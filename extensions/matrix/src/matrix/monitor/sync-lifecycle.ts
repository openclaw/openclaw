// Matrix plugin module implements sync lifecycle behavior.
import type { MatrixClient } from "../sdk.js";
import { isMatrixTerminalSyncState, type MatrixSyncState } from "../sync-state.js";
import type { MatrixMonitorStatusController } from "./status.js";

function formatSyncLifecycleError(state: MatrixSyncState, error?: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  const message = typeof error === "string" && error.trim() ? error.trim() : undefined;
  if (state === "STOPPED") {
    return new Error(message ?? "Matrix sync stopped unexpectedly");
  }
  if (state === "ERROR") {
    return new Error(message ?? "Matrix sync entered ERROR unexpectedly");
  }
  return new Error(message ?? `Matrix sync entered ${state} unexpectedly`);
}

/**
 * Determine whether a sync error is likely recoverable.
 * Decryption failures on individual messages should not tear down the sync loop.
 */
function isRecoverableSyncError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const message = error.message.toLowerCase();
  // Megolm session-key failures: a remote sender hasn't shared keys yet.
  if (message.includes("decryption") || message.includes("decrypt")) {
    return true;
  }
  if (message.includes("megolm") || (message.includes("session") && message.includes("key"))) {
    return true;
  }
  if (message.includes("unknown inbound session")) {
    return true;
  }
  // Transient HTTP/network errors that the SDK already retries internally.
  if (message.includes("etimedout") || message.includes("econnrefused") || message.includes("enotfound")) {
    return true;
  }
  return false;
}

export function createMatrixMonitorSyncLifecycle(params: {
  client: MatrixClient;
  statusController: MatrixMonitorStatusController;
  isStopping?: () => boolean;
}) {
  let fatalError: Error | null = null;
  let resolveFatalWait: (() => void) | null = null;
  let rejectFatalWait: ((error: Error) => void) | null = null;

  const settleFatal = (error: Error) => {
    if (fatalError) {
      return;
    }
    fatalError = error;
    rejectFatalWait?.(error);
    resolveFatalWait = null;
    rejectFatalWait = null;
  };

  const onSyncState = (state: MatrixSyncState, _prevState: string | null, error?: unknown) => {
    if (isMatrixTerminalSyncState(state) && !params.isStopping?.()) {
      const fatalErrorLocal = formatSyncLifecycleError(state, error);
      params.statusController.noteUnexpectedError(fatalErrorLocal);
      settleFatal(fatalErrorLocal);
      return;
    }
    // Fatal sync failures are sticky for telemetry; later SDK state churn during
    // cleanup or reconnect should not overwrite the first recorded error.
    if (fatalError) {
      return;
    }
    // Operator-initiated shutdown can still emit transient sync states before
    // the final STOPPED. Ignore that churn so intentional stops do not look
    // like runtime failures.
    if (params.isStopping?.() && !isMatrixTerminalSyncState(state)) {
      return;
    }
    params.statusController.noteSyncState(state, error);
  };

  const onUnexpectedError = (error: Error) => {
    if (params.isStopping?.()) {
      return;
    }
    params.statusController.noteUnexpectedError(error);
    // Decryption and transient network errors should not tear down the sync loop.
    // The SDK will attempt to recover; only escalate truly fatal errors.
    if (!isRecoverableSyncError(error)) {
      settleFatal(error);
    }
  };

  params.client.on("sync.state", onSyncState);
  params.client.on("sync.unexpected_error", onUnexpectedError);

  return {
    async waitForFatalStop(): Promise<void> {
      if (fatalError) {
        throw fatalError;
      }
      if (resolveFatalWait || rejectFatalWait) {
        throw new Error("Matrix fatal-stop wait already in progress");
      }
      await new Promise<void>((resolve, reject) => {
        resolveFatalWait = resolve;
        rejectFatalWait = (error) => reject(error);
      });
    },
    dispose() {
      resolveFatalWait?.();
      resolveFatalWait = null;
      rejectFatalWait = null;
      params.client.off("sync.state", onSyncState);
      params.client.off("sync.unexpected_error", onUnexpectedError);
    },
  };
}
