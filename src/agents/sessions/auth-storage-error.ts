import fs from "node:fs";

export class AuthStoragePersistenceError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "AuthStoragePersistenceError";
  }
}

class AuthStorageLegacyPathMigrationRequiredError extends Error {
  readonly code = "AUTH_PROFILE_MIGRATION_REQUIRED" as const;
  readonly action = "migrate to AuthStorage.forAgent(agentDir)" as const;

  constructor() {
    super(
      "Deprecated AuthStorage path contains unmigrated credentials; run openclaw doctor --fix for standard agent auth.json or migrate plugin storage to AuthStorage.forAgent(agentDir).",
    );
    this.name = "AuthStorageLegacyPathMigrationRequiredError";
  }
}

export function assertDeprecatedAuthStoragePathAbsent(authPath: string | undefined): void {
  // Deprecated adapters use this path only to derive the SQLite owner and
  // never create or write it. An existing file is therefore unmigrated input.
  if (authPath && fs.existsSync(authPath)) {
    throw new AuthStorageLegacyPathMigrationRequiredError();
  }
}
