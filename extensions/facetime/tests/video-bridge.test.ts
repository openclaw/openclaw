import type { LiveVisualHealth } from "openclaw/plugin-sdk/live-visual";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveFaceTimeConfig } from "../src/config.js";
import { startFaceTimeVideoBridge } from "../src/video-bridge.js";

function createHarness() {
  let health: LiveVisualHealth = { status: "ready", droppedMediaBytes: 0 };
  const session = {
    output: {
      kind: "browser-source" as const,
      url: "http://127.0.0.1:18794/avatar/?token=secret",
      video: { width: 800, height: 600, frameRate: 24 },
    },
    write: vi.fn(() => true),
    health: vi.fn(() => health),
    close: vi.fn(async () => {}),
  };
  const provider = {
    id: "lobster",
    label: "OpenClaw Lobster",
    open: vi.fn(async () => session),
  };
  const obs = {
    attach: vi.fn(async () => {}),
    startVirtualCamera: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as RuntimeLogger;
  const config = resolveFaceTimeConfig({
    video: {
      enabled: true,
      width: 960,
      height: 540,
      frameRate: 24,
      obs: { password: "test-password" },
    },
  }).video;
  return {
    config,
    logger,
    obs,
    provider,
    session,
    setHealth(next: typeof health) {
      health = next;
    },
  };
}

describe("FaceTime video bridge", () => {
  it("drives one live visual with exact sample-clock PCM and terminal cleanup", async () => {
    const { config, logger, obs, provider, session } = createHarness();
    const bridge = await startFaceTimeVideoBridge({
      config,
      fullConfig: {},
      logger,
      callUUID: "opaque-call",
      dependencies: {
        resolveProvider: () => provider,
        createObs: () => obs as never,
      },
    });

    expect(provider.open).toHaveBeenCalledWith({
      streamId: "opaque-call",
      clock: { unitsPerSecond: 24_000 },
      video: { width: 960, height: 540, frameRate: 24 },
      audio: { encoding: "pcm-s16le", sampleRateHz: 24_000, channels: 1 },
    });
    expect(obs.attach).toHaveBeenCalledWith(
      session.output.url,
      session.output.video,
      "test-password",
    );
    expect(obs.startVirtualCamera).toHaveBeenCalledOnce();

    const first = Buffer.alloc(480);
    const second = Buffer.alloc(960);
    expect(bridge?.sendAudio(first)).toBe(true);
    expect(bridge?.sendAudio(second)).toBe(true);
    expect(session.write).toHaveBeenCalledWith({ type: "audio", pts: 0, data: first });
    expect(session.write).toHaveBeenCalledWith({ type: "audio", pts: 240, data: second });

    bridge?.clear("barge-in");
    expect(session.write).toHaveBeenCalledWith({ type: "flush", reason: "barge-in" });
    expect(session.write).toHaveBeenCalledWith({
      type: "cue",
      pts: 720,
      name: "activity",
      value: "listening",
    });

    await bridge?.stop("hangup");
    expect(obs.stop).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledWith("hangup");
  });

  it("releases the provider session when OBS cannot attach", async () => {
    const { config, logger, obs, provider, session } = createHarness();
    obs.attach.mockRejectedValueOnce(new Error("OBS unavailable"));

    await expect(
      startFaceTimeVideoBridge({
        config,
        fullConfig: {},
        logger,
        callUUID: "call",
        dependencies: {
          resolveProvider: () => provider,
          createObs: () => obs as never,
        },
      }),
    ).rejects.toThrow("OBS unavailable");

    expect(obs.stop).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledWith("obs-start-failed");
  });

  it("releases OBS and the provider when initial health cannot be read", async () => {
    const { config, logger, obs, provider, session } = createHarness();
    session.health.mockImplementationOnce(() => {
      throw new Error("provider retired");
    });

    await expect(
      startFaceTimeVideoBridge({
        config,
        fullConfig: {},
        logger,
        callUUID: "call",
        dependencies: {
          resolveProvider: () => provider,
          createObs: () => obs as never,
        },
      }),
    ).rejects.toThrow("provider retired");

    expect(obs.stop).toHaveBeenCalledOnce();
    expect(session.close).toHaveBeenCalledWith("obs-start-failed");
  });

  it("degrades and retires video on provider backpressure without throwing", async () => {
    const { config, logger, obs, provider, session, setHealth } = createHarness();
    const bridge = await startFaceTimeVideoBridge({
      config,
      fullConfig: {},
      logger,
      callUUID: "call",
      dependencies: {
        resolveProvider: () => provider,
        createObs: () => obs as never,
      },
    });
    setHealth({ status: "ready", droppedMediaBytes: 480 });

    expect(bridge?.sendAudio(Buffer.alloc(480))).toBe(false);
    await vi.waitFor(() => expect(obs.stop).toHaveBeenCalledOnce());
    expect(bridge?.status()).toMatchObject({
      active: false,
      error: "live-visual provider overflow",
    });
  });

  it("retires a provider that closes after startup", async () => {
    const { config, logger, obs, provider, session, setHealth } = createHarness();
    const bridge = await startFaceTimeVideoBridge({
      config,
      fullConfig: {},
      logger,
      callUUID: "call",
      dependencies: {
        resolveProvider: () => provider,
        createObs: () => obs as never,
      },
    });
    setHealth({ status: "closed", droppedMediaBytes: 0 });

    expect(bridge?.sendAudio(Buffer.alloc(480))).toBe(false);
    await vi.waitFor(() => expect(obs.stop).toHaveBeenCalledOnce());
    expect(bridge?.status()).toMatchObject({ active: false, error: "live-visual provider closed" });
  });
});
