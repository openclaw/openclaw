// Reproduction for #95875: Codex-backed transcript messages must carry an
// explicit `__openclaw.harness` field so operators read "ran on Codex" directly
// instead of inferring it from the canonical openai provider/api labels.
//
// Runs the production transcript-mirror path against a real temp session file
// and asserts the persisted JSONL carries the harness stamp.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  attachCodexMirrorIdentity,
  mirrorCodexAppServerTranscript,
} from "../../extensions/codex/src/app-server/transcript-mirror.ts";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-harness-runtime";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeUserMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp,
  } as AgentMessage;
}

function makeAssistantMessage(text: string, timestamp: number): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp,
  } as AgentMessage;
}

async function main() {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-repro-95875-"));
  const sessionFile = path.join(tmpDir, "session.jsonl");
  const base = Number(Date.now());

  try {
    await mirrorCodexAppServerTranscript({
      sessionFile,
      sessionKey: "agent:main:main",
      messages: [
        attachCodexMirrorIdentity(makeUserMessage("hello", base), "turn-1:prompt"),
        attachCodexMirrorIdentity(
          makeAssistantMessage("codex reply", base + 1),
          "turn-1:assistant",
        ),
      ],
      idempotencyScope: "codex-app-server:thread-1",
    });

    const raw = await fs.readFile(sessionFile, "utf8");
    const messages = raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as { type?: string; message?: Record<string, unknown> })
      .filter((entry) => entry.type === "message");

    console.log(`=== Reproduction for issue #95875 ===`);
    console.log(`Session file: ${sessionFile}`);
    console.log(`Persisted message entries: ${messages.length}`);

    let allStamped = true;
    for (const entry of messages) {
      const openclaw = entry.message?.["__openclaw"] as { harness?: string } | undefined;
      const provider = entry.message?.provider;
      const api = entry.message?.api;
      const stamped = openclaw?.harness === "codex";
      allStamped = allStamped && stamped;
      console.log(
        `  role=${entry.message?.role} provider=${provider ?? "(none)"} api=${api ?? "(none)"} ` +
          `harness=${openclaw?.harness ?? "(MISSING)"}`,
      );
    }

    const firstMessageRaw = messages[0]
      ? JSON.stringify(messages[0].message?.["__openclaw"])
      : "(none)";
    console.log(`First message __openclaw: ${firstMessageRaw}`);

    if (messages.length !== 2 || !allStamped) {
      console.error("FAIL: Codex transcript messages are not stamped with __openclaw.harness=codex.");
      process.exitCode = 1;
      return;
    }
    console.log("PASS: Every Codex-backed transcript message carries an explicit harness=codex field.");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
