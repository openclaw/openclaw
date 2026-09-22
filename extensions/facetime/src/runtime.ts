import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { PluginRuntime, RuntimeLogger } from "openclaw/plugin-sdk/plugin-runtime";
import { normalizeFaceTimeCallEvent } from "./call-events.js";
import { FaceTimeCallRegistry } from "./call-lifecycle.js";
import { resolveFaceTimeConfig, validateFaceTimeConfig, type FaceTimeConfig } from "./config.js";
import { installFaceTimeDriver } from "./driver-setup.js";
import { resolveFaceTimeHelperEndpoint } from "./helper-endpoint.js";
import {
  FaceTimeHelperAmbiguousError,
  FaceTimeHelperSocketServer,
  FaceTimeHelperUnavailableError,
  readHelperResults,
  type FaceTimeHelperPeer,
} from "./helper-rpc.js";
import { FaceTimeHelperSupervisor } from "./helper-supervisor.js";
import {
  doesPendingFaceTimeDialHaveCallUUID,
  normalizeFaceTimeOutboundIdentityEvent,
  resolveFaceTimeDialRequest,
  resolveFaceTimeDialResult,
  retainFaceTimeDialCallUUID,
  type FaceTimeDialResult,
  type PendingFaceTimeDial,
} from "./outbound-call.js";
import { PendingFaceTimeDialStore } from "./pending-dial-store.js";
import { ensureCaptureBinary, ensureHelperArtifacts } from "./plugin-paths.js";
import { runFaceTimePreflight, type FaceTimePreflightResult } from "./preflight.js";
import { createFaceTimeCallControl } from "./runtime-call-control.js";
import { createFaceTimeCallEventHandler } from "./runtime-call-events.js";
import { terminateExactCarrierProcesses } from "./runtime-carrier-process.js";
import {
  reconcilePendingFaceTimeCarrier,
  hasDialHelperConfirmation,
  OUTBOUND_DIAL_HELPER_BUNDLES,
  OUTBOUND_RECONCILE_ATTEMPTS,
  OUTBOUND_RECONCILE_INTERVAL_MS,
  retainOutboundDialHelperPeers,
  readOutboundCallUUID,
  readOutboundProxyIdentifier,
  retainHelperResultPeers,
} from "./runtime-helper-results.js";
import type { ActiveFaceTimeCall, FaceTimeRuntimeStatus } from "./runtime-state.js";
import { buildFaceTimeRuntimeStatus } from "./runtime-status.js";
import { runFaceTimeSetup, type FaceTimeSetupReport } from "./setup.js";

export type { FaceTimeRuntimeStatus } from "./runtime-state.js";

export type FaceTimeRuntime = {
  config: FaceTimeConfig;
  status(): Promise<FaceTimeRuntimeStatus>;
  setup(): Promise<FaceTimeSetupReport>;
  preflight(): Promise<FaceTimePreflightResult>;
  dial(params: { handle: unknown; mode?: unknown }): Promise<FaceTimeDialResult>;
  hangup(params?: { callUUID?: unknown }): Promise<{ callUUID?: string; dialID?: string }>;
  installDriver(): Promise<{ started: true }>;
  stop(): Promise<void>;
};

const OUTBOUND_RECONCILE_DELAY_MS = 1_000;

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

  const calls = new FaceTimeCallRegistry<ActiveFaceTimeCall>();
  const pendingDialStore = new PendingFaceTimeDialStore(
    params.runtime.state.openKeyedStore({
      namespace: "pending-dial",
      maxEntries: 1,
      overflowPolicy: "reject-new",
    }),
  );
  let outboundDialInFlight: Promise<FaceTimeDialResult> | undefined;
  let outboundDialDispatchPending = false;
  let outboundCallPending: PendingFaceTimeDial | undefined = await pendingDialStore.load();
  const outboundCarrierPeers = new Map<number, FaceTimeHelperPeer>();
  if (outboundCallPending) {
    outboundCallPending.ownerEpoch += 1;
    await pendingDialStore.save(outboundCallPending);
  }
  let outboundReconcileTimer: NodeJS.Timeout | undefined;
  let outboundReconcileInFlight: Promise<void> | undefined;
  let driverInstall: FaceTimeRuntimeStatus["driverInstall"] = { phase: "idle" };
  let driverInstallAbortController: AbortController | undefined;
  let driverInstallTask: Promise<void> | undefined;
  const isDriverInstallPending = () => driverInstall.phase === "installing";
  const captureBinary = await ensureCaptureBinary();
  const { buildId: helperBuildId, ipcKey: helperIpcKey } = await ensureHelperArtifacts({
    pluginRoot: params.pluginRoot,
    runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
  });
  let stopping = false;
  let helperStopped = false;
  const helperRef: { current?: FaceTimeHelperSocketServer } = {};
  const helperSupervisor = new FaceTimeHelperSupervisor({
    pluginRoot: params.pluginRoot,
    logger: params.logger,
    runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
    connectedBundles: () => helperRef.current?.connectedHelperBundles ?? [],
  });
  const pendingOperations = new Set<Promise<void>>();
  const observePendingOperation = (operation: Promise<void>) => {
    pendingOperations.add(operation);
    void operation.then(
      () => pendingOperations.delete(operation),
      (error: unknown) => {
        pendingOperations.delete(operation);
        params.logger.warn(
          `[facetime] pending dial operation failed: ${formatErrorMessage(error)}`,
        );
      },
    );
    return operation;
  };
  let pendingClearSettlement: Promise<void> = Promise.resolve();
  const clearOutboundCallPending = (
    expectedDialID = outboundCallPending?.dialID,
  ): Promise<void> => {
    if (outboundReconcileTimer) {
      clearTimeout(outboundReconcileTimer);
      outboundReconcileTimer = undefined;
    }
    const pending = outboundCallPending;
    const clearing = (async () => {
      if (expectedDialID) {
        await pendingDialStore.clear(expectedDialID);
      }
      if (outboundCallPending === pending) {
        outboundCallPending = undefined;
        outboundCarrierPeers.clear();
      }
    })();
    pendingClearSettlement = clearing.catch(() => undefined);
    return clearing;
  };
  const persistOutboundCallPending = (): Promise<void> =>
    outboundCallPending ? pendingDialStore.save(outboundCallPending) : Promise.resolve();
  const reconcilePendingOutboundCall = async (): Promise<void> => {
    if (outboundDialDispatchPending) {
      return;
    }
    if (outboundReconcileInFlight) {
      return await outboundReconcileInFlight;
    }
    const pending = outboundCallPending;
    if (!pending) {
      return;
    }
    const reconciliation = (async () => {
      try {
        await reconcilePendingFaceTimeCarrier({
          helper,
          pending,
          isCurrent: () =>
            outboundCallPending === pending && !pendingDialStore.isClearing(pending.dialID),
          peers: outboundCarrierPeers,
          persist: persistOutboundCallPending,
          clear: () => clearOutboundCallPending(pending.dialID),
        });
        // Cancellation is retained intent; discovering a late carrier cannot restore consent.
        if (outboundCallPending === pending && pending.delivery === "cancelling") {
          await cancelPendingOutboundCall();
        }
      } catch (error) {
        params.logger.debug?.(
          `[facetime] outbound dial reconciliation deferred: ${formatErrorMessage(error)}`,
        );
      }
    })();
    outboundReconcileInFlight = reconciliation;
    try {
      await reconciliation;
    } finally {
      if (outboundReconcileInFlight === reconciliation) {
        outboundReconcileInFlight = undefined;
      }
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
      void observePendingOperation(
        reconcilePendingOutboundCall().finally(() => {
          if (outboundCallPending === pending) {
            scheduleOutboundReconciliation();
          }
        }),
      );
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
    const pending = outboundCallPending;
    if (!pending) {
      return undefined;
    }
    const { handle, dialID } = pending;
    let { callUUID } = pending;
    pending.delivery = "cancelling";
    await persistOutboundCallPending();
    if (outboundCallPending !== pending || pendingDialStore.isClearing(pending.dialID)) {
      return undefined;
    }
    const result = await helper
      .cancelOutgoingCall({
        dialID,
        handle,
        callUUID,
        proxyIdentifier: pending.proxyIdentifier,
        requestedAt: pending.requestedAt,
        mode: pending.mode,
      })
      .finally(scheduleOutboundReconciliation);
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
    const replyCallUUID = helperResults.map(readOutboundCallUUID).find((value) => Boolean(value));
    callUUID = replyCallUUID ?? callUUID;
    if (outboundCallPending === pending) {
      retainOutboundDialHelperPeers(outboundCarrierPeers, result);
      // Native events may replace the carrier while cancellation is in flight.
      retainFaceTimeDialCallUUID(pending, replyCallUUID);
      await persistOutboundCallPending();
    }
    return { ...(callUUID ? { callUUID } : {}), dialID, handle };
  };
  let helperTopologyVersion = 0;
  const helperEndpoint = resolveFaceTimeHelperEndpoint();
  const callEventRef: {
    current?: ReturnType<typeof createFaceTimeCallEventHandler>;
  } = {};
  const helper = new FaceTimeHelperSocketServer({
    ...helperEndpoint,
    logger: params.logger,
    ipcKey: helperIpcKey,
    buildId: helperBuildId,
    onMessage(message, peer) {
      if (helperStopped) {
        return undefined;
      }
      const outboundIdentity = normalizeFaceTimeOutboundIdentityEvent(message);
      if (outboundIdentity && outboundCallPending?.dialID === outboundIdentity.data.dial_id) {
        if (OUTBOUND_DIAL_HELPER_BUNDLES.has(peer.bundleIdentifier)) {
          outboundCarrierPeers.set(peer.processId, peer);
        }
        retainFaceTimeDialCallUUID(outboundCallPending, outboundIdentity.data.call_uuid);
        if (outboundIdentity.data.proxy_identifier) {
          outboundCallPending.proxyIdentifier = outboundIdentity.data.proxy_identifier;
        }
        return observePendingOperation(persistOutboundCallPending());
      }
      const event = normalizeFaceTimeCallEvent(message);
      if (event) {
        const operation = callEventRef.current?.handleCallEvent(event, peer);
        if (operation) {
          return observePendingOperation(operation);
        }
      }
      return undefined;
    },
    onConnect(bundleIdentifier) {
      helperTopologyVersion += 1;
      helperSupervisor?.connected(bundleIdentifier);
      for (const call of calls.values()) {
        if (call.carrierHangupPending) {
          void attemptCarrierHangup(call, "helper-reconnected");
        }
      }
      if (!stopping) {
        void observePendingOperation(
          reconcilePendingOutboundCall().finally(scheduleOutboundReconciliation),
        );
      }
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
        "[facetime] carrier helper disconnected during a call; retaining audio safety bridge",
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
  helperRef.current = helper;

  const callControl = createFaceTimeCallControl({
    calls,
    helper,
    config,
    fullConfig: params.fullConfig,
    runtime: params.runtime,
    logger: params.logger,
    captureBinary,
    isStopping: () => stopping,
    getHelperTopologyVersion: () => helperTopologyVersion,
    retainHelperResultPeers,
  });
  const { attemptCarrierHangup, stopCall } = callControl;
  callEventRef.current = createFaceTimeCallEventHandler({
    calls,
    helper,
    config,
    logger: params.logger,
    callControl,
    isStopping: () => stopping,
    isDriverInstallPending,
    getPendingDial: () =>
      pendingDialStore.isClearing(outboundCallPending?.dialID) ? undefined : outboundCallPending,
    clearPendingDial: () => clearOutboundCallPending(),
    persistPendingDial: persistOutboundCallPending,
    outboundCarrierPeers,
    cancelPendingDial: async (pending) => {
      if (outboundCallPending === pending) {
        await cancelPendingOutboundCall();
      }
    },
  });

  await helper.start();
  helperSupervisor.start();
  params.logger.info(
    `[facetime] listening for FaceTime helper events on ${helperEndpoint.host}:${helperEndpoint.port}`,
  );
  const readStatus = async (): Promise<FaceTimeRuntimeStatus> =>
    buildFaceTimeRuntimeStatus({
      calls,
      helperConnected: helper.connectedSockets > 0,
      helperTargets: helperSupervisor.status(),
      driverInstall,
      pendingDial: outboundCallPending,
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
      if (isDriverInstallPending()) {
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
        ownerHandles: config.ownerHandles,
      });
      const dialID = randomUUID();
      const requestedAt = new Date().toISOString();
      const pending: PendingFaceTimeDial = {
        ...request,
        version: 1,
        ownerEpoch: 1,
        dialID,
        delivery: "in-flight",
        requestedAt,
      };
      outboundCallPending = pending;
      outboundDialDispatchPending = true;
      let helperStarted = false;
      const canDispatch = () =>
        !stopping &&
        outboundCallPending === pending &&
        pending.delivery !== "cancelling" &&
        !pendingDialStore.isClearing(pending.dialID);
      const dialPromise = (async (): Promise<FaceTimeDialResult> => {
        await persistOutboundCallPending();
        if (!canDispatch()) {
          throw new Error("outbound FaceTime dial was cancelled before helper dispatch");
        }
        outboundDialDispatchPending = false;
        helperStarted = true;
        const helperResult = await helper.startCall(request, dialID, requestedAt);
        retainOutboundDialHelperPeers(outboundCarrierPeers, helperResult);
        const result = resolveFaceTimeDialResult({ dialID, request, helper: helperResult });
        const callUUID = result.callUUID;
        if (outboundCallPending === pending) {
          if (pending.delivery !== "cancelling") {
            pending.delivery = "accepted";
          }
          // The helper can emit native identity before its action reply arrives.
          // A reply without identity must not erase that earlier exact match.
          if (callUUID) {
            retainFaceTimeDialCallUUID(outboundCallPending, callUUID);
          }
          if (result.proxyIdentifier) {
            outboundCallPending.proxyIdentifier = result.proxyIdentifier;
          }
          await persistOutboundCallPending();
          scheduleOutboundReconciliation();
        }
        if (pending.delivery === "cancelling") {
          throw new Error("outbound FaceTime dial was cancelled before helper acknowledgement");
        }
        // TelephonyUtilities may accept the dial before assigning a UUID. The
        // later outgoing status event owns correlation in that normal state.
        return result;
      })();
      outboundDialInFlight = dialPromise;
      try {
        return await dialPromise;
      } catch (error) {
        if (!helperStarted) {
          throw error;
        }
        // Only local unavailability proves the command was never sent. Native
        // errors can follow carrier creation, so they still require reconciliation.
        if (error instanceof FaceTimeHelperUnavailableError) {
          if (outboundCallPending === pending && pending.delivery !== "cancelling") {
            await clearOutboundCallPending();
          }
        } else {
          if (outboundCallPending === pending) {
            if (pending.delivery !== "cancelling") {
              pending.delivery = "ambiguous";
            }
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
            await persistOutboundCallPending();
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
          outboundDialDispatchPending = false;
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
          ? calls.get(requestedCallUUID)
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
            await new Promise<void>((resolve) => {
              setTimeout(resolve, OUTBOUND_RECONCILE_INTERVAL_MS);
            });
          }
        }
      }
      if (!call) {
        throw new Error("no active FaceTime call to hang up");
      }
      if (outboundCallPending && calls.get(outboundCallPending.dialID) === call) {
        call.beginClosing();
        outboundCallPending.delivery = "cancelling";
        await persistOutboundCallPending();
        scheduleOutboundReconciliation();
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
        nativePackageReady: true,
        pluginRoot: params.pluginRoot,
        runCommandWithTimeout: params.runtime.system.runCommandWithTimeout,
        runtimeStatus,
        preflight,
      });
    },
    async preflight() {
      return await runPreflight();
    },
    async installDriver() {
      if (stopping) {
        throw new Error("cannot install the FaceTime audio driver while the plugin is stopping");
      }
      if (isDriverInstallPending()) {
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
        .catch((error: unknown) => {
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
          }
        });
      return { started: true };
    },
    async stop() {
      stopping = true;
      if (outboundReconcileTimer) {
        clearTimeout(outboundReconcileTimer);
        outboundReconcileTimer = undefined;
      }
      driverInstallAbortController?.abort();
      await driverInstallTask;
      await pendingDialStore.settle();
      // Join local publication too: the native queue can settle before it forgets the deleted dial.
      await pendingClearSettlement;
      let cleanupError: Error | undefined;
      let pendingCleanupError: Error | undefined;
      const shutdownPending = outboundCallPending;
      if (outboundCallPending || outboundDialInFlight) {
        try {
          await cancelPendingOutboundCall();
        } catch (error) {
          pendingCleanupError = new Error(
            `outbound FaceTime dial cleanup failed: ${formatErrorMessage(error)}`,
          );
        }
        await outboundDialInFlight?.catch(() => undefined);
        await reconcilePendingOutboundCall();
        if (!outboundCallPending) {
          pendingCleanupError = undefined;
        }
        if (outboundCallPending === shutdownPending && calls.size === 0 && shutdownPending) {
          const pendingEpoch = shutdownPending.ownerEpoch;
          try {
            await terminateExactCarrierProcesses({
              runtime: params.runtime,
              peers: outboundCarrierPeers,
              assertCurrent: () => {
                if (
                  outboundCallPending !== shutdownPending ||
                  shutdownPending.ownerEpoch !== pendingEpoch
                ) {
                  throw new Error("pending FaceTime dial changed during fail-closed shutdown");
                }
              },
            });
            await clearOutboundCallPending(shutdownPending.dialID);
            pendingCleanupError = undefined;
          } catch (error) {
            pendingCleanupError ??= new Error(
              `pending FaceTime carrier termination failed: ${formatErrorMessage(error)}`,
            );
          }
        }
        cleanupError ??= pendingCleanupError;
      }
      for (const call of calls.values()) {
        try {
          await stopCall(call);
        } catch (error) {
          cleanupError ??= error instanceof Error ? error : new Error(formatErrorMessage(error));
        }
      }
      await helperSupervisor.stop();
      await helper.stop();
      helperStopped = true;
      // Failed carrier cleanup leaves startup waiting for closure; report that failure.
      if (!cleanupError) {
        while (pendingOperations.size > 0) {
          await Promise.allSettled(pendingOperations);
        }
      }
      await pendingDialStore.settle();
      if (cleanupError) {
        throw cleanupError;
      }
    },
  };
}
