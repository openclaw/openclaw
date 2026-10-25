import { Worker } from "node:worker_threads";
import { captureRuntimeConfigAsyncReader } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { filterMemorySearchHitsBySessionVisibility } from "./session-search-visibility.js";

function seed(
  agentId: string,
  sessionKey: string,
  sessionId: string,
  fields: Partial<Parameters<typeof upsertSessionEntry>[0]["entry"]> = {},
) {
  return upsertSessionEntry({
    agentId,
    sessionKey,
    entry: { sessionId, updatedAt: 1, ...fields },
  });
}

it.each([false, true])(
  "reads only hit identities and required aliases (recall=%s)",
  async (recall) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      await captureRuntimeConfigAsyncReader()();
      const anchor = "agent:main:telegram:direct:owner";
      const visible = "agent:main:telegram:direct:friend";
      const shared = "agent:main:telegram:group:team";
      const legacyArchive = "agent:main:telegram:direct:legacy";
      await seed("main", anchor, "current", { chatType: "direct" });
      await seed("main", visible, "candidate", {
        chatType: "direct",
        parentSessionKey: "agent:retired:parent",
      });
      await seed("main", shared, "\tcandidate\u00a0", { chatType: "group" });
      await seed("main", legacyArchive, "after-reset", { chatType: "direct" });
      await seed("main", "agent:main:unrelated", "unrelated");
      await seed("other", "agent:other:unrelated", "other");
      await seed("retired", "agent:retired:parent", "parent");
      const hit = {
        path: "sessions/main/candidate.jsonl",
        source: "sessions" as const,
        snippet: "private context",
        score: 1,
        startLine: 1,
        endLine: 2,
      };
      const archiveHit = {
        ...hit,
        path: "sessions/main/telegram:direct:legacy.jsonl.reset.2026-08-11T08-00-00.000Z",
      };
      using posted = vi.spyOn(Worker.prototype, "postMessage");
      using emitted = vi.spyOn(Worker.prototype, "emit");
      const hits = [hit, { ...hit, startLine: 3, endLine: 4 }];
      const filtered = await filterMemorySearchHitsBySessionVisibility({
        cfg: {
          agents: { entries: { main: {}, other: {} } },
          tools: { sessions: { visibility: "self" } },
        },
        agentId: "main",
        requesterSessionKey: recall ? anchor : visible,
        sandboxed: false,
        hits: [...hits, archiveHit],
        conversationRecall: recall
          ? { anchorSessionKey: anchor, scope: "same-agent-private", corpus: "sessions" }
          : undefined,
      });
      expect(filtered).toEqual(recall ? [archiveHit] : hits);
      const readKeys: unknown[] = [];
      posted.mock.calls.forEach(([message]: readonly unknown[]) => {
        const input = isRecord(message) ? message.input : undefined;
        if (isRecord(input) && input.kind === "session-entry-read" && isRecord(input.scope)) {
          readKeys.push(input.scope.sessionKey);
        }
      });
      emitted.mock.calls.forEach(([event, message]: readonly unknown[]) => {
        const reply = isRecord(message) && isRecord(message.value) ? message.value : undefined;
        const value = reply?.ok === true && isRecord(reply.value) ? reply.value : undefined;
        if (event === "message" && value && Array.isArray(value.entries)) {
          readKeys.push(
            ...value.entries.map((row) => (isRecord(row) ? row.sessionKey : undefined)),
          );
        }
      });
      const expectedKeys = [...(recall ? [anchor] : []), visible, shared, legacyArchive];
      expect(readKeys).toHaveLength(expectedKeys.length);
      expect(readKeys).toEqual(expect.arrayContaining(expectedKeys));
    });
  },
);
