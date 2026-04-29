import path from "node:path";
import { assertSandboxPath } from "./sandbox-paths.js";
import type { SandboxFsBridge } from "./sandbox/fs-bridge.js";

export type SandboxedBridgeMediaPathConfig = {
  root: string;
  bridge: SandboxFsBridge;
  workspaceOnly?: boolean;
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

  // Detect media:// URIs before bridge resolution so they are not mangled
  // by POSIX path.resolve (which turns media://inbound/x into workspace/media:/inbound/x).
  if (/^media:\/\//i.test(filePath)) {
    const fallbackDir = params.inboundFallbackDir?.trim();
    if (fallbackDir) {
      const basename = path.basename(new URL(filePath).pathname);
      const fallbackPath = path.join(fallbackDir, basename);
      try {
        const stat = await params.sandbox.bridge.stat({
          filePath: fallbackPath,
          cwd: params.sandbox.root,
        });
        if (stat) {
          const resolvedFallback = params.sandbox.bridge.resolvePath({
            filePath: fallbackPath,
            cwd: params.sandbox.root,
          });
          return {
            resolved: resolvedFallback.hostPath ?? resolvedFallback.containerPath,
            rewrittenFrom: filePath,
          };
        }
      } catch {
        // stat or resolve failed — fall through to return the raw URI
      }
    }
    // Return the raw media:// URI so downstream loadWebMedia can resolve it
    // through resolveMediaStoreUriToPath.
    return { resolved: filePath };
  }

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
