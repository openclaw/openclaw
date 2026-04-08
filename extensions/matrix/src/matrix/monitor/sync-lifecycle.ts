import type { MatrixClient } from "../sdk.js";
import type { MatrixSyncState } from "../sync-state.js";
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
    params.statusController.noteSyncState(state, error);
    if (state === "STOPPED" && !params.isStopping?.()) {
      settleFatal(formatSyncLifecycleError(state, error));
    }
  };

  const onUnexpectedError = (error: Error) => {
    params.statusController.noteUnexpectedError(error);
    if (!params.isStopping?.()) {
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
