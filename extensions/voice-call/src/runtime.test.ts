import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { resetPluginRuntimeStateForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { VoiceCallConfig } from "./config.js";
import {
  createMockSessionRuntime,
  registerFastContextMemoryProvider,
} from "./runtime.fast-context.test-support.js";
import { createExternalProviderConfig, createVoiceCallBaseConfig } from "./test-fixtures.js";
import type { CallRecord } from "./types.js";
import type { RealtimeCallHandler } from "./webhook/realtime-handler.js";
import { StreamDisconnectGrace } from "./webhook/stream-disconnect-grace.js";

const mocks = vi.hoisted(() => ({
  managerInitialize: vi.fn(),
  managerStop: vi.fn(),
  managerGetCall: vi.fn(),
  webhookStart: vi.fn(),
  webhookStop: vi.fn(),
  webhookSetRealtimeHandler: vi.fn(),
  webhookGetRealtimeHandler: vi.fn(),
  webhookGetMediaStreamHandler: vi.fn(),
  webhookGetStreamDisconnectLifecycle: vi.fn(),
  webhookCtorArgs: [] as unknown[][],
  realtimeHandlerCtorArgs: [] as ConstructorParameters<typeof RealtimeCallHandler>[],
  realtimeHandlerRegisterToolHandler: vi.fn<RealtimeCallHandler["registerToolHandler"]>(),
  realtimeHandlerSetPublicUrl: vi.fn(),
  resolveConfiguredRealtimeVoiceProviderAsync: vi.fn(),
  resolveRealtimeFastContextConsult: vi.fn(),
  actualRealtimeFastContextConsult: undefined as
    | typeof import("openclaw/plugin-sdk/realtime-voice").resolveRealtimeVoiceFastContextConsult
    | undefined,
  startTunnel: vi.fn(),
  setupTailscaleExposure: vi.fn(),
  cleanupTailscaleExposure: vi.fn(),
}));

vi.mock("./manager.js", () => ({
  CallManager: class {
    initialize = mocks.managerInitialize;
    stop = mocks.managerStop;
    getCall = mocks.managerGetCall;
  },
}));

vi.mock("./webhook.js", () => ({
  VoiceCallWebhookServer: class {
    constructor(...args: unknown[]) {
      mocks.webhookCtorArgs.push(args);
    }
    start = mocks.webhookStart;
    stop = mocks.webhookStop;
    setRealtimeHandler = mocks.webhookSetRealtimeHandler;
    getRealtimeHandler = mocks.webhookGetRealtimeHandler;
    getMediaStreamHandler = mocks.webhookGetMediaStreamHandler;
    getStreamDisconnectLifecycle = mocks.webhookGetStreamDisconnectLifecycle;
  },
}));

// mock-isolation: Keep provider registration and credential state outside runtime tests.
vi.mock("./realtime-voice.runtime.js", () => ({
  resolveConfiguredRealtimeVoiceProviderAsync: mocks.resolveConfiguredRealtimeVoiceProviderAsync,
}));

vi.mock("openclaw/plugin-sdk/realtime-voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/realtime-voice")>();
  mocks.actualRealtimeFastContextConsult = actual.resolveRealtimeVoiceFastContextConsult;
  return {
    ...actual,
    resolveRealtimeVoiceFastContextConsult: mocks.resolveRealtimeFastContextConsult,
  };
});

// mock-isolation: Inspect handler wiring without starting realtime transport.
vi.mock("./webhook/realtime-handler.js", () => ({
  RealtimeCallHandler: class {
    constructor(...args: ConstructorParameters<typeof RealtimeCallHandler>) {
      mocks.realtimeHandlerCtorArgs.push(args);
    }
    registerToolHandler = mocks.realtimeHandlerRegisterToolHandler;
    setPublicUrl = mocks.realtimeHandlerSetPublicUrl;
  },
}));

vi.mock("./tunnel.js", () => ({
  startTunnel: mocks.startTunnel,
}));

vi.mock("./webhook/tailscale.js", () => ({
  setupTailscaleExposure: mocks.setupTailscaleExposure,
  cleanupTailscaleExposure: mocks.cleanupTailscaleExposure,
}));

import { createVoiceCallRuntime } from "./runtime.js";

function createBaseConfig(): VoiceCallConfig {
  return createVoiceCallBaseConfig({ tunnelProvider: "ngrok" });
}

function createRuntime(options: Partial<Parameters<typeof createVoiceCallRuntime>[0]> = {}) {
  return createVoiceCallRuntime({
    scheduler: createTestPluginServiceScheduler(),
    config: createBaseConfig(),
    coreConfig: {},
    agentRuntime: {} as never,
    ...options,
  });
}

function setConsultCall(overrides: Record<string, unknown> = {}) {
  mocks.managerGetCall.mockReturnValue({
    callId: "call-1",
    agentId: "main",
    direction: "inbound",
    from: "+15550001234",
    to: "+15550009999",
    transcript: [],
    ...overrides,
  });
}

function createConsultRuntime<T>(runEmbeddedAgent: T, sessionStore: Record<string, unknown> = {}) {
  return {
    defaults: { provider: "openai", model: "gpt-5.4" },
    resolveAgentDir: vi.fn(() => "/tmp/agent"),
    resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
    resolveAgentIdentity: vi.fn(),
    resolveThinkingDefault: vi.fn(() => "high"),
    resolveAgentTimeoutMs: vi.fn(() => 30_000),
    ensureAgentWorkspace: vi.fn(async () => {}),
    session: createMockSessionRuntime(sessionStore),
    runEmbeddedAgent,
  };
}

function answeringAgent(text: string) {
  type Agent = Parameters<typeof createVoiceCallRuntime>[0]["agentRuntime"]["runEmbeddedAgent"];
  return vi.fn(async (_params: Parameters<Agent>[0]) => ({ payloads: [{ text }], meta: {} }));
}

function consultParamsFrom(agent: ReturnType<typeof answeringAgent>) {
  return expectDefined(agent.mock.calls.at(0), "consult call")[0];
}

function createRealtimeConfig(
  realtime: Partial<VoiceCallConfig["realtime"]> = {},
  overrides: Partial<VoiceCallConfig> = {},
) {
  const config = createBaseConfig();
  return { ...config, ...overrides, realtime: { ...config.realtime, enabled: true, ...realtime } };
}

function fastContextConfig(timeoutMs: number): VoiceCallConfig["realtime"]["fastContext"] {
  return { enabled: true, timeoutMs, maxResults: 2, sources: ["memory"], fallbackToConsult: false };
}

const customTool: VoiceCallConfig["realtime"]["tools"][number] = {
  type: "function",
  name: "custom_tool",
  description: "Custom tool",
  parameters: { type: "object", properties: {} },
};

function expectIncludes(value: unknown, ...parts: string[]) {
  for (const part of parts) {
    expect(value).toContain(part);
  }
}

const realtimeArgs = () => expectDefined(mocks.realtimeHandlerCtorArgs[0], "realtime handler");

function requireRealtimeConsultToolHandler() {
  const registeredToolHandler = expectDefined(
    mocks.realtimeHandlerRegisterToolHandler.mock.calls.at(0),
    "realtime tool handler registration call",
  );
  expect(registeredToolHandler[0]).toBe("openclaw_agent_consult");
  return registeredToolHandler[1];
}

async function startConsult(
  config: VoiceCallConfig,
  agentRuntime: ReturnType<typeof createConsultRuntime>,
  coreConfig: OpenClawConfig = {},
) {
  await createRuntime({ config, agentRuntime: agentRuntime as never, coreConfig });
  return requireRealtimeConsultToolHandler();
}

describe("createVoiceCallRuntime lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.webhookStart.mockResolvedValue("http://127.0.0.1:3334/voice/webhook");
    mocks.webhookGetRealtimeHandler.mockReturnValue({
      setPublicUrl: mocks.realtimeHandlerSetPublicUrl,
    });
    const streamDisconnectLifecycle = new StreamDisconnectGrace(() => {});
    mocks.webhookGetStreamDisconnectLifecycle.mockReturnValue(streamDisconnectLifecycle);
    onTestFinished(() => streamDisconnectLifecycle.close());
    mocks.webhookCtorArgs.length = 0;
    mocks.realtimeHandlerCtorArgs.length = 0;
    mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
      provider: { id: "openai" },
      providerConfig: { model: "gpt-realtime" },
    });
    mocks.resolveRealtimeFastContextConsult.mockResolvedValue({ handled: false });
    mocks.startTunnel.mockResolvedValue(null);
    mocks.setupTailscaleExposure.mockResolvedValue(null);
  });

  it("explains the missing phone-call owner before provisioning a runtime", async () => {
    await expect(
      createRuntime({
        coreConfig: {
          agents: { ownership: "explicit", entries: { operator: {}, support: {} } },
        },
      }),
    ).rejects.toThrow("Set plugins.entries.voice-call.config.agentId to a configured agent ID.");
    expect(mocks.webhookCtorArgs).toHaveLength(0);
    expect(mocks.managerInitialize).not.toHaveBeenCalled();
    expect(mocks.startTunnel).not.toHaveBeenCalled();
  });

  it.each<{ name: string; coreConfig: OpenClawConfig; agentId?: string }>([
    { name: "sole named agent", coreConfig: { agents: { entries: { operator: {} } } } },
    {
      name: "explicit fleet owner",
      coreConfig: {
        agents: { ownership: "explicit", entries: { support: {}, operator: {} } },
      },
      agentId: "OPERATOR",
    },
  ])("preserves the $name for phone-call startup", async ({ coreConfig, agentId }) => {
    const runtime = await createRuntime({
      config: { ...createBaseConfig(), agentId },
      coreConfig,
    });
    expect(runtime.config.agentId).toBe("operator");
    await runtime.stop();
  });

  it("cleans up tunnel, tailscale, and webhook server when init fails after start", async () => {
    const config = createBaseConfig();
    const tunnelStop = vi.fn().mockResolvedValue(undefined);
    mocks.startTunnel.mockResolvedValue({
      publicUrl: "https://public.example:8443/voice/webhook",
      stop: tunnelStop,
    });
    mocks.managerInitialize.mockRejectedValue(new Error("init failed"));

    await expect(createRuntime({ config })).rejects.toThrow("init failed");

    expect(tunnelStop).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupTailscaleExposure).toHaveBeenCalledTimes(1);
    expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
  });

  it("returns an idempotent stop handler", async () => {
    const tunnelStop = vi.fn().mockResolvedValue(undefined);
    const webhookStopped = createDeferred<void>();
    mocks.webhookStop.mockReturnValue(webhookStopped.promise);
    mocks.startTunnel.mockResolvedValue({
      publicUrl: "https://public.example/voice/webhook",
      stop: tunnelStop,
    });

    const runtime = await createRuntime();

    const firstStop = runtime.stop();
    const secondStop = runtime.stop();
    let stopped = false;
    void secondStop.then(() => {
      stopped = true;
    });

    expect(secondStop).toBe(firstStop);
    await vi.waitFor(() => expect(mocks.webhookStop).toHaveBeenCalledTimes(1));
    expect(stopped).toBe(false);
    expect(mocks.managerStop).not.toHaveBeenCalled();

    webhookStopped.resolve();
    await firstStop;
    expect(stopped).toBe(true);
    expect(mocks.managerStop).toHaveBeenCalledOnce();

    expect(tunnelStop).toHaveBeenCalledTimes(1);
    expect(mocks.cleanupTailscaleExposure).toHaveBeenCalledTimes(1);
    expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
  });

  it("drains the manager after transport cleanup fails and preserves the first error", async () => {
    const transportFailure = new Error("webhook shutdown failed");
    const drain = createDeferred<void>();
    mocks.webhookStop.mockRejectedValue(transportFailure);
    mocks.managerStop.mockReturnValue(drain.promise);
    const runtime = await createRuntime();
    let settled = false;
    const stopped = runtime.stop().catch((error: unknown) => {
      settled = true;
      return error;
    });
    await vi.waitFor(() => expect(mocks.managerStop).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    drain.reject(new Error("manager drain failed"));
    expect(await stopped).toBe(transportFailure);
  });

  it("builds realtime instructions for the agent frozen on each call", async () => {
    const config = createRealtimeConfig(
      {
        agentContext: {
          enabled: true,
          maxChars: 6000,
          includeIdentity: true,
          includeWorkspaceFiles: false,
          files: ["SOUL.md"],
        },
      },
      { agentId: "operator" },
    );
    const coreConfig: OpenClawConfig = {
      agents: {
        entries: {
          operator: { identity: { name: "Main Voice" } },
          support: { identity: { name: "Support Voice" } },
        },
      },
    };
    const runtime = await createRuntime({ config, coreConfig });
    expect(mocks.webhookCtorArgs[0]?.[4]).toBe(coreConfig);

    const resolveCallRegistration = realtimeArgs()[2];
    expect(mocks.resolveConfiguredRealtimeVoiceProviderAsync).not.toHaveBeenCalled();
    expect(runtime.config.agentId).toBe("operator");
    const register = (agentId?: string, metadata?: CallRecord["metadata"]) =>
      resolveCallRegistration({
        callId: "call-1",
        provider: "mock",
        direction: "outbound",
        state: "active",
        from: "+15550001111",
        to: "+15550002222",
        startedAt: 0,
        transcript: [],
        processedEventIds: [],
        agentId,
        metadata,
        sessionKey: "agent:operator:voice:unowned",
      });
    await expect(register()).rejects.toThrow("no recorded agent owner");
    expect(mocks.resolveConfiguredRealtimeVoiceProviderAsync).not.toHaveBeenCalled();
    const defaultRegistration = await register("operator");
    expect(defaultRegistration.agentId).toBe("operator");
    expect(defaultRegistration.instructions).toContain("- Name: Main Voice");
    const briefRegistration = await register("operator", {
      brief: { task: "Arrange a plumber visit", approvals: "No paid work" },
    });
    expectIncludes(briefRegistration.instructions, "Arrange a plumber visit", "No paid work");
    expect(defaultRegistration.instructions).not.toContain("Arrange a plumber visit");

    const supportRegistration = await register("support");
    expect(supportRegistration.agentId).toBe("support");
    expect(supportRegistration.instructions).toContain("- Name: Support Voice");
    expect(supportRegistration.instructions).not.toContain("Main Voice");

    const unknownRegistration = await register("unknown");
    expect(unknownRegistration.instructions).not.toContain("Configured identity:");
    expect(unknownRegistration.instructions.match(/Agent context:/g)).toHaveLength(1);
  });

  it.each([
    ["twilio", undefined],
    ["telnyx", undefined],
    ["plivo", undefined],
    ["twilio", "http://127.0.0.1:3334/voice/webhook"],
  ] as const)("fails closed for %s with a local-only webhook (%s)", async (provider, publicUrl) => {
    await expect(
      createRuntime({
        config: createExternalProviderConfig({ provider, publicUrl }),
      }),
    ).rejects.toThrow(`${provider} requires a publicly reachable webhook URL`);
    expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
  });

  it("accepts an explicit public URL without logging it twice", async () => {
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const runtime = await createRuntime({
      config: createExternalProviderConfig({
        provider: "twilio",
        publicUrl: "https://voice.example.com/voice/webhook",
      }),
      logger,
    });

    expect(mocks.managerInitialize).toHaveBeenCalledWith(
      expect.anything(),
      "https://voice.example.com/voice/webhook",
    );
    expect(logger.info).toHaveBeenCalledWith(
      "[voice-call] Webhook URL: https://voice.example.com/voice/webhook",
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      "[voice-call] Public URL: https://voice.example.com/voice/webhook",
    );

    await runtime.stop();
  });

  it("wires realtime consults and keeps outbound calls off inbound number routes", async () => {
    const config = createRealtimeConfig(
      { tools: [customTool], consultThinkingLevel: "ultra", consultFastMode: true },
      { inboundPolicy: "allowlist" },
    );
    config.numbers["+15550009999"] = {
      agentId: "inbound-route",
      responseModel: "openai/gpt-5.5",
    };
    const runEmbeddedAgent = answeringAgent("Use the shipment status.");
    const agentRuntime = createConsultRuntime(runEmbeddedAgent);
    setConsultCall({
      agentId: "support",
      direction: "outbound",
      metadata: {
        requesterSessionKey: "agent:main:discord:channel:general",
        brief: { task: "Check shipment reference ABC" },
        ownerInstructions: ["Ask for tomorrow delivery"],
      },
      transcript: [{ speaker: "user", text: "Can you check shipment status?" }],
    });

    const handler = await startConsult(config, agentRuntime, {
      agents: { defaults: { model: { primary: "anthropic/claude-opus-5-5" } } },
    });

    expect(realtimeArgs()[0].tools).toContainEqual(customTool);

    await expect(
      handler({ question: "What should I say?" }, "call-1", {
        partialUserTranscript: "Also check the ETA.",
      }),
    ).resolves.toEqual({
      text: "Use the shipment status.",
    });
    expect(agentRuntime.resolveThinkingDefault).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    const consultParams = consultParamsFrom(runEmbeddedAgent);
    expect(consultParams).toMatchObject({
      agentId: "support",
      sessionKey: "agent:support:voice:15550009999",
      spawnedBy: "agent:main:discord:channel:general",
      messageProvider: "voice",
      lane: "voice",
      provider: "anthropic",
      model: "claude-opus-5-5",
      thinkLevel: "ultra",
      fastMode: true,
    });
    expect(consultParams.toolsAllow).toEqual([
      "read",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
      "voice_call",
    ]);
    expect(consultParams.toolBindings).toEqual({
      voice_call: { kind: "active-call", callId: "call-1" },
    });
    expectIncludes(
      consultParams.extraSystemPrompt,
      "one or two bounded read-only queries",
      'bound call id is "call-1"',
      "Check shipment reference ABC",
      "Ask for tomorrow delivery",
    );
    expectIncludes(
      consultParams.prompt,
      "Caller: Can you check shipment status?",
      "Caller: Also check the ETA.",
    );
  });

  it("always exposes the built-in end-call tool without allowing configured replacement", async () => {
    const config = createRealtimeConfig({
      toolPolicy: "none",
      tools: [
        {
          ...customTool,
          name: "openclaw_end_call",
          description: "Configured replacement",
          parameters: { type: "object", properties: { callId: { type: "string" } } },
        },
        customTool,
      ],
    });

    await createRuntime({ config });

    const tools = realtimeArgs()[0].tools;
    expect(tools.map((tool) => tool.name)).toEqual(["openclaw_end_call", "custom_tool"]);
    const endCallTool = expectDefined(tools[0], "end-call tool");
    expectIncludes(endCallTool.description, "final words", "no further reply");
    expect(endCallTool.parameters).toEqual({
      type: "object",
      properties: {},
    });
    expect(mocks.realtimeHandlerRegisterToolHandler).not.toHaveBeenCalled();
  });

  it.each(["aborted", "model-locked"] as const)(
    "rejects %s consults before context or dispatch",
    async (state) => {
      const runEmbeddedAgent = vi.fn();
      const sessionStore: Record<string, unknown> = {};
      if (state === "model-locked") {
        sessionStore["agent:main:voice:15550001234"] = {
          sessionId: "locked-codex-session",
          updatedAt: 1,
          agentHarnessId: "codex",
          modelSelectionLocked: true,
        };
      }
      setConsultCall();
      const handler = await startConsult(
        createRealtimeConfig(),
        createConsultRuntime(runEmbeddedAgent, sessionStore),
      );
      const controller = new AbortController();
      if (state === "aborted") {
        controller.abort(new Error("voice session replaced"));
      }
      await expect(
        handler({ question: "Check the deployment." }, "call-1", {
          abortSignal: controller.signal,
        }),
      ).rejects.toThrow(
        state === "aborted"
          ? "voice session replaced"
          : "Model selection is locked for this session.",
      );
      expect(mocks.resolveRealtimeFastContextConsult).not.toHaveBeenCalled();
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    },
  );

  it("canonicalizes restored legacy per-call keys for realtime consults", async () => {
    const config = createRealtimeConfig(
      {},
      { inboundPolicy: "allowlist", sessionScope: "per-call" },
    );
    const runEmbeddedAgent = answeringAgent("Per-call consult answer.");
    const agentRuntime = createConsultRuntime(runEmbeddedAgent);
    setConsultCall({ sessionKey: "voice:call:call-1" });

    const handler = await startConsult(config, agentRuntime);

    await expect(handler({ question: "What should I say?" }, "call-1", {})).resolves.toEqual({
      text: "Per-call consult answer.",
    });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(consultParamsFrom(runEmbeddedAgent).sessionKey).toBe("agent:main:voice:call:call-1");
  });

  it.each(["live", "consult-aborted", "call-ended"])(
    "keeps selected memory-provider lookup bound to call and consult: %s",
    async (state) => {
      onTestFinished(() => resetPluginRuntimeStateForTest());
      const { open, search } = registerFastContextMemoryProvider();
      mocks.resolveRealtimeFastContextConsult.mockImplementation(
        expectDefined(mocks.actualRealtimeFastContextConsult, "actual fast context consult"),
      );
      setConsultCall({ state: "active" });
      const runEmbeddedAgent = vi.fn();
      const handler = await startConsult(
        createRealtimeConfig({ fastContext: fastContextConfig(1_000) }),
        { session: createMockSessionRuntime({}), runEmbeddedAgent } as never,
      );
      const consult = new AbortController();
      const pending = handler({ question: "Are the lights on?" }, "call-1", {
        abortSignal: consult.signal,
      });
      if (state === "consult-aborted") {
        consult.abort(new Error("consult cancelled"));
        await expect(pending).rejects.toThrow("consult cancelled");
      } else {
        if (state === "call-ended") {
          mocks.managerGetCall.mockReturnValue(undefined);
        }
        expect(await pending).toMatchObject({
          text: expect.stringContaining(
            state === "live"
              ? "Lights are on."
              : "No relevant OpenClaw memory or session context was found quickly",
          ),
        });
      }
      expect(open).toHaveBeenCalledTimes(state === "live" ? 1 : 0);
      expect(search).toHaveBeenCalledTimes(state === "live" ? 1 : 0);
      expect(runEmbeddedAgent).not.toHaveBeenCalled();
    },
  );
});
