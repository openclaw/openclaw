import { formatSignalDaemonExit, type SignalDaemonHandle } from "./daemon.js";

export function createSignalDaemonLifecycle(params: { abortSignal?: AbortSignal }) {
  let daemonHandle: SignalDaemonHandle | null = null;
  let daemonExitError: Error | undefined;
  const daemonAbortController = new AbortController();
  const abortSignal = params.abortSignal
    ? AbortSignal.any([params.abortSignal, daemonAbortController.signal])
    : daemonAbortController.signal;
  const stop = (): Promise<void> => {
    daemonAbortController.abort(params.abortSignal?.reason ?? new Error("Signal monitor stopped"));
    return daemonHandle?.stop() ?? Promise.resolve();
  };
  const attach = (handle: SignalDaemonHandle) => {
    daemonHandle = handle;
    void handle.exited.then((exit) => {
      if (abortSignal.aborted) {
        return;
      }
      daemonExitError = new Error(formatSignalDaemonExit(exit));
      daemonAbortController.abort(daemonExitError);
    });
  };
  return { attach, stop, getExitError: () => daemonExitError, abortSignal };
}
