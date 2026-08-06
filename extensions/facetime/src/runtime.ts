import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { FACETIME_FEED_DEVICE_NAME, FACETIME_MIC_DEVICE_NAME } from "./audio-pump.js";
import {
  isActiveCall,
  isEndedCall,
  isIncomingRingingCall,
  isOutgoingRingingCall,
  isWhitelistedFaceTimeCall,
  canonicalizeFaceTimeHandle,
  normalizeFaceTimeCallEvent,
  normalizeFaceTimeHandle,
  normalizeFaceTimeHandleCandidates,
  resolveAllowlistedFaceTimeOwner,
  type AuthenticatedFaceTimeOwner,
  type FaceTimeCallStatusEvent,
} from "./call-events.js";
import { resolveFaceTimeConfig, validateFaceTimeConfig, type FaceTimeConfig } from "./config.js";
import { installFaceTimeDriver } from "./driver-setup.js";
import { formatErrorMessage } from "./errors.js";
import {
  FaceTimeHelperActionError,
  FaceTimeHelperAmbiguousError,
  FaceTimeHelperSocketServer,
  FaceTimeHelperUnavailableError,
  type HelperActionResult,
} from "./helper-rpc.js";
import {
  FaceTimeHelperSupervisor,
  type FaceTimeHelperSupervisorStatus,
} from "./helper-supervisor.js";
import {
  doesPendingFaceTimeDialHaveCallUUID,
  doesFaceTimeCallMatchPendingDial,
  normalizeFaceTimeOutboundIdentityEvent,
  resolveFaceTimeDialRequest,
  resolveFaceTimeDialResult,
  retainFaceTimeDialCallUUID,
  type FaceTimeDialMode,
  type FaceTimeDialResult,
  type PendingFaceTimeDial,
} from "./outbound-call.js";
import { assertPairedAudioTransport } from "./paired-audio-transport.js";
import { ensureCaptureBinary, ensureHelperArtifacts } from "./plugin-paths.js";
import { runFaceTimePreflight, type FaceTimePreflightResult } from "./preflight.js";
import { runFaceTimeSetup, type FaceTimeSetupReport } from "./setup.js";
import { startFaceTimeTalkDriver, type FaceTimeTalkDriver } from "./talk-driver.js";
import { summarizeRecentTalkEvents, type FaceTimeTalkEventSummary } from "./talk-events-summary.js";
import { playFaceTimeTestAudio } from "./test-audio.js";

type ActiveFaceTimeCall = {
  callUUID: string;
  callUUIDAliases?: Set<string>;
  lifecycleAbort: AbortController;
  /** Verified at the FaceTime allowlist or authorized outbound-dial boundary. */
  senderId: string;
  senderIsOwner: true;
  handle?: string;
  callStatus?: number;
  isSendingAudio?: boolean;
  isSendingTransmission?: boolean;
  isUplinkMuted?: boolean;
  isSendingVideo?: boolean;
  conversationUUID?: string;
  conversationGroupUUID?: string;
  conversationAudioEnabled?: boolean;
  conversationVideoEnabled?: boolean;
  conversationAVMode?: number;
  conversationResolvedAudioVideoMode?: number;
  localMeterLevel?: number;
  remoteMeterLevel?: number;
  maxLocalMeterLevel?: number;
  maxRemoteMeterLevel?: number;
  audioReady: boolean;
  audioTransport?: {
    captureBinary: string;
    feedDevice: string;
    microphoneDevice: string;
    processInputVerified: boolean;
    processOutputSuppressed: boolean;
  };
  lastHelperAction?: HelperActionResult;
  lastRoutingError?: string;
  audioRouting?: Promise<void>;
  talk?: FaceTimeTalkDriver;
  talkStarting?: Promise<void>;
  talkActivation?: Promise<void>;
  audioEnabled?: boolean;
  audioEnablePromise?: Promise<void>;
  unmuteRequested?: boolean;
  carrierHangupPending?: boolean;
  carrierHangupRetryTimer?: NodeJS.Timeout;
  carrierHangupAttempt?: Promise<boolean>;
  carrierHangupRequired?: boolean;
};

const OUTBOUND_RECONCILE_ATTEMPTS = 12;
const OUTBOUND_RECONCILE_INTERVAL_MS = 250;
const OUTBOUND_RECONCILE_DELAY_MS = 1_000;
const OUTBOUND_DIAL_HELPER_BUNDLES = new Set([
  "com.apple.FaceTime",
  "com.apple.FaceTime.FTConversationService",
]);

function resolveAuthorizedOutboundOwner(pending: PendingFaceTimeDial): AuthenticatedFaceTimeOwner {
  // Pending dials are created only by resolveFaceTimeDialRequest, which rejects
  // handles outside whitelistHandles before native dialing starts.
  return { senderId: canonicalizeFaceTimeHandle(pending.handle), senderIsOwner: true };
}

export type FaceTimeRuntimeStatus = {
  enabled: true;
  helperConnected: boolean;
  helperTargets: FaceTimeHelperSupervisorStatus;
  driverInstallPending: boolean;
  driverInstall: {
    phase: "idle" | "installing" | "succeeded" | "failed";
    startedAt?: string;
    finishedAt?: string;
    changed?: boolean;
    error?: string;
  };
  processOutputSuppressed: boolean;
  outboundCallPending?: {
    dialID: string;
    delivery: PendingFaceTimeDial["delivery"];
    handle: string;
    mode: FaceTimeDialMode;
    requestedAt: string;
    proxyIdentifier?: string;
  };
  calls: Array<{
    callUUID: string;
    handle?: string;
    callStatus?: number;
    isSendingAudio?: boolean;
    isSendingTransmission?: boolean;
    isUplinkMuted?: boolean;
    isSendingVideo?: boolean;
    conversationUUID?: string;
    conversationGroupUUID?: string;
    conversationAudioEnabled?: boolean;
    conversationVideoEnabled?: boolean;
    conversationAVMode?: number;
    conversationResolvedAudioVideoMode?: number;
    localMeterLevel?: number;
    remoteMeterLevel?: number;
    maxLocalMeterLevel?: number;
    maxRemoteMeterLevel?: number;
    realtimeActive: boolean;
    audioReady: boolean;
    audioTransport?: ActiveFaceTimeCall["audioTransport"];
    lastHelperAction?: HelperActionResult;
    lastRoutingError?: string;
    carrierHangupPending?: boolean;
    recentTalkEvents?: FaceTimeTalkEventSummary[];
  }>;
};

export type FaceTimeRuntime = {
  config: FaceTimeConfig;
  status(): Promise<FaceTimeRuntimeStatus>;
  setup(): Promise<FaceTimeSetupReport>;
  preflight(): Promise<FaceTimePreflightResult>;
  dial(params: { handle: unknown; mode?: unknown }): Promise<FaceTimeDialResult>;
  hangup(params?: { callUUID?: unknown }): Promise<{ callUUID?: string; dialID?: string }>;
  testAudio(params?: { phrase?: unknown }): Promise<{ phrase: string; deviceName: string }>;
  installDriver(): Promise<{ started: true }>;
  stop(): Promise<void>;
};

function readCallUUID(event: FaceTimeCallStatusEvent): string {
  return String(event.data.call_uuid);
}

function isCarrierAlreadyGoneError(error: unknown): boolean {
  const message = formatErrorMessage(error);
  return /call not found|not waiting to be left/iu.test(message);
}

function updateCallStatus(call: ActiveFaceTimeCall, event: FaceTimeCallStatusEvent): void {
  call.callStatus =
    typeof event.data.call_status === "number" ? event.data.call_status : call.callStatus;
  call.isSendingAudio =
    typeof event.data.is_sending_audio === "boolean"
      ? event.data.is_sending_audio
      : call.isSendingAudio;
  call.isSendingTransmission =
    typeof event.data.is_sending_transmission === "boolean"
      ? event.data.is_sending_transmission
      : call.isSendingTransmission;
  call.isUplinkMuted =
    typeof event.data.is_uplink_muted === "boolean"
      ? event.data.is_uplink_muted
      : call.isUplinkMuted;
  call.isSendingVideo =
    typeof event.data.is_sending_video === "boolean"
      ? event.data.is_sending_video
      : call.isSendingVideo;
  call.conversationUUID =
    typeof event.data.conversation_uuid === "string"
      ? event.data.conversation_uuid
      : call.conversationUUID;
  call.conversationGroupUUID =
    typeof event.data.conversation_group_uuid === "string"
      ? event.data.conversation_group_uuid
      : call.conversationGroupUUID;
  call.conversationAudioEnabled =
    typeof event.data.conversation_audio_enabled === "boolean"
      ? event.data.conversation_audio_enabled
      : call.conversationAudioEnabled;
  call.conversationVideoEnabled =
    typeof event.data.conversation_video_enabled === "boolean"
      ? event.data.conversation_video_enabled
      : call.conversationVideoEnabled;
  call.conversationAVMode =
    typeof event.data.conversation_av_mode === "number"
      ? event.data.conversation_av_mode
      : call.conversationAVMode;
  call.conversationResolvedAudioVideoMode =
    typeof event.data.conversation_resolved_audio_video_mode === "number"
      ? event.data.conversation_resolved_audio_video_mode
      : call.conversationResolvedAudioVideoMode;
  call.localMeterLevel =
    typeof event.data.local_meter_level === "number"
      ? event.data.local_meter_level
      : call.localMeterLevel;
  call.remoteMeterLevel =
    typeof event.data.remote_meter_level === "number"
      ? event.data.remote_meter_level
      : call.remoteMeterLevel;
  if (typeof event.data.local_meter_level === "number") {
    call.maxLocalMeterLevel = Math.max(call.maxLocalMeterLevel ?? 0, event.data.local_meter_level);
  }
  if (typeof event.data.remote_meter_level === "number") {
    call.maxRemoteMeterLevel = Math.max(
      call.maxRemoteMeterLevel ?? 0,
      event.data.remote_meter_level,
    );
  }
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

  const calls = new Map<string, ActiveFaceTimeCall>();
  let outboundDialInFlight: Promise<FaceTimeDialResult> | undefined;
  let outboundCallPending: PendingFaceTimeDial | undefined;
  let outboundReconcileTimer: NodeJS.Timeout | undefined;
  let driverInstallPending = false;
  let driverInstall: FaceTimeRuntimeStatus["driverInstall"] = { phase: "idle" };
  let driverInstallAbortController: AbortController | undefined;
  let driverInstallTask: Promise<void> | undefined;
  const captureBinary = await ensureCaptureBinary({
    pluginRoot: params.pluginRoot,
    runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
  });
  const { buildId: helperBuildId, ipcKey: helperIpcKey } = await ensureHelperArtifacts({
    pluginRoot: params.pluginRoot,
    runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
  });
  let stopping = false;
  const clearOutboundCallPending = () => {
    if (outboundReconcileTimer) {
      clearTimeout(outboundReconcileTimer);
      outboundReconcileTimer = undefined;
    }
    outboundCallPending = undefined;
  };
  const readHelperResults = (result: HelperActionResult): HelperActionResult[] =>
    Array.isArray(result.helperResults)
      ? result.helperResults.filter((entry): entry is HelperActionResult =>
          Boolean(entry && typeof entry === "object"),
        )
      : [result];
  const readOutboundCallUUID = (result: HelperActionResult): string | undefined =>
    readHelperResults(result)
      .map((entry) =>
        typeof entry.call_uuid === "string" && entry.call_uuid.trim()
          ? entry.call_uuid.trim()
          : undefined,
      )
      .find((value) => Boolean(value));
  const readOutboundProxyIdentifier = (result: HelperActionResult): string | undefined =>
    readHelperResults(result)
      .map((entry) =>
        typeof entry.proxy_identifier === "string" && entry.proxy_identifier.trim()
          ? entry.proxy_identifier.trim()
          : undefined,
      )
      .find((value) => Boolean(value));
  const hasDialHelperConfirmation = (results: HelperActionResult[]): boolean =>
    results.some(
      (entry) =>
        typeof entry.helperBundleIdentifier === "string" &&
        OUTBOUND_DIAL_HELPER_BUNDLES.has(entry.helperBundleIdentifier),
    );
  const hasDefinitiveDialHelperAbsence = (results: HelperActionResult[]): boolean =>
    results.some(
      (entry) =>
        typeof entry.helperBundleIdentifier === "string" &&
        OUTBOUND_DIAL_HELPER_BUNDLES.has(entry.helperBundleIdentifier) &&
        entry.found === false &&
        entry.retained_outbound_dial !== true,
    );
  const findOutgoingCallDuringReconciliation = async (
    handle: string,
    callUUID?: string,
    dialID?: string,
    proxyIdentifier?: string,
    requestedAt?: string,
    mode?: FaceTimeDialMode,
  ): Promise<HelperActionResult> => {
    let result: HelperActionResult = { found: false };
    for (let attempt = 0; attempt < OUTBOUND_RECONCILE_ATTEMPTS; attempt += 1) {
      result = await helper.findOutgoingCall(
        handle,
        callUUID,
        dialID,
        proxyIdentifier,
        requestedAt,
        mode,
      );
      if (
        readOutboundCallUUID(result) ||
        readHelperResults(result).some((entry) => entry.found === true)
      ) {
        return result;
      }
      if (attempt + 1 < OUTBOUND_RECONCILE_ATTEMPTS) {
        await new Promise<void>((resolve) => setTimeout(resolve, OUTBOUND_RECONCILE_INTERVAL_MS));
      }
    }
    return result;
  };
  const reconcilePendingOutboundCall = async (): Promise<void> => {
    const pending = outboundCallPending;
    if (!pending) {
      return;
    }
    try {
      const result = await findOutgoingCallDuringReconciliation(
        pending.handle,
        pending.callUUID,
        pending.dialID,
        pending.proxyIdentifier,
        pending.requestedAt,
        pending.mode,
      );
      if (outboundCallPending !== pending) {
        return;
      }
      const reconciledCallUUID = readOutboundCallUUID(result);
      if (reconciledCallUUID) {
        retainFaceTimeDialCallUUID(pending, reconciledCallUUID);
      }
      const reconciledProxyIdentifier = readOutboundProxyIdentifier(result);
      if (reconciledProxyIdentifier) {
        pending.proxyIdentifier = reconciledProxyIdentifier;
      }
      if (!reconciledCallUUID && !reconciledProxyIdentifier) {
        const helperResults = readHelperResults(result);
        const helpersContacted =
          typeof result.helpersContacted === "number"
            ? result.helpersContacted
            : helperResults.length;
        if (
          helperResults.length === helpersContacted &&
          hasDialHelperConfirmation(helperResults) &&
          hasDefinitiveDialHelperAbsence(helperResults) &&
          helperResults.every((entry) => entry.found === false)
        ) {
          clearOutboundCallPending();
        }
      }
    } catch (error) {
      params.logger.debug?.(
        `[facetime] outbound dial reconciliation deferred: ${formatErrorMessage(error)}`,
      );
    }
  };
  const scheduleOutboundReconciliation = () => {
    if (
      stopping ||
      outboundReconcileTimer ||
      !outboundCallPending ||
      helper.connectedSockets === 0
    ) {
      return;
    }
    const pending = outboundCallPending;
    outboundReconcileTimer = setTimeout(() => {
      outboundReconcileTimer = undefined;
      void reconcilePendingOutboundCall().finally(() => {
        if (outboundCallPending === pending) {
          scheduleOutboundReconciliation();
        }
      });
    }, OUTBOUND_RECONCILE_DELAY_MS);
    outboundReconcileTimer.unref?.();
  };
  const cancelPendingOutboundCall = async (): Promise<
    | {
        callUUID?: string;
        dialID: string;
        handle: string;
      }
    | undefined
  > => {
    if (!outboundCallPending && !outboundDialInFlight) {
      return undefined;
    }
    if (outboundDialInFlight) {
      try {
        await outboundDialInFlight;
      } catch {
        // Re-read pending state below. Definitive helper rejection clears it,
        // while an ambiguous outcome retains the caller-generated dial ID.
      }
    }
    const pending = outboundCallPending;
    if (!pending) {
      return undefined;
    }
    const { handle, dialID } = pending;
    let { callUUID } = pending;
    const result = await helper.cancelOutgoingCall({
      dialID,
      handle,
      callUUID,
      proxyIdentifier: pending.proxyIdentifier,
      requestedAt: pending.requestedAt,
      mode: pending.mode,
    });
    const helperResults = readHelperResults(result);
    const cancelled = helperResults.some((entry) => entry.cancelled === true);
    const helpersContacted =
      typeof result.helpersContacted === "number" ? result.helpersContacted : helperResults.length;
    const definitivelyAbsent =
      helperResults.length === helpersContacted &&
      hasDialHelperConfirmation(helperResults) &&
      helperResults.every((entry) => entry.found === false && entry.cancelled === false);
    if (!cancelled && !definitivelyAbsent) {
      throw new Error("FaceTime helper could not confirm outbound call cancellation");
    }
    callUUID = helperResults.map(readOutboundCallUUID).find((value) => Boolean(value)) ?? callUUID;
    clearOutboundCallPending();
    return { ...(callUUID ? { callUUID } : {}), dialID, handle };
  };
  let helperSupervisor: FaceTimeHelperSupervisor | undefined;
  let helperTopologyVersion = 0;
  const helper = new FaceTimeHelperSocketServer({
    host: config.helperHost,
    port: config.helperPort,
    logger: params.logger,
    ipcKey: helperIpcKey,
    buildId: helperBuildId,
    onMessage(message) {
      const outboundIdentity = normalizeFaceTimeOutboundIdentityEvent(message);
      if (outboundIdentity && outboundCallPending?.dialID === outboundIdentity.data.dial_id) {
        retainFaceTimeDialCallUUID(outboundCallPending, outboundIdentity.data.call_uuid);
        outboundCallPending.proxyIdentifier =
          outboundIdentity.data.proxy_identifier ?? outboundCallPending.proxyIdentifier;
        return;
      }
      const event = normalizeFaceTimeCallEvent(message);
      if (event) {
        void handleCallEvent(event).catch((error: Error) => {
          params.logger.warn(`[facetime] call event handling failed: ${formatErrorMessage(error)}`);
        });
      }
    },
    onConnect(bundleIdentifier) {
      helperTopologyVersion += 1;
      helperSupervisor?.connected(bundleIdentifier);
      for (const call of calls.values()) {
        if (call.carrierHangupPending) {
          void attemptCarrierHangup(call, "helper-reconnected");
        }
      }
      void reconcilePendingOutboundCall().finally(scheduleOutboundReconciliation);
    },
    onDisconnect(bundleIdentifier) {
      helperTopologyVersion += 1;
      helperSupervisor?.disconnected(bundleIdentifier);
      if (stopping || calls.size === 0) {
        return;
      }
      // The helper socket is the only carrier control path. Keep the process tap
      // and route monitor alive until the helper reconnects or the call ends.
      params.logger.warn(
        `[facetime] ${bundleIdentifier} helper disconnected during a call; retaining audio safety bridge`,
      );
      // Call events do not identify which helper owns the carrier. Another
      // app's remaining socket cannot prove control of this call is intact.
      for (const call of calls.values()) {
        void attemptCarrierHangup(call, "helper-disconnected");
      }
    },
    onStale(bundleIdentifier, processId) {
      helperSupervisor?.stale(bundleIdentifier, processId);
    },
  });

  const routeCallAudio = async (call: ActiveFaceTimeCall) => {
    if (!call.audioReady) {
      const routing =
        call.audioRouting ??
        (async () => {
          const assertCallOpen = () => {
            if (call.lifecycleAbort.signal.aborted || calls.get(call.callUUID) !== call) {
              throw new Error("FaceTime call closed during audio routing");
            }
          };
          assertCallOpen();
          await access(captureBinary, constants.X_OK);
          assertCallOpen();
          await assertPairedAudioTransport(params.runtime.system.runCommandWithTimeout);
          assertCallOpen();
          call.audioReady = true;
          call.audioTransport = {
            captureBinary,
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
    }
    if (call.lifecycleAbort.signal.aborted) {
      throw new Error("FaceTime call closed during audio routing");
    }
  };

  const enableCallAudio = async (call: ActiveFaceTimeCall) => {
    const mutedResult = await helper.setMuted(call.callUUID, false);
    call.lastHelperAction = mutedResult;
    params.logger.debug?.(
      `[facetime] helper set-muted result ${call.callUUID}: ${JSON.stringify(mutedResult)}`,
    );
    const transmissionResult = await helper.startTransmission(call.callUUID);
    call.lastHelperAction = transmissionResult;
    params.logger.debug?.(
      `[facetime] helper start-transmission result ${call.callUUID}: ${JSON.stringify(transmissionResult)}`,
    );
    if (call.audioTransport) {
      call.audioTransport.processInputVerified = true;
      call.audioTransport.processOutputSuppressed = true;
    }
  };

  const closeCall = async (callUUID: string, reason: string) => {
    const call = calls.get(callUUID);
    if (!call) {
      return;
    }
    calls.delete(callUUID);
    if (call.carrierHangupRetryTimer) {
      clearTimeout(call.carrierHangupRetryTimer);
      call.carrierHangupRetryTimer = undefined;
    }
    call.lifecycleAbort.abort();
    await call.audioRouting?.catch((error: Error) => {
      params.logger.debug?.(
        `[facetime] audio routing cancellation for ${callUUID}: ${formatErrorMessage(error)}`,
      );
    });
    await call.talkStarting?.catch((error: Error) => {
      params.logger.debug?.(
        `[facetime] talk startup cancellation for ${callUUID}: ${formatErrorMessage(error)}`,
      );
    });
    await call.talk?.close(reason).catch((error: Error) => {
      params.logger.debug?.(
        `[facetime] talk close ignored for ${callUUID}: ${formatErrorMessage(error)}`,
      );
    });
    await call.talkActivation?.catch((error: Error) => {
      params.logger.debug?.(
        `[facetime] talk activation cancellation for ${callUUID}: ${formatErrorMessage(error)}`,
      );
    });
    call.audioReady = false;
    call.audioTransport = undefined;
    params.logger.info(
      `[facetime] call closed: ${callUUID} (${reason}); meter max local=${call.maxLocalMeterLevel ?? "unavailable"} remote=${call.maxRemoteMeterLevel ?? "unavailable"}`,
    );
  };

  const attemptCarrierHangup = async (
    call: ActiveFaceTimeCall,
    reason: string,
    options: { closeLocal?: boolean; scheduleRetry?: boolean } = {},
  ): Promise<boolean> => {
    const closeLocal = options.closeLocal !== false;
    const scheduleRetry = options.scheduleRetry !== false;
    if (calls.get(call.callUUID) !== call) {
      return true;
    }
    call.carrierHangupPending = true;
    // suspendMedia gates model I/O synchronously, but native teardown is
    // fallible. Carrier safety actions must never wait for local cleanup.
    void call.talk?.suspendMedia(reason).catch((error) => {
      params.logger.warn(
        `[facetime] local media suspension failed for ${call.callUUID}: ${formatErrorMessage(error)}`,
      );
    });
    const attempt =
      call.carrierHangupAttempt ??
      (async () => {
        const topologyVersion = helperTopologyVersion;
        const helperTopologyIncomplete =
          helperSupervisor?.status().some((target) => !target.connected) ?? true;
        try {
          await helper.safetyMute(call.callUUID);
        } catch (error) {
          params.logger.warn(
            `[facetime] failed to safety-mute carrier ${call.callUUID}: ${formatErrorMessage(error)}`,
          );
        }
        try {
          await helper.leaveCall(call.callUUID);
          return true;
        } catch (error) {
          // A non-owner helper can report "Call not found" while another app
          // still owns the carrier. Accept absence only from a stable, complete topology.
          if (
            isCarrierAlreadyGoneError(error) &&
            !helperTopologyIncomplete &&
            helperTopologyVersion === topologyVersion
          ) {
            return true;
          }
          params.logger.warn(
            `[facetime] carrier hangup pending for ${call.callUUID}: ${formatErrorMessage(error)}`,
          );
          return false;
        }
      })();
    call.carrierHangupAttempt = attempt;
    let carrierClosed: boolean;
    try {
      carrierClosed = await attempt;
    } finally {
      if (call.carrierHangupAttempt === attempt) {
        call.carrierHangupAttempt = undefined;
      }
    }
    if (carrierClosed) {
      call.carrierHangupPending = false;
      call.carrierHangupRequired = false;
      if (closeLocal) {
        await closeCall(call.callUUID, reason);
      }
      return true;
    }
    if (scheduleRetry && !call.carrierHangupRetryTimer) {
      call.carrierHangupRetryTimer = setTimeout(() => {
        call.carrierHangupRetryTimer = undefined;
        void attemptCarrierHangup(call, reason);
      }, 1_000);
      call.carrierHangupRetryTimer.unref?.();
    }
    // Keep the process tap alive until leaveCall succeeds or an ended event arrives.
    return false;
  };

  const waitForStartupCarrierHangup = async (
    call: ActiveFaceTimeCall,
    reason: string,
  ): Promise<boolean> => {
    while (calls.get(call.callUUID) === call && !call.lifecycleAbort.signal.aborted) {
      // closeCall waits for talkStarting, so this pre-return driver must retain
      // its own tap until carrier cleanup succeeds or an ended event aborts it.
      if (
        await attemptCarrierHangup(call, reason, {
          closeLocal: false,
          scheduleRetry: false,
        })
      ) {
        return true;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 1_000);
        timer.unref?.();
      });
    }
    return true;
  };

  const startCallTalk = async (call: ActiveFaceTimeCall) => {
    if (call.talk) {
      return;
    }
    if (!call.talkStarting) {
      const callUUID = call.callUUID;
      call.talkStarting = (async () => {
        await routeCallAudio(call);
        const talk = await startFaceTimeTalkDriver({
          config,
          fullConfig: params.fullConfig,
          runtime: params.runtime,
          logger: params.logger,
          callUUID,
          senderId: call.senderId,
          senderIsOwner: call.senderIsOwner,
          captureBinary,
          signal: call.lifecycleAbort.signal,
          async onHangupRequested() {
            const closed = await attemptCarrierHangup(call, "caller-requested-hangup");
            if (!closed) {
              throw new Error(`carrier hangup pending for ${call.callUUID}; retry scheduled`);
            }
          },
          async onFailure(error) {
            // Ringing calls have not joined a carrier yet, so their tap can close
            // immediately. Active calls retain it until carrier hangup is proven.
            if (!call.carrierHangupRequired) {
              return true;
            }
            const failureReason = `talk-failed: ${formatErrorMessage(error)}`;
            if (!call.talk) {
              return await waitForStartupCarrierHangup(call, failureReason);
            }
            const carrierClosed = await attemptCarrierHangup(call, failureReason, {
              closeLocal: false,
            });
            if (carrierClosed) {
              // The failure callback can run inside readyForAudio. Defer local
              // cleanup so closeCall never waits on the activation invoking us.
              queueMicrotask(() => {
                void closeCall(call.callUUID, failureReason);
              });
            }
            return carrierClosed;
          },
        });
        // A helper disconnect or hangup can arrive while the provider connects.
        if (stopping || calls.get(callUUID) !== call) {
          await talk.close("call-ended-during-start");
          return;
        }
        call.talk = talk;
        if (call.audioTransport) {
          call.audioTransport.processOutputSuppressed = true;
        }
        params.logger.info(`[facetime] realtime talk suppression ready: ${callUUID}`);
      })();
    }
    const starting = call.talkStarting;
    try {
      await starting;
    } finally {
      if (call.talkStarting === starting) {
        call.talkStarting = undefined;
      }
    }
  };

  const activateCallTalk = async (call: ActiveFaceTimeCall, options: { unmute: boolean }) => {
    call.unmuteRequested ||= options.unmute;
    const ensureAudioEnabled = async () => {
      if (call.audioEnabled) {
        return;
      }
      call.audioEnablePromise ??= (async () => {
        await enableCallAudio(call);
        call.audioEnabled = true;
      })();
      const enabling = call.audioEnablePromise;
      try {
        await enabling;
      } finally {
        if (call.audioEnablePromise === enabling) {
          call.audioEnablePromise = undefined;
        }
      }
    };
    if (!call.talkActivation) {
      call.talkActivation = (async () => {
        await call.talk?.readyForAudio();
        if (call.lifecycleAbort.signal.aborted || calls.get(call.callUUID) !== call) {
          throw new Error("FaceTime call closed during audio activation");
        }
        if (call.unmuteRequested) {
          await ensureAudioEnabled();
        } else if (call.audioTransport) {
          call.audioTransport.processInputVerified = true;
        }
        call.talk?.activate();
      })();
    }
    const activation = call.talkActivation;
    try {
      await activation;
      // A concurrent caller may request unmute after the shared readiness path
      // has already inspected the coalesced flag.
      if (options.unmute) {
        await ensureAudioEnabled();
      }
    } finally {
      if (call.talkActivation === activation) {
        call.talkActivation = undefined;
      }
    }
  };

  const answerIncomingCall = async (
    event: FaceTimeCallStatusEvent,
    owner: AuthenticatedFaceTimeOwner,
  ) => {
    const callUUID = readCallUUID(event);
    if (driverInstallPending) {
      params.logger.warn(
        `[facetime] ignored incoming call ${callUUID}; audio driver installation is pending`,
      );
      return;
    }
    const existing = calls.get(callUUID);
    if (existing) {
      return;
    }
    if (calls.size > 0) {
      params.logger.warn(
        `[facetime] ignored incoming call ${callUUID}; another FaceTime bridge is active`,
      );
      return;
    }
    const handle = normalizeFaceTimeHandle(event.data.handle);
    const call: ActiveFaceTimeCall = {
      callUUID,
      ...owner,
      handle,
      lifecycleAbort: new AbortController(),
      audioReady: false,
    };
    updateCallStatus(call, event);
    calls.set(callUUID, call);
    let answerAttempted = false;
    try {
      // The native process tap is ready and suppressing hardware playback before answer.
      await startCallTalk(call);
      if (
        call.lifecycleAbort.signal.aborted ||
        calls.get(callUUID) !== call ||
        call.carrierHangupPending
      ) {
        throw new Error("FaceTime call closed before answer");
      }
      // The helper can answer before its RPC response reaches us. From this
      // point onward, any failure must prove carrier cleanup before tap release.
      call.carrierHangupRequired = true;
      answerAttempted = true;
      await helper.answerCall(callUUID);
      await activateCallTalk(call, { unmute: true });
      params.logger.info(
        `[facetime] answered whitelisted FaceTime call: ${callUUID} from ${handle ?? "unknown"}`,
      );
    } catch (error) {
      params.logger.warn(
        `[facetime] failed to answer FaceTime call ${callUUID}: ${formatErrorMessage(error)}`,
      );
      if (answerAttempted) {
        await attemptCarrierHangup(call, "answer-failed");
        return;
      }
      await closeCall(callUUID, "answer-failed").catch((closeError: Error) => {
        params.logger.warn(
          `[facetime] answer failure cleanup failed: ${formatErrorMessage(closeError)}`,
        );
      });
    }
  };

  const activateCall = async (
    event: FaceTimeCallStatusEvent,
    owner?: AuthenticatedFaceTimeOwner,
  ) => {
    const callUUID = readCallUUID(event);
    if (driverInstallPending) {
      params.logger.warn(
        `[facetime] ignored active call ${callUUID}; audio driver installation is pending`,
      );
      return;
    }
    let call = calls.get(callUUID);
    if (!call) {
      if (!owner) {
        params.logger.warn(
          `[facetime] refused active call without authenticated owner: ${callUUID}`,
        );
        return;
      }
      if (calls.size > 0) {
        params.logger.warn(
          `[facetime] ignored active call ${callUUID}; another FaceTime bridge is active`,
        );
        return;
      }
      call = {
        callUUID,
        ...owner,
        handle: normalizeFaceTimeHandle(event.data.handle),
        lifecycleAbort: new AbortController(),
        audioReady: false,
      };
      calls.set(callUUID, call);
    }
    updateCallStatus(call, event);
    call.carrierHangupRequired = true;
    try {
      await startCallTalk(call);
      await activateCallTalk(call, { unmute: event.data.is_sending_audio === false });
      params.logger.info(`[facetime] realtime talk session active: ${callUUID}`);
    } catch (error) {
      if (call.lifecycleAbort.signal.aborted || calls.get(callUUID) !== call) {
        return;
      }
      params.logger.warn(
        `[facetime] failed to start realtime talk for ${callUUID}: ${formatErrorMessage(error)}`,
      );
      await attemptCarrierHangup(call, "talk-start-failed");
    }
  };

  const handleCallEvent = async (event: FaceTimeCallStatusEvent) => {
    if (stopping) {
      return;
    }
    const callUUID = readCallUUID(event);
    const existingCall = calls.get(callUUID);
    if (existingCall) {
      updateCallStatus(existingCall, event);
    }
    const handleForLog =
      normalizeFaceTimeHandleCandidates(event.data.handle).join(", ") || "unknown";
    if (isIncomingRingingCall(event)) {
      const owner = resolveAllowlistedFaceTimeOwner({
        event,
        whitelistHandles: config.whitelistHandles,
      });
      if (owner) {
        await answerIncomingCall(event, owner);
      } else {
        params.logger.info(
          `[facetime] ignored non-whitelisted FaceTime call: ${callUUID} handle=${handleForLog}`,
        );
      }
      return;
    }
    if (isOutgoingRingingCall(event)) {
      if (
        outboundCallPending &&
        doesFaceTimeCallMatchPendingDial({ event, pending: outboundCallPending })
      ) {
        retainFaceTimeDialCallUUID(outboundCallPending, callUUID);
      }
      return;
    }
    if (isActiveCall(event)) {
      const authorizedPending =
        event.data.is_outgoing === true &&
        outboundCallPending &&
        doesFaceTimeCallMatchPendingDial({ event, pending: outboundCallPending })
          ? outboundCallPending
          : undefined;
      const owner = authorizedPending
        ? resolveAuthorizedOutboundOwner(authorizedPending)
        : resolveAllowlistedFaceTimeOwner({
            event,
            whitelistHandles: config.whitelistHandles,
          });
      if (!calls.has(callUUID) && !owner) {
        params.logger.info(
          `[facetime] ignored active non-whitelisted FaceTime call: ${callUUID} handle=${handleForLog}`,
        );
        return;
      }
      await activateCall(event, owner);
      if (authorizedPending && outboundCallPending === authorizedPending && calls.has(callUUID)) {
        const activeCall = calls.get(callUUID);
        if (activeCall && authorizedPending.callUUIDAliases) {
          activeCall.callUUIDAliases = new Set(authorizedPending.callUUIDAliases);
        }
        clearOutboundCallPending();
      }
      return;
    }
    if (isEndedCall(event)) {
      if (
        event.data.is_outgoing === true &&
        outboundCallPending &&
        doesFaceTimeCallMatchPendingDial({ event, pending: outboundCallPending })
      ) {
        clearOutboundCallPending();
      }
      await closeCall(callUUID, `status-${event.data.call_status}`);
    }
  };

  await helper.start();
  helperSupervisor = new FaceTimeHelperSupervisor({
    pluginRoot: params.pluginRoot,
    logger: params.logger,
    runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
    connectedBundles: () => helper.connectedHelperBundles,
  });
  helperSupervisor.start();
  params.logger.info(
    `[facetime] listening for FaceTime helper events on ${config.helperHost}:${config.helperPort}`,
  );

  const readStatus = async (): Promise<FaceTimeRuntimeStatus> => ({
    enabled: true,
    helperConnected: helper.connectedSockets > 0,
    helperTargets: helperSupervisor?.status() ?? [],
    driverInstallPending,
    driverInstall,
    processOutputSuppressed: [...calls.values()].some(
      (call) => call.talk?.processOutputSuppressed() === true,
    ),
    outboundCallPending: outboundCallPending
      ? {
          dialID: outboundCallPending.dialID,
          delivery: outboundCallPending.delivery,
          handle: outboundCallPending.handle,
          mode: outboundCallPending.mode,
          requestedAt: outboundCallPending.requestedAt,
          proxyIdentifier: outboundCallPending.proxyIdentifier,
        }
      : undefined,
    calls: [...calls.values()].map((call) => ({
      callUUID: call.callUUID,
      handle: call.handle,
      callStatus: call.callStatus,
      isSendingAudio: call.isSendingAudio,
      isSendingTransmission: call.isSendingTransmission,
      isUplinkMuted: call.isUplinkMuted,
      isSendingVideo: call.isSendingVideo,
      conversationUUID: call.conversationUUID,
      conversationGroupUUID: call.conversationGroupUUID,
      conversationAudioEnabled: call.conversationAudioEnabled,
      conversationVideoEnabled: call.conversationVideoEnabled,
      conversationAVMode: call.conversationAVMode,
      conversationResolvedAudioVideoMode: call.conversationResolvedAudioVideoMode,
      localMeterLevel: call.localMeterLevel,
      remoteMeterLevel: call.remoteMeterLevel,
      maxLocalMeterLevel: call.maxLocalMeterLevel,
      maxRemoteMeterLevel: call.maxRemoteMeterLevel,
      realtimeActive: call.talk?.realtimeActive() === true,
      audioReady: call.audioReady,
      audioTransport: call.audioTransport
        ? {
            ...call.audioTransport,
            processOutputSuppressed: call.talk?.processOutputSuppressed() === true,
          }
        : undefined,
      lastHelperAction: call.lastHelperAction,
      lastRoutingError: call.lastRoutingError,
      carrierHangupPending: call.carrierHangupPending,
      recentTalkEvents: call.talk
        ? summarizeRecentTalkEvents(call.talk.recentTalkEvents)
        : undefined,
    })),
  });
  const runPreflight = async (): Promise<FaceTimePreflightResult> =>
    await runFaceTimePreflight({
      config,
      fullConfig: params.fullConfig,
      runtime: params.runtime,
      logger: params.logger,
      helperConnected: helper.connectedSockets > 0,
      captureBinary,
    });

  return {
    config,
    async status() {
      return await readStatus();
    },
    async dial(dialParams) {
      if (stopping) {
        throw new Error("cannot start an outbound FaceTime call while the plugin is stopping");
      }
      if (driverInstallPending) {
        throw new Error(
          "cannot start an outbound FaceTime call while audio driver installation is pending",
        );
      }
      if (calls.size > 0) {
        throw new Error("cannot start an outbound FaceTime call while another call is active");
      }
      if (outboundCallPending) {
        throw new Error(
          `outbound FaceTime ${outboundCallPending.mode} call is already pending for ${outboundCallPending.handle}`,
        );
      }
      if (outboundDialInFlight) {
        throw new Error("cannot start an outbound FaceTime call while another dial is in flight");
      }
      const request = resolveFaceTimeDialRequest({
        handle: dialParams.handle,
        mode: dialParams.mode,
        whitelistHandles: config.whitelistHandles,
      });
      const dialID = randomUUID();
      const requestedAt = new Date().toISOString();
      outboundCallPending = { ...request, dialID, delivery: "in-flight", requestedAt };
      const dialPromise = (async (): Promise<FaceTimeDialResult> => {
        const helperResult = await helper.startCall(request, dialID, requestedAt);
        const result = resolveFaceTimeDialResult({ dialID, request, helper: helperResult });
        const callUUID = result.callUUID;
        if (outboundCallPending?.dialID === dialID) {
          outboundCallPending.delivery = "accepted";
          // The helper can emit native identity before its action reply arrives.
          // A reply without identity must not erase that earlier exact match.
          if (callUUID) {
            retainFaceTimeDialCallUUID(outboundCallPending, callUUID);
          }
          if (result.proxyIdentifier) {
            outboundCallPending.proxyIdentifier = result.proxyIdentifier;
          }
          scheduleOutboundReconciliation();
        }
        // TelephonyUtilities may accept the dial before assigning a UUID. The
        // later outgoing status event owns correlation in that normal state.
        return result;
      })();
      outboundDialInFlight = dialPromise;
      try {
        return await dialPromise;
      } catch (error) {
        // A helper-declared rejection means dialing did not begin. Transport
        // errors are ambiguous, so retain ownership until helper polling
        // correlates an outgoing event or an operator cancels the request.
        if (
          error instanceof FaceTimeHelperActionError ||
          error instanceof FaceTimeHelperUnavailableError
        ) {
          if (outboundCallPending?.dialID === dialID) {
            clearOutboundCallPending();
          }
        } else {
          if (outboundCallPending?.dialID === dialID) {
            outboundCallPending.delivery = "ambiguous";
            if (error instanceof FaceTimeHelperAmbiguousError) {
              const callUUID = readOutboundCallUUID(error.result);
              const proxyIdentifier = readOutboundProxyIdentifier(error.result);
              if (callUUID) {
                retainFaceTimeDialCallUUID(outboundCallPending, callUUID);
              }
              if (proxyIdentifier) {
                outboundCallPending.proxyIdentifier = proxyIdentifier;
              }
            }
          }
          if (outboundDialInFlight === dialPromise) {
            outboundDialInFlight = undefined;
          }
          await reconcilePendingOutboundCall();
          scheduleOutboundReconciliation();
        }
        throw error;
      } finally {
        if (outboundDialInFlight === dialPromise) {
          outboundDialInFlight = undefined;
        }
      }
    },
    async hangup(hangupParams) {
      const requestedCallUUID =
        typeof hangupParams?.callUUID === "string" && hangupParams.callUUID.trim()
          ? hangupParams.callUUID.trim()
          : undefined;
      const findCall = () =>
        requestedCallUUID
          ? (calls.get(requestedCallUUID) ??
            [...calls.values()].find((candidate) =>
              candidate.callUUIDAliases?.has(requestedCallUUID),
            ))
          : ([...calls.values()].find((candidate) => candidate.talk) ?? [...calls.values()][0]);
      let call = findCall();
      if (!call) {
        if (
          !requestedCallUUID ||
          (outboundCallPending &&
            doesPendingFaceTimeDialHaveCallUUID(outboundCallPending, requestedCallUUID))
        ) {
          const canceled = await cancelPendingOutboundCall();
          if (canceled) {
            return {
              ...(canceled.callUUID ? { callUUID: canceled.callUUID } : {}),
              dialID: canceled.dialID,
            };
          }
        }
        // The helper emits active status before acknowledging the dial. Let
        // that async event handler finish registering the call, then re-read.
        for (let attempt = 0; attempt < OUTBOUND_RECONCILE_ATTEMPTS && !call; attempt += 1) {
          call = findCall();
          if (!call && attempt + 1 < OUTBOUND_RECONCILE_ATTEMPTS) {
            await new Promise<void>((resolve) =>
              setTimeout(resolve, OUTBOUND_RECONCILE_INTERVAL_MS),
            );
          }
        }
      }
      if (!call) {
        throw new Error("no active FaceTime call to hang up");
      }
      const closed = await attemptCarrierHangup(call, "operator-hangup");
      if (!closed) {
        throw new Error(`carrier hangup pending for ${call.callUUID}; retry scheduled`);
      }
      return { callUUID: call.callUUID };
    },
    async setup() {
      const preflight = runPreflight();
      // Setup overlaps the live loopback with static checks. Observe failures
      // immediately, then let runFaceTimeSetup surface the same rejection.
      void preflight.catch(() => undefined);
      // Refresh after preflight because helper injection can finish while the
      // live loopback runs. A failed preflight is reported by setup itself.
      const runtimeStatus = preflight.then(
        () => readStatus(),
        () => readStatus(),
      );
      return await runFaceTimeSetup({
        config,
        pluginRoot: params.pluginRoot,
        runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
        runtimeStatus,
        preflight,
      });
    },
    async preflight() {
      return await runPreflight();
    },
    async testAudio(testParams) {
      const activeCall = [...calls.values()].find((call) => call.talk) ?? [...calls.values()][0];
      if (activeCall) {
        await routeCallAudio(activeCall);
      }
      return await playFaceTimeTestAudio(
        {
          runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
          logger: params.logger,
        },
        { phrase: testParams?.phrase },
      );
    },
    async installDriver() {
      if (stopping) {
        throw new Error("cannot install the FaceTime audio driver while the plugin is stopping");
      }
      if (driverInstallPending) {
        throw new Error("FaceTime audio driver installation is already pending");
      }
      if (calls.size > 0 || outboundCallPending || outboundDialInFlight) {
        throw new Error(
          "Cannot install the FaceTime audio driver during an active or pending call",
        );
      }
      // Hold this gate across the build and administrator prompt. Dial and
      // auto-answer consult it before claiming a call, so Core Audio cannot be
      // restarted underneath a newly managed call.
      driverInstallPending = true;
      driverInstall = {
        phase: "installing",
        startedAt: new Date().toISOString(),
      };
      const installAbortController = new AbortController();
      driverInstallAbortController = installAbortController;
      driverInstallTask = installFaceTimeDriver({
        pluginRoot: params.pluginRoot,
        runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
        callActive: false,
        signal: installAbortController.signal,
      })
        .then((result) => {
          driverInstall = {
            phase: "succeeded",
            startedAt: driverInstall.startedAt,
            finishedAt: new Date().toISOString(),
            changed: result.changed,
          };
          params.logger.info(
            `[facetime] audio driver installation ${result.changed ? "completed" : "already current"}`,
          );
        })
        .catch((error) => {
          const message = formatErrorMessage(error);
          driverInstall = {
            phase: "failed",
            startedAt: driverInstall.startedAt,
            finishedAt: new Date().toISOString(),
            error: message,
          };
          params.logger.warn(`[facetime] audio driver installation failed: ${message}`);
        })
        .finally(() => {
          if (driverInstallAbortController === installAbortController) {
            driverInstallAbortController = undefined;
            driverInstallTask = undefined;
            driverInstallPending = false;
          }
        });
      return { started: true };
    },
    async stop() {
      stopping = true;
      driverInstallAbortController?.abort();
      await driverInstallTask;
      let cleanupError: Error | undefined;
      if (outboundCallPending || outboundDialInFlight) {
        try {
          await cancelPendingOutboundCall();
        } catch (error) {
          cleanupError ??= new Error(
            `outbound FaceTime dial cleanup failed: ${formatErrorMessage(error)}`,
          );
        }
      }
      for (const call of [...calls.values()]) {
        const closed = await attemptCarrierHangup(call, "runtime-stop");
        if (!closed) {
          cleanupError ??= new Error(
            `carrier hangup remains pending for ${call.callUUID}; audio safety bridge retained`,
          );
        }
      }
      if (cleanupError) {
        // The retained audio safety bridge still needs helper reinjection to
        // mute or hang up the carrier on a later retry.
        stopping = false;
        throw cleanupError;
      }
      helperSupervisor?.stop();
      await helper.stop();
    },
  };
}
