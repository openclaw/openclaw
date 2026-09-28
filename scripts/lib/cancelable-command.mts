import { hasUnjoinedWork, signalExitCode } from "./managed-child-process.mts";

export function isCommandCancellation(error: unknown) {
  return (
    !hasUnjoinedWork(error) &&
    error instanceof Error &&
    (error.name === "AbortError" || ("code" in error && error.code === "ABORT_ERR"))
  );
}

/** Keep the command owner alive through leaf cleanup and asynchronous ownership release. */
export async function runCancelableCommand(run: (signal: AbortSignal) => Promise<number>) {
  const controller = new AbortController();
  let received: NodeJS.Signals | undefined;
  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    const handler = () => {
      received ??= signal;
      // Let active leaves receive the original OS signal before generic abort.
      queueMicrotask(() => controller.abort());
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }
  try {
    try {
      const status = await run(controller.signal);
      return received ? signalExitCode(received) : status;
    } catch (error) {
      // Unverified extinction must reach artifact ownership, never become an exit code.
      if (!received || !isCommandCancellation(error)) {
        throw error;
      }
      return signalExitCode(received);
    }
  } finally {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  }
}
