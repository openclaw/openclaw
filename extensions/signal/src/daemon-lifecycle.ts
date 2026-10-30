import { formatSignalDaemonExit, type SignalDaemonHandle } from "./daemon.js";

export function createSignalDaemonLifecycle(params: {
  abortSignal?: AbortSignal;
  /** Fires once gateway shutdown has started; unexpected daemon exits during
   *  drain must not be treated as monitor failures that could trigger a respawn. */
  shutdownSignal?: AbortSignal;
}) {
  let daemonHandle: SignalDaemonHandle | null = null;
  let daemonStopRequested = false;
  let daemonStopPromise: Promise<void> | undefined;
  let daemonExitError: Error | undefined;
  const daemonAbortController = new AbortController();
  const shutdownSignal = params.shutdownSignal ?? params.abortSignal;
  const abortSignal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, daemonAbortController.signal])
    : daemonAbortController.signal;
  const isDraining = () =>
    daemonStopRequested || params.abortSignal?.aborted === true || shutdownSignal?.aborted === true;
  const stop = (): Promise<void> => {
    if (daemonStopPromise) {
      return daemonStopPromise;
    }
    daemonStopRequested = true;
    if (!daemonAbortController.signal.aborted) {
      daemonAbortController.abort(
        params.abortSignal?.reason ?? new Error("Signal monitor stopped"),
      );
    }
    daemonStopPromise = daemonHandle?.stop() ?? Promise.resolve();
    return daemonStopPromise;
  };
  const attach = (handle: SignalDaemonHandle) => {
    daemonHandle = handle;
    void handle.exited.then((exit) => {
      if (isDraining()) {
        return;
      }
      daemonExitError = new Error(formatSignalDaemonExit(exit));
      if (!daemonAbortController.signal.aborted) {
        daemonAbortController.abort(daemonExitError);
      }
    });
  };
  return { attach, stop, getExitError: () => daemonExitError, abortSignal };
}
