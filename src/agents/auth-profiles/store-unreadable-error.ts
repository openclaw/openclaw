import { shortenHomePath } from "../../utils.js";

export const AUTH_PROFILE_MIGRATION_COMMAND = "openclaw doctor --fix" as const;

export class AuthProfileStoreUnreadableError extends Error {
  readonly code = "AUTH_PROFILE_STORE_UNREADABLE" as const;
  readonly action = AUTH_PROFILE_MIGRATION_COMMAND;

  constructor(databasePath: string) {
    super(
      `Auth profile store ${shortenHomePath(databasePath)} is unreadable; run ${AUTH_PROFILE_MIGRATION_COMMAND}.`,
    );
    this.name = "AuthProfileStoreUnreadableError";
  }
}
