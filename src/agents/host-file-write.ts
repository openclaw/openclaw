import fs from "node:fs/promises";
import path from "node:path";
import { overwriteFileHandleWithAuthority } from "@openclaw/fs-safe/advanced";
import type { SessionSourceAssertion } from "../config/sessions/session-source-authority.js";
import { ignoreMissingPath } from "../infra/errno.js";
import { expandOsHomePrefix } from "./sessions/tools/path-utils.js";

export type HostFileMutationPreparer = SessionSourceAssertion["prepareSessionSourceStorageEffect"];

/** File effects retain database custody, independent of policy checked at tool entry. */
export async function prepareHostFileMutation(
  prepare: HostFileMutationPreparer,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const prepared = await prepare?.();
  return {
    assertCurrent: () => {
      signal?.throwIfAborted();
      prepared?.assertCurrent();
    },
    [Symbol.asyncDispose]: async () => {
      await prepared?.release?.();
    },
  };
}

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
  prepareMutation?: HostFileMutationPreparer,
) {
  const resolved = path.resolve(expandOsHomePrefix(absolutePath));
  {
    await using effect = await prepareHostFileMutation(prepareMutation, abortSignal);
    effect.assertCurrent();
    await fs.mkdir(path.dirname(resolved), { recursive: true });
  }
  const handle = await openHostFileForUpdate(resolved);
  if (!handle) {
    await using effect = await prepareHostFileMutation(prepareMutation, abortSignal);
    effect.assertCurrent();
    await fs.writeFile(resolved, content, "utf-8");
    return;
  }
  try {
    await using effects = new AsyncDisposableStack();
    await overwriteFileHandleWithAuthority(handle, Buffer.from(content, "utf-8"), async () => {
      const effect = effects.use(await prepareHostFileMutation(prepareMutation, abortSignal));
      return effect.assertCurrent;
    });
  } finally {
    await handle.close().catch(() => undefined);
  }
}
