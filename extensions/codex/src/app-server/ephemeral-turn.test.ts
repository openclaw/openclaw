import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, expect, it } from "vitest";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import { CodexEphemeralTurn } from "./ephemeral-turn.js";
import type { CodexTurn, JsonObject } from "./protocol.js";

const threadId = "side-thread";
const turn = { id: "side-turn", status: "inProgress", items: [] } satisfies CodexTurn;
const answer = { id: "answer", type: "agentMessage" as const, text: "Final." };
const collectors: CodexEphemeralTurn[] = [];
function setup(
  options: ConstructorParameters<typeof CodexEphemeralTurn>[2] = { textMode: "last" },
) {
  const fixture = createFakeCodexAppServerClient();
  const collector = new CodexEphemeralTurn(fixture.client, threadId, options);
  collectors.push(collector);
  const send = (method: string, params: JsonObject) =>
    fixture.notify({ method, params: { threadId, turnId: turn.id, ...params } });
  return {
    fixture,
    send,
    wait: (signal = new AbortController().signal) =>
      collector.wait(turn, { signal, abortError: () => new Error("caller aborted") }),
    stream: () => send("item/agentMessage/delta", { itemId: "answer", delta: "Still working." }),
    complete: (items: (typeof answer)[] | null = [answer]) =>
      send("turn/completed", { turn: { ...turn, status: "completed", items } }),
  };
}
afterEach(() => collectors.splice(0).forEach((collector) => collector.route.release()));

it("rejects a disconnect after a malformed completion", async () => {
  const { fixture, wait, complete } = setup();
  const abort = new AbortController();
  const completion = wait(abort.signal).catch((error: unknown) => error);
  try {
    await complete(null);
    fixture.close(new Error("connection lost"));
    const outcome = await Promise.race([completion, setImmediate("still waiting")]);
    expect(outcome).toMatchObject({ message: "codex app-server turn router closed" });
  } finally {
    abort.abort();
    await completion;
  }
});

it("drains a validated completion through disconnect while earlier projection is pending", async () => {
  const started = createDeferred<void>();
  const releaseProjection = createDeferred<void>();
  const { fixture, wait, stream, complete } = setup({
    textMode: "last",
    onAssistantMessageStart: () => {
      started.resolve();
      return releaseProjection.promise;
    },
    onNotificationReceived: (event) => {
      if (event.method === "turn/completed") {
        fixture.close(new Error("connection closed after completion"));
      }
    },
  });
  const completion = wait();
  try {
    const delta = stream();
    await started.promise;
    const terminal = complete();
    releaseProjection.resolve();
    await Promise.all([delta, terminal]);
    expect((await completion).text).toBe("Final.");
  } finally {
    releaseProjection.resolve();
  }
});

it("waits for a valid completion after streamed all-mode text", async () => {
  const { wait, stream, complete } = setup({ textMode: "all" });
  const completion = wait();
  await stream();
  await complete(null);
  await complete();
  expect(await completion).toMatchObject({ turn: { status: "completed" }, text: "Final." });
});

it.each(["last", "all"] as const)(
  "counts each completed response once with %s text aggregation",
  async (textMode) => {
    const { wait, complete, send } = setup({ textMode });
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
    await complete([{ ...answer, id: "commentary", text: "Checking." }, answer]);
    const result = await wait();
    expect(result.text).toBe(textMode === "last" ? "Final." : "Checking.\n\nFinal.");
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
  const { wait, complete, send } = setup();
  const last = { inputTokens: 21, cachedInputTokens: 20, outputTokens: 6, totalTokens: 27 };
  await send("thread/tokenUsage/updated", { tokenUsage: { last } });
  await complete();
  expect((await wait()).usage).toMatchObject({ input: 1, cacheRead: 20, output: 6 });
});
