// Memory Core tests cover canonical dreaming config migration.
import fs from "node:fs";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { migrateMemoryCoreLegacyConfig } from "./config-compat.js";

describe("memory-core config compatibility", () => {
  it("moves dreaming from the selected non-core memory plugin", () => {
    const migration = migrateMemoryCoreLegacyConfig({
      plugins: {
        slots: {
          memory: "memory-lancedb",
        },
        entries: {
          "memory-lancedb": {
            config: {
              embedding: {
                model: "text-embedding-3-small",
              },
              dreaming: {
                enabled: true,
                frequency: "0 */6 * * *",
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    expect(migration?.changes).toEqual([
      "Moved plugins.entries.memory-lancedb.config.dreaming → memory.extensions.memory-core.dreaming.",
    ]);
    expect(migration?.config.memory?.extensions?.["memory-core"]).toEqual({
      dreaming: {
        enabled: true,
        frequency: "0 */6 * * *",
      },
    });
    expect(migration?.config.plugins?.entries?.["memory-lancedb"]?.config).toEqual({
      embedding: {
        model: "text-embedding-3-small",
      },
    });
  });

  it("preserves explicit canonical dreaming settings", () => {
    const migration = migrateMemoryCoreLegacyConfig({
      memory: {
        extensions: {
          "memory-core": {
            dreaming: {
              enabled: false,
            },
          },
        },
      },
      plugins: {
        slots: {
          memory: "memory-lancedb",
        },
        entries: {
          "memory-lancedb": {
            config: {
              dreaming: {
                enabled: true,
                frequency: "0 */6 * * *",
              },
            },
          },
        },
      },
    } as OpenClawConfig);

    expect(migration?.config.memory?.extensions?.["memory-core"]).toEqual({
      dreaming: {
        enabled: false,
        frequency: "0 */6 * * *",
      },
    });
  });

  it("declares the selected memory slot as a compatibility migration trigger", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      configContracts?: { compatibilityMigrationPaths?: string[] };
    };

    expect(manifest.configContracts?.compatibilityMigrationPaths).toContain("plugins.slots.memory");
  });
});
