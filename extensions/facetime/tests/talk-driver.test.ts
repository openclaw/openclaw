import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  mocks,
  resetTalkDriverMocks,
  startParams,
  startReadyFaceTimeTalkDriver as startReady,
} from "./talk-driver.test-support.js";

const { resolveFaceTimeRealtimeProvider } = await import("../src/talk-driver-config.js");
const { startFaceTimeTalkDriver } = await import("../src/talk-driver.js");

const { bridge, pump, onFailure } = mocks;

function serverEvent(type: string, responseId?: string) {
  mocks.sessionParams?.onEvent({ direction: "server", type, responseId });
}

function expectTeardown(stopCalls = 1) {
  expect(pump.stop).toHaveBeenCalledTimes(stopCalls);
  expect(pump.suspendMedia).toHaveBeenCalledOnce();
  expect(bridge.close).toHaveBeenCalledOnce();
}

beforeEach(resetTalkDriverMocks);
afterEach(() => vi.useRealTimers());

it("resolves only the explicitly selected plugin-local provider secret", async () => {
  await withEnvAsync({ SELECTED_REALTIME_KEY: "selected-key" }, async () => {
    await resolveFaceTimeRealtimeProvider({
      config: startParams({
        realtime: {
          provider: "selected",
          providers: {
            ignored: {
              apiKey: { source: "env", provider: "default", id: "MISSING_IGNORED_KEY" },
            },
            selected: {
              apiKey: { source: "env", provider: "default", id: "SELECTED_REALTIME_KEY" },
            },
          },
        },
      }).config,
      fullConfig: {},
      agentId: "main",
    });

    expect(mocks.resolveProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        configuredProviderId: "selected",
        providerConfigs: { selected: { apiKey: "selected-key" } },
        surface: "bridge",
      }),
    );
  });
});

it.each([
  ["aborted", false],
  ["aborted", true],
  ["provider connect failed", true],
  ["capture failed during connect", true],
] as const)(
  "retains suppression after %s until carrier safety is %s",
  async (kind, carrierClosed) => {
    const connect = createDeferred<void>();
    const carrierSafety = createDeferred<boolean>();
    const carrierFailure = vi.fn(() => carrierSafety.promise);
    const controller = new AbortController();
    bridge.connect.mockReturnValueOnce(connect.promise);
    const driver = await startFaceTimeTalkDriver(
      startParams({ signal: controller.signal, onFailure: carrierFailure }),
    );
    const ready = driver.readyForAudio();
    const failed = expect(ready).rejects.toThrow(kind === "aborted" ? "startup aborted" : kind);
    await vi.waitFor(() => expect(bridge.connect).toHaveBeenCalledOnce());
    const triggeringFailure =
      kind === "aborted"
        ? controller.abort()
        : kind === "provider connect failed"
          ? connect.reject(new Error(kind))
          : mocks.pumpParams?.onError(new Error(kind));
    await vi.waitFor(() => expect(carrierFailure).toHaveBeenCalledOnce());
    expectTeardown(0);
    expect(driver.processOutputSuppressed()).toBe(true);
    if (kind === "aborted") {
      connect.resolve();
      mocks.sessionParams?.onReady();
      await Promise.resolve();
      driver.activate();
      expect(driver.realtimeActive()).toBe(false);
      expect(pump.routeReady).not.toHaveBeenCalled();
      expect(bridge.triggerGreeting).not.toHaveBeenCalled();
      expect(pump.stop).not.toHaveBeenCalled();
    }
    carrierSafety.resolve(carrierClosed);
    await triggeringFailure;
    await failed;
    expect(pump.stop).toHaveBeenCalledTimes(carrierClosed ? 1 : 0);
    await driver.close("carrier-closed");
    expectTeardown();
  },
);

it.each([false, true])(
  "settles pending audio readiness with safety suspension=%s",
  async (suspend) => {
    const connect = createDeferred<void>(),
      route = createDeferred<void>();
    bridge.connect.mockReturnValueOnce(connect.promise);
    pump.routeReady.mockReturnValueOnce(route.promise);
    const driver = await startFaceTimeTalkDriver(startParams());
    const first = driver.readyForAudio(),
      second = driver.readyForAudio();
    let fullyReady = false;
    void first.then(
      () => {
        fullyReady = true;
      },
      () => {},
    );
    const failed = suspend
      ? expect(Promise.all([first, second])).rejects.toThrow(
          "FaceTime model media suspended: carrier-hangup-pending",
        )
      : undefined;
    await vi.waitFor(() => expect(bridge.connect).toHaveBeenCalledOnce());
    expect(pump.routeReady).not.toHaveBeenCalled();
    expect(driver.realtimeActive()).toBe(false);
    connect.resolve();
    await Promise.resolve();
    expect(driver.realtimeActive()).toBe(false);
    mocks.sessionParams?.onReady();
    await vi.waitFor(() => expect(driver.realtimeActive()).toBe(true));
    expect(pump.routeReady).toHaveBeenCalledOnce();
    expect(fullyReady).toBe(false);
    if (suspend) {
      await driver.suspendMedia("carrier-hangup-pending");
    }
    route.resolve();
    if (suspend) {
      await failed;
    } else {
      await Promise.all([first, second]);
    }
    expect(fullyReady).toBe(!suspend);
    expect(driver.realtimeActive()).toBe(!suspend);
  },
);

it("keeps the carrier alive for a recoverable provider error after readiness", async () => {
  const driver = await startReady();

  mocks.sessionParams?.onError(new Error("socket reconnecting"));
  await Promise.resolve();

  expect(driver.realtimeActive()).toBe(true);
  expect(onFailure).not.toHaveBeenCalled();
  expect(pump.suspendMedia).not.toHaveBeenCalled();
});

it("ignores a stale response terminal and drains only the current response", async () => {
  await startReady();
  pump.queuedAudioFrames.mockReturnValue(240);
  serverEvent("response.created", "response-current");
  mocks.sessionParams?.audioSink.sendAudio(Buffer.alloc(480));
  mocks.sessionParams?.onResponseDone?.({
    status: "completed",
    responseId: "response-stale",
  });
  expect(pump.finishOutputAudio).not.toHaveBeenCalled();

  mocks.sessionParams?.onResponseDone?.({
    status: "completed",
    responseId: "response-current",
  });
  expect(pump.finishOutputAudio).toHaveBeenCalledOnce();
  pump.queuedAudioFrames.mockReturnValue(0);
  mocks.pumpParams?.onPlaybackDrained();
  expect(pump.clearOutputAudio).not.toHaveBeenCalled();
});

it.each(["cancelled", "failed"] as const)(
  "flushes native playback for a %s response outcome without killing the carrier",
  async (status) => {
    const driver = await startReady();
    serverEvent("response.created", "response-1");
    mocks.sessionParams?.audioSink.sendAudio(Buffer.alloc(480));
    mocks.sessionParams?.onResponseDone?.(
      status === "failed"
        ? { status, responseId: "response-1", message: "response failed" }
        : { status, responseId: "response-1" },
    );

    expect(pump.clearOutputAudio).toHaveBeenCalled();
    expect(onFailure).not.toHaveBeenCalled();
    expect(driver.realtimeActive()).toBe(true);
  },
);

it("fails closed when the provider never becomes ready after connect", async () => {
  vi.useFakeTimers();
  const driver = await startFaceTimeTalkDriver(startParams({ onFailure }));
  const failed = expect(driver.readyForAudio()).rejects.toThrow(
    "Realtime provider was not ready within 15 seconds",
  );
  await vi.advanceTimersByTimeAsync(15_000);
  await failed;
  expect(onFailure).toHaveBeenCalledWith(
    expect.objectContaining({ message: "Realtime provider was not ready within 15 seconds" }),
  );
  expectTeardown();
});

it.each([true, false])(
  "tears down failed audio only when carrier cleanup is safe=%s",
  async (safe) => {
    onFailure.mockResolvedValueOnce(safe);
    const driver = await startReady();
    if (safe) {
      pump.suspendMedia.mockRejectedValueOnce(new Error("native playback teardown failed"));
    }
    await expect(mocks.pumpParams?.onError(new Error("capture failed"))).resolves.toBe(safe);
    expect(onFailure).toHaveBeenCalledExactlyOnceWith(new Error("capture failed"));
    expectTeardown(safe ? 1 : 0);
    expect(driver.realtimeActive()).toBe(false);
  },
);

it("stops all model media while retaining native process suppression", async () => {
  const driver = await startReady();
  mocks.pumpParams?.onInputAudio(Buffer.from([5, 6]));
  expect(bridge.sendAudio).not.toHaveBeenCalled();
  driver.activate();
  mocks.pumpParams?.onInputAudio(Buffer.from([1, 2]));
  expect(bridge.sendAudio).toHaveBeenCalledWith(Buffer.from([1, 2]));
  mocks.sessionParams?.audioSink.sendAudio(Buffer.from([3, 4]));
  expect(bridge.sendAudio).toHaveBeenCalledOnce();
  expect(pump.writeOutputAudio).toHaveBeenCalledOnce();

  await driver.suspendMedia("carrier-hangup-pending");
  mocks.pumpParams?.onInputAudio(Buffer.from([5, 6]));
  mocks.sessionParams?.audioSink.sendAudio(Buffer.from([7, 8]));
  mocks.sessionParams?.audioSink.clearAudio();

  expect(driver.processOutputSuppressed()).toBe(true);
  expect(driver.realtimeActive()).toBe(false);
  expect(bridge.sendAudio).toHaveBeenCalledTimes(1);
  expect(pump.writeOutputAudio).toHaveBeenCalledTimes(1);
  expect(pump.clearOutputAudio).not.toHaveBeenCalled();
  expect(pump.suspendMedia).toHaveBeenCalledOnce();
  expect(pump.stop).not.toHaveBeenCalled();
});

it("greets after the answered call's media route settles despite raw VAD noise", async () => {
  const driver = await startReady();

  vi.useFakeTimers();
  expect(bridge.triggerGreeting).not.toHaveBeenCalled();
  driver.activate();
  driver.activate();
  serverEvent("input_audio_buffer.speech_started");
  await vi.advanceTimersByTimeAsync(50);
  mocks.sessionParams?.onTranscript?.("user", "", true);
  await vi.advanceTimersByTimeAsync(49);
  expect(bridge.triggerGreeting).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(bridge.triggerGreeting).toHaveBeenCalledWith(
    "Greet the caller briefly, introduce yourself using your configured identity, and ask how you can help.",
  );
  await vi.advanceTimersByTimeAsync(50);
  expect(bridge.triggerGreeting).toHaveBeenCalledOnce();
});

it("keeps direct hangup available without consult tools and deduplicates requests", async () => {
  await startReady({ realtime: { toolPolicy: "none" } });

  expect(mocks.sessionParams?.tools?.map((tool) => tool.name)).toEqual(["facetime_end_call"]);
  expect(mocks.sessionParams?.instructions).toContain("call facetime_end_call immediately");

  const event = {
    itemId: "item-hangup",
    callId: "provider-hangup",
    name: "facetime_end_call",
    args: {},
  };
  await mocks.sessionParams?.onToolCall(event);

  expect(bridge.submitToolResult).toHaveBeenCalledWith(
    "provider-hangup",
    {
      status: "ending",
      message: "The current FaceTime call is ending. Do not speak another response.",
    },
    { suppressResponse: true },
  );
  expect(mocks.hangupRequested).toHaveBeenCalledOnce();
  expect(mocks.consult).not.toHaveBeenCalled();

  await mocks.sessionParams?.onToolCall(event);
  expect(mocks.hangupRequested).toHaveBeenCalledOnce();
  expect(mocks.consult).not.toHaveBeenCalled();
});

it("combines custom instructions with workspace identity and agent proxy policy", async () => {
  mocks.resolveAgentContext.mockResolvedValue(
    "Agent context: shared voice agent context.\n\nOpenClaw realtime voice profile context:\n\n### IDENTITY.md\nName: Tide",
  );
  await startReady({
    realtime: {
      sessionKey: "agent:lobster:facetime",
      instructions: "Speak warmly and keep answers short.",
    },
  });

  expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
  expect(mocks.resolveAgentContext).toHaveBeenCalledWith(
    expect.objectContaining({ agentId: "lobster", sessionKey: "agent:lobster:facetime" }),
  );
  const instructions = mocks.sessionParams?.instructions;
  expect(instructions?.match(/Agent context:/g)).toHaveLength(1);
  expect(instructions).toContain("Speak warmly and keep answers short.");
  expect(instructions).toContain("Name: Tide");
  expect(instructions).toContain("same configured OpenClaw agent");
  expect(instructions).toContain(
    "authenticated owner/user described by the loaded workspace profile context",
  );
  expect(instructions).toContain(
    "Answer greetings, acknowledgements, and questions about your own identity or persona directly",
  );
  expect(instructions).toContain(
    "- Answer directly for greetings, acknowledgements, simple conversational glue, and brief latency tests.",
  );
  expect(instructions).toContain("Never claim you retried");
  expect(instructions).not.toContain("Lobster");
  expect(instructions).not.toContain("Omar");
});
