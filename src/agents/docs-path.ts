/**
 * Locates local OpenClaw docs/source roots for references shown to agents.
 */
import fs from "node:fs";
import path from "node:path";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { resolveSandboxPathMapping } from "./path-policy.js";
import type { SandboxContext } from "./sandbox/types.js";

export const OPENCLAW_DOCS_URL = "https://docs.openclaw.ai";
export const OPENCLAW_SOURCE_URL = "https://github.com/openclaw/openclaw";

type ResolveOpenClawReferencePathParams = {
  workspaceDir?: string;
  argv1?: string;
  cwd?: string;
  moduleUrl?: string;
  sandbox?: Pick<SandboxContext, "enabled" | "fsBridge"> | null;
};

/** Resolve docs and source from one package root, preferring workspace docs. */
export async function resolveOpenClawReferencePaths(
  params: ResolveOpenClawReferencePathParams,
): Promise<{
  docsPath: string | null;
  sourcePath: string | null;
}> {
  const resolveReference = (directory: string, marker: string): string | null => {
    if (!fs.existsSync(path.join(directory, marker))) {
      return null;
    }
    if (!params.sandbox?.enabled) {
      return directory;
    }
    try {
      const hostPath = fs.realpathSync(directory);
      const bridge = params.sandbox.fsBridge;
      if (!bridge) {
        return null;
      }
      const resolved = bridge.resolvePath({ filePath: hostPath });
      const mappings = bridge.pathMappings;
      // Remote bridges expose projections, not host paths; shadows must still match the source.
      const backingPath = mappings
        ? resolveSandboxPathMapping(mappings, resolved.containerPath)?.hostPath
        : resolved.hostPath;
      return backingPath && fs.realpathSync(backingPath) === hostPath
        ? resolved.containerPath
        : null;
    } catch {
      return null;
    }
  };
  const packageRoot = await resolveOpenClawPackageRoot({
    cwd: params.cwd,
    argv1: params.argv1,
    moduleUrl: params.moduleUrl,
  });
  const workspaceDir = params.workspaceDir?.trim();
  return {
    docsPath:
      (workspaceDir ? resolveReference(path.join(workspaceDir, "docs"), "docs.json") : null) ??
      (packageRoot ? resolveReference(path.join(packageRoot, "docs"), "docs.json") : null),
    sourcePath: packageRoot ? resolveReference(packageRoot, ".git") : null,
  };
}
