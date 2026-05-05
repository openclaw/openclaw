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

function parseInboundMediaFallbackName(rawPath: string): string | null {
  let url: URL;
  try {
    url = new URL(rawPath);
  } catch {
    return null;
  }
  if (url.protocol.toLowerCase() !== "media:" || url.hostname !== "inbound") {
    return null;
  }
  const rawName = url.pathname.startsWith("/") ? url.pathname.slice(1) : url.pathname;
  if (!rawName || rawName.includes("/")) {
    return null;
  }
  let decodedName: string;
  try {
    decodedName = decodeURIComponent(rawName);
  } catch {
    return null;
  }
  if (
    !decodedName ||
    decodedName === "." ||
    decodedName === ".." ||
    decodedName.includes("/") ||
    decodedName.includes("\\")
  ) {
    return null;
  }
  return decodedName;
}

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

  // Detect media:// URIs before bridge resolution so they are not mangled
  // by POSIX path.resolve (which turns media://inbound/x into workspace/media:/inbound/x).
  if (/^media:\/\//i.test(filePath)) {
    const fallbackDir = params.inboundFallbackDir?.trim();
    const inboundName = parseInboundMediaFallbackName(filePath);
    if (fallbackDir && inboundName) {
      const fallbackPath = path.join(fallbackDir, inboundName);
      let fallbackStat: Awaited<ReturnType<SandboxFsBridge["stat"]>> | null = null;
      try {
        fallbackStat = await params.sandbox.bridge.stat({
          filePath: fallbackPath,
          cwd: params.sandbox.root,
        });
      } catch {
        // stat failed — fall through to return the raw URI
      }
      if (fallbackStat) {
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
    // Return the raw media:// URI so downstream loadWebMedia can resolve it
    // through resolveMediaStoreUriToPath.
    return { resolved: filePath };
  }

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
