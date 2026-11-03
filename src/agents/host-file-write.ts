import fs from "node:fs/promises";
import path from "node:path";
import { overwriteFileHandleWithAuthority } from "@openclaw/fs-safe/advanced";
import { prepareSessionSourceEffect } from "../config/sessions/session-source-authority.js";
import { ignoreMissingPath } from "../infra/errno.js";
import { captureAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";
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
  const assertCurrent = captureAgentToolSourceExecutionGuard(abortSignal);
  await using effects = new AsyncDisposableStack();
  const prepareAuthority = async () => {
    const prepared = await prepareSessionSourceEffect(assertCurrent);
    effects.defer(() => prepared.release?.());
    return prepared.assertCurrent;
  };
  const resolved = path.resolve(expandOsHomePrefix(absolutePath));
  (await prepareAuthority())();
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const handle = await openHostFileForUpdate(resolved);
  if (!handle) {
    (await prepareAuthority())();
    await fs.writeFile(resolved, content, "utf-8");
    return;
  }
  try {
    await overwriteFileHandleWithAuthority(handle, Buffer.from(content, "utf-8"), prepareAuthority);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
