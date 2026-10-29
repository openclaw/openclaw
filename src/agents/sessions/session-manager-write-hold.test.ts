import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  loadTranscriptEventsSync,
  readTranscriptMutationAtSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { prepareTranscriptMessageAppend } from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import { appendTranscriptMessageSnapshotSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.kernel.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import {
  withOpenClawTestState,
  type OpenClawTestState,
} from "../../test-utils/openclaw-test-state.js";
import type { AgentMessage } from "../runtime/index.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import * as transcriptRedact from "../transcript-sanitize.js";
import { sessionScope } from "./session-manager-fixtures.test-support.js";
import { SessionManager } from "./session-manager.js";

async function setup(state: OpenClawTestState) {
  const scope = sessionScope(path.join(state.sessionsDir(), "sessions.json"), "write-hold");
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  const manager = SessionManager.open(scope, state.workspaceDir);
  const parentId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  const { db } = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  return { scope, manager, parentId, db };
}

const assistantMessage = (text: string) => ({
  role: "assistant" as const,
  content: [{ type: "text" as const, text }],
  api: "messages" as const,
  provider: "anthropic",
  model: "sonnet-4.6",
  usage: createZeroUsageFixture(),
  stopReason: "stop" as const,
  timestamp: 2,
});

it.each(["assistant", "toolResult"] as const)(
  "prepares large %s payloads before the writer lock and preserves keyed replay",
  async (role) => {
    await withOpenClawTestState({ label: "session-write-hold" }, async (state) => {
      const { scope, manager, parentId, db } = await setup(state);
      const text = "```ts\nconst value = 42;\n```\n".repeat(8000);
      const content = [{ type: "text" as const, text }];
      const message: AgentMessage =
        role === "assistant"
          ? assistantMessage(text)
          : { role, content, toolCallId: "call-1", toolName: "read", isError: false, timestamp: 2 };
      Object.assign(message, {
        MediaPaths: ["/media/a.png"],
        MediaTypes: ["image/png"],
        idempotencyKey: `write-hold:${role}`,
      });
      const redactionHeld: boolean[] = [];
      const largeJsonHeld: boolean[] = [];
      const compressionHeld: boolean[] = [];
      const codec = resolveZstdCodec();
      if (!codec) {
        throw new Error("Writer preparation proof requires native zstd support");
      }
      const compress = codec.compress;
      const redact = transcriptRedact.sanitizeTranscriptMessage;
      const stringify = JSON.stringify;
      const parse = JSON.parse;
      function track<Args extends unknown[], Result>(
        fn: (...args: Args) => Result,
        held: boolean[],
        payload?: (result: Result, ...args: Args) => string | undefined,
      ) {
        return (...args: Args) => {
          const locked = db.isTransaction;
          const result = fn(...args);
          if (!payload || (payload(result, ...args)?.length ?? 0) > 100_000) {
            held.push(locked);
          }
          return result;
        };
      }
      vi.spyOn(codec, "compress").mockImplementation(track(compress, compressionHeld));
      vi.spyOn(transcriptRedact, "sanitizeTranscriptMessage").mockImplementation(
        track(redact, redactionHeld),
      );
      vi.spyOn(JSON, "stringify").mockImplementation(
        track(stringify, largeJsonHeld, (result) => result),
      );
      vi.spyOn(JSON, "parse").mockImplementation(track(parse, largeJsonHeld, (_, json) => json));
      let entryId: string;
      try {
        entryId = manager.appendMessage(message);
      } finally {
        vi.restoreAllMocks();
      }
      expect(redactionHeld).toEqual([false]);
      expect(compressionHeld).toEqual([false]);
      expect(largeJsonHeld.length).toBeGreaterThan(0);
      expect(largeJsonHeld).not.toContain(true);
      const entry = manager.getEntry(entryId);
      expect(entry).toMatchObject({
        parentId,
        message: {
          role,
          content,
          __openclaw: { media: [{ path: "/media/a.png", contentType: "image/png" }] },
        },
      });
      if (entry?.type !== "message") {
        throw new Error("Missing committed message");
      }
      expect(entry.message).not.toHaveProperty("MediaPaths");
      expect(entry.message).not.toHaveProperty("MediaTypes");
      const stored = loadTranscriptEventsSync(scope);
      expect(stored.at(-1)).toEqual(manager.getEntry(entryId));
      const replay = appendTranscriptMessageSnapshotSync(
        scope,
        { message, eventId: entryId, parentId, now: 2 },
        prepareTranscriptMessageAppend({ message }),
      );
      expect(replay).toMatchObject({
        ok: true,
        value: { result: { appended: false, messageId: entryId, message: entry.message } },
      });
      expect(loadTranscriptEventsSync(scope)).toEqual(stored);
    });
  },
);

it("rejects a stale generation and stores prepared messages under the rebased descendant", async () => {
  await withOpenClawTestState({ label: "session-prepared-reparent" }, async (state) => {
    const { scope, manager, parentId, db } = await setup(state);
    const message = assistantMessage("prepared response ".repeat(8000));
    const prepared = prepareTranscriptMessageAppend({ message });
    expect(prepared?.persistedMessage).toEqual(message);
    const expectedMutationAt = readTranscriptMutationAtSync(scope);
    const descendant = manager.appendMessage(assistantMessage("intervening assistant"));
    const before = loadTranscriptEventsSync(scope);
    const options = {
      message,
      eventId: "prepared-response",
      parentId,
      now: 2,
      appendIntent: "active-branch" as const,
    };
    expect(() =>
      appendTranscriptMessageSnapshotSync(scope, { ...options, expectedMutationAt }, prepared),
    ).toThrow("SQLite transcript changed while preparing rewrite");
    expect(loadTranscriptEventsSync(scope)).toEqual(before);

    expect(appendTranscriptMessageSnapshotSync(scope, options, prepared)).toMatchObject({
      ok: true,
      value: { result: { appended: true, effectiveParentId: descendant } },
    });
    expect(loadTranscriptEventsSync(scope)).toEqual([
      ...before,
      expect.objectContaining({ id: "prepared-response", parentId: descendant, message }),
    ]);
    const row = db
      .prepare("SELECT navigation_json FROM transcript_events ORDER BY seq DESC LIMIT 1")
      .get();
    if (typeof row?.navigation_json !== "string") {
      throw new Error("Expected compressed rebased transcript metadata");
    }
    expect(JSON.parse(row.navigation_json).report.entry.parentId).toBe(descendant);
  });
});
