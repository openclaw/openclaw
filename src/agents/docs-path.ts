/**
 * Locates local OpenClaw docs/source roots for references shown to agents.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { resolveOpenClawPackageRoot } from "../infra/openclaw-root.js";
import { isPathInside } from "../infra/path-guards.js";
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
  const resolveReference = async (directory: string, marker: string) => {
    try {
      await fs.access(path.join(directory, marker));
      if (!params.sandbox?.enabled) {
        return directory;
      }
      const hostPath = await fs.realpath(directory);
      const bridge = params.sandbox.fsBridge;
      if (!bridge) {
        return null;
      }
      const mappings = bridge.pathMappings;
      const resolved = bridge.resolvePath({ filePath: mappings ? directory : hostPath });
      const mapped = mappings ? resolveSandboxPathMapping(mappings, resolved.containerPath) : null;
      const backingPath = mappings ? mapped?.hostPath : resolved.hostPath;
      // Preserve mount aliases, but reject shadows and symlinks outside the selected source.
      return backingPath &&
        (await fs.realpath(backingPath)) === hostPath &&
        (!mapped || isPathInside(await fs.realpath(mapped.mapping.hostRoot), hostPath))
        ? resolved.containerPath
        : null;
    } catch {
      return null;
    }
  };
  const packageRoot = await resolveOpenClawPackageRoot(params);
  const workspaceDir = params.workspaceDir?.trim();
  return {
    docsPath:
      (workspaceDir
        ? await resolveReference(path.join(workspaceDir, "docs"), "docs.json")
        : null) ??
      (packageRoot ? await resolveReference(path.join(packageRoot, "docs"), "docs.json") : null),
    sourcePath: packageRoot ? await resolveReference(packageRoot, ".git") : null,
  };
}
