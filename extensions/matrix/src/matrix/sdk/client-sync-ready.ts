import type { EventEmitter } from "node:events";
import { createMatrixStartupAbortError } from "../startup-abort.js";
import {
  isMatrixReadySyncState,
  isMatrixTerminalSyncState,
  type MatrixSyncState,
} from "../sync-state.js";
import { isMatrixAccessTokenInvalidatedError } from "./client-support.js";

export async function waitForMatrixInitialSyncReady(params: {
  emitter: EventEmitter;
  state: MatrixSyncState | null;
  error?: unknown;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<void> {
  const timeoutMs = params.timeoutMs ?? 30_000;
  if (isMatrixReadySyncState(params.state)) {
    return;
  }
  if (isMatrixAccessTokenInvalidatedError(params.error)) {
    throw params.error instanceof Error
      ? params.error
      : new Error("Matrix access token invalidated", { cause: params.error });
  }
  if (isMatrixTerminalSyncState(params.state)) {
    throw new Error(`Matrix sync entered ${params.state} during startup`);
  }

  await new Promise<void>((resolve, reject) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const abortSignal = params.abortSignal;

    const cleanup = () => {
      params.emitter.off("sync.state", onSyncState);
      params.emitter.off("sync.unexpected_error", onUnexpectedError);
      abortSignal?.removeEventListener("abort", onAbort);
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = undefined;
      }
    };

    const settle = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const onSyncState = (state: MatrixSyncState, _prevState: string | null, error?: unknown) => {
      if (isMatrixReadySyncState(state)) {
        settle();
        return;
      }
      if (isMatrixAccessTokenInvalidatedError(error)) {
        settle(error instanceof Error ? error : new Error("Matrix access token invalidated"));
        return;
      }
      if (isMatrixTerminalSyncState(state)) {
        settle(
          new Error(
            error instanceof Error && error.message
              ? error.message
              : `Matrix sync entered ${state} during startup`,
          ),
        );
      }
    };

    const onUnexpectedError = settle;

    const onAbort = () => {
      settle(createMatrixStartupAbortError());
    };

    params.emitter.on("sync.state", onSyncState);
    params.emitter.on("sync.unexpected_error", onUnexpectedError);
    if (abortSignal?.aborted) {
      onAbort();
      return;
    }
    abortSignal?.addEventListener("abort", onAbort, { once: true });
    timeoutId = setTimeout(() => {
      settle(new Error(`Matrix client did not reach a ready sync state within ${timeoutMs}ms`));
    }, timeoutMs);
    timeoutId.unref?.();
  });
}
