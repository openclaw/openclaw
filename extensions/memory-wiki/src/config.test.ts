// Memory Wiki tests cover config plugin behavior.
import fs from "node:fs";
import path from "node:path";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { withEnv } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { memoryWikiConfigSchema } from "./config-schema.js";
import { resolveMemoryWikiAgentConfig, resolveMemoryWikiConfig } from "./config.js";

function compileManifestConfigSchema() {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: JsonSchemaObject };
  return (value: unknown) =>
    validateJsonSchemaValue({
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

  it("resolves normalized agent ids to distinct vault roots", () => {
    const base = resolveMemoryWikiConfig(
      {
        vault: {
          scope: "agent",
          path: "~/vaults/wiki",
        },
      },
      { homedir: "/Users/tester" },
    );
    const appConfig = {
      agents: {
        entries: { "support-team": {}, marketing: {} },
      },
    } as OpenClawConfig;

    const support = resolveMemoryWikiAgentConfig({
      config: base,
      appConfig,
      agentId: " SUPPORT TEAM ",
    });
    const marketing = resolveMemoryWikiAgentConfig({
      config: base,
      appConfig,
      agentId: "MARKETING",
    });

    expect(base.vault.path).toBe(path.join("/Users/tester", "vaults", "wiki"));
    expect(support).toMatchObject({
      agentId: "support-team",
      vault: { scope: "agent", path: path.join(base.vault.path, "support-team") },
    });
    expect(marketing).toMatchObject({
      agentId: "marketing",
      vault: { scope: "agent", path: path.join(base.vault.path, "marketing") },
    });
    expect(support.vault.path).not.toBe(marketing.vault.path);
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

    const expectedRoot = path.join("/Users/tester", ".openclaw", "wiki");
    expect(base.vault.path).toBe(expectedRoot);
    expect(resolved.vault.path).toBe(path.join(expectedRoot, "support"));
  });

  it("rejects unsafe-local access for agent-scoped vaults", () => {
    const parsed = memoryWikiConfigSchema.safeParse?.({
      vaultMode: "unsafe-local",
      vault: { scope: "agent" },
    });

    expect(parsed?.success).toBe(false);
    if (parsed?.success === false) {
      expect(parsed.error?.issues).toContainEqual(
        expect.objectContaining({
          path: ["vaultMode"],
          message: "vaultMode=unsafe-local cannot be combined with vault.scope=agent",
        }),
      );
    }
  });

  it("rejects the global Obsidian CLI selector for agent-scoped vaults", () => {
    const parsed = memoryWikiConfigSchema.safeParse?.({
      vault: { scope: "agent" },
      obsidian: { useOfficialCli: true },
    });

    expect(parsed?.success).toBe(false);
    if (parsed?.success === false) {
      expect(parsed.error?.issues).toContainEqual(
        expect.objectContaining({
          path: ["obsidian", "useOfficialCli"],
          message: "obsidian.useOfficialCli cannot be enabled with vault.scope=agent",
        }),
      );
    }
  });
});

describe("memory-wiki manifest config schema", () => {
  it("rejects unsafe-local access for agent-scoped vaults", () => {
    const validate = compileManifestConfigSchema();

    expect(
      validate({
        vaultMode: "unsafe-local",
        vault: { scope: "agent" },
      }),
    ).toBe(false);
  });

  it("rejects the global Obsidian CLI selector for agent-scoped vaults", () => {
    const validate = compileManifestConfigSchema();

    expect(
      validate({
        vault: { scope: "agent" },
        obsidian: { useOfficialCli: true },
      }),
    ).toBe(false);
  });
});
