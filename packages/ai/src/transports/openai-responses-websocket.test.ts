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
    emitError(error: Error): void;
  }>,
  clients: [] as Array<{ apiKey?: string }>,
  options: [] as Array<{ headers?: Record<string, string> }>,
  responseBatches: [] as Array<Array<Record<string, unknown>>>,
}));

vi.mock("openai/resources/responses/ws.js", () => ({
  ResponsesWS: class MockResponsesWS {
    socket = { readyState: 1 };
    closed = false;
    private events: Array<Record<string, unknown>> = [];
    private errorListeners: Array<(error: Error) => void> = [];

    constructor(client: { apiKey?: string }, options: { headers?: Record<string, string> }) {
      websocketState.instances.push(this);
      websocketState.clients.push(client);
      websocketState.options.push(options);
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
      for (const listener of this.errorListeners) {
        listener(error);
      }
    }

    stream() {
      const readEvents = () => this.events;
      return (async function* () {
        yield { type: "open" as const };
        for (const message of readEvents()) {
          yield { type: "message" as const, message };
        }
      })();
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

function completion(responseId: string, output: Array<Record<string, unknown>> = []) {
  return {
    type: "response.completed",
    response: {
      id: responseId,
      status: "completed",
      output,
      usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
    },
  };
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

function createStream(request: Record<string, unknown>, overrides: { sessionId?: string } = {}) {
  return createOpenAIResponsesWebSocketStream({
    client,
    request,
    mode: "websocket-cached",
    sessionId: overrides.sessionId ?? "session-1",
    headers: { "x-stable-session": "session-1" },
  });
}

describe("native OpenAI Responses WebSocket transport", () => {
  beforeEach(() => {
    websocketState.instances.length = 0;
    websocketState.clients.length = 0;
    websocketState.options.length = 0;
    websocketState.responseBatches.length = 0;
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
    const compatibleClient = {
      ...clientFixture,
      baseURL: "https://compatible.example/v1",
    } as never;

    expect(() =>
      createOpenAIResponsesWebSocketStream({
        client: compatibleClient,
        request: { model: "gpt-5.6-luna", input: [firstUser] },
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
    websocketState.responseBatches.push([completion("resp_1")]);
    const sentinelClient = {
      ...clientFixture,
      apiKey: "SECRET_SENTINEL-key",
    };

    const response = createOpenAIResponsesWebSocketStream({
      client: sentinelClient as never,
      request: { model: "gpt-5.6-luna", input: [firstUser] },
      mode: "websocket",
      headers: {
        Authorization: "Bearer should-not-override-api-key",
        "x-provider-auth": "SECRET_SENTINEL-header",
      },
    });
    await consumeResponse(response);

    expect(websocketState.clients[0]?.apiKey).toBe("resolved-key");
    expect(websocketState.options[0]?.headers).toEqual({ "x-provider-auth": "resolved-header" });
  });

  it("does not retain a continuation after a terminal incomplete response", async () => {
    websocketState.responseBatches.push(
      [completion("resp_1", [assistantOutput])],
      [
        {
          type: "response.incomplete",
          response: { id: "resp_2", status: "incomplete", output: [] },
        },
      ],
      [completion("resp_3")],
    );
    const initial = { model: "gpt-5.6-luna", input: [firstUser] };
    await consumeResponse(createStream(initial));

    const secondRequest = {
      ...initial,
      input: [firstUser, assistantOutput, { role: "user", content: "second" }],
    };
    const second = createStream(secondRequest);
    expect(second.continuationStatus).toBe("continued");
    await consumeResponse(second);

    const third = createStream({
      ...secondRequest,
      input: [...secondRequest.input, { role: "user", content: "third" }],
    });
    expect(third.continuationStatus).toBe("no_previous_response");
    expect(third.request).not.toHaveProperty("previous_response_id");
    await consumeResponse(third);
    expect(websocketState.instances).toHaveLength(1);
  });

  it.each([
    {
      name: "history rewrite",
      mutate: (request: Record<string, unknown>) => ({
        ...request,
        input: [{ role: "user", content: "rewritten" }],
      }),
    },
    {
      name: "assistant phase change",
      mutate: (request: Record<string, unknown>) => ({
        ...request,
        input: [
          firstUser,
          { ...assistantOutput, phase: "commentary" },
          { role: "user", content: "second" },
        ],
      }),
    },
  ])("resets continuation on $name", async ({ mutate }) => {
    websocketState.responseBatches.push(
      [completion("resp_1", [assistantOutput])],
      [completion("resp_2")],
    );
    const initial = {
      model: "gpt-5.6-luna",
      stream: true,
      store: false,
      instructions: "stable prompt",
      tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
      input: [firstUser],
    };
    await consumeResponse(createStream(initial));

    const changed = createStream(
      mutate({
        ...initial,
        input: [firstUser, assistantOutput, { role: "user", content: "second" }],
      }),
    );
    expect(changed.continuationStatus).not.toBe("continued");
    expect(changed.request).not.toHaveProperty("previous_response_id");
    await consumeResponse(changed);
    expect(websocketState.instances).toHaveLength(1);
  });

  it("uses a transient socket for a concurrent request and preserves the cached owner", async () => {
    websocketState.responseBatches.push(
      [completion("resp_cached")],
      [completion("resp_transient")],
      [completion("resp_reused")],
    );
    const request = { model: "gpt-5.6-luna", stream: true, input: [firstUser] };
    const cached = createStream(request);
    const concurrent = createStream(request);

    await consumeResponse(cached);
    await consumeResponse(concurrent);
    await consumeResponse(createStream(request));

    expect(websocketState.instances).toHaveLength(2);
    expect(websocketState.instances[1]?.closed).toBe(true);
    expect(websocketState.instances[0]?.closed).toBe(false);
  });

  it("evicts a cached idle socket when its lifetime error listener fires", async () => {
    websocketState.responseBatches.push([completion("resp_1")], [completion("resp_2")]);
    const request = { model: "gpt-5.6-luna", input: [firstUser] };
    await consumeResponse(createStream(request));

    websocketState.instances[0]?.emitError(new Error("idle connection failed"));
    expect(websocketState.instances[0]?.closed).toBe(true);

    await consumeResponse(createStream(request));
    expect(websocketState.instances).toHaveLength(2);
  });

  it("keeps an idle connection reusable without retaining its completed caller", async () => {
    const host = createAiTransportHost({ runInDetachedAsyncContext: runDetached });
    const callers = new AsyncLocalStorage<object>();
    let reference: WeakRef<object> | undefined;
    const request = { model: "fixture", input: [firstUser] };
    websocketState.responseBatches.push([completion("resp_1")], [completion("resp_2")]);
    const completeTurn = () => {
      const caller = { turn: 1 };
      reference = new WeakRef(caller);
      return runWithAiTransportHost(host, () =>
        callers.run(caller, () => consumeResponse(createStream(request))),
      );
    };
    try {
      await runTurnOutsideCollector(completeTurn);
      const control = new WeakRef({ unowned: true });
      // Keep real cache timers and ALS alive while collecting the completed turn.
      await nextTurn();
      queryObjects(WeakRef);
      expect(control.deref()).toBeUndefined();
      assert.ok(reference);
      expect(reference.deref()).toBeUndefined();

      await runWithAiTransportHost(host, async () => {
        const followup = createStream(request);
        expect(followup.reusedConnection).toBe(true);
        expect(followup.request.previous_response_id).toBe("resp_1");
        await consumeResponse(followup);
      });
      expect(websocketState.instances).toHaveLength(1);
      expect(websocketState.instances[0]?.closed).toBe(false);
    } finally {
      cleanupSessionResources(undefined, host);
      callers.disable();
    }
  });

  it("keeps a degradation cooldown without retaining the failed caller or request", async () => {
    const host = createAiTransportHost({ runInDetachedAsyncContext: runDetached });
    const callers = new AsyncLocalStorage<object>();
    const references: WeakRef<object>[] = [];
    const failTurn = () => {
      const caller = { turn: 1 };
      const request = { model: "fixture", input: [firstUser] };
      const restoreRequest = () => request;
      references.push(new WeakRef(caller), new WeakRef(request), new WeakRef(restoreRequest));
      return runWithAiTransportHost(host, () =>
        callers.run(caller, () =>
          consumeResponse(
            createOpenAIResponsesWebSocketStream({
              client,
              request,
              restoreRequest,
              mode: "websocket-cached",
              sessionId: "failed-retention",
              headers: { "x-stable-session": "session-1" },
              degradeCooldownMs: 60_000,
            }),
          ),
        ),
      );
    };
    try {
      // Vitest's async matcher retains the rejection until the test finishes.
      await runTurnOutsideCollector(() =>
        assert.rejects(failTurn(), /failed after request dispatch/),
      );
      const control = new WeakRef({ unowned: true });
      await nextTurn();
      queryObjects(WeakRef);
      expect(control.deref()).toBeUndefined();
      expect(references.filter((reference) => reference.deref())).toHaveLength(0);

      runWithAiTransportHost(host, () => {
        expect(() =>
          createStream({ model: "fixture", input: [firstUser] }, { sessionId: "failed-retention" }),
        ).toThrow(
          expect.objectContaining({
            cause: expect.objectContaining({ message: expect.stringContaining("cooling down") }),
          }),
        );
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
    websocketState.responseBatches.push(
      [completion("first-shared")],
      [completion("first-other")],
      [completion("second-shared")],
    );
    await runWithAiTransportHost(firstHost, () =>
      consumeResponse(createStream({ model: "gpt-5.6-luna", input: [firstUser] })),
    );
    await runWithAiTransportHost(firstHost, () =>
      consumeResponse(
        createStream(
          { model: "gpt-5.6-luna", input: [{ role: "user", content: "other" }] },
          { sessionId: "other" },
        ),
      ),
    );
    await runWithAiTransportHost(secondHost, () =>
      consumeResponse(createStream({ model: "gpt-5.6-luna", input: [firstUser] })),
    );

    cleanupSessionResources("session-1", firstHost);
    expect(websocketState.instances.map(({ closed }) => closed)).toEqual([true, false, false]);

    cleanupSessionResources(undefined, firstHost);
    expect(websocketState.instances.map(({ closed }) => closed)).toEqual([true, true, false]);

    cleanupSessionResources(undefined, secondHost);
    expect(websocketState.instances.map(({ closed }) => closed)).toEqual([true, true, true]);
  });
});
