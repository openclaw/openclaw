import fs from "node:fs";
import path from "node:path";

import { logDebug } from "../../logger.js";

type TranscriptRole = "user" | "assistant";

function fileEndsWithNewline(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return true;
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(1);
      fs.readSync(fd, buffer, 0, 1, stat.size - 1);
      return buffer[0] === 0x0a;
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return true;
  }
}

function appendJsonlLine(params: { filePath: string; value: unknown }) {
  fs.mkdirSync(path.dirname(params.filePath), { recursive: true });
  const prefix =
    fs.existsSync(params.filePath) && !fileEndsWithNewline(params.filePath) ? "\n" : "";
  fs.appendFileSync(params.filePath, `${prefix}${JSON.stringify(params.value)}\n`, "utf-8");
}

export function appendSdkTextTurnToSessionTranscript(params: {
  sessionFile: string;
  role: TranscriptRole;
  text: string;
  timestamp?: number;
}): void {
  const trimmed = params.text.trim();
  if (!trimmed) return;

  try {
    appendJsonlLine({
      filePath: params.sessionFile,
      value: {
        role: params.role,
        content: [{ type: "text", text: trimmed }],
        timestamp: params.timestamp ?? Date.now(),
      },
    });
  } catch (err) {
    logDebug(`[sdk-session-transcript] Failed to append transcript: ${String(err)}`);
  }
}

export function appendSdkTurnPairToSessionTranscript(params: {
  sessionFile: string;
  prompt: string;
  assistantText?: string;
  timestamp?: number;
}): void {
  const ts = params.timestamp ?? Date.now();
  appendSdkTextTurnToSessionTranscript({
    sessionFile: params.sessionFile,
    role: "user",
    text: params.prompt,
    timestamp: ts,
  });
  if (params.assistantText) {
    appendSdkTextTurnToSessionTranscript({
      sessionFile: params.sessionFile,
      role: "assistant",
      text: params.assistantText,
      timestamp: ts,
    });
  }
}
