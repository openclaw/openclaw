import fs from "node:fs/promises";
import path from "node:path";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";

export async function writeMemoryIndexArchiveTranscript(params: {
  sessionId: string;
  text: string;
}): Promise<string> {
  const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
  await fs.mkdir(sessionsDir, { recursive: true });
  const sessionFile = path.join(sessionsDir, `${params.sessionId}.jsonl`);
  await fs.writeFile(
    sessionFile,
    [
      JSON.stringify({
        type: "session",
        id: params.sessionId,
        timestamp: "2026-04-07T15:24:04.113Z",
      }),
      JSON.stringify({
        type: "message",
        message: {
          role: "assistant",
          timestamp: "2026-04-07T15:25:04.113Z",
          content: [{ type: "text", text: params.text }],
        },
      }),
    ].join("\n") + "\n",
    "utf8",
  );
  return sessionFile;
}
