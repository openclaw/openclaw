import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { describe, expect, it } from "vitest";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import { CodexEphemeralTurn } from "./ephemeral-turn.js";
import type { CodexServerNotification, CodexTurn, JsonObject } from "./protocol.js";

const threadId = "side-thread";
const turn = { id: "side-turn", status: "inProgress", items: [] } satisfies CodexTurn;
const answer = { id: "answer", type: "agentMessage", text: "Final answer." } as const;
const waitOptions = () => ({
  signal: new AbortController().signal,
  abortError: () => new Error("aborted"),
});
const notification = (method: string, params: JsonObject): CodexServerNotification => ({
  method,
  params: { threadId, turnId: turn.id, ...params },
});
const streamedText = () =>
  notification("item/agentMessage/delta", { itemId: "answer", delta: "Still working." });
const completed = (items: Array<{ id: string; type: "agentMessage"; text: string }> | null) => ({
  method: "turn/completed",
  params: { threadId, turn: { ...turn, status: "completed", items } },
});

describe("CodexEphemeralTurn", () => {
  it("rejects a disconnect after a malformed completion", async () => {
    const fixture = createFakeCodexAppServerClient();
    const collector = new CodexEphemeralTurn(fixture.client, threadId, { textMode: "last" });
    const abort = new AbortController();
    const completion = collector
      .wait(turn, { signal: abort.signal, abortError: () => new Error("caller aborted") })
      .catch((error: unknown) => error);
    try {
      await fixture.notify(completed(null));
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
    const collector = new CodexEphemeralTurn(fixture.client, threadId, {
      textMode: "last",
      onAssistantMessageStart: async () => {
        started.resolve();
        await releaseProjection.promise;
      },
      onNotificationReceived: (event) => {
        if (event.method === "turn/completed") {
          fixture.close(new Error("connection closed after completion"));
        }
      },
    });
    const completion = collector.wait(turn, waitOptions());
    try {
      const delta = fixture.notify(streamedText());
      await started.promise;
      const terminal = fixture.notify(completed([answer]));
      releaseProjection.resolve();
      await Promise.all([delta, terminal]);
      expect((await completion).text).toBe("Final answer.");
    } finally {
      releaseProjection.resolve();
      collector.route.release();
    }
  });

  it("waits for a valid completion after streamed all-mode text", async () => {
    const fixture = createFakeCodexAppServerClient();
    const collector = new CodexEphemeralTurn(fixture.client, threadId, { textMode: "all" });
    try {
      const completion = collector.wait(turn, waitOptions());
      await fixture.notify(streamedText());
      await fixture.notify(completed(null));
      await fixture.notify(completed([answer]));
      const result = await completion;
      expect(result.turn?.status).toBe("completed");
      expect(result.text).toBe("Final answer.");
    } finally {
      collector.route.release();
    }
  });

  it.each(["last", "all"] as const)(
    "counts each completed response once with %s text aggregation",
    async (textMode) => {
      const fixture = createFakeCodexAppServerClient();
      const collector = new CodexEphemeralTurn(fixture.client, threadId, { textMode });
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
      ] as const;
      try {
        for (const response of [...responses, responses[0]]) {
          await fixture.notify(notification("rawResponse/completed", response));
        }
        await fixture.notify(
          completed([
            { id: "commentary", type: "agentMessage", text: "Checking the answer." },
            answer,
          ]),
        );
        const result = await collector.wait(turn, waitOptions());
        expect(result.text).toBe(
          textMode === "last" ? "Final answer." : "Checking the answer.\n\nFinal answer.",
        );
        expect(result.usage).toEqual({
          input: 13,
          output: 9,
          cacheRead: 7,
          cacheWrite: 3,
          reasoningTokens: 5,
          total: 32,
          contextUsage: { state: "available", promptTokens: 15, totalTokens: 20 },
        });
      } finally {
        collector.route.release();
      }
    },
  );
});
