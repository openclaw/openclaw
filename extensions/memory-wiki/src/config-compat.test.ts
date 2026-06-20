// Memory Wiki tests cover config compat plugin behavior.
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import {
  legacyConfigRules,
  migrateMemoryWikiLegacyConfig,
  normalizeCompatibilityConfig,
} from "./config-compat.js";
import { resolveMemoryWikiConfigForAgent } from "./config.js";

describe("memory-wiki config compatibility", () => {
  it("detects any legacy global plugin config", () => {
    expect(
      legacyConfigRules[0]?.match({
        vaultMode: "bridge",
      }),
    ).toBe(true);
  });

  it("migrates readMemoryCore to readMemoryArtifacts", () => {
    const config = {
      plugins: {
        entries: {
          "memory-wiki": {
            config: {
              bridge: {
                enabled: true,
                readMemoryCore: false,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const migration = migrateMemoryWikiLegacyConfig(config);

    expect(migration?.changes).toEqual([
      "Moved plugins.entries.memory-wiki.config.bridge.readMemoryCore → bridge.readMemoryArtifacts.",
      "Moved plugins.entries.memory-wiki.config → memory.extensions.memory-wiki.",
    ]);
    expect(
      (
        migration!.config.memory!.extensions!["memory-wiki"] as {
          bridge?: Record<string, unknown>;
        }
      ).bridge,
    ).toEqual({
      enabled: true,
      readMemoryArtifacts: false,
    });
  });

  it("keeps the canonical bridge toggle when both keys are present", () => {
    const config = {
      plugins: {
        entries: {
          "memory-wiki": {
            config: {
              bridge: {
                readMemoryCore: false,
                readMemoryArtifacts: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    const migration = normalizeCompatibilityConfig({ cfg: config });

    expect(migration.changes).toEqual([
      "Removed legacy plugins.entries.memory-wiki.config.bridge.readMemoryCore; kept explicit bridge.readMemoryArtifacts.",
      "Moved plugins.entries.memory-wiki.config → memory.extensions.memory-wiki.",
    ]);
    expect(
      (
        migration.config.memory!.extensions!["memory-wiki"] as {
          bridge?: Record<string, unknown>;
        }
      ).bridge,
    ).toEqual({
      readMemoryArtifacts: true,
    });
  });

  it("pins a populated legacy main vault for a custom default agent", () => {
    const config = {
      agents: {
        list: [{ id: "research", default: true }],
      },
    } as OpenClawConfig;
    const homedir = "/Users/tester";
    const legacyVaultPath = path.join(homedir, ".openclaw", "wiki", "main");

    const migration = migrateMemoryWikiLegacyConfig(config, {
      homedir,
      pathExists: (candidate) => candidate === legacyVaultPath,
    });

    expect(migration?.changes).toEqual([
      "Preserved legacy ~/.openclaw/wiki/main as the default agent Memory Wiki vault.",
    ]);
    expect(
      resolveMemoryWikiConfigForAgent(migration?.config ?? config, "research", { homedir }).vault
        .path,
    ).toBe(path.join(homedir, ".openclaw", "wiki", "main"));
    expect(migration?.config.memory?.extensions?.["memory-wiki"]).toBeUndefined();
  });
});
