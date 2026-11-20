import fs from "node:fs/promises";
import path from "node:path";
import { overwriteFileHandle } from "@openclaw/fs-safe/advanced";
import { ignoreMissingPath } from "../infra/errno.js";
import { expandOsHomePrefix } from "./sessions/tools/path-utils.js";

async function openHostFileForUpdate(resolved: string) {
  try {
    const existing = await fs.stat(resolved);
    // Rollback requires the original bytes; unreadable files must fail before mutation.
    return existing.isFile() ? await fs.open(resolved, "r+") : undefined;
  } catch (error) {
    return ignoreMissingPath(error);
  }
}

export async function writeHostFile(
  absolutePath: string,
  content: string,
  abortSignal?: AbortSignal,
) {
  const resolved = path.resolve(expandOsHomePrefix(absolutePath));
  abortSignal?.throwIfAborted();
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const handle = await openHostFileForUpdate(resolved);
  if (!handle) {
    abortSignal?.throwIfAborted();
    await fs.writeFile(resolved, content, "utf-8");
    return;
  }
  try {
    await overwriteFileHandle(handle, Buffer.from(content, "utf-8"), {
      beforeWrite: () => abortSignal?.throwIfAborted(),
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}
