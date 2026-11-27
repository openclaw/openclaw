import path from "node:path";
import { toErrorObject } from "../infra/errors.js";
import { isSandboxRootEscapeError } from "./apply-patch-containment-hint.js";
import { assertSandboxPath } from "./sandbox-paths.js";

export async function assertSandboxPathWithinAnyRoot(params: {
  cwd?: string;
  filePath: string;
  roots: readonly string[];
  allowLinkedWorktrees?: boolean;
}) {
  let firstRootEscapeError: unknown;
  const seen = new Set<string>();
  for (const [index, candidateRoot] of params.roots.entries()) {
    if (!candidateRoot) {
      continue;
    }
    const root = path.resolve(candidateRoot);
    if (seen.has(root)) {
      continue;
    }
    seen.add(root);
    try {
      return await assertSandboxPath({
        filePath: params.filePath,
        cwd: index === 0 ? (params.cwd ?? root) : root,
        root,
        ...(index === 0 && params.allowLinkedWorktrees ? { allowLinkedWorktrees: true } : {}),
      });
    } catch (error) {
      if (!isSandboxRootEscapeError(error)) {
        throw error;
      }
      firstRootEscapeError ??= error;
    }
  }
  throw toErrorObject(
    firstRootEscapeError ?? new Error("Path guard has no configured roots."),
    "Non-Error thrown",
  );
}
