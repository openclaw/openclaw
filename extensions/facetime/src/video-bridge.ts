import { createHash } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type {
  LiveVisualHealth,
  LiveVisualInputEvent,
  LiveVisualProvider,
} from "openclaw/plugin-sdk/live-visual";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";
import type { FaceTimeVideoConfig } from "./config.js";
import { FaceTimeObsVideoController } from "./obs-video-controller.js";

export type FaceTimeVideoState = "idle" | "listening" | "thinking" | "speaking";

export type FaceTimeVideoBridgeStatus = {
  enabled: true;
  active: boolean;
  provider: string;
  health: LiveVisualHealth;
  error?: string;
};

export type FaceTimeVideoBridge = {
  sendAudio(audio: Uint8Array): boolean;
  setState(state: FaceTimeVideoState): void;
  clear(reason: string): void;
  status(): FaceTimeVideoBridgeStatus;
  stop(reason?: string): Promise<void>;
};

type VideoBridgeDependencies = {
  resolveProvider: (params: {
    providerId: string;
    config?: OpenClawConfig;
  }) => LiveVisualProvider | undefined | Promise<LiveVisualProvider | undefined>;
  createObs: (params: {
    config: FaceTimeVideoConfig;
    logger: RuntimeLogger;
    inputName: string;
    sceneName: string;
  }) => FaceTimeObsVideoController;
};

const DEFAULT_DEPENDENCIES: VideoBridgeDependencies = {
  resolveProvider: async (params) => {
    const sdk = await import("openclaw/plugin-sdk/live-visual");
    return sdk.resolveLiveVisualProvider(params);
  },
  createObs: (params) => new FaceTimeObsVideoController(params),
};

export async function startFaceTimeVideoBridge(params: {
  config: FaceTimeVideoConfig;
  fullConfig: OpenClawConfig;
  logger: RuntimeLogger;
  callUUID: string;
  signal?: AbortSignal;
  dependencies?: Partial<VideoBridgeDependencies>;
}): Promise<FaceTimeVideoBridge | undefined> {
  if (!params.config.enabled) {
    return undefined;
  }
  params.signal?.throwIfAborted();
  const dependencies = { ...DEFAULT_DEPENDENCIES, ...params.dependencies };
  const provider = await dependencies.resolveProvider({
    providerId: params.config.provider,
    config: params.fullConfig,
  });
  if (!provider) {
    throw new Error(`live-visual provider not found: ${params.config.provider}`);
  }

  const session = await provider.open({
    streamId: params.callUUID,
    clock: { unitsPerSecond: 24_000 },
    video: {
      width: params.config.width,
      height: params.config.height,
      frameRate: params.config.frameRate,
    },
    audio: { encoding: "pcm-s16le", sampleRateHz: 24_000, channels: 1 },
  });
  if (params.signal?.aborted) {
    await session.close("startup-aborted");
    params.signal.throwIfAborted();
  }
  const inputSuffix = createHash("sha256").update(params.callUUID).digest("hex").slice(0, 12);
  const obs = dependencies.createObs({
    config: params.config,
    logger: params.logger,
    inputName: `${params.config.obs.sourceName.slice(0, 80)} (${inputSuffix})`,
    sceneName: `${params.config.obs.sceneName.slice(0, 80)} (${inputSuffix})`,
  });
  let lastHealth: LiveVisualHealth;
  try {
    const password = await resolveConfiguredSecretInputString({
      config: params.fullConfig,
      env: process.env,
      value: params.config.obs.password,
      path: "plugins.entries.facetime.config.video.obs.password",
    });
    if (password.unresolvedRefReason) {
      throw new Error(password.unresolvedRefReason);
    }
    params.signal?.throwIfAborted();
    await obs.attach(session.output.url, session.output.video, password.value);
    params.signal?.throwIfAborted();
    await obs.startVirtualCamera();
    params.signal?.throwIfAborted();
    lastHealth = session.health();
    if (lastHealth.status === "degraded" || lastHealth.status === "closed") {
      throw new Error(lastHealth.error ?? `live-visual provider is ${lastHealth.status}`);
    }
  } catch (error) {
    await Promise.allSettled([
      obs.stop(),
      session.close(params.signal?.aborted ? "startup-aborted" : "obs-start-failed"),
    ]);
    throw error;
  }

  let pts = 0;
  let speaking = false;
  let closed = false;
  let retiring: Promise<void> | undefined;
  let errorMessage: string | undefined;
  let hadReadyVisual = lastHealth.status === "ready";

  const retire = (reason: string) =>
    (retiring ??= (async () => {
      closed = true;
      await Promise.allSettled([obs.stop(), session.close(reason)]);
    })());

  const degrade = (reason: string) => {
    if (errorMessage) {
      return;
    }
    errorMessage = reason;
    params.logger.warn?.(`[facetime] video bridge degraded: ${reason}`);
    void retire("video-degraded");
  };

  const inspect = (accepted: boolean) => {
    if (closed) {
      return false;
    }
    try {
      const health = session.health();
      const overflowed = health.droppedMediaBytes > lastHealth.droppedMediaBytes;
      if (health.status === "ready") {
        hadReadyVisual = true;
      }
      lastHealth = health;
      if (
        health.status === "degraded" ||
        health.status === "closed" ||
        overflowed ||
        (!accepted && hadReadyVisual)
      ) {
        degrade(
          health.error ??
            (overflowed
              ? "live-visual provider overflow"
              : `live-visual provider ${health.status === "closed" ? "closed" : "disconnected"}`),
        );
        return false;
      }
      return accepted;
    } catch (error) {
      degrade(formatErrorMessage(error));
      return false;
    }
  };

  const write = (event: LiveVisualInputEvent) => {
    if (closed) {
      return false;
    }
    try {
      return inspect(session.write(event));
    } catch (error) {
      degrade(formatErrorMessage(error));
      return false;
    }
  };

  const setState = (state: FaceTimeVideoState) => {
    write({ type: "cue", pts, name: "activity", value: state });
  };
  setState("listening");

  return {
    sendAudio(audio) {
      if (!speaking) {
        speaking = true;
        setState("speaking");
      }
      const accepted = write({ type: "audio", pts, data: audio });
      pts += Math.floor(audio.byteLength / 2);
      return accepted;
    },
    setState(state) {
      speaking = state === "speaking";
      setState(state);
    },
    clear(reason) {
      speaking = false;
      write({ type: "flush", reason });
      setState("listening");
    },
    status() {
      return {
        enabled: true,
        active: !closed,
        provider: params.config.provider,
        health: lastHealth,
        error: errorMessage,
      };
    },
    stop(reason = "closed") {
      return retire(reason);
    },
  };
}
