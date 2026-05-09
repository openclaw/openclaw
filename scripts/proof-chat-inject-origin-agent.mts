#!/usr/bin/env tsx
/**
 * Real-behavior proof for chat.inject originAgent attribution patch.
 *
 * Exercises the patched code path in `appendInjectedAssistantMessageToTranscript`
 * against a synthetic transcript fixture. No real session keys, no real
 * channel ids, nothing from the running OpenClaw install.
 *
 * Output:
 *   1) baseline call (no originAgent)         -> provider = "openclaw"
 *   2) patched call  (originAgent: "hermes")  -> provider = "hermes"
 *   3) patched call  (originAgent: "codex")   -> provider = "codex"
 *
 * Each line of the resulting transcript jsonl is read back and the `provider`
 * field is printed verbatim, proving the patched code path stamps the value.
 */

import fs from "node:fs";
import path from "node:path";
import os from "node:os";

import { appendInjectedAssistantMessageToTranscript } from "../src/gateway/server-methods/chat-transcript-inject.js";
import { createTranscriptFixtureSync } from "../src/gateway/server-methods/chat.test-helpers.js";

function readLast(transcriptPath: string): Record<string, unknown> | null {
  const raw = fs.readFileSync(transcriptPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const obj = JSON.parse(lines[i]) as Record<string, unknown>;
    if (obj.type === "message") {
      return obj;
    }
  }
  return null;
}

function extractProvider(entry: Record<string, unknown> | null): string {
  if (!entry) return "<no-message-entry>";
  const msg = (entry as { message?: Record<string, unknown> }).message;
  if (msg && typeof msg === "object" && typeof msg.provider === "string") {
    return msg.provider;
  }
  return JSON.stringify(msg ?? entry).slice(0, 200);
}

async function runCase(
  caseLabel: string,
  originAgent: string | undefined,
): Promise<void> {
  const { dir, transcriptPath } = createTranscriptFixtureSync({
    prefix: "proof-chat-inject-",
    sessionId: `synthetic-${caseLabel}`,
  });
  try {
    const result = await appendInjectedAssistantMessageToTranscript({
      transcriptPath,
      message: `synthetic test body for case=${caseLabel}`,
      label: "proof-fixture",
      ...(originAgent !== undefined ? { originAgent } : {}),
    });

    const last = readLast(transcriptPath);
    const provider = extractProvider(last);

    console.log("=================================================");
    console.log(`CASE          : ${caseLabel}`);
    console.log(`originAgent   : ${originAgent === undefined ? "<unset>" : `"${originAgent}"`}`);
    console.log(`append.ok     : ${result.ok}`);
    console.log(`messageId     : ${result.messageId ?? "<none>"}`);
    console.log(`stamped.provider : ${provider}`);
    console.log("");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  console.log("");
  console.log("OpenClaw chat.inject originAgent attribution — real-behavior proof");
  console.log("Patched modules under test:");
  console.log("  src/gateway/server-methods/chat-transcript-inject.ts");
  console.log("  src/gateway/protocol/schema/logs-chat.ts (schema field)");
  console.log("  src/gateway/server-methods/chat.ts (handler threading)");
  console.log("");

  await runCase("baseline-no-origin", undefined);
  await runCase("hermes", "hermes");
  await runCase("codex", "codex");

  console.log("=================================================");
  console.log("Expected: provider = \"openclaw\" when originAgent unset,");
  console.log("          provider = \"<originAgent>\" when set.");
  console.log("");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
