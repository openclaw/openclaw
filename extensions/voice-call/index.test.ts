import { AsyncLocalStorage } from "node:async_hooks";
import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VoiceCallRuntime } from "./runtime-entry.js";
import { normalizeVoiceCallConfig } from "./src/config.js";
import type { CallRecord } from "./src/types.js";

let runtimeStub: VoiceCallRuntime;
const callGatewayFromCliMock = vi.hoisted(() => vi.fn());

vi.mock("./runtime-entry.js", () => ({
  createVoiceCallRuntime: vi.fn(async () => runtimeStub),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/gateway-runtime")>()),
  callGatewayFromCli: callGatewayFromCliMock,
}));

import {
  createVoiceCallLogger,
  createVoiceCallServiceContext,
  registerVoiceCall,
  type VoiceCallTestTool,
} from "./index.test-harness.js";
import { createVoiceCallRuntime } from "./runtime-entry.js";

const noopLogger = createVoiceCallLogger();

type TestGatewayHandler = (ctx: {
  params: Record<string, unknown>;
  client?: { internal?: { pluginRuntimeOwnerId?: string } };
  respond: ReturnType<typeof vi.fn>;
}) => Promise<void>;

type Registered = ReturnType<typeof setup>;
type RespondCall = [
  ok: boolean,
  payload?: Record<string, unknown>,
  error?: { code?: unknown; message?: unknown },
];

function createRuntimeStub(callId = "call-1"): VoiceCallRuntime {
  const call = createCallRecord({ callId });
  return {
    config: normalizeVoiceCallConfig({ toNumber: "+15550001234", realtime: { enabled: false } }),
    manager: {
      initiateCall: vi.fn(async () => ({ callId, success: true })),
      continueCall: vi.fn(async () => ({ success: true, transcript: "hello" })),
      speak: vi.fn(async () => ({ success: true })),
      sendDtmf: vi.fn(async () => ({ success: true })),
      getCall: vi.fn((id: string) => (id === callId ? call : undefined)),
      getCallByProviderCallId: vi.fn(() => undefined),
      getCallFromMemoryOrStore: vi.fn(async (id: string) => (id === callId ? call : undefined)),
      getActiveCalls: vi.fn(() => [call]),
    } as unknown as VoiceCallRuntime["manager"],
    webhookServer: {
      speakRealtime: vi.fn(() => ({ success: false, error: "No active realtime bridge for call" })),
    } as unknown as VoiceCallRuntime["webhookServer"],
    stop: vi.fn(async () => {}),
  };
}

function createCallRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    ...redactedStatus,
    from: "+15550001111",
    to: "+15550001234",
    transcript: [],
    processedEventIds: [],
    ...overrides,
  };
}

const createServiceContext = () => createVoiceCallServiceContext({ logger: noopLogger });

function setup(config: Record<string, unknown> = { provider: "mock" }) {
  return registerVoiceCall({ config, logger: noopLogger });
}

async function setupActive(config: Record<string, unknown> = { provider: "mock" }) {
  const registered = setup(config);
  await registered.service.start(createServiceContext());
  return registered;
}

async function invokeGateway(
  methods: Registered["methods"],
  method: string,
  params: Record<string, unknown>,
  client?: Parameters<TestGatewayHandler>[0]["client"],
) {
  const respond = vi.fn();
  await (methods.get(method) as TestGatewayHandler | undefined)?.({ params, client, respond });
  const call = respond.mock.calls[0];
  if (!call) {
    throw new Error("Expected gateway response");
  }
  return call as RespondCall;
}

async function activeTool(context: Record<string, unknown> = {}) {
  const registered = setup();
  const tool = registered.toolFactory(context);
  await registered.service.start(createServiceContext());
  return tool;
}

async function gateway(
  method: string,
  params: Record<string, unknown>,
  client?: Parameters<typeof invokeGateway>[3],
) {
  return invokeGateway((await setupActive()).methods, method, params, client);
}

function twilioConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: "twilio",
    fromNumber: "+15550001234",
    twilio: { accountSid: "AC123", authToken: "token" },
    ...overrides,
  };
}

function completedCall(endedAt = Date.UTC(2026, 4, 2, 9, 18, 23)) {
  return createCallRecord({
    providerCallId: "CA123",
    state: "completed",
    endReason: "completed",
    endedAt,
  });
}

function expectCliGatewayCall(method: string, params: unknown, timeout = "5000") {
  expect(callGatewayFromCliMock).toHaveBeenCalledWith(method, { json: true, timeout }, params, {
    progress: false,
  });
}

function clearTwilioEnv() {
  for (const name of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM_NUMBER"]) {
    vi.stubEnv(name, "");
  }
}

const redactedStatus = {
  callId: "call-1",
  provider: "mock",
  direction: "outbound",
  state: "active",
  startedAt: Date.UTC(2026, 4, 2, 9, 0, 0),
} satisfies Partial<CallRecord>;

async function registerVoiceCallCli(
  program: Command,
  pluginConfig: Record<string, unknown> = { provider: "mock" },
) {
  await setup(pluginConfig).cli({ program, parentPath: [], config: {}, logger: noopLogger });
}

async function runVoiceCallCli(
  args: string[],
  pluginConfig: Record<string, unknown> = { provider: "mock" },
): Promise<string> {
  vi.stubEnv("OPENCLAW_CLI", "1");
  const program = new Command();
  let output = "";
  const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write);
  try {
    await registerVoiceCallCli(program, pluginConfig);
    await program.parseAsync(["voicecall", ...args], { from: "user" });
    return output;
  } finally {
    writeSpy.mockRestore();
  }
}

beforeEach(() => {
  Object.values(noopLogger).forEach((log) => log.mockClear());
  runtimeStub = createRuntimeStub();
  callGatewayFromCliMock.mockReset();
  callGatewayFromCliMock.mockRejectedValue(
    Object.assign(new Error("gateway transport failed"), {
      name: "GatewayTransportError",
      kind: "closed",
      connectionDetails: { url: "ws://127.0.0.1:18789" },
    }),
  );
  vi.mocked(createVoiceCallRuntime).mockReset();
  vi.mocked(createVoiceCallRuntime).mockImplementation(async () => runtimeStub);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.voice-call.runtimeCoordinator")
  ];
});

it("defaults canonical plugin config to an enabled mock runtime", async () => {
  await setupActive({});
  expect(vi.mocked(createVoiceCallRuntime).mock.calls[0]?.[0].config).toMatchObject({
    enabled: true,
    provider: "mock",
  });
});

it("does not start the webhook runtime for CLI-only plugin loading", async () => {
  vi.stubEnv("OPENCLAW_CLI", "1");
  await setupActive();
  expect(createVoiceCallRuntime).not.toHaveBeenCalled();
});

it("reports incomplete provider setup through service health and gateway commands", async () => {
  clearTwilioEnv();
  const { service, methods } = setup({ provider: "twilio" });
  const reportFailure = vi.fn();

  await service?.start({
    ...createServiceContext(),
    serviceHealth: { reportFailure, clearFailure: vi.fn() },
  });

  expect(noopLogger.error.mock.calls.flat().join("\n")).toContain("TWILIO_ACCOUNT_SID");
  expect(reportFailure).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("TWILIO_ACCOUNT_SID") }),
  );
  const [ok, payload, error] = await invokeGateway(methods, "voicecall.initiate", {
    message: "Hi",
    to: "+15550001234",
  });

  expect(createVoiceCallRuntime).not.toHaveBeenCalled();
  expect([ok, payload, error]).toEqual([
    false,
    undefined,
    expect.objectContaining({
      code: "UNAVAILABLE",
      message: expect.stringContaining("TWILIO_ACCOUNT_SID"),
    }),
  ]);
});

it("registers voice call gateway methods with least-privilege scopes", () => {
  const { methodScopes } = setup();

  for (const method of [
    "initiate",
    "start",
    "continue",
    "continue.start",
    "speak",
    "dtmf",
    "end",
  ]) {
    expect(methodScopes.get(`voicecall.${method}`)).toBe("operator.write");
  }
  expect(methodScopes.get("voicecall.continue.result")).toBe("operator.read");
  expect(methodScopes.get("voicecall.status")).toBe("operator.read");
});

it("preserves legacy start options and accepts agent routing from plugin runtime", async () => {
  const respond = await gateway(
    "voicecall.start",
    {
      to: "+15550001234",
      agentId: "support",
      dtmfSequence: "ww123456#",
      message: "Hi",
      mode: "conversation",
    },
    { internal: { pluginRuntimeOwnerId: "google-meet" } },
  );

  expect(runtimeStub.manager["initiateCall"]).toHaveBeenCalledWith("+15550001234", undefined, {
    agentId: "support",
    dtmfSequence: "ww123456#",
    message: "Hi",
    mode: "conversation",
  });
  expect(respond[0]).toBe(true);
});

it("rejects external per-call agent routing", async () => {
  const { methods } = setup();
  const respond = await invokeGateway(methods, "voicecall.start", {
    to: "+15550001234",
    agentId: "spoofed",
  });

  expect(runtimeStub.manager["initiateCall"]).not.toHaveBeenCalled();
  expect(respond[2]?.code).toBe("INVALID_REQUEST");
});

it.each(["single", "list"])("returns redacted %s call status", async (mode) => {
  const call = createCallRecord({
    metadata: { requesterSessionKey: "agent:main:discord:channel:general" },
    processedEventIds: ["evt-1"],
    sessionKey: "agent:main:voice:call-1",
    transcript: [{ timestamp: 1, speaker: "user", text: "private call transcript", isFinal: true }],
  });
  if (mode === "single") {
    runtimeStub.manager.getCallFromMemoryOrStore = vi.fn(async () => call);
  } else {
    runtimeStub.manager.getActiveCalls = vi.fn(() => [call]);
  }
  const [ok, payload] = await gateway(
    "voicecall.status",
    mode === "single" ? { callId: "call-1" } : {},
  );
  expect(ok).toBe(true);
  expect(payload?.found).toBe(true);
  const calls = mode === "single" ? [payload?.call] : payload?.calls;
  expect(calls).toEqual([redactedStatus]);
});

it.each(["gateway", "tool"])("sends DTMF through the %s adapter", async (adapter) => {
  const params = { callId: "call-1", digits: "ww123#" };
  if (adapter === "gateway") {
    expect(await gateway("voicecall.dtmf", params)).toEqual([true, { success: true }]);
  } else {
    const tool = await activeTool();
    expect((await tool.execute("id", { action: "send_dtmf", ...params })).details.success).toBe(
      true,
    );
  }
  expect(runtimeStub.manager["sendDtmf"]).toHaveBeenCalledWith("call-1", "ww123#");
});

it("does not fall back to one-shot TwiML speak when realtime-only speech is requested", async () => {
  runtimeStub.config.realtime.enabled = true;
  const speakRealtime = vi.spyOn(runtimeStub.webhookServer, "speakRealtime");
  const respond = await gateway("voicecall.speak", {
    allowTwimlFallback: false,
    callId: "call-1",
    message: "hello",
  });

  expect(speakRealtime).toHaveBeenCalledWith("call-1", "hello");
  expect(runtimeStub.manager["speak"]).not.toHaveBeenCalled();
  expect(respond).toEqual([true, { success: false, error: "No active realtime bridge for call" }]);
});

it.each([true, false])("uses realtime speech or classic fallback (%s)", async (realtime) => {
  runtimeStub.config.realtime.enabled = true;
  const speakRealtime = vi.spyOn(runtimeStub.webhookServer, "speakRealtime");
  const speak = vi.spyOn(runtimeStub.manager, "speak");
  if (realtime) {
    runtimeStub.manager.getCall = vi.fn(() => undefined);
    runtimeStub.manager.getCallByProviderCallId = vi.fn(() =>
      createCallRecord({ callId: "call-1", providerCallId: "CA123" }),
    );
    speakRealtime.mockReturnValue({ success: true });
  }
  const result = await (
    await activeTool()
  ).execute("id", {
    action: "speak_to_user",
    callId: realtime ? "CA123" : "call-1",
    message: "hello",
  });
  expect(speakRealtime).toHaveBeenCalledWith("call-1", "hello");
  expect(speak.mock.calls).toEqual(realtime ? [] : [["call-1", "hello"]]);
  expect(result.details.success).toBe(true);
});

it.each([Date.UTC(2026, 4, 2, 9, 18, 23), Number.POSITIVE_INFINITY])(
  "reports stale call history with endedAt=%s",
  async (endedAt) => {
    runtimeStub.manager.getCall = vi.fn(() => undefined);
    runtimeStub.manager.getCallFromMemoryOrStore = vi.fn(async () => completedCall(endedAt));
    const [ok, , error] = await gateway("voicecall.speak", {
      callId: "CA123",
      message: "hello",
    });
    expect(ok).toBe(false);
    expect(error?.message).toContain("call is not active");
    expect(error?.message).toContain("last state=completed");
    expect(error?.message).toContain("endReason=completed");
    if (!Number.isFinite(endedAt)) {
      expect(error?.message).not.toContain("endedAt=");
    }
    expect(runtimeStub.manager["speak"]).not.toHaveBeenCalled();
  },
);

it.each([{ action: "initiate_call", message: "Hello" }, { message: "Hello" }])(
  "freezes invocation context for tool-created calls ($action)",
  async (params) => {
    const tool = await activeTool({
      agentId: "support",
      sessionKey: "agent:support:discord:channel:general",
    });

    await tool.execute("id", {
      ...params,
      to: "+15550001234",
      requesterSessionKey: "agent:spoofed:requester",
      sessionKey: "agent:support:voice:call-1",
    });

    expect(runtimeStub.manager["initiateCall"]).toHaveBeenCalledWith(
      "+15550001234",
      "agent:support:voice:call-1",
      expect.objectContaining({
        agentId: "support",
        message: "Hello",
        requesterSessionKey: "agent:support:discord:channel:general",
      }),
    );
  },
);

it("does not expose requester session identity to the model", () => {
  expect(JSON.stringify(setup().tool().parameters)).not.toContain("requesterSessionKey");
});

it.each([true, false])("tool get_status uses persisted fallback (found=%s)", async (found) => {
  runtimeStub.manager.getCallFromMemoryOrStore = vi.fn(async () =>
    found ? completedCall() : undefined,
  );
  const tool = await activeTool();
  const result = await tool.execute("id", { action: "get_status", callId: "call-1" });
  expect(runtimeStub.manager["getCallFromMemoryOrStore"]).toHaveBeenCalledWith("call-1");
  expect(result.details).toMatchObject(
    found ? { found: true, call: { state: "completed" } } : { found: false },
  );
});

it("legacy tool status without sid returns error payload", async () => {
  const tool = await activeTool();
  const result = await tool.execute("id", { mode: "status" });
  expect(String(result.details.error)).toContain("sid required");
});

it("CLI rejects invalid numeric options", async () => {
  const program = new Command();
  await registerVoiceCallCli(program);
  for (const [command, option] of [
    ["expose", "--port"],
    ["latency", "--last"],
  ] as const) {
    for (const value of ["nope", "Infinity", "1.5"]) {
      await expect(
        program.parseAsync(["voicecall", command, option, value], { from: "user" }),
      ).rejects.toThrow(`Invalid numeric value for ${option}`);
    }
  }
});

it("CLI start delegates to the running gateway runtime", async () => {
  callGatewayFromCliMock.mockResolvedValueOnce({ callId: "gateway-call", initiated: true });

  const output = await runVoiceCallCli(["start", "--to", "+1", "--message", "Hello"]);
  expectCliGatewayCall(
    "voicecall.start",
    { to: "+1", message: "Hello", mode: "conversation" },
    "35000",
  );
  expect(createVoiceCallRuntime).not.toHaveBeenCalled();
  expect(output).toContain('"callId": "gateway-call"');
});

it("responds with protocol errors for delegated gateway failures", async () => {
  expect(await invokeGateway(setup().methods, "voicecall.start", {})).toEqual([
    false,
    undefined,
    { code: "INVALID_REQUEST", message: "to required" },
  ]);
});

it("starts and polls delegated gateway continue operations", async () => {
  callGatewayFromCliMock
    .mockResolvedValueOnce({
      operationId: "op-1",
      status: "pending",
      pollTimeoutMs: 180000,
    })
    .mockResolvedValueOnce({
      operationId: "op-1",
      status: "completed",
      result: { success: true, transcript: "gateway hello" },
    });

  const output = await runVoiceCallCli(["continue", "--call-id", "call-1", "--message", "Hello"], {
    provider: "mock",
    transcriptTimeoutMs: 120000,
    tts: { timeoutMs: 30000 },
  });
  expectCliGatewayCall("voicecall.continue.start", { callId: "call-1", message: "Hello" }, "35000");
  expect(callGatewayFromCliMock).toHaveBeenCalledWith(
    "voicecall.continue.result",
    { json: true, timeout: "5000" },
    { operationId: "op-1" },
    { progress: false, signal: expect.any(AbortSignal) },
  );
  expect(createVoiceCallRuntime).not.toHaveBeenCalled();
  expect(output).toContain('"transcript": "gateway hello"');
});

it("caps gateway continue poll timeouts from voice and TTS configuration", async () => {
  const continuation = createDeferred<{ success: true; transcript: string }>();
  runtimeStub.manager.continueCall = vi.fn(async () => await continuation.promise);
  const { methods } = await setupActive();
  runtimeStub.config.transcriptTimeoutMs = Number.MAX_SAFE_INTEGER;
  runtimeStub.config.tts = { timeoutMs: Number.MAX_SAFE_INTEGER };
  try {
    const [ok, payload] = await invokeGateway(methods, "voicecall.continue.start", {
      callId: "call-1",
      message: "Hello",
    });
    expect(ok).toBe(true);
    expect(payload?.pollTimeoutMs).toBe(MAX_TIMER_TIMEOUT_MS);
  } finally {
    continuation.resolve({ success: true, transcript: "finished" });
    await continuation.promise;
  }
});

it("gateway continue operations return pending, completed, and failed results", async () => {
  runtimeStub.config.transcriptTimeoutMs = 120000;
  const continuation = createDeferred<{ success: true; transcript: string }>();
  runtimeStub.manager.continueCall = vi.fn(async () => await continuation.promise);
  const { methods } = await setupActive({
    provider: "mock",
    transcriptTimeoutMs: 120000,
    tts: { timeoutMs: 30000 },
  });
  const start = (message: string) =>
    invokeGateway(methods, "voicecall.continue.start", { callId: "call-1", message });
  const result = (operationId: unknown) =>
    invokeGateway(methods, "voicecall.continue.result", { operationId });
  const [, startPayload] = await start("Hello");
  expect(startPayload?.pollTimeoutMs).toBe(180000);
  expect(runtimeStub.manager["continueCall"]).toHaveBeenCalledWith("call-1", "Hello");
  expect(await result(startPayload?.operationId)).toMatchObject([true, { status: "pending" }]);

  continuation.resolve({ success: true, transcript: "gateway hello" });
  await continuation.promise;
  await vi.waitFor(async () => {
    expect(await result(startPayload?.operationId)).toEqual([
      true,
      {
        operationId: startPayload?.operationId,
        status: "completed",
        result: { success: true, transcript: "gateway hello" },
      },
    ]);
  });
  expect(await result(startPayload?.operationId)).toEqual([
    false,
    undefined,
    { code: "INVALID_REQUEST", message: "operation not found" },
  ]);

  runtimeStub.manager.continueCall = vi.fn(async () => ({ success: false, error: "turn failed" }));
  const [, failedStart] = await start("Try again");
  await vi.waitFor(async () => {
    expect(await result(failedStart?.operationId)).toMatchObject([
      true,
      { status: "failed", error: "turn failed" },
    ]);
  });
});

it.each([undefined, "http://127.0.0.1:3334/voice/webhook"])(
  "CLI setup reports invalid webhook exposure (%s) as JSON",
  async (publicUrl) => {
    const config = twilioConfig({ publicUrl });
    const parsed = JSON.parse(await runVoiceCallCli(["setup", "--json"], config)) as {
      ok?: boolean;
      checks?: Array<{ id: string; ok: boolean; message: string }>;
    };
    expect(parsed.ok).toBe(false);
    const exposure = parsed.checks?.find((check) => check.id === "webhook-exposure");
    expect(exposure?.ok).toBe(false);
    if (publicUrl) {
      expect(exposure?.message).toContain("local/private");
    }
  },
);

it("CLI status reads the gateway without starting telephony", async () => {
  callGatewayFromCliMock.mockResolvedValueOnce({
    found: true,
    calls: [{ callId: "gateway-call" }],
  });
  expect(JSON.parse(await runVoiceCallCli(["status", "--json"]))).toEqual({
    found: true,
    calls: [{ callId: "gateway-call" }],
  });
  expect(createVoiceCallRuntime).not.toHaveBeenCalled();
  expectCliGatewayCall("voicecall.status", undefined);
});

it("CLI setup and smoke check readiness without placing a live call", async () => {
  const config = twilioConfig({ publicUrl: "https://voice.example.com/voice/webhook" });
  expect(await runVoiceCallCli(["setup"], config)).toContain("Voice Call setup: OK");
  const output = await runVoiceCallCli(["smoke", "--to", "+15550009999"], config);
  expect(output).toContain("Voice Call setup: OK");
  expect(output).toContain("OK provider: Provider configured: twilio");
  expect(output).toContain("live-call: dry run for +15550009999");
  expect(runtimeStub.manager["initiateCall"]).not.toHaveBeenCalled();
});

describe("runtime lifecycle", () => {
  const serviceHealth = { reportFailure: vi.fn(), clearFailure: vi.fn() };
  const serviceContext = createVoiceCallServiceContext({ serviceHealth });
  const createRuntime = vi.mocked(createVoiceCallRuntime);

  function runtime(callId = "call-a", stopImpl = async () => {}) {
    const initiateCall = vi.fn(async () => ({ callId, success: true }));
    const stop = vi.fn(stopImpl);
    return {
      initiateCall,
      stop,
      value: {
        config: { toNumber: "+15550000001", realtime: { enabled: false } },
        manager: { initiateCall },
        stop,
      } as unknown as VoiceCallRuntime,
    };
  }

  const call = (tool: VoiceCallTestTool) =>
    tool.execute("call", { action: "initiate_call", message: "hello" });
  function expectError(result: Awaited<ReturnType<typeof call>>, text: string) {
    const error =
      typeof result.details.error === "string"
        ? result.details.error
        : JSON.stringify(result.details.error ?? "");
    expect(error).toContain(text);
    expect(result.content?.some((entry) => entry.text?.includes(error))).toBe(true);
  }
  const gatewayCall = async (registration: Registered, callId: string) =>
    expect(
      await invokeGateway(registration.methods, "voicecall.initiate", { message: "hello" }),
    ).toEqual([true, { callId, initiated: true }]);

  beforeEach(() => {
    createRuntime.mockReset();
    serviceHealth.reportFailure.mockReset();
    serviceHealth.clearFailure.mockReset();
  });
  it("requires service startup before enabling requester reporting", async () => {
    const registration = registerVoiceCall({ config: { reports: { enabled: true } } });
    expectError(await call(registration.tool()), "requires service startup");
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("retains tool routing and isolated service contexts across replacement and restart", async () => {
    const actor = new AsyncLocalStorage<string>();
    const stopping = createDeferred<void>();
    const release = createDeferred<void>();
    const a = runtime("call-a", () => {
      stopping.resolve();
      return release.promise;
    });
    const b = runtime("call-b");
    const restarted = runtime("call-restarted");
    createRuntime
      .mockResolvedValueOnce(a.value)
      .mockResolvedValueOnce(b.value)
      .mockResolvedValueOnce(restarted.value);
    const register = (toNumber: string) =>
      registerVoiceCall({ config: { toNumber, reports: { enabled: true } } });
    const aService = register("+15550000001");
    const concrete = aService.tool();
    const invoke = (tool: VoiceCallTestTool) => actor.run("requesting-caller", () => call(tool));
    const start = (service: ReturnType<typeof register>, name: string) =>
      actor.run(name, () => service.service.start(serviceContext));
    const readContext = (index: number) =>
      actor.run("requesting-caller", () =>
        createRuntime.mock.calls[index]?.[0].runInServiceContext?.(() => actor.getStore()),
      );
    expect(start(aService, "service-a")).toBeUndefined();
    await invoke(concrete);
    const cold = registerVoiceCall({ registrationMode: "tool-discovery" }).toolFactory({});
    const bService = register("+15550000002");
    const bTool = bService.tool();
    await invoke(concrete);
    await invoke(cold);
    expect(a.initiateCall).toHaveBeenCalledTimes(3);
    expect(readContext(0)).toBe("service-a");
    const stopped = aService.service.stop?.(serviceContext);
    await stopping.promise;
    expect(createRuntime).toHaveBeenCalledTimes(1);
    release.resolve();
    await stopped;
    void start(bService, "service-b");
    await invoke(concrete);
    await invoke(cold);
    await aService.service.stop?.(serviceContext);
    await invoke(bTool);
    await gatewayCall(bService, "call-b");
    expect(b.initiateCall).toHaveBeenCalledTimes(4);
    expect(createRuntime.mock.calls[1]?.[0].config.toNumber).toBe("+15550000002");
    expect([readContext(0), readContext(1)]).toEqual(["service-a", "service-b"]);
    await bService.service.stop?.(serviceContext);
    expect(b.stop).toHaveBeenCalledOnce();
    expectError(await invoke(concrete), "requires service startup");
    expectError(await invoke(cold), "requires service startup");
    void start(bService, "service-b-restarted");
    await invoke(bTool);
    await gatewayCall(bService, "call-restarted");
    expect(restarted.initiateCall).toHaveBeenCalledTimes(2);
    expect(createRuntime).toHaveBeenCalledTimes(3);
    expect(a.stop).toHaveBeenCalledOnce();
  });

  it.each([false, true])("settles pending startup (stopping=%s)", async (stopping) => {
    const ready = createDeferred<VoiceCallRuntime>();
    const fixture = runtime();
    const logger = createVoiceCallLogger();
    createRuntime.mockReturnValue(ready.promise);
    const full = registerVoiceCall({ logger });
    expect(full.service.start(serviceContext)).toBeUndefined();
    if (stopping) {
      const stopped = full.service.stop?.(serviceContext);
      ready.resolve(fixture.value);
      await stopped;
      expect(fixture.stop).toHaveBeenCalledOnce();
      expect(logger.error).not.toHaveBeenCalled();
      expectError(await call(full.tool()), "not running");
    } else {
      const discovery = registerVoiceCall({ registrationMode: "tool-discovery" });
      const calls = [call(full.tool()), call(discovery.tool())];
      expect(createRuntime).toHaveBeenCalledTimes(1);
      ready.resolve(fixture.value);
      await Promise.all(calls);
      expect(fixture.initiateCall).toHaveBeenCalledTimes(2);
    }
    expect(createRuntime).toHaveBeenCalledTimes(1);
  });

  it("keeps the service runtime after a failed consult is cleaned up", async () => {
    const fixture = runtime();
    createRuntime.mockResolvedValue(fixture.value);
    const service = registerVoiceCall({});
    void service.service.start(serviceContext);
    await call(service.tool());
    const consult = registerVoiceCall({ registrationMode: "tool-discovery" });
    fixture.initiateCall.mockRejectedValueOnce(
      new Error("agent harness host capability is no longer active"),
    );
    expectError(await call(consult.tool()), "host capability is no longer active");
    await consult.service.stop?.(serviceContext);
    await gatewayCall(service, "call-a");
    expect(fixture.stop).not.toHaveBeenCalled();
    expect(createRuntime).toHaveBeenCalledTimes(1);
  });

  it("logs a genuine startup failure and retries the same generation", async () => {
    const logged = createDeferred<string>();
    const fixture = runtime();
    createRuntime
      .mockRejectedValueOnce(new Error("provider boom"))
      .mockResolvedValueOnce(fixture.value);
    const service = registerVoiceCall({ logger: createVoiceCallLogger(logged.resolve) });
    void service.service.start(serviceContext);
    await expect(logged.promise).resolves.toContain("Failed to start runtime: provider boom");
    expect(serviceHealth.reportFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "provider boom" }),
    );
    await call(service.tool());
    expect(createRuntime).toHaveBeenCalledTimes(2);
    expect(fixture.initiateCall).toHaveBeenCalledOnce();
    expect(serviceHealth.clearFailure).toHaveBeenCalled();
  });
});
