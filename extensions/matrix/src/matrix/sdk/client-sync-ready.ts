import type { EventEmitter } from "node:events";
import { createDeferred } from "openclaw/plugin-sdk/concurrency-runtime";
import { raceWithTimeout } from "openclaw/plugin-sdk/time-runtime";
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

  const ready = createDeferred();
  const settle = (error?: Error) => {
    if (error) {
      ready.reject(error);
    } else {
      ready.resolve();
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
  params.emitter.on("sync.state", onSyncState);
  params.emitter.on("sync.unexpected_error", settle);
  try {
    if (params.abortSignal?.aborted) {
      throw createMatrixStartupAbortError();
    }
    await raceWithTimeout(
      ready.promise,
      timeoutMs,
      () => {
        throw new Error(`Matrix client did not reach a ready sync state within ${timeoutMs}ms`);
      },
      {
        ref: false,
        signal: params.abortSignal,
        onAbort: () => {
          throw createMatrixStartupAbortError();
        },
      },
    );
  } finally {
    params.emitter.off("sync.state", onSyncState);
    params.emitter.off("sync.unexpected_error", settle);
  }
}
