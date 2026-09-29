import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import { CodexEphemeralTurn } from "./ephemeral-turn.js";
import type { CodexTurn } from "./protocol.js";

describe("CodexEphemeralTurn", () => {
  it("rejects a disconnect after a malformed completion", async () => {
    const fixture = createFakeCodexAppServerClient();
    const collector = new CodexEphemeralTurn(fixture.client, "side-thread", { textMode: "last" });
    const abort = new AbortController();
    const completion = collector
      .wait(
        { id: "side-turn", status: "inProgress", items: [] },
        { signal: abort.signal, abortError: () => new Error("caller aborted") },
      )
      .catch((error: unknown) => error);
    try {
      await fixture.notify({
        method: "turn/completed",
        params: {
          threadId: "side-thread",
          turn: { id: "side-turn", status: "completed", items: null },
        },
      });
      fixture.close(new Error("connection lost"));
      const outcome = await Promise.race([
        completion,
        new Promise((resolve) => {
          setImmediate(() => resolve("still waiting"));
        }),
      ]);
      expect(outcome).toMatchObject({ message: "codex app-server turn router closed" });
    } finally {
      abort.abort();
      await completion;
      collector.route.release();
    }
  });

  it("drains a validated completion through disconnect while earlier projection is pending", async () => {
    const fixture = createFakeCodexAppServerClient();
    const started = createDeferred<void>();
    const releaseProjection = createDeferred<void>();
    const collector = new CodexEphemeralTurn(fixture.client, "side-thread", {
      textMode: "last",
      onAssistantMessageStart: async () => {
        started.resolve();
        await releaseProjection.promise;
      },
      onNotificationReceived: (notification) => {
        if (notification.method === "turn/completed") {
          fixture.close(new Error("connection closed after completion"));
        }
      },
    });
    const completion = collector.wait(
      { id: "side-turn", status: "inProgress", items: [] },
      { signal: new AbortController().signal, abortError: () => new Error("aborted") },
    );
    try {
      const delta = fixture.notify({
        method: "item/agentMessage/delta",
        params: {
          threadId: "side-thread",
          turnId: "side-turn",
          itemId: "answer",
          delta: "Still working.",
        },
      });
      await started.promise;
      const terminal = fixture.notify({
        method: "turn/completed",
        params: {
          threadId: "side-thread",
          turn: {
            id: "side-turn",
            status: "completed",
            items: [{ id: "answer", type: "agentMessage", text: "Final answer." }],
          },
        },
      });
      releaseProjection.resolve();
      await Promise.all([delta, terminal]);
      expect((await completion).text).toBe("Final answer.");
    } finally {
      releaseProjection.resolve();
      collector.route.release();
    }
  });

  it.each(["last", "all"] as const)(
    "waits for a valid completion after streamed %s text",
    async (textMode) => {
      const fixture = createFakeCodexAppServerClient();
      const collector = new CodexEphemeralTurn(fixture.client, "side-thread", { textMode });
      const turn = { id: "side-turn", status: "inProgress", items: [] } satisfies CodexTurn;
      try {
        const completion = collector.wait(turn, {
          signal: new AbortController().signal,
          abortError: () => new Error("aborted"),
        });
        await fixture.notify({
          method: "item/agentMessage/delta",
          params: {
            threadId: "side-thread",
            turnId: turn.id,
            itemId: "answer",
            delta: "Still working.",
          },
        });
        await fixture.notify({
          method: "turn/completed",
          params: {
            threadId: "side-thread",
            turn: { id: turn.id, status: "completed", items: null },
          },
        });
        await fixture.notify({
          method: "turn/completed",
          params: {
            threadId: "side-thread",
            turn: {
              ...turn,
              status: "completed",
              items: [{ id: "answer", type: "agentMessage", text: "Final answer." }],
            },
          },
        });

        const result = await completion;
        expect(result.turn?.status).toBe("completed");
        expect(result.text).toBe("Final answer.");
      } finally {
        collector.route.release();
      }
    },
  );

  it.each(["last", "all"] as const)(
    "counts each completed response once with %s text aggregation",
    async (textMode) => {
      const fixture = createFakeCodexAppServerClient();
      const collector = new CodexEphemeralTurn(fixture.client, "side-thread", { textMode });
      const turn = {
        id: "side-turn",
        status: "inProgress",
        items: [],
        error: null,
        startedAt: null,
        completedAt: null,
        durationMs: null,
      } satisfies CodexTurn;
      const responses = [
        {
          responseId: "first-response",
          usage: {
            inputTokens: 8,
            cachedInputTokens: 2,
            cacheWriteInputTokens: 1,
            outputTokens: 4,
            reasoningOutputTokens: 3,
            totalTokens: 12,
          },
        },
        {
          responseId: "final-response",
          usage: {
            inputTokens: 15,
            cachedInputTokens: 5,
            cacheWriteInputTokens: 2,
            outputTokens: 5,
            reasoningOutputTokens: 2,
            totalTokens: 20,
          },
        },
      ];
      try {
        for (const response of [...responses, responses[0]]) {
          await fixture.notify({
            method: "rawResponse/completed",
            params: { threadId: "side-thread", turnId: turn.id, ...response },
          });
        }
        await fixture.notify({
          method: "turn/completed",
          params: {
            threadId: "side-thread",
            turn: {
              ...turn,
              status: "completed",
              items: [
                { id: "commentary", type: "agentMessage", text: "Checking the answer." },
                { id: "answer", type: "agentMessage", text: "Final answer." },
              ],
            },
          },
        });
        const result = await collector.wait(turn, {
          signal: new AbortController().signal,
          abortError: () => new Error("aborted"),
        });
        expect(result.text).toBe(
          textMode === "last" ? "Final answer." : "Checking the answer.\n\nFinal answer.",
        );
        expect(result.usage).toEqual({
          input: 13,
          output: 9,
          cacheRead: 7,
          cacheWrite: 3,
          reasoningTokens: 5,
          total: responses.reduce((total, response) => total + response.usage.totalTokens, 0),
          contextUsage: { state: "available", promptTokens: 15, totalTokens: 20 },
        });
      } finally {
        collector.route.release();
      }
    },
  );
});
