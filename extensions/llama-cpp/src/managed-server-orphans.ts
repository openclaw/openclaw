import path from "node:path";
import { createSubsystemLogger } from "openclaw/plugin-sdk/logging-core";
import { findManagedLlamaServerAsset } from "./llama-server-assets.js";

const log = createSubsystemLogger("llama-cpp");
const recoveries = new Map<string, Promise<void>>();

function readUniqueArgument(argv: readonly string[], name: string): string | undefined {
  const values = argv.flatMap((argument, index) => {
    if (argument === name) {
      const value = argv[index + 1];
      return value === undefined ? [] : [value];
    }
    return argument.startsWith(`${name}=`) ? [argument.slice(name.length + 1)] : [];
  });
  return values.length === 1 ? values[0] : undefined;
}

/** A new host process recovers once; in-process restarts retain that host's children. */
export async function recoverManagedLlamaServer(params: {
  command: string;
  port: number;
  presetPath?: string;
  cwd?: string;
  args?: readonly string[];
  signal?: AbortSignal;
}): Promise<void> {
  params.signal?.throwIfAborted();
  if (!findManagedLlamaServerAsset(params.command)) {
    return;
  }
  const required = new Map([["--port", String(params.port)]]);
  const preset = params.presetPath ?? readUniqueArgument(params.args ?? [], "--models-preset");
  if (preset) {
    required.set("--models-preset", preset);
  }
  const cwd =
    preset && !path.isAbsolute(preset) ? path.resolve(params.cwd ?? process.cwd()) : undefined;
  const host = readUniqueArgument(params.args ?? [], "--host");
  if (host) {
    required.set("--host", host);
  }
  const key = JSON.stringify([params.command, [...required], cwd]);
  let recovery = recoveries.get(key);
  if (!recovery) {
    recovery = (async () => {
      const { reapOrphanedProcesses } = await import("openclaw/plugin-sdk/process-runtime");
      // Released 2026.9.9 hosts lack this helper; remove when the minimum plugin API advances.
      if (typeof reapOrphanedProcesses !== "function") {
        return;
      }
      await reapOrphanedProcesses({
        command: params.command,
        cwd,
        matchesArguments: (argv) =>
          [...required].every(([name, value]) => readUniqueArgument(argv, name) === value),
        signal: params.signal,
        onReap: (pid) =>
          log.info(`reaping orphaned managed llama-server: pid=${pid} port=${params.port}`),
      });
    })().catch((error: unknown) => {
      recoveries.delete(key);
      throw error;
    });
    recoveries.set(key, recovery);
  }
  await recovery;
  params.signal?.throwIfAborted();
}
