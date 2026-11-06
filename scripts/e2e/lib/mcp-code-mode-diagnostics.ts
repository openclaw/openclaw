import { open } from "node:fs/promises";
import { isRecord } from "@openclaw/normalization-core/record-coerce";

const MAX_LOG_BYTES = 8 * 1024 * 1024;
const MAX_RECORDS = 256;
const MAX_TURNS = 2;
const QA_MARKER = "mcp code mode api file qa check:";
const PUBLIC_TERMS = [
  "MCP_CODE_MODE_FILE_TOOL_RESULT",
  "fixture-note-alpha",
  "API.list",
  "API.read",
  "MCP.fixture.lookupNote",
  "catalog.all",
  "ALL_TOOLS",
  "TypeError",
  "ReferenceError",
  "SyntaxError",
  "not defined",
  "not a function",
  "invalid_input",
  "internal_error",
  "timeout",
] as const;
const RESULT_FIELDS = [
  "status",
  "error",
  "code",
  "value",
  "content",
  "type",
  "text",
  "output",
  "result",
  "marker",
  "resultText",
  "note",
  "rootHasFixture",
  "headerHasLookup",
  "allHasMcp",
  "files",
] as const;

// Project known fields and public fixture terms, never arbitrary result text or
// object keys. Error messages can contain source, paths, headers, or credentials.
function resultFacts(value: unknown, depth = 0, budget = { nodes: 32 }): unknown {
  if (depth > 6 || budget.nodes-- <= 0) {
    return { omitted: "structure-limit" };
  }
  if (typeof value === "string") {
    const facts = {
      kind: "string",
      bytes: Buffer.byteLength(value),
      terms: PUBLIC_TERMS.filter((term) => value.includes(term)),
      state: ["completed", "waiting", "failed", "text", "input_text"].includes(value)
        ? value
        : undefined,
    };
    if (value.length <= 32_768) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (isRecord(parsed) || Array.isArray(parsed)) {
          return { ...facts, json: resultFacts(parsed, depth + 1, budget) };
        }
      } catch {
        /* Plain tool text is a valid output shape. */
      }
    }
    return facts;
  }
  if (Array.isArray(value)) {
    return {
      kind: "array",
      length: value.length,
      items: value.slice(0, 8).map((item) => resultFacts(item, depth + 1, budget)),
    };
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      RESULT_FIELDS.filter((key) => Object.hasOwn(value, key)).map((key) => [
        key,
        resultFacts(value[key], depth + 1, budget),
      ]),
    );
  }
  return typeof value === "boolean" || value === null ? value : { kind: typeof value };
}

function callId(id: string, ordinal: number): string {
  return /^call_mock_exec_[a-f0-9]{10}$/u.test(id) ? id : `selected-exec-${ordinal}`;
}

function wireCallId(id: unknown): string | undefined {
  // Responses replay strips the item ID suffix from persisted call/result IDs.
  return typeof id === "string" ? id.split("|", 1)[0] : undefined;
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return Array.isArray(value)
    ? value
        .filter(isRecord)
        .flatMap((part) => (typeof part.text === "string" ? [part.text] : []))
        .join("\n")
    : "";
}

/** Select only the fixture's current user turn; old or unrelated calls cannot explain it. */
export function projectMcpCodeModeDiagnostics(
  records: readonly unknown[],
  transcript: readonly unknown[],
) {
  const turns: unknown[] = [];
  const selectedIds = new Set<string>();
  const responsesRecordBodyTruncated: { seq?: number; byteLength?: number }[] = [];
  // The newest initial QA request (no calls after its user message) bounds this
  // attempt. Older attempts can repeat both the prompt and deterministic call ID.
  for (const record of records.slice(-MAX_RECORDS).toReversed()) {
    if (!isRecord(record) || record.method !== "POST" || record.path !== "/v1/responses") {
      continue;
    }
    let body: unknown = record.body;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        continue;
      }
    }
    if (isRecord(body) && body.truncated === true) {
      // The producer discarded the input, so this record cannot be attributed
      // to the current QA turn. Never inspect or export its private preview.
      if (responsesRecordBodyTruncated.length < MAX_TURNS) {
        responsesRecordBodyTruncated.push({
          seq:
            typeof record.seq === "number" && Number.isSafeInteger(record.seq)
              ? record.seq
              : undefined,
          byteLength:
            typeof body.byteLength === "number" && Number.isSafeInteger(body.byteLength)
              ? body.byteLength
              : undefined,
        });
      }
      continue;
    }
    if (!isRecord(body) || !Array.isArray(body.input)) {
      continue;
    }
    const input = body.input.filter(isRecord);
    const userIndex = input.findLastIndex((item) => item.role === "user");
    if (userIndex < 0 || !contentText(input[userIndex]?.content).includes(QA_MARKER)) {
      continue;
    }
    const current = input.slice(userIndex + 1);
    const calls = current.filter(
      (item) =>
        item.type === "function_call" && item.name === "exec" && typeof item.call_id === "string",
    );
    const outputs = current.filter((item) => item.type === "function_call_output");
    turns.push({
      seq: Number.isSafeInteger(record.seq) ? record.seq : undefined,
      execCalls: calls.slice(0, MAX_TURNS).map((call) => {
        const id = call.call_id as string;
        selectedIds.add(id);
        const output = outputs.find((item) => item.call_id === id);
        return {
          callId: callId(id, [...selectedIds].indexOf(id) + 1),
          arguments: resultFacts(call.arguments),
          outputPresent: output !== undefined,
          output: resultFacts(output?.output),
        };
      }),
      unrelatedOutputs: outputs.filter(
        (output) => !calls.some((call) => call.call_id === output.call_id),
      ).length,
    });
    if (calls.length === 0 || turns.length === MAX_TURNS) {
      break;
    }
  }
  const allMessages = transcript
    .filter(isRecord)
    .map((event) => event.message)
    .filter(isRecord);
  const transcriptUserIndex = allMessages.findLastIndex((message) => message.role === "user");
  const transcriptFixtureTurnPresent =
    transcriptUserIndex >= 0 &&
    contentText(allMessages[transcriptUserIndex]?.content).includes(QA_MARKER);
  const messages = transcriptFixtureTurnPresent ? allMessages.slice(transcriptUserIndex + 1) : [];
  const persistedExecCalls = messages
    .flatMap((message) =>
      message.role === "assistant" && Array.isArray(message.content)
        ? message.content.filter(isRecord)
        : [],
    )
    .filter((item) => item.type === "toolCall" && item.name === "exec");
  const persistedExecWithoutSelectedWireCall = persistedExecCalls.some((call) => {
    const id = wireCallId(call.id);
    return id !== undefined && !selectedIds.has(id);
  });
  const transcriptPairs = [...selectedIds].slice(0, MAX_TURNS).map((id, index) => {
    const call = persistedExecCalls.find((item) => wireCallId(item.id) === id);
    const result = messages.find(
      (message) => message.role === "toolResult" && wireCallId(message.toolCallId) === id,
    );
    return {
      callId: callId(id, index + 1),
      callPresent: call !== undefined,
      resultPresent: result !== undefined,
      isError: result?.isError === true,
      content: resultFacts(result?.content),
      details: resultFacts(result?.details),
    };
  });
  const projection = {
    providerTurns: turns.toReversed(),
    transcriptPairs,
    transcriptFixtureTurnPresent,
    persistedExecWithoutSelectedWireCall,
    responsesRecordBodyTruncated,
    recordsTruncated: records.length > MAX_RECORDS,
  };
  return Buffer.byteLength(JSON.stringify(projection)) <= 32_768
    ? projection
    : {
        projection: "over-limit",
        providerTurnCount: turns.length,
        transcriptPairCount: transcriptPairs.length,
      };
}

/** The private request log stays in the container; only the bounded projection is printed. */
export async function readMcpCodeModeDiagnostics(
  requestLog: string | undefined,
  transcript: readonly unknown[],
) {
  if (!requestLog) {
    return { requestLog: "not-configured" };
  }
  try {
    const file = await open(requestLog, "r");
    try {
      const bytes = Buffer.alloc(MAX_LOG_BYTES + 1);
      let count = 0;
      while (count < bytes.length) {
        const read = await file.read(bytes, count, bytes.length - count, null);
        if (read.bytesRead === 0) {
          break;
        }
        count += read.bytesRead;
      }
      if (count > MAX_LOG_BYTES) {
        return { requestLog: "over-limit" };
      }
      const records: unknown[] = [];
      let malformed = 0;
      for (const line of bytes.subarray(0, count).toString("utf8").split("\n")) {
        if (!line.trim()) {
          continue;
        }
        try {
          records.push(JSON.parse(line));
        } catch {
          malformed += 1;
        }
      }
      return {
        requestLog: "read",
        malformed,
        ...projectMcpCodeModeDiagnostics(records, transcript),
      };
    } finally {
      await file.close();
    }
  } catch {
    return { requestLog: "unreadable" };
  }
}
