import type { OpenClawConfig } from "openclaw/plugin-sdk/core";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginServiceScheduler } from "openclaw/plugin-sdk/plugin-test-api";
import { resetPluginRuntimeStateForTest } from "openclaw/plugin-sdk/plugin-test-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallConfig } from "./config.js";
import {
  createMockSessionRuntime,
  registerFastContextMemoryProvider,
} from "./runtime.fast-context.test-support.js";
import { createExternalProviderConfig, createVoiceCallBaseConfig } from "./test-fixtures.js";
import type { RealtimeCallHandler } from "./webhook/realtime-handler.js";

const mocks = vi.hoisted(() => ({
  resolveVoiceCallConfig: vi.fn(),
  resolveVoiceCallStreamExposurePaths: vi.fn(),
  resolveTwilioAuthToken: vi.fn(),
  validateProviderConfig: vi.fn(),
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
  realtimeHandlerCtorArgs: [] as unknown[][],
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

vi.mock("./config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./config.js")>();
  return {
    ...actual,
    resolveVoiceCallConfig: mocks.resolveVoiceCallConfig,
    resolveVoiceCallStreamExposurePaths: mocks.resolveVoiceCallStreamExposurePaths,
    resolveTwilioAuthToken: mocks.resolveTwilioAuthToken,
    validateProviderConfig: mocks.validateProviderConfig,
  };
});

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

vi.mock("./webhook/realtime-handler.js", () => ({
  RealtimeCallHandler: class {
    constructor(...args: unknown[]) {
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
  return vi.fn(async (_params: unknown) => ({ payloads: [{ text }], meta: {} }));
}

function createDefaultConsultRuntime<T>(runEmbeddedAgent: T) {
  return {
    defaults: { provider: "openai", model: "gpt-5.4" },
    ...createConsultRuntime(runEmbeddedAgent),
  };
}

function consultParamsFrom(agent: ReturnType<typeof answeringAgent>) {
  return requireRecord(expectDefined(agent.mock.calls.at(0), "consult call")[0], "consult params");
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

const requireRecord = createRequireRecord("record", "expected-label-record");

function requireRealtimeTools() {
  const { tools } = requireRecord(
    mocks.realtimeHandlerCtorArgs[0]?.[0],
    "realtime handler options",
  );
  if (!Array.isArray(tools)) {
    throw new Error("expected realtime handler tools to be an array");
  }
  return tools;
}

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
) {
  await createRuntime({ config, agentRuntime: agentRuntime as never });
  return requireRealtimeConsultToolHandler();
}

describe("createVoiceCallRuntime lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.resolveVoiceCallConfig.mockImplementation((cfg: VoiceCallConfig) => cfg);
    mocks.resolveTwilioAuthToken.mockImplementation(
      (cfg: VoiceCallConfig) => cfg.twilio?.authToken,
    );
    mocks.validateProviderConfig.mockReturnValue({ valid: true, errors: [] });
    mocks.webhookStart.mockResolvedValue("http://127.0.0.1:3334/voice/webhook");
    mocks.webhookGetRealtimeHandler.mockReturnValue({
      setPublicUrl: mocks.realtimeHandlerSetPublicUrl,
    });
    mocks.webhookGetStreamDisconnectLifecycle.mockReturnValue({
      connect: vi.fn(),
      disconnect: vi.fn(),
      retire: vi.fn(),
    });
    mocks.webhookCtorArgs.length = 0;
    mocks.realtimeHandlerCtorArgs.length = 0;
    mocks.resolveConfiguredRealtimeVoiceProviderAsync.mockReturnValue({
      provider: { id: "openai" },
      providerConfig: { model: "gpt-realtime" },
    });
    mocks.resolveRealtimeFastContextConsult.mockResolvedValue({ handled: false });
    mocks.resolveVoiceCallStreamExposurePaths.mockReturnValue([
      {
        localPath: "/voice/stream/realtime",
        publicPath: "/voice/stream/realtime",
      },
    ]);
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
        agents: { ownership: "explicit", entries: { operator: {}, support: {} } },
      },
      agentId: "OPERATOR",
    },
    {
      name: "explicit owner after another agent",
      coreConfig: { agents: { entries: { support: {}, operator: {} } } },
      agentId: "operator",
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
    config.tunnel.provider = "tailscale-funnel";
    config.tailscale.port = 8443;
    const tunnelStop = vi.fn().mockResolvedValue(undefined);
    mocks.startTunnel.mockResolvedValue({
      publicUrl: "https://public.example:8443/voice/webhook",
      stop: tunnelStop,
    });
    mocks.managerInitialize.mockRejectedValue(new Error("init failed"));

    await expect(createRuntime({ config })).rejects.toThrow("init failed");

    expect(mocks.startTunnel).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "tailscale-funnel",
        tailscalePort: 8443,
        streamPaths: [
          {
            localPath: "/voice/stream/realtime",
            publicPath: "/voice/stream/realtime",
          },
        ],
      }),
    );
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

  it("passes fullConfig to the webhook server for streaming provider resolution", async () => {
    const coreConfig = { tts: { provider: "openai" } } as OpenClawConfig;
    const fullConfig: OpenClawConfig = { plugins: { entries: { openai: { enabled: true } } } };

    await createRuntime({ coreConfig, fullConfig });

    expect(mocks.webhookCtorArgs[0]?.[4]).toBe(coreConfig);
    expect(mocks.webhookCtorArgs[0]?.[5]).toBe(fullConfig);
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
    const fullConfig: OpenClawConfig = {
      agents: {
        entries: {
          operator: { identity: { name: "Main Voice" } },
          support: { identity: { name: "Support Voice" } },
        },
      },
    };
    const runtime = await createRuntime({ config, fullConfig });

    const resolveCallRegistration = mocks.realtimeHandlerCtorArgs[0]?.[2];
    expect(mocks.realtimeHandlerCtorArgs[0]?.[4]).toBe(
      mocks.webhookGetStreamDisconnectLifecycle.mock.results[0]?.value,
    );
    expect(mocks.resolveConfiguredRealtimeVoiceProviderAsync).not.toHaveBeenCalled();
    if (typeof resolveCallRegistration !== "function") {
      throw new Error("expected per-call realtime registration resolver");
    }
    expect(runtime.config.agentId).toBe("operator");
    const outboundContact = {
      direction: "outbound" as const,
      from: "+15550001111",
      to: "+15550002222",
    };
    const register = (callId: string, agentId?: string, metadata?: unknown) =>
      resolveCallRegistration({ ...outboundContact, callId, agentId, metadata });
    await expect(
      resolveCallRegistration({
        ...outboundContact,
        callId: "unowned",
        sessionKey: "agent:operator:voice:unowned",
      }),
    ).rejects.toThrow("no recorded agent owner");
    expect(mocks.resolveConfiguredRealtimeVoiceProviderAsync).not.toHaveBeenCalled();
    const defaultRegistration = await register("call-default", "operator");
    expect(defaultRegistration.agentId).toBe("operator");
    expect(defaultRegistration.instructions).toContain("- Name: Main Voice");
    expect(defaultRegistration.instructions.match(/Agent context:/g)).toHaveLength(1);
    const briefRegistration = await register("call-brief", "operator", {
      brief: { task: "Arrange a plumber visit", approvals: "No paid work" },
    });
    expectIncludes(briefRegistration.instructions, "Arrange a plumber visit", "No paid work");
    expect(defaultRegistration.instructions).not.toContain("Arrange a plumber visit");

    const supportRegistration = await register("call-support", "support");
    expect(supportRegistration.agentId).toBe("support");
    expect(supportRegistration.instructions.match(/Agent context:/g)).toHaveLength(1);
    expect(supportRegistration.instructions).toContain("- Name: Support Voice");
    expect(supportRegistration.instructions).not.toContain("Main Voice");

    const unknownRegistration = await register("call-unknown", "unknown");
    expect(unknownRegistration.instructions).not.toContain("Configured identity:");
    expect(unknownRegistration.instructions.match(/Agent context:/g)).toHaveLength(1);
  });

  it.each(["twilio", "telnyx", "plivo"] as const)(
    "fails closed when %s falls back to a local-only webhook",
    async (provider) => {
      await expect(
        createRuntime({
          config: createExternalProviderConfig({ provider }),
        }),
      ).rejects.toThrow(`${provider} requires a publicly reachable webhook URL`);
      expect(mocks.webhookStop).toHaveBeenCalledTimes(1);
    },
  );

  it("fails closed when Twilio publicUrl points at a local-only webhook", async () => {
    await expect(
      createRuntime({
        config: createExternalProviderConfig({
          provider: "twilio",
          publicUrl: "http://127.0.0.1:3334/voice/webhook",
        }),
      }),
    ).rejects.toThrow("twilio requires a publicly reachable webhook URL");
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

    expect(runtime).toMatchObject({
      webhookUrl: "https://voice.example.com/voice/webhook",
      publicUrl: "https://voice.example.com/voice/webhook",
    });
    expect(logger.info).toHaveBeenCalledWith(
      "[voice-call] Webhook URL: https://voice.example.com/voice/webhook",
    );
    expect(logger.info).not.toHaveBeenCalledWith(
      "[voice-call] Public URL: https://voice.example.com/voice/webhook",
    );

    await runtime.stop();
  });

  it("wires realtime consults and keeps outbound calls off inbound number routes", async () => {
    const config = createRealtimeConfig({ tools: [customTool] }, { inboundPolicy: "allowlist" });
    config.numbers["+15550009999"] = {
      agentId: "inbound-route",
      responseModel: "openai/gpt-5.5",
    };
    const runEmbeddedAgent = answeringAgent("Use the shipment status.");
    const agentRuntime = createDefaultConsultRuntime(runEmbeddedAgent);
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

    const handler = await startConsult(config, agentRuntime);

    const tools = requireRealtimeTools();
    expect(tools.map((tool) => requireRecord(tool, "realtime tool").name)).toEqual([
      "openclaw_end_call",
      "openclaw_agent_consult",
      "custom_tool",
    ]);

    await expect(
      handler({ question: "What should I say?" }, "call-1", {
        partialUserTranscript: "Also check the ETA.",
      }),
    ).resolves.toEqual({
      text: "Use the shipment status.",
    });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    const consultParams = consultParamsFrom(runEmbeddedAgent);
    expect(consultParams).toMatchObject({
      agentId: "support",
      sessionKey: "agent:support:voice:15550009999",
      spawnedBy: "agent:main:discord:channel:general",
      messageProvider: "voice",
      lane: "voice",
      provider: "openai",
      model: "gpt-5.4",
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

    const tools = requireRealtimeTools();
    expect(tools.map((tool) => requireRecord(tool, "realtime tool").name)).toEqual([
      "openclaw_end_call",
      "custom_tool",
    ]);
    const endCallTool = requireRecord(tools[0], "end-call tool");
    expectIncludes(endCallTool.description, "final words", "no further reply");
    expect(requireRecord(endCallTool.parameters, "end-call parameters")).toEqual({
      type: "object",
      properties: {},
    });
    expect(mocks.realtimeHandlerRegisterToolHandler).not.toHaveBeenCalled();
  });

  it("rejects a realtime consult whose lifecycle owner already aborted", async () => {
    const config = createRealtimeConfig();
    const runEmbeddedAgent = vi.fn();
    const agentRuntime = createDefaultConsultRuntime(runEmbeddedAgent);
    setConsultCall({ callId: "call-aborted" });

    const handler = await startConsult(config, agentRuntime);

    const controller = new AbortController();
    controller.abort(new Error("voice session replaced"));

    await expect(
      handler({ question: "Check the deployment." }, "call-aborted", {
        abortSignal: controller.signal,
      }),
    ).rejects.toThrow("voice session replaced");
    expect(mocks.resolveRealtimeFastContextConsult).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("canonicalizes restored legacy per-call keys for realtime consults", async () => {
    const config = createRealtimeConfig(
      {},
      { inboundPolicy: "allowlist", sessionScope: "per-call" },
    );
    const runEmbeddedAgent = answeringAgent("Per-call consult answer.");
    const agentRuntime = createDefaultConsultRuntime(runEmbeddedAgent);
    setConsultCall({ sessionKey: "voice:call:call-1" });

    const handler = await startConsult(config, agentRuntime);

    await expect(handler({ question: "What should I say?" }, "call-1", {})).resolves.toEqual({
      text: "Per-call consult answer.",
    });
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(consultParamsFrom(runEmbeddedAgent).sessionKey).toBe("agent:main:voice:call:call-1");
  });

  it("blocks locked Codex realtime consults before fast context or model dispatch", async () => {
    const config = createRealtimeConfig();
    const sessionStore: Record<string, unknown> = {
      "agent:main:voice:15550001234": {
        sessionId: "locked-codex-session",
        updatedAt: 1,
        agentHarnessId: "codex",
        modelSelectionLocked: true,
      },
    };
    const runEmbeddedAgent = vi.fn();
    const agentRuntime = createConsultRuntime(runEmbeddedAgent, sessionStore);
    setConsultCall({ callId: "call-locked" });

    const handler = await startConsult(config, agentRuntime);

    await expect(
      handler({ question: "Continue this session." }, "call-locked", {}),
    ).rejects.toThrow("Model selection is locked for this session.");
    expect(mocks.resolveRealtimeFastContextConsult).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  it("answers realtime consults from fast memory context before starting the full agent", async () => {
    const config = createRealtimeConfig({ fastContext: fastContextConfig(800) });
    const runEmbeddedAgent = answeringAgent("slow answer");
    const agentRuntime = createConsultRuntime(runEmbeddedAgent);
    setConsultCall();
    mocks.resolveRealtimeFastContextConsult.mockResolvedValue({
      handled: true,
      result: {
        text: "Fast OpenClaw memory or session context found.\nThe caller's basement lights are on.",
      },
    });

    const handler = await startConsult(config, agentRuntime);

    const fastContextResult = await handler(
      { question: "Are the basement lights on?" },
      "call-1",
      {},
    );
    const fastContextRecord = requireRecord(fastContextResult, "fast context result");
    expect(fastContextRecord.text).toContain("The caller's basement lights are on.");
    expect(mocks.resolveRealtimeFastContextConsult).toHaveBeenCalledWith({
      cfg: {},
      agentId: "main",
      args: { question: "Are the basement lights on?" },
      config: fastContextConfig(800),
      logger: {
        info: console.log,
        warn: console.warn,
        error: console.error,
        debug: console.debug,
      },
      sessionKey: "agent:main:voice:15550001234",
      labels: {
        audienceLabel: "caller",
        contextName: "OpenClaw memory or session context",
      },
      liveness: { signal: undefined, assertCurrent: expect.any(Function) },
    });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
  });

  describe("fast memory context through the selected memory provider", () => {
    afterEach(() => {
      resetPluginRuntimeStateForTest();
    });

    async function createFastContextHandler() {
      const config = createRealtimeConfig({ fastContext: fastContextConfig(1_000) });
      const { open, search } = registerFastContextMemoryProvider();
      mocks.resolveRealtimeFastContextConsult.mockImplementation(
        expectDefined(mocks.actualRealtimeFastContextConsult, "actual fast context consult"),
      );
      setConsultCall({ state: "active" });
      await createRuntime({
        config,
        agentRuntime: { session: createMockSessionRuntime({}) } as never,
      });
      return { handler: requireRealtimeConsultToolHandler(), open, search };
    }

    it("answers from the provider while the call and consult are live", async () => {
      const { handler, open, search } = await createFastContextHandler();
      const result = await handler({ question: "Are the lights on?" }, "call-1", {
        abortSignal: new AbortController().signal,
      });
      expect(requireRecord(result, "fast context result").text).toContain("Lights are on.");
      expect(open).toHaveBeenCalledOnce();
      expect(search).toHaveBeenCalledOnce();
    });

    it("rejects a consult aborted during lookup before provider I/O", async () => {
      const { handler, open } = await createFastContextHandler();
      const consult = new AbortController();
      const pending = handler({ question: "Are the lights on?" }, "call-1", {
        abortSignal: consult.signal,
      });
      consult.abort(new Error("consult cancelled"));
      await expect(pending).rejects.toThrow("consult cancelled");
      expect(open).not.toHaveBeenCalled();
    });

    it("rejects a call that ends during lookup before provider I/O", async () => {
      const { handler, open } = await createFastContextHandler();
      const pending = handler({ question: "Are the lights on?" }, "call-1", {
        abortSignal: new AbortController().signal,
      });
      mocks.managerGetCall.mockReturnValue(undefined);
      const result = await pending;
      expect(requireRecord(result, "fast context result").text).toContain(
        "No relevant OpenClaw memory or session context was found quickly",
      );
      expect(open).not.toHaveBeenCalled();
    });
  });

  it("uses the configured realtime consult thinking level when set", async () => {
    const config = createRealtimeConfig(
      { consultThinkingLevel: "ultra", consultFastMode: true },
      { inboundPolicy: "allowlist" },
    );
    const runEmbeddedAgent = answeringAgent("Done.");
    const agentRuntime = createDefaultConsultRuntime(runEmbeddedAgent);
    setConsultCall({ direction: "outbound" });

    const handler = await startConsult(config, agentRuntime);

    await expect(handler({ question: "Turn on the lights." }, "call-1", {})).resolves.toEqual({
      text: "Done.",
    });

    expect(agentRuntime.resolveThinkingDefault).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).toHaveBeenCalledOnce();
    expect(consultParamsFrom(runEmbeddedAgent)).toMatchObject({
      thinkLevel: "ultra",
      fastMode: true,
    });
  });
});
