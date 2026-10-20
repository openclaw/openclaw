import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { MAX_TIMER_TIMEOUT_MS } from "openclaw/plugin-sdk/number-runtime";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
  error?: {
    code?: unknown;
    message?: unknown;
  },
];

function createRuntimeStub(callId = "call-1"): VoiceCallRuntime {
  const call = createCallRecord({ callId });
  return {
    config: normalizeVoiceCallConfig({
      toNumber: "+15550001234",
      realtime: { enabled: false },
    }),
    provider: {} as VoiceCallRuntime["provider"],
    manager: {
      initiateCall: vi.fn(async () => ({ callId, success: true })),
      continueCall: vi.fn(async () => ({ success: true, transcript: "hello" })),
      speak: vi.fn(async () => ({ success: true })),
      sendDtmf: vi.fn(async () => ({ success: true })),
      endCall: vi.fn(async () => ({ success: true })),
      getCall: vi.fn((id: string) => (id === callId ? call : undefined)),
      getCallByProviderCallId: vi.fn(() => undefined),
      getCallFromMemoryOrStore: vi.fn(async (id: string) => (id === callId ? call : undefined)),
      getActiveCalls: vi.fn(() => [call]),
      getCallHistory: vi.fn(async () => []),
    } as unknown as VoiceCallRuntime["manager"],
    webhookServer: {
      speakRealtime: vi.fn(() => ({ success: false, error: "No active realtime bridge for call" })),
    } as unknown as VoiceCallRuntime["webhookServer"],
    webhookUrl: "http://127.0.0.1:3334/voice/webhook",
    publicUrl: null,
    stop: vi.fn(async () => {}),
  };
}

function createCallRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-1",
    provider: "mock",
    direction: "outbound",
    state: "active",
    from: "+15550001111",
    to: "+15550001234",
    startedAt: Date.UTC(2026, 4, 2, 9, 0, 0),
    transcript: [],
    processedEventIds: [],
    ...overrides,
  };
}

function createPrivateCallRecord(): CallRecord {
  return createCallRecord({
    metadata: { requesterSessionKey: "agent:main:discord:channel:general" },
    processedEventIds: ["evt-1"],
    sessionKey: "agent:main:voice:call-1",
    transcript: [
      {
        timestamp: Date.UTC(2026, 4, 2, 9, 1, 0),
        speaker: "user",
        text: "private call transcript",
        isFinal: true,
      },
    ],
  });
}

const createServiceContext = () => createVoiceCallServiceContext({ logger: noopLogger });

function setup(config: Record<string, unknown>, toolContext: Record<string, unknown> = {}) {
  const registered = registerVoiceCall({ config, logger: noopLogger });
  return { ...registered, tools: [registered.toolFactory(toolContext)] as const };
}

async function setupActive(
  config: Record<string, unknown>,
  toolContext: Record<string, unknown> = {},
): Promise<Registered> {
  const registered = setup(config, toolContext);
  await registered.service?.start(createServiceContext());
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
  return (await setupActive({ provider: "mock" }, context)).tools[0];
}

function twilioConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: "twilio",
    fromNumber: "+15550001234",
    twilio: { accountSid: "AC123", authToken: "token" },
    ...overrides,
  };
}

function mockHistoricalCall(endedAt: number) {
  runtimeStub.manager.getCall = vi.fn(() => undefined);
  runtimeStub.manager.getCallByProviderCallId = vi.fn(() => undefined);
  runtimeStub.manager.getCallFromMemoryOrStore = vi.fn(async () =>
    createCallRecord({
      providerCallId: "CA123",
      state: "completed",
      endReason: "completed",
      endedAt,
    }),
  );
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

function firstRuntimeConfig() {
  return vi.mocked(createVoiceCallRuntime).mock.calls[0]?.[0].config;
}

const redactedStatus = {
  callId: "call-1",
  provider: "mock",
  direction: "outbound",
  state: "active",
  startedAt: Date.UTC(2026, 4, 2, 9, 0, 0),
};

async function registerVoiceCallCli(
  program: Command,
  pluginConfig: Record<string, unknown> = { provider: "mock" },
) {
  const registrar = setup(pluginConfig).cli;
  if (!registrar) {
    throw new Error("voice-call CLI registrar was not registered");
  }
  await registrar({ program, parentPath: [], config: {}, logger: noopLogger });
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
  noopLogger.info.mockClear();
  noopLogger.warn.mockClear();
  noopLogger.error.mockClear();
  noopLogger.debug.mockClear();
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
  const { service } = setup({});

  await service?.start(createServiceContext());

  expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);
  expect(firstRuntimeConfig()).toMatchObject({ enabled: true, provider: "mock" });
});

it("does not start the webhook runtime for CLI-only plugin loading", async () => {
  vi.stubEnv("OPENCLAW_CLI", "1");
  const { service } = setup({ provider: "mock" });

  await service?.start(createServiceContext());

  expect(createVoiceCallRuntime).not.toHaveBeenCalled();
});

it("reports degraded service health when provider setup is incomplete", async () => {
  clearTwilioEnv();
  const { service } = setup({ provider: "twilio" });
  const reportFailure = vi.fn();

  await service?.start({
    ...createServiceContext(),
    serviceHealth: { reportFailure, clearFailure: vi.fn() },
  });

  expect(createVoiceCallRuntime).not.toHaveBeenCalled();
  expect(noopLogger.error.mock.calls.flat().join("\n")).toContain(
    "Runtime not started: setup incomplete",
  );
  expect(noopLogger.error.mock.calls.flat().join("\n")).toContain("TWILIO_ACCOUNT_SID");
  expect(reportFailure).toHaveBeenCalledWith(
    expect.objectContaining({ message: expect.stringContaining("TWILIO_ACCOUNT_SID") }),
  );
});

it("registers Twilio configs with SecretRef auth tokens", async () => {
  const authToken = { source: "env", provider: "default", id: "TWILIO_AUTH_TOKEN" };
  const { service } = setup(
    twilioConfig({ enabled: true, twilio: { accountSid: "AC123", authToken } }),
  );

  await service?.start(createServiceContext());

  expect(createVoiceCallRuntime).toHaveBeenCalledTimes(1);
  expect(firstRuntimeConfig()?.twilio?.authToken).toEqual(authToken);
});

it("still reports missing provider setup when a command needs the runtime", async () => {
  clearTwilioEnv();
  const { methods } = setup({ provider: "twilio" });
  const respond = await invokeGateway(methods, "voicecall.initiate", {
    message: "Hi",
    to: "+15550001234",
  });

  expect(createVoiceCallRuntime).not.toHaveBeenCalled();
  const [ok, payload, error] = respond;
  expect(ok).toBe(false);
  expect(payload).toBeUndefined();
  expect(String(error?.message)).toContain("TWILIO_ACCOUNT_SID");
});

it("registers voice call gateway methods with least-privilege scopes", () => {
  const { methodScopes } = setup({ provider: "mock" });

  for (const method of [
    "voicecall.initiate",
    "voicecall.start",
    "voicecall.continue",
    "voicecall.continue.start",
    "voicecall.speak",
    "voicecall.dtmf",
    "voicecall.end",
  ]) {
    expect(methodScopes.get(method)).toBe("operator.write");
  }
  expect(methodScopes.get("voicecall.continue.result")).toBe("operator.read");
  expect(methodScopes.get("voicecall.status")).toBe("operator.read");
});

it("preserves mode on legacy voicecall.start", async () => {
  const { methods } = await setupActive({ provider: "mock" });
  const respond = await invokeGateway(methods, "voicecall.start", {
    dtmfSequence: "ww123456#",
    message: "Hi",
    mode: "conversation",
    to: "+15550001234",
  });
  expect(runtimeStub.manager["initiateCall"]).toHaveBeenCalledWith("+15550001234", undefined, {
    dtmfSequence: "ww123456#",
    message: "Hi",
    mode: "conversation",
  });
  expect(respond[0]).toBe(true);
});

it("accepts per-call agent routing only from plugin runtime", async () => {
  const { methods } = await setupActive({ provider: "mock" });
  const respond = await invokeGateway(
    methods,
    "voicecall.start",
    { to: "+15550001234", agentId: "support" },
    { internal: { pluginRuntimeOwnerId: "google-meet" } },
  );

  expect(runtimeStub.manager["initiateCall"]).toHaveBeenCalledWith(
    "+15550001234",
    undefined,
    expect.objectContaining({ agentId: "support" }),
  );
  expect(respond[0]).toBe(true);
});

it("rejects external per-call agent routing", async () => {
  const { methods } = setup({ provider: "mock" });
  const respond = await invokeGateway(methods, "voicecall.start", {
    to: "+15550001234",
    agentId: "spoofed",
  });

  expect(runtimeStub.manager["initiateCall"]).not.toHaveBeenCalled();
  expect(respond[2]?.code).toBe("INVALID_REQUEST");
});

it.each(["single", "list"])("returns redacted %s call status", async (mode) => {
  const call = createPrivateCallRecord();
  if (mode === "single") {
    runtimeStub.manager.getCallFromMemoryOrStore = vi.fn(async () => call);
  } else {
    runtimeStub.manager.getActiveCalls = vi.fn(() => [call]);
  }
  const { methods } = await setupActive({ provider: "mock" });
  const [ok, payload] = await invokeGateway(
    methods,
    "voicecall.status",
    mode === "single" ? { callId: "call-1" } : {},
  );
  expect(ok).toBe(true);
  expect(payload?.found).toBe(true);
  const calls = mode === "single" ? [payload?.call] : payload?.calls;
  expect(calls).toEqual([redactedStatus]);
});

it("sends DTMF via voicecall.dtmf", async () => {
  const { methods } = await setupActive({ provider: "mock" });
  const respond = await invokeGateway(methods, "voicecall.dtmf", {
    callId: "call-1",
    digits: "ww123#",
  });

  expect(runtimeStub.manager["sendDtmf"]).toHaveBeenCalledWith("call-1", "ww123#");
  expect(respond).toEqual([true, { success: true }]);
});

it("does not fall back to one-shot TwiML speak when realtime-only speech is requested", async () => {
  runtimeStub.config.realtime.enabled = true;
  const { methods } = await setupActive({ provider: "mock" });
  const respond = await invokeGateway(methods, "voicecall.speak", {
    allowTwimlFallback: false,
    callId: "call-1",
    message: "hello",
  });

  expect(runtimeStub.webhookServer["speakRealtime"]).toHaveBeenCalledWith("call-1", "hello");
  expect(runtimeStub.manager["speak"]).not.toHaveBeenCalled();
  expect(respond).toEqual([true, { success: false, error: "No active realtime bridge for call" }]);
});

it.each([true, false])(
  "tool speech uses realtime=%s with classic fallback otherwise",
  async (realtime) => {
    runtimeStub.config.realtime.enabled = true;
    if (realtime) {
      runtimeStub.manager.getCall = vi.fn(() => undefined);
      runtimeStub.manager.getCallByProviderCallId = vi.fn(() =>
        createCallRecord({ callId: "call-1", providerCallId: "CA123" }),
      );
      runtimeStub.webhookServer.speakRealtime = vi.fn(() => ({ success: true }));
    }
    const tool = await activeTool();
    const result = await tool.execute("id", {
      action: "speak_to_user",
      callId: realtime ? "CA123" : "call-1",
      message: "hello",
    });
    expect(runtimeStub.webhookServer["speakRealtime"]).toHaveBeenCalledWith("call-1", "hello");
    if (realtime) {
      expect(runtimeStub.manager["speak"]).not.toHaveBeenCalled();
    } else {
      expect(runtimeStub.manager["speak"]).toHaveBeenCalledWith("call-1", "hello");
    }
    expect(result.details.success).toBe(true);
  },
);

it.each([Date.UTC(2026, 4, 2, 9, 18, 23), Number.POSITIVE_INFINITY])(
  "reports stale call history with endedAt=%s",
  async (endedAt) => {
    mockHistoricalCall(endedAt);
    const { methods } = await setupActive({ provider: "mock" });
    const [ok, , error] = await invokeGateway(methods, "voicecall.speak", {
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
  const { tools } = setup({ provider: "mock" });
  const tool = tools[0] as { parameters: unknown };

  expect(JSON.stringify(tool.parameters)).not.toContain("requesterSessionKey");
});

it.each([true, false])("tool get_status uses persisted fallback (found=%s)", async (found) => {
  const completed = createCallRecord({
    providerCallId: "CA123",
    state: "completed",
    endReason: "completed",
    endedAt: Date.UTC(2026, 4, 2, 9, 18, 23),
  });
  runtimeStub.manager.getCallFromMemoryOrStore = vi.fn(async () => (found ? completed : undefined));
  const tool = await activeTool();
  const result = await tool.execute("id", { action: "get_status", callId: "call-1" });
  expect(runtimeStub.manager["getCallFromMemoryOrStore"]).toHaveBeenCalledWith("call-1");
  expect(result.details).toMatchObject(
    found ? { found: true, call: { state: "completed" } } : { found: false },
  );
});

it("tool send_dtmf returns json payload", async () => {
  const tool = await activeTool();
  const result = await tool.execute("id", {
    action: "send_dtmf",
    callId: "call-1",
    digits: "ww123#",
  });
  expect(runtimeStub.manager["sendDtmf"]).toHaveBeenCalledWith("call-1", "ww123#");
  expect(result.details.success).toBe(true);
});

it("legacy tool status without sid returns error payload", async () => {
  const tool = await activeTool();
  const result = await tool.execute("id", { mode: "status" });
  expect(String(result.details.error)).toContain("sid required");
});

it("CLI rejects invalid numeric options", async () => {
  const program = new Command();
  await registerVoiceCallCli(program);
  for (const port of ["nope", "Infinity", "3334.9"]) {
    await expect(
      program.parseAsync(["voicecall", "expose", "--port", port, "--mode", "off"], {
        from: "user",
      }),
    ).rejects.toThrow(/Invalid numeric value for --port/);
  }
  const tmpFile = path.join(os.tmpdir(), `voicecall-invalid-${Date.now()}.jsonl`);
  fs.writeFileSync(tmpFile, "{}\n", "utf8");
  try {
    for (const last of ["later", "Infinity", "1.5"]) {
      await expect(
        program.parseAsync(["voicecall", "latency", "--file", tmpFile, "--last", last], {
          from: "user",
        }),
      ).rejects.toThrow(/Invalid numeric value for --last/);
    }
  } finally {
    fs.unlinkSync(tmpFile);
  }
});

it("CLI latency summarizes turn metrics from JSONL", async () => {
  const tmpFile = path.join(os.tmpdir(), `voicecall-latency-${Date.now()}.jsonl`);
  fs.writeFileSync(
    tmpFile,
    [
      { metadata: { lastTurnLatencyMs: 100, lastTurnListenWaitMs: 70 } },
      { metadata: { lastTurnLatencyMs: 200, lastTurnListenWaitMs: 110 } },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n") + "\n",
    "utf8",
  );
  try {
    const printed = await runVoiceCallCli(["latency", "--file", tmpFile, "--last", "10"]);
    expect(printed).toContain('"recordsScanned": 2');
    expect(printed).toContain('"p50Ms": 100');
    expect(printed).toContain('"p95Ms": 200');
  } finally {
    fs.unlinkSync(tmpFile);
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
  const { methods } = setup({ provider: "mock" });
  const respond = await invokeGateway(methods, "voicecall.start", {});

  const [ok, payload, error] = respond;
  expect(ok).toBe(false);
  expect(payload).toBeUndefined();
  expect(error?.code).toBe("INVALID_REQUEST");
  expect(error?.message).toBe("to required");
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
  expectCliGatewayCall("voicecall.continue.result", { operationId: "op-1" }, "5000");
  expect(createVoiceCallRuntime).not.toHaveBeenCalled();
  expect(output).toContain('"transcript": "gateway hello"');
});

it("caps gateway continue poll timeouts from voice and TTS configuration", async () => {
  const continuation = createDeferred<{ success: true; transcript: string }>();
  runtimeStub.manager.continueCall = vi.fn(async () => await continuation.promise);
  const { methods } = await setupActive({ provider: "mock" });
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
  runtimeStub.manager.continueCall = vi.fn(
    async () => await continuation.promise,
  ) as VoiceCallRuntime["manager"]["continueCall"];
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
  expect(startPayload).toMatchObject({
    operationId: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
    ),
    status: "pending",
    pollTimeoutMs: 180000,
  });
  expect(runtimeStub.manager["continueCall"]).toHaveBeenCalledWith("call-1", "Hello");
  expect(await result(startPayload?.operationId)).toMatchObject([true, { status: "pending" }]);

  continuation.resolve({ success: true, transcript: "gateway hello" });
  await continuation.promise;
  const completedCall = await vi.waitFor(async () => {
    const call = await result(startPayload?.operationId);
    expect(call[1]?.status).toBe("completed");
    return call;
  });
  expect(completedCall[0]).toBe(true);
  expect(completedCall[1]?.result).toEqual({ success: true, transcript: "gateway hello" });
  expect(await result(startPayload?.operationId)).toEqual([
    false,
    undefined,
    { code: "INVALID_REQUEST", message: "operation not found" },
  ]);

  runtimeStub.manager.continueCall = vi.fn(async () => ({
    success: false,
    error: "turn failed",
  })) as VoiceCallRuntime["manager"]["continueCall"];
  const [, failedStart] = await start("Try again");
  const failedCall = await vi.waitFor(async () => {
    const call = await result(failedStart?.operationId);
    expect(call[1]?.status).toBe("failed");
    return call;
  });
  expect(failedCall[0]).toBe(true);
  expect(failedCall[1]).toMatchObject({ status: "failed", error: "turn failed" });
});

it("CLI setup prints human-readable checks by default", async () => {
  const output = await runVoiceCallCli(
    ["setup"],
    twilioConfig({ publicUrl: "https://voice.example.com/voice/webhook" }),
  );
  expect(output).toContain("Voice Call setup: OK");
  expect(output).toContain("OK provider: Provider configured: twilio");
});

it.each([undefined, "http://127.0.0.1:3334/voice/webhook"])(
  "CLI setup reports invalid webhook exposure (%s) as JSON",
  async (publicUrl) => {
    const config = publicUrl === undefined ? twilioConfig() : twilioConfig({ publicUrl });
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

it.each([false, true])("CLI status stays read-only (gateway available=%s)", async (available) => {
  if (available) {
    callGatewayFromCliMock.mockResolvedValueOnce({
      found: true,
      calls: [{ callId: "gateway-call" }],
    });
  }
  const parsed = JSON.parse(await runVoiceCallCli(["status", "--json"])) as {
    calls?: Array<{ callId?: string }>;
  };
  expect(createVoiceCallRuntime).not.toHaveBeenCalled();
  if (available) {
    expectCliGatewayCall("voicecall.status", undefined, "5000");
    expect(parsed.calls).toHaveLength(1);
    expect(parsed.calls?.[0]?.callId).toBe("gateway-call");
  } else {
    expect(parsed.calls).toEqual([]);
  }
});

it("CLI smoke dry-runs a live call unless --yes is passed", async () => {
  const output = await runVoiceCallCli(
    ["smoke", "--to", "+15550009999"],
    twilioConfig({ publicUrl: "https://voice.example.com/voice/webhook" }),
  );
  expect(output).toContain("live-call: dry run for +15550009999");
  expect(runtimeStub.manager["initiateCall"]).not.toHaveBeenCalled();
});
