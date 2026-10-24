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
import { afterEach, expect, it, vi } from "vitest";
import { streamSimpleOpenAICodexResponses } from "../../../packages/ai/src/providers/openai-chatgpt-responses.js";
import {
  modelRequestBodyState,
  prepareModelRequestBody,
  serializeModelRequestBody,
} from "../../../packages/ai/src/transports/model-request-body.js";
import * as guardedFetch from "../../infra/net/fetch-guard.js";
import * as undiciRuntime from "../../infra/net/undici-runtime.js";
import "../ai-transport-runtime-host.js";
import type { Context, Message, Model } from "../../llm/types.js";
import { createAssistantMessageEventStream } from "../../llm/utils/event-stream.js";
import { withServer } from "../../plugin-sdk/test-helpers/http-test-server.js";
import { createDeferredCore } from "../../shared/deferred.js";
import { providerResponse, type WireApi } from "../embedded-agent-runner.wire.test-support.js";
import { attachModelProviderRequestTransport } from "../provider-request-config.js";
import { closeProviderTransportDispatcherPool } from "../provider-transport-dispatcher-pool.js";
import type { StreamFn } from "../runtime/index.js";
import { makeAgentAssistantMessage } from "../test-helpers/agent-message-fixtures.js";
import { makeProviderModelFixture } from "../test-helpers/provider-model-fixture.js";
import { ZERO_USAGE_FIXTURE } from "../test-helpers/usage-fixtures.js";
import {
  recordEmbeddedSessionForkMessage,
  runEmbeddedSessionFork,
  wrapStreamFnWithSessionFork,
} from "./session-fork.js";

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
const identity = { agentId: "main", sessionId: "fork-test", runId: "fork-parent" };
const sseOptions = { apiKey: "synthetic-key", transport: "sse" as const };

function apiModel(api: "openai-responses" | "anthropic-messages"): Model {
  return {
    ...model,
    api,
    provider: api === "anthropic-messages" ? "anthropic" : "openai",
    baseUrl: api === "anthropic-messages" ? "https://api.anthropic.com" : model.baseUrl,
  };
}

async function complete(
  parent: StreamFn,
  requestModel: Model = model,
  requestContext = context,
  options: Parameters<StreamFn>[2] = {},
) {
  return (await parent(requestModel, requestContext, options)).result();
}

function toolResult(
  toolCallId: string,
  toolName: string,
  text: string,
  details?: unknown,
  timestamp = 3,
): Extract<Message, { role: "toolResult" }> {
  return {
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    isError: false,
    timestamp,
    details,
  };
}
const publish = (message: Message) =>
  recordEmbeddedSessionForkMessage(identity.sessionId, identity.runId, message);
const publishedResult = (...args: Parameters<typeof toolResult>) => publish(toolResult(...args));
const history = (...messages: Message[]): Context => ({
  ...context,
  messages: [...context.messages, ...messages],
});
function parentTransport() {
  const payloads: Record<string, unknown>[] = [];
  return { payloads, parent: wrapStreamFnWithSessionFork(transport(payloads), identity) };
}

function transport(payloads: Record<string, unknown>[]): StreamFn {
  return async (requestModel, requestContext, options) => {
    const key = requestModel.api === "anthropic-messages" ? "messages" : "input";
    const payload = {
      model: requestModel.id,
      system: requestContext.systemPrompt,
      tools: [],
      [key]: requestContext.messages.map((message) => structuredClone(message)),
    };
    const prepared = (await options?.onPayload?.(payload, requestModel)) ?? payload;
    if (!isRecord(prepared)) {
      throw new Error("Expected provider request");
    }
    payloads.push(prepared);
    const stream = createAssistantMessageEventStream();
    stream.end(
      makeAgentAssistantMessage({
        api: requestModel.api,
        provider: requestModel.provider,
        model: requestModel.id,
        content: [{ type: "text", text: "Answer" }],
        timestamp: 2,
        usage: { ...ZERO_USAGE_FIXTURE, input: 10, output: 1, cacheRead: 9, totalTokens: 11 },
      }),
    );
    return stream;
  };
}

function expectText(text: string, included: string[], excluded: string[] = []) {
  for (const part of included) {
    expect(text).toContain(part);
  }
  for (const part of excluded) {
    expect(text).not.toContain(part);
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown> = {}, async?: true) {
  return {
    type: "toolCall" as const,
    id,
    name,
    arguments: args,
    ...(async === undefined ? {} : { async }),
  };
}

function captureParent(prepare?: StreamFn) {
  const liveOptions: NonNullable<Parameters<StreamFn>[2]>[] = [];
  const payloads: Record<string, unknown>[] = [];
  const replay = transport(payloads);
  const parent = wrapStreamFnWithSessionFork((requestModel, requestContext, options) => {
    if (liveOptions.length) {
      return replay(requestModel, requestContext, options);
    }
    liveOptions.push(options!);
    return prepare?.(requestModel, requestContext, options) ?? createAssistantMessageEventStream();
  }, identity);
  return { parent, liveOptions, payloads };
}

async function expectCollected(references: WeakRef<object>[]) {
  const control = new WeakRef({ unowned: true });
  // Leave the creation job before GC, without disabling expiry timers or ALS.
  await nextTurn();
  queryObjects(WeakRef);
  expect(control.deref()).toBeUndefined();
  expect(references.filter((reference) => reference.deref())).toHaveLength(0);
}

async function fork(requestModel: Model = model, assertCurrent = () => {}) {
  return runEmbeddedSessionFork({
    ...identity,
    model: requestModel,
    apiKey: "synthetic-key",
    question: "Review only",
    assertCurrent,
  });
}

afterEach(async () => {
  cleanupSessionResources();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await closeProviderTransportDispatcherPool();
});

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

it.each(["unencoded", "encoded", "continuation"] as const)(
  "releases the %s prepared payload while the parent options remain live",
  async (boundary) => {
    const references: WeakRef<object>[] = [];
    const { parent, liveOptions, payloads } = captureParent(
      async (requestModel, _context, options) => {
        modelRequestBodyState(options!).encode = async (payload) => {
          const encoded = serializeModelRequestBody(payload);
          references.push(new WeakRef(encoded.body.buffer));
          return encoded;
        };
        const encode = boundary === "unencoded" ? undefined : prepareModelRequestBody(options);
        const payload = {
          model: model.id,
          input: [{ role: "user", content: "Prepared parent prefix" }],
          stream: true,
        };
        references.push(new WeakRef(payload));
        await options?.onPayload?.(payload, requestModel);
        await encode?.(
          boundary === "continuation"
            ? { ...payload, input: [], previous_response_id: "resp_parent" }
            : payload,
        );
        return createAssistantMessageEventStream();
      },
    );

    await parent(model, context, {});
    await expectCollected(references);
    expect(liveOptions[0]?.onPayload).toBeTypeOf("function");
    await expect(fork()).resolves.toBe("Answer");
    expect(JSON.stringify(payloads[0]?.input)).toContain("Prepared parent prefix");
  },
);

it("keeps a captured prefix across suffix retries and replaces it after full-history recovery", async () => {
  const { parent, liveOptions, payloads } = captureParent();
  await parent(model, context, {});
  const options = liveOptions[0]!;
  const encode = prepareModelRequestBody(options);
  await options.onPayload?.(
    { input: [{ role: "user", content: "Original full prefix" }], stream: true },
    model,
  );
  const suffix = { input: [], previous_response_id: "resp_parent", stream: true };
  await encode(suffix);
  await encode({ ...suffix, service_tier: "default" });
  await expect(fork()).resolves.toBe("Answer");
  expect(JSON.stringify(payloads.at(-1)?.input)).toContain("Original full prefix");

  const rebuilt = {
    input: [{ role: "user", content: "Recovered full history" }],
    stream: true,
  };
  await options.onPayload?.(rebuilt, model);
  await encode(rebuilt);
  await expect(fork()).resolves.toBe("Answer");
  const recovered = JSON.stringify(payloads.at(-1)?.input);
  expectText(recovered, ["Recovered full history"], ["Original full prefix"]);
});

it.each([false, true])(
  "prepares the next parent without reviving cleared state (cleared: %s)",
  async (cleared) => {
    const { payloads, parent } = parentTransport();
    await complete(parent);
    const review = cleared ? undefined : fork();
    const preparing = createDeferredCore();
    const releasePreparation = createDeferredCore();
    const nextParent = parent(
      model,
      cleared
        ? context
        : {
            ...context,
            messages: [{ role: "user", content: "Next parent request", timestamp: 3 }],
          },
      {
        onPayload: async (payload) => {
          preparing.resolve();
          await releasePreparation.promise;
          return payload;
        },
      },
    );
    try {
      await preparing.promise;
      if (cleared) {
        cleanupSessionResources(identity.sessionId);
      } else {
        await expect(review).resolves.toBe("Answer");
        await expect(fork()).resolves.toBe("Answer");
        expectText(
          JSON.stringify(payloads.at(-1)?.input),
          ["Parent question"],
          ["Next parent request"],
        );
      }
    } finally {
      releasePreparation.resolve();
      await (await nextParent).result();
    }
    if (cleared) {
      await expect(fork()).rejects.toThrow("requires a parent turn");
      expect(payloads).toHaveLength(2);
    } else {
      await expect(fork()).resolves.toBe("Answer");
      expect(JSON.stringify(payloads.at(-1)?.input)).toContain("Next parent request");
    }
  },
);

it("preserves the committed prefix when replacement option copying fails", async () => {
  const { parent, payloads } = parentTransport();
  await complete(parent);
  const copy = vi
    .spyOn(Blob.prototype, "arrayBuffer")
    .mockRejectedValueOnce(new Error("Blob source is unavailable"));
  await complete(
    parent,
    model,
    { messages: [{ role: "user", content: "Replacement prefix", timestamp: 3 }] },
    { metadata: { blob: new Blob(["Options"], { type: "application/x-unreadable" }) } },
  );
  copy.mockRestore();
  await expect(fork()).resolves.toBe("Answer");
  expectText(JSON.stringify(payloads.at(-1)?.input), ["Parent question"], ["Replacement prefix"]);
});

it("keeps fork snapshots without retaining completed parent contexts or payload hooks", async () => {
  const callers = new AsyncLocalStorage<object>();
  const references: WeakRef<object>[] = [];
  const payloads: Record<string, unknown>[] = [];

  async function completeParent() {
    const caller = { turn: "completed" };
    const parentContext = structuredClone(context);
    const thinkingBudgets = { high: 4096 };
    const hostedTools = new Set(["web_search"]);
    const onPayload = (payload: unknown) => {
      expect(callers.getStore()).toBe(caller);
      return payload;
    };
    references.push(
      new WeakRef(caller),
      new WeakRef(parentContext),
      new WeakRef(onPayload),
      new WeakRef(thinkingBudgets),
      new WeakRef(hostedTools),
    );
    const parent = wrapStreamFnWithSessionFork(transport(payloads), identity);
    await callers.run(caller, async () => {
      const options = {
        onPayload,
        thinkingBudgets,
        openclawCodeModeAllowedHostedToolTypes: hostedTools,
      };
      await complete(parent, model, parentContext, options);
      publishedResult("lookup", "lookup", "Result", { blob: new Blob(["Opaque result"]) });
    });
  }

  try {
    await completeParent();
    await expectCollected(references);
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
    const completed = await complete(parent, model, context, sseOptions);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    const parentContext = history(
      { ...completed, stopReason: "toolUse", content: [toolCall("completed", "lookup")] },
      toolResult(
        "completed",
        "lookup",
        "Tool answer",
        kind === "bigint" ? { value: 1n } : cyclic,
        2,
      ),
    );
    const onPayload = vi.fn();
    const forkSent = createDeferredCore();
    const releaseFork = createDeferredCore();
    physicalFetch.mockImplementationOnce(async () => {
      forkSent.resolve();
      await releaseFork.promise;
      return wireResponse();
    });
    const runningFork = expect(fork()).resolves.toBe("Answer");
    try {
      await forkSent.promise;
      const assistant = await complete(parent, model, parentContext, {
        ...sseOptions,
        onPayload,
      });
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
    const { parent, request } = guardedTransport(undefined, api);
    const requestModel = apiModel(api);
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
    const assistant = await complete(parent, requestModel, parentContext, sseOptions);
    const publication = {
      ...assistant,
      content: [{ type: "text" as const, text: "Published answer" }],
    };
    publish(publication);
    publication.content[0]!.text = "Changed after publication";

    for (let index = 0; index < 2; index++) {
      await expect(fork(requestModel)).resolves.toBe("Answer");
      const body = await request(index + 1).text();
      expectText(body, ["Frozen question", "Published answer"], ["Changed after publication"]);
    }
    expect(parentContext.messages).toHaveLength(1);
    expect(parentContext.messages[0]!.content).toEqual([{ type: "text", text: "Frozen question" }]);
  },
);

it("preserves opaque publication details across isolated forks", async () => {
  const values: { byte: number; blob: string | undefined }[] = [];
  const replay = transport([]);
  const parent = wrapStreamFnWithSessionFork(async (requestModel, requestContext, options) => {
    const details = requestContext.messages.find(
      (message) => message.role === "toolResult",
    )?.details;
    if (isRecord(details) && details.bytes instanceof Uint8Array) {
      values.push({
        byte: details.bytes[0]!,
        blob: details.blob instanceof Blob ? await details.blob.text() : undefined,
      });
      new Uint8Array(details.bytes.buffer).fill(99);
    }
    return replay(requestModel, requestContext, options);
  }, identity);
  await complete(parent);
  const bytes = new Uint8Array([7]);
  publishedResult("lookup", "lookup", "Result", {
    bytes,
    blob: new Blob(["discard|Opaque result|discard"]).slice(8, 21),
  });
  bytes[0] = 42;
  await expect(fork()).resolves.toBe("Answer");
  await expect(fork()).resolves.toBe("Answer");
  expect(values).toEqual([
    { byte: 7, blob: "Opaque result" },
    { byte: 7, blob: "Opaque result" },
  ]);
});

it.each(["entry overhead", "opaque publications"] as const)(
  "bounds retained snapshots including %s within 64 MiB",
  async (kind) => {
    const count = kind === "entry overhead" ? 64 : 3;
    const payload = "x".repeat(kind === "entry overhead" ? 1024 * 1024 - 1024 : 1);
    const ids = Array.from({ length: count }, (_, index) => ({
      ...identity,
      sessionId: `budget-${index}`,
    }));
    // The transport discards requests; only the production snapshot owner retains them.
    const stream: StreamFn = async (requestModel, requestContext, options) => {
      await options?.onPayload?.({ input: requestContext.messages }, requestModel);
      const result = createAssistantMessageEventStream();
      result.end(makeAgentAssistantMessage({ content: [{ type: "text", text: "Answer" }] }));
      return result;
    };
    for (const id of ids) {
      await complete(wrapStreamFnWithSessionFork(stream, id), model, {
        messages: [{ role: "user", content: payload, timestamp: 1 }],
      });
      if (kind === "opaque publications") {
        recordEmbeddedSessionForkMessage(
          id.sessionId,
          id.runId,
          toolResult("lookup", "lookup", "Result", {
            blob: new Blob([new Uint8Array(22 * 1024 * 1024)]),
          }),
        );
      }
    }
    const review = (sessionId: string) =>
      runEmbeddedSessionFork({
        ...identity,
        sessionId,
        model,
        question: "Review only",
        assertCurrent() {},
      });
    await expect(review(ids[0]!.sessionId)).rejects.toThrow("requires a parent turn");
    await expect(review(ids.at(-1)!.sessionId)).resolves.toBe("Answer");
  },
);

it.each([
  ["openai-responses", false],
  ["openai-responses", true],
  ["anthropic-messages", false],
  ["anthropic-messages", true],
] as const)("represents an in-flight %s tool call as pending (async=%s)", async (api, async) => {
  const { parent, request } = guardedTransport(undefined, api);
  const requestModel = apiModel(api);
  const assistant = await complete(parent, requestModel, context, sseOptions);
  publish({
    ...assistant,
    stopReason: "toolUse",
    content: [
      toolCall("pending_call", "exec", { command: "echo 3; sleep 10" }, async || undefined),
    ],
  });
  await expect(fork(requestModel)).resolves.toBe("Answer");
  const pendingBody = await request(1).text();
  expectText(
    pendingBody,
    ["pending_call", "still running", "result is not available yet"],
    ["aborted", '"is_error":true'],
  );

  publishedResult("pending_call", "exec", "3");
  await expect(fork(requestModel)).resolves.toBe("Answer");
  const completedBody = await request(2).text();
  expectText(
    completedBody,
    [api === "anthropic-messages" ? '"content":"3"' : '"output":"3"'],
    ["still running", "aborted"],
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
    const { parent, request } = guardedTransport(undefined, api);
    const requestModel = {
      ...model,
      api,
      provider,
    };
    const replayContext: Context = {
      ...context,
      tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object" } }],
    };
    const completed = await complete(parent, requestModel, replayContext, {
      apiKey: "synthetic-key",
    });
    await complete(
      parent,
      requestModel,
      {
        ...history({
          ...completed,
          ...(api !== "openai-responses"
            ? { provider: "prior-provider", model: "prior-model" }
            : {}),
          content: [
            { type: "text", text: "Starting lookup" },
            toolCall(sourceId, "lookup", {}, true),
          ],
        }),
        tools: replayContext.tools,
      },
      { apiKey: "synthetic-key" },
    );
    publishedResult(sourceId, "lookup", "LATE_RESULT_1119");
    await expect(fork(requestModel)).resolves.toBe("Answer");
    const body = await request().text();
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
  await complete(parent, model, context, sseOptions);
  physicalFetch.mockClear();
  withdrawDuringDns = true;
  await expect(
    fork(model, () => {
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
          response.end(responseBody);
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
  await complete(parent, requestModel, context, sseOptions);
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
  await expect(fork(currentModel)).resolves.toBe("Answer");
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
  const { parent, request } = guardedTransport(undefined, "anthropic-messages");
  const requestModel = apiModel("anthropic-messages");
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
  expect((await complete(parent, requestModel, context, options)).stopReason).toBe("stop");
  const readPayload = async (index: number) => {
    const payload: unknown = await request(index).json();
    if (!isRecord(payload)) {
      throw new Error("Expected provider request");
    }
    return payload;
  };
  const original = await readPayload(0);
  await expect(fork(requestModel)).resolves.toBe("Answer");
  const replay = await readPayload(1);
  if (!Array.isArray(original.messages) || !Array.isArray(replay.messages)) {
    throw new Error("Expected Anthropic messages");
  }
  expect(replay).toEqual(
    expect.objectContaining({
      tool_choice: { type: "none" },
      tools: [hostedTool],
      system: original.system,
    }),
  );
  expect(replay.messages.slice(0, original.messages.length)).toEqual(original.messages);
  expect(replay.messages).toHaveLength(original.messages.length + 1);
});

it("retains the full parent prefix when HTTP continuation sends only a suffix", async () => {
  const { parent, request } = guardedTransport();
  const requestModel: Model = { ...model, compat: { supportsResponsesContinuation: true } };
  let prepared: Record<string, unknown> = {};
  const options = {
    ...sseOptions,
    sessionId: identity.sessionId,
    onPayload: (payload: unknown) => {
      if (!isRecord(payload)) {
        throw new Error("Expected request");
      }
      prepared = { ...payload, store: true };
      return prepared;
    },
  };
  const completed = await complete(parent, requestModel, context, options);
  const stringify = JSON.stringify;
  let fullHistoryEncodings = 0;
  const spy = vi.spyOn(JSON, "stringify").mockImplementation((value, ...args) => {
    const json = stringify(value, ...args);
    if (json?.includes("Parent question")) {
      fullHistoryEncodings++;
    }
    return json;
  });
  await complete(
    parent,
    requestModel,
    history(completed, { role: "user", content: "Continue parent", timestamp: 3 }),
    options,
  );
  spy.mockRestore();
  expect(fullHistoryEncodings).toBe(2);
  const continuationBody = await request(1).text();
  const continuation = JSON.parse(continuationBody);
  expect(continuationBody).toBe(
    JSON.stringify({
      ...prepared,
      input: Array.isArray(prepared.input) ? prepared.input.slice(-1) : [],
      previous_response_id: "resp_fork",
    }),
  );
  expect(continuation.previous_response_id).toBe("resp_fork");
  expect(JSON.stringify(continuation.input)).not.toContain("Parent question");
  await expect(fork(requestModel)).resolves.toBe("Answer");
  const replayBody = await request().text();
  const replay = JSON.parse(replayBody);
  expect(replayBody).toBe(
    JSON.stringify({
      ...prepared,
      input: [...(Array.isArray(prepared.input) ? prepared.input : []), replay.input.at(-1)],
    }),
  );
  expect(replay.previous_response_id).toBeUndefined();
  expectText(JSON.stringify(replay.input), ["Parent question", "Continue parent", "Review only"]);
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
  const { payloads, parent } = parentTransport();
  const message = await complete(parent);
  cleanupSessionResources(identity.sessionId);
  publish(message);
  await expect(fork()).rejects.toThrow("requires a parent turn");
  expect(payloads).toHaveLength(1);
});

it.each([{ callback: () => {} }, { bytes: new Uint8Array(new SharedArrayBuffer(16)) }])(
  "retires optional replay if a published message cannot be retained: %j",
  async (details) => {
    const { parent } = parentTransport();
    await complete(parent);
    expect(() =>
      publish({ ...toolResult("lookup", "lookup", "", details, 2), content: [] }),
    ).not.toThrow();
    await expect(fork()).rejects.toThrow("requires a parent turn");
  },
);

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
  await complete(
    parent,
    model,
    { ...context, tools, messages: [{ role: "user", content: parentText, timestamp: 1 }] },
    { ...codeModeOptions, apiKey: "synthetic-key", onPayload },
  );
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
    expect(body).toEqual(expect.objectContaining({ tools: bodies[0].tools, tool_choice: "none" }));
  }
});
