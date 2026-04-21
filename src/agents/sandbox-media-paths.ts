import path from "node:path";
import { normalizeBoundaryRoots, resolvePathWithinRoots } from "./path-policy.js";
import { assertSandboxPath } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

export type SandboxedBridgeMediaPathConfig = {
  root: string;
  bridge: SandboxFsBridge;
  workspaceOnly?: boolean;
  allowedRoots?: string[];
};

export function createSandboxBridgeReadFile(params: {
  sandbox: Pick<SandboxedBridgeMediaPathConfig, "root" | "bridge">;
}): (filePath: string) => Promise<Buffer> {
  return async (filePath: string) =>
    await params.sandbox.bridge.readFile({
      filePath,
      cwd: params.sandbox.root,
    });
}

export async function resolveSandboxedBridgeMediaPath(params: {
  sandbox: SandboxedBridgeMediaPathConfig;
  mediaPath: string;
  inboundFallbackDir?: string;
}): Promise<{ resolved: string; rewrittenFrom?: string }> {
  const normalizeFileUrl = (rawPath: string) =>
    rawPath.startsWith("file://") ? rawPath.slice("file://".length) : rawPath;
  const filePath = normalizeFileUrl(params.mediaPath);
  const allowedRoots = normalizeBoundaryRoots([
    params.sandbox.root,
    ...(params.sandbox.allowedRoots ?? []),
  ]);
  const enforceWorkspaceBoundary = async (hostPath: string) => {
    if (!params.sandbox.workspaceOnly) {
      return;
    }
    if (allowedRoots.length <= 1) {
      await assertSandboxPath({
        filePath: hostPath,
        cwd: params.sandbox.root,
        root: params.sandbox.root,
      });
      return;
    }
    const match = resolvePathWithinRoots(allowedRoots, hostPath, {
      cwd: params.sandbox.root,
      boundaryLabel: "allowed work roots",
    });
    await assertSandboxPath({
      filePath: match.resolved,
      cwd: match.root,
      root: match.root,
    });
  };

  const resolveDirect = () =>
    params.sandbox.bridge.resolvePath({
      filePath,
      cwd: params.sandbox.root,
    });
  try {
    const resolved = resolveDirect();
    if (resolved.hostPath) {
      await enforceWorkspaceBoundary(resolved.hostPath);
    }
    return { resolved: resolved.hostPath ?? resolved.containerPath };
  } catch (err) {
    const fallbackDir = params.inboundFallbackDir?.trim();
    if (!fallbackDir) {
      throw err;
    }
    const fallbackPath = path.join(fallbackDir, path.basename(filePath));
    try {
      const stat = await params.sandbox.bridge.stat({
        filePath: fallbackPath,
        cwd: params.sandbox.root,
      });
      if (!stat) {
        throw err;
      }
    } catch {
      throw err;
    }
    const resolvedFallback = params.sandbox.bridge.resolvePath({
      filePath: fallbackPath,
      cwd: params.sandbox.root,
    });
    if (resolvedFallback.hostPath) {
      await enforceWorkspaceBoundary(resolvedFallback.hostPath);
    }
    return {
      resolved: resolvedFallback.hostPath ?? resolvedFallback.containerPath,
      rewrittenFrom: filePath,
    };
  }
}
