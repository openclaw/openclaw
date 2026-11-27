import path from "node:path";
import { createInterface } from "node:readline";
import { loadInventorySources, type inventory } from "../database-worker-inventory.mjs";
import { runManagedCommand } from "./managed-child-process.mts";
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

/** Join one snapshot's V8/compiler processes before starting the next snapshot. */
export async function inventoryInSubprocess(
  root: string,
  ref = "",
  staged = false,
  sources: ReadonlyMap<string, string> = loadInventorySources(root, ref, staged),
  observer?: NativeTypeScriptObserver,
): Promise<ReturnType<typeof inventory>> {
  // Preserve the caller's explicit heap cap, not its test preloads or debuggers.
  const heapArgs = process.execArgv.filter(
    (arg, index, args) =>
      arg.startsWith("--max-old-space-size=") ||
      arg === "--max-old-space-size" ||
      args[index - 1] === "--max-old-space-size",
  );
  const output: Buffer[] = [];
  const diagnostics: string[] = [];
  let transportError: Error | undefined;
  const exitCode = await runManagedCommand({
    bin: process.versions.bun ? "node" : process.execPath,
    args: [
      ...heapArgs,
      "--import",
      path.join(toolingRoot, "scripts/tsx.mjs"),
      path.join(toolingRoot, "scripts/database-worker-inventory.mjs"),
      "--json",
      "--snapshot",
    ],
    cwd: toolingRoot,
    stdio: ["pipe", "pipe", "pipe"],
    requireProcessTreeExit: process.platform !== "win32",
    onReady(child) {
      child.stdout!.on("data", (chunk: Buffer) => output.push(chunk));
      createInterface({ input: child.stderr!, crlfDelay: Infinity }).on("line", (line) => {
        if (!line.startsWith(tracePrefix)) {
          if (line) {
            diagnostics.push(line);
          }
          return;
        }
        try {
          const event: { phase: string; facts?: Record<string, string | number> } = JSON.parse(
            line.slice(tracePrefix.length),
          );
          reportNativeTypeScriptPhase(observer, event.phase, event.facts);
        } catch (error) {
          transportError ??= error instanceof Error ? error : new Error(String(error));
        }
      });
      child.stdin!.on("error", (error) => {
        transportError ??= error;
      });
      child.stdin!.end(
        JSON.stringify({ root, ref, staged, sources: [...sources], trace: observer !== undefined }),
      );
    },
  });
  if (exitCode !== 0) {
    throw new InventoryProcessError(
      diagnostics.join("\n") || `SQLite snapshot inventory failed (${exitCode}).`,
      exitCode,
    );
  }
  if (transportError) {
    throw transportError;
  }
  if (diagnostics.length > 0) {
    console.error(diagnostics.join("\n"));
  }
  const result: { files: ReturnType<typeof inventory> } = JSON.parse(
    Buffer.concat(output).toString("utf8"),
  );
  return result.files;
}
