import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveConfiguredSecretInputString } from "openclaw/plugin-sdk/secret-input-runtime";

export type WorkboardDatabaseInput = { connection: string; schemaPrefix: string } | undefined;

/** Resolve secrets on the host; workers receive only the selected connection. */
export async function resolveWorkboardDatabaseInput(
  config: OpenClawConfig,
): Promise<WorkboardDatabaseInput> {
  if (config.database?.engine !== "postgres") {
    return undefined;
  }
  const { value, unresolvedRefReason } = await resolveConfiguredSecretInputString({
    config,
    env: process.env,
    value: config.database.postgres?.connection,
    path: "database.postgres.connection",
  });
  if (!value) {
    throw new Error(
      `${unresolvedRefReason ?? "database.engine postgres requires database.postgres.connection."} Configure a resolvable PostgreSQL DSN (prefer a SecretRef).`,
    );
  }
  return { connection: value, schemaPrefix: config.database.postgres?.schemaPrefix ?? "openclaw" };
}
