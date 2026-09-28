import { zstdDecompressSync } from "node:zlib";
import type { Api, Context, Model } from "@openclaw/llm-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost, getAiTransportHost } from "../host.js";
import { responsesPromptObserver, type ResponsesPromptObservation } from "../internal/openai.js";
import { codeModeToolSurfaceObserver } from "../provider-options.js";
import {
  closeOpenAICodexWebSocketSessions,
  resetOpenAICodexWebSocketStateForTest,
  streamOpenAICodexResponses,
  streamSimpleOpenAICodexResponses,
} from "../providers/openai-chatgpt-responses.js";
import { streamOpenAIResponses } from "../providers/openai-responses.js";
import { cleanupSessionResources } from "../session-resources.js";
import { SYSTEM_PROMPT_CACHE_BOUNDARY } from "../utils/system-prompt-cache-boundary.js";
import { resolveResponsesContextUsageBoundary } from "./openai-responses-context-usage.js";
import {
  completedSdkResponse,
  createModel,
  createContext,
  createCompactionContext,
  createOrphanedToolOutputCompactionContext,
  SDK_FULL_HISTORY_PREFIX,
  SDK_REASONING_CIPHERTEXT,
} from "./openai-responses-prompt-observer.test-support.js";

type SdkResponse = { data: AsyncIterable<unknown>; response: Response };

const sdkState = vi.hoisted(() => ({
  clients: [] as Array<"openai" | "azure">,
  outcomes: [] as Array<Error | SdkResponse>,
  order: [] as string[],
  requests: [] as Array<Record<string, unknown>>,
}));

vi.mock("openai", () => {
  const createClient = (client: "openai" | "azure") =>
    class MockOpenAI {
      responses = {
        create: (request: Record<string, unknown>) => {
          sdkState.clients.push(client);
          sdkState.order.push(`${client}.create`);
          sdkState.requests.push(request);
          const outcome = sdkState.outcomes.shift() ?? new Error("stop after request");
          return {
            withResponse: async () => {
              if (outcome instanceof Error) {
                throw outcome;
              }
              return outcome;
            },
          };
        },
      };
    };
  return { default: createClient("openai"), AzureOpenAI: createClient("azure") };
});

import {
  createAzureOpenAIResponsesTransportStreamFn,
  createOpenAIResponsesTransportStreamFn,
} from "./openai-responses-client.js";

const initialHost = getAiTransportHost();

function createJwt(): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-1" },
  })}.signature`;
}

function completedSseResponse(responseId = "resp_test"): Response {
  return new Response(
    `data: ${JSON.stringify({
      type: "response.completed",
      response: {
        id: responseId,
        status: "completed",
        output: [],
        usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
      },
    })}\n\n`,
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

function requestHasCompaction(request: Record<string, unknown> | undefined): boolean {
  return Array.isArray(request?.input) && request.input.some((item) => item?.type === "compaction");
}

async function runObservedRequest(params: {
  context: Context;
  model?: Model;
  azure?: boolean;
  errors?: Error[];
  options?: Record<string, unknown>;
}) {
  const observations: ResponsesPromptObservation[] = [];
  const options = { apiKey: "test-key", ...params.options };
  const requestStart = sdkState.requests.length;
  const orderStart = sdkState.order.length;
  sdkState.outcomes = params.errors ?? [new Error("stop after request")];
  responsesPromptObserver.set(options, (observation) => {
    sdkState.order.push("observe");
    observations.push(observation);
  });
  const streamFn = params.azure
    ? createAzureOpenAIResponsesTransportStreamFn()
    : createOpenAIResponsesTransportStreamFn();
  const stream = await Promise.resolve(
    streamFn(params.model ?? createModel(), params.context, options as never),
  );
  expect((await stream.result()).stopReason).toBe("error");
  return {
    observations,
    order: sdkState.order.slice(orderStart),
    requests: sdkState.requests.slice(requestStart),
  };
}

beforeEach(() => {
  sdkState.clients = [];
  sdkState.outcomes = [];
  sdkState.order = [];
  sdkState.requests = [];
  configureAiTransportHost(initialHost);
});

afterEach(() => {
  // A native OpenAI model here is store:true-eligible for HTTP continuation
  // (see explicitStore in openai-responses-payload-policy.ts), so any test
  // whose transport claims a continuation entry leaves it in the module-level
  // httpContinuationEntries map. it.each cases in this file commonly reuse
  // the same sessionId across iterations, so a stale entry from an earlier
  // iteration would otherwise be claimed by a later, unrelated one.
  cleanupSessionResources();
  closeOpenAICodexWebSocketSessions();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetOpenAICodexWebSocketStateForTest();
  configureAiTransportHost(initialHost);
});

describe("OpenAI Responses provider prompt observer", () => {
  it.each(["string input", "missing terminal output"])(
    "preserves %s without a checkpoint measurement",
    async (shape) => {
      const response = completedSdkResponse("resp_unbound_shape");
      if (shape === "missing terminal output") {
        response.data = (async function* () {
          yield {
            type: "response.completed",
            response: {
              id: "resp_unbound_shape",
              status: "completed",
              usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
            },
          };
        })();
      }
      sdkState.outcomes = [response];
      const model = createModel();
      const identity = { sessionId: "unbound-shape", authProfileId: "profile-a" };
      const stream = await Promise.resolve(
        createOpenAIResponsesTransportStreamFn()(model, createCompactionContext(model, identity), {
          apiKey: "test-key",
          ...identity,
          transport: "sse",
          onPayload:
            shape === "string input"
              ? () => ({ model: model.id, input: "hello", stream: true })
              : undefined,
        }),
      );
      const result = await stream.result();
      if (shape === "string input") {
        expect(sdkState.requests[0]?.input).toBe("hello");
      }
      expect(result.errorMessage).toBeUndefined();
      expect(result.stopReason).toBe("stop");
      expect(result).not.toHaveProperty("openclawResponsesInputReplay.contextUsage");
    },
  );

  it.each(["native", "shared", "chatgpt"] as const)(
    "preserves measured checkpoint usage through %s egress and saved-history replay",
    async (transport) => {
      const identity = { sessionId: `usage-${transport}`, authProfileId: "usage-profile" };
      const model = createModel<Api>(
        transport === "chatgpt"
          ? { api: "openai-chatgpt-responses", baseUrl: "https://chatgpt.test/backend-api" }
          : {},
      );
      const context = createOrphanedToolOutputCompactionContext(model, identity);
      const toolOutput = context.messages.find((message) => message.role === "toolResult");
      if (!toolOutput || toolOutput.role !== "toolResult") {
        throw new Error("missing tool-output fixture");
      }
      toolOutput.content = [{ type: "text", text: "large historical tool output\n".repeat(8_000) }];
      const run = async (rewriteInput: boolean) => {
        sdkState.outcomes = [completedSdkResponse(`resp_usage_${transport}`)];
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => completedSseResponse(`resp_usage_${transport}`)),
        );
        const options = {
          ...identity,
          apiKey: transport === "chatgpt" ? createJwt() : "test-key",
          transport: "sse" as const,
          onPayload: (payload: unknown) => {
            if (!rewriteInput) {
              return payload;
            }
            const request = payload as Record<string, unknown>;
            return {
              ...request,
              input: [
                ...(request.input as unknown[]),
                { role: "user", content: "hook-only history that is absent from the transcript" },
              ],
            };
          },
        };
        const stream =
          transport === "chatgpt"
            ? streamOpenAICodexResponses(
                { ...model, api: "openai-chatgpt-responses", compat: undefined },
                context,
                options,
              )
            : transport === "shared"
              ? streamOpenAIResponses({ ...model, api: "openai-responses" }, context, options)
              : await Promise.resolve(
                  createOpenAIResponsesTransportStreamFn()(model, context, options),
                );
        const result = await stream.result();
        expect(result.stopReason).toBe("stop");
        expect(result.usage.contextUsage).toEqual({
          state: "available",
          promptTokens: 5,
          totalTokens: 8,
        });
        const persisted = JSON.stringify([...context.messages, result]);
        const savedMessages = JSON.parse(persisted) as Context["messages"];
        return {
          result,
          boundary: resolveResponsesContextUsageBoundary(
            savedMessages,
            model,
            identity,
            context.systemPrompt,
          ),
        };
      };

      const measured = await run(false);
      expect(measured.result).toMatchObject({
        openclawResponsesInputReplay: { contextUsage: { totalTokens: 8 } },
      });
      expect(measured.boundary).toEqual({
        index: context.messages.length,
        totalTokens: 8,
        suffix: [],
      });

      const rewritten = await run(true);
      expect(rewritten.boundary).toBeUndefined();
    },
  );

  it("binds measured usage to streamed reasoning when the terminal ciphertext changes", async () => {
    const model = createModel();
    const identity = { sessionId: "reasoning-session", authProfileId: "reasoning-profile" };
    const context = createCompactionContext(model, identity);
    const reasoning = {
      type: "reasoning",
      id: "rs_streamed",
      content: [],
      summary: [],
      encrypted_content: "opaque-streamed-reasoning",
    };
    sdkState.outcomes.push({
      response: new Response(null, { status: 200 }),
      data: (async function* () {
        yield { type: "response.output_item.added", output_index: 0, item: reasoning };
        yield { type: "response.output_item.done", output_index: 0, item: reasoning };
        yield {
          type: "response.completed",
          response: {
            id: "resp_streamed_reasoning",
            status: "completed",
            output: [{ ...reasoning, encrypted_content: "opaque-terminal-reasoning" }],
            usage: { input_tokens: 500, output_tokens: 25, total_tokens: 525 },
          },
        };
      })(),
    });
    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(model, context, {
        apiKey: "test-key",
        ...identity,
        transport: "sse",
      }),
    );
    const result = await stream.result();
    expect(result.content[0]).toMatchObject({
      type: "thinking",
      thinkingSignature: expect.stringContaining("opaque-streamed-reasoning"),
    });
    const persisted = JSON.stringify([...context.messages, result]);
    expect(
      resolveResponsesContextUsageBoundary(
        JSON.parse(persisted),
        model,
        identity,
        context.systemPrompt,
      ),
    ).toEqual({ index: context.messages.length, totalTokens: 525, suffix: [] });
  });

  // createModel() defaults to a verified native OpenAI route (see
  // usesVerifiedInstructionsEndpoint in openai-responses-payload-policy.ts),
  // so this request carries the system prompt via top-level `instructions`
  // rather than an `input.developer`/`input.system` message. That default is
  // route-specific, not universal -- see the Azure test below, which is on
  // an unverified route and falls back to input.developer.
  // The reasoning flag no longer changes promptSource (it used to select
  // between the developer/system input roles); both cases stay in the table
  // to confirm reasoning=true/false doesn't regress instructions delivery.
  it.each([{ reasoning: true }, { reasoning: false }] as const)(
    "observes the final instructions prompt (reasoning=$reasoning)",
    async ({ reasoning }) => {
      const prompt = `PRIVATE-reasoning-${reasoning}-PROMPT`;
      const run = await runObservedRequest({
        context: createContext(prompt),
        model: createModel({ reasoning }),
      });

      expect(run.observations).toEqual([
        {
          egress: "responses-sdk",
          payloadVariant: "initial",
          promptSource: "instructions",
          expectedChars: prompt.length,
          observedChars: prompt.length,
          matchesAssembledPrompt: true,
        },
      ]);
      expect(JSON.stringify(run.observations)).not.toContain(prompt);
    },
  );

  it("observes Azure Responses egress", async () => {
    const prompt = "PRIVATE-AZURE-PROMPT";
    const run = await runObservedRequest({
      azure: true,
      context: createContext(prompt),
      model: createModel({
        api: "azure-openai-responses",
        provider: "azure-openai-responses",
        baseUrl: "https://example.openai.azure.com",
      }),
    });

    expect(sdkState.clients).toEqual(["azure"]);
    expect(run.order).toEqual(["observe", "azure.create"]);
    expect(run.observations[0]).toMatchObject({
      egress: "responses-sdk",
      payloadVariant: "initial",
      // Azure is not a verified instructions-field route (see
      // usesVerifiedInstructionsEndpoint in openai-responses-payload-policy.ts)
      // -- it falls back to embedding the prompt in input, same as any other
      // unverified route.
      promptSource: "input.developer",
      matchesAssembledPrompt: true,
    });
  });

  it("recovers Azure compaction rejection and suppresses it on the next turn", async () => {
    const identity = { sessionId: "azure-recovery-session", authProfileId: "azure-profile" };
    const azureModel = createModel({
      api: "azure-openai-responses",
      provider: "azure-openai-responses",
      baseUrl: "https://example.openai.azure.com",
    });
    const context = createCompactionContext(azureModel, identity);
    const observations: ResponsesPromptObservation[] = [];
    const options = { apiKey: "test-key", ...identity };
    responsesPromptObserver.set(options, (observation) => observations.push(observation));
    sdkState.outcomes = [
      Object.assign(new Error("invalid encrypted content"), {
        code: "invalid_encrypted_content",
      }),
      completedSdkResponse("resp_azure_recovered"),
      completedSdkResponse("resp_azure_next"),
    ];
    const streamFn = createAzureOpenAIResponsesTransportStreamFn();

    const recoveredStream = await Promise.resolve(streamFn(azureModel, context, options as never));
    const recovered = await recoveredStream.result();
    expect(recovered).toMatchObject({
      stopReason: "stop",
      providerReplay: { type: "openai-responses-compaction-suppression", data: "rejected" },
    });
    expect(recovered).not.toHaveProperty("openclawResponsesInputReplay.contextUsage");
    const nextStream = await Promise.resolve(
      streamFn(
        azureModel,
        {
          ...context,
          messages: [
            ...context.messages,
            recovered,
            { role: "user", content: "continue again", timestamp: 3 },
          ],
        },
        options as never,
      ),
    );
    expect((await nextStream.result()).stopReason).toBe("stop");

    expect(sdkState.clients).toEqual(["azure", "azure", "azure"]);
    expect(sdkState.requests).toHaveLength(3);
    expect(requestHasCompaction(sdkState.requests[0])).toBe(true);
    expect(requestHasCompaction(sdkState.requests[1])).toBe(false);
    expect(requestHasCompaction(sdkState.requests[2])).toBe(false);
    expect(JSON.stringify(sdkState.requests[0]?.input)).not.toContain(SDK_FULL_HISTORY_PREFIX);
    expect(JSON.stringify(sdkState.requests[1]?.input)).toContain(SDK_FULL_HISTORY_PREFIX);
    expect(observations.map((entry) => entry.payloadVariant)).toEqual([
      "initial",
      "compaction-stripped",
      "initial",
    ]);
    expect(JSON.stringify(observations)).not.toContain("opaque-azure-compaction");
  });

  it("rebuilds full history when compaction leaves an orphaned function output", async () => {
    const identity = { sessionId: "orphan-recovery-session", authProfileId: "openai-profile" };
    const openAIModel = createModel();
    const context = createOrphanedToolOutputCompactionContext(openAIModel, identity);
    const observations: ResponsesPromptObservation[] = [];
    const options = { apiKey: "test-key", ...identity };
    responsesPromptObserver.set(options, (observation) => observations.push(observation));
    sdkState.outcomes = [
      Object.assign(
        new Error("400 No tool call found for function call output with call_id call_compacted."),
        { status: 400, type: "invalid_request_error", param: "input", code: null },
      ),
      completedSdkResponse("resp_orphan_recovered"),
    ];

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, options as never),
    );
    const recovered = await stream.result();

    expect(recovered).toMatchObject({
      stopReason: "stop",
      providerReplay: { type: "openai-responses-compaction-suppression", data: "rejected" },
    });
    expect(sdkState.requests).toHaveLength(2);
    expect(requestHasCompaction(sdkState.requests[0])).toBe(true);
    expect(JSON.stringify(sdkState.requests[0]?.input)).toContain("function_call_output");
    expect(JSON.stringify(sdkState.requests[0]?.input)).not.toContain('"type":"function_call"');
    expect(requestHasCompaction(sdkState.requests[1])).toBe(false);
    expect(JSON.stringify(sdkState.requests[1]?.input)).toContain('"type":"function_call"');
    expect(JSON.stringify(sdkState.requests[1]?.input)).toContain("function_call_output");
    expect(observations.map((entry) => entry.payloadVariant)).toEqual([
      "initial",
      "compaction-stripped",
    ]);
  });

  it("lazily rebuilds full history after reasoning and compaction rejection", async () => {
    const identity = { sessionId: "sdk-recovery-session", authProfileId: "sdk-profile" };
    const openAIModel = createModel();
    const context = createCompactionContext(openAIModel, identity, true);
    const invalidEncryptedContent = () =>
      Object.assign(new Error("invalid encrypted content"), {
        code: "invalid_encrypted_content",
      });
    const onPayload = vi.fn((request: unknown) => request);
    const onCompactionRejected = vi.fn();
    sdkState.outcomes = [
      invalidEncryptedContent(),
      invalidEncryptedContent(),
      completedSdkResponse("resp_sdk_recovered"),
    ];

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(openAIModel, context, {
        apiKey: "test-key",
        ...identity,
        onCompactionRejected,
        onPayload,
      } as never),
    );
    expect((await stream.result()).stopReason).toBe("stop");

    expect(sdkState.requests).toHaveLength(3);
    expect(requestHasCompaction(sdkState.requests[0])).toBe(true);
    expect(JSON.stringify(sdkState.requests[0]?.input)).toContain(SDK_REASONING_CIPHERTEXT);
    expect(JSON.stringify(sdkState.requests[0]?.input)).not.toContain(SDK_FULL_HISTORY_PREFIX);
    expect(requestHasCompaction(sdkState.requests[1])).toBe(true);
    expect(JSON.stringify(sdkState.requests[1]?.input)).not.toContain(SDK_REASONING_CIPHERTEXT);
    expect(requestHasCompaction(sdkState.requests[2])).toBe(false);
    expect(JSON.stringify(sdkState.requests[2]?.input)).toContain(SDK_FULL_HISTORY_PREFIX);
    expect(JSON.stringify(sdkState.requests[2]?.input)).not.toContain(SDK_REASONING_CIPHERTEXT);
    expect(onPayload).toHaveBeenCalledTimes(2);
    expect(onCompactionRejected).toHaveBeenCalledOnce();
  });

  it.each(["iterator", "response.failed"] as const)(
    "retries encrypted reasoning rejected by the SDK %s drain without dropping compaction",
    async (failureShape) => {
      const identity = { sessionId: "sdk-drain-session", authProfileId: "sdk-drain-profile" };
      const model = createModel({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      });
      const context = createCompactionContext(model, identity, true);
      const onResponse = vi.fn();
      const options = { apiKey: createJwt(), ...identity, onResponse };
      const observations: ResponsesPromptObservation[] = [];
      responsesPromptObserver.set(options, (observation) => observations.push(observation));
      const failureMessage =
        "400 The encrypted content [REDACTED] could not be verified. " +
        "Reason: Encrypted content could not be decrypted or parsed.";
      const failedResponse: SdkResponse = {
        data: (async function* () {
          yield { type: "response.created", response: { id: "resp_rejected" } };
          if (failureShape === "iterator") {
            throw new Error(failureMessage);
          }
          yield {
            type: "response.failed",
            response: {
              id: "resp_rejected",
              status: "failed",
              error: { code: null, message: failureMessage },
            },
          };
        })(),
        response: new Response(null, {
          status: 200,
          headers: {
            "openai-model": "gpt-5.4-stale-rejected-attempt",
            "x-request-id": "req_rejected",
          },
        }),
      };
      const recoveredResponse = completedSdkResponse("resp_recovered");
      recoveredResponse.response = new Response(null, {
        status: 200,
        headers: { "x-request-id": "req_recovered" },
      });
      sdkState.outcomes = [failedResponse, recoveredResponse];

      const stream = await Promise.resolve(
        createOpenAIResponsesTransportStreamFn()(model, context, options as never),
      );
      const eventTypes: string[] = [];
      for await (const event of stream) {
        eventTypes.push(event.type);
      }
      const result = await stream.result();
      expect(result).toMatchObject({ stopReason: "stop" });
      expect(result.responseModel).toBeUndefined();
      expect(result).not.toHaveProperty("openclawResponsesInputReplay.contextUsage");
      expect(
        resolveResponsesContextUsageBoundary(
          [...context.messages, result],
          model,
          identity,
          context.systemPrompt,
        ),
      ).toBeUndefined();

      expect(sdkState.requests).toHaveLength(2);
      expect(requestHasCompaction(sdkState.requests[0])).toBe(true);
      expect(requestHasCompaction(sdkState.requests[1])).toBe(true);
      expect(JSON.stringify(sdkState.requests[0]?.input)).toContain(SDK_REASONING_CIPHERTEXT);
      expect(JSON.stringify(sdkState.requests[1]?.input)).not.toContain(SDK_REASONING_CIPHERTEXT);
      expect(observations.map((observation) => observation.payloadVariant)).toEqual([
        "initial",
        "reasoning-stripped",
      ]);
      expect(onResponse.mock.calls.map(([response]) => response.headers["x-request-id"])).toEqual([
        "req_rejected",
        "req_recovered",
      ]);
      expect(eventTypes).toEqual(["start", "done"]);
    },
  );

  it("does not invoke the provider or retry when prompt observation throws", async () => {
    const options = { apiKey: "test-key" };
    responsesPromptObserver.set(options, () => {
      throw Object.assign(new Error("observer failed"), {
        code: "invalid_encrypted_content",
      });
    });
    sdkState.outcomes = [completedSdkResponse("resp_unexpected")];

    const stream = await Promise.resolve(
      createOpenAIResponsesTransportStreamFn()(
        createModel(),
        createContext("PRIVATE-OBSERVER-FAILURE-PROMPT"),
        options as never,
      ),
    );
    expect(await stream.result()).toMatchObject({
      stopReason: "error",
      errorMessage: "observer failed",
    });
    expect(sdkState.clients).toEqual([]);
    expect(sdkState.requests).toEqual([]);
  });

  it("observes the async replacement immediately before final transformed egress", async () => {
    const prompt = "PRIVATE-FINAL-TRANSFORMED-PROMPT";
    const toolSurfaceObserver = vi.fn();
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
    codeModeToolSurfaceObserver.set(options, toolSurfaceObserver);
    const run = await runObservedRequest({
      context: createContext(prompt, { tools: [tool("exec"), tool("wait")] as never }),
      options,
    });

    expect(run.order).toEqual(["observe", "openai.create"]);
    expect(run.observations[0]?.matchesAssembledPrompt).toBe(true);
    expect(run.requests[0]?.metadata).toEqual({ caller: "kept", host: "added" });
    expect(run.requests[0]?.tools).toEqual([tool("exec"), tool("wait"), { type: "web_search" }]);
    expect(toolSurfaceObserver).toHaveBeenCalledOnce();
    expect(toolSurfaceObserver).toHaveBeenCalledWith({
      beforeToolIdentities: [
        "client:exec",
        "client:wait",
        "client:rogue",
        "hosted:web_search",
        "hosted:file_search",
      ],
      afterToolIdentities: ["client:exec", "client:wait", "hosted:web_search"],
    });
    expect(JSON.stringify(run.requests[0]?.input)).toContain("omitted image payload");
  });

  it.each([
    { azure: false, remove: false },
    { azure: true, remove: false },
    { azure: false, remove: true },
    { azure: true, remove: true },
  ])(
    "honors the payload hook's metadata choice (azure=$azure, remove=$remove)",
    async ({ azure, remove }) => {
      configureAiTransportHost({
        ...initialHost,
        plugin: {
          ...initialHost.plugin,
          resolveTransportTurnState: () => ({ metadata: { host: "added" } }),
        },
      });
      const run = await runObservedRequest({
        azure,
        context: createContext("prompt"),
        options: {
          onPayload: (payload: unknown) => {
            const request = payload as Record<string, unknown>;
            expect(request.metadata).toEqual({ host: "added" });
            if (remove) {
              delete request.metadata;
            }
            return request;
          },
        },
      });
      expect(run.requests).toHaveLength(1);
      if (remove) {
        expect(run.requests[0]).not.toHaveProperty("metadata");
      } else {
        expect(run.requests[0]?.metadata).toEqual({ host: "added" });
      }
    },
  );

  it("observes each staged encrypted-content recovery attempt", async () => {
    const prompt = "PRIVATE-REPLAY-PROMPT";
    const invalidEncryptedContent = Object.assign(new Error("invalid encrypted content"), {
      code: "invalid_encrypted_content",
    });
    const onPayload = vi.fn((request: Record<string, unknown>) => ({
      ...request,
      input: [
        ...((request.input as unknown[]) ?? []),
        { type: "reasoning", encrypted_content: "opaque", summary: [] },
        {
          type: "compaction",
          id: "cmp_invalid",
          encrypted_content: "opaque-compaction",
        },
      ],
    }));
    const run = await runObservedRequest({
      context: createContext(prompt),
      errors: [invalidEncryptedContent, invalidEncryptedContent, new Error("stop after retry")],
      options: { onPayload },
    });

    expect(run.order).toEqual([
      "observe",
      "openai.create",
      "observe",
      "openai.create",
      "observe",
      "openai.create",
    ]);
    expect(run.observations.map((entry) => entry.payloadVariant)).toEqual([
      "initial",
      "reasoning-stripped",
      "compaction-stripped",
    ]);
    expect(run.observations.every((entry) => entry.egress === "responses-sdk")).toBe(true);
    expect(run.observations.every((entry) => entry.matchesAssembledPrompt)).toBe(true);
    expect(JSON.stringify(run.requests[0])).toContain("encrypted_content");
    expect(JSON.stringify(run.requests[1])).toContain("opaque-compaction");
    expect(JSON.stringify(run.requests[1])).not.toContain('"opaque"');
    expect(
      ((run.requests[1]?.input as Array<{ type?: string }> | undefined) ?? []).some(
        (item) => item.type === "compaction",
      ),
    ).toBe(true);
    expect(JSON.stringify(run.requests[2])).not.toContain("encrypted_content");
    expect(
      ((run.requests[2]?.input as Array<{ type?: string }> | undefined) ?? []).some(
        (item) => item.type === "compaction",
      ),
    ).toBe(false);
    expect(onPayload).toHaveBeenCalledTimes(2);
  });

  it("uses cache-boundary and surrogate normalization as the expected prompt owner", async () => {
    const systemPrompt = `stable${SYSTEM_PROMPT_CACHE_BOUNDARY}dynamic\ud800`;
    const normalizedPrompt = "stable\ndynamic";
    const run = await runObservedRequest({ context: createContext(systemPrompt) });

    expect(run.observations[0]).toMatchObject({
      expectedChars: normalizedPrompt.length,
      observedChars: normalizedPrompt.length,
      matchesAssembledPrompt: true,
    });
    const request = run.requests[0];
    if (!request) {
      throw new Error("missing captured request");
    }
    expect(request.instructions).toBe(normalizedPrompt);
  });

  it("reports missing and same-length mutated prompts without retaining content", async () => {
    const missingPrompt = "PRIVATE-MISSING-PROMPT";
    const missing = await runObservedRequest({
      context: createContext(missingPrompt),
      options: {
        onPayload: () => ({
          model: "gpt-5.4",
          stream: true,
          input: [{ type: "message", role: "user", content: "hello" }],
        }),
      },
    });
    const mismatch = await runObservedRequest({
      context: createContext("trusted"),
      options: {
        onPayload: () => ({
          model: "gpt-5.4",
          stream: true,
          input: [{ type: "message", role: "developer", content: "altered" }],
        }),
      },
    });

    expect(missing.observations[0]).toMatchObject({
      promptSource: "missing",
      observedChars: 0,
      matchesAssembledPrompt: false,
    });
    expect(mismatch.observations[0]).toMatchObject({
      promptSource: "input.developer",
      expectedChars: 7,
      observedChars: 7,
      matchesAssembledPrompt: false,
    });
    expect(JSON.stringify([...missing.observations, ...mismatch.observations])).not.toContain(
      missingPrompt,
    );
  });

  it("observes each native WebSocket connection-limit dispatch before send", async () => {
    const prompt = "PRIVATE-NATIVE-WEBSOCKET-PROMPT";
    const identity = { sessionId: "websocket-usage-session", authProfileId: "websocket-profile" };
    const model = createModel({
      api: "openai-chatgpt-responses",
      baseUrl: "https://chatgpt.test/backend-api",
    });
    const context = createCompactionContext(model, identity);
    context.systemPrompt = prompt;
    const observations: ResponsesPromptObservation[] = [];
    const order: string[] = [];
    const sentRequests: Array<Record<string, unknown>> = [];
    let connections = 0;
    class ConnectionLimitWebSocket extends EventTarget {
      private readonly limitReached = connections++ === 0;

      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(payload: string): void {
        order.push("send");
        sentRequests.push(JSON.parse(payload) as Record<string, unknown>);
        const event = this.limitReached
          ? { type: "error", error: { code: "websocket_connection_limit_reached" } }
          : {
              type: "response.completed",
              response: {
                id: "resp_ws",
                status: "completed",
                output: [],
                usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
              },
            };
        queueMicrotask(() => {
          this.dispatchEvent(Object.assign(new Event("message"), { data: JSON.stringify(event) }));
        });
      }

      close(): void {}
    }
    vi.stubGlobal("WebSocket", ConnectionLimitWebSocket);
    vi.stubGlobal("fetch", vi.fn());
    const options = { apiKey: createJwt(), transport: "websocket" as const, ...identity };
    responsesPromptObserver.set(options, (observation) => {
      order.push("observe");
      observations.push(observation);
    });

    const result = await streamOpenAICodexResponses(model, context, options).result();

    expect(result.stopReason).toBe("stop");
    expect(
      resolveResponsesContextUsageBoundary(
        [...context.messages, result],
        model,
        identity,
        context.systemPrompt,
      ),
    ).toEqual({ index: context.messages.length, totalTokens: 8, suffix: [] });
    expect(connections).toBe(2);
    expect(order).toEqual(["observe", "send", "observe", "send"]);
    expect(sentRequests.map((request) => request.instructions)).toEqual([prompt, prompt]);
    expect(observations).toEqual([
      {
        egress: "native-codex-websocket",
        payloadVariant: "initial",
        promptSource: "instructions",
        expectedChars: prompt.length,
        observedChars: prompt.length,
        matchesAssembledPrompt: true,
      },
      {
        egress: "native-codex-websocket",
        payloadVariant: "initial",
        promptSource: "instructions",
        expectedChars: prompt.length,
        observedChars: prompt.length,
        matchesAssembledPrompt: true,
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain(prompt);
  });

  it("forwards the private observer through simple options to final native SSE egress", async () => {
    const prompt = "PRIVATE-NATIVE-SSE-PROMPT";
    const observations: ResponsesPromptObservation[] = [];
    const order: string[] = [];
    let sentRequest: Record<string, unknown> | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input, init) => {
        order.push("fetch");
        const body =
          typeof init?.body === "string"
            ? init.body
            : zstdDecompressSync(init?.body as Uint8Array).toString("utf8");
        sentRequest = JSON.parse(body) as Record<string, unknown>;
        return completedSseResponse();
      }),
    );
    const options = {
      apiKey: createJwt(),
      transport: "sse" as const,
      onPayload: async (body: unknown) => {
        await Promise.resolve();
        return { ...(body as Record<string, unknown>), finalTransform: true };
      },
    };
    responsesPromptObserver.set(options, (observation) => {
      order.push("observe");
      observations.push(observation);
    });

    const result = await streamSimpleOpenAICodexResponses(
      createModel({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.test/backend-api",
      }),
      createContext(prompt),
      options,
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(order).toEqual(["observe", "fetch"]);
    expect(sentRequest).toMatchObject({ instructions: prompt, finalTransform: true });
    expect(observations).toEqual([
      {
        egress: "native-codex-sse",
        payloadVariant: "initial",
        promptSource: "instructions",
        expectedChars: prompt.length,
        observedChars: prompt.length,
        matchesAssembledPrompt: true,
      },
    ]);
    expect(JSON.stringify(observations)).not.toContain(prompt);
  });

  it("observes only SSE when automatic WebSocket fallback happens before send", async () => {
    const prompt = "PRIVATE-PRE-SEND-FALLBACK-PROMPT";
    const observations: ResponsesPromptObservation[] = [];
    class FailingWebSocket {
      constructor() {
        throw new Error("websocket connect failed");
      }
      send(): void {}
      close(): void {}
      addEventListener(): void {}
      removeEventListener(): void {}
    }
    vi.stubGlobal("WebSocket", FailingWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => completedSseResponse()),
    );
    const options = { apiKey: createJwt(), transport: "auto" as const };
    responsesPromptObserver.set(options, (observation) => observations.push(observation));

    const result = await streamOpenAICodexResponses(
      createModel({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.test/backend-api",
      }),
      createContext(prompt),
      options,
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(observations.map((entry) => entry.egress)).toEqual(["native-codex-sse"]);
  });

  it("observes WebSocket then SSE when fallback happens after send", async () => {
    const prompt = "PRIVATE-POST-SEND-FALLBACK-PROMPT";
    const observations: ResponsesPromptObservation[] = [];
    const order: string[] = [];
    class SendThenFailWebSocket extends EventTarget {
      constructor() {
        super();
        queueMicrotask(() => this.dispatchEvent(new Event("open")));
      }

      send(): void {
        order.push("send");
        queueMicrotask(() =>
          this.dispatchEvent(
            Object.assign(new Event("error"), { message: "connection dropped after send" }),
          ),
        );
      }

      close(): void {}
    }
    vi.stubGlobal("WebSocket", SendThenFailWebSocket);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        order.push("fetch");
        return completedSseResponse();
      }),
    );
    const options = { apiKey: createJwt(), transport: "auto" as const };
    responsesPromptObserver.set(options, (observation) => {
      order.push(`observe:${observation.egress}`);
      observations.push(observation);
    });

    const result = await streamOpenAICodexResponses(
      createModel({
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.test/backend-api",
      }),
      createContext(prompt),
      options,
    ).result();

    expect(result.stopReason).toBe("stop");
    expect(order).toEqual([
      "observe:native-codex-websocket",
      "send",
      "observe:native-codex-sse",
      "fetch",
    ]);
    expect(observations.map((entry) => entry.egress)).toEqual([
      "native-codex-websocket",
      "native-codex-sse",
    ]);
  });
});
