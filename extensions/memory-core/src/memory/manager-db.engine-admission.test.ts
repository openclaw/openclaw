import * as engineRuntime from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, expect, it, vi } from "vitest";
import { openMemoryDatabaseReadOnlyAtPath } from "./manager-db.js";

afterEach(() => vi.restoreAllMocks());

it("reports unavailable PostgreSQL search before a missing index can become an empty SQLite index", () => {
  vi.spyOn(engineRuntime, "getDatabaseEngineSelection").mockReturnValue({
    effectiveEngines: {
      state: "postgres",
      agent: "postgres",
      workboard: "postgres",
      logbook: "postgres",
      "team-reports": "postgres",
      quarantine: "sqlite",
      "managed-update": "sqlite",
      "package-activation": "sqlite",
    },
    postgres: { connection: "postgresql://unreachable.invalid/r4", schemaPrefix: "r4_memory" },
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

it("keeps SQLite agent memory available when state uses PostgreSQL", () => {
  vi.spyOn(engineRuntime, "getDatabaseEngineSelection").mockReturnValue({
    effectiveEngines: {
      state: "postgres",
      agent: "sqlite",
      workboard: "sqlite",
      logbook: "sqlite",
      "team-reports": "sqlite",
      quarantine: "sqlite",
      "managed-update": "sqlite",
      "package-activation": "sqlite",
    },
    postgres: { connection: "postgresql://unreachable.invalid/r4", schemaPrefix: "r4_memory" },
  });

  const opened = openMemoryDatabaseReadOnlyAtPath(
    "/synthetic-missing-r4-memory/openclaw-agent.sqlite",
    false,
    "main",
  );
  try {
    expect(opened.hasIndex).toBe(false);
  } finally {
    opened.release();
  }
});
