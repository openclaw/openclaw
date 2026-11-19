import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { readMigrationConfigPath } from "openclaw/plugin-sdk/migration";
import { expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import { parsePolicy } from "./src/stores-config.js";

const config = (maintenance: Record<string, unknown>) =>
  ({
    plugins: {
      entries: {
        knowledge: {
          enabled: true,
          config: { writesEnabled: true, maintenance },
        },
      },
    },
  }) as OpenClawConfig;

const flagged = (cfg: OpenClawConfig) =>
  legacyConfigRules.filter((rule) => rule.match(readMigrationConfigPath(cfg, rule.path)));

it("removes the retired reviewJobId and keeps the rest of the Knowledge config", () => {
  const before = config({ schedule: "*/10 * * * *", reviewJobId: "13a7daf3" });
  const original = structuredClone(before);
  expect(flagged(before)).toHaveLength(1);
  const result = normalizeCompatibilityConfig({ cfg: before });
  expect(result.changes).toHaveLength(1);
  expect(result.config.plugins?.entries?.knowledge).toStrictEqual({
    enabled: true,
    config: { writesEnabled: true, maintenance: { schedule: "*/10 * * * *" } },
  });
  expect(before, "the input is not mutated").toStrictEqual(original);
  expect(() => parsePolicy(result.config.plugins?.entries?.knowledge?.config)).not.toThrow();
  expect(flagged(result.config)).toHaveLength(0);
  expect(normalizeCompatibilityConfig({ cfg: result.config }).changes).toStrictEqual([]);
});

it("leaves configs without the retired key unchanged", () => {
  for (const cfg of [config({ schedule: "30 3 * * *" }), {} as OpenClawConfig]) {
    expect(flagged(cfg)).toHaveLength(0);
    expect(normalizeCompatibilityConfig({ cfg })).toStrictEqual({ config: cfg, changes: [] });
  }
});
