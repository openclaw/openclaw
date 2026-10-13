import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
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
import * as transcriptAnchors from "../../config/sessions/session-transcript-anchor-read.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import * as contextWorker from "../../config/sessions/session-transcript-read-worker-runtime.js";
import { waitForSessionTranscriptProjection } from "../../config/sessions/session-transcript-reconcile.js";
import { WorkerTaskPool } from "../../infra/worker-task-pool.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { openOpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { CURRENT_SESSION_VERSION, SessionManager } from "./session-manager.js";

it("reports context queue overload without losing context and completes every admitted read", async () => {
  await withOpenClawTestState({ label: "model-context-pressure" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "context-pressure",
      sessionKey: "agent:main:context-pressure",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
    const source = await SessionManager.openAsync(scope);
    await source.appendMessageAsync(makeUserMessage("retain this context", 1));
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
        return input;
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
      expect((await SessionManager.openModelContextAsync(scope)).buildSessionContext()).toEqual(
        expected,
      );
    } finally {
      release.resolve();
      spy.mockRestore();
      await Promise.allSettled([...accepted, excess]);
    }
  });
});

it("acquires a long sparse context with preserved message order", async () => {
  await withOpenClawTestState({ label: "model-context-batch" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "batched-context",
      sessionKey: "agent:main:batched-context",
      storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
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
    const context = (await SessionManager.openModelContextAsync(scope)).buildSessionContext();
    expect(context.messages.map((message) => "content" in message && message.content)).toEqual(
      messages
        .filter((entry) => !entry.message.excludeFromContext)
        .map((entry) => entry.message.content),
    );
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
    await withOpenClawTestState({ label: "model-context" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "model-view",
        sessionKey: "agent:main:model-view",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(scope);
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
      const old = expectDefined(
        await source.appendMessageAsync({
          role: "user",
          content: "old",
          timestamp: 1,
          __openclaw: metadata,
        } as Parameters<SessionManager["appendMessageAsync"]>[0]),
        "Expected appended message",
      );
      const excluded = expectDefined(
        await source.appendMessageAsync({
          role: "custom",
          customType: "display",
          content: marker + "d".repeat(256 * 1024),
          display: true,
          excludeFromContext: true,
          timestamp: 1,
        }),
        "Expected appended message",
      );
      const kept = expectDefined(
        await source.appendMessageAsync({
          role: "user",
          content: "kept",
          timestamp: 2,
          __openclaw: metadata,
        } as Parameters<SessionManager["appendMessageAsync"]>[0]),
        "Expected appended message",
      );
      await source.appendMessageAsync(
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
      const result = expectDefined(
        await source.appendMessageAsync({
          role: "toolResult",
          toolName: "read",
          toolCallId: "paired",
          isError: false,
          timestamp: 3,
          content: [{ type: "text", text: "tool output" }],
        }),
        "Expected appended message",
      );
      await source.appendCustomMessageEntryAsync("synthetic-context", "custom context", true, {
        source: "synthetic",
      });
      await source.branchWithSummaryAsync(source.getLeafId(), "branch summary");
      if (scenario === "reset" || scenario === "reset-compaction") {
        await source.appendResetBoundaryAsync("new", kept);
      }
      if (scenario === "compaction" || scenario === "reset-compaction") {
        await source.appendCompactionAsync(
          "summary",
          scenario === "compaction" ? excluded : kept,
          100,
        );
      }
      if (scenario === "opaque-compaction") {
        await appendTranscriptEvent(scope, {
          type: "opaque-synthetic",
          id: "opaque-keep",
          parentId: kept,
        });
        await source.reloadPersistedTranscriptAsync();
        await source.appendCompactionAsync("summary", "opaque-keep", 100);
      }
      if (scenario === "leaf-compaction") {
        const leafMarker = await source.appendLeafControlAsync({
          targetId: kept,
          appendParentId: kept,
        });
        await source.appendCompactionAsync("summary", leafMarker.id, 100);
      }
      if (scenario === "leaf") {
        await source.branchAsync(old);
        const inactive = expectDefined(
          await source.appendMessageAsync({
            role: "user",
            content: marker + "abandoned".repeat(4096),
            timestamp: 4,
          }),
          "Expected appended message",
        );
        await source.appendLeafControlAsync({
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
        await source.reloadPersistedTranscriptAsync();
      }
      await source.appendMessageAsync({ role: "user", content: "latest", timestamp: 5 });
      const expected = source.buildSessionContext();
      expect((await SessionManager.openModelContextAsync(scope)).buildSessionContext()).toEqual(
        (await SessionManager.openModelContextAsync(scope)).buildSessionContext(),
      );
      expect(
        await SessionManager.readSessionContextAsync(scope, (messages) => Array.from(messages)),
      ).toEqual(expected.messages);
      const visible = (messages: typeof expected.messages) =>
        messages.map((message) => ({
          role: message.role,
          content: "content" in message ? message.content : undefined,
          summary: "summary" in message ? message.summary : undefined,
        }));
      const database = openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
      const fingerprint = () => {
        const hash = createHash("sha256");
        for (const row of database.db
          .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
          .iterate(scope.sessionId)) {
          hash.update(String(row.event_json));
        }
        return hash.digest("hex");
      };
      const before = fingerprint();
      const detached = await SessionManager.openModelContextAsync(scope);

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
      await detached.appendMessageAsync({ role: "user", content: "review only", timestamp: 6 });
      expect(fingerprint()).toBe(before);
      await source.branchAsync(source.getLeafId()!);
      await waitForSessionTranscriptProjection(scope);
      const admitted = await source.appendMessageWithTranscriptAnchorAsync(
        makeUserMessage("current turn", 7),
      );
      if (!admitted.anchor) {
        throw new Error("missing admission");
      }
      const admission = {
        ...admitted.anchor,
        role: "user" as const,
        logicalTurnId: "synthetic-turn",
      };
      const earlier = await runWithSessionTranscriptReadFence(admission, async () =>
        (await SessionManager.openModelContextAsync(scope)).buildSessionContext(),
      );
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
          await expect(
            SessionManager.openModelContextAsync(scope, {
              admission: { ...admission, ...patch } as typeof admission,
            }),
          ).rejects.toThrow(/Current-turn transcript admission/);
          await expect(
            SessionManager.readSessionContextAsync(scope, () => [], {
              admission: { ...admission, ...patch } as typeof admission,
            }),
          ).rejects.toThrow(/Current-turn transcript admission/);
        }
      }
      await source.appendResetBoundaryAsync("new");
      await source.appendCompactionAsync("later summary", admitted.entryId, 100);
      expect(
        await runWithSessionTranscriptReadFence(admission, async () =>
          (await SessionManager.openModelContextAsync(scope)).buildSessionContext(),
        ),
      ).toEqual(earlier);
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
    await withOpenClawTestState({ label: "model-excluded-retention" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "excluded-retention",
        sessionKey: "agent:main:excluded-retention",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(scope);
      const pairedCall =
        role === "toolResult"
          ? expectDefined(
              await source.appendMessageAsync(
                makeAgentAssistantMessage({
                  content: [{ type: "toolCall", id: "paired", name: "read", arguments: {} }],
                }),
              ),
              "Expected appended message",
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
      const retained = expectDefined(
        await source.appendMessageAsync(message),
        "Expected appended message",
      );
      if (boundary === "reset") {
        await source.appendResetBoundaryAsync("new", pairedCall ?? retained);
      } else if (boundary === "compaction") {
        await source.appendCompactionAsync("summary", pairedCall ?? retained, 100);
      }
      const ordinaryExcluded = {
        role: "user" as const,
        content: "ordinary-excluded:" + "x".repeat(256 * 1024),
        timestamp: 2,
        excludeFromContext: true,
      };
      await source.appendMessageAsync(ordinaryExcluded);
      await source.appendMessageAsync({
        role: "user",
        content: "synthetic current text",
        timestamp: 3,
      });
      const expected = source.buildSessionContext();
      expect(
        expected.messages.some(
          (entry) => "excludeFromContext" in entry && entry.excludeFromContext === true,
        ),
      ).toBe(boundary === "reset");
      const database = openOpenClawAgentDatabase({ agentId: scope.agentId, path: scope.storePath });
      const fingerprint = () => {
        const hash = createHash("sha256");
        for (const row of database.db
          .prepare("SELECT event_json FROM transcript_events WHERE session_id = ? ORDER BY seq")
          .iterate(scope.sessionId)) {
          hash.update(String(row.event_json));
        }
        return hash.digest("hex");
      };
      const before = fingerprint();
      const actual = (await SessionManager.openModelContextAsync(scope)).buildSessionContext();

      expect(fingerprint()).toBe(before);
      expect(actual.model).toEqual(expected.model);
      expect(
        actual.messages.map((entry) => ("content" in entry ? entry.content : undefined)),
      ).toEqual(expected.messages.map((entry) => ("content" in entry ? entry.content : undefined)));
    });
  },
);

it.each([false, true, "path"])("keeps model reads non-persisting (%s)", async (incognito) => {
  await withOpenClawTestState({ label: "model-readonly" }, async (state) => {
    const scope = {
      agentId: "main",
      sessionId: "readonly",
      sessionKey:
        incognito === true ? "agent:main:dashboard:incognito-readonly" : "agent:main:readonly",
      storePath:
        incognito === "path"
          ? resolveIncognitoOpenClawAgentSqlitePath({ agentId: "main", env: state.env })
          : path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
    };
    expect(
      (await SessionManager.openModelContextAsync(scope)).buildSessionContext().messages,
    ).toEqual([]);
    expect(
      await SessionManager.readSessionContextAsync(scope, (messages) => Array.from(messages)),
    ).toEqual([]);
    expect(
      await SessionManager.readSessionContextAsync(scope, (messages) => [...messages]),
    ).toEqual([]);
    expect(fs.existsSync(scope.storePath)).toBe(false);
    await upsertSessionEntryCore(scope, {
      sessionId: scope.sessionId,
      updatedAt: 1,
      ...(incognito ? { incognito: true } : {}),
    });
    const source = await SessionManager.openAsync(scope);
    await source.appendMessageAsync({ role: "user", content: "visible", timestamp: 1 });
    const view = await SessionManager.openModelContextAsync(scope);
    expect((await SessionManager.openModelContextAsync(scope)).buildSessionContext()).toEqual(
      view.buildSessionContext(),
    );
    expect(view.buildSessionContext()).toEqual(source.buildSessionContext());
    expect(view.isPersisted()).toBe(false);
    if (incognito) {
      expect(fs.existsSync(scope.storePath)).toBe(false);
    } else {
      const database = openOpenClawAgentDatabase({ agentId: "main", path: scope.storePath });
      // A transient reader reconstructs navigation from its own read snapshot, not a stale cache.
      database.db
        .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
        .run(scope.sessionId);
      expect((await SessionManager.openModelContextAsync(scope)).buildSessionContext()).toEqual(
        source.buildSessionContext(),
      );
      database.db
        .prepare("DELETE FROM session_transcript_index_state WHERE session_id = ?")
        .run(scope.sessionId);
      expect((await SessionManager.openModelContextAsync(scope)).buildSessionContext()).toEqual(
        source.buildSessionContext(),
      );
      expect(
        database.db
          .prepare("SELECT COUNT(*) AS n FROM session_transcript_index_state WHERE session_id = ?")
          .get(scope.sessionId)?.n,
      ).toBe(0);
      expect(database.db.isTransaction).toBe(false);
      expect((await SessionManager.openModelContextAsync(scope)).buildSessionContext()).toEqual(
        source.buildSessionContext(),
      );
    }
  });
});

it.each([false, true])(
  "releases aborted context reads before the next read (incognito=%s)",
  async (incognito) => {
    await withOpenClawTestState({ label: "context-worker-lifecycle" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "worker-lifecycle",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-worker-lifecycle"
          : "agent:main:worker-lifecycle",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(scope);
      await source.appendMessageAsync({ role: "user", content: "visible", timestamp: 1 });
      expect((await SessionManager.openModelContextAsync(scope)).buildSessionContext()).toEqual(
        source.buildSessionContext(),
      );
      for (const alreadyAborted of [true, false]) {
        const controller = new AbortController();
        const reason = new Error("cancel context read");
        if (alreadyAborted) {
          controller.abort(reason);
        }
        const pending = SessionManager.openModelContextAsync(scope, { signal: controller.signal });
        if (!alreadyAborted) {
          controller.abort(reason);
        }
        await expect(pending).rejects.toBe(reason);
      }
      expect((await SessionManager.openModelContextAsync(scope)).buildSessionContext()).toEqual(
        source.buildSessionContext(),
      );
    });
  },
);

it.each([
  { incognito: false, mutation: "rewrite" },
  { incognito: false, mutation: "append" },
  { incognito: true, mutation: "append" },
])(
  "validates admission before accepting context (incognito=$incognito mutation=$mutation)",
  async ({ incognito, mutation }) => {
    await withOpenClawTestState({ label: "context-worker-fence" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: incognito ? "incognito-worker-fence" : "worker-fence",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-worker-fence"
          : "agent:main:worker-fence",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(scope);
      await source.appendMessageAsync({ role: "user", content: "previous", timestamp: 1 });
      await waitForSessionTranscriptProjection(scope);
      const admitted = await source.appendMessageWithTranscriptAnchorAsync(
        makeUserMessage("current", 2),
      );
      if (!admitted.anchor) {
        throw new Error("missing admission");
      }
      const admission = {
        ...admitted.anchor,
        role: "user" as const,
        logicalTurnId: "worker-fence",
      };
      const expected = (
        await SessionManager.openModelContextAsync(scope, { admission })
      ).buildSessionContext();
      const mutate = async () => {
        if (mutation === "rewrite") {
          expect(
            await source.removeTrailingEntriesAsync(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "user" &&
                entry.message.content === "current",
            ),
          ).toBe(1);
        }
        await source.appendMessageAsync({ role: "user", content: "replacement", timestamp: 3 });
      };
      const spy = incognito
        ? undefined
        : vi
            .spyOn(contextWorker, "readSessionTranscriptModelContextInWorker")
            .mockImplementationOnce(async (...args) => {
              spy!.mockRestore();
              const result = await contextWorker.readSessionTranscriptModelContextInWorker(...args);
              await mutate();
              return result;
            });
      try {
        const pending = SessionManager.openModelContextAsync(scope, { admission });
        if (incognito) {
          await mutate();
        }
        if (mutation === "rewrite") {
          await expect(pending).rejects.toThrow("Current-turn transcript admission");
        } else {
          expect((await pending).buildSessionContext()).toEqual(expected);
        }
      } finally {
        spy?.mockRestore();
      }
    });
  },
);

it.each(
  [false, true].flatMap((incognito) =>
    (
      ["append", "rewrite", "delete", "branch", "compaction", "reset", "other-session"] as const
    ).map((mutation) => ({ incognito, mutation })),
  ),
)(
  "validates unadmitted context before acceptance (incognito=$incognito mutation=$mutation)",
  async ({ incognito, mutation }) => {
    await withOpenClawTestState({ label: "unadmitted-context-fence" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "unadmitted-context",
        sessionKey: incognito
          ? "agent:main:dashboard:incognito-unadmitted-context"
          : "agent:main:unadmitted-context",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(scope);
      const first = expectDefined(
        await source.appendMessageAsync({
          role: "user",
          content: "before",
          timestamp: 1,
        }),
        "Expected appended message",
      );
      if (mutation === "branch") {
        await source.appendMessageAsync(makeUserMessage("branch tip", 2));
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
        mutationSource = await SessionManager.openAsync(otherScope);
      }
      const mutate = async () => {
        if (mutation === "rewrite") {
          expect(
            replaceTranscriptEventsSync(scope, [
              source.getHeader(),
              ...source
                .getEntries()
                .map((entry) =>
                  entry.type === "message"
                    ? Object.assign({}, entry, { message: makeUserMessage("rewritten prefix", 1) })
                    : entry,
                ),
            ]),
          ).toBe(true);
          return;
        }
        if (mutation === "delete") {
          expect(
            await source.removeTrailingEntriesAsync(
              (entry) =>
                entry.type === "message" &&
                entry.message.role === "user" &&
                entry.message.content === "before",
            ),
          ).toBe(1);
          return;
        }
        if (mutation === "branch") {
          await source.branchAsync(first);
        } else if (mutation === "compaction") {
          await source.appendCompactionAsync("summary", first, 1);
        } else if (mutation === "reset") {
          source.resetLeaf();
        }
        await mutationSource.appendMessageAsync({ role: "user", content: "after", timestamp: 2 });
      };
      const spy = incognito
        ? vi
            .spyOn(transcriptAnchors, "readSessionTranscriptAnchorsAsync")
            .mockImplementationOnce(async (...args) => {
              spy.mockRestore();
              await mutate();
              return transcriptAnchors.readSessionTranscriptAnchorsAsync(...args);
            })
        : vi
            .spyOn(contextWorker, "readSessionTranscriptModelContextInWorker")
            .mockImplementationOnce(async (...args) => {
              spy!.mockRestore();
              const result = await contextWorker.readSessionTranscriptModelContextInWorker(...args);
              await mutate();
              return result;
            });
      try {
        const pending = SessionManager.openModelContextAsync(scope);
        if (mutation === "other-session" || mutation === "append") {
          expect((await pending).buildSessionContext()).toEqual(expected);
        } else {
          await expect(pending).rejects.toThrow("Session transcript changed during context read");
        }
      } finally {
        spy?.mockRestore();
      }
    });
  },
);

it.each([false, true])(
  "closes lazy context without acquiring unread payloads (rejected=%s)",
  async (rejected) => {
    await withOpenClawTestState({ label: "context-reader-lifetime" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "lazy-context",
        sessionKey: "agent:main:lazy-context",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(scope);
      await source.appendMessageAsync({ role: "user", content: "first", timestamp: 1 });
      const marker = "synthetic-unread-context:";
      await source.appendMessageAsync({
        role: "user",
        content: marker + "x".repeat(256 * 1024),
        timestamp: 2,
      });
      let retained: Iterator<unknown> | undefined;
      const read = async () =>
        await SessionManager.readSessionContextAsync(scope, (messages) => {
          retained = messages[Symbol.iterator]();
          expect(retained.next().value).toMatchObject({ role: "user", content: "first" });
          if (rejected) {
            throw new Error("synthetic projection rejection");
          }
        });
      if (rejected) {
        await expect(read()).rejects.toThrow("synthetic projection rejection");
      } else {
        await read();
      }
      expect(retained?.next()).toEqual({ done: true, value: undefined });

      expect(
        await SessionManager.readSessionContextAsync(scope, (messages) => Array.from(messages)),
      ).toEqual(source.buildSessionContext().messages);
    });
  },
);

it.each(["details", "text", "duplicate-object", "late-array-call"])(
  "keeps real tool output across reset (%s)",
  async (marker) => {
    await withOpenClawTestState({ label: "model-pairing" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "pairing",
        sessionKey: "agent:main:pairing",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(scope);
      const firstKept = expectDefined(
        await source.appendMessageAsync(
          makeAgentAssistantMessage({
            content: [
              ...Array.from({ length: marker === "late-array-call" ? 16 : 1 }, () => ({
                type: "text" as const,
                text: "Reading the file",
              })),
              {
                type: "toolCall",
                id: "repeat",
                name: "read",
                arguments: { path: "synthetic.txt" },
              },
            ],
          }),
        ),
        "Expected appended message",
      );
      const missingResult = expectDefined(
        await source.appendMessageAsync({
          role: "toolResult",
          toolCallId: "repeat",
          toolName: "read",
          isError: true,
          content: [
            {
              type: "text",
              text: marker === "details" ? "missing" : LEGACY_MISSING_TOOL_RESULT_TEXT,
            },
          ],
          ...(marker === "details"
            ? { details: { openclawSyntheticMissingToolResult: true } }
            : {}),
          timestamp: 1,
        }),
        "Expected appended message",
      );
      await source.appendMessageAsync({
        role: "toolResult",
        toolCallId: "repeat",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "real output" }],
        timestamp: 2,
      });
      await source.appendMessageAsync({
        role: "toolResult",
        toolCallId: "orphan",
        toolName: "read",
        isError: false,
        content: [{ type: "text", text: "orphan-body:" + "x".repeat(512 * 1024) }],
        timestamp: 3,
      });
      await source.appendResetBoundaryAsync("new", firstKept);
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
      const messages = (await SessionManager.openModelContextAsync(scope)).buildSessionContext()
        .messages;

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
    await withOpenClawTestState({ label: "model-checkpoint" }, async (state) => {
      const scope = {
        agentId: "main",
        sessionId: "checkpoint",
        sessionKey: "agent:main:checkpoint",
        storePath: path.join(state.agentDir("main"), "openclaw-agent.sqlite"),
      };
      await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
      const source = await SessionManager.openAsync(scope);
      const kept = expectDefined(
        await source.appendMessageAsync({
          role: "user",
          content: "visible",
          timestamp: 1,
        }),
        "Expected appended message",
      );
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
      await source.appendMessageAsync(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "kept answer" }],
          model: "gpt-5.6-luna",
          providerReplay: checkpoint,
        }),
      );
      if (boundary === "reset") {
        await source.appendResetBoundaryAsync("new", kept);
      } else {
        await source.appendCompactionAsync("summary", kept, 100);
      }
      const valid = { ...checkpoint, data: "valid-post-boundary-checkpoint" };
      await source.appendMessageAsync(
        makeAgentAssistantMessage({
          content: [{ type: "text", text: "new answer" }],
          model: "gpt-5.6-luna",
          providerReplay: valid,
        }),
      );
      const context = (await SessionManager.openModelContextAsync(scope)).buildSessionContext();

      expect(context).toEqual(source.buildSessionContext());
      expect(context.messages.at(-1)).toMatchObject({ providerReplay: valid });
    });
  },
);
