import path from "node:path";
import { expect, it, vi } from "vitest";
import {
  loadTranscriptEventsSync,
  readTranscriptMutationAtSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import { prepareTranscriptMessageAppend } from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import { appendTranscriptMessageSnapshotSync } from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { resolveZstdCodec } from "../../infra/zstd-codec.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import type { AgentMessage } from "../runtime/index.js";
import { createZeroUsageFixture } from "../test-helpers/usage-fixtures.js";
import * as transcriptRedact from "../transcript-redact.js";
import { SessionManager } from "./session-manager.js";

it.each(["assistant", "toolResult"] as const)(
  "prepares large %s payloads before the writer lock and preserves keyed replay",
  async (role) => {
    await withOpenClawTestState({ label: "session-write-hold" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "write-hold",
        sessionKey: "agent:main:write-hold",
        storePath: path.join(state.sessionsDir(), "sessions.json"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const manager = SessionManager.open(scope, state.workspaceDir);
      const parentId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
      const { db } = openOpenClawAgentDatabase({
        agentId: scope.agentId,
        path: resolveSessionTranscriptDatabasePath(scope),
      });
      const text = "```ts\nconst value = 42;\n```\n".repeat(8000);
      const content = [{ type: "text" as const, text }];
      const message: AgentMessage =
        role === "assistant"
          ? {
              role,
              content,
              api: "messages",
              provider: "anthropic",
              model: "sonnet-4.6",
              usage: createZeroUsageFixture(),
              stopReason: "stop",
              timestamp: 2,
            }
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
      const redact = transcriptRedact.redactTranscriptMessage;
      const stringify = JSON.stringify;
      const parse = JSON.parse;
      const spies = [
        vi.spyOn(codec, "compress").mockImplementation((...args) => {
          compressionHeld.push(db.isTransaction);
          return compress(...args);
        }),
        vi.spyOn(transcriptRedact, "redactTranscriptMessage").mockImplementation((...args) => {
          redactionHeld.push(db.isTransaction);
          return redact(...args);
        }),
        vi.spyOn(JSON, "stringify").mockImplementation((...args: Parameters<typeof stringify>) => {
          const result = stringify(...args);
          if (result && result.length > 100_000) {
            largeJsonHeld.push(db.isTransaction);
          }
          return result;
        }),
        vi.spyOn(JSON, "parse").mockImplementation((...args: Parameters<typeof parse>) => {
          if (args[0].length > 100_000) {
            largeJsonHeld.push(db.isTransaction);
          }
          return parse(...args);
        }),
      ];
      let entryId: string;
      try {
        entryId = manager.appendMessage(message);
      } finally {
        for (const spy of spies) {
          spy.mockRestore();
        }
      }
      expect(redactionHeld).toEqual([false]);
      expect(largeJsonHeld.length).toBeGreaterThan(0);
      expect(largeJsonHeld).not.toContain(true);
      expect(compressionHeld).toEqual([false]);
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
        value: {
          result: { appended: false, messageId: entryId, message: entry.message },
        },
      });
      expect(loadTranscriptEventsSync(scope)).toEqual(stored);
    });
  },
);

it("rejects a stale generation and rebuilds prepared bytes for a rebased descendant", async () => {
  await withOpenClawTestState({ label: "session-prepared-reparent" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "prepared-reparent",
      sessionKey: "agent:main:prepared-reparent",
      storePath: path.join(state.sessionsDir(), "sessions.json"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const manager = SessionManager.open(scope, state.workspaceDir);
    const parentId = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text: "prepared response ".repeat(8000) }],
      api: "messages" as const,
      provider: "anthropic",
      model: "sonnet-4.6",
      usage: createZeroUsageFixture(),
      stopReason: "stop" as const,
      timestamp: 2,
    };
    const prepared = prepareTranscriptMessageAppend(
      { message },
      {
        scope,
        envelope: {
          type: "message",
          id: "prepared-response",
          parentId,
          timestamp: new Date(2).toISOString(),
        },
      },
    );
    expect(prepared?.physicalPayload?.payload.event_zstd).toBeInstanceOf(Uint8Array);
    const expectedMutationAt = readTranscriptMutationAtSync(scope);
    const descendant = manager.appendMessage({
      ...message,
      content: [{ type: "text", text: "intervening assistant" }],
    });
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
    const stored = loadTranscriptEventsSync(scope);
    expect(stored.slice(0, -1)).toEqual(before);
    expect(stored.at(-1)).toMatchObject({
      id: "prepared-response",
      parentId: descendant,
      message,
    });
    const { db } = openOpenClawAgentDatabase({
      agentId: scope.agentId,
      path: resolveSessionTranscriptDatabasePath(scope),
    });
    const row = db
      .prepare("SELECT navigation_json FROM transcript_events ORDER BY seq DESC LIMIT 1")
      .get();
    expect(typeof row?.navigation_json).toBe("string");
    if (typeof row?.navigation_json !== "string") {
      throw new Error("Expected compressed rebased transcript metadata");
    }
    expect(JSON.parse(row.navigation_json).report.entry.parentId).toBe(descendant);
  });
});
