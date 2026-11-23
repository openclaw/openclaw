import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadAuthProfileStoreForRuntimeAsync } from "./auth-profiles.js";
import {
  assertAuthProfileMigrationStateAtDatabasePath,
  hasLegacyAuthProfileCredentialSourceAsync,
} from "./auth-profiles/legacy-source-diagnostic.js";
import { resolveSharedAuthStorePath } from "./auth-profiles/path-resolve.js";
import { getScopedAuthProfileEnv } from "./auth-profiles/runtime-scope.js";
import { resolveAuthProfileDatabasePath } from "./auth-profiles/sqlite.js";
import { assertRuntimeProviderSecretOwnerAvailable } from "./model-auth-runtime-config.js";

export async function assertProviderAuthReady(params: {
  provider: string;
  cfg?: OpenClawConfig;
  agentDir?: string;
}): Promise<void> {
  const env = cloneEnvWithPlatformSemantics(getScopedAuthProfileEnv() ?? process.env);
  env.OPENCLAW_STATE_DIR = resolveStateDir(env);
  const databasePath = params.agentDir
    ? resolveAuthProfileDatabasePath(params.agentDir)
    : undefined;
  // Pending credential files own their providers' auth routes until Doctor commits
  // and archives them; do not fall through to env/config credentials.
  if (await hasLegacyAuthProfileCredentialSourceAsync(params.agentDir, env)) {
    await loadAuthProfileStoreForRuntimeAsync(
      params.agentDir,
      {
        migrationProvider: params.provider,
        config: params.cfg,
        readOnly: true,
        externalCli: { mode: "none" },
      },
      env,
    );
  }
  assertAuthProfileMigrationStateAtDatabasePath(
    databasePath ?? resolveSharedAuthStorePath(env),
    params.provider,
    params.cfg,
  );
  // A failed explicit ref owns the provider. Stop before profile/env discovery so requests cannot
  // silently switch credentials while this configured owner is cold.
  assertRuntimeProviderSecretOwnerAvailable({ cfg: params.cfg, provider: params.provider });
}
