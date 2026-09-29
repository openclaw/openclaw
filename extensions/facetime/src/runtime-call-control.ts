import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { FACETIME_FEED_DEVICE_NAME, FACETIME_MIC_DEVICE_NAME } from "./audio-pump.js";
import type { FaceTimeCallRegistry } from "./call-lifecycle.js";
import type { FaceTimeConfig } from "./config.js";
import type { ActiveFaceTimeCall } from "./runtime-state.js";
import { startFaceTimeTalkDriver } from "./talk-driver.js";

export function createFaceTimeCallControl(params: {
  calls: FaceTimeCallRegistry<ActiveFaceTimeCall>;
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  captureBinary: string;
  isStopping: () => boolean;
}) {
  const routeCallAudio = async (call: ActiveFaceTimeCall) => {
    if (call.audioReady) {
      return;
    }
    const routing =
      call.audioRouting ??
      (async () => {
        if (call.lifecycleAbort.signal.aborted || params.calls.active !== call) {
          throw new Error("FaceTime attachment closed during audio routing");
        }
        await access(params.captureBinary, constants.X_OK);
        call.audioReady = true;
        call.audioTransport = {
          captureBinary: params.captureBinary,
          feedDevice: FACETIME_FEED_DEVICE_NAME,
          microphoneDevice: FACETIME_MIC_DEVICE_NAME,
          processInputVerified: false,
          processOutputSuppressed: false,
        };
        call.lastRoutingError = undefined;
      })();
    call.audioRouting = routing;
    try {
      await routing;
    } catch (error) {
      call.audioReady = false;
      call.lastRoutingError = formatErrorMessage(error);
      throw error;
    } finally {
      if (call.audioRouting === routing) {
        call.audioRouting = undefined;
      }
    }
  };

  const closeCall = async (call: ActiveFaceTimeCall, reason: string) => {
    if (params.calls.active !== call) {
      return;
    }
    call.beginClosing();
    await call.audioRouting?.catch(() => undefined);
    await call.talkStarting?.catch(() => undefined);
    await call.talk?.close(reason).catch((error: unknown) => {
      params.logger.debug?.(`[facetime] talk close ignored: ${formatErrorMessage(error)}`);
    });
    await call.talkActivation?.catch(() => undefined);
    call.audioReady = false;
    call.audioTransport = undefined;
    call.markCarrierClosed();
    params.calls.close(call);
    params.logger.info(`[facetime] detached from active FaceTime call (${reason})`);
  };

  const startCallTalk = async (call: ActiveFaceTimeCall) => {
    if (call.talk) {
      return;
    }
    call.talkStarting ??= (async () => {
      await routeCallAudio(call);
      const talk = await startFaceTimeTalkDriver({
        config: params.config,
        fullConfig: params.fullConfig,
        runtime: params.runtime,
        logger: params.logger,
        callUUID: call.callUUID,
        senderId: call.senderId,
        senderIsOwner: true,
        captureBinary: params.captureBinary,
        signal: call.lifecycleAbort.signal,
        async onFailure(error) {
          queueMicrotask(() => void closeCall(call, `media-failed: ${formatErrorMessage(error)}`));
          return true;
        },
      });
      if (params.isStopping() || params.calls.active !== call) {
        await talk.close("attachment-ended-during-start");
        return;
      }
      call.talk = talk;
      if (call.audioTransport) {
        call.audioTransport.processOutputSuppressed = true;
      }
    })();
    const starting = call.talkStarting;
    try {
      await starting;
    } finally {
      if (call.talkStarting === starting) {
        call.talkStarting = undefined;
      }
    }
  };

  const activateCallTalk = async (call: ActiveFaceTimeCall) => {
    const generation = call.captureGeneration();
    call.talkActivation ??= (async () => {
      await call.talk?.readyForAudio();
      call.assertCurrent(generation);
      call.markModelReady(generation);
      call.markCarrierActive(generation);
      call.markModelActive(generation);
      call.talk?.activate();
      if (call.audioTransport) {
        call.audioTransport.processInputVerified = true;
        call.audioTransport.processOutputSuppressed = call.talk?.processOutputSuppressed() === true;
      }
    })();
    const activation = call.talkActivation;
    try {
      await activation;
    } finally {
      if (call.talkActivation === activation) {
        call.talkActivation = undefined;
      }
    }
  };

  return { activateCallTalk, closeCall, startCallTalk, stopCall: closeCall };
}
