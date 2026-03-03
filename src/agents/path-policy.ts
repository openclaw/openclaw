import path from "node:path";
import { normalizeWindowsPathForComparison } from "../infra/path-guards.js";
import { resolveSandboxInputPath } from "./sandbox-paths.js";

type RelativePathOptions = {
  allowRoot?: boolean;
  cwd?: string;
  boundaryLabel?: string;
  includeRootInError?: boolean;
};

function throwPathEscapesBoundary(params: {
  options?: RelativePathOptions;
  rootResolved: string;
  candidate: string;
}): never {
  const boundary = params.options?.boundaryLabel ?? "workspace root";
  const suffix = params.options?.includeRootInError ? ` (${params.rootResolved})` : "";
  throw new Error(`Path escapes ${boundary}${suffix}: ${params.candidate}`);
}

function toRelativePathUnderRoot(params: {
  root: string;
  candidate: string;
  options?: RelativePathOptions;
}): string {
  const resolvedInput = resolveSandboxInputPath(
    params.candidate,
    params.options?.cwd ?? params.root,
  );

  if (process.platform === "win32") {
    const rootResolved = path.win32.resolve(params.root);
    const resolvedCandidate = path.win32.resolve(resolvedInput);
    const rootForCompare = normalizeWindowsPathForComparison(rootResolved);
    const targetForCompare = normalizeWindowsPathForComparison(resolvedCandidate);
    const relative = path.win32.relative(rootForCompare, targetForCompare);
    if (relative === "" || relative === ".") {
      if (params.options?.allowRoot) {
        return "";
      }
      throwPathEscapesBoundary({
        options: params.options,
        rootResolved,
        candidate: params.candidate,
      });
    }
    if (relative.startsWith("..") || path.win32.isAbsolute(relative)) {
      throwPathEscapesBoundary({
        options: params.options,
        rootResolved,
        candidate: params.candidate,
      });
    }
    return relative;
  }

  const rootResolved = path.resolve(params.root);
  const resolvedCandidate = path.resolve(resolvedInput);
  const relative = path.relative(rootResolved, resolvedCandidate);
  if (relative === "" || relative === ".") {
    if (params.options?.allowRoot) {
      return "";
    }
    throwPathEscapesBoundary({
      options: params.options,
      rootResolved,
      candidate: params.candidate,
    });
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throwPathEscapesBoundary({
      options: params.options,
      rootResolved,
      candidate: params.candidate,
    });
  }
  return relative;
}

export function toRelativeWorkspacePath(
  root: string,
  candidate: string,
  options?: Pick<RelativePathOptions, "allowRoot" | "cwd">,
): string {
  return toRelativePathUnderRoot({
    root,
    candidate,
    options: {
      allowRoot: options?.allowRoot,
      cwd: options?.cwd,
      boundaryLabel: "workspace root",
    },
  });
}

export function toRelativeSandboxPath(
  root: string,
  candidate: string,
  options?: Pick<RelativePathOptions, "allowRoot" | "cwd">,
): string {
  return toRelativePathUnderRoot({
    root,
    candidate,
    options: {
      allowRoot: options?.allowRoot,
      cwd: options?.cwd,
      boundaryLabel: "sandbox root",
      includeRootInError: true,
    },
  });
}

export function resolvePathFromInput(filePath: string, cwd: string): string {
  return path.normalize(resolveSandboxInputPath(filePath, cwd));
}
