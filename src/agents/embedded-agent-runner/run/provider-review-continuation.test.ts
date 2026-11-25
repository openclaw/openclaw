import { zstdDecompressSync } from "node:zlib";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { convertToLlm } from "../../../../packages/agent-core/src/harness/messages.js";
import { configureAiTransportHost } from "../../../../packages/ai/src/host.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamSimpleOpenAICodexResponses,
} from "../../../../packages/ai/src/providers/openai-chatgpt-responses.js";
import { createTransportAwareStreamFnForModel } from "../../../../packages/ai/src/transports/provider-transport-stream.js";
import { createDeferred } from "../../../../test/helpers/promise.js";
import { makeTextToolResult } from "../../../../test/helpers/text-tool-result.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { Context, Model } from "../../../llm/types.js";
import { issueProviderReviewAcknowledgment } from "../../../sessions/provider-review.js";
import type { StreamFn } from "../../runtime/index.js";
import { makeProviderModelFixture } from "../../test-helpers/provider-model-fixture.js";
import { wrapStreamFnWithProviderReviewContinuation } from "./provider-review-continuation.js";

const store = vi.hoisted(() => ({
  entry: undefined as SessionEntry | undefined,
  beforeClear: undefined as (() => Promise<void>) | undefined,
  beforeRead: undefined as ((read: number) => Promise<void>) | undefined,
  reads: 0,
}));
vi.mock("../../../config/sessions/provider-review-store.js", () => ({
  readSessionProviderReview: async () => {
    await store.beforeRead?.(++store.reads);
    return store.entry;
  },
  compareSessionProviderReview: async (
    _target: unknown,
    update: {
      nextReview: SessionEntry["providerReview"];
      assertCurrent: () => void;
    },
  ) => {
    await store.beforeClear?.();
    update.assertCurrent();
    store.entry = { ...store.entry!, providerReview: update.nextReview };
    return store.entry;
  },
}));
const model = makeProviderModelFixture<"openai-chatgpt-responses">({
  id: "test-model",
  name: "Test",
  provider: "openai",
  api: "openai-chatgpt-responses",
  baseUrl: "https://chatgpt.com/backend-api",
  contextWindow: 128000,
  maxTokens: 1000,
}) satisfies Model<"openai-chatgpt-responses">;
const context: Context = {
  systemPrompt: "Keep existing permissions.",
  messages: [
    { role: "user", content: "old history", timestamp: 1 },
    { role: "user", content: "wrapper around continuation", timestamp: 2 },
  ],
};
const steer = "  Proceed only with the reviewed target.\n";
const target = {
  agentId: "test",
  storePath: "/synthetic/store",
  sessionKey: "agent:test:review",
  sessionId: "session-1",
};
const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const apiKey = `${encode({ alg: "none", typ: "JWT" })}.${encode({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" } })}.signature`;
const created = {
  type: "response.created",
  response: { id: "accepted-response", status: "in_progress" },
};
const completed = {
  type: "response.completed",
  response: {
    id: "accepted-response",
    status: "completed",
    output: [],
    usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
  },
};
const failed = {
  type: "response.failed",
  response: {
    id: "failed-response",
    status: "failed",
    error: { code: "misalignment_policy_violation", message: "Paused" },
  },
};
const turnMetadata = { turn_id: "existing-turn", sandbox: "unchanged" };
const clientMetadata = {
  existing: "preserved",
  "x-codex-turn-metadata": JSON.stringify(turnMetadata),
};
const userInput = (...texts: string[]) => ({
  role: "user",
  content: texts.map((text) => ({ type: "input_text", text })),
});
const messageInput = (...texts: string[]) => ({ type: "message", ...userInput(...texts) });
const reviewedInput = [messageInput("old history"), messageInput(steer)];
const routes = [
  { transport: "sse", strategy: "native" },
  { transport: "websocket", strategy: "native" },
  { transport: "sse", strategy: "managed" },
] as const;
function assertResponsesPayload(
  payload: unknown,
): asserts payload is Record<string, unknown> & { input: unknown[] } {
  if (!isRecord(payload) || !Array.isArray(payload.input)) {
    throw new Error("Fixture expected Responses input");
  }
}
function acceptanceGate(fail = false) {
  const entered = createDeferred();
  const release = createDeferred();
  store.beforeClear = async () => {
    entered.resolve();
    await release.promise;
    if (fail) {
      throw new Error("Local review commit failed");
    }
  };
  return { entered: entered.promise, release: release.resolve };
}
const expectBlocked = () => expect(store.entry?.providerReview?.id).toBe("review-1");

beforeEach(() => {
  store.beforeClear = undefined;
  store.beforeRead = undefined;
  store.reads = 0;
  store.entry = {
    sessionId: target.sessionId,
    updatedAt: 1,
    providerReview: {
      id: "review-1",
      sessionId: target.sessionId,
      runId: "old-run",
      provider: model.provider,
      model: model.id,
      runtimeId: "openclaw",
      api: model.api,
      review: { explanation: "Review these findings.", continuation: { message: steer } },
    },
  };
});
afterEach(() => {
  closeOpenAICodexWebSocketSessions();
  resetOpenAICodexWebSocketStateForTest();
  configureAiTransportHost({});
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function fixture(
  transport: "sse" | "websocket" | "auto",
  events: object[] = [created, completed],
  strategy: "native" | "managed" = "native",
) {
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw new Error("revoked");
    }
  };
  const acknowledgment = await issueProviderReviewAcknowledgment({
    target,
    reviewId: "review-1",
    nextRunId: "next-run",
    assertCurrent,
  });
  const requests: Record<string, unknown>[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const request = new Request(url, init);
    // Byte buffers also carry plain SDK JSON; the HTTP header owns decompression.
    const raw =
      request.headers.get("content-encoding") === "zstd"
        ? zstdDecompressSync(new Uint8Array(await request.arrayBuffer())).toString()
        : await request.text();
    requests.push(JSON.parse(raw));
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  let onConnect: (() => void) | undefined;
  class Socket extends EventTarget {
    constructor() {
      super();
      queueMicrotask(() => {
        onConnect?.();
        this.dispatchEvent(new Event("open"));
      });
    }
    send(raw: string) {
      requests.push(JSON.parse(raw));
      queueMicrotask(() => {
        for (const event of events) {
          this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
        }
      });
    }
    close() {}
  }
  vi.stubGlobal("WebSocket", Socket);
  configureAiTransportHost({
    requiresManagedTransport: () => strategy === "managed",
    buildModelFetch: () => fetchMock,
  });
  const managed = createTransportAwareStreamFnForModel(model);
  const base: StreamFn =
    managed ??
    ((_model, nextContext, options) =>
      streamSimpleOpenAICodexResponses(model, nextContext, options));
  store.reads = 0;
  const createWrapper = () =>
    wrapStreamFnWithProviderReviewContinuation({
      streamFn: base,
      acknowledgment,
      runId: "next-run",
      assertCurrent,
    });
  const stream = createWrapper();
  const options = {
    apiKey,
    transport,
    onPayload: (payload: unknown) => ({
      ...(payload as Record<string, unknown>),
      client_metadata: { ...clientMetadata },
    }),
  };
  return {
    requests,
    fetchMock,
    stream,
    createWrapper,
    options,
    revoke: () => {
      current = false;
    },
    onConnect: (callback: () => void) => {
      onConnect = callback;
    },
  };
}

describe("explicit direct Responses continuation", () => {
  it.each(routes)(
    "preserves runtime context after the acknowledged turn over $strategy $transport",
    async ({ transport, strategy }) => {
      const f = await fixture(transport, [created, completed], strategy);
      const carrier = {
        role: "custom" as const,
        customType: "openclaw.runtime-context",
        content: "Runtime context must survive continuation.\n",
        display: false,
        details: {
          source: "openclaw-runtime-context",
          runtimeContextCarrier: true,
        },
        timestamp: 3,
      };
      const messages = convertToLlm([...context.messages, carrier]);
      const before = JSON.stringify(messages);
      const stream = await f.stream(
        model,
        { ...context, messages },
        {
          ...f.options,
          onPayload: (payload: unknown) => {
            assertResponsesPayload(payload);
            return {
              ...f.options.onPayload(payload),
              input: payload.input.map((item: unknown) => {
                if (!isRecord(item)) {
                  throw new Error("Fixture expected a Responses input item");
                }
                return Object.assign({}, item);
              }),
            };
          },
        },
      );
      const result = await stream.result();
      expect(result.stopReason).toBe("stop");
      expect(f.requests).toHaveLength(1);
      expect(f.requests[0]?.input).toEqual([
        ...reviewedInput,
        messageInput(
          `OpenClaw runtime context:\n${carrier.content}\nEnd OpenClaw runtime context.`,
        ),
      ]);
      expect(JSON.stringify(messages)).toBe(before);
      expect(messages.at(-1)).toMatchObject({ role: "user", runtimeContext: {} });
      expect(store.entry?.providerReview).toBeUndefined();
    },
  );

  it("keeps a mixed-media runtime carrier behind the reviewed user input", async () => {
    const f = await fixture("sse");
    const carrier = {
      role: "user" as const,
      content: [
        { type: "text" as const, text: "Plugin runtime context" },
        { type: "image" as const, mimeType: "image/png", data: "aW1n" },
      ],
      timestamp: 3,
      runtimeContext: {},
    };
    const messages = [...context.messages, carrier];
    const before = JSON.stringify(messages);

    const result = await (await f.stream(model, { ...context, messages }, f.options)).result();

    expect(result.stopReason).toBe("stop");
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.input).toEqual([
      ...reviewedInput,
      messageInput("Plugin runtime context", "(image omitted: model does not support images)"),
    ]);
    expect(JSON.stringify(messages)).toBe(before);
  });

  it.each(["sse", "websocket"] as const)(
    "sends the literal steer and one-shot metadata over %s, then leaves later tool calls ordinary",
    async (transport) => {
      const f = await fixture(transport);
      const dormantWrapper = f.createWrapper();
      const result = await (await f.stream(model, context, f.options)).result();
      expect(result.stopReason).toBe("stop");
      expect(store.entry?.providerReview).toBeUndefined();
      expect(() => f.createWrapper()).toThrow("cannot start another transport attempt");
      await expect(dormantWrapper(model, context, f.options)).rejects.toThrow(
        "belongs to another transport attempt",
      );
      expect(f.requests).toHaveLength(1);
      const request = f.requests[0]!;
      expect(request.instructions).toBe(context.systemPrompt);
      expect(request.input).toEqual(reviewedInput);
      expect(JSON.stringify(request)).not.toContain("wrapper around continuation");
      const metadata = request.client_metadata as Record<string, string>;
      expect(metadata.existing).toBe("preserved");
      const sentMetadata = JSON.parse(metadata["x-codex-turn-metadata"]!);
      expect(sentMetadata).toMatchObject(turnMetadata);
      expect(JSON.parse(sentMetadata.misalignment_override)).toEqual({
        timestamp: expect.any(Number),
      });
      expect(metadata).not.toHaveProperty("misalignment_override");
      const later: Context = {
        ...context,
        messages: [
          ...context.messages,
          makeTextToolResult("tool-1", "read", "tool result", false, 3),
        ],
      };
      await (await f.stream(model, later, f.options)).result();
      expect(f.requests).toHaveLength(2);
      expect(f.requests[1]?.client_metadata).toEqual(clientMetadata);
    },
  );

  it.each(["sse", "websocket"] as const)(
    "does not clear on a failed first %s event",
    async (transport) => {
      const f = await fixture(transport, [failed]);
      expect((await (await f.stream(model, context, f.options)).result()).stopReason).toBe("error");
      expectBlocked();
    },
  );

  it("revalidates after awaited payload hooks and websocket connection", async () => {
    const http = await fixture("sse");
    await (
      await http.stream(model, context, {
        ...http.options,
        onPayload: async () => {
          http.revoke();
        },
      })
    ).result();
    expect(http.requests).toHaveLength(0);
    const ws = await fixture("websocket");
    ws.onConnect(ws.revoke);
    await (await ws.stream(model, context, ws.options)).result();
    expect(ws.requests).toHaveLength(0);
    expectBlocked();
  });

  it("blocks automatic websocket redispatch and HTTP fallback after a sent continuation", async () => {
    const f = await fixture("auto", [
      { type: "error", code: "websocket_connection_limit_reached", message: "connection limit" },
    ]);
    expect((await (await f.stream(model, context, f.options)).result()).stopReason).toBe("error");
    expect(f.requests).toHaveLength(1);
    expect(f.fetchMock).not.toHaveBeenCalled();
    expectBlocked();
  });

  it("joins acceptance settlement through cancellation without clearing the block", async () => {
    const f = await fixture("sse");
    const gate = acceptanceGate();
    const controller = new AbortController();
    const stream = await f.stream(model, context, { ...f.options, signal: controller.signal });
    const result = stream.result();
    await gate.entered;
    controller.abort();
    gate.release();
    expect((await result).stopReason).toBe("aborted");
    expectBlocked();
  });

  it.each(routes)(
    "withholds queued function calls when $strategy $transport acceptance clearing fails",
    async ({ transport, strategy }) => {
      const call = {
        type: "function_call",
        id: "fc-record",
        call_id: "call-record",
        name: "record_result",
        arguments: JSON.stringify({ result: "done" }),
        status: "completed",
      };
      const f = await fixture(
        transport,
        [
          created,
          {
            type: "response.output_item.added",
            output_index: 0,
            item: { ...call, arguments: "", status: "in_progress" },
          },
          {
            type: "response.function_call_arguments.delta",
            output_index: 0,
            item_id: call.id,
            delta: call.arguments,
          },
          {
            type: "response.function_call_arguments.done",
            output_index: 0,
            item_id: call.id,
            arguments: call.arguments,
          },
          { type: "response.output_item.done", output_index: 0, item: call },
          { ...completed, response: { ...completed.response, output: [call] } },
        ],
        strategy,
      );
      const gate = acceptanceGate(true);
      const stream = await f.stream(
        model,
        {
          ...context,
          tools: [
            {
              name: call.name,
              description: "Record a synthetic result",
              parameters: Type.Object({ result: Type.String() }),
            },
          ],
        },
        f.options,
      );
      const delivered: string[] = [];
      const executionOpportunity = vi.fn();
      const drain = (async () => {
        for await (const event of stream) {
          delivered.push(event.type);
          if (event.type === "toolcall_end") {
            executionOpportunity(event.toolCall);
          }
        }
      })();
      const result = stream.result();
      await gate.entered;
      try {
        expect(delivered).not.toContain("toolcall_start");
        expect(executionOpportunity).not.toHaveBeenCalled();
      } finally {
        gate.release();
      }
      const terminal = await result;
      await drain;
      expect(terminal.stopReason).toBe("error");
      expect(terminal.content.filter((block) => block.type === "toolCall")).toEqual([]);
      expect(delivered).not.toContain("toolcall_start");
      expect(delivered).not.toContain("toolcall_end");
      expect(executionOpportunity).not.toHaveBeenCalled();
      expectBlocked();
      expect(f.requests).toHaveLength(1);
      await expect(f.stream(model, context, f.options)).rejects.toThrow("cannot be retried");
      expect(f.requests).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "uses the selected managed ChatGPT HTTP route (refused: %s)",
    async (refused) => {
      const f = await fixture("auto", refused ? [failed] : [created, completed], "managed");
      const result = await (await f.stream(model, context, f.options)).result();
      expect(result.stopReason).toBe(refused ? "error" : "stop");
      expect(f.fetchMock).toHaveBeenCalledTimes(1);
      expect(store.entry?.providerReview?.id).toBe(refused ? "review-1" : undefined);
      const request = f.requests[0]!;
      expect(request.input).toEqual(
        reviewedInput.map(({ role, content }) => expect.objectContaining({ role, content })),
      );
      const metadata = request.client_metadata as Record<string, string>;
      expect(JSON.parse(metadata["x-codex-turn-metadata"]!)).toMatchObject({
        ...turnMetadata,
        misalignment_override: expect.any(String),
      });
    },
  );

  it("stops managed semantic retry at the existing fetch owner", async () => {
    const f = await fixture("sse", [], "managed");
    f.fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: { code: "invalid_encrypted_content", message: "invalid_encrypted_content" },
        }),
        { status: 400 },
      ),
    );
    const options = {
      ...f.options,
      onPayload: (payload: unknown) => {
        assertResponsesPayload(payload);
        const prepared = f.options.onPayload(payload);
        return {
          ...prepared,
          input: [
            {
              type: "reasoning",
              id: "reasoning-1",
              encrypted_content: "synthetic-ciphertext",
              summary: [],
            },
            ...payload.input,
          ],
        };
      },
    };
    expect((await (await f.stream(model, context, options)).result()).stopReason).toBe("error");
    expect(f.fetchMock).toHaveBeenCalledTimes(1);
    expectBlocked();
  });

  it("does not send a native WebSocket request after its transport timeout during admission", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const f = await fixture("websocket");
    const entered = createDeferred();
    const release = createDeferred();
    store.beforeRead = async (read) => {
      if (read === 3) {
        entered.resolve();
        await release.promise;
      }
    };
    const caller = new AbortController();
    const stream = await f.stream(model, context, {
      ...f.options,
      signal: caller.signal,
      timeoutMs: 1000,
    });
    await entered.promise;
    timeout.abort(new DOMException("Transport timeout", "TimeoutError"));
    release.resolve();
    expect((await stream.result()).stopReason).toBe("error");
    expect(caller.signal.aborted).toBe(false);
    expect(f.requests).toHaveLength(0);
    expectBlocked();
  });

  it.each(["native", "managed"] as const)(
    "retains the block and joins %s acceptance settlement after a first-event timeout",
    async (strategy) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const f = await fixture("sse", [created, completed], strategy);
      const gate = acceptanceGate();
      const caller = new AbortController();
      const options = { ...f.options, signal: caller.signal, firstEventTimeoutMs: 1000 };
      const stream = await f.stream(model, context, options);
      let settled = false;
      const result = stream.result().then((message) => {
        settled = true;
        return message;
      });
      await gate.entered;
      await vi.advanceTimersByTimeAsync(1000);
      expect(settled).toBe(false);
      expect(caller.signal.aborted).toBe(false);
      gate.release();
      expect((await result).stopReason).toBe("error");
      expectBlocked();
    },
  );

  it.each([
    ["extra in-place input", "payload added user input"],
    ["extra replacement input", "payload added user input"],
    ["replacement identity", "changed its next user input"],
    ["reorder", "changed its next user input"],
    ["replace-carrier", "changed its next user input"],
    ["mutate-carrier", "changed its next user input"],
    ["model", "changed the reviewed runtime or model"],
  ])("rejects unreviewed payload changes before dispatch: %s", async (change, error) => {
    const f = await fixture("sse");
    const hasCarrier = ["reorder", "replace-carrier", "mutate-carrier"].includes(change);
    const messages: Context["messages"] = hasCarrier
      ? [
          ...context.messages,
          { role: "user", content: "Runtime context", timestamp: 3, runtimeContextCarrier: true },
        ]
      : context.messages;
    const stream = await f.stream(
      model,
      { ...context, messages },
      {
        ...f.options,
        onPayload: (payload: unknown) => {
          assertResponsesPayload(payload);
          if (change === "model") {
            return { ...payload, model: "other-model" };
          }
          if (change.startsWith("extra")) {
            const extra = [userInput("Extra unreviewed input"), userInput("Trailing input")];
            if (change === "extra in-place input") {
              payload.input.push(...extra);
              return undefined;
            }
            return { ...payload, input: [...payload.input, ...extra] };
          }
          if (change === "replacement identity") {
            return {
              ...payload,
              input: [...payload.input.slice(0, -1), userInput(steer)],
            };
          }
          if (change === "reorder") {
            [payload.input[0], payload.input[1]] = [payload.input[1], payload.input[0]];
          } else {
            const carrier = payload.input.at(-1);
            if (
              !isRecord(carrier) ||
              !Array.isArray(carrier.content) ||
              !isRecord(carrier.content[0])
            ) {
              throw new Error("Fixture expected a runtime-context carrier");
            }
            if (change === "mutate-carrier") {
              carrier.content[0].text = "Unreviewed input";
            } else {
              payload.input[payload.input.length - 1] = userInput("Unreviewed input");
            }
          }
          return payload;
        },
      },
    );
    const result = await stream.result();
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toContain(error);
    expect(f.requests).toHaveLength(0);
    expectBlocked();
  });

  it("preserves effective settings, tools, and history transforms while keeping the exact steer", async () => {
    const f = await fixture("sse");
    const stream = await f.stream(model, context, {
      ...f.options,
      onPayload: (payload: unknown) => {
        if (!isRecord(payload) || !Array.isArray(payload.input) || !isRecord(payload.input[0])) {
          throw new Error("Fixture expected Responses user input");
        }
        return {
          ...f.options.onPayload(payload),
          instructions: "Current configured instructions",
          tools: [{ type: "web_search" }],
          reasoning: { effort: "high" },
          text: { verbosity: "high" },
          input: [
            {
              ...payload.input[0],
              content: [{ type: "input_text", text: "Configured history projection" }],
            },
            ...payload.input.slice(1),
          ],
        };
      },
    });
    expect((await stream.result()).stopReason).toBe("stop");
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]).toMatchObject({
      instructions: "Current configured instructions",
      tools: [{ type: "web_search" }],
      reasoning: { effort: "high" },
      text: { verbosity: "high" },
      input: [userInput("Configured history projection"), userInput(steer)],
    });
    expect(store.entry?.providerReview).toBeUndefined();
  });

  it("rejects malformed existing metadata and unsupported API-key routes before dispatch", async () => {
    const f = await fixture("sse");
    await expect(
      f.stream({ ...model, api: "openai-responses" }, context, f.options),
    ).rejects.toThrow("runtime and model");
    const stream = await f.stream(model, context, {
      ...f.options,
      onPayload: (payload: unknown) => ({
        ...(payload as Record<string, unknown>),
        client_metadata: { "x-codex-turn-metadata": "invalid" },
      }),
    });
    expect((await stream.result()).stopReason).toBe("error");
    expect(f.requests).toHaveLength(0);
  });
});
