import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { configureAiTransportHost, getAiTransportHost } from "@openclaw/ai";
import { isAnthropicOAuthApiKey } from "@openclaw/ai/internal/anthropic";
import { Type } from "typebox";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  anthropicModel,
  context as anthropicContext,
  anthropicEvents,
  createAnthropicResponse,
} from "../../../../packages/ai/src/provider-transport-parity.test-support.js";
import {
  resolveProviderContext,
  type ProviderStreamOptions,
} from "../../../../packages/ai/src/provider-types.js";
import { bindStreamLlmRuntime } from "../../../llm/model-runtime-binding.js";
import { createCodexNativeWebSearchWrapper } from "../../../llm/providers/stream-wrappers/openai.js";
import { createAssistantMessageEventStream } from "../../../llm/utils/event-stream.js";
import { attachRuntimePromptMediaFacts } from "../../../media/media-facts.js";
import { createOperationalRunInstanceRef } from "../../admitted-run-context.js";
import type { StreamFn } from "../../runtime/index.js";
import { castAgentMessage } from "../../test-helpers/agent-message-fixtures.js";
import {
  testing as extraParamsTesting,
  type WrapProviderStreamFnParams,
} from "../extra-params.test-support.js";
import { prepareEmbeddedAttemptTransport } from "./attempt-stream-settle.js";

const registerProviderStreamForModel = vi.hoisted(() => vi.fn());

vi.mock("../../provider-stream.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../provider-stream.js")>()),
  registerProviderStreamForModel,
}));

type PrepareTransportInput = Parameters<typeof prepareEmbeddedAttemptTransport>[0];
const MP4 = Buffer.from("0000001c6674797069736f6d0000000069736f6d0000000000000000", "hex");
const admittedRunContext = {
  operationalRunInstance: createOperationalRunInstanceRef("test-run"),
};

function createTransportFixture(testCase: {
  compaction: boolean;
  pruning: boolean;
  apiKey: string;
  baseUrl?: string;
}) {
  const streamFn = vi.fn<StreamFn>();
  bindStreamLlmRuntime(streamFn, {
    streamSimple: streamFn,
    registry: { getApiProvider: () => undefined },
  } as never);
  const session = {
    agent: {
      streamFn,
      transport: "auto",
    },
  };
  const input = {
    attempt: {
      config: {
        agents: {
          defaults: { contextPruning: { mode: testCase.pruning ? "cache-ttl" : "off" } },
        },
      },
      model: {
        api: "anthropic-messages",
        provider: "anthropic",
        id: "claude-sonnet-4-6",
        baseUrl: testCase.baseUrl ?? "https://api.anthropic.com",
      },
      modelId: "claude-sonnet-4-6",
      provider: "anthropic",
      promptCacheKey: undefined,
      resolvedApiKey: undefined,
      authStorage: { getApiKey: async () => testCase.apiKey },
      runId: "run-transport-1",
      admittedRunContext,
      runtimePlan: {
        auth: { forwardedAuthProfileId: undefined },
        transport: {
          resolveExtraParams: () => ({
            transport: "sse",
            anthropicServerCompaction: testCase.compaction,
          }),
        },
      },
      sessionId: "sess-transport-1",
    },
    session,
    settingsManager: {
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
    },
    providerThinkingLevel: undefined,
    sessionAgentId: "main",
    workspaceDir: "/workspace",
    workspaceOnly: false,
    agentDir: "/agent",
    abortSignal: new AbortController().signal,
    getProviderRuntimeHandle: () => ({
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
    }),
    sandboxSessionKey: "agent:main:test",
    codeModeControlsEnabled: false,
    providerPromptState: {
      state: {},
      effectiveContextTokenBudget: 128_000,
    },
  } as unknown as PrepareTransportInput;
  return { input, session, streamFn };
}

describe("prepareEmbeddedAttemptTransport", () => {
  beforeEach(() => {
    // These cases own prepared auth/config, not runtime plugin discovery.
    extraParamsTesting.setProviderRuntimeDepsForTest({ wrapProviderStreamFn: () => undefined });
  });
  afterEach(() => {
    extraParamsTesting.resetProviderRuntimeDepsForTest();
    registerProviderStreamForModel.mockReset();
  });

  it.each([undefined, "test-subscription"])(
    "lets the provider select transport from the prepared auth flow %s",
    async (authFlow) => {
      const { input, session, streamFn } = createTransportFixture({
        compaction: false,
        pruning: false,
        apiKey: "test-access-token",
      });
      streamFn.mockReturnValue(createAssistantMessageEventStream());
      registerProviderStreamForModel.mockReturnValue(streamFn);
      input.attempt.runtimePlan!.auth.selectedAuthMode = "oauth";
      input.attempt.runtimePlan!.auth.selectedAuthFlow = authFlow;
      extraParamsTesting.setProviderRuntimeDepsForTest({
        wrapProviderStreamFn: ({ context }) => {
          const base = context.streamFn;
          if (!base) {
            throw new Error("Expected prepared base stream");
          }
          return (model, messages, options) =>
            base(model, messages, {
              ...options,
              transport: context.auth?.authFlow === "test-subscription" ? "sse" : "auto",
            });
        },
      });

      await prepareEmbeddedAttemptTransport(input);
      await session.agent.streamFn(input.attempt.model, { messages: [] }, {});

      expect(streamFn).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ transport: authFlow ? "sse" : "auto" }),
      );
    },
  );

  it.each([
    {
      compaction: true,
      apiKey: "test-api-key",
      replayEnabled: true,
      pruning: false,
      clearing: false,
    },
    {
      compaction: true,
      apiKey: "test-sk-ant-oat-oauth",
      replayEnabled: false,
      pruning: true,
      clearing: false,
    },
    {
      compaction: false,
      apiKey: "test-api-key",
      replayEnabled: false,
      pruning: true,
      clearing: true,
    },
    {
      compaction: true,
      apiKey: "test-api-key",
      replayEnabled: true,
      pruning: true,
      clearing: true,
    },
    {
      compaction: false,
      apiKey: "test-api-key",
      replayEnabled: false,
      pruning: true,
      clearing: false,
      baseUrl: "https://proxy.example.test/anthropic",
    },
  ])("prepares transport and replay from resolved auth/config: %j", async (testCase) => {
    const { input, session } = createTransportFixture(testCase);

    const result = await prepareEmbeddedAttemptTransport(input);

    expect(result.effectiveAgentTransport).toBe("sse");
    expect(session.agent.transport).toBe("sse");
    expect(result.compactionReplayEnabled).toBe(testCase.replayEnabled);
    expect(result.serverToolClearingEnabled).toBe(testCase.clearing);
  });

  it.each([
    { source: "stored profile", resolvedApiKey: undefined },
    { source: "resolved run", resolvedApiKey: "sk-ant-oat01-synthetic-run" },
  ])(
    "gives provider wrappers the $source credential the Anthropic transport sends",
    async ({ resolvedApiKey }) => {
      await import("../../ai-transport-runtime-host.js");
      const previousHost = getAiTransportHost();
      const requests: Array<{ headers: Headers; payload: Record<string, unknown> }> = [];
      configureAiTransportHost({
        ...previousHost,
        buildModelFetch: () => async (_input, init) => {
          if (typeof init?.body !== "string") {
            throw new Error("expected a JSON Anthropic request body");
          }
          requests.push({
            headers: new Headers(init.headers),
            payload: JSON.parse(init.body) as Record<string, unknown>,
          });
          return createAnthropicResponse(anthropicEvents);
        },
      });
      const wrapperApiKeys: unknown[] = [];
      // Stands in for the Anthropic plugin, which publishes installed Claude CLI
      // evidence only after classifying the request credential as OAuth.
      const wrapProviderStreamFn = vi.fn(({ context }: WrapProviderStreamFnParams) => {
        const streamFn = context.streamFn;
        if (!streamFn) {
          throw new Error("expected a provider stream to wrap");
        }
        return ((model, streamContext, options) => {
          wrapperApiKeys.push(options?.apiKey);
          return streamFn(
            model,
            streamContext,
            isAnthropicOAuthApiKey(options?.apiKey)
              ? { ...options, headers: { ...options?.headers, "user-agent": "claude-cli/2.1.400" } }
              : options,
          );
        }) satisfies StreamFn;
      });
      extraParamsTesting.setProviderRuntimeDepsForTest({ wrapProviderStreamFn });
      const { input, session } = createTransportFixture({
        compaction: false,
        pruning: false,
        apiKey: "sk-ant-oat01-synthetic-profile",
      });
      input.attempt.model = anthropicModel;
      input.attempt.resolvedApiKey = resolvedApiKey;
      const expectedApiKey = resolvedApiKey ?? "sk-ant-oat01-synthetic-profile";

      try {
        await prepareEmbeddedAttemptTransport(input);
        // Agent turns send no credential; the attempt owns it.
        const stream = await session.agent.streamFn(anthropicModel, anthropicContext, {});
        expect((await stream.result()).stopReason).toBe("stop");
      } finally {
        configureAiTransportHost(previousHost);
      }

      expect(wrapProviderStreamFn).toHaveBeenCalledOnce();
      expect(wrapperApiKeys).toEqual([expectedApiKey]);
      expect(requests).toHaveLength(1);
      expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${expectedApiKey}`);
      expect(requests[0]?.headers.get("user-agent")).toBe("claude-cli/2.1.400");
      expect(requests[0]?.payload.system).toContainEqual({
        type: "text",
        text: "x-anthropic-billing-header: cc_version=2.1.400; cc_entrypoint=sdk-cli;",
      });
    },
  );

  it("keeps the run credential out of session-owned fallback streams", async () => {
    // Session-owned streams resolve their own auth; the run credential is not theirs.
    const sessionStream = vi.fn<StreamFn>(() => createAssistantMessageEventStream());
    bindStreamLlmRuntime(sessionStream, {
      streamSimple: vi.fn<StreamFn>(),
      registry: { getApiProvider: () => undefined },
    } as never);
    const { input, session } = createTransportFixture({
      compaction: false,
      pruning: false,
      apiKey: "stored-profile-key",
    });
    session.agent.streamFn = sessionStream;
    input.attempt.model = { ...input.attempt.model, api: "test-api" };

    const result = await prepareEmbeddedAttemptTransport(input);
    await session.agent.streamFn(input.attempt.model, { messages: [] }, {});

    expect(result.streamStrategy).toBe("session-custom");
    expect(sessionStream).toHaveBeenCalledOnce();
    expect(sessionStream.mock.calls[0]?.[2]?.apiKey).toBeUndefined();
  });

  describe.each([false, true])("with code mode enabled: %s", (codeModeControlsEnabled) => {
    it.each([
      { label: "foreground", toolExecutionAllow: undefined, expectedSearch: true },
      { label: "skill review", toolExecutionAllow: ["skill_workshop"], expectedSearch: false },
      { label: "explicit search", toolExecutionAllow: ["web_search"], expectedSearch: true },
      { label: "no execution", toolExecutionAllow: [], expectedSearch: false },
    ])("keeps $label authority on the provider payload", async (testCase) => {
      const { input, streamFn } = createTransportFixture({
        compaction: false,
        pruning: false,
        apiKey: "test-api-key",
      });
      input.attempt.model = {
        ...input.attempt.model,
        api: "openai-chatgpt-responses",
        provider: "openai",
        id: "gpt-5.4",
        baseUrl: "https://chatgpt.com/backend-api",
      };
      input.attempt.modelId = input.attempt.model.id;
      input.attempt.provider = input.attempt.model.provider;
      input.attempt.toolExecutionAllow = testCase.toolExecutionAllow;
      input.attempt.config = {
        auth: { profiles: { test: { provider: "openai", mode: "oauth" } } },
        tools: { web: { search: { openaiCodex: { enabled: true } } } },
      };
      input.codeModeControlsEnabled = codeModeControlsEnabled;
      extraParamsTesting.setProviderRuntimeDepsForTest({
        wrapProviderStreamFn: ({ context }) =>
          createCodexNativeWebSearchWrapper(context.streamFn, context),
      });
      const functionTools = (
        codeModeControlsEnabled ? ["exec", "wait"] : ["read", "skill_workshop"]
      ).map((name) => ({
        type: "function",
        name,
        description: name,
        parameters: Type.Object({}),
      }));
      const payload: { tools: Array<Record<string, unknown>> } = { tools: [...functionTools] };
      const foregroundFunctionSchemas = JSON.stringify(functionTools);
      streamFn.mockImplementation(async (model, _context, options) => {
        await options?.onPayload?.(payload, model);
        return createAssistantMessageEventStream();
      });

      await prepareEmbeddedAttemptTransport(input);
      await input.session.agent.streamFn?.(
        input.attempt.model,
        { messages: [], tools: functionTools },
        {},
      );

      expect(JSON.stringify(payload.tools.filter((tool) => tool.type === "function"))).toBe(
        foregroundFunctionSchemas,
      );
      expect(payload.tools.some((tool) => tool.type === "web_search")).toBe(
        testCase.expectedSearch,
      );
    });
  });

  it("materializes native video from the prepared session agent workspace", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-transport-video-"));
    const videoPath = path.join(workspaceDir, "history.mp4");
    await fs.writeFile(videoPath, MP4);
    let providerOptions: ProviderStreamOptions | undefined;
    const providerStream = vi.fn((_model, _context, options) => {
      providerOptions = options as ProviderStreamOptions;
      return {} as never;
    });
    bindStreamLlmRuntime(providerStream, {
      streamSimple: providerStream,
      registry: { getApiProvider: () => undefined },
    } as never);
    const session = {
      agent: {
        streamFn: providerStream,
        transport: "auto",
      },
    };
    const model = {
      api: "test-api",
      provider: "test-provider",
      id: "test-model-video",
    };
    registerProviderStreamForModel.mockReturnValue(providerStream);

    try {
      await prepareEmbeddedAttemptTransport({
        attempt: {
          config: { agents: { list: [{ id: "marketing", workspace: workspaceDir }] } },
          model,
          modelId: model.id,
          provider: model.provider,
          runId: "run-native-video",
          admittedRunContext,
          runtimePlan: {
            auth: { forwardedAuthProfileId: undefined },
            transport: { resolveExtraParams: () => ({}) },
          },
          sessionId: "session-native-video",
        },
        session,
        settingsManager: {
          getGlobalSettings: () => ({}),
          getProjectSettings: () => ({}),
        },
        sessionAgentId: "marketing",
        workspaceDir,
        workspaceOnly: false,
        agentDir: workspaceDir,
        abortSignal: new AbortController().signal,
        getProviderRuntimeHandle: () => ({ provider: model.provider, modelId: model.id }),
        sandboxSessionKey: "agent:marketing:test",
        codeModeControlsEnabled: false,
        providerPromptState: { state: {}, effectiveContextTokenBudget: 128_000 },
      } as unknown as PrepareTransportInput);
      const message = attachRuntimePromptMediaFacts(
        castAgentMessage({ role: "user", content: [{ type: "text", text: "inspect" }] }),
        [{ kind: "video", path: videoPath, contentType: "video/mp4" }],
      );
      const context = { systemPrompt: "system", messages: [message], tools: [] };

      session.agent.streamFn(model as never, context as never, {});
      const provider = await resolveProviderContext(context as never, providerOptions);

      expect(provider.messages[0]?.content).toEqual([
        { type: "text", text: "inspect" },
        { type: "video", data: MP4.toString("base64"), mimeType: "video/mp4" },
      ]);
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("records image hydration failures at the provider handoff", async () => {
    let providerOptions: ProviderStreamOptions | undefined;
    const providerStream = vi.fn((_model, _context, options) => {
      providerOptions = options as ProviderStreamOptions;
      return {} as never;
    });
    bindStreamLlmRuntime(providerStream, {
      streamSimple: providerStream,
      registry: { getApiProvider: () => undefined },
    } as never);
    const session = {
      agent: { streamFn: providerStream, transport: "auto" },
    };
    const model = { api: "test-api", provider: "test-provider", id: "test-model-image" };
    const onCurrentTurnImageFailure = vi.fn();
    registerProviderStreamForModel.mockReturnValue(providerStream);
    await prepareEmbeddedAttemptTransport({
      attempt: {
        config: {},
        model,
        modelId: model.id,
        provider: model.provider,
        runId: "run-native-image-failure",
        admittedRunContext,
        runtimePlan: {
          auth: { forwardedAuthProfileId: undefined },
          transport: { resolveExtraParams: () => ({}) },
        },
        sessionId: "session-native-image-failure",
      },
      session,
      settingsManager: {
        getGlobalSettings: () => ({}),
        getProjectSettings: () => ({}),
      },
      onCurrentTurnImageFailure,
      sessionAgentId: "main",
      workspaceDir: "/tmp",
      workspaceOnly: false,
      agentDir: "/tmp",
      abortSignal: new AbortController().signal,
      getProviderRuntimeHandle: () => ({ provider: model.provider, modelId: model.id }),
      sandboxSessionKey: "agent:main:test",
      codeModeControlsEnabled: false,
      providerPromptState: { state: {}, effectiveContextTokenBudget: 128_000 },
    } as unknown as PrepareTransportInput);
    const message = attachRuntimePromptMediaFacts(
      castAgentMessage({
        role: "user",
        content: [
          { type: "text", text: "inspect" },
          { type: "image", data: "%%%", mimeType: "image/png" },
        ],
      }),
      [{ kind: "image" }],
      ["inline"],
    );
    const context = { systemPrompt: "system", messages: [message], tools: [] };

    session.agent.streamFn(model as never, context as never, {});
    const provider = await resolveProviderContext(context as never, providerOptions);

    expect(onCurrentTurnImageFailure).toHaveBeenCalledWith(1);
    expect(provider.messages[0]?.content).toEqual([
      { type: "text", text: "inspect" },
      {
        type: "text",
        text: expect.stringMatching(/1.*image contents.*unavailable.*resend.*not claim/is),
      },
    ]);
  });
});
