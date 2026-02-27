import path from "node:path";
import { assertSandboxPath } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

export type SandboxedBridgeMediaPathConfig = {
  root: string;
  bridge: SandboxFsBridge;
  workspaceOnly?: boolean;
};

export async function resolveSandboxedBridgeMediaPath(params: {
  sandbox: SandboxedBridgeMediaPathConfig;
  mediaPath: string;
  inboundFallbackDir?: string;
}): Promise<{ resolved: string; rewrittenFrom?: string }> {
  const normalizeFileUrl = (rawPath: string) =>
    rawPath.startsWith("file://") ? rawPath.slice("file://".length) : rawPath;
  const filePath = normalizeFileUrl(params.mediaPath);
  const enforceWorkspaceBoundary = async (hostPath: string) => {
    if (!params.sandbox.workspaceOnly) {
      return;
    }
    await assertSandboxPath({
      filePath: hostPath,
      cwd: params.sandbox.root,
      root: params.sandbox.root,
    });
  };

  const resolveDirect = () =>
    params.sandbox.bridge.resolvePath({
      filePath,
      cwd: params.sandbox.root,
    });
  try {
    const resolved = resolveDirect();
    await enforceWorkspaceBoundary(resolved.hostPath);
    return { resolved: resolved.hostPath };
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
    await enforceWorkspaceBoundary(resolvedFallback.hostPath);
    return { resolved: resolvedFallback.hostPath, rewrittenFrom: filePath };
  }
}
