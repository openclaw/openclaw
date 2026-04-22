import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { saveJsonFile } from "../../infra/json-file.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { AUTH_PROFILE_FILENAME } from "./path-constants.js";
import { resolveAuthStatePath, resolveAuthStorePath } from "./path-resolve.js";
import type { AuthProfileSecretsStore } from "./types.js";
export {
  resolveAuthStatePath,
  resolveAuthStatePathForDisplay,
  resolveAuthStorePath,
  resolveAuthStorePathForDisplay,
  resolveLegacyAuthStorePath,
  resolveOAuthRefreshLockPath,
} from "./path-resolve.js";

export function ensureAuthStoreFile(pathname: string) {
  if (fs.existsSync(pathname)) {
    return;
  }
  const payload: AuthProfileSecretsStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  saveJsonFile(pathname, payload);
}

/**
 * Discover auth-profile store paths for every agent directory on disk, so
 * OAuth refresh can broadcast fresh credentials to peer agents instead of
 * only the invoking agent's store and the main store. This closes issue
 * #59272 — without it, a refresh on agent A rotates the server-side refresh
 * token and silently invalidates the stale copy held by every other agent
 * that never entered the refresh path.
 *
 * The caller passes any store paths it wants to skip (usually the invoking
 * agent's own path and the main path, which are handled elsewhere). Missing
 * files are filtered out so a brand-new agent dir without an auth file is
 * ignored rather than created — profiles only ever replace an existing
 * entry on a peer; they never create a new one.
 *
 * Set `OPENCLAW_DISABLE_AUTH_PEER_MIRROR=1` to opt out and restore the
 * pre-fix behavior (mirror to main only).
 */
export function listPeerAuthStorePaths(
  params: {
    exclude?: readonly string[];
    env?: NodeJS.ProcessEnv;
  } = {},
): string[] {
  const env = params.env ?? process.env;
  if (env.OPENCLAW_DISABLE_AUTH_PEER_MIRROR === "1") {
    return [];
  }
  const agentsRoot = path.join(resolveStateDir(env), "agents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const excluded = new Set((params.exclude ?? []).map((p) => path.resolve(p)));
  const results: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(agentsRoot, entry.name, "agent", AUTH_PROFILE_FILENAME);
    if (excluded.has(path.resolve(candidate))) {
      continue;
    }
    if (!fs.existsSync(candidate)) {
      continue;
    }
    results.push(candidate);
  }
  return results.toSorted();
}
