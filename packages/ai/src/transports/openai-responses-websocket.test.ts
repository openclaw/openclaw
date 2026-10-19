import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { supportsNativeOpenAIResponsesEndpoint } from "./openai-responses-endpoint.js";

const websocketState = vi.hoisted(() => ({
  instances: [] as Array<{
    socket: { readyState: number };
    closed: boolean;
    client: { apiKey?: string };
    options: { headers?: Record<string, string> };
    emitError(error: Error): void;
  }>,
  responseBatches: [] as Array<Array<Record<string, unknown>>>,
}));

vi.mock("openai/resources/responses/ws.js", () => ({
  ResponsesWS: class MockResponsesWS {
    socket = { readyState: 1 };
    closed = false;
    private events: Array<Record<string, unknown>> = [];
    private errorListeners: Array<(error: Error) => void> = [];

    constructor(
      public client: { apiKey?: string },
      public options: { headers?: Record<string, string> },
    ) {
      websocketState.instances.push(this);
    }

    send() {
      this.events = websocketState.responseBatches.shift() ?? [];
    }

    close() {
      this.closed = true;
      this.socket.readyState = 3;
    }

    on(event: string, listener: (error: Error) => void) {
      if (event === "error") {
        this.errorListeners.push(listener);
      }
      return this;
    }

    emitError(error: Error) {
      this.errorListeners.forEach((listener) => listener(error));
    }

    async *stream() {
      yield { type: "open" as const };
      for (const message of this.events) {
        yield { type: "message" as const, message };
      }
    }
  },
}));

import {
  configureAiTransportHost,
  createAiTransportHost,
  getAiTransportHost,
  runWithAiTransportHost,
} from "../host.js";
import { cleanupSessionResources } from "../session-resources.js";
import { createOpenAIResponsesWebSocketStream } from "./openai-responses-websocket.js";

const initialHost = getAiTransportHost();
const runDetached = AsyncLocalStorage.snapshot();
const clientFixture = {
  apiKey: "test-key",
  baseURL: "https://api.openai.com/v1",
  withOptions(options: { apiKey?: string }) {
    return { ...this, ...options };
  },
};
const client = clientFixture as never;
const firstUser = { role: "user" as const, content: "first" };
const assistantOutput = {
  type: "message",
  id: "msg_1",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "one", annotations: [] }],
  phase: "final_answer",
};

function completion(
  responseId: string,
  output: Array<Record<string, unknown>> = [],
  status = "completed",
) {
  return { type: `response.${status}`, response: { id: responseId, status, output } };
}

function queueCompletions(...ids: string[]) {
  websocketState.responseBatches.push(...ids.map((id) => [completion(id)]));
}

async function consumeResponse(response: ReturnType<typeof createOpenAIResponsesWebSocketStream>) {
  for await (const event of response.stream) {
    void event;
  }
  response.finish();
}

function runTurnOutsideCollector(run: () => Promise<void>): Promise<void> {
  // Do not keep the completed caller promise in the collecting test's async frame.
  return new Promise<void>((resolve, reject) => {
    void nextTurn()
      .then(run)
      .then(() => resolve(), reject);
  });
}

const request = (input: unknown[] = [firstUser]) => ({
  model: "gpt-5.6-luna",
  input,
});
type StreamOptions = Parameters<typeof createOpenAIResponsesWebSocketStream>[0];
function createStream(body = request(), overrides: Partial<StreamOptions> = {}) {
  return createOpenAIResponsesWebSocketStream({
    client,
    request: body,
    mode: "websocket-cached",
    sessionId: "session-1",
    headers: { "x-stable-session": "session-1" },
    ...overrides,
  });
}

describe("native OpenAI Responses WebSocket transport", () => {
  beforeEach(() => {
    for (const entries of Object.values(websocketState)) {
      entries.length = 0;
    }
    configureAiTransportHost(initialHost);
  });

  afterEach(() => {
    cleanupSessionResources();
    configureAiTransportHost(initialHost);
  });

  it.each([
    ["missing endpoint", "openai", undefined],
    ["credentials and URL components", "openai", "https://user:pass@api.openai.com/v1?q=x#x"],
    ["lookalike host", "openai", "https://api.openai.com.evil.example/v1"],
  ])("rejects %s", (_name, provider, baseUrl) => {
    expect(
      supportsNativeOpenAIResponsesEndpoint({ provider, api: "openai-responses", baseUrl }),
    ).toBe(false);
  });

  it("rejects an effective SDK client endpoint that is not the official API", () => {
    expect(() =>
      createStream(request(), {
        client: { ...clientFixture, baseURL: "https://compatible.example/v1" } as never,
        mode: "websocket",
      }),
    ).toThrow("official API endpoint");
    expect(websocketState.instances).toHaveLength(0);
  });

  it("resolves credentials and forwards stable headers at the WebSocket boundary", async () => {
    configureAiTransportHost({
      ...initialHost,
      resolveSecretSentinel: (value) => value.replaceAll("SECRET_SENTINEL", "resolved"),
    });
    queueCompletions("resp_1");
    await consumeResponse(
      createStream(request(), {
        client: { ...clientFixture, apiKey: "SECRET_SENTINEL-key" } as never,
        mode: "websocket",
        headers: {
          Authorization: "Bearer should-not-override-api-key",
          "x-provider-auth": "SECRET_SENTINEL-header",
        },
      }),
    );

    expect(websocketState.instances[0]?.client.apiKey).toBe("resolved-key");
    expect(websocketState.instances[0]?.options.headers).toEqual({
      "x-provider-auth": "resolved-header",
    });
  });

  it.each(["terminal incomplete response", "history rewrite", "assistant phase change"])(
    "resets continuation after %s",
    async (change) => {
      const incomplete = change === "terminal incomplete response";
      const history = [firstUser, assistantOutput, { role: "user", content: "second" }];
      websocketState.responseBatches.push(
        [completion("resp_1", [assistantOutput])],
        [completion("resp_2", [], incomplete ? "incomplete" : "completed")],
        [completion("resp_3")],
      );
      await consumeResponse(createStream());
      const input =
        change === "history rewrite"
          ? [{ role: "user", content: "rewritten" }]
          : change === "assistant phase change"
            ? [firstUser, { ...assistantOutput, phase: "commentary" }, history[2]]
            : history;
      const changed = createStream(request(input));
      if (incomplete) {
        expect(changed.continuationStatus).toBe("continued");
        await consumeResponse(changed);
        const third = createStream(request([...history, { role: "user", content: "third" }]));
        expect(third.continuationStatus).toBe("no_previous_response");
        expect(third.request).not.toHaveProperty("previous_response_id");
        await consumeResponse(third);
      } else {
        expect(changed.continuationStatus).not.toBe("continued");
        expect(changed.request).not.toHaveProperty("previous_response_id");
        await consumeResponse(changed);
      }
      expect(websocketState.instances).toHaveLength(1);
    },
  );

  it("uses a transient socket for a concurrent request and preserves the cached owner", async () => {
    queueCompletions("resp_cached", "resp_transient", "resp_reused");
    const body = { ...request(), stream: true };
    const cached = createStream(body);
    const concurrent = createStream(body);

    await consumeResponse(cached);
    await consumeResponse(concurrent);
    await consumeResponse(createStream(body));

    expect(websocketState.instances.map(({ closed }) => closed)).toEqual([false, true]);
  });

  it("evicts a cached idle socket when its lifetime error listener fires", async () => {
    queueCompletions("resp_1", "resp_2");
    await consumeResponse(createStream());

    websocketState.instances[0]?.emitError(new Error("idle connection failed"));
    expect(websocketState.instances[0]?.closed).toBe(true);

    await consumeResponse(createStream());
    expect(websocketState.instances).toHaveLength(2);
  });

  it.each([
    { name: "idle connection", failed: false },
    { name: "degradation cooldown", failed: true },
  ])("keeps the $name without retaining its caller", async ({ failed }) => {
    const host = createAiTransportHost({ runInDetachedAsyncContext: runDetached });
    const callers = new AsyncLocalStorage<object>();
    const references: WeakRef<object>[] = [];
    queueCompletions(...(failed ? [] : ["resp_1", "resp_2"]));
    const turn = () => {
      const caller = { turn: 1 };
      const body = { model: "gpt-5.6-luna", input: [firstUser] };
      const restoreRequest = () => body;
      const tracked = failed ? [caller, body, restoreRequest] : [caller];
      references.push(...tracked.map((value) => new WeakRef(value)));
      const consume = () =>
        consumeResponse(
          createStream(body, failed ? { restoreRequest, degradeCooldownMs: 60_000 } : {}),
        );
      return runWithAiTransportHost(host, () => callers.run(caller, consume));
    };
    try {
      // Vitest's async matcher retains the rejection until the test finishes.
      await runTurnOutsideCollector(() =>
        failed ? assert.rejects(turn(), /failed after request dispatch/) : turn(),
      );
      const control = new WeakRef({ unowned: true });
      // Keep real cache timers and ALS alive while collecting the completed turn.
      await nextTurn();
      queryObjects(WeakRef);
      expect(control.deref()).toBeUndefined();
      expect(references.filter((reference) => reference.deref())).toHaveLength(0);
      await runWithAiTransportHost(host, async () => {
        if (failed) {
          expect(() => createStream()).toThrow(
            expect.objectContaining({
              cause: expect.objectContaining({ message: expect.stringContaining("cooling down") }),
            }),
          );
        } else {
          const followup = createStream();
          expect(followup).toMatchObject({
            reusedConnection: true,
            request: { previous_response_id: "resp_1" },
          });
          await consumeResponse(followup);
          expect(websocketState.instances[0]?.closed).toBe(false);
        }
      });
      expect(websocketState.instances).toHaveLength(1);
    } finally {
      cleanupSessionResources(undefined, host);
      callers.disable();
    }
  });

  it("keeps matching-session and all-session cleanup inside one runtime owner", async () => {
    const firstHost = createAiTransportHost();
    const secondHost = createAiTransportHost();
    queueCompletions("first-shared", "first-other", "second-shared");
    for (const [host, sessionId] of [
      [firstHost, "session-1"],
      [firstHost, "other"],
      [secondHost, "session-1"],
    ] as const) {
      await runWithAiTransportHost(host, () =>
        consumeResponse(createStream(request(), { sessionId })),
      );
    }

    cleanupSessionResources("session-1", firstHost);
    expect(websocketState.instances.map(({ closed }) => closed)).toEqual([true, false, false]);

    cleanupSessionResources(undefined, firstHost);
    expect(websocketState.instances.map(({ closed }) => closed)).toEqual([true, true, false]);

    cleanupSessionResources(undefined, secondHost);
    expect(websocketState.instances.map(({ closed }) => closed)).toEqual([true, true, true]);
  });
});
