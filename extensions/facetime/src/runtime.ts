import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { FaceTimeCallRegistry } from "./call-lifecycle.js";
import { resolveFaceTimeConfig, validateFaceTimeConfig, type FaceTimeConfig } from "./config.js";
import { installFaceTimeDriver } from "./driver-setup.js";
import {
  resolveFaceTimeDialRequest,
  type FaceTimeDialMode,
  type FaceTimeDialRequest,
} from "./outbound-call.js";
import { ensureCaptureBinary } from "./plugin-paths.js";
import { runFaceTimePreflight, type FaceTimePreflightResult } from "./preflight.js";
import { createFaceTimeCallControl } from "./runtime-call-control.js";
import { ActiveFaceTimeCall, type FaceTimeRuntimeStatus } from "./runtime-state.js";
import { buildFaceTimeRuntimeStatus } from "./runtime-status.js";
import { runFaceTimeSetup, type FaceTimeSetupReport } from "./setup.js";

export type { FaceTimeRuntimeStatus } from "./runtime-state.js";

export type FaceTimeDialResult = FaceTimeDialRequest & {
  dialID: string;
  state: "operator-action-required";
  guidance: string;
};

export type FaceTimeAttachResult = {
  callUUID: string;
  handle: string;
  mode: FaceTimeDialMode;
  state: "attached";
  admission: "operator-confirmed-owner";
};

export type FaceTimeRuntime = {
  config: FaceTimeConfig;
  status(): Promise<FaceTimeRuntimeStatus>;
  setup(): Promise<FaceTimeSetupReport>;
  preflight(): Promise<FaceTimePreflightResult>;
  dial(params: { handle: unknown; mode?: unknown }): Promise<FaceTimeDialResult>;
  attach(params: { handle: unknown; mode?: unknown }): Promise<FaceTimeAttachResult>;
  hangup(params?: { callUUID?: unknown }): Promise<{
    callUUID: string;
    detached: true;
    manualHangupRequired: true;
  }>;
  installDriver(): Promise<{ started: true }>;
  stop(): Promise<void>;
};

function faceTimeUrl(request: FaceTimeDialRequest): string {
  const scheme = request.mode === "video" ? "facetime" : "facetime-audio";
  return `${scheme}://${encodeURIComponent(request.handle)}`;
}

export async function createFaceTimeRuntime(params: {
  config: FaceTimeConfig;
  fullConfig: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
  pluginRoot: string;
}): Promise<FaceTimeRuntime> {
  const config = resolveFaceTimeConfig(params.config);
  if (!config.enabled) {
    throw new Error("facetime disabled in plugin config");
  }
  const validation = validateFaceTimeConfig(config);
  if (!validation.valid) {
    throw new Error(`Invalid facetime config: ${validation.errors.join("; ")}`);
  }

  const captureBinary = await ensureCaptureBinary();
  const calls = new FaceTimeCallRegistry<ActiveFaceTimeCall>();
  let stopping = false;
  let driverInstall: FaceTimeRuntimeStatus["driverInstall"] = { phase: "idle" };
  let driverInstallAbortController: AbortController | undefined;
  let driverInstallTask: Promise<void> | undefined;
  const callControl = createFaceTimeCallControl({
    calls,
    config,
    fullConfig: params.fullConfig,
    runtime: params.runtime,
    logger: params.logger,
    captureBinary,
    isStopping: () => stopping,
  });

  const readStatus = () => buildFaceTimeRuntimeStatus({ calls, driverInstall });
  const runPreflight = () =>
    runFaceTimePreflight({
      config,
      fullConfig: params.fullConfig,
      runtime: params.runtime,
      logger: params.logger,
      captureBinary,
    });

  return {
    config,
    async status() {
      return readStatus();
    },
    async dial(dialParams) {
      if (stopping) {
        throw new Error("cannot open FaceTime while the plugin is stopping");
      }
      if (calls.size > 0) {
        throw new Error("OpenClaw is already attached to a FaceTime call");
      }
      const request = resolveFaceTimeDialRequest({
        handle: dialParams.handle,
        mode: dialParams.mode,
        ownerHandles: config.ownerHandles,
      });
      const result = await params.runtime.system.runCommandWithTimeout(
        ["/usr/bin/open", faceTimeUrl(request)],
        { timeoutMs: 10_000 },
      );
      if (result.code !== 0) {
        throw new Error(
          `Could not open FaceTime: ${result.stderr || result.stdout || `exit ${result.code}`}`,
        );
      }
      return {
        ...request,
        dialID: randomUUID(),
        state: "operator-action-required",
        guidance: "Confirm or answer the call in FaceTime, then run attach_current_call.",
      };
    },
    async attach(attachParams) {
      if (stopping) {
        throw new Error("cannot attach while the plugin is stopping");
      }
      if (driverInstall.phase === "installing") {
        throw new Error("audio driver installation is pending");
      }
      if (calls.size > 0) {
        throw new Error("OpenClaw is already attached to a FaceTime call");
      }
      const request = resolveFaceTimeDialRequest({
        handle: attachParams.handle,
        mode: attachParams.mode,
        ownerHandles: config.ownerHandles,
      });
      const call = new ActiveFaceTimeCall({
        callUUID: randomUUID(),
        handle: request.handle,
        mode: request.mode,
      });
      calls.create(call);
      try {
        await callControl.startCallTalk(call);
        await callControl.activateCallTalk(call);
      } catch (error) {
        await callControl.closeCall(call, "attach-failed");
        throw error;
      }
      return {
        callUUID: call.callUUID,
        handle: call.handle,
        mode: call.mode,
        state: "attached",
        admission: call.admission,
      };
    },
    async hangup(hangupParams) {
      const requested =
        typeof hangupParams?.callUUID === "string" && hangupParams.callUUID.trim()
          ? hangupParams.callUUID.trim()
          : undefined;
      const call = requested ? calls.get(requested) : calls.active;
      if (!call) {
        throw new Error("no OpenClaw FaceTime attachment is active");
      }
      await callControl.closeCall(call, "operator-detach");
      return { callUUID: call.callUUID, detached: true, manualHangupRequired: true };
    },
    async setup() {
      const preflight = runPreflight();
      return await runFaceTimeSetup({
        config,
        nativePackageReady: true,
        pluginRoot: params.pluginRoot,
        runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
        runtimeStatus: readStatus(),
        preflight,
      });
    },
    async preflight() {
      return await runPreflight();
    },
    async installDriver() {
      if (stopping) {
        throw new Error("cannot install the FaceTime audio driver while stopping");
      }
      if (driverInstall.phase === "installing") {
        throw new Error("FaceTime audio driver installation is already pending");
      }
      if (calls.size > 0) {
        throw new Error("Cannot install the FaceTime audio driver while attached to a call");
      }
      driverInstall = { phase: "installing", startedAt: new Date().toISOString() };
      const controller = new AbortController();
      driverInstallAbortController = controller;
      driverInstallTask = installFaceTimeDriver({
        pluginRoot: params.pluginRoot,
        runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
        callActive: false,
        signal: controller.signal,
      })
        .then((result) => {
          driverInstall = {
            phase: "succeeded",
            startedAt: driverInstall.startedAt,
            finishedAt: new Date().toISOString(),
            changed: result.changed,
          };
        })
        .catch((error: unknown) => {
          driverInstall = {
            phase: "failed",
            startedAt: driverInstall.startedAt,
            finishedAt: new Date().toISOString(),
            error: formatErrorMessage(error),
          };
        })
        .finally(() => {
          driverInstallAbortController = undefined;
          driverInstallTask = undefined;
        });
      return { started: true };
    },
    async stop() {
      stopping = true;
      driverInstallAbortController?.abort();
      await driverInstallTask;
      const call = calls.active;
      if (call) {
        await callControl.stopCall(call, "runtime-stop");
      }
    },
  };
}
