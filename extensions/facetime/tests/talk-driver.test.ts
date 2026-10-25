import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { withEnvAsync } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mocks,
  resetTalkDriverMocks,
  startParams,
  startReadyFaceTimeTalkDriver,
} from "./talk-driver.test-support.js";

const { resolveFaceTimeConfig } = await import("../src/config.js");
const { resolveFaceTimeRealtimeProvider } = await import("../src/talk-driver-config.js");
const { startFaceTimeTalkDriver } = await import("../src/talk-driver.js");

function expectSuspended(stopCalls: number) {
  expect(mocks.bridge.close).toHaveBeenCalledOnce();
  expect(mocks.pump.suspendMedia).toHaveBeenCalledOnce();
  expect(mocks.pump.stop).toHaveBeenCalledTimes(stopCalls);
}

describe("FaceTime talk driver lifecycle", () => {
  beforeEach(resetTalkDriverMocks);

  it("resolves only the explicitly selected plugin-local provider secret", async () => {
    await withEnvAsync({ SELECTED_REALTIME_KEY: "selected-key" }, async () => {
      await resolveFaceTimeRealtimeProvider({
        config: resolveFaceTimeConfig({
          ownerHandles: ["caller@example.com"],
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
        }),
        fullConfig: {} as never,
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
    ["abort", false],
    ["abort", true],
    ["capture", true],
    ["provider", true],
  ] as const)(
    "fences %s startup failure until carrier closure (%s)",
    async (source, carrierClosed) => {
      const connect = createDeferred<void>();
      const carrierSafety = createDeferred<boolean>();
      const controller = new AbortController();
      const message = {
        abort: "startup aborted",
        capture: "capture failed during connect",
        provider: "provider connect failed",
      }[source];
      const failure = new Error(message);
      if (source === "provider") {
        mocks.bridge.connect.mockRejectedValueOnce(failure);
      } else {
        mocks.bridge.connect.mockReturnValueOnce(connect.promise);
      }
      mocks.onFailure.mockReturnValueOnce(carrierSafety.promise);
      const driver = await startFaceTimeTalkDriver(startParams({ signal: controller.signal }));
      const failed = expect(driver.readyForAudio()).rejects.toThrow(message);
      await vi.waitFor(() => expect(mocks.bridge.connect).toHaveBeenCalledOnce());
      if (source === "abort") {
        controller.abort();
      }
      const captureFailure = source === "capture" ? mocks.pumpParams?.onError(failure) : undefined;
      await vi.waitFor(() => expect(mocks.onFailure).toHaveBeenCalledOnce());
      expectSuspended(0);
      expect(driver.processOutputSuppressed()).toBe(true);

      connect.resolve();
      mocks.sessionParams?.onReady();
      await Promise.resolve();
      driver.activate();
      expect(driver.realtimeActive()).toBe(false);
      expect(mocks.pump.routeReady).not.toHaveBeenCalled();
      expect(mocks.bridge.triggerGreeting).not.toHaveBeenCalled();
      expect(mocks.pump.stop).not.toHaveBeenCalled();

      carrierSafety.resolve(carrierClosed);
      await Promise.all([failed, captureFailure]);
      expect(mocks.pump.stop).toHaveBeenCalledTimes(carrierClosed ? 1 : 0);
      await driver.close("carrier-closed");
      expect(mocks.pump.stop).toHaveBeenCalledOnce();
      expect(mocks.bridge.close).toHaveBeenCalledOnce();
    },
  );

  it("waits for provider connect, provider ready, and microphone routing", async () => {
    const connect = createDeferred<void>();
    const route = createDeferred<void>();
    mocks.bridge.connect.mockReturnValueOnce(connect.promise);
    mocks.pump.routeReady.mockReturnValueOnce(route.promise);
    const driver = await startFaceTimeTalkDriver(startParams());
    const first = driver.readyForAudio();
    const second = driver.readyForAudio();
    let fullyReady = false;
    void first.then(() => {
      fullyReady = true;
    });

    await vi.waitFor(() => expect(mocks.bridge.connect).toHaveBeenCalledOnce());
    expect(mocks.pump.routeReady).not.toHaveBeenCalled();
    expect(driver.realtimeActive()).toBe(false);

    connect.resolve();
    await Promise.resolve();
    expect(driver.realtimeActive()).toBe(false);

    mocks.sessionParams?.onReady();
    await vi.waitFor(() => expect(driver.realtimeActive()).toBe(true));
    expect(mocks.pump.routeReady).toHaveBeenCalledOnce();
    expect(fullyReady).toBe(false);

    route.resolve();
    await Promise.all([first, second]);
    expect(fullyReady).toBe(true);
    expect(driver.realtimeActive()).toBe(true);
  });

  it("keeps the carrier alive for a recoverable provider error after readiness", async () => {
    const driver = await startReadyFaceTimeTalkDriver();

    mocks.sessionParams?.onError(new Error("socket reconnecting"));
    await Promise.resolve();

    expect(driver.realtimeActive()).toBe(true);
    expect(mocks.onFailure).not.toHaveBeenCalled();
    expect(mocks.pump.suspendMedia).not.toHaveBeenCalled();
  });

  it("ignores a stale response terminal and drains only the current response", async () => {
    await startReadyFaceTimeTalkDriver();
    mocks.pump.queuedAudioFrames.mockReturnValue(240);
    mocks.sessionParams?.onEvent({
      direction: "server",
      type: "response.created",
      responseId: "response-current",
    });
    mocks.sessionParams?.audioSink.sendAudio(Buffer.alloc(480));
    mocks.sessionParams?.onResponseDone?.({
      status: "completed",
      responseId: "response-stale",
    });
    expect(mocks.pump.finishOutputAudio).not.toHaveBeenCalled();

    mocks.sessionParams?.onResponseDone?.({
      status: "completed",
      responseId: "response-current",
    });
    expect(mocks.pump.finishOutputAudio).toHaveBeenCalledOnce();
    mocks.pump.queuedAudioFrames.mockReturnValue(0);
    mocks.pumpParams?.onPlaybackDrained({ generation: 1, playedFrames: 240 });
    expect(mocks.pump.clearOutputAudio).not.toHaveBeenCalled();
  });

  it.each(["cancelled", "failed"] as const)(
    "flushes native playback for a %s response outcome without killing the carrier",
    async (status) => {
      const driver = await startReadyFaceTimeTalkDriver();
      mocks.sessionParams?.onEvent({
        direction: "server",
        type: "response.created",
        responseId: "response-1",
      });
      mocks.sessionParams?.audioSink.sendAudio(Buffer.alloc(480));
      mocks.sessionParams?.onResponseDone?.({
        status,
        responseId: "response-1",
        ...(status === "failed" ? { message: `response ${status}` } : {}),
      });

      expect(mocks.pump.clearOutputAudio).toHaveBeenCalled();
      expect(mocks.onFailure).not.toHaveBeenCalled();
      expect(driver.realtimeActive()).toBe(true);
    },
  );

  it("rejects pending audio readiness when safety suspension wins the route race", async () => {
    const route = createDeferred<void>();
    mocks.pump.routeReady.mockReturnValueOnce(route.promise);
    const driver = await startFaceTimeTalkDriver(startParams());
    const ready = driver.readyForAudio();
    const failed = expect(ready).rejects.toThrow(
      "FaceTime model media suspended: carrier-hangup-pending",
    );
    await vi.waitFor(() => expect(mocks.createSession).toHaveBeenCalledOnce());
    mocks.sessionParams?.onReady();
    await vi.waitFor(() => expect(driver.realtimeActive()).toBe(true));

    await driver.suspendMedia("carrier-hangup-pending");
    route.resolve();

    await failed;
    expect(driver.realtimeActive()).toBe(false);
  });

  it("fails closed when the provider never becomes ready after connect", async () => {
    vi.useFakeTimers();
    try {
      const driver = await startFaceTimeTalkDriver(startParams());
      const ready = driver.readyForAudio();
      const failed = expect(ready).rejects.toThrow(
        "Realtime provider was not ready within 15 seconds",
      );

      await vi.advanceTimersByTimeAsync(15_000);

      await failed;
      expect(mocks.onFailure).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Realtime provider was not ready within 15 seconds",
        }),
      );
      expectSuspended(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports carrier failure and performs final teardown when media suspension rejects", async () => {
    const driver = await startReadyFaceTimeTalkDriver();
    mocks.pump.suspendMedia.mockRejectedValueOnce(new Error("native playback teardown failed"));

    await mocks.pumpParams?.onError(new Error("capture failed"));

    expect(mocks.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: "capture failed" }),
    );
    expectSuspended(1);
    expect(driver.realtimeActive()).toBe(false);
  });

  it("retains process-tap suppression when carrier cleanup is not yet safe", async () => {
    const onFailure = vi.fn(async () => false);
    await startReadyFaceTimeTalkDriver(startParams({ onFailure }));

    await expect(mocks.pumpParams?.onError(new Error("carrier hangup pending"))).resolves.toBe(
      false,
    );

    expect(onFailure).toHaveBeenCalledOnce();
    expectSuspended(0);
  });

  it("stops all model media while retaining native process suppression", async () => {
    const driver = await startReadyFaceTimeTalkDriver();
    mocks.pumpParams?.onInputAudio(Buffer.from([5, 6]));
    expect(mocks.bridge.sendAudio).not.toHaveBeenCalled();
    driver.activate();
    mocks.pumpParams?.onInputAudio(Buffer.from([1, 2]));
    expect(mocks.bridge.sendAudio).toHaveBeenCalledWith(Buffer.from([1, 2]));
    mocks.sessionParams?.audioSink.sendAudio(Buffer.from([3, 4]));
    expect(mocks.bridge.sendAudio).toHaveBeenCalledOnce();
    expect(mocks.pump.writeOutputAudio).toHaveBeenCalledOnce();

    await driver.suspendMedia("carrier-hangup-pending");
    mocks.pumpParams?.onInputAudio(Buffer.from([5, 6]));
    mocks.sessionParams?.audioSink.sendAudio(Buffer.from([7, 8]));
    mocks.sessionParams?.audioSink.clearAudio();

    expect(driver.processOutputSuppressed()).toBe(true);
    expect(driver.realtimeActive()).toBe(false);
    expect(mocks.bridge.sendAudio).toHaveBeenCalledTimes(1);
    expect(mocks.pump.writeOutputAudio).toHaveBeenCalledTimes(1);
    expect(mocks.pump.clearOutputAudio).not.toHaveBeenCalled();
    expect(mocks.pump.suspendMedia).toHaveBeenCalledOnce();
    expect(mocks.pump.stop).not.toHaveBeenCalled();
  });

  it.each(["", "I have a question"])("greets only without caller speech (%s)", async (speech) => {
    const driver = await startReadyFaceTimeTalkDriver();
    vi.useFakeTimers();
    try {
      expect(mocks.bridge.triggerGreeting).not.toHaveBeenCalled();
      driver.activate();
      driver.activate();
      mocks.sessionParams?.onEvent({
        direction: "server",
        type: "input_audio_buffer.speech_started",
      });
      await vi.advanceTimersByTimeAsync(50);
      mocks.sessionParams?.onTranscript?.("user", speech, true);
      await vi.advanceTimersByTimeAsync(49);
      expect(mocks.bridge.triggerGreeting).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      if (!speech) {
        expect(mocks.bridge.triggerGreeting).toHaveBeenCalledWith(
          "Greet the caller briefly, introduce yourself using your configured identity, and ask how you can help.",
        );
      }
      await vi.advanceTimersByTimeAsync(50);
      expect(mocks.bridge.triggerGreeting).toHaveBeenCalledTimes(speech ? 0 : 1);
    } finally {
      try {
        await driver.close();
      } finally {
        vi.useRealTimers();
      }
    }
  });

  it("keeps direct hangup available without consult tools and deduplicates requests", async () => {
    await startReadyFaceTimeTalkDriver({ realtime: { toolPolicy: "none" } });

    expect(mocks.sessionParams?.tools?.map((tool) => tool.name)).toEqual(["facetime_end_call"]);
    expect(mocks.sessionParams?.instructions).toContain("call facetime_end_call immediately");

    const event = {
      itemId: "item-hangup",
      callId: "provider-hangup",
      name: "facetime_end_call",
      args: {},
    };
    await mocks.sessionParams?.onToolCall(event);

    expect(mocks.bridge.submitToolResult).toHaveBeenCalledWith(
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
    mocks.bridge.connect.mockResolvedValue();
    mocks.resolveAgentContext.mockResolvedValue(
      "Agent context: shared voice agent context.\n\nOpenClaw realtime voice profile context:\n\n### IDENTITY.md\nName: Tide",
    );
    await startReadyFaceTimeTalkDriver({
      realtime: {
        sessionKey: "agent:lobster:facetime",
        instructions: "Speak warmly and keep answers short.",
      },
    });

    expect(mocks.resolveDefaultAgentId).not.toHaveBeenCalled();
    expect(mocks.resolveAgentContext).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "lobster", sessionKey: "agent:lobster:facetime" }),
    );
    expect(mocks.sessionParams?.instructions).toContain("Speak warmly and keep answers short.");
    expect(mocks.sessionParams?.instructions?.match(/Agent context:/g)).toHaveLength(1);
    expect(mocks.sessionParams?.instructions).toContain("Name: Tide");
    expect(mocks.sessionParams?.instructions).toContain("same configured OpenClaw agent");
    expect(mocks.sessionParams?.instructions).toContain(
      "authenticated owner/user described by the loaded workspace profile context",
    );
    expect(mocks.sessionParams?.instructions).toContain(
      "Answer greetings, acknowledgements, and questions about your own identity or persona directly",
    );
    expect(mocks.sessionParams?.instructions).toContain("Consult behavior: substantive.");
    expect(mocks.sessionParams?.instructions).toContain("Never claim you retried");
    expect(mocks.sessionParams?.instructions).not.toContain("Lobster");
    expect(mocks.sessionParams?.instructions).not.toContain("Omar");
  });
});
