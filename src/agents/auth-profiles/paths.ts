/**
 * Public path barrel for auth-profile stores.
 * Import through this file for canonical SQLite display and lock paths.
 */
import path from "node:path";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { Result } from "@openclaw/normalization-core/result";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { resolveStateDir } from "../../config/paths.js";
import { withSqliteWorkerCleanupFailure } from "../../infra/sqlite-worker-broker-reply.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { resolveUserPath } from "../../utils.js";
import {
  resolveOAuthRefreshLockPath,
  resolveSharedAuthStoreOwnershipAsync,
  resolveSharedAuthStorePath,
} from "./path-resolve.js";
import { prepareSharedAuthStoreOwnershipForNative } from "./path-resolve.native.js";
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
 * @deprecated New SDK displays should use resolveProviderAuthProfileMetadataAsync from
 * openclaw/plugin-sdk/provider-auth-runtime. This selected-path helper remains supported until
 * removal in a later stable release after deprecation ships;
 * resolveAuthStorePathForDisplayAsync is core-internal.
 */
export function resolveAuthStorePathForDisplay(agentDir?: string): string {
  warnPluginSdkDeprecation({
    family: "auth-profile-sync-operations",
    method: "resolveAuthStorePathForDisplay",
    replacement:
      "provider metadata from resolveProviderAuthProfileMetadataAsync in openclaw/plugin-sdk/provider-auth-runtime",
    compatibility:
      "This selected-path helper remains supported until removal in a later stable release after deprecation ships; its async path replacement is core-internal.",
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
  let result: Result<string, unknown>;
  try {
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
    result = { ok: true, value: normalizeDisplayPath(selected, capturedEnv) };
  } catch (error) {
    result = { ok: false, error };
  }
  try {
    await local?.dispose();
  } catch (error) {
    throw result.ok
      ? error
      : withSqliteWorkerCleanupFailure(
          toErrorObject(result.error, "Auth display path read failed"),
          error,
        );
  }
  if (!result.ok) {
    throw result.error;
  }
  return result.value;
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
