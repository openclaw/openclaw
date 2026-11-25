import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import {
  extractErrorCode,
  FsSafeError,
  type root as fsRoot,
  statRegularFileSync,
} from "openclaw/plugin-sdk/security-runtime";
import type { ChatGptImportRunRecord } from "./import-runs-state.js";

type ChatGptImportRunEntry = ChatGptImportRunRecord["createdPaths"][number];
export type ChatGptRollbackEntryRef = {
  entry: ChatGptImportRunEntry;
  kind: "created" | "updated";
  index: number;
};
export type ChatGptRecoverySlot = {
  ref: ChatGptRollbackEntryRef;
  slotRelativePath: string;
  contentRelativePath: string;
};
export type ChatGptRollbackRoot = Awaited<ReturnType<typeof fsRoot>>;

export function recoverySlotPrefix(ref: ChatGptRollbackEntryRef): string {
  return `${ref.kind}-${ref.index}-${createHash("sha256").update(ref.entry.path).digest("hex")}-`;
}

export function resolveContainedImportPath(
  root: string,
  relativePath: string,
  label: string,
): string {
  if (!relativePath || path.isAbsolute(relativePath) || path.win32.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a relative path: ${relativePath}`);
  }
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, relativePath);
  if (!isPathInside(resolvedRoot, resolvedPath)) {
    throw new Error(`${label} must stay inside ${resolvedRoot}: ${relativePath}`);
  }
  return resolvedPath;
}

export function isFsSafeErrorCode(error: unknown, code: FsSafeError["code"]): boolean {
  return error instanceof FsSafeError && error.code === code;
}

async function reserveRecoverySlot(
  runRoot: ChatGptRollbackRoot,
  ref: ChatGptRollbackEntryRef,
): Promise<{ slotRelativePath: string; contentRelativePath: string }> {
  await runRoot.mkdir("recovered");
  const slotRelativePath = path.posix.join(
    "recovered",
    `${recoverySlotPrefix(ref)}${randomUUID()}`,
  );
  await runRoot.mkdir(slotRelativePath);
  return {
    slotRelativePath,
    contentRelativePath: path.posix.join(slotRelativePath, "content"),
  };
}

export async function removeEmptyRecoverySlot(
  runRoot: ChatGptRollbackRoot,
  slotRelativePath: string,
): Promise<void> {
  try {
    if ((await runRoot.list(slotRelativePath)).length > 0) {
      return;
    }
    await runRoot.remove(slotRelativePath);
  } catch (error) {
    if (isFsSafeErrorCode(error, "not-found")) {
      return;
    }
    throw error;
  }
}

export async function moveTargetToRecovery(params: {
  vaultRoot: ChatGptRollbackRoot;
  runRoot: ChatGptRollbackRoot;
  runRelativePath: string;
  ref: ChatGptRollbackEntryRef;
}): Promise<ChatGptRecoverySlot | null> {
  const sourcePath = resolveContainedImportPath(
    params.vaultRoot.rootReal,
    params.ref.entry.path,
    "Memory Wiki import page path",
  );
  for (;;) {
    const slot = await reserveRecoverySlot(params.runRoot, params.ref);
    const recoveryVaultRelativePath = path.posix.join(
      params.runRelativePath,
      slot.contentRelativePath,
    );
    try {
      await params.vaultRoot.move(params.ref.entry.path, recoveryVaultRelativePath, {
        assertBeforeMutation: () => {
          // Root.move accepts directories; rollback owns the narrower page-file contract.
          // Root.move rechecks its retained source identity after this admission callback.
          let source;
          try {
            source = statRegularFileSync(sourcePath);
          } catch (cause) {
            if (extractErrorCode(cause)) {
              throw cause;
            }
            throw new FsSafeError("invalid-path", "Memory Wiki rollback requires a regular file", {
              cause,
            });
          }
          if (source.missing) {
            throw new FsSafeError("not-found", "Memory Wiki rollback target no longer exists");
          }
        },
      });
      return { ref: params.ref, ...slot };
    } catch (error) {
      await removeEmptyRecoverySlot(params.runRoot, slot.slotRelativePath);
      if (isFsSafeErrorCode(error, "not-found")) {
        return null;
      }
      if (isFsSafeErrorCode(error, "already-exists")) {
        continue;
      }
      throw error;
    }
  }
}
