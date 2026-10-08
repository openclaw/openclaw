// Built with the invocation's immutable runtime generation, never loaded as source.
import { createServiceChildRelayAdapter } from "../../src/process/supervisor/service-child-relay-host.js";
import type { ProcessExtinctionResult } from "../../src/process/supervisor/types.js";
import { signalExitCode } from "./managed-child-process.mts";

/** The caller owns a complete local tooling entry, not an arbitrary callback. */
export async function runDistArtifactCommand(
  args: string[],
  cwd: string,
  admitRoot: (pid: number, startIdentity: number) => Promise<string>,
  signal?: AbortSignal,
): Promise<number> {
  const controller = new AbortController();
  const abortSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  let received: (typeof signals)[number] | undefined;
  const handlers = signals.map((name) => {
    const forward = () => {
      received ??= name;
      controller.abort();
    };
    process.on(name, forward);
    return [name, forward] as const;
  });
  let cleanup: Promise<ProcessExtinctionResult> | undefined;
  try {
    const { adapter, ready } = await createServiceChildRelayAdapter({
      command: process.execPath,
      args,
      cwd,
      env: process.env,
      // This fixed tooling entry has no application stdin. Reserve it for a
      // one-shot admission grant; the root cannot import workload code before it.
      stdinMode: "pipe-open",
      oomScoreWrapperSelected: false,
      stdoutConsumption: "awaited",
      stderrDestination: process.stderr,
      abortSignal,
      onSpawnCleanup: (pending) => {
        cleanup = pending;
      },
    });
    const cancel = () => adapter.kill("SIGTERM");
    abortSignal.addEventListener("abort", cancel, { once: true });
    try {
      const output = adapter.consumeStdout(
        (chunk) =>
          new Promise<void>((resolve, reject) => {
            process.stdout.write(chunk, (error) => (error ? reject(error) : resolve()));
          }),
      );
      // The adapter wait joins this same consumer, including delayed destination writes.
      void output.catch(() => {});
      await ready;
      if (adapter.treeOwnership !== "linux-subreaper") {
        adapter.kill("SIGTERM");
        throw new Error("Artifact entry was not admitted by the native descendant owner");
      }
      const root = adapter.nativeRootIdentity;
      if (!root || !adapter.stdin) {
        throw new Error("Artifact native root channel or birth identity is unavailable");
      }
      const grant = await admitRoot(root.pid, root.startIdentity);
      if (abortSignal.aborted) {
        cancel();
      }
      adapter.stdin.write(grant + "\n");
      adapter.stdin.end();
      const [result, extinct] = await Promise.allSettled([
        adapter.wait().catch((error: unknown) => {
          adapter.kill("SIGTERM");
          throw error;
        }),
        adapter.waitForExtinction(),
      ]);
      if (extinct.status === "rejected") {
        throw extinct.reason;
      }
      if (result.status === "rejected") {
        throw result.reason;
      }
      // Source EOF can precede the inherited diagnostic destination's callbacks.
      await new Promise<void>((resolve, reject) => {
        process.stderr.write("", (error) => (error ? reject(error) : resolve()));
      });
      return received
        ? signalExitCode(received)
        : (result.value.code ?? (result.value.signal ? signalExitCode(result.value.signal) : 1));
    } catch (error) {
      adapter.kill("SIGTERM");
      throw error;
    } finally {
      abortSignal.removeEventListener("abort", cancel);
      adapter.dispose();
    }
  } catch (error) {
    // Construction can fail after spawning the native owner. Keep its separate
    // cleanup outcome and join it before the artifact caller sees the failure.
    const [closed] = await Promise.allSettled([cleanup]);
    throw Object.assign(
      new Error("Artifact native command did not provide complete settlement", {
        cause:
          closed.status === "rejected"
            ? new AggregateError([error, closed.reason], "Artifact command and cleanup failed")
            : error,
      }),
      { processTreeState: "indeterminate" },
    );
  } finally {
    for (const [name, forward] of handlers) {
      process.off(name, forward);
    }
  }
}
