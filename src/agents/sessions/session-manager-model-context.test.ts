import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { StatementSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { LEGACY_MISSING_TOOL_RESULT_TEXT } from "../../../packages/agent-core/src/harness/session/tool-result-pairing.js";
import { makeUserMessage } from "../../../test/helpers/user-message.js";
import {
  appendTranscriptEvent,
  upsertSessionEntryCore,
} from "../../config/sessions/session-accessor.js";
import {
  replaceTranscriptEvents,
  replaceTranscriptEventsSync,
} from "../../config/sessions/session-accessor.sqlite-transcript-write.test-support.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import {
  afterModelRead,
  expectCancelledReads,
  sessionScope,
  withSessionState,
} from "./session-manager-fixtures.test-support.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";
import { toolResult } from "./session-message-fixtures.test-support.js";

function readModel(...args: Parameters<typeof SessionManager.openModelContext>) {
  return SessionManager.openModelContext(...args).buildSessionContext();
}

async function readModelAsync(...args: Parameters<typeof SessionManager.openModelContextAsync>) {
  return (await SessionManager.openModelContextAsync(...args)).buildSessionContext();
}

function withoutPayload<T>(markers: string[], read: () => T): T {
  const parse = JSON.parse;
  let bytes = 0;
  const spy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    if (typeof text === "string" && markers.some((marker) => text.includes(marker))) {
      bytes += text.length;
    }
    return parse(text, reviver);
  });
  try {
    const result = read();
    expect(bytes).toBe(0);
    return result;
  } finally {
    spy.mockRestore();
  }
}

function fingerprint(scope: Parameters<typeof SessionManager.open>[0]) {
  const database = openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
  const hash = createHash("sha256");
  for (const row of database.db
    .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
    .iterate(scope.sessionId)) {
    hash.update(String(row.event_json));
  }
  return hash.digest("hex");
}

it("reports context queue overload without losing context and completes every admitted read", async () => {
  await withSessionState("context-pressure", async ({ scope }) => {
    const source = SessionManager.open(scope);
    source.appendMessage(makeUserMessage("retain this context", 1));
    await waitForSessionTranscriptProjection(scope);
    const expected = source.buildSessionContext();
    const release = createDeferredCore();
    const completed: number[] = [];
    const spy = vi.spyOn(WorkerTaskPool.prototype, "run").mockImplementationOnce(function (
      this: WorkerTaskPool<unknown, unknown>,
      input,
      options,
    ) {
      spy.mockRestore();
      // Hold this caller's first preparation while real pool admission fills the queue.
      return this.run(async () => {
        await release.promise;
        return typeof input === "function" ? await input() : input;
      }, options);
    });
    const accepted = Array.from({ length: 128 }, (_, index) =>
      SessionManager.openModelContextAsync(scope).then((context) => {
        completed.push(index);
        return context.buildSessionContext();
      }),
    );
    let reported: unknown;
    const excess = SessionManager.openModelContextAsync(scope).catch((error: unknown) => {
      reported = error;
    });
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(reported).toMatchObject({ name: "WorkerTaskError", code: "overloaded" });
      expect(completed).toEqual([]);
      expect(source.buildSessionContext()).toEqual(expected);
      release.resolve();
      expect(await Promise.all(accepted)).toEqual(Array.from({ length: 128 }, () => expected));
      // Foreground reads run on a worker pool, so completion order is not FIFO.
      expect(completed.toSorted((a, b) => a - b)).toEqual(
        Array.from({ length: 128 }, (_, index) => index),
      );
      expect(await readModelAsync(scope)).toEqual(expected);
    } finally {
      release.resolve();
      spy.mockRestore();
      await Promise.allSettled([...accepted, excess]);
    }
  });
});

it("acquires a long sparse context with bounded queries and preserved message order", async () => {
  await withSessionState("batched-context", async ({ scope }) => {
    const messages = Array.from({ length: 1_200 }, (_, index) => ({
      type: "message",
      id: `message-${index}`,
      parentId: index === 0 ? null : `message-${index - 1}`,
      timestamp: new Date(index).toISOString(),
      message: {
        role: "user",
        content: `message ${index}`,
        timestamp: index,
        excludeFromContext: index % 17 === 0,
      },
    }));
    await replaceTranscriptEvents(scope, [
      { type: "session", version: CURRENT_SESSION_VERSION, id: scope.sessionId, cwd: "/synthetic" },
      ...messages,
    ]);
    const database = openOpenClawAgentDatabase({ agentId: "main", path: scope.storePath });
    const prototype = Object.getPrototypeOf(database.db.prepare("SELECT 1")) as StatementSync;
    const iterate = vi.spyOn(prototype, "iterate");
    const get = vi.spyOn(prototype, "get");
    try {
      const context = SessionManager.openModelContext(scope).buildSessionContext();
      expect(context.messages.map((message) => "content" in message && message.content)).toEqual(
        messages
          .filter((entry) => !entry.message.excludeFromContext)
          .map((entry) => entry.message.content),
      );
      // Protect acquisition cost independently of the exact chunk size or query implementation.
      expect(iterate.mock.calls.length + get.mock.calls.length).toBeLessThan(20);
      expect(await readModelAsync(scope)).toEqual(context);
    } finally {
      iterate.mockRestore();
      get.mockRestore();
    }
  });
});

it.each([
  "whole",
  "reset",
  "compaction",
  "reset-compaction",
  "leaf",
  "opaque",
  "opaque-compaction",
  "leaf-compaction",
])(
  "acquires detached %s context without native payloads or changing stored evidence",
  async (scenario) => {
    await withSessionState("model-view", async ({ state, scope }) => {
      const source = SessionManager.open(scope);
      const marker = "synthetic-native-memory:";
      const metadata = {
        upstreamUserText: marker + "x".repeat(256 * 1024),
        mirrorIdentity: "synthetic-identity",
        mirrorOrigin: "synthetic-origin",
        turnTainted: true,
        sender: { id: "synthetic-sender" },
        media: { type: "synthetic" },
      };
      await source.appendThinkingLevelChange("high");
      await source.appendModelChange("openai", "gpt-5.6-luna");
      const old = source.appendMessage({
        role: "user",
        content: "old",
        timestamp: 1,
        __openclaw: metadata,
      } as Parameters<SessionManager["appendMessage"]>[0]);
      const excluded = source.appendMessage({
        role: "custom",
        customType: "display",
        content: marker + "d".repeat(256 * 1024),
        display: true,
        excludeFromContext: true,
        timestamp: 1,
      });
      const kept = source.appendMessage({
        role: "user",
        content: "kept",
        timestamp: 2,
        __openclaw: metadata,
      } as Parameters<SessionManager["appendMessage"]>[0]);
      source.appendMessage(
        makeAgentAssistantMessage({
          model: "gpt-5.6-luna",
          providerReplay: {
            v: 1,
            type: "openai-responses-compaction",
            data: "synthetic-checkpoint",
            provider: "openai",
            api: "openai-responses",
            model: "gpt-5.6-luna",
            baseUrlHash: "synthetic",
          },
          content: [
            {
              type: "toolCall",
              id: "paired",
              name: "read",
              arguments: { nested: { path: "synthetic.txt" } },
            },
          ],
          stopReason: "toolUse",
        }),
      );
      const result = source.appendMessage(toolResult("tool output", "paired", 3));
      source.appendCustomMessageEntry("synthetic-context", "custom context", true, {
        source: "synthetic",
      });
      source.branchWithSummary(source.getLeafId(), "branch summary");
      if (scenario === "reset" || scenario === "reset-compaction") {
        source.appendResetBoundary("new", kept);
      }
      if (scenario === "compaction" || scenario === "reset-compaction") {
        source.appendCompaction("summary", scenario === "compaction" ? excluded : kept, 100);
      }
      if (scenario === "opaque-compaction") {
        await appendTranscriptEvent(scope, {
          type: "opaque-synthetic",
          id: "opaque-keep",
          parentId: kept,
        });
        source.reloadPersistedTranscript();
        source.appendCompaction("summary", "opaque-keep", 100);
      }
      if (scenario === "leaf-compaction") {
        const leafMarker = source.appendLeafControl({ targetId: kept, appendParentId: kept });
        source.appendCompaction("summary", leafMarker.id, 100);
      }
      if (scenario === "leaf") {
        source.branch(old);
        const inactive = source.appendMessage({
          role: "user",
          content: marker + "abandoned".repeat(4096),
          timestamp: 4,
        });
        source.appendLeafControl({
          targetId: result,
          appendParentId: inactive,
          appendMode: "side",
        });
      }
      if (scenario === "opaque") {
        await appendTranscriptEvent(scope, {
          type: "opaque-synthetic",
          id: "opaque",
          parentId: result,
          data: marker + "o".repeat(256 * 1024),
        });
        source.reloadPersistedTranscript();
      }
      source.appendMessage(makeUserMessage("latest", 5));
      const expected = source.buildSessionContext();
      expect(await readModelAsync(scope)).toEqual(readModel(scope));
      expect(SessionManager.readSessionContext(scope, (messages) => Array.from(messages))).toEqual(
        expected.messages,
      );
      const visible = (messages: typeof expected.messages) =>
        messages.map((message) => ({
          role: message.role,
          content: "content" in message ? message.content : undefined,
          summary: "summary" in message ? message.summary : undefined,
        }));
      const before = fingerprint(scope);
      const detached = withoutPayload([marker], () => SessionManager.openModelContext(scope));
      expect(detached.isPersisted()).toBe(false);
      expect(detached.getHeader()?.id).toBe(scope.sessionId);
      expect(detached.migrated).toBe(false);
      expect(detached.getBoundaryCount()).toBe(source.getBoundaryCount());
      const context = detached.buildSessionContext();
      expect(visible(context.messages)).toEqual(visible(expected.messages));
      expect(context.model).toEqual(expected.model);
      expect(
        context.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.providerReplay),
      ).toEqual(
        expected.messages
          .filter((message) => message.role === "assistant")
          .map((message) => message.providerReplay),
      );
      expect(context.thinkingLevel).toBe("high");
      const retainedUser = context.messages.find(
        (message) => message.role === "user" && message.content === "kept",
      );
      expect(retainedUser).toMatchObject({
        __openclaw: {
          mirrorIdentity: "synthetic-identity",
          mirrorOrigin: "synthetic-origin",
          turnTainted: true,
          sender: metadata.sender,
          media: metadata.media,
        },
      });
      expect(
        Object.hasOwn(
          (retainedUser as unknown as { __openclaw: object })["__openclaw"],
          "upstreamUserText",
        ),
      ).toBe(false);
      if (scenario === "reset") {
        expect(
          (retainedUser as unknown as Record<symbol, unknown>)[
            Symbol.for("openclaw.sessionHistoryPrelude")
          ],
        ).toBe(true);
      }
      detached.appendMessage(makeUserMessage("review only", 6));
      expect(fingerprint(scope)).toBe(before);
      source.branch(source.getLeafId()!);
      await waitForSessionTranscriptProjection(scope);
      const admitted = source.appendMessageWithTranscriptAnchor(makeUserMessage("current turn", 7));
      assert(admitted.anchor, "missing admission");
      const admission = {
        ...admitted.anchor,
        role: "user" as const,
        logicalTurnId: "synthetic-turn",
      };
      const earlier = runWithSessionTranscriptReadFence(admission, () => readModel(scope));
      expect(
        (
          await runWithSessionTranscriptReadFence(admission, () =>
            SessionManager.openModelContextAsync(scope),
          )
        ).buildSessionContext(),
      ).toEqual(earlier);
      if (scenario === "whole") {
        for (const patch of [
          { role: "assistant" },
          { sessionKey: "agent:main:wrong" },
          { storePath: path.join(state.agentDir("main"), "wrong.sqlite") },
        ]) {
          expect(() =>
            SessionManager.openModelContext(scope, {
              admission: { ...admission, ...patch } as typeof admission,
            }),
          ).toThrow(/Current-turn transcript admission/);
          await expect(
            SessionManager.openModelContextAsync(scope, {
              admission: { ...admission, ...patch } as typeof admission,
            }),
          ).rejects.toThrow(/Current-turn transcript admission/);
          expect(() =>
            SessionManager.readSessionContext(scope, () => [], {
              admission: { ...admission, ...patch } as typeof admission,
            }),
          ).toThrow(/Current-turn transcript admission/);
        }
      }
      source.appendResetBoundary("new");
      source.appendCompaction("later summary", admitted.entryId, 100);
      expect(runWithSessionTranscriptReadFence(admission, () => readModel(scope))).toEqual(earlier);
    });
  },
);

it.each([
  { boundary: "reset", role: "user" },
  { boundary: "reset", role: "assistant" },
  { boundary: "reset", role: "toolResult" },
  { boundary: "compaction", role: "toolResult" },
  { boundary: "whole", role: "user" },
] as const)(
  "preserves excluded $role payload selection across $boundary",
  async ({ boundary, role }) => {
    await withSessionState("excluded-retention", async ({ scope }) => {
      const source = SessionManager.open(scope);
      const pairedCall =
        role === "toolResult"
          ? source.appendMessage(
              makeAgentAssistantMessage({
                content: [{ type: "toolCall", id: "paired", name: "read", arguments: {} }],
              }),
            )
          : undefined;
      const content = [{ type: "text" as const, text: "synthetic retained text" }];
      const message = {
        ...(role === "assistant"
          ? makeAgentAssistantMessage({ content })
          : role === "user"
            ? { role, content: "synthetic retained text", timestamp: 1 }
            : {
                role,
                content,
                toolCallId: "paired",
                toolName: "read",
                isError: false,
                timestamp: 1,
              }),
        excludeFromContext: true,
        __openclaw: { upstreamUserText: "private-retained:" + "x".repeat(256 * 1024) },
      };
      const retained = source.appendMessage(message);
      if (boundary === "reset") {
        source.appendResetBoundary("new", pairedCall ?? retained);
      } else if (boundary === "compaction") {
        source.appendCompaction("summary", pairedCall ?? retained, 100);
      }
      const ordinaryExcluded = {
        role: "user" as const,
        content: "ordinary-excluded:" + "x".repeat(256 * 1024),
        timestamp: 2,
        excludeFromContext: true,
      };
      source.appendMessage(ordinaryExcluded);
      source.appendMessage(makeUserMessage("synthetic current text", 3));
      const expected = source.buildSessionContext();
      expect(
        expected.messages.some(
          (entry) => "excludeFromContext" in entry && entry.excludeFromContext === true,
        ),
      ).toBe(boundary === "reset");
      const before = fingerprint(scope);
      const actual = withoutPayload(["private-retained:", "ordinary-excluded:"], () =>
        readModel(scope),
      );
      expect(fingerprint(scope)).toBe(before);
      expect(actual.model).toEqual(expected.model);
      expect(
        actual.messages.map((entry) => ("content" in entry ? entry.content : undefined)),
      ).toEqual(expected.messages.map((entry) => ("content" in entry ? entry.content : undefined)));
    });
  },
);

it("keeps durable model reads non-persisting", async () => {
  await withOpenClawTestState({ label: "model-readonly" }, async (state) => {
    const scope = sessionScope(
      path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      "readonly",
    );
    expect(readModel(scope).messages).toEqual([]);
    expect((await readModelAsync(scope)).messages).toEqual([]);
    expect(SessionManager.readSessionContext(scope, (messages) => Array.from(messages))).toEqual(
      [],
    );
    expect(
      await SessionManager.readSessionContextAsync(scope, (messages) => [...messages]),
    ).toEqual([]);
    expect(fs.existsSync(scope.storePath)).toBe(false);
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
    });
    const source = SessionManager.open(scope);
    source.appendMessage(makeUserMessage("visible", 1));
    const view = SessionManager.openModelContext(scope);
    expect(await readModelAsync(scope)).toEqual(view.buildSessionContext());
    expect(view.buildSessionContext()).toEqual(source.buildSessionContext());
    expect(view.isPersisted()).toBe(false);
    const database = openOpenClawAgentDatabase({ agentId: "main", path: scope.storePath });
    // A transient reader reconstructs navigation from its own read snapshot, not a stale cache.
    database.db
      .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
      .run(scope.sessionId);
    expect(readModel(scope)).toEqual(source.buildSessionContext());
    database.db
      .prepare("DELETE FROM session_transcript_index_state WHERE session_id = ?")
      .run(scope.sessionId);
    expect(readModel(scope)).toEqual(source.buildSessionContext());
    expect(
      database.db
        .prepare("SELECT COUNT(*) AS n FROM session_transcript_index_state WHERE session_id = ?")
        .get(scope.sessionId)?.n,
    ).toBe(0);
    const parse = JSON.parse;
    const parseSpy = vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      if (typeof text === "string" && text.includes('"role":"user"')) {
        throw new Error("synthetic decode failure");
      }
      return parse(text, reviver);
    });
    try {
      expect(() => SessionManager.openModelContext(scope)).toThrow("synthetic decode failure");
    } finally {
      parseSpy.mockRestore();
    }
    expect(database.db.isTransaction).toBe(false);
    expect(readModel(scope)).toEqual(source.buildSessionContext());
  });
});

it("releases aborted durable context reads before the next read", async () => {
  await withSessionState("worker-lifecycle", async ({ scope }) => {
    const source = SessionManager.open(scope);
    source.appendMessage(makeUserMessage("visible", 1));
    expect(await readModelAsync(scope)).toEqual(source.buildSessionContext());
    await expectCancelledReads((signal) => SessionManager.openModelContextAsync(scope, { signal }));
    expect(await readModelAsync(scope)).toEqual(source.buildSessionContext());
  });
});

it.each(["rewrite", "append"] as const)(
  "validates durable admission before accepting context (mutation=%s)",
  async (mutation) => {
    await withSessionState("worker-fence", async ({ scope }) => {
      const source = SessionManager.open(scope);
      source.appendMessage(makeUserMessage("previous", 1));
      await waitForSessionTranscriptProjection(scope);
      const admitted = source.appendMessageWithTranscriptAnchor(makeUserMessage("current", 2));
      assert(admitted.anchor, "missing admission");
      const admission = {
        ...admitted.anchor,
        role: "user" as const,
        logicalTurnId: "worker-fence",
      };
      const expected = readModel(scope, { admission });
      const mutate = () => {
        if (mutation === "rewrite") {
          expect(
            source.removeTrailingEntries(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "user" &&
                entry.message.content === "current",
            ),
          ).toBe(1);
        }
        source.appendMessage(makeUserMessage("replacement", 3));
      };
      const spy = afterModelRead(mutate, true);
      try {
        const pending = SessionManager.openModelContextAsync(scope, { admission });
        if (mutation === "rewrite") {
          await expect(pending).rejects.toThrow("Current-turn transcript admission");
        } else {
          expect((await pending).buildSessionContext()).toEqual(expected);
        }
      } finally {
        spy.mockRestore();
      }
    });
  },
);

it.each(["append", "rewrite", "delete", "branch", "compaction", "reset", "other-session"] as const)(
  "validates unadmitted durable context before acceptance (mutation=%s)",
  async (mutation) => {
    await withSessionState("unadmitted-context", async ({ scope }) => {
      const source = SessionManager.open(scope);
      const first = source.appendMessage(makeUserMessage("before", 1));
      if (mutation === "branch") {
        source.appendMessage(makeUserMessage("branch tip", 2));
      }
      const expected = source.buildSessionContext();
      let mutationSource = source;
      if (mutation === "other-session") {
        const otherScope = {
          ...scope,
          sessionId: "other-context",
          sessionKey: `${scope.sessionKey}-other`,
        };
        await upsertSessionEntryCore(otherScope, {
          sessionId: otherScope.sessionId,
          updatedAt: 1,
        });
        mutationSource = SessionManager.open(otherScope);
      }
      const mutate = () => {
        if (mutation === "rewrite") {
          expect(
            replaceTranscriptEventsSync(scope, [
              source.getHeader(),
              ...source.getEntries().map((entry) =>
                entry.type === "message"
                  ? Object.assign({}, entry, {
                      message: makeUserMessage("rewritten prefix", 1),
                    })
                  : entry,
              ),
            ]),
          ).toBe(true);
          return;
        }
        if (mutation === "delete") {
          expect(
            source.removeTrailingEntries(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "user" &&
                entry.message.content === "before",
            ),
          ).toBe(1);
          return;
        }
        if (mutation === "branch") {
          source.branch(first);
        } else if (mutation === "compaction") {
          source.appendCompaction("summary", first, 1);
        } else if (mutation === "reset") {
          source.resetLeaf();
        }
        mutationSource.appendMessage(makeUserMessage("after", 2));
      };
      const spy = afterModelRead(mutate, true);
      try {
        const pending = SessionManager.openModelContextAsync(scope);
        if (mutation === "other-session" || mutation === "append") {
          expect((await pending).buildSessionContext()).toEqual(expected);
        } else {
          await expect(pending).rejects.toThrow("Session transcript changed during context read");
        }
      } finally {
        spy.mockRestore();
      }
    });
  },
);

it.each([false, true])(
  "closes lazy context without acquiring unread payloads (rejected=%s)",
  async (rejected) => {
    await withSessionState("lazy-context", async ({ scope }) => {
      const source = SessionManager.open(scope);
      source.appendMessage(makeUserMessage("first", 1));
      const marker = "synthetic-unread-context:";
      source.appendMessage({
        role: "user",
        content: marker + "x".repeat(256 * 1024),
        timestamp: 2,
      });
      let retained: Iterator<unknown> | undefined;
      withoutPayload([marker], () => {
        const read = () =>
          SessionManager.readSessionContext(scope, (messages) => {
            retained = messages[Symbol.iterator]();
            expect(retained.next().value).toMatchObject({ role: "user", content: "first" });
            if (rejected) {
              throw new Error("synthetic projection rejection");
            }
          });
        if (rejected) {
          expect(read).toThrow("synthetic projection rejection");
        } else {
          read();
        }
        expect(retained?.next()).toEqual({ done: true, value: undefined });
      });
      expect(SessionManager.readSessionContext(scope, (messages) => Array.from(messages))).toEqual(
        source.buildSessionContext().messages,
      );
    });
  },
);

it.each(["details", "text", "duplicate-object", "late-array-call"])(
  "keeps real tool output across reset (%s)",
  async (marker) => {
    await withSessionState("pairing", async ({ scope }) => {
      const source = SessionManager.open(scope);
      const firstKept = source.appendMessage(
        makeAgentAssistantMessage({
          content: [
            ...Array.from({ length: marker === "late-array-call" ? 16 : 1 }, () => ({
              type: "text" as const,
              text: "Reading the file",
            })),
            { type: "toolCall", id: "repeat", name: "read", arguments: { path: "synthetic.txt" } },
          ],
        }),
      );
      const missingResult = source.appendMessage({
        ...toolResult(
          marker === "details" ? "missing" : LEGACY_MISSING_TOOL_RESULT_TEXT,
          "repeat",
          1,
        ),
        isError: true,
        ...(marker === "details" ? { details: { openclawSyntheticMissingToolResult: true } } : {}),
      });
      source.appendMessage(toolResult("real output", "repeat", 2));
      source.appendMessage(toolResult("orphan-body:" + "x".repeat(512 * 1024), "orphan", 3));
      source.appendResetBoundary("new", firstKept);
      if (marker === "duplicate-object") {
        await waitForSessionTranscriptProjection(scope);
        const database = openOpenClawAgentDatabase({ agentId: "main", path: scope.storePath });
        // Preserve duplicate members from imported JSON; JavaScript objects would collapse them.
        const content = `{"part":{"type":"text","text":"ordinary"},"part":{"type":"text","text":${JSON.stringify(LEGACY_MISSING_TOOL_RESULT_TEXT)}}}`;
        database.db
          .prepare(
            "UPDATE transcript_events SET event_json = json_set(event_json, '$.message.content', json(?)) WHERE session_id = ? AND json_extract(event_json, '$.id') = ?",
          )
          .run(content, scope.sessionId, missingResult);
      }
      const messages = withoutPayload(["orphan-body:"], () => readModel(scope).messages);
      expect(
        messages
          .filter((message) => message.role === "toolResult")
          .map((message) => message.content),
      ).toEqual([[{ type: "text", text: "real output" }]]);
    });
  },
);

it.each(["reset", "compaction"])(
  "does not acquire checkpoints invalidated by %s",
  async (boundary) => {
    await withSessionState("checkpoint", async ({ scope }) => {
      const source = SessionManager.open(scope);
      const kept = source.appendMessage(makeUserMessage("visible", 1));
      const marker = "synthetic-obsolete-checkpoint-";
      const checkpoint = {
        v: 1 as const,
        type: "openai-responses-compaction",
        data: marker + "x".repeat(1024 * 1024),
        provider: "openai",
        api: "openai-responses",
        model: "gpt-5.6-luna",
        baseUrlHash: "synthetic",
      };
      source.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "kept answer" }],
          model: "gpt-5.6-luna",
          providerReplay: checkpoint,
        }),
      );
      if (boundary === "reset") {
        source.appendResetBoundary("new", kept);
      } else {
        source.appendCompaction("summary", kept, 100);
      }
      const valid = { ...checkpoint, data: "valid-post-boundary-checkpoint" };
      source.appendMessage(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "new answer" }],
          model: "gpt-5.6-luna",
          providerReplay: valid,
        }),
      );
      const context = withoutPayload([marker], () => readModel(scope));
      expect(context).toEqual(source.buildSessionContext());
      expect(context.messages.at(-1)).toMatchObject({ providerReplay: valid });
    });
  },
);

it("refills warmed context when a prompt restart retires a suffix entry", async () => {
  await withSessionState("model-prompt-restart", async ({ scope }) => {
    const source = SessionManager.open(scope);
    for (let index = 1; index <= 4; index++) {
      source.appendMessage(makeUserMessage(`question-${index}`, index));
    }
    source.appendCustomMessageEntry("openclaw.system-update", "old prompt", false, {
      kind: "prompt-update",
    });
    const limits = { maxBytes: 1_000_000, maxEvents: 4 };
    const read = () => readModelAsync(scope, { limits });
    const warmed = await read();
    expect(warmed.messages).toHaveLength(4);
    expect(warmed.messages[0]).toMatchObject({ content: "question-2" });

    source.appendCustomEntry("openclaw.system-prompt", { restart: true });
    const expected = source.buildSessionContext();
    expect(expected.messages).toHaveLength(4);
    expect(expected.messages[0]).toMatchObject({ content: "question-1" });
    expect(await read()).toEqual(expected);
    expect(await read()).toEqual(expected);
  });
});

it("keeps warmed current context after historical and smaller-window reads", async () => {
  await withSessionState("model-anchor-retention", async ({ scope }) => {
    const source = SessionManager.open(scope);
    const discardedId = source.appendMessage(makeUserMessage("discarded-prefix", 0));
    for (let index = 1; index < 6; index++) {
      source.appendMessage(makeUserMessage(`question-${index}`, index));
    }
    await waitForSessionTranscriptProjection(scope);
    const historical = source.appendMessageWithTranscriptAnchor(makeUserMessage("question-6", 6));
    assert(historical.anchor, "missing historical anchor");
    for (let index = 7; index < 16; index++) {
      source.appendMessage(makeUserMessage(`question-${index}`, index));
    }
    await waitForSessionTranscriptProjection(scope);
    const limits = { maxBytes: 8192, maxEvents: 4 };
    const readCurrent = () => SessionManager.openModelContext(scope, { limits });
    const current = readCurrent();
    const expected = current.buildSessionContext();
    expect(current.getBranch().some((entry) => entry.id === discardedId)).toBe(false);
    expect(expected.messages.at(-1)).toMatchObject({ content: "question-15" });

    const earlier = SessionManager.openModelContext(scope, {
      through: historical.anchor,
      limits: { ...limits, maxEvents: 2 },
    });
    expect(earlier.buildSessionContext().messages.at(-1)).toMatchObject({ content: "question-6" });

    withoutPayload([JSON.stringify(discardedId)], () => {
      expect(readCurrent().buildSessionContext()).toEqual(expected);
      expect(
        SessionManager.openModelContext(scope, {
          limits: { ...limits, maxEvents: 2 },
        })
          .buildSessionContext()
          .messages.at(-1),
      ).toMatchObject({ content: "question-15" });
      expect(readCurrent().buildSessionContext()).toEqual(expected);
    });
  });
});
