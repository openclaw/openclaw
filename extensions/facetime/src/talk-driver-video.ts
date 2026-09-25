import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import type { FaceTimeVideoConfig } from "./config.js";
import {
  startFaceTimeVideoBridge,
  type FaceTimeVideoBridge,
  type FaceTimeVideoBridgeStatus,
  type FaceTimeVideoState,
} from "./video-bridge.js";

const VIDEO_START_TIMEOUT_MS = 15_000;
const VIDEO_STOP_TIMEOUT_MS = 2_000;

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMs: number,
  message: string,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(message));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export type FaceTimeTalkVideo = {
  start(): void;
  sendAudio(audio: Uint8Array): void;
  setState(state: FaceTimeVideoState): void;
  clear(reason: string): void;
  status(): FaceTimeVideoBridgeStatus | undefined;
  stop(reason: string): Promise<void>;
};

/** Keeps optional video startup/failure outside the audio call's health boundary. */
export function createFaceTimeTalkVideo(params: {
  config: FaceTimeVideoConfig;
  fullConfig: OpenClawConfig;
  logger: RuntimeLogger;
  callUUID: string;
  isRetired: () => boolean;
}): FaceTimeTalkVideo {
  let active: FaceTimeVideoBridge | undefined;
  let starting: Promise<void> | undefined;
  let startAbort: AbortController | undefined;
  let lastStatus: FaceTimeVideoBridgeStatus | undefined = params.config.enabled
    ? {
        enabled: true,
        active: false,
        provider: params.config.provider,
        health: { status: "starting", droppedMediaBytes: 0 },
      }
    : undefined;

  const start = () =>
    (starting ??= (async () => {
      if (!params.config.enabled) {
        return;
      }
      startAbort = new AbortController();
      try {
        const bridge = await withTimeout(
          startFaceTimeVideoBridge({ ...params, signal: startAbort.signal }),
          VIDEO_START_TIMEOUT_MS,
          "video bridge startup timed out after 15 seconds",
          () => startAbort?.abort(),
        );
        if (params.isRetired()) {
          await bridge?.stop("startup-retired");
          return;
        }
        active = bridge;
        lastStatus = bridge?.status() ?? lastStatus;
      } catch (error) {
        const message = formatErrorMessage(error);
        lastStatus = {
          enabled: true,
          active: false,
          provider: params.config.provider,
          health: { status: "degraded", droppedMediaBytes: 0, error: message },
          error: message,
        };
        params.logger.warn?.(`[facetime] video bridge unavailable: ${message}`);
      }
    })());

  return {
    start() {
      void start();
    },
    sendAudio(audio) {
      active?.sendAudio(audio);
    },
    setState(state) {
      active?.setState(state);
    },
    clear(reason) {
      active?.clear(reason);
    },
    status() {
      return active?.status() ?? lastStatus;
    },
    async stop(reason) {
      startAbort?.abort();
      const bridge = active;
      active = undefined;
      const status = bridge?.status() ?? lastStatus;
      if (status) {
        lastStatus = {
          ...status,
          active: false,
          health: { ...status.health, status: "closed" },
        };
      }
      if (!bridge) {
        return;
      }
      await withTimeout(
        bridge.stop(reason),
        VIDEO_STOP_TIMEOUT_MS,
        "video bridge cleanup timed out after 2 seconds",
      ).catch((error) => {
        params.logger.warn?.(`[facetime] ${formatErrorMessage(error)}`);
      });
    },
  };
}
