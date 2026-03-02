import path from "node:path";
import { resolveSandboxInputPath } from "./sandbox-paths.js";

type RelativePathOptions = {
  allowRoot?: boolean;
  cwd?: string;
  boundaryLabel?: string;
  includeRootInError?: boolean;
};

function toRelativePathUnderRoot(params: {
  root: string;
  candidate: string;
  options?: RelativePathOptions;
}): string {
  const rootResolved = path.resolve(params.root);
  const resolvedCandidate = path.resolve(
    resolveSandboxInputPath(params.candidate, params.options?.cwd ?? params.root),
  );
  const relative = path.relative(rootResolved, resolvedCandidate);
  if (relative === "" || relative === ".") {
    if (params.options?.allowRoot) {
      return "";
    }
    const boundary = params.options?.boundaryLabel ?? "workspace root";
    const suffix = params.options?.includeRootInError ? ` (${rootResolved})` : "";
    throw new Error(`Path escapes ${boundary}${suffix}: ${params.candidate}`);
  }
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    const boundary = params.options?.boundaryLabel ?? "workspace root";
    const suffix = params.options?.includeRootInError ? ` (${rootResolved})` : "";
    throw new Error(`Path escapes ${boundary}${suffix}: ${params.candidate}`);
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
