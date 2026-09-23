import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errors.js";
import { overwriteFileHandle } from "../infra/file-descriptor.js";
import { captureAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";
import { expandOsHomePrefix } from "./sessions/tools/path-utils.js";

function resolveHostPath(filePath: string): string {
  return path.resolve(expandOsHomePrefix(filePath));
}

async function openHostFileForUpdate(resolved: string) {
  try {
    const existing = await fs.stat(resolved);
    // Rollback requires the original bytes; unreadable files must fail before mutation.
    return existing.isFile() ? await fs.open(resolved, "r+") : undefined;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function writeHostFile(
  absolutePath: string,
  content: string,
  abortSignal?: AbortSignal,
) {
  const assertCurrent = captureAgentToolSourceExecutionGuard(abortSignal);
  const resolved = resolveHostPath(absolutePath);
  assertCurrent();
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const handle = await openHostFileForUpdate(resolved);
  if (!handle) {
    assertCurrent();
    await fs.writeFile(resolved, content, "utf-8");
    return;
  }
  try {
    await overwriteFileHandle(handle, Buffer.from(content, "utf-8"), {
      beforeWrite: assertCurrent,
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}
