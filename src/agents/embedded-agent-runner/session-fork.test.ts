import { cleanupSessionResources } from "@openclaw/ai/internal/runtime";
import {
  createAnthropicMessagesTransportStreamFn,
  createOpenAICompletionsTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "@openclaw/ai/transports";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import { streamSimpleOpenAICodexResponses } from "../../../packages/ai/src/providers/openai-chatgpt-responses.js";
import * as guardedFetch from "../../infra/net/fetch-guard.js";
import * as undiciRuntime from "../../infra/net/undici-runtime.js";
import type { Context, Message, Model } from "../../llm/types.js";
import "../ai-transport-runtime-host.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { expectText } from "../../test-utils/text-assertions.js";
import { providerResponse, type WireApi } from "../embedded-agent-runner.wire.test-support.js";
import { attachModelProviderRequestTransport } from "../provider-request-config.js";
import { closeProviderTransportDispatcherPool } from "../provider-transport-dispatcher-pool.js";
import type { StreamFn } from "../runtime/index.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { ZERO_USAGE_FIXTURE } from "../test-helpers/usage-fixtures.js";
import { runEmbeddedSessionFork } from "./session-fork.js";

const context: Context = {
  systemPrompt: "Stable instructions",
  messages: [{ role: "user", content: "Parent question", timestamp: 1 }],
};
const model = makeProviderModelFixture({
  provider: "openai",
  id: "fork-test",
  name: "Fork test",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  contextWindow: 10000,
  maxTokens: 1000,
});
const sseOptions = { apiKey: "synthetic-key", transport: "sse" as const };

function apiModel(api: WireApi): Model {
  return {
    ...model,
    api,
    provider: api === "anthropic-messages" ? "anthropic" : "openai",
    baseUrl: api === "anthropic-messages" ? "https://api.anthropic.com" : model.baseUrl,
  };
}
async function complete(
  streamFn: StreamFn,
  requestModel: Model = model,
  requestContext = context,
  options: Parameters<StreamFn>[2] = sseOptions,
) {
  return (await streamFn(requestModel, requestContext, options)).result();
}
function toolCall(id: string, name: string, args: Record<string, unknown> = {}, async?: true) {
  return { type: "toolCall" as const, id, name, arguments: args, ...(async ? { async } : {}) };
}
function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  details?: unknown,
): Message {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp: 3,
    details,
  };
}
function assistant(calls: ReturnType<typeof toolCall>[], requestModel: Model = model): Message {
  return makeAgentAssistantMessage({
    api: requestModel.api,
    provider: requestModel.provider,
    model: requestModel.id,
    content: calls,
    stopReason: "toolUse",
    timestamp: 2,
  });
}
const history = (...messages: Message[]): Context => ({
  ...context,
  messages: [...context.messages, ...messages],
});
function fork(
  streamFn: StreamFn,
  requestModel: Model = model,
  requestContext = context,
  assertCurrent = () => {},
) {
  return runEmbeddedSessionFork({
    context: requestContext,
    streamFn,
    model: requestModel,
    apiKey: "synthetic-key",
    options: { transport: "sse" },
    question: "Review only",
    assertCurrent,
  });
}

function wireResponse(api: WireApi = "openai-responses"): Response {
  return providerResponse({
    api,
    model: model.id,
    id: "resp_fork",
    messageId: "msg_fork",
    text: "Answer",
    calls: [],
    done: api === "openai-completions",
    completionModel: true,
  }).response;
}
function guardedTransport(beforeDns?: () => void, api: WireApi = "openai-responses") {
  const physicalFetch = vi.fn<typeof fetch>(async () => wireResponse(api));
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
    request: (index = -1) => {
      const [url, init] = physicalFetch.mock.calls.at(index)!;
      return new Request(url, init);
    },
    streamFn:
      api === "anthropic-messages"
        ? createAnthropicMessagesTransportStreamFn()
        : api === "openai-completions"
          ? createOpenAICompletionsTransportStreamFn()
          : createOpenAIResponsesTransportStreamFn(),
  };
}
afterEach(async () => {
  cleanupSessionResources();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await closeProviderTransportDispatcherPool();
});

it.each(["openai-responses", "openai-completions"] as const)(
  "rebuilds an identical %s wire prefix from history without a captured parent",
  async (api) => {
    const { streamFn, request } = guardedTransport(undefined, api);
    const requestModel = apiModel(api);
    const prepared: Context = {
      ...history(
        assistant([toolCall("lookup_1", "lookup")], requestModel),
        toolResult("lookup_1", "lookup", "Known answer 🦞"),
        {
          role: "user",
          content: [
            { type: "text", text: "Inspect this image" },
            {
              type: "image",
              mimeType: "image/png",
              data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
            },
          ],
          timestamp: 4,
        },
      ),
      tools: [
        { name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } },
      ],
    };
    expect((await complete(streamFn, requestModel, prepared)).stopReason).toBe("stop");
    const original = await request().json();
    cleanupSessionResources();
    await expect(fork(streamFn, requestModel, prepared)).resolves.toBe("Answer");
    const replay = await request().json();
    const key = api === "openai-responses" ? "input" : "messages";
    expect(JSON.stringify(replay[key].slice(0, original[key].length))).toBe(
      JSON.stringify(original[key]),
    );
    expect(replay.tools).toEqual(original.tools);
    expect(replay.instructions).toEqual(original.instructions);
    expect(replay.tool_choice).toBe("none");
    expect(replay.previous_response_id).toBeUndefined();
    expectText(JSON.stringify(replay[key]), [
      "Known answer 🦞",
      "Review only",
      "Inspect this image",
    ]);
    expect(prepared.messages).toHaveLength(4);
  },
);

it.each(["bigint", "cycle"])(
  "does not traverse transport-irrelevant %s tool metadata",
  async (kind) => {
    const { streamFn, request } = guardedTransport();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const prepared = history(
      assistant([toolCall("lookup", "lookup")]),
      toolResult("lookup", "lookup", "Known answer", kind === "bigint" ? { value: 1n } : cyclic),
    );
    await expect(fork(streamFn, model, prepared)).resolves.toBe("Answer");
    expect(await request().text()).toContain("Known answer");
  },
);

it.each([
  ["openai-responses", false],
  ["openai-responses", true],
  ["anthropic-messages", false],
  ["anthropic-messages", true],
] as const)(
  "pairs an in-flight %s tool call without changing its parent (async=%s)",
  async (api, async) => {
    const { streamFn, request } = guardedTransport(undefined, api);
    const requestModel = apiModel(api);
    const prepared = history(
      assistant(
        [toolCall("pending_call", "exec", { command: "echo 3; sleep 10" }, async || undefined)],
        requestModel,
      ),
    );
    Object.freeze(prepared.messages);
    await expect(fork(streamFn, requestModel, prepared)).resolves.toBe("Answer");
    expectText(
      await request().text(),
      ["pending_call", "still running", "result is not available yet"],
      ["aborted", '"is_error":true'],
    );
    expect(prepared.messages).toHaveLength(2);
    await expect(
      fork(streamFn, requestModel, {
        ...prepared,
        messages: [...prepared.messages, toolResult("pending_call", "exec", "3")],
      }),
    ).resolves.toBe("Answer");
    expectText(
      await request().text(),
      [api === "anthropic-messages" ? '"content":"3"' : '"output":"3"'],
      ["still running", "aborted"],
    );
  },
);

it.each([
  ["openai-responses", "github-copilot", "earlier:call", "earlier_call"],
  ["openai-responses", "custom", "earlier:call", "earlier:call"],
  ["anthropic-messages", "anthropic", "earlier:call", "earlier_call"],
  ["openai-completions", "openai", "earlier:call|fc_item", "earlier_call"],
] as const)(
  "pairs late %s/%s results after provider call-ID conversion",
  async (api, provider, sourceId, wireId) => {
    const { streamFn, request } = guardedTransport(undefined, api);
    const requestModel = { ...model, api, provider };
    const callModel =
      api === "openai-responses"
        ? requestModel
        : { ...requestModel, provider: "prior-provider", id: "prior-model" };
    const prepared: Context = {
      ...history(
        assistant([toolCall(sourceId, "lookup", {}, true)], callModel),
        toolResult(sourceId, "lookup", "LATE_RESULT_1119"),
      ),
      tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
    };
    await expect(fork(streamFn, requestModel, prepared)).resolves.toBe("Answer");
    const replay = await request().json();
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
  const { streamFn, physicalFetch } = guardedTransport(() => {
    revoked = true;
  });
  await expect(
    fork(streamFn, model, context, () => {
      if (revoked) {
        throw new Error("Session access withdrawn");
      }
    }),
  ).rejects.toThrow("Session access withdrawn");
  expect(physicalFetch).not.toHaveBeenCalled();
});

it("rechecks native SSE fork authority before replaying a redirect body", async () => {
  const responseBody = await wireResponse().text();
  const redirectReady = createDeferredCore();
  const releaseRedirect = createDeferredCore();
  const requests: string[] = [];
  let revoked = false;
  await withServer(
    (request, response) => {
      requests.push(request.url ?? "");
      request.resume();
      request.on("end", () => {
        if (request.url !== "/redirected") {
          redirectReady.resolve();
          void releaseRedirect.promise.then(() => {
            response.writeHead(307, { location: "/redirected" });
            response.end();
          });
        } else {
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.end(responseBody);
        }
      });
    },
    async (baseUrl) => {
      const requestModel = attachModelProviderRequestTransport(
        { ...model, api: "openai-chatgpt-responses" as const, baseUrl },
        { allowPrivateNetwork: true },
      );
      const apiKey = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "fork-account" } })).toString("base64url")}.signature`;
      const streamFn: StreamFn = (activeModel, requestContext, options) =>
        streamSimpleOpenAICodexResponses(
          { ...activeModel, api: "openai-chatgpt-responses" },
          requestContext,
          options,
        );
      const result = runEmbeddedSessionFork({
        context,
        streamFn,
        model: requestModel,
        apiKey,
        options: { transport: "sse" },
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

it("uses the current prepared proxy and TLS transport policy", async () => {
  const { streamFn, physicalFetch } = guardedTransport();
  const proxy = vi.spyOn(undiciRuntime, "createHttp1ProxyAgent");
  const requestModel = attachModelProviderRequestTransport(model, {
    proxy: {
      mode: "explicit-proxy",
      url: "http://proxy.example:8443",
      tls: { ca: "synthetic-ca", insecureSkipVerify: false },
    },
  });
  await expect(fork(streamFn, requestModel)).resolves.toBe("Answer");
  expect(proxy).toHaveBeenCalledWith(
    expect.objectContaining({
      uri: "http://proxy.example:8443",
      requestTls: expect.objectContaining({ ca: "synthetic-ca", rejectUnauthorized: true }),
    }),
    undefined,
  );
  expect(physicalFetch).toHaveBeenCalledOnce();
  expect(physicalFetch.mock.calls[0]?.[1]).toEqual(
    expect.objectContaining({ dispatcher: proxy.mock.results[0]?.value }),
  );
});

it("denies Anthropic hosted search while retaining prepared tools and system", async () => {
  const { streamFn, request } = guardedTransport(undefined, "anthropic-messages");
  const requestModel = apiModel("anthropic-messages");
  const hostedTool = { type: "web_search_20250305", name: "web_search" };
  const withHostedTool: StreamFn = (activeModel, requestContext, options) =>
    streamFn(activeModel, requestContext, {
      ...options,
      onPayload: (payload, payloadModel) => {
        if (!isRecord(payload)) {
          throw new Error("Expected provider request");
        }
        const prepared = { ...payload, tools: [hostedTool] };
        return options?.onPayload?.(prepared, payloadModel) ?? prepared;
      },
    });
  await complete(withHostedTool, requestModel);
  const original = await request().json();
  await expect(fork(withHostedTool, requestModel)).resolves.toBe("Answer");
  const replay = await request().json();
  expect(replay).toEqual(
    expect.objectContaining({
      tool_choice: { type: "none" },
      tools: [hostedTool],
      system: original.system,
    }),
  );
  expectText(JSON.stringify(replay.messages), ["Parent question", "Review only"]);
});

it("rebuilds full history independently when the parent uses HTTP continuation", async () => {
  const { streamFn, request } = guardedTransport();
  const requestModel: Model = { ...model, compat: { supportsResponsesContinuation: true } };
  const options = { ...sseOptions, sessionId: "fork-continuation" };
  const completed = await complete(streamFn, requestModel, context, options);
  const prepared = history(completed, { role: "user", content: "Continue parent", timestamp: 3 });
  await complete(streamFn, requestModel, prepared, options);
  const continuation = await request().json();
  expect(continuation.previous_response_id).toBe("resp_fork");
  expect(JSON.stringify(continuation.input)).not.toContain("Parent question");
  await expect(
    runEmbeddedSessionFork({
      context: prepared,
      streamFn,
      model: requestModel,
      apiKey: "synthetic-key",
      options,
      question: "Review only",
      assertCurrent() {},
    }),
  ).resolves.toBe("Answer");
  const replay = await request().json();
  expect(replay.previous_response_id).toBeUndefined();
  expectText(JSON.stringify(replay.input), ["Parent question", "Continue parent", "Review only"]);
});

it("returns provider-reported usage and denies requested tools before answering", async () => {
  const requests: Context[] = [];
  const onUsage = vi.fn();
  const streamFn: StreamFn = async (requestModel, requestContext, options) => {
    requests.push({ ...requestContext, messages: [...requestContext.messages] });
    const payload = await options?.onPayload?.(
      { input: requestContext.messages, tools: [{ type: "web_search" }] },
      requestModel,
    );
    expect(payload).toMatchObject({ tool_choice: "none" });
    const stream = createAssistantMessageEventStream();
    stream.end(
      makeAgentAssistantMessage({
        api: requestModel.api,
        provider: requestModel.provider,
        model: requestModel.id,
        stopReason: requests.length === 1 ? "toolUse" : "stop",
        content:
          requests.length === 1 ? [toolCall("denied", "exec")] : [{ type: "text", text: "Answer" }],
        // This proves usage forwarding from a mock provider, not live cache effectiveness.
        usage: { ...ZERO_USAGE_FIXTURE, input: 10, output: 1, cacheRead: 9, totalTokens: 20 },
      }),
    );
    return stream;
  };
  await expect(
    runEmbeddedSessionFork({
      context,
      streamFn,
      model,
      question: "Review only",
      assertCurrent() {},
      onUsage,
    }),
  ).resolves.toBe("Answer");
  expect(requests).toHaveLength(2);
  expectText(JSON.stringify(requests[1]?.messages), ["Tool execution denied", "denied"]);
  expect(onUsage).toHaveBeenLastCalledWith(
    expect.objectContaining({ input: 20, output: 2, cacheRead: 18 }),
  );
  expect(context.messages).toHaveLength(1);
});

it("rejects unsupported APIs before dispatch", async () => {
  const streamFn = vi.fn<StreamFn>();
  await expect(fork(streamFn, { ...model, api: "bedrock-converse-stream" })).rejects.toThrow(
    "Session forks do not support provider API bedrock-converse-stream",
  );
  expect(streamFn).not.toHaveBeenCalled();
});
