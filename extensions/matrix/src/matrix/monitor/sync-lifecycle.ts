// Matrix plugin module implements sync lifecycle behavior.
import type { MatrixClient } from "../sdk.js";
import { isMatrixTerminalSyncState, type MatrixSyncState } from "../sync-state.js";
import type { MatrixMonitorStatusController } from "./status.js";

/**
 * Determines if a sync error is recoverable (non-fatal).
 * Decryption failures, Megolm errors, and transient network issues should not
 * stop the entire sync process. These are expected during normal operation.
 */
function isRecoverableSyncError(error?: unknown): boolean {
  if (!error) {
    return false;
  }
  const message = error instanceof Error ? error.message : String(error);
  const lowerMessage = message.toLowerCase();

  // Decryption and Megolm errors are recoverable (keys may arrive later)
  if (lowerMessage.includes("decrypt") || lowerMessage.includes("megolm")) {
    return true;
  }

  // Session/key-related errors are often transient
  if (lowerMessage.includes("session") && lowerMessage.includes("key")) {
    return true;
  }

  // Transient network errors
  if (lowerMessage.includes("network") || lowerMessage.includes("timeout") || lowerMessage.includes("offline")) {
    return true;
  }

  // M error codes for network issues
  if (lowerMessage.includes("m_unknown_token") || lowerMessage.includes("m_limit_exceeded")) {
    return true;
  }

  return false;
}

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
      // Recoverable errors (decryption, Megolm, network) should not stop sync
      if (isRecoverableSyncError(error)) {
        params.statusController.noteSyncState(state, error);
        return;
      }
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
    // Recoverable errors (decryption, Megolm, network) should not be treated as fatal
    if (isRecoverableSyncError(error)) {
      params.statusController.noteSyncState("SYNCING", error);
      return;
    }
    params.statusController.noteUnexpectedError(error);
    settleFatal(error);
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
