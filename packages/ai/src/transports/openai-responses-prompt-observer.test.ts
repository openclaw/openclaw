import type { AssistantMessage, Context, Model } from "@openclaw/llm-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { responsesPromptObserver, type ResponsesPromptObservation } from "../internal/openai.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
  streamSimpleOpenAICodexResponses,
} from "../providers/openai-chatgpt-responses.js";
import {
  createJwt,
  emitWebSocket,
  installWebSocket,
} from "../providers/openai-chatgpt-responses.test-helpers.js";
import { streamOpenAIResponses } from "../providers/openai-responses.js";
import { cleanupSessionResources } from "../session-resources.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";
import { resolveResponsesContextUsageBoundary } from "./openai-responses-context-usage.js";
import * as fixtures from "./openai-responses-prompt-observer.test-support.js";
import type { SdkResponse } from "./openai-responses-sdk.test-support.js";

const sdkState = vi.hoisted(() => ({
  outcomes: [] as Array<Error | SdkResponse>,
  order: [] as string[],
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", async () => {
  const { createResponsesSdkMock } = await import("./openai-responses-sdk.test-support.js");
  return createResponsesSdkMock(sdkState, {
    unexpectedRequest: "stop after request",
    onCreate: (client) => {
      sdkState.order.push(`${client}.create`);
    },
  });
});

import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-client.js";
import { collectEventTypes } from "./openai-stream-cases.test-support.js";

const initialHost = getAiTransportHost();
const { SDK_FULL_HISTORY_PREFIX: fullHistory, SDK_REASONING_CIPHERTEXT: reasoningCiphertext } =
  fixtures;
const requestInput = (index: number) => JSON.stringify(sdkState.requests[index]?.input);
const nativeModel = () =>
  fixtures.createModel({
    api: "openai-chatgpt-responses",
    baseUrl: "https://chatgpt.test/backend-api",
  });
const invalidEncryptedContent = () =>
  Object.assign(new Error("invalid encrypted content"), { code: "invalid_encrypted_content" });
const identity = { sessionId: "observer-session", authProfileId: "observer-profile" };
const sdkOptions = { apiKey: "test-key", ...identity };
function compactionCase() {
  const model = fixtures.createModel();
  return { model, context: fixtures.createCompactionContext(model, identity) };
}
const runManaged = (
  model: Model,
  context: Context,
  options: Record<string, unknown>,
  azure = false,
) =>
  (azure
    ? createAzureOpenAIResponsesTransportStreamFn()
    : createOpenAIResponsesTransportStreamFn())(model, context, options as never);
const managedResult = async (
  model: Model,
  context: Context,
  options: Record<string, unknown>,
  azure = false,
) => {
  const result = await (await runManaged(model, context, options, azure)).result();
  expect(result.stopReason).toBe("stop");
  return result;
};
function usageBoundary(
  context: Context,
  result: AssistantMessage,
  model: Model,
  persisted = false,
) {
  const messages = [...context.messages, result];
  const saved = persisted ? JSON.stringify(messages) : undefined;
  return resolveResponsesContextUsageBoundary(
    saved === undefined ? messages : JSON.parse(saved),
    model,
    identity,
    context.systemPrompt,
  );
}
function observe(options: object, order?: string[], includeEgress = false) {
  const observations: ResponsesPromptObservation[] = [];
  responsesPromptObserver.set(options, (observation) => {
    order?.push(includeEgress ? `observe:${observation.egress}` : "observe");
    observations.push(observation);
  });
  return observations;
}
function expectObservations(
  observations: ResponsesPromptObservation[],
  egress: string,
  prompt: string,
  count = 1,
) {
  expect(observations).toEqual(
    Array.from({ length: count }, () => ({
      egress,
      payloadVariant: "initial",
      promptSource: "instructions",
      expectedChars: prompt.length,
      observedChars: prompt.length,
      matchesAssembledPrompt: true,
    })),
  );
  expect(JSON.stringify(observations)).not.toContain(prompt);
}

const expectedBoundary = (context: Context, totalTokens = 8) => ({
  index: context.messages.length,
  totalTokens,
  suffix: [],
});
function mockSse(order?: string[], onRequest?: (request: Record<string, unknown>) => void) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input, init) => {
      order?.push("fetch");
      if (onRequest) {
        onRequest(await fixtures.requestBody(init));
      }
      return fixtures.sseResponse([
        fixtures.completedResponse("resp_test", [], { usage: fixtures.responseUsage }),
      ]);
    }),
  );
}

function requestHasCompaction(request: Record<string, unknown> | undefined): boolean {
  return Array.isArray(request?.input) && request.input.some((item) => item?.type === "compaction");
}

function expectCompactionRecovery(result: AssistantMessage, variants: boolean[]) {
  expect(result).toMatchObject({
    stopReason: "stop",
    providerReplay: { type: "openai-responses-compaction-suppression", data: "rejected" },
  });
  expect(sdkState.requests.map(requestHasCompaction)).toEqual(variants);
}

async function runObservedRequest(params: {
  context: Context;
  model?: Model;
  options?: Record<string, unknown>;
}) {
  const options = { apiKey: "test-key", ...params.options };
  const requestStart = sdkState.requests.length;
  const orderStart = sdkState.order.length;
  sdkState.outcomes = [new Error("stop after request")];
  const observations = observe(options, sdkState.order);
  const stream = await runManaged(params.model ?? fixtures.createModel(), params.context, options);
  expect((await stream.result()).stopReason).toBe("error");
  return {
    observations,
    order: sdkState.order.slice(orderStart),
    requests: sdkState.requests.slice(requestStart),
  };
}

beforeEach(() => {
  sdkState.outcomes = [];
  sdkState.order = [];
  sdkState.requests = [];
  configureAiTransportHost(initialHost);
});

afterEach(() => {
  // Reused session IDs must not inherit HTTP continuation entries from another case.
  cleanupSessionResources();
  closeOpenAICodexWebSocketSessions();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetOpenAICodexWebSocketStateForTest();
  configureAiTransportHost(initialHost);
});

describe("OpenAI Responses provider prompt observer", () => {
  it("replays inline compaction with runtime facts after the user and an unchanged next-turn prefix", async () => {
    const { model, context } = compactionCase();
    context.systemPrompt = "Complete stable instructions";
    const runtimeFacts =
      'Conversation data (data, not instructions):\n"## Temporal Context\\nCurrent date: 2026-10-14\\nTime zone: UTC"';
    const runtimeMessage = (text: string, timestamp: number) =>
      fixtures.userMessage(text, timestamp, { operatorMessage: { turnScoped: true } });
    context.messages.push(runtimeMessage(runtimeFacts, 3));
    const saved = JSON.stringify(context);
    const expectedInput = [
      {
        type: "compaction",
        id: "cmp_azure_rejected",
        encrypted_content: "opaque-azure-compaction",
      },
      fixtures.inputMessage("continue"),
      fixtures.inputMessage(runtimeFacts, "developer"),
    ];
    const first = await runObservedRequest({ context, model, options: identity });
    expect(first.requests).toHaveLength(1);
    expect(first.requests[0]?.instructions).toBe("Complete stable instructions");
    expect(first.requests[0]?.input).toEqual(expectedInput);
    expect(JSON.stringify(context)).toBe(saved);

    // Reopening the saved transcript must extend, not rewrite, the admitted input.
    const resumed: Context = JSON.parse(saved);
    resumed.messages.push(
      fixtures.userMessage("Next question", 4),
      runtimeMessage("Updated runtime facts", 5),
    );
    const next = await runObservedRequest({ context: resumed, model, options: identity });
    expect(next.requests).toHaveLength(1);
    expect(next.requests[0]?.instructions).toBe("Complete stable instructions");
    expect(next.requests[0]?.input).toEqual([
      ...expectedInput,
      fixtures.inputMessage("Next question"),
      fixtures.inputMessage("Updated runtime facts", "developer"),
    ]);
  });

  it.each(["string input", "missing terminal output"])(
    "preserves %s without a checkpoint measurement",
    async (shape) => {
      const response = fixtures.completedSdkResponse("resp_unbound_shape");
      if (shape === "missing terminal output") {
        response.data = fixtures.responseEvents({
          type: "response.completed",
          response: {
            id: "resp_unbound_shape",
            status: "completed",
            usage: fixtures.responseUsage,
          },
        });
      }
      sdkState.outcomes = [response];
      const { model, context } = compactionCase();
      const result = await managedResult(model, context, {
        ...sdkOptions,
        transport: "sse",
        onPayload:
          shape === "string input"
            ? () => ({ model: model.id, input: "hello", stream: true })
            : undefined,
      });
      if (shape === "string input") {
        expect(sdkState.requests[0]?.input).toBe("hello");
      }
      expect(result.errorMessage).toBeUndefined();
      expect(result).not.toHaveProperty("openclawResponsesInputReplay.contextUsage");
    },
  );

  it.each(["shared", "chatgpt"] as const)(
    "preserves measured checkpoint usage through %s egress and saved-history replay",
    async (transport) => {
      const model = transport === "chatgpt" ? nativeModel() : fixtures.createModel();
      const context = fixtures.createOrphanedToolOutputCompactionContext(model, identity);
      const toolOutput = context.messages.find((message) => message.role === "toolResult");
      if (!toolOutput || toolOutput.role !== "toolResult") {
        throw new Error("missing tool-output fixture");
      }
      toolOutput.content = [{ type: "text", text: "large historical tool output\n".repeat(8_000) }];
      context.messages.push(
        fixtures.userMessage("OpenClaw runtime context:\ncurrent runtime facts", 2, {
          runtimeContext: {},
        }),
      );
      const run = async (rewriteInput: boolean) => {
        sdkState.outcomes = [fixtures.completedSdkResponse(`resp_usage_${transport}`)];
        mockSse();
        const options = {
          ...identity,
          apiKey: transport === "chatgpt" ? createJwt() : "test-key",
          transport: "sse" as const,
          onPayload: rewriteInput
            ? (payload: unknown) => {
                const request = payload as Record<string, unknown>;
                return {
                  ...request,
                  input: [
                    ...(request.input as unknown[]),
                    {
                      role: "user",
                      content: "hook-only history that is absent from the transcript",
                    },
                  ],
                };
              }
            : undefined,
        };
        const result = await (
          transport === "chatgpt"
            ? streamOpenAICodexResponses(
                { ...model, api: "openai-chatgpt-responses", compat: undefined },
                context,
                options,
              )
            : streamOpenAIResponses({ ...model, api: "openai-responses" }, context, options)
        ).result();
        expect(result.stopReason).toBe("stop");
        expect(result.usage.contextUsage).toEqual({
          state: "available",
          promptTokens: 5,
          totalTokens: 8,
        });
        return {
          result,
          boundary: usageBoundary(context, result, model, true),
        };
      };

      const measured = await run(false);
      expect(measured.result).toMatchObject({
        openclawResponsesInputReplay: { contextUsage: { totalTokens: 8 } },
      });
      expect(measured.boundary).toEqual(expectedBoundary(context));

      const rewritten = await run(true);
      expect(rewritten.boundary).toBeUndefined();
    },
  );

  it("binds measured usage to terminal reasoning when its ciphertext changes", async () => {
    const { model, context } = compactionCase();
    const reasoning = {
      type: "reasoning",
      id: "rs_streamed",
      content: [],
      summary: [],
      encrypted_content: "opaque-streamed-reasoning",
    };
    sdkState.outcomes.push({
      response: new Response(null, { status: 200 }),
      data: fixtures.responseEvents(
        { type: "response.output_item.added", output_index: 0, item: reasoning },
        { type: "response.output_item.done", output_index: 0, item: reasoning },
        fixtures.completedResponse(
          "resp_streamed_reasoning",
          [{ ...reasoning, encrypted_content: "opaque-terminal-reasoning" }],
          { usage: { input_tokens: 500, output_tokens: 25, total_tokens: 525 } },
        ),
      ),
    });
    const result = await managedResult(model, context, { ...sdkOptions, transport: "sse" });
    expect(result.content[0]).toMatchObject({
      type: "thinking",
      thinkingSignature: expect.stringContaining("opaque-terminal-reasoning"),
    });
    expect(usageBoundary(context, result, model, true)).toEqual(expectedBoundary(context, 525));
  });

  it("recovers Azure compaction rejection and suppresses it on the next turn", async () => {
    const azureModel = fixtures.createModel({
      api: "azure-openai-responses",
      provider: "azure-openai-responses",
      baseUrl: "https://example.openai.azure.com",
    });
    const context = fixtures.createCompactionContext(azureModel, identity);
    const options = { ...sdkOptions };
    const observations = observe(options);
    sdkState.outcomes = [
      invalidEncryptedContent(),
      fixtures.completedSdkResponse("resp_azure_recovered"),
      fixtures.completedSdkResponse("resp_azure_next"),
    ];
    const recovered = await managedResult(azureModel, context, options, true);
    expect(recovered).not.toHaveProperty("openclawResponsesInputReplay.contextUsage");
    await managedResult(
      azureModel,
      {
        ...context,
        messages: [...context.messages, recovered, fixtures.userMessage("continue again", 3)],
      },
      options,
      true,
    );

    expectCompactionRecovery(recovered, [true, false, false]);
    expect(requestInput(0)).not.toContain(fullHistory);
    expect(requestInput(1)).toContain(fullHistory);
    expect(observations.map((entry) => entry.payloadVariant)).toEqual([
      "initial",
      "compaction-stripped",
      "initial",
    ]);
    expect(JSON.stringify(observations)).not.toContain("opaque-azure-compaction");
  });

  it("rebuilds full history when compaction leaves an orphaned function output", async () => {
    const openAIModel = fixtures.createModel();
    const context = fixtures.createOrphanedToolOutputCompactionContext(openAIModel, identity);
    const options = { ...sdkOptions };
    const observations = observe(options);
    sdkState.outcomes = [
      Object.assign(
        new Error("400 No tool call found for function call output with call_id call_compacted."),
        { status: 400, type: "invalid_request_error", param: "input", code: null },
      ),
      fixtures.completedSdkResponse("resp_orphan_recovered"),
    ];

    const recovered = await managedResult(openAIModel, context, options);

    expectCompactionRecovery(recovered, [true, false]);
    expect(requestInput(0)).toContain("function_call_output");
    expect(requestInput(0)).not.toContain('"type":"function_call"');
    expect(requestInput(1)).toContain('"type":"function_call"');
    expect(requestInput(1)).toContain("function_call_output");
    expect(observations.map((entry) => entry.payloadVariant)).toEqual([
      "initial",
      "compaction-stripped",
    ]);
  });

  it("retries encrypted reasoning rejected by the SDK response.failed drain without dropping compaction", async () => {
    const model = fixtures.createModel({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    const context = fixtures.createCompactionContext(model, identity, true);
    const onResponse = vi.fn();
    const options = { apiKey: createJwt(), ...identity, onResponse };
    const observations = observe(options);
    const failureMessage =
      "400 The encrypted content [REDACTED] could not be verified. " +
      "Reason: Encrypted content could not be decrypted or parsed.";
    const failedResponse: SdkResponse = {
      data: fixtures.responseEvents(
        { type: "response.created", response: { id: "resp_rejected" } },
        {
          type: "response.failed",
          response: {
            id: "resp_rejected",
            status: "failed",
            error: { code: null, message: failureMessage },
          },
        },
      ),
      response: new Response(null, {
        status: 200,
        headers: {
          "openai-model": "gpt-5.4-stale-rejected-attempt",
          "x-request-id": "req_rejected",
        },
      }),
    };
    const recoveredResponse = fixtures.completedSdkResponse("resp_recovered");
    recoveredResponse.response = new Response(null, {
      status: 200,
      headers: { "x-request-id": "req_recovered" },
    });
    sdkState.outcomes = [failedResponse, recoveredResponse];

    const stream = await runManaged(model, context, options);
    const eventTypes = await collectEventTypes(stream);
    const result = await stream.result();
    expect(result).toMatchObject({ stopReason: "stop" });
    expect(result.responseModel).toBeUndefined();
    expect(result).not.toHaveProperty("openclawResponsesInputReplay.contextUsage");
    expect(usageBoundary(context, result, model)).toBeUndefined();

    expect(sdkState.requests.map(requestHasCompaction)).toEqual([true, true]);
    expect(requestInput(0)).toContain(reasoningCiphertext);
    expect(requestInput(1)).not.toContain(reasoningCiphertext);
    expect(observations.map((observation) => observation.payloadVariant)).toEqual([
      "initial",
      "reasoning-stripped",
    ]);
    expect(onResponse.mock.calls.map(([response]) => response.headers["x-request-id"])).toEqual([
      "req_rejected",
      "req_recovered",
    ]);
    expect(eventTypes).toEqual(["start", "done"]);
  });

  it("observes the async replacement immediately before final transformed egress", async () => {
    const prompt = "PRIVATE-FINAL-TRANSFORMED-PROMPT";
    const tool = (name: string) => ({
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    });
    configureAiTransportHost({
      ...initialHost,
      plugin: {
        ...initialHost.plugin,
        resolveTransportTurnState: () => ({ metadata: { host: "added" } }),
      },
    });
    const options = {
      openclawCodeModeToolSurface: true,
      openclawCodeModeAllowedHostedToolTypes: new Set(["web_search"]),
      onPayload: async (payload: unknown) => {
        await Promise.resolve();
        const request = payload as { metadata?: Record<string, string> };
        expect(request.metadata).toEqual({ host: "added" });
        return {
          model: "gpt-5.4",
          stream: true,
          metadata: { ...request.metadata, caller: "kept" },
          input: [
            { type: "message", role: "developer", content: prompt },
            {
              type: "message",
              role: "user",
              content: [{ type: "input_image", image_url: "data:image/png;base64,invalid!" }],
            },
          ],
          tools: [
            tool("exec"),
            tool("wait"),
            tool("rogue"),
            { type: "web_search" },
            { type: "file_search" },
          ],
        };
      },
    };
    const run = await runObservedRequest({
      context: fixtures.createContext(prompt, { tools: [tool("exec"), tool("wait")] as never }),
      options,
    });

    expect(run.order).toEqual(["observe", "openai.create"]);
    expect(run.observations[0]?.matchesAssembledPrompt).toBe(true);
    expect(run.requests[0]?.metadata).toEqual({ caller: "kept", host: "added" });
    expect(run.requests[0]?.tools).toEqual([tool("exec"), tool("wait"), { type: "web_search" }]);
    expect(JSON.stringify(run.requests[0]?.input)).toContain("omitted image payload");
  });

  it("uses cache-boundary and surrogate normalization as the expected prompt owner", async () => {
    const systemPrompt = `stable${SYSTEM_PROMPT_CACHE_BOUNDARY}dynamic\ud800`;
    const normalizedPrompt = "stable\ndynamic";
    const run = await runObservedRequest({ context: fixtures.createContext(systemPrompt) });

    expect(run.observations[0]).toMatchObject({
      expectedChars: normalizedPrompt.length,
      observedChars: normalizedPrompt.length,
      matchesAssembledPrompt: true,
    });
    expect(run.requests[0]?.instructions).toBe(normalizedPrompt);
  });

  it("observes each native WebSocket connection-limit dispatch before send", async () => {
    const prompt = "PRIVATE-NATIVE-WEBSOCKET-PROMPT";
    const model = nativeModel();
    const context = { ...fixtures.createCompactionContext(model, identity), systemPrompt: prompt };
    const order: string[] = [];
    const sentRequests: Array<Record<string, unknown>> = [];
    const connections = installWebSocket(
      (socket, payload) => {
        order.push("send");
        sentRequests.push(JSON.parse(payload) as Record<string, unknown>);
        const event =
          socket.connectionId === 1
            ? { type: "error", error: { code: "websocket_connection_limit_reached" } }
            : fixtures.completedResponse("resp_ws", [], { usage: fixtures.responseUsage });
        queueMicrotask(() => emitWebSocket(socket, event));
      },
      true,
      { deferReply: false, trackReadyState: false },
    );
    vi.stubGlobal("fetch", vi.fn());
    const options = { apiKey: createJwt(), transport: "websocket" as const, ...identity };
    const observations = observe(options, order);

    const result = await streamOpenAICodexResponses(model, context, options).result();

    expect(result.stopReason).toBe("stop");
    expect(usageBoundary(context, result, model)).toEqual(expectedBoundary(context));
    expect(connections.sockets).toHaveLength(2);
    expect(order).toEqual(["observe", "send", "observe", "send"]);
    expect(sentRequests.map((request) => request.instructions)).toEqual([prompt, prompt]);
    expectObservations(observations, "native-codex-websocket", prompt, 2);
  });

  it.each(["before", "after"])(
    "forwards simple-option observation through async payload replacement and fallback %s send",
    async (phase) => {
      const prompt = `PRIVATE-${phase}-SEND-FALLBACK-PROMPT`;
      const order: string[] = [];
      if (phase === "before") {
        vi.stubGlobal("WebSocket", function FailingWebSocket() {
          throw new Error("websocket connect failed");
        });
      } else {
        installWebSocket(
          (socket) => {
            order.push("send");
            queueMicrotask(() =>
              socket.dispatchEvent(
                Object.assign(new Event("error"), { message: "connection dropped after send" }),
              ),
            );
          },
          true,
          { deferReply: false, trackReadyState: false },
        );
      }
      let sentRequest: Record<string, unknown> | undefined;
      mockSse(order, (request) => {
        sentRequest = request;
      });
      const options = {
        apiKey: createJwt(),
        transport: "auto" as const,
        onPayload: async (body: unknown) => {
          await Promise.resolve();
          return { ...(body as Record<string, unknown>), finalTransform: true };
        },
      };
      const observations = observe(options, order, true);

      const result = await streamSimpleOpenAICodexResponses(
        nativeModel(),
        fixtures.createContext(prompt),
        options,
      ).result();

      expect(result.stopReason).toBe("stop");
      expect(order).toEqual([
        ...(phase === "after" ? ["observe:native-codex-websocket", "send"] : []),
        "observe:native-codex-sse",
        "fetch",
      ]);
      expect(observations.map((entry) => entry.egress)).toEqual([
        ...(phase === "after" ? ["native-codex-websocket"] : []),
        "native-codex-sse",
      ]);
      expect(sentRequest).toMatchObject({ instructions: prompt, finalTransform: true });
      expectObservations(
        observations.filter((entry) => entry.egress === "native-codex-sse"),
        "native-codex-sse",
        prompt,
      );
    },
  );
});
