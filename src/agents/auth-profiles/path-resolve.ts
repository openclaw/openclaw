import { createHash } from "node:crypto";
import path from "node:path";
import { resolveUserPath } from "../../utils.js";
import { resolveDefaultAgentDir } from "../agent-scope-config.js";
import { AUTH_PROFILE_FILENAME, AUTH_STATE_FILENAME } from "./path-constants.js";

export function resolveAuthStorePath(agentDir?: string): string {
  const resolved = resolveUserPath(agentDir ?? resolveDefaultAgentDir({}));
  return path.join(resolved, AUTH_PROFILE_FILENAME);
}

export function resolveAuthStatePath(agentDir?: string): string {
  const resolved = resolveUserPath(agentDir ?? resolveDefaultAgentDir({}));
  return path.join(resolved, AUTH_STATE_FILENAME);
}

export function resolveAuthStorePathForDisplay(agentDir?: string): string {
  const pathname = resolveAuthStorePath(agentDir);
  return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}

export function resolveAuthStatePathForDisplay(agentDir?: string): string {
  const pathname = resolveAuthStatePath(agentDir);
  return pathname.startsWith("~") ? pathname : resolveUserPath(pathname);
}

export const OAUTH_REFRESH_LOCK_SCOPE = "auth.oauth-refresh";

function buildOAuthRefreshLockHash(provider: string, profileId: string): string {
  const hash = createHash("sha256");
  hash.update(provider, "utf8");
  hash.update("\u0000", "utf8"); // NUL separator: unambiguous boundary.
  hash.update(profileId, "utf8");
  return `sha256-${hash.digest("hex")}`;
}

/**
 * Resolve the SQLite state-lock key for a cross-agent, per-profile OAuth
 * refresh. The hash input is `provider\0profileId`, which is unambiguous,
 * filesystem-independent, and bounded for arbitrary profile ids.
 */
export function resolveOAuthRefreshLockKey(provider: string, profileId: string): string {
  return buildOAuthRefreshLockHash(provider, profileId);
}
