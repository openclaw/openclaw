import fs from "node:fs/promises";
import path from "node:path";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { RuntimeId } from "./runtime-id.js";
import type { RuntimeParityCell, RuntimeParityResult } from "./runtime-parity.js";
import { extractQaContentText } from "./runtime-transcript.js";

type JsonlReplayResult = {
  transcripts: Array<{
    transcriptPath: string;
    userTurnCount: number;
    cells: { openclaw: RuntimeParityCell[]; codex: RuntimeParityCell[] };
    drift: Array<RuntimeParityResult["drift"]>;
    firstDriftAtTurn?: number;
  }>;
};

function extractTextContent(content: unknown): string {
  return extractQaContentText(content, (block) => {
    const type = normalizeOptionalString(block.type)?.toLowerCase();
    return !type || ["text", "input_text", "message", "output_text", "user_text"].includes(type)
      ? (normalizeOptionalString(block.text) ?? normalizeOptionalString(block.content))
      : undefined;
  });
}

function extractJsonlReplayUserTurns(transcriptBytes: string): string[] {
  const turns: string[] = [];
  const acceptedLines: string[] = [];
  for (const rawLine of transcriptBytes.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) {
      continue;
    }
    acceptedLines.push(trimmed);
    const message = isRecord(parsed.message) ? parsed.message : parsed;
    if (normalizeOptionalString(message.role)?.toLowerCase() !== "user") {
      continue;
    }
    const userText = extractTextContent(message.content);
    if (!userText) {
      continue;
    }
    turns.push(`${acceptedLines.join("\n")}\n`);
  }
  return turns;
}

async function listJsonlFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listJsonlFiles(entryPath)));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(entryPath);
    }
  }
  return files;
}

function createMockJsonlReplayCell(
  runtime: RuntimeId,
  transcriptBytes: string,
  turn: number,
): RuntimeParityResult["cells"]["openclaw"] {
  const inputTokens = Math.max(1, Math.ceil(transcriptBytes.length / 4));
  return {
    runtime,
    transcriptBytes,
    toolCalls: [],
    finalText: `Replayed curated turn ${turn}.`,
    usage: { inputTokens, outputTokens: 8, totalTokens: inputTokens + 8 },
    wallClockMs: 1,
    bootStateLines: [],
    status: "pass",
  };
}

export async function runJsonlReplay(directory: string): Promise<JsonlReplayResult> {
  const transcriptPaths = await listJsonlFiles(path.resolve(directory));
  const transcripts: JsonlReplayResult["transcripts"] = [];

  for (const transcriptPath of transcriptPaths) {
    const transcriptBytes = await fs.readFile(transcriptPath, "utf8");
    const turns = extractJsonlReplayUserTurns(transcriptBytes);
    const cells: { openclaw: RuntimeParityCell[]; codex: RuntimeParityCell[] } = {
      openclaw: [],
      codex: [],
    };
    const drift: Array<RuntimeParityResult["drift"]> = [];
    for (const [index, transcriptPrefix] of turns.entries()) {
      cells.openclaw.push(createMockJsonlReplayCell("openclaw", transcriptPrefix, index + 1));
      cells.codex.push(createMockJsonlReplayCell("codex", transcriptPrefix, index + 1));
      drift.push("none");
    }

    transcripts.push({
      transcriptPath,
      userTurnCount: turns.length,
      cells,
      drift,
    });
  }

  return { transcripts };
}

export function renderJsonlReplayMarkdownReport(report: {
  generatedAt: string;
  providerMode: "mock-openai" | "live-frontier";
  runtimePair: ["openclaw", "codex"];
  transcripts: JsonlReplayResult["transcripts"];
}): string {
  const totalTurns = report.transcripts.reduce((sum, entry) => sum + entry.userTurnCount, 0);
  const driftedTranscripts = report.transcripts.filter(
    (entry) => entry.firstDriftAtTurn !== undefined,
  );
  const lines = [
    `# OpenClaw JSONL Replay Report - ${report.runtimePair[0]} vs ${report.runtimePair[1]}`,
    "",
    `- Generated at: ${report.generatedAt}`,
    `- Provider mode: ${report.providerMode}`,
    `- Transcripts: ${report.transcripts.length}`,
    `- User turns: ${totalTurns}`,
    `- Drifted transcripts: ${driftedTranscripts.length}`,
    "",
    "| Transcript | User turns | First drift turn | Drift sequence |",
    "| --- | ---: | ---: | --- |",
  ];

  for (const transcript of report.transcripts) {
    lines.push(
      `| ${path.basename(transcript.transcriptPath)} | ${transcript.userTurnCount} | ${transcript.firstDriftAtTurn ?? ""} | ${transcript.drift.join(", ")} |`,
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}
