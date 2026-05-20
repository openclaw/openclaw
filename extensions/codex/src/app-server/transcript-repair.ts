import fs from "node:fs/promises";
import path from "node:path";

export type CodexRolloutTranscriptRepairResult = {
  scannedFiles: number;
  repairedFiles: number;
  insertedOutputs: number;
};

type ParsedJsonLine = {
  raw: string;
  value?: Record<string, unknown>;
};

const SYNTHETIC_TOOL_OUTPUT_TEXT =
  "[openclaw] custom tool call was interrupted by OpenClaw before a tool output was recorded; inserted synthetic output during transcript repair.";

export async function repairCodexRolloutMissingCustomToolOutputs(
  files: readonly string[],
): Promise<CodexRolloutTranscriptRepairResult> {
  const result: CodexRolloutTranscriptRepairResult = {
    scannedFiles: 0,
    repairedFiles: 0,
    insertedOutputs: 0,
  };
  const visited = new Set<string>();
  for (const file of files) {
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    const repair = await repairCodexRolloutFile(file);
    if (repair.scanned) {
      result.scannedFiles += 1;
    }
    if (repair.insertedOutputs > 0) {
      result.repairedFiles += 1;
      result.insertedOutputs += repair.insertedOutputs;
    }
  }
  return result;
}

async function repairCodexRolloutFile(
  file: string,
): Promise<{ scanned: boolean; insertedOutputs: number }> {
  const scan = await scanCodexRolloutFileForMissingCustomToolOutputs(file);
  if (!scan.exists) {
    return { scanned: false, insertedOutputs: 0 };
  }
  if (!scan.hasMissingOutputs) {
    return { scanned: true, insertedOutputs: 0 };
  }

  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { scanned: false, insertedOutputs: 0 };
    }
    throw error;
  }
  if (!raw.trim()) {
    return { scanned: true, insertedOutputs: 0 };
  }

  const endsWithNewline = raw.endsWith("\n");
  const lines = raw.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  const parsedLines = lines.map(parseJsonLine);
  const outputCallIds = new Set<string>();
  const toolCalls: Array<{ index: number; callId: string; timestamp?: string }> = [];
  for (const [index, line] of parsedLines.entries()) {
    const payload = readPayload(line.value);
    const type = readString(payload, "type");
    if (type === "custom_tool_call") {
      const callId = readString(payload, "call_id");
      if (callId) {
        toolCalls.push({ index, callId, timestamp: readString(line.value, "timestamp") });
      }
    } else if (type === "custom_tool_call_output") {
      const callId = readString(payload, "call_id");
      if (callId) {
        outputCallIds.add(callId);
      }
    }
  }

  const missingCalls = toolCalls.filter((call) => !outputCallIds.has(call.callId));
  if (missingCalls.length === 0) {
    return { scanned: true, insertedOutputs: 0 };
  }

  const missingByIndex = new Map<number, Array<{ callId: string; timestamp?: string }>>();
  for (const call of missingCalls) {
    const calls = missingByIndex.get(call.index) ?? [];
    calls.push(call);
    missingByIndex.set(call.index, calls);
  }

  const repaired: string[] = [];
  for (const [index, line] of parsedLines.entries()) {
    repaired.push(line.raw);
    for (const call of missingByIndex.get(index) ?? []) {
      repaired.push(JSON.stringify(buildSyntheticCustomToolOutput(call)));
    }
  }
  const nextRaw = repaired.join("\n") + (endsWithNewline ? "\n" : "");
  await writeFileAtomically(file, nextRaw);
  return { scanned: true, insertedOutputs: missingCalls.length };
}

async function scanCodexRolloutFileForMissingCustomToolOutputs(
  file: string,
): Promise<{ exists: boolean; hasMissingOutputs: boolean }> {
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, "r");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { exists: false, hasMissingOutputs: false };
    }
    throw error;
  }
  const outputCallIds = new Set<string>();
  const toolCallIds = new Set<string>();
  try {
    for await (const raw of handle.readLines()) {
      const payload = readPayload(parseJsonLine(raw).value);
      const type = readString(payload, "type");
      if (type === "custom_tool_call") {
        const callId = readString(payload, "call_id");
        if (callId) {
          toolCallIds.add(callId);
        }
      } else if (type === "custom_tool_call_output") {
        const callId = readString(payload, "call_id");
        if (callId) {
          outputCallIds.add(callId);
        }
      }
    }
  } finally {
    await handle.close();
  }
  for (const callId of toolCallIds) {
    if (!outputCallIds.has(callId)) {
      return { exists: true, hasMissingOutputs: true };
    }
  }
  return { exists: true, hasMissingOutputs: false };
}

async function writeFileAtomically(file: string, content: string): Promise<void> {
  const tempFile = path.join(
    path.dirname(file),
    `.${path.basename(file)}.repair-${process.pid}-${Date.now()}.tmp`,
  );
  try {
    await fs.writeFile(tempFile, content, "utf8");
    await fs.rename(tempFile, file);
  } catch (error) {
    await fs.rm(tempFile, { force: true }).catch(() => undefined);
    throw error;
  }
}

function parseJsonLine(raw: string): ParsedJsonLine {
  try {
    const value = JSON.parse(raw) as unknown;
    return {
      raw,
      value:
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined,
    };
  } catch {
    return { raw };
  }
}

function buildSyntheticCustomToolOutput(call: {
  callId: string;
  timestamp?: string;
}): Record<string, unknown> {
  return {
    timestamp: call.timestamp ?? new Date().toISOString(),
    type: "response_item",
    payload: {
      type: "custom_tool_call_output",
      call_id: call.callId,
      output: [
        {
          type: "input_text",
          text: SYNTHETIC_TOOL_OUTPUT_TEXT,
        },
      ],
    },
  };
}

function readPayload(
  value: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  const payload = value?.payload;
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : undefined;
}

function readString(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const raw = value?.[key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
