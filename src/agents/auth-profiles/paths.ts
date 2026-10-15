/**
 * Public path barrel for auth-profile stores.
 * Import through this file for canonical SQLite display and lock paths.
 */
import path from "node:path";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { resolveUserPath } from "../../utils.js";
import {
  resolveOAuthRefreshLockPath,
  resolveSharedAuthStoreOwnershipAsync,
  resolveSharedAuthStorePath,
} from "./path-resolve.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./path-resolve.native.js";
import { withAuthProfileReaderCleanup } from "./reader-cleanup.js";
import { prepareAgentAuthProfileRowsRead } from "./sqlite-read.js";
import {
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabaseOwnerId,
} from "./sqlite.js";
import type { AuthProfileRowRead } from "./types.js";

export { resolveOAuthRefreshLockPath };

function selectLocalDisplayPath(
  localPath: string | undefined,
  status: AuthProfileRowRead["store"]["status"] | undefined,
): string | undefined {
  return status !== undefined && status !== "missing" ? localPath : undefined;
}

function normalizeDisplayPath(pathname: string, env: NodeJS.ProcessEnv = process.env): string {
  return pathname.startsWith("~") ? pathname : resolveUserPath(pathname, env);
}

/**
 * @deprecated Display provider/profile identifiers instead. Public database-path displays are retired;
 * there is no public async path replacement. Bundled callers use AuthStorage.resolvePathForDisplayAsync.
 * Supported through 2026-12-31; removal ships in the first January 2027 stable release.
 */
export function resolveAuthStorePathForDisplay(agentDir?: string): string {
  warnPluginSdkDeprecation({
    family: "auth-profile-sync-operations",
    method: "resolveAuthStorePathForDisplay",
    replacement:
      "provider/profile identifiers for displays (there is no public async database-path replacement)",
  });
  prepareSharedAuthStoreOwnershipForNative();
  const localPath = agentDir
    ? path.join(resolveUserPath(agentDir), "openclaw-agent.sqlite")
    : undefined;
  const selected = selectLocalDisplayPath(
    localPath,
    agentDir ? inspectPersistedAuthProfileStoreRaw(agentDir).status : undefined,
  );
  return normalizeDisplayPath(selected ?? resolveSharedAuthStorePath());
}

/** Resolve the selected auth store's display path without host-thread SQLite. */
export async function resolveAuthStorePathForDisplayAsync(
  agentDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const capturedEnv = cloneEnvWithPlatformSemantics(env);
  capturedEnv.OPENCLAW_STATE_DIR = resolveStateDir(capturedEnv);
  const localPath = agentDir
    ? path.join(resolveUserPath(agentDir, capturedEnv), "openclaw-agent.sqlite")
    : undefined;
  const local = localPath
    ? prepareAgentAuthProfileRowsRead({
        databasePath: localPath,
        agentId: resolveAuthProfileDatabaseOwnerId(path.dirname(localPath)),
        env: capturedEnv,
      })
    : undefined;
  return withAuthProfileReaderCleanup(
    async () => {
      let selected: string | undefined;
      if (local) {
        const rows = await local.read();
        selected = selectLocalDisplayPath(localPath, rows.store.status);
      }
      if (selected === undefined) {
        await resolveSharedAuthStoreOwnershipAsync(
          captureOpenClawStateWorkerContext({ env: capturedEnv }),
        );
        selected = resolveSharedAuthStorePath(capturedEnv);
      }
      return normalizeDisplayPath(selected, capturedEnv);
    },
    local ? [local] : [],
    {
      read: "Auth display path read failed",
      cleanup: "Auth display path reader cleanup failed",
    },
  );
}

/** Private model preparation checks its caller authority once before consuming the label. */
export async function withPreparedAuthStorePathForDisplay<T>(
  agentDir: string | undefined,
  env: NodeJS.ProcessEnv,
  assertCurrent: () => void,
  consume: (pathname: string) => T,
): Promise<T> {
  const pathname = await resolveAuthStorePathForDisplayAsync(agentDir, env);
  assertCurrent();
  return consume(pathname);
}

/** @deprecated Use resolveAuthStatePathForDisplayAsync in runtime callers. */
export function resolveAuthStatePathForDisplay(agentDir?: string): string {
  return resolveAuthStorePathForDisplay(agentDir);
}

/** Retained terminology for the selected auth store's async display path. */
export const resolveAuthStatePathForDisplayAsync = resolveAuthStorePathForDisplayAsync;
