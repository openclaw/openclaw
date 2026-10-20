import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it } from "vitest";
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

const collectors: CodexEphemeralTurn[] = [];
function setup(
  options: ConstructorParameters<typeof CodexEphemeralTurn>[2] = { textMode: "last" },
) {
  const fixture = createFakeCodexAppServerClient();
  const collector = new CodexEphemeralTurn(fixture.client, threadId, options);
  collectors.push(collector);
  const send = (method: string, params: JsonObject) => fixture.notify(notification(method, params));
  return { fixture, collector, send };
}
afterEach(() => collectors.splice(0).forEach((collector) => collector.route.release()));

it("rejects a disconnect after a malformed completion", async () => {
  const { fixture, collector } = setup();
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
        setImmediate(resolve, "still waiting");
      }),
    ]);
    expect(outcome).toMatchObject({ message: "codex app-server turn router closed" });
  } finally {
    abort.abort();
    await completion;
  }
});

it("drains a validated completion through disconnect while earlier projection is pending", async () => {
  const started = createDeferred<void>();
  const releaseProjection = createDeferred<void>();
  const { fixture, collector } = setup({
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
  }
});

it("waits for a valid completion after streamed all-mode text", async () => {
  const { fixture, collector } = setup({ textMode: "all" });
  const completion = collector.wait(turn, waitOptions());
  await fixture.notify(streamedText());
  await fixture.notify(completed(null));
  await fixture.notify(completed([answer]));
  expect(await completion).toMatchObject({ turn: { status: "completed" }, text: "Final answer." });
});

it.each(["last", "all"] as const)(
  "counts each completed response once with %s text aggregation",
  async (textMode) => {
    const { fixture, collector, send } = setup({ textMode });
    const responses = [
      ["first-response", 8, 2, 1, 4, 3, 12],
      ["final-response", 15, 5, 2, 5, 2, 20],
    ] as const;
    const repeated = [...responses, responses[0]];
    for (const [id, input, cached, write, output, reasoning, total] of repeated) {
      await send("rawResponse/completed", {
        responseId: id,
        usage: {
          inputTokens: input,
          cachedInputTokens: cached,
          cacheWriteInputTokens: write,
          outputTokens: output,
          reasoningOutputTokens: reasoning,
          totalTokens: total,
        },
      });
    }
    await fixture.notify(
      completed([{ id: "commentary", type: "agentMessage", text: "Checking the answer." }, answer]),
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
  },
);

it("reports forked-thread usage, which arrives only as thread token updates", async () => {
  const { fixture, collector, send } = setup();
  const last = {
    inputTokens: 21_000,
    cachedInputTokens: 20_500,
    outputTokens: 60,
    totalTokens: 21_060,
  };
  await send("thread/tokenUsage/updated", { tokenUsage: { last } });
  await fixture.notify(completed([answer]));
  const result = await collector.wait(turn, waitOptions());
  expect(result.usage).toMatchObject({ input: 500, cacheRead: 20_500, output: 60 });
});
