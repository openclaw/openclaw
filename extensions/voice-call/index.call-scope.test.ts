import os from "node:os";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  createTestPluginApi,
  createTestPluginServiceScheduler,
} from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "./api.js";
import type { VoiceCallRuntime } from "./runtime-entry.js";
import { createManagerHarness, FakeProvider } from "./src/manager.test-harness.js";

type RuntimeFixture = ReturnType<typeof makeRuntime>;

let runtimeStub: RuntimeFixture;
let runtimeToCreate: VoiceCallRuntime;

// mock-isolation: Exercise tool scope without starting real telephony or state services.
vi.mock("./runtime-entry.js", () => ({
  createVoiceCallRuntime: vi.fn(async () => runtimeToCreate),
}));

import plugin from "./index.js";
import { createVoiceCallRuntime } from "./runtime-entry.js";

const noopLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeRuntime() {
  const call = {
    callId: "call-1",
    provider: "twilio",
    direction: "outbound",
    state: "active",
    from: "+15550001111",
    to: "+15550001234",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
  } as const;
  const initiateCall = vi.fn(async () => ({ callId: "new-call", success: true }));
  const sendDtmf = vi.fn(async () => ({ success: true }));
  const endCall = vi.fn(async () => ({ success: true }));
  const getCallForStream = vi.fn(async (callId: string) =>
    callId === call.callId ? call : undefined,
  );
  const runtime = {
    config: { realtime: { enabled: false } } as VoiceCallRuntime["config"],
    provider: {} as VoiceCallRuntime["provider"],
    manager: {
      initiateCall,
      sendDtmf,
      endCall,
      getCallForStream,
    } as unknown as VoiceCallRuntime["manager"],
    webhookServer: {} as VoiceCallRuntime["webhookServer"],
    webhookUrl: "http://127.0.0.1:3334/voice/webhook",
    publicUrl: null,
    stop: vi.fn(async () => {}),
  } as VoiceCallRuntime;
  return { call, runtime, initiateCall, sendDtmf, endCall, getCallForStream };
}

async function makeManagerRuntime() {
  const provider = new FakeProvider();
  const { manager } = await createManagerHarness({}, provider);
  const started = await manager.initiateCall("+15550001234");
  if (!started.success) {
    throw new Error(started.error ?? "Expected test call to start");
  }
  const call = manager.getCall(started.callId);
  if (!call?.providerCallId) {
    throw new Error("Expected an active test call with carrier identity");
  }
  const initiateCall = vi.spyOn(manager, "initiateCall");
  const sendDtmf = vi.spyOn(manager, "sendDtmf");
  const endCall = vi.spyOn(manager, "endCall");
  const getCallForStream = vi.spyOn(manager, "getCallForStream");
  const hangupCall = vi.spyOn(provider, "hangupCall");
  const runtime = {
    config: { realtime: { enabled: false } } as VoiceCallRuntime["config"],
    provider,
    manager,
    webhookServer: {} as VoiceCallRuntime["webhookServer"],
    webhookUrl: "http://127.0.0.1:3334/voice/webhook",
    publicUrl: null,
    stop: vi.fn(async () => {}),
  } as VoiceCallRuntime;
  return {
    call,
    runtime,
    provider,
    initiateCall,
    sendDtmf,
    endCall,
    getCallForStream,
    hangupCall,
  };
}

function registerBoundTool(callId: string = runtimeStub.call.callId) {
  let toolFactory: ((context: Record<string, unknown>) => unknown) | undefined;
  let registeredService: Parameters<OpenClawPluginApi["registerService"]>[0] | undefined;
  const api = createTestPluginApi({
    id: "voice-call",
    name: "Voice Call",
    description: "test",
    version: "0",
    source: "test",
    registrationMode: "full",
    config: {},
    pluginConfig: { provider: "mock" },
    runtime: { tts: { textToSpeechTelephony: vi.fn() } } as unknown as OpenClawPluginApi["runtime"],
    logger: noopLogger,
    registerGatewayMethod: () => {},
    registerTool: (tool: unknown) => {
      toolFactory =
        typeof tool === "function"
          ? (tool as (context: Record<string, unknown>) => unknown)
          : () => tool;
    },
    registerCli: () => {},
    registerService: (service) => {
      if (service.apiVersion !== 2) {
        throw new Error("Expected scheduler-owned voice-call service");
      }
      registeredService = service;
      void service.start({
        config: {},
        stateDir: os.tmpdir(),
        logger: noopLogger,
        scheduler: createTestPluginServiceScheduler(),
      });
    },
    resolvePath: (path: string) => path,
  });
  plugin.register(api);
  if (!registeredService) {
    throw new Error("Expected voice-call service registration");
  }
  if (!toolFactory) {
    throw new Error("Expected voice-call tool registration");
  }
  return {
    service: registeredService,
    tool: toolFactory({
      toolBindings: { voice_call: { kind: "active-call", callId } },
    }) as {
      execute: (id: string, params: unknown, signal?: AbortSignal) => Promise<unknown>;
    },
  };
}

describe("voice-call active-call tool scope", () => {
  beforeEach(() => {
    runtimeStub = makeRuntime();
    runtimeToCreate = runtimeStub.runtime;
    vi.mocked(createVoiceCallRuntime)
      .mockReset()
      .mockImplementation(async () => runtimeToCreate);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (globalThis as Record<PropertyKey, unknown>)[
      Symbol.for("openclaw.voice-call.runtimeCoordinator")
    ];
  });

  it("hangs up the exact active call once through the registered tool", async () => {
    const carrier = await makeManagerRuntime();
    runtimeToCreate = carrier.runtime;
    const { tool } = registerBoundTool(carrier.call.callId);

    const result = await tool.execute("end", { action: "end_call" });

    expect(JSON.stringify(result)).not.toContain("error");
    expect(carrier.endCall).toHaveBeenCalledOnce();
    expect(carrier.endCall).toHaveBeenCalledWith(carrier.call.callId);
    expect(carrier.hangupCall).toHaveBeenCalledExactlyOnceWith({
      callId: carrier.call.callId,
      providerCallId: carrier.call.providerCallId,
      reason: "hangup-bot",
    });
  });

  it("rejects a foreign call id without reaching the provider effect", async () => {
    const carrier = await makeManagerRuntime();
    runtimeToCreate = carrier.runtime;
    const { tool } = registerBoundTool(carrier.call.callId);

    const result = await tool.execute("foreign", { action: "end_call", callId: "call-foreign" });

    expect(JSON.stringify(result)).toContain("bound to call");
    expect(carrier.endCall).not.toHaveBeenCalled();
    expect(carrier.hangupCall).not.toHaveBeenCalled();
  });

  it.each([
    { action: "continue_call", callId: "bound", message: "continue" },
    { action: "get_status", callId: "bound" },
    { action: "initiate_call", message: "start" },
    { action: "send_dtmf", callId: "bound", digits: "1" },
    { action: "speak_to_user", callId: "bound", message: "speak" },
  ])("rejects every bound-call action except end_call ($action)", async (params) => {
    const { tool } = registerBoundTool();
    const scopedParams = {
      ...params,
      ...(params.callId ? { callId: runtimeStub.call.callId } : {}),
    };

    const result = await tool.execute("rejected", scopedParams);

    expect(JSON.stringify(result)).toContain("only end_call");
    expect(runtimeStub.endCall).not.toHaveBeenCalled();
    expect(runtimeStub.initiateCall).not.toHaveBeenCalled();
    expect(runtimeStub.sendDtmf).not.toHaveBeenCalled();
  });

  it("finishes an accepted hang-up when the consult is cancelled during call lookup", async () => {
    const carrier = await makeManagerRuntime();
    runtimeToCreate = carrier.runtime;
    const { tool } = registerBoundTool(carrier.call.callId);
    const controller = new AbortController();
    const lookupStarted = createDeferred<void>();
    const releaseLookup = createDeferred<void>();
    const call = carrier.call;
    carrier.getCallForStream.mockImplementation(async () => {
      lookupStarted.resolve();
      await releaseLookup.promise;
      return call;
    });

    const pending = tool.execute("control", { action: "end_call" }, controller.signal);
    await lookupStarted.promise;
    controller.abort();
    releaseLookup.resolve();

    expect(JSON.stringify(await pending)).not.toContain("error");
    expect(carrier.endCall).toHaveBeenCalledOnce();
    expect(carrier.endCall).toHaveBeenCalledWith(call.callId);
    expect(carrier.hangupCall).toHaveBeenCalledExactlyOnceWith({
      callId: call.callId,
      providerCallId: call.providerCallId,
      reason: "hangup-bot",
    });
  });

  it("rejects hang-up before admission when the consult is cancelled or the call has ended", async () => {
    const { tool } = registerBoundTool();
    const controller = new AbortController();
    controller.abort();

    const cancelled = await tool.execute("cancelled", { action: "end_call" }, controller.signal);
    expect(JSON.stringify(cancelled)).toContain("error");

    runtimeStub.getCallForStream.mockResolvedValue(undefined);
    const ended = await tool.execute("ended", { action: "end_call" });
    expect(JSON.stringify(ended)).toContain("no longer active");
    expect(runtimeStub.endCall).not.toHaveBeenCalled();
  });

  it("rejects a bound hang-up when its service is retired during call lookup", async () => {
    const carrier = await makeManagerRuntime();
    runtimeToCreate = carrier.runtime;
    const { service, tool } = registerBoundTool(carrier.call.callId);
    const lookupStarted = createDeferred<void>();
    const releaseLookup = createDeferred<void>();
    carrier.getCallForStream.mockImplementation(async () => {
      lookupStarted.resolve();
      await releaseLookup.promise;
      return carrier.call;
    });

    const pending = tool.execute("retired", { action: "end_call" });
    await lookupStarted.promise;
    await service.stop?.({} as never);
    releaseLookup.resolve();
    const result = await pending;

    expect(JSON.stringify(result)).toContain("no longer active");
    expect(carrier.endCall).not.toHaveBeenCalled();
    expect(carrier.hangupCall).not.toHaveBeenCalled();
  });

  it("rejects a bound hang-up when a replacement service takes ownership during lookup", async () => {
    const carrier = await makeManagerRuntime();
    runtimeToCreate = carrier.runtime;
    const { tool } = registerBoundTool(carrier.call.callId);
    const lookupStarted = createDeferred<void>();
    const releaseLookup = createDeferred<void>();
    carrier.getCallForStream.mockImplementation(async () => {
      lookupStarted.resolve();
      await releaseLookup.promise;
      return carrier.call;
    });

    const pending = tool.execute("replaced", { action: "end_call" });
    await lookupStarted.promise;
    registerBoundTool(carrier.call.callId);
    releaseLookup.resolve();

    const result = await pending;

    expect(JSON.stringify(result)).toContain("no longer active");
    expect(carrier.endCall).not.toHaveBeenCalled();
    expect(carrier.hangupCall).not.toHaveBeenCalled();
  });
});
