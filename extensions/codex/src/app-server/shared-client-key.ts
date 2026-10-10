/** Cache keys that decide which acquisitions share one physical Codex app-server client. */
import { createHash } from "node:crypto";
import {
  resolveCodexAppServerFallbackApiKeyCacheKey,
  resolveCodexAppServerPreparedApiKeyCacheKey,
} from "./auth-cache-key.js";
import type * as codexAuth from "./auth-types.js";
import type { CodexAppServerStartOptions } from "./config-contracts.js";
import { codexAppServerStartOptionsKey } from "./config-runtime.js";
import type { CodexDesktopGeneration } from "./desktop-generation-owner.js";

/**
 * Returns the shared-client key for start options under one acquisition's
 * auth identity, desktop generation, and runtime-artifact mode. Callers key
 * their resolved start options, and rekey after a managed fallback.
 */
export function createSharedCodexAppServerClientKeyResolver(params: {
  startOptions: CodexAppServerStartOptions;
  agentDir?: string;
  authProfileId?: string;
  authBindingFingerprint?: string;
  preparedAuth?: codexAuth.CodexAppServerResolvedPreparedAuth;
  authRequirement?: codexAuth.CodexAppServerAuthRequirement;
  usesNativeAuth: boolean;
  desktopGeneration?: CodexDesktopGeneration;
  runtimeArtifactMode?: "capture";
  expectedRuntimeArtifact?: { id: string; fingerprint: string };
}): (startOptions: CodexAppServerStartOptions) => string {
  const { preparedAuth, authRequirement, authProfileId, desktopGeneration } = params;
  const authIdentityCacheKey =
    preparedAuth?.kind === "api-key"
      ? resolveCodexAppServerPreparedApiKeyCacheKey(preparedAuth.apiKey)
      : (preparedAuth?.snapshot.secretFreeCacheKey ??
        (authRequirement === "api-key" && !authProfileId
          ? resolveCodexAppServerFallbackApiKeyCacheKey({ startOptions: params.startOptions })
          : undefined));
  // Capture turns cannot inherit a normal client whose loaded bytes predate the
  // filesystem snapshot. Keep their physical process generation separate.
  const expectedRuntimeArtifactKey = params.expectedRuntimeArtifact
    ? createHash("sha256")
        .update(params.expectedRuntimeArtifact.id)
        .update("\0")
        .update(params.expectedRuntimeArtifact.fingerprint)
        .digest("hex")
    : "mint";
  return (startOptions) => {
    const baseKey = `${codexAppServerStartOptionsKey(startOptions, {
      authProfileId,
      authBindingFingerprint: params.authBindingFingerprint,
      agentDir: params.usesNativeAuth ? undefined : params.agentDir,
      fallbackApiKeyCacheKey: authIdentityCacheKey,
    })}\0auth-requirement:${authRequirement ?? "native"}${
      desktopGeneration ? `\0desktop-generation:${desktopGeneration.epoch}` : ""
    }`;
    return params.runtimeArtifactMode
      ? `${baseKey}\0runtime-artifact:capture-v1:${expectedRuntimeArtifactKey}`
      : baseKey;
  };
}
