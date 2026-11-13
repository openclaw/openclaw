import { createHash } from "node:crypto";
import path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  persistSessionTranscriptTurn,
  upsertSessionEntryCore,
} from "../../../../src/config/sessions/session-accessor.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../../src/test-utils/openclaw-test-state.js";
import { buildSessionEntries, buildSessionEntry, streamSessionEntry } from "./session-files.js";

// Seeds ~300 MB of transcript text; run with OPENCLAW_SESSION_EXPORT_STRESS=1.
const MESSAGES = 20_000;
const MESSAGE_CHARS = 15_000;
// Space-free text wraps at exactly 800 chars: 18 full lines and one 600-char tail.
const LINES_PER_MESSAGE = Math.ceil(MESSAGE_CHARS / 800);
const SEED_BATCH = 250;

let state: OpenClawTestState;
let scope: { agentId: string; sessionId: string; sessionKey: string; storePath: string };

/** The persisted entry hash format, computed over a complete export. */
function hashSessionEntrySnapshot(params: {
  content: string;
  lineMap: readonly number[];
  messageTimestampsMs: readonly number[];
  lineProvenance: readonly unknown[];
  resetRecallCutoff: unknown;
}): string {
  return createHash("sha256")
    .update(params.content)
    .update("\n")
    .update(params.lineMap.join(","))
    .update("\n")
    .update(params.messageTimestampsMs.join(","))
    .update("\n")
    .update(JSON.stringify(params.lineProvenance))
    .update("\n")
    .update(JSON.stringify(params.resetRecallCutoff))
    .digest("hex");
}

const messageText = (index: number) => {
  const head = `m${index}-`;
  return head + "x".repeat(MESSAGE_CHARS - head.length);
};

beforeAll(async () => {
  if (process.env.OPENCLAW_SESSION_EXPORT_STRESS !== "1") {
    return;
  }
  state = await createOpenClawTestState({ prefix: "session-large-export-", layout: "state-only" });
  scope = {
    agentId: "main",
    sessionId: "large",
    sessionKey: "agent:main:chat:large",
    storePath: path.join(state.stateDir, "agents", "main", "sessions", "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  for (let start = 0; start < MESSAGES; start += SEED_BATCH) {
    await persistSessionTranscriptTurn(scope, {
      messages: Array.from({ length: Math.min(SEED_BATCH, MESSAGES - start) }, (_, offset) => {
        const index = start + offset;
        return {
          message: {
            role: index % 2 === 0 ? "user" : "assistant",
            content: messageText(index),
            timestamp: 1_700_000_000_000 + index,
          },
        };
      }),
      touchSessionEntry: true,
      updateMode: "none",
    });
  }
}, 600_000);

afterAll(async () => {
  await state?.cleanup();
});

it.runIf(process.env.OPENCLAW_SESSION_EXPORT_STRESS === "1")(
  "exports a 20,000-message session through the real transcript worker",
  async () => {
    const [batched] = await buildSessionEntries([{ absPath: scope.sessionKey, options: scope }]);
    expect(batched).not.toBeNull();
    const entry = batched!;
    expect(entry.lineMap).toHaveLength(MESSAGES * LINES_PER_MESSAGE);
    expect(entry.content.length).toBe(
      MESSAGES * (MESSAGE_CHARS + LINES_PER_MESSAGE * "User: ".length) +
        (MESSAGES / 2) * LINES_PER_MESSAGE * ("Assistant: ".length - "User: ".length) +
        MESSAGES * LINES_PER_MESSAGE -
        1,
    );
    expect(entry.hash).toBe(
      hashSessionEntrySnapshot({
        content: entry.content,
        lineMap: entry.lineMap,
        messageTimestampsMs: entry.messageTimestampsMs,
        lineProvenance: entry.lineProvenance,
        resetRecallCutoff: { state: "absent" },
      }),
    );
    const contentDigest = createHash("sha256").update(entry.content).digest("hex");
    const prefixLineCount = entry.lineMap.length - LINES_PER_MESSAGE;
    let prefixEnd = -1;
    for (let line = 0; line < prefixLineCount; line++) {
      prefixEnd = entry.content.indexOf("\n", prefixEnd + 1);
    }
    const prefixHash = hashSessionEntrySnapshot({
      content: entry.content.slice(0, prefixEnd),
      lineMap: entry.lineMap.slice(0, prefixLineCount),
      messageTimestampsMs: entry.messageTimestampsMs.slice(0, prefixLineCount),
      lineProvenance: entry.lineProvenance.slice(0, prefixLineCount),
      resetRecallCutoff: { state: "absent" },
    });
    const single = await buildSessionEntry(scope.sessionKey, scope);
    expect(single?.hash).toBe(entry.hash);
    expect(createHash("sha256").update(single!.content).digest("hex")).toBe(contentDigest);

    // The paged export delivers the same bytes in bounded pages, without retaining them.
    const streamedDigest = createHash("sha256");
    let lines = 0;
    let pages = 0;
    let largestPageChars = 0;
    const summary = await streamSessionEntry(scope.sessionKey, scope, {
      prefixLineCount,
      onPage(page) {
        expect(page.startLine).toBe(lines);
        const text = page.lines.join("\n");
        streamedDigest.update(lines === 0 ? text : `\n${text}`);
        largestPageChars = Math.max(largestPageChars, text.length);
        lines += page.lines.length;
        pages++;
      },
    });
    expect(summary).toMatchObject({
      hash: entry.hash,
      prefixHash,
      lineCount: MESSAGES * LINES_PER_MESSAGE,
    });
    expect(lines).toBe(MESSAGES * LINES_PER_MESSAGE);
    expect(streamedDigest.digest("hex")).toBe(contentDigest);
    expect(pages).toBeGreaterThan(400);
    expect(largestPageChars).toBeLessThanOrEqual(600 * 1024);
  },
  1_800_000,
);
