import { spawnSync } from "node:child_process";
import { constants } from "node:os";
import path from "node:path";
import { loadInventorySources, type inventory } from "../database-worker-inventory.mjs";
import {
  reportNativeTypeScriptPhase,
  type NativeTypeScriptObserver,
} from "./native-typescript.mts";

const toolingRoot = path.resolve(import.meta.dirname, "../..");
const tracePrefix = "[inventory-phase] ";

export class InventoryProcessError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.exitCode = exitCode;
  }
}

/** A snapshot owns its V8/compiler graphs until this synchronous child has exited. */
export function inventoryInSubprocess(
  root: string,
  ref = "",
  staged = false,
  sources: ReadonlyMap<string, string> = loadInventorySources(root, ref, staged),
  observer?: NativeTypeScriptObserver,
): ReturnType<typeof inventory> {
  // Preserve the caller's explicit heap cap, not its test preloads or debuggers.
  const heapArgs = process.execArgv.filter(
    (arg, index, args) =>
      arg.startsWith("--max-old-space-size=") ||
      arg === "--max-old-space-size" ||
      args[index - 1] === "--max-old-space-size",
  );
  const child = spawnSync(
    process.versions.bun ? "node" : process.execPath,
    [
      ...heapArgs,
      "--import",
      path.join(toolingRoot, "scripts/tsx.mjs"),
      path.join(toolingRoot, "scripts/database-worker-inventory.mjs"),
      "--json",
      "--snapshot",
    ],
    {
      cwd: toolingRoot,
      input: JSON.stringify({
        root,
        ref,
        staged,
        sources: [...sources],
        trace: observer !== undefined,
      }),
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
    },
  );
  const diagnostics: string[] = [];
  for (const line of (child.stderr ?? "").split(/\r?\n/u)) {
    if (line.startsWith(tracePrefix)) {
      const event: { phase: string; facts?: Record<string, string | number> } = JSON.parse(
        line.slice(tracePrefix.length),
      );
      reportNativeTypeScriptPhase(observer, event.phase, event.facts);
    } else if (line) {
      diagnostics.push(line);
    }
  }
  if (child.error || child.status !== 0) {
    const exitCode = child.status ?? (child.signal ? 128 + constants.signals[child.signal] : 1);
    throw (
      child.error ??
      new InventoryProcessError(
        diagnostics.join("\n") ||
          `SQLite snapshot inventory failed (${child.signal ?? child.status}).`,
        exitCode,
      )
    );
  }
  if (diagnostics.length > 0) {
    console.error(diagnostics.join("\n"));
  }
  const result: { files: ReturnType<typeof inventory> } = JSON.parse(child.stdout);
  return result.files;
}
