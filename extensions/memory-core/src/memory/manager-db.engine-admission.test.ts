import * as engineRuntime from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, expect, it, vi } from "vitest";
import { openMemoryDatabaseReadOnlyAtPath } from "./manager-db.js";

afterEach(() => vi.restoreAllMocks());

it("reports unavailable PostgreSQL search before a missing index can become an empty SQLite index", () => {
  vi.spyOn(engineRuntime, "getDatabaseEngineSelection").mockReturnValue({
    input: { connection: "postgresql://unreachable.invalid/r4", schemaPrefix: "r4_memory" },
  });

  expect(() =>
    openMemoryDatabaseReadOnlyAtPath(
      "/synthetic-missing-r4-memory/openclaw-agent.sqlite",
      false,
      "main",
    ),
  ).toThrowError(
    expect.objectContaining({
      name: "DatabaseSearchCapabilityUnavailableError",
      code: "DATABASE_SEARCH_CAPABILITY_UNAVAILABLE",
    }),
  );
});
