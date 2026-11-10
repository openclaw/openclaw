import fs from "node:fs";
import { dirname } from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { warnPluginSdkDeprecation } from "../../plugins/sdk-deprecation.js";
import { getAgentDir } from "../config.js";
import { AuthStorage as CoreAuthStorage } from "./auth-storage.core.js";

export type {
  AuthStatus,
  ApiKeyCredential,
  AuthCredential,
  AuthStorageBackend,
  AuthStorageData,
} from "./auth-storage.core.js";
export { OAuthProviderConfiguredUnavailableError } from "./auth-storage.core.js";
export type AuthStorage = CoreAuthStorage;

class AuthStorageLegacyPathMigrationRequiredError extends Error {
  readonly code = "AUTH_PROFILE_MIGRATION_REQUIRED" as const;
  readonly action = "migrate to AuthStorage.forAgentAsync(agentDir)" as const;

  constructor() {
    super(
      "Deprecated AuthStorage path contains unmigrated credentials; run openclaw doctor --fix for standard agent auth.json or migrate plugin storage to AuthStorage.forAgentAsync(agentDir).",
    );
    this.name = "AuthStorageLegacyPathMigrationRequiredError";
  }
}

function assertDeprecatedAuthStoragePathAbsent(authPath: string | undefined): void {
  // Deprecated adapters use this path only to derive the SQLite owner and
  // never create or write it. An existing file is therefore unmigrated input.
  if (authPath && fs.existsSync(authPath)) {
    throw new AuthStorageLegacyPathMigrationRequiredError();
  }
}

const forAgent = CoreAuthStorage.forAgent;
const forAgentAsync = CoreAuthStorage.forAgentAsync;

// Public default paths retain the same constructor used by explicit-directory callers.
export const AuthStorage = Object.assign(CoreAuthStorage, {
  /** @deprecated Use forAgentAsync. Supported through 2026-12-31. Removal in the first January 2027 stable release. */
  forAgent(agentDir: string = getAgentDir(), config?: OpenClawConfig): AuthStorage {
    return forAgent(agentDir, config);
  },
  async forAgentAsync(
    agentDir: string = getAgentDir(),
    config?: OpenClawConfig,
  ): Promise<AuthStorage> {
    return forAgentAsync(agentDir, config);
  },
  /**
   * @deprecated Use AuthStorage.forAgentAsync(agentDir). The path-taking compatibility
   * form remains supported through 2026-12-31; removal ships in the first
   * January 2027 stable. It no longer reads or writes JSON.
   */
  create(authPath?: string): AuthStorage {
    warnPluginSdkDeprecation({
      family: "auth-profile-sync-operations",
      method: "AuthStorage.create",
      replacement: "AuthStorage.forAgentAsync",
    });
    assertDeprecatedAuthStoragePathAbsent(authPath);
    return AuthStorage.forAgent(authPath ? dirname(authPath) : getAgentDir(), undefined);
  },
});
Object.defineProperty(AuthStorage, "create", { enumerable: false });
