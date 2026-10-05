import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { killProcessTree } from "openclaw/plugin-sdk/process-runtime";
import { closeCodexAppServerTransportAndWait } from "./app-server/transport.js";

/** Keeps worker placement custody until native process exit is observed. */
export function createCodexNodeAppServerProcessOwner(params: {
  child: () => ChildProcessWithoutNullStreams | undefined;
  unsubscribe: () => void;
  release: () => Promise<void> | void;
  activeProcesses: Set<() => Promise<void>>;
  terminate?: typeof closeCodexAppServerTransportAndWait;
}) {
  let settled = false;
  let settling: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  const settle = async (confirmedExit = false) => {
    if (settled) {
      return;
    }
    const child = params.child();
    if (!confirmedExit && child && child.exitCode === null && child.signalCode === null) {
      return;
    }
    if (settling) {
      return await settling;
    }
    settling = (async () => {
      await params.release();
      params.activeProcesses.delete(stop);
      settled = true;
    })();
    try {
      await settling;
    } catch (error) {
      settling = undefined;
      throw error;
    }
  };
  const stop = async () => {
    if (stopping) {
      return await stopping;
    }
    stopping = (async () => {
      params.unsubscribe();
      const child = params.child();
      let confirmedExit = false;
      if (child && child.exitCode === null && child.signalCode === null) {
        if (process.platform === "win32" && child.pid) {
          killProcessTree(child.pid, { graceMs: 1000 });
        }
        const result = await (params.terminate ?? closeCodexAppServerTransportAndWait)(child, {
          exitTimeoutMs: 5000,
        });
        if (!result.exited) {
          throw new Error("Codex node app-server process did not terminate");
        }
        confirmedExit = true;
      }
      await settle(confirmedExit);
    })();
    try {
      await stopping;
    } catch (error) {
      stopping = undefined;
      throw error;
    }
  };
  const observe = (child: ChildProcessWithoutNullStreams) => {
    params.activeProcesses.add(stop);
    child.once("exit", () => {
      void settle().catch(() => {});
    });
  };
  return { stop, observe };
}
