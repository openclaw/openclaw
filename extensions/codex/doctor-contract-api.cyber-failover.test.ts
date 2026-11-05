import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };
import { readCodexPluginConfig } from "./src/app-server/config-parsing.js";

function createConfig(cyberFailover: unknown) {
  return {
    agents: {
      defaults: {
        model: { primary: "openai/primary", fallbacks: ["openai/fallback@work"] },
        models: { "openai/primary": { alias: "primary" } },
      },
    },
    auth: {
      profiles: { work: { provider: "openai", mode: "api_key" } },
      order: { openai: ["work"] },
    },
    plugins: {
      entries: {
        codex: {
          enabled: true,
          config: {
            appServer: {
              command: "/synthetic/codex",
              approvalPolicy: "never",
              authToken: "synthetic-token",
              cyberFailover,
            },
          },
        },
        unrelated: { enabled: false, config: { model: "keep-me" } },
      },
    },
  } satisfies OpenClawConfig;
}

describe("Codex cyber failover target retirement", () => {
  it.each(["openai/retired-target", "", null, 42, {}, undefined])(
    "removes only the retired target %j while preserving routing, account, and mode",
    (model) => {
      const current = { mode: "off", cooloffMs: 1234 };
      const original = createConfig({ ...current, model });
      const before = structuredClone(original);
      const legacyPluginConfig = original.plugins.entries.codex.config;
      const rule = legacyConfigRules.find((candidate) => candidate.path.at(-1) === "cyberFailover");
      expect(rule?.match(legacyPluginConfig.appServer.cyberFailover)).toBe(true);
      expect(rule?.message).toContain('Run "openclaw doctor --fix"');
      expect(
        validateJsonSchemaValue({ schema: manifest.configSchema, value: legacyPluginConfig }).ok,
      ).toBe(false);
      expect(readCodexPluginConfig(legacyPluginConfig)).toEqual({});

      const result = normalizeCompatibilityConfig({ cfg: original });

      expect(result.config).toEqual(createConfig(current));
      expect(result.changes).toEqual([
        "Removed retired plugins.entries.codex.config.appServer.cyberFailover.model; automatic cyber-policy retries use the active model through approved Daybreak access. Existing mode and cooloffMs settings were not changed.",
      ]);
      expect(original).toEqual(before);
      const pluginConfig = result.config.plugins?.entries?.codex?.config;
      expect(
        validateJsonSchemaValue({ schema: manifest.configSchema, value: pluginConfig }).ok,
      ).toBe(true);
      expect(readCodexPluginConfig(pluginConfig)).toEqual(pluginConfig);
      expect(rule?.match(current)).toBe(false);
      const repeated = normalizeCompatibilityConfig({ cfg: result.config });
      expect(repeated.config).toBe(result.config);
      expect(repeated.changes).toEqual([]);
    },
  );

  it.each([undefined, null, [], {}, { mode: "auto", cooloffMs: 500 }])(
    "leaves config without an own target untouched: %j",
    (cyberFailover) => {
      const cfg = createConfig(cyberFailover);
      const result = normalizeCompatibilityConfig({ cfg });
      expect(result.config).toBe(cfg);
      expect(result.changes).toEqual([]);
    },
  );
});
