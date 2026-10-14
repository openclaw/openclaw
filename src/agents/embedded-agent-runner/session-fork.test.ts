import { AsyncLocalStorage } from "node:async_hooks";
import { setImmediate as nextTurn } from "node:timers/promises";
import { queryObjects } from "node:v8";
import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import {
  createAnthropicMessagesTransportStreamFn,
  createOpenAICompletionsTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "@openclaw/ai/transports";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimpleOpenAICodexResponses } from "../../../packages/ai/src/providers/openai-chatgpt-responses.js";
import * as guardedFetch from "../../infra/net/fetch-guard.js";
import * as undiciRuntime from "../../infra/net/undici-runtime.js";
import "../ai-transport-runtime-host.js";
import type { Context, Model } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { attachModelProviderRequestTransport } from "../provider-request-config.js";
import { closeProviderTransportDispatcherPool } from "../provider-transport-dispatcher-pool.js";
import type { StreamFn } from "../runtime/index.js";
import {
  recordEmbeddedSessionForkMessage,
  runEmbeddedSessionFork,
  wrapStreamFnWithSessionFork,
} from "./session-fork.js";

const context: Context = {
  systemPrompt: "Stable instructions",
  messages: [{ role: "user", content: "Parent question", timestamp: 1 }],
};
const model: Model = {
  provider: "openai",
  id: "fork-test",
  name: "Fork test",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  reasoning: false,
  input: ["text"],
  contextWindow: 10000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const identity = { agentId: "main", sessionId: "fork-test", runId: "fork-parent" };

function transport(payloads: Record<string, unknown>[], tools: unknown[]): StreamFn {
  return async (requestModel, requestContext, options) => {
    const key = requestModel.api === "anthropic-messages" ? "messages" : "input";
    const payload = {
      model: requestModel.id,
      system: requestContext.systemPrompt,
      tools,
      [key]: requestContext.messages.map((message) => structuredClone(message)),
    };
    const prepared = (await options?.onPayload?.(payload, requestModel)) ?? payload;
    if (!isRecord(prepared)) {
      throw new Error("Expected provider request");
    }
    payloads.push(prepared);
    const stream = createAssistantMessageEventStream();
    stream.end({
      role: "assistant",
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      content: [{ type: "text", text: "Answer" }],
      stopReason: "stop",
      timestamp: 2,
      usage: {
        input: 10,
        output: 1,
        cacheRead: 9,
        cacheWrite: 0,
        totalTokens: 11,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    return stream;
  };
}

async function fork(requestModel = model) {
  return runEmbeddedSessionFork({
    ...identity,
    model: requestModel,
    apiKey: "synthetic-key",
    question: "Review only",
    assertCurrent: () => {},
  });
}

afterEach(async () => {
  cleanupSessionResources();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await closeProviderTransportDispatcherPool();
});

function responsesBody(): string {
  const item = {
    type: "message",
    id: "msg_fork",
    role: "assistant",
    content: [{ type: "output_text", text: "Answer", annotations: [] }],
    status: "completed",
  };
  return [
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: { id: "resp_fork", status: "completed", output: [item] },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
}

describe("prepared session fork provider boundary", () => {
  it("keeps fork snapshots without retaining completed parent contexts or payload hooks", async () => {
    const callers = new AsyncLocalStorage<object>();
    const references: WeakRef<object>[] = [];
    const payloads: Record<string, unknown>[] = [];

    async function completeParent() {
      const caller = { turn: "completed" };
      const parentContext = structuredClone(context);
      const onPayload = (payload: unknown) => {
        expect(callers.getStore()).toBe(caller);
        return payload;
      };
      references.push(new WeakRef(caller), new WeakRef(parentContext), new WeakRef(onPayload));
      const parent = wrapStreamFnWithSessionFork(transport(payloads, []), identity);
      await callers.run(caller, async () => {
        await (await parent(model, parentContext, { onPayload })).result();
      });
    }

    try {
      await completeParent();
      const control = new WeakRef({ unowned: true });
      // End the creation job before GC; retain the real expiry timer and enabled ALS.
      await nextTurn();
      queryObjects(WeakRef);
      expect(control.deref()).toBeUndefined();
      expect(references.filter((reference) => reference.deref())).toHaveLength(0);
      await expect(fork()).resolves.toBe("Answer");
      expect(payloads).toHaveLength(2);
    } finally {
      callers.disable();
    }
  });

  function guardedTransport(
    beforeDns?: () => void,
    api: "openai-responses" | "anthropic-messages" | "openai-completions" = "openai-responses",
  ) {
    const physicalFetch = vi.fn<typeof fetch>(async () => {
      if (api === "anthropic-messages") {
        const events = [
          {
            type: "message_start",
            message: {
              id: "msg_fork",
              type: "message",
              role: "assistant",
              model: "fork-test",
              content: [],
              usage: { input_tokens: 10, output_tokens: 0 },
            },
          },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Answer" } },
          { type: "content_block_stop", index: 0 },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 1 },
          },
          { type: "message_stop" },
        ];
        return new Response(
          events
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      if (api === "openai-completions") {
        return new Response(
          `data: ${JSON.stringify({
            id: "completion-fork",
            object: "chat.completion.chunk",
            created: 1,
            model: model.id,
            choices: [
              { index: 0, delta: { role: "assistant", content: "Answer" }, finish_reason: "stop" },
            ],
          })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(responsesBody(), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", physicalFetch);
    const realGuardedFetch = guardedFetch.fetchWithSsrFGuard;
    vi.spyOn(guardedFetch, "fetchWithSsrFGuard").mockImplementation((options) =>
      realGuardedFetch({
        ...options,
        lookupFn: async () => {
          beforeDns?.();
          return [{ address: "93.184.216.34", family: 4 }];
        },
      }),
    );
    return {
      physicalFetch,
      parent: wrapStreamFnWithSessionFork(
        api === "anthropic-messages"
          ? createAnthropicMessagesTransportStreamFn()
          : api === "openai-completions"
            ? createOpenAICompletionsTransportStreamFn()
            : createOpenAIResponsesTransportStreamFn(),
        identity,
      ),
    };
  }

  it.each(["bigint", "cycle"])(
    "replays wire history without traversing transport-irrelevant %s tool metadata",
    async (kind) => {
      const { parent, physicalFetch } = guardedTransport();
      const completed = await (
        await parent(model, context, { apiKey: "synthetic-key", transport: "sse" })
      ).result();
      const cyclic: { self?: unknown } = {};
      cyclic.self = cyclic;
      const parentContext: Context = {
        ...context,
        messages: [
          ...context.messages,
          {
            ...completed,
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "completed", name: "lookup", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "completed",
            toolName: "lookup",
            content: [{ type: "text", text: "Tool answer" }],
            isError: false,
            timestamp: 2,
            details: kind === "bigint" ? { value: 1n } : cyclic,
          },
        ],
      };
      const onPayload = vi.fn();
      const forkSent = createDeferredCore();
      const releaseFork = createDeferredCore();
      physicalFetch.mockImplementationOnce(async () => {
        forkSent.resolve();
        await releaseFork.promise;
        return new Response(responsesBody(), {
          headers: { "content-type": "text/event-stream" },
        });
      });
      const runningFork = expect(fork()).resolves.toBe("Answer");
      try {
        await forkSent.promise;
        const assistant = await (
          await parent(model, parentContext, {
            apiKey: "synthetic-key",
            transport: "sse",
            onPayload,
          })
        ).result();
        expect(assistant.stopReason).toBe("stop");
        expect(onPayload).toHaveBeenCalledOnce();
        expect(physicalFetch).toHaveBeenCalledTimes(3);
        await expect(fork()).resolves.toBe("Answer");
      } finally {
        releaseFork.resolve();
        await runningFork;
      }
    },
  );

  it.each(["openai-responses", "anthropic-messages"] as const)(
    "replays frozen %s history and keeps later publications isolated",
    async (api) => {
      const { parent, physicalFetch } = guardedTransport(undefined, api);
      const requestModel = {
        ...model,
        api,
        provider: api === "anthropic-messages" ? "anthropic" : "openai",
        baseUrl: api === "anthropic-messages" ? "https://api.anthropic.com" : model.baseUrl,
      };
      const parentContext: Context = {
        systemPrompt: "Frozen instructions 🦞",
        messages: [
          { role: "user", content: [{ type: "text", text: "Frozen question" }], timestamp: 1 },
        ],
      };
      const message = parentContext.messages[0]!;
      if (Array.isArray(message.content)) {
        message.content.forEach((block) => Object.freeze(block));
      }
      Object.freeze(message.content);
      Object.freeze(message);
      Object.freeze(parentContext.messages);
      Object.freeze(parentContext);
      const assistant = await (
        await parent(requestModel, parentContext, { apiKey: "synthetic-key", transport: "sse" })
      ).result();
      const publication = {
        ...assistant,
        content: [{ type: "text" as const, text: "Published answer" }],
      };
      recordEmbeddedSessionForkMessage(identity.sessionId, identity.runId, publication);
      publication.content[0]!.text = "Changed after publication";

      for (let index = 0; index < 2; index++) {
        await expect(fork(requestModel)).resolves.toBe("Answer");
        const [url, init] = physicalFetch.mock.calls[index + 1]!;
        const body = await new Request(url, init).text();
        expect(body).toContain("Frozen question");
        expect(body).toContain("Published answer");
        expect(body).not.toContain("Changed after publication");
      }
      expect(parentContext.messages).toHaveLength(1);
      expect(parentContext.messages[0]!.content).toEqual([
        { type: "text", text: "Frozen question" },
      ]);
    },
  );

  it.each([
    ["openai-responses", false],
    ["openai-responses", true],
    ["anthropic-messages", false],
    ["anthropic-messages", true],
  ] as const)("represents an in-flight %s tool call as pending (async=%s)", async (api, async) => {
    const { parent, physicalFetch } = guardedTransport(undefined, api);
    const requestModel = {
      ...model,
      api,
      provider: api === "anthropic-messages" ? "anthropic" : "openai",
      baseUrl: api === "anthropic-messages" ? "https://api.anthropic.com" : model.baseUrl,
    };
    const assistant = await (
      await parent(requestModel, context, { apiKey: "synthetic-key", transport: "sse" })
    ).result();
    recordEmbeddedSessionForkMessage(identity.sessionId, identity.runId, {
      ...assistant,
      stopReason: "toolUse",
      content: [
        {
          type: "toolCall",
          id: "pending_call",
          name: "exec",
          arguments: { command: "echo 3; sleep 10" },
          ...(async ? { async: true } : {}),
        },
      ],
    });
    const runFork = () =>
      runEmbeddedSessionFork({
        ...identity,
        model: requestModel,
        apiKey: "synthetic-key",
        question: "Review only",
        assertCurrent: () => {},
      });
    await expect(runFork()).resolves.toBe("Answer");
    const pendingCall = physicalFetch.mock.calls[1]!;
    const pendingBody = await new Request(pendingCall[0], pendingCall[1]).text();
    expect(pendingBody).toContain("pending_call");
    expect(pendingBody).toContain("still running");
    expect(pendingBody).toContain("result is not available yet");
    expect(pendingBody).not.toContain("aborted");
    expect(pendingBody).not.toContain('"is_error":true');

    recordEmbeddedSessionForkMessage(identity.sessionId, identity.runId, {
      role: "toolResult",
      toolCallId: "pending_call",
      toolName: "exec",
      content: [{ type: "text", text: "3" }],
      isError: false,
      timestamp: 3,
    });
    await expect(runFork()).resolves.toBe("Answer");
    const completedCall = physicalFetch.mock.calls[2]!;
    const completedBody = await new Request(completedCall[0], completedCall[1]).text();
    expect(completedBody).not.toContain("still running");
    expect(completedBody).not.toContain("aborted");
    expect(completedBody).toContain(
      api === "anthropic-messages" ? '"content":"3"' : '"output":"3"',
    );
  });

  it.each([
    ["openai-responses", "github-copilot", "earlier:call", "earlier_call"],
    ["openai-responses", "custom", "earlier:call", "earlier:call"],
    ["anthropic-messages", "anthropic", "earlier:call", "earlier_call"],
    ["openai-completions", "openai", "earlier:call|fc_item", "earlier_call"],
  ] as const)(
    "keeps late %s/%s tool results paired with the captured prefix",
    async (api, provider, sourceId, wireId) => {
      const { parent, physicalFetch } = guardedTransport(undefined, api);
      const requestModel = {
        ...model,
        api,
        provider,
      };
      const completed = await (
        await parent(requestModel, context, { apiKey: "synthetic-key" })
      ).result();
      await (
        await parent(
          requestModel,
          {
            ...context,
            messages: [
              ...context.messages,
              {
                ...completed,
                ...(api !== "openai-responses"
                  ? { provider: "prior-provider", model: "prior-model" }
                  : {}),
                content: [
                  { type: "text", text: "Starting lookup" },
                  {
                    type: "toolCall",
                    id: sourceId,
                    name: "lookup",
                    arguments: {},
                    async: true,
                  },
                ],
              },
            ],
          },
          { apiKey: "synthetic-key" },
        )
      ).result();
      recordEmbeddedSessionForkMessage(identity.sessionId, identity.runId, {
        role: "toolResult",
        toolCallId: sourceId,
        toolName: "lookup",
        content: [{ type: "text", text: "LATE_RESULT_1119" }],
        isError: false,
        timestamp: 3,
      });
      await expect(fork(requestModel)).resolves.toBe("Answer");
      const call = physicalFetch.mock.calls.at(-1)!;
      const body = await new Request(call[0], call[1]).text();
      expect(body).toContain("LATE_RESULT_1119");
      const replay = JSON.parse(body);
      const results =
        api === "openai-responses"
          ? replay.input
          : api === "anthropic-messages"
            ? replay.messages.flatMap((message: { content: unknown }) => message.content)
            : replay.messages;
      expect(results).toContainEqual(
        expect.objectContaining(
          api === "openai-responses"
            ? { type: "function_call_output", call_id: wireId, output: "LATE_RESULT_1119" }
            : api === "anthropic-messages"
              ? { type: "tool_result", tool_use_id: wireId, content: "LATE_RESULT_1119" }
              : { role: "tool", tool_call_id: wireId, content: "LATE_RESULT_1119" },
        ),
      );
    },
  );

  it("blocks the physical send when access is withdrawn during guarded DNS preparation", async () => {
    let revoked = false;
    let withdrawDuringDns = false;
    const { parent, physicalFetch } = guardedTransport(() => {
      if (withdrawDuringDns) {
        revoked = true;
      }
    });
    await (await parent(model, context, { apiKey: "synthetic-key", transport: "sse" })).result();
    physicalFetch.mockClear();
    withdrawDuringDns = true;
    await expect(
      runEmbeddedSessionFork({
        ...identity,
        model,
        apiKey: "synthetic-key",
        question: "Review only",
        assertCurrent: () => {
          if (revoked) {
            throw new Error("Session access withdrawn");
          }
        },
      }),
    ).rejects.toThrow("Session access withdrawn");
    expect(physicalFetch).not.toHaveBeenCalled();
  });

  it("rechecks native SSE fork authority before replaying a redirect body", async () => {
    const redirectReady = createDeferredCore();
    const releaseRedirect = createDeferredCore();
    const requests: string[] = [];
    let redirectFork = false;
    let revoked = false;
    await withServer(
      (request, response) => {
        requests.push(request.url ?? "");
        request.resume();
        request.on("end", () => {
          if (redirectFork && request.url !== "/redirected") {
            redirectReady.resolve();
            void releaseRedirect.promise.then(() => {
              response.writeHead(307, { location: "/redirected" });
              response.end();
            });
          } else {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.end(responsesBody());
          }
        });
      },
      async (baseUrl) => {
        const requestModel = attachModelProviderRequestTransport(
          {
            ...model,
            api: "openai-chatgpt-responses" as const,
            baseUrl,
          },
          { allowPrivateNetwork: true },
        );
        const apiKey = `e30.${Buffer.from(
          JSON.stringify({
            "https://api.openai.com/auth": { chatgpt_account_id: "fork-account" },
          }),
        ).toString("base64url")}.signature`;
        const parent = wrapStreamFnWithSessionFork(
          (activeModel, requestContext, options) =>
            streamSimpleOpenAICodexResponses(
              { ...activeModel, api: "openai-chatgpt-responses" },
              requestContext,
              options,
            ),
          identity,
        );
        expect(
          (await (await parent(requestModel, context, { apiKey, transport: "sse" })).result())
            .stopReason,
        ).toBe("stop");
        requests.length = 0;
        redirectFork = true;
        const result = runEmbeddedSessionFork({
          ...identity,
          model: requestModel,
          apiKey,
          question: "Review only",
          assertCurrent: () => {
            if (revoked) {
              throw new Error("Session access withdrawn");
            }
          },
        });
        const rejected = expect(result).rejects.toThrow("Session access withdrawn");
        await redirectReady.promise;
        revoked = true;
        releaseRedirect.resolve();
        await rejected;
        expect(requests).toHaveLength(1);
        expect(requests).not.toContain("/redirected");
      },
    );
  });

  it("replays through the current prepared proxy and TLS transport policy", async () => {
    const { parent, physicalFetch } = guardedTransport();
    const proxy = vi.spyOn(undiciRuntime, "createHttp1ProxyAgent");
    const requestModel = attachModelProviderRequestTransport(model, {
      proxy: {
        mode: "explicit-proxy",
        url: "http://parent-proxy.example:8443",
        tls: { ca: "parent-ca", insecureSkipVerify: false },
      },
    });
    await (
      await parent(requestModel, context, { apiKey: "synthetic-key", transport: "sse" })
    ).result();
    expect(proxy).toHaveBeenCalled();
    proxy.mockClear();
    physicalFetch.mockClear();
    const currentModel = attachModelProviderRequestTransport(requestModel, {
      proxy: {
        mode: "explicit-proxy",
        url: "http://proxy.example:8443",
        tls: { ca: "synthetic-ca", insecureSkipVerify: false },
      },
    });
    await expect(
      runEmbeddedSessionFork({
        ...identity,
        model: currentModel,
        apiKey: "synthetic-key",
        question: "Review only",
        assertCurrent: () => {},
      }),
    ).resolves.toBe("Answer");
    expect(proxy).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: "http://proxy.example:8443",
        requestTls: expect.objectContaining({ ca: "synthetic-ca", rejectUnauthorized: true }),
      }),
      undefined,
    );
    expect(physicalFetch).toHaveBeenCalledOnce();
    expect(physicalFetch.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({
        dispatcher: proxy.mock.results[0]?.value,
      }),
    );
  });

  it("denies Anthropic hosted search while preserving the real request prefix", async () => {
    const { parent, physicalFetch } = guardedTransport(undefined, "anthropic-messages");
    const requestModel = {
      ...model,
      api: "anthropic-messages" as const,
      provider: "anthropic",
      baseUrl: "https://api.anthropic.com",
    };
    const hostedTool = { type: "web_search_20250305", name: "web_search" };
    const options = {
      apiKey: "synthetic-key",
      onPayload: (payload: unknown) => {
        if (!isRecord(payload)) {
          throw new Error("Expected provider request");
        }
        return { ...payload, tools: [hostedTool] };
      },
    };
    expect((await (await parent(requestModel, context, options)).result()).stopReason).toBe("stop");
    const readPayload = async (index: number) => {
      const call = physicalFetch.mock.calls[index];
      if (!call) {
        throw new Error("Missing physical request");
      }
      const payload: unknown = await new Request(call[0], call[1]).json();
      if (!isRecord(payload)) {
        throw new Error("Expected provider request");
      }
      return payload;
    };
    const original = await readPayload(0);
    await expect(
      runEmbeddedSessionFork({
        ...identity,
        model: requestModel,
        apiKey: "synthetic-key",
        question: "Review only",
        assertCurrent: () => {},
      }),
    ).resolves.toBe("Answer");
    const replay = await readPayload(1);
    if (!Array.isArray(original.messages) || !Array.isArray(replay.messages)) {
      throw new Error("Expected Anthropic messages");
    }
    expect(replay.tool_choice).toEqual({ type: "none" });
    expect(replay.tools).toEqual([hostedTool]);
    expect(replay.system).toEqual(original.system);
    expect(replay.messages.slice(0, original.messages.length)).toEqual(original.messages);
    expect(replay.messages).toHaveLength(original.messages.length + 1);
  });

  it("retains the full parent prefix when HTTP continuation sends only a suffix", async () => {
    const { parent, physicalFetch } = guardedTransport();
    const requestModel: Model = { ...model, compat: { supportsResponsesContinuation: true } };
    const options = {
      apiKey: "synthetic-key",
      sessionId: identity.sessionId,
      transport: "sse" as const,
      onPayload: (payload: unknown) => {
        if (!isRecord(payload)) {
          throw new Error("Expected request");
        }
        return { ...payload, store: true };
      },
    };
    const completed = await (await parent(requestModel, context, options)).result();
    await (
      await parent(
        requestModel,
        {
          ...context,
          messages: [
            ...context.messages,
            completed,
            { role: "user", content: "Continue parent", timestamp: 3 },
          ],
        },
        options,
      )
    ).result();
    const second = physicalFetch.mock.calls[1]!;
    const continuation = await new Request(second[0], second[1]).json();
    expect(continuation.previous_response_id).toBe("resp_fork");
    expect(JSON.stringify(continuation.input)).not.toContain("Parent question");
    await expect(fork(requestModel)).resolves.toBe("Answer");
    const last = physicalFetch.mock.calls.at(-1)!;
    const replay = await new Request(last[0], last[1]).json();
    expect(replay.previous_response_id).toBeUndefined();
    expect(JSON.stringify(replay.input)).toContain("Parent question");
    expect(JSON.stringify(replay.input)).toContain("Continue parent");
    expect(JSON.stringify(replay.input)).toContain("Review only");
  });

  it("rejects Bedrock forks before dispatch with an actionable unsupported API error", async () => {
    await expect(
      runEmbeddedSessionFork({
        ...identity,
        model: { ...model, api: "bedrock-converse-stream" },
        question: "Review only",
        assertCurrent: () => {},
      }),
    ).rejects.toThrow("Session forks do not support provider API bedrock-converse-stream");
  });

  it("does not restore cleared context when an old publication arrives", async () => {
    const payloads: Record<string, unknown>[] = [];
    const parent = wrapStreamFnWithSessionFork(transport(payloads, []), identity);
    const message = await (await parent(model, context, {})).result();
    cleanupSessionResources(identity.sessionId);
    recordEmbeddedSessionForkMessage(identity.sessionId, identity.runId, message);
    await expect(fork()).rejects.toThrow("requires a parent turn");
    expect(payloads).toHaveLength(1);
  });

  it("retires optional replay if a published message cannot be retained", async () => {
    const payloads: Record<string, unknown>[] = [];
    const parent = wrapStreamFnWithSessionFork(transport(payloads, []), identity);
    await (await parent(model, context, {})).result();
    expect(() =>
      recordEmbeddedSessionForkMessage(identity.sessionId, identity.runId, {
        role: "toolResult",
        toolCallId: "lookup",
        toolName: "lookup",
        content: [],
        isError: false,
        timestamp: 2,
        details: { callback: () => {} },
      }),
    ).not.toThrow();
    await expect(fork()).rejects.toThrow("requires a parent turn");
  });

  it("isolates replayed wire data without re-entering the parent's one-shot payload hook", async () => {
    const { parent, physicalFetch } = guardedTransport();
    const unicode = "🦞 café e\u0301 \u0000 \ud800";
    let encodings = 0;
    const metadata = {
      acknowledged: "review",
      unicode,
      toJSON() {
        return { acknowledged: this.acknowledged, unicode, encoding: ++encodings };
      },
    };
    const codeModeOptions = {
      openclawCodeModeToolSurface: true,
      openclawCodeModeAllowedHostedToolTypes: new Set(["web_search"]),
    };
    const tools = ["exec", "wait"].map((name) => ({
      name,
      description: name,
      parameters: Type.Object({}),
    }));
    const parentText = "Unicode parent 🦞 café e\u0301";
    const onPayload = vi.fn((payload: unknown) => {
      if (onPayload.mock.calls.length > 1) {
        throw new Error("Provider review continuation cannot rebuild or retry its request");
      }
      if (!isRecord(payload) || !Array.isArray(payload.tools)) {
        throw new Error("Expected request");
      }
      return {
        ...payload,
        client_metadata: metadata,
        tools: [...payload.tools, { type: "web_search" }],
      };
    });
    await (
      await parent(
        model,
        { ...context, tools, messages: [{ role: "user", content: parentText, timestamp: 1 }] },
        { ...codeModeOptions, apiKey: "synthetic-key", onPayload },
      )
    ).result();
    expect(encodings).toBe(1);
    metadata.acknowledged = "changed after parent send";
    await expect(fork()).resolves.toBe("Answer");
    await expect(fork()).resolves.toBe("Answer");
    expect(onPayload).toHaveBeenCalledTimes(1);
    const bodies = await Promise.all(
      physicalFetch.mock.calls.map(([url, init]) => new Request(url, init).json()),
    );
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(body).toMatchObject({
        client_metadata: { acknowledged: "review", unicode, encoding: 1 },
        input: expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: [{ type: "input_text", text: parentText }],
          }),
        ]),
      });
    }
    expect(bodies[2]).toEqual(bodies[1]);
    for (const body of bodies.slice(1)) {
      expect(body.tools).toEqual(bodies[0].tools);
      expect(body.tool_choice).toBe("none");
    }
  });
});
