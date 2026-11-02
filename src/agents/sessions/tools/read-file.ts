import { statSync } from "node:fs";
import { deserialize } from "node:v8";
import { readRegularFile } from "@openclaw/fs-safe/advanced";
import { isPathInside, safeRealpathSync } from "@openclaw/fs-safe/path";
import { resolveStateDir } from "../../../config/state-dir.js";
import { resolveRuntimeProcessEntrypointUrl } from "../../../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../../../infra/runtime-worker-url.js";
import { isSqliteFilePath } from "../../../infra/sqlite-file-path.js";
import {
  resolveCommandProcessSignal,
  withCommandProcessScope,
} from "../../../process/exec-spawn.js";
import { runCommandBuffered } from "../../../process/exec.js";
import { getSpawnBroker } from "../../../process/spawn-broker/context.js";
import { withChildProcessOperation } from "../../../process/spawn-diagnostics.js";
import {
  captureReadFilePage,
  type ReadFilePage,
  type ReadFilePageParams,
} from "./read-file-page.js";
import type { FileReadResult } from "./read-file.worker.js";

function requiresIsolatedRead(filePath: string): boolean {
  const stateDir = resolveStateDir();
  if (isSqliteFilePath(filePath) || isPathInside(stateDir, filePath)) {
    return true;
  }
  const realPath = safeRealpathSync(filePath);
  // Metadata probes never close SQLite descriptors; aliases and hardlinks can hide database names.
  return (
    !realPath ||
    isSqliteFilePath(realPath) ||
    isPathInside(safeRealpathSync(stateDir) ?? stateDir, realPath) ||
    statSync(realPath, { throwIfNoEntry: false })?.nlink !== 1
  );
}

export async function readLocalFile(filePath: string, signal?: AbortSignal): Promise<Buffer> {
  if (!requiresIsolatedRead(filePath)) {
    return (await readRegularFile({ filePath })).buffer;
  }
  // Closing a raw descriptor in any Gateway thread drops SQLite's POSIX locks on that inode.
  const broker = getSpawnBroker();
  if (broker) {
    return broker.readFile(filePath, resolveCommandProcessSignal(signal));
  }
  return (await readFileInWorker(filePath, signal)).buffer;
}

export async function captureLocalReadFile(
  filePath: string,
  params: ReadFilePageParams,
  signal?: AbortSignal,
): Promise<ReadFilePage> {
  if (!requiresIsolatedRead(filePath)) {
    return captureReadFilePage(filePath, params, signal);
  }
  const broker = getSpawnBroker();
  if (broker) {
    return broker.readFilePage(filePath, params, resolveCommandProcessSignal(signal));
  }
  return readFileInWorker(filePath, signal, params);
}

// Standalone CLI callers have no Gateway broker to retain a separate-process reader.
async function readFileInWorker(
  filePath: string,
  signal: AbortSignal | undefined,
  page?: ReadFilePageParams,
): Promise<ReadFilePage> {
  return withCommandProcessScope(async () => {
    const result = await withChildProcessOperation("agent.file-read", () =>
      runCommandBuffered(
        [
          process.execPath,
          ...resolveRuntimeWorkerArgv(resolveRuntimeProcessEntrypointUrl("fileToolRead")),
          filePath,
          ...(page ? ["page", JSON.stringify(page)] : []),
        ],
        {
          input: "",
          signal,
          maxOutputBytes: { stdout: Number.MAX_SAFE_INTEGER, stderr: 64 * 1024 },
        },
      ),
    );
    if (result.code !== 0 || result.termination !== "exit") {
      throw result.error ?? new Error(`File read failed: ${result.termination}`);
    }
    // SAFETY: The private child serializes only its read result after closing its descriptor.
    const reply = deserialize(result.stdout) as FileReadResult;
    if ("error" in reply) {
      throw Object.assign(reply.error, { code: reply.code });
    }
    return reply;
  }, signal);
}
