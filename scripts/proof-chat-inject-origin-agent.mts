#!/usr/bin/env tsx
/**
 * Real-behavior proof for the chat.inject originAgent attribution patch.
 *
 * Exercises `appendInjectedAssistantMessageToTranscript` against synthetic
 * transcript fixtures and reads the persisted jsonl back to confirm:
 *
 *   1. provider stays "openclaw" in every case (replay-filter sentinel preserved)
 *   2. originAgent is absent on baseline calls
 *   3. originAgent is stamped verbatim when a non-empty value is passed
 *   4. blank/whitespace originAgent is normalized to absent
 *
 * Synthetic fixtures only — no real session keys, no tokens, no production data.
 */

import fs from "node:fs";

import { appendInjectedAssistantMessageToTranscript } from "../src/gateway/server-methods/chat-transcript-inject.js";
import { createTranscriptFixtureSync } from "../src/gateway/server-methods/chat.test-helpers.js";

function readLastMessageBody(transcriptPath: string): Record<string, unknown> | null {
  const raw = fs.readFileSync(transcriptPath, "utf-8");
  const lines = raw.split(/\r?\n/).filter((l) => l.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const obj = JSON.parse(lines[i]) as Record<string, unknown>;
    if (obj.type === "message") {
      const msg = (obj as { message?: Record<string, unknown> }).message;
      return msg ?? null;
    }
  }
  return null;
}

async function runCase(
  caseLabel: string,
  originAgent: string | undefined,
  expectedOriginAgentField: string,
): Promise<void> {
  const { dir, transcriptPath } = createTranscriptFixtureSync({
    prefix: "proof-chat-inject-",
    sessionId: `synthetic-${caseLabel.replace(/\s+/g, "-")}`,
  });
  try {
    const result = await appendInjectedAssistantMessageToTranscript({
      transcriptPath,
      message: `synthetic test body for case=${caseLabel}`,
      label: "proof-fixture",
      ...(originAgent !== undefined ? { originAgent } : {}),
    });

    const body = readLastMessageBody(transcriptPath);
    const provider = (body && typeof body.provider === "string") ? body.provider : "<missing>";
    const model = (body && typeof body.model === "string") ? body.model : "<missing>";
    const persistedOriginAgent =
      body && Object.prototype.hasOwnProperty.call(body, "originAgent")
        ? String((body as { originAgent: unknown }).originAgent)
        : "<absent>";

    let pass = true;
    if (provider !== "openclaw") {
      pass = false;
    }
    if (model !== "gateway-injected") {
      pass = false;
    }
    if (expectedOriginAgentField === "absent") {
      if (persistedOriginAgent !== "<absent>") {
        pass = false;
      }
    } else if (persistedOriginAgent !== expectedOriginAgentField) {
      pass = false;
    }

    console.log("=================================================");
    console.log(`CASE                  : ${caseLabel}`);
    console.log(`input.originAgent     : ${originAgent === undefined ? "<unset>" : JSON.stringify(originAgent)}`);
    console.log(`append.ok             : ${result.ok}`);
    console.log(`messageId             : ${result.messageId ?? "<none>"}`);
    console.log(`stamped.provider      : ${provider}`);
    console.log(`stamped.model         : ${model}`);
    console.log(`stamped.originAgent   : ${persistedOriginAgent}`);
    console.log(`expected.originAgent  : ${expectedOriginAgentField}`);
    console.log(`result                : ${pass ? "PASS" : "FAIL"}`);
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
  console.log("Design:");
  console.log("  provider stays 'openclaw' (replay-filter sentinel preserved)");
  console.log("  originAgent is a NEW persisted field for display-only attribution");
  console.log("  empty/whitespace originAgent is normalized to absent");
  console.log("");

  await runCase("baseline-no-origin", undefined, "absent");
  await runCase("hermes", "hermes", "hermes");
  await runCase("codex", "codex", "codex");
  await runCase("blank-empty-string", "", "absent");
  await runCase("whitespace-only", "   ", "absent");
  await runCase("trim-surrounding-whitespace", "  hermes  ", "hermes");
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
