import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VoiceCallRuntime } from "./runtime-entry.js";
import { createManagerHarness, FakeProvider } from "./src/manager.test-harness.js";

// mock-isolation: Exercise tool scope without starting real telephony or state services.
vi.mock("./runtime-entry.js", () => ({
  createVoiceCallRuntime: vi.fn(),
}));

import {
  createVoiceCallLogger,
  createVoiceCallServiceContext,
  registerVoiceCall,
} from "./index.test-harness.js";
import { createVoiceCallRuntime } from "./runtime-entry.js";

const noopLogger = createVoiceCallLogger();

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
  vi.mocked(createVoiceCallRuntime).mockResolvedValue(runtime);
  return {
    ...registerBoundTool(call.callId),
    call,
    initiateCall,
    sendDtmf,
    endCall,
    getCallForStream,
    hangupCall,
  };
}

function registerBoundTool(callId: string) {
  const { service, toolFactory } = registerVoiceCall({
    logger: noopLogger,
    startOnRegistration: createVoiceCallServiceContext({ logger: noopLogger }),
  });
  return {
    service,
    tool: toolFactory({ toolBindings: { voice_call: { kind: "active-call", callId } } }),
  };
}

function holdCallLookup(carrier: Awaited<ReturnType<typeof makeManagerRuntime>>) {
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  carrier.getCallForStream.mockImplementation(async () => {
    started.resolve();
    await release.promise;
    return carrier.call;
  });
  return { started: started.promise, release: release.resolve };
}

function expectHangup(carrier: Awaited<ReturnType<typeof makeManagerRuntime>>) {
  expect(carrier.endCall).toHaveBeenCalledExactlyOnceWith(carrier.call.callId);
  expect(carrier.hangupCall).toHaveBeenCalledExactlyOnceWith({
    callId: carrier.call.callId,
    providerCallId: carrier.call.providerCallId,
    reason: "hangup-bot",
  });
}

function expectNoHangup(carrier: Awaited<ReturnType<typeof makeManagerRuntime>>) {
  expect(carrier.endCall).not.toHaveBeenCalled();
  expect(carrier.hangupCall).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.mocked(createVoiceCallRuntime).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.voice-call.runtimeCoordinator")
  ];
});

it("hangs up the exact active call once through the registered tool", async () => {
  const carrier = await makeManagerRuntime();
  const result = await carrier.tool.execute("end", { action: "end_call" });

  expect(JSON.stringify(result)).not.toContain("error");
  expectHangup(carrier);
});

it("rejects a foreign call id without reaching the provider effect", async () => {
  const carrier = await makeManagerRuntime();
  const result = await carrier.tool.execute("foreign", {
    action: "end_call",
    callId: "call-foreign",
  });

  expect(JSON.stringify(result)).toContain("bound to call");
  expectNoHangup(carrier);
});

it("rejects a non-end_call action on a bound call (steer_call)", async () => {
  const carrier = await makeManagerRuntime();
  const result = await carrier.tool.execute("rejected", {
    action: "steer_call",
    callId: carrier.call.callId,
    message: "steer",
  });
  expect(JSON.stringify(result)).toContain("only end_call");
  expect(carrier.endCall).not.toHaveBeenCalled();
  expect(carrier.initiateCall).not.toHaveBeenCalled();
  expect(carrier.sendDtmf).not.toHaveBeenCalled();
});

it("finishes an accepted hang-up when the consult is cancelled during call lookup", async () => {
  const carrier = await makeManagerRuntime();
  const { tool } = carrier;
  const controller = new AbortController();
  const lookup = holdCallLookup(carrier);

  const pending = tool.execute("control", { action: "end_call" }, controller.signal);
  await lookup.started;
  controller.abort();
  lookup.release();

  expect(JSON.stringify(await pending)).not.toContain("error");
  expectHangup(carrier);
});

it("rejects hang-up before admission when the consult is cancelled or the call has ended", async () => {
  const carrier = await makeManagerRuntime();
  const { tool } = carrier;
  const controller = new AbortController();
  controller.abort();

  const cancelled = await tool.execute("cancelled", { action: "end_call" }, controller.signal);
  expect(JSON.stringify(cancelled)).toContain("error");

  carrier.getCallForStream.mockResolvedValue(undefined);
  const ended = await tool.execute("ended", { action: "end_call" });
  expect(JSON.stringify(ended)).toContain("no longer active");
  expect(carrier.endCall).not.toHaveBeenCalled();
});

it.each(["retired", "replaced"])(
  "rejects a bound hang-up when its service is %s during lookup",
  async (change) => {
    const carrier = await makeManagerRuntime();
    const lookup = holdCallLookup(carrier);
    const pending = carrier.tool.execute(change, { action: "end_call" });
    await lookup.started;
    if (change === "retired") {
      await carrier.service.stop?.({} as never);
    } else {
      registerBoundTool(carrier.call.callId);
    }
    lookup.release();
    expect(JSON.stringify(await pending)).toContain("no longer active");
    expectNoHangup(carrier);
  },
);
