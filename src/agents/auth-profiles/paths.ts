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

/** Resolve the user-facing path for the database selected by the auth store loader. */
export function resolveAuthStorePathForDisplay(agentDir?: string): string {
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

/** Private model preparation: inspect the original source once before formatting its labels. */
export async function withPreparedAuthStorePathForDisplay<T>(
  agentDir: string | undefined,
  env: NodeJS.ProcessEnv,
  assertCurrent: () => void,
  consume: (pathname: string) => T,
): Promise<T> {
  assertCurrent();
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
  const shared: Result<ReturnType<typeof captureOpenClawStateWorkerContext>, unknown> = (() => {
    try {
      return { ok: true, value: captureOpenClawStateWorkerContext({ env: capturedEnv }) };
    } catch (error) {
      return { ok: false, error };
    }
  })();
  let localUsed = false;
  let sharedUsed = false;
  const assertSources = () => {
    assertCurrent();
    if (localUsed) {
      local?.assertCurrent();
    }
    if (sharedUsed) {
      if (!shared.ok) {
        throw shared.error;
      }
      shared.value.maintenanceScope?.assertAdmission();
      shared.value.admission.assertCurrent();
    }
  };
  let result: Result<T, unknown>;
  try {
    let selected: string | undefined;
    if (local) {
      localUsed = true;
      assertSources();
      const rows = await local.read();
      assertSources();
      selected = selectLocalDisplayPath(localPath, rows.store.status);
    }
    if (selected === undefined) {
      sharedUsed = true;
      assertSources();
      if (!shared.ok) {
        throw shared.error;
      }
      await resolveSharedAuthStoreOwnershipAsync(shared.value);
      assertSources();
      selected = resolveSharedAuthStorePath(capturedEnv);
    }
    assertSources();
    result = { ok: true, value: consume(normalizeDisplayPath(selected, capturedEnv)) };
    assertSources();
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
  assertSources();
  return result.value;
}

/** Retained name for callers that present auth runtime state from the same selected store. */
export function resolveAuthStatePathForDisplay(agentDir?: string): string {
  return resolveAuthStorePathForDisplay(agentDir);
}
