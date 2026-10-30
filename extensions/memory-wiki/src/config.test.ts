import fs from "node:fs";
import path from "node:path";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { memoryWikiConfigSchema } from "./config-schema.js";
import { resolveMemoryWikiAgentConfig, resolveMemoryWikiConfig } from "./config.js";

function validateManifestConfig(value: unknown) {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: JsonSchemaObject };
  return validateJsonSchemaValue({
    cacheKey: "memory-wiki.manifest.config.test",
    schema: manifest.configSchema,
    value,
    applyDefaults: true,
  }).ok;
}

describe("resolveMemoryWikiConfig", () => {
  it("uses the configured state directory for schema-resolved defaults", () => {
    const stateDir = "/tmp/openclaw-schema-state";
    withEnv({ OPENCLAW_STATE_DIR: stateDir }, () => {
      const parsed = memoryWikiConfigSchema.safeParse?.(undefined);
      expect(parsed).toMatchObject({
        success: true,
        data: { vault: { path: path.join(stateDir, "wiki", "main") } },
      });
    });
  });

  it("uses the wiki root before appending the single configured agent", () => {
    const base = resolveMemoryWikiConfig(
      { vault: { scope: "agent" } },
      { homedir: "/Users/tester" },
    );
    const resolved = resolveMemoryWikiAgentConfig({
      config: base,
      appConfig: { agents: { entries: { support: {} } } },
    });
    expect(
      resolveMemoryWikiConfig({ vault: { path: "~/vaults/wiki" } }, { homedir: "/Users/tester" })
        .vault.path,
    ).toBe(path.join("/Users/tester", "vaults", "wiki"));
    const expectedRoot = path.join("/Users/tester", ".openclaw", "wiki");
    expect(base.vault.path).toBe(expectedRoot);
    expect(resolved.vault.path).toBe(path.join(expectedRoot, "support"));
  });

  it.each([
    [{ vaultMode: "unsafe-local", vault: { scope: "agent" } }, ["vaultMode"]],
    [
      { vault: { scope: "agent" }, obsidian: { useOfficialCli: true } },
      ["obsidian", "useOfficialCli"],
    ],
  ] as const)("rejects incompatible agent-scoped config %j", (config, issuePath) => {
    expect(memoryWikiConfigSchema.safeParse?.(config)).toMatchObject({
      success: false,
      error: {
        issues: expect.arrayContaining([expect.objectContaining({ path: issuePath })]),
      },
    });
    expect(validateManifestConfig(config)).toBe(false);
  });
});
