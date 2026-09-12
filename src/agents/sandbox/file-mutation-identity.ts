import { resolveIdentityPathViaExistingAncestorSync } from "../../infra/boundary-path.js";
import type { SandboxFsBridge } from "./fs-bridge.types.js";

type SandboxFileIdentityParams = {
  filePath: string;
  cwd?: string;
  signal?: AbortSignal;
};

export const SANDBOX_FILE_IDENTITY = Symbol.for("openclaw.sandboxFileIdentity");
export const SANDBOX_FILE_POLICY_PATH = Symbol.for("openclaw.sandboxFilePolicyPath");

type SandboxFileIdentityBridge = SandboxFsBridge & {
  [SANDBOX_FILE_IDENTITY](params: SandboxFileIdentityParams): string | Promise<string>;
};

type SandboxFilePolicyPathBridge = SandboxFsBridge & {
  [SANDBOX_FILE_POLICY_PATH](params: SandboxFileIdentityParams): string | Promise<string>;
};

function hasSandboxFileIdentity(bridge: SandboxFsBridge): bridge is SandboxFileIdentityBridge {
  return SANDBOX_FILE_IDENTITY in bridge;
}

function hasSandboxFilePolicyPath(bridge: SandboxFsBridge): bridge is SandboxFilePolicyPathBridge {
  return SANDBOX_FILE_POLICY_PATH in bridge;
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
    // Shipped plugin bridges may predate physical identity support. Their resolved bridge path
    // preserves the prior SDK contract while current bridges canonicalize aliases.
    const resolved = params.bridge.resolvePath({ filePath: params.filePath, cwd: params.cwd });
    identity = resolved.hostPath
      ? resolveIdentityPathViaExistingAncestorSync(resolved.hostPath)
      : resolved.containerPath;
  }
  return identity;
}

/** Resolves one file identity back into the bridge's caller-facing policy namespace. */
export async function resolveSandboxFilePolicyPath(params: {
  bridge: SandboxFsBridge;
  filePath: string;
  cwd?: string;
  signal?: AbortSignal;
}): Promise<string> {
  if (hasSandboxFilePolicyPath(params.bridge)) {
    return await params.bridge[SANDBOX_FILE_POLICY_PATH]({
      filePath: params.filePath,
      cwd: params.cwd,
      signal: params.signal,
    });
  }
  // Shipped plugin bridges may predate policy-identity support. Preserve their
  // existing policy namespace rather than assuming they accept host paths.
  return params.bridge.resolvePath({ filePath: params.filePath, cwd: params.cwd }).containerPath;
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
