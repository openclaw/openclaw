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
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { expectText } from "../../test-utils/text-assertions.js";
import { providerResponse, type WireApi } from "../embedded-agent-runner.wire.test-support.js";
import { attachModelProviderRequestTransport } from "../provider-request-config.js";
import { closeProviderTransportDispatcherPool } from "../provider-transport-dispatcher-pool.js";
import type { StreamFn } from "../runtime/index.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
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
  overrides: Partial<Parameters<typeof runEmbeddedSessionFork>[0]> = {},
) {
  return runEmbeddedSessionFork({
    context: requestContext,
    streamFn,
    model: requestModel,
    apiKey: "synthetic-key",
    options: { transport: "sse" },
    question: "Review only",
    assertCurrent() {},
    ...overrides,
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
    const details: { value: bigint; self?: unknown } = { value: 1n };
    details.self = details;
    const prepared: Context = {
      ...history(
        assistant([toolCall(sourceId, "lookup", {}, true)], callModel),
        toolResult(sourceId, "lookup", "LATE_RESULT_1119", details),
      ),
      tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
    };
    // The full-run reconstruction suite covers Responses byte identity; keep
    // Chat Completions' exact prefix check at this completed-tool replay boundary.
    let originalMessages: unknown[] | undefined;
    if (api === "openai-completions") {
      await complete(streamFn, requestModel, prepared);
      originalMessages = (await request().json()).messages;
    }
    await expect(fork(streamFn, requestModel, prepared)).resolves.toBe("Answer");
    const replay = await request().json();
    if (originalMessages) {
      expect(JSON.stringify(replay.messages.slice(0, originalMessages.length))).toBe(
        JSON.stringify(originalMessages),
      );
    }
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
    fork(streamFn, model, context, {
      assertCurrent() {
        if (revoked) {
          throw new Error("Session access withdrawn");
        }
      },
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
      const result = fork(streamFn, requestModel, context, {
        apiKey,
        assertCurrent() {
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
  await expect(fork(streamFn, requestModel, prepared, { options })).resolves.toBe("Answer");
  const replay = await request().json();
  expect(replay.previous_response_id).toBeUndefined();
  expectText(JSON.stringify(replay.input), ["Parent question", "Continue parent", "Review only"]);
});

it("rejects unsupported APIs before dispatch", async () => {
  const streamFn = vi.fn<StreamFn>();
  await expect(fork(streamFn, { ...model, api: "bedrock-converse-stream" })).rejects.toThrow(
    "Session forks do not support provider API bedrock-converse-stream",
  );
  expect(streamFn).not.toHaveBeenCalled();
});
