import path from "node:path";
import { resolveIdentityPathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import { normalizeWindowsPathForComparison } from "../../infra/path-guards.js";
import type { SandboxFsBridge } from "./fs-bridge.types.js";

type SandboxFileIdentityParams = {
  filePath: string;
  cwd?: string;
  signal?: AbortSignal;
};

export const SANDBOX_FILE_IDENTITY = Symbol.for("openclaw.sandboxFileIdentity");

type SandboxFileIdentityBridge = SandboxFsBridge & {
  [SANDBOX_FILE_IDENTITY](params: SandboxFileIdentityParams): string | Promise<string>;
};

function hasSandboxFileIdentity(bridge: SandboxFsBridge): bridge is SandboxFileIdentityBridge {
  return SANDBOX_FILE_IDENTITY in bridge;
}

export async function resolveSandboxFileIdentity(params: {
  bridge: SandboxFsBridge;
  filePath: string;
  cwd?: string;
  signal?: AbortSignal;
}): Promise<string> {
  let identity: string;
  if (hasSandboxFileIdentity(params.bridge)) {
    identity = await params.bridge[SANDBOX_FILE_IDENTITY]({
      filePath: params.filePath,
      cwd: params.cwd,
      signal: params.signal,
    });
  } else {
    // Shipped plugin bridges may predate physical identity support. Normalize
    // equivalent lexical spellings without claiming to resolve remote aliases;
    // current bridges supply their own physical identity above.
    const resolved = params.bridge.resolvePath({ filePath: params.filePath, cwd: params.cwd });
    const containerPath = resolved.containerPath;
    identity = resolved.hostPath
      ? resolveIdentityPathViaExistingAncestorSync(resolved.hostPath)
      : !containerPath.startsWith("/") && path.win32.isAbsolute(containerPath)
        ? normalizeWindowsPathForComparison(containerPath)
        : path.posix.normalize(containerPath);
  }
  return identity;
}

export async function resolveSandboxFileMutationQueueKey(params: {
  bridge: SandboxFsBridge;
  root: string;
  filePath: string;
  cwd?: string;
  signal?: AbortSignal;
}): Promise<string> {
  return `${params.root}\0${await resolveSandboxFileIdentity(params)}`;
}
