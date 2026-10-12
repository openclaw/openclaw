import fs from "node:fs";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, describe, expect, it } from "vitest";
import { resolveWorkboardDatabaseInput } from "./database-config.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("workboard host database selection", () => {
  it("defaults to SQLite and does not resolve unused PostgreSQL credentials", async () => {
    await expect(resolveWorkboardDatabaseInput({})).resolves.toBeUndefined();
    await expect(
      resolveWorkboardDatabaseInput({
        database: {
          engine: "sqlite",
          postgres: { connection: { source: "file", provider: "missing", id: "/dsn" } },
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("resolves a file SecretRef on the host with the configured prefix", async () => {
    const file = path.join(tempDirs.make("workboard-database-secret-"), "connection.json");
    const connection = "postgresql://localhost/workboard_fixture";
    fs.writeFileSync(file, JSON.stringify({ dsn: connection }), { mode: 0o600 });
    await expect(
      resolveWorkboardDatabaseInput({
        database: {
          engine: "postgres",
          postgres: {
            connection: { source: "file", provider: "database", id: "/dsn" },
            schemaPrefix: "fixture",
          },
        },
        secrets: { providers: { database: { source: "file", path: file } } },
      }),
    ).resolves.toEqual({ connection, schemaPrefix: "fixture" });
  });

  it.each([
    undefined,
    { connection: { source: "file", provider: "missing", id: "/dsn" } },
  ] as const)(
    "refuses missing or unresolved PostgreSQL connections without fallback %#",
    async (postgres) => {
      await expect(
        resolveWorkboardDatabaseInput({ database: { engine: "postgres", postgres } }),
      ).rejects.toThrow(/database.postgres.connection.*(?:Configure|configured)/);
    },
  );
});
