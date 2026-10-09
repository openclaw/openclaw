import { statSync } from "node:fs";
import { basename } from "node:path";
import { deserialize } from "node:v8";
import { readRegularFile } from "@openclaw/fs-safe/advanced";
import { isPathInside, safeRealpathSync } from "@openclaw/fs-safe/path";
import { resolveStateDir } from "../../../config/state-dir.js";
import { resolveRuntimeProcessEntrypointUrl } from "../../../infra/runtime-process-url.js";
import { resolveRuntimeWorkerArgv } from "../../../infra/runtime-worker-url.js";
import { withCommandProcessScope } from "../../../process/exec-spawn.js";
import { runCommandBuffered } from "../../../process/exec.js";
import type { FileReadResult } from "./read-file.worker.js";

function requiresIsolatedRead(filePath: string): boolean {
  const sqliteName = /\.(?:sqlite3?|db)(?:-(?:wal|shm|journal))?$/i;
  const stateDir = resolveStateDir();
  if (sqliteName.test(basename(filePath)) || isPathInside(stateDir, filePath)) {
    return true;
  }
  const realPath = safeRealpathSync(filePath);
  // Metadata probes never close SQLite descriptors; aliases and hardlinks can hide database names.
  return (
    !realPath ||
    sqliteName.test(basename(realPath)) ||
    isPathInside(safeRealpathSync(stateDir) ?? stateDir, realPath) ||
    statSync(realPath, { throwIfNoEntry: false })?.nlink !== 1
  );
}

export async function readLocalFile(filePath: string, signal?: AbortSignal): Promise<Buffer> {
  if (!requiresIsolatedRead(filePath)) {
    return (await readRegularFile({ filePath })).buffer;
  }
  // Closing a raw descriptor in any Gateway thread drops SQLite's POSIX locks on that inode.
  return await withCommandProcessScope(async () => {
    const result = await runCommandBuffered(
      [
        process.execPath,
        ...resolveRuntimeWorkerArgv(resolveRuntimeProcessEntrypointUrl("fileToolRead")),
        filePath,
      ],
      {
        input: "",
        signal,
        // Preserve fs.readFile's byte limit, including the serialized result envelope.
        maxOutputBytes: { stdout: Number.MAX_SAFE_INTEGER, stderr: 64 * 1024 },
      },
    );
    if (result.code !== 0 || result.termination !== "exit") {
      throw result.error ?? new Error(`File read failed: ${result.termination}`);
    }
    // SAFETY: The private child serializes only the read result after closing its descriptor.
    const reply = deserialize(result.stdout) as FileReadResult;
    if ("error" in reply) {
      throw Object.assign(reply.error, { code: reply.code });
    }
    return reply.buffer;
  }, signal);
}
