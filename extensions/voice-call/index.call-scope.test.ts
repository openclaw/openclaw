import assert from "node:assert/strict";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { VoiceCallRuntime } from "./runtime-entry.js";
import { createManagerHarness } from "./src/manager.test-harness.js";

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
  const { manager, provider } = await createManagerHarness();
  const started = await manager.initiateCall("+15550001234");
  assert(started.success, "Expected test call to start");
  const call = manager.getCall(started.callId);
  assert(call?.providerCallId, "Expected an active test call with carrier identity");
  vi.mocked(createVoiceCallRuntime).mockResolvedValue({
    config: { realtime: { enabled: false } } as VoiceCallRuntime["config"],
    provider,
    manager,
    webhookServer: {} as VoiceCallRuntime["webhookServer"],
    webhookUrl: "http://127.0.0.1:3334/voice/webhook",
    publicUrl: null,
    stop: vi.fn(async () => {}),
  } as VoiceCallRuntime);
  return {
    ...registerBoundTool(call.callId),
    call,
    provider,
    getCallForStream: vi.spyOn(manager, "getCallForStream"),
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

let carrier: Awaited<ReturnType<typeof makeManagerRuntime>>;

function holdCallLookup() {
  const started = createDeferred<void>();
  const release = createDeferred<void>();
  carrier.getCallForStream.mockImplementation(async () => {
    started.resolve();
    await release.promise;
    return carrier.call;
  });
  return { started: started.promise, release: release.resolve };
}

beforeEach(async () => {
  vi.mocked(createVoiceCallRuntime).mockReset();
  carrier = await makeManagerRuntime();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.voice-call.runtimeCoordinator")
  ];
});

it.each([
  ["end_call", "call-foreign", "bound to call"],
  ["steer_call", undefined, "only end_call"],
])("rejects %s targeting %s before any effect", async (action, callId, error) => {
  const result = await carrier.tool.execute("rejected", {
    action,
    callId: callId ?? carrier.call.callId,
  });
  expect(JSON.stringify(result)).toContain(error);
  expect(carrier.provider.hangupCalls).toEqual([]);
});

it("finishes an accepted hang-up when the consult is cancelled during call lookup", async () => {
  const controller = new AbortController();
  const lookup = holdCallLookup();
  const pending = carrier.tool.execute("control", { action: "end_call" }, controller.signal);
  await lookup.started;
  controller.abort();
  lookup.release();
  expect(JSON.stringify(await pending)).not.toContain("error");
  expect(carrier.provider.hangupCalls).toEqual([
    {
      callId: carrier.call.callId,
      providerCallId: carrier.call.providerCallId,
      reason: "hangup-bot",
    },
  ]);
});

it("rejects hang-up before admission when the consult is cancelled or the call has ended", async () => {
  const { tool } = carrier;
  const controller = new AbortController();
  controller.abort();

  const cancelled = await tool.execute("cancelled", { action: "end_call" }, controller.signal);
  expect(JSON.stringify(cancelled)).toContain("error");

  carrier.getCallForStream.mockResolvedValue(undefined);
  const ended = await tool.execute("ended", { action: "end_call" });
  expect(JSON.stringify(ended)).toContain("no longer active");
  expect(carrier.provider.hangupCalls).toEqual([]);
});

it.each(["retired", "replaced", "restarted"])(
  "rejects a bound hang-up when its service is %s during lookup",
  async (change) => {
    const lookup = holdCallLookup();
    const pending = carrier.tool.execute(change, { action: "end_call" });
    await lookup.started;
    if (change === "retired" || change === "restarted") {
      await carrier.service.stop?.({} as never);
      if (change === "restarted") {
        await carrier.service.start(createVoiceCallServiceContext({ logger: noopLogger }));
      }
    } else {
      registerBoundTool(carrier.call.callId);
    }
    lookup.release();
    expect(JSON.stringify(await pending)).toContain("no longer active");
    expect(carrier.provider.hangupCalls).toEqual([]);
  },
);
