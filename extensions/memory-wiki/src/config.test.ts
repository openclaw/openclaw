// Memory Wiki tests cover config plugin behavior.
import fs from "node:fs";
import path from "node:path";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import {
  DEFAULT_WIKI_RENDER_MODE,
  DEFAULT_WIKI_SEARCH_BACKEND,
  DEFAULT_WIKI_SEARCH_CORPUS,
  DEFAULT_WIKI_VAULT_MODE,
  resolveDefaultMemoryWikiVaultPath,
  resolveMemoryWikiConfig,
  resolveMemoryWikiConfigForAgent,
} from "./config.js";

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

function readManifest(): {
  configContracts?: { compatibilityMigrationPaths?: string[] };
  configSchema: JsonSchemaObject;
} {
  return JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as {
    configContracts?: { compatibilityMigrationPaths?: string[] };
    configSchema: JsonSchemaObject;
  };
}

describe("resolveMemoryWikiConfig", () => {
  it("returns isolated defaults", () => {
    const config = resolveMemoryWikiConfig(undefined, { homedir: "/Users/tester" });

    expect(config.vaultMode).toBe(DEFAULT_WIKI_VAULT_MODE);
    expect(config.vault.renderMode).toBe(DEFAULT_WIKI_RENDER_MODE);
    expect(config.vault.path).toBe(resolveDefaultMemoryWikiVaultPath("/Users/tester"));
    expect(config.search.backend).toBe(DEFAULT_WIKI_SEARCH_BACKEND);
    expect(config.search.corpus).toBe(DEFAULT_WIKI_SEARCH_CORPUS);
    expect(config.context.includeCompiledDigestPrompt).toBe(false);
  });

  it("expands ~/ paths and preserves explicit modes", () => {
    const config = resolveMemoryWikiConfig(
      {
        vaultMode: "bridge",
        vault: {
          path: "~/vaults/wiki",
          renderMode: "obsidian",
        },
      },
      { homedir: "/Users/tester" },
    );

    expect(config.vaultMode).toBe("bridge");
    expect(config.vault.path).toBe(path.join("/Users/tester", "vaults", "wiki"));
    expect(config.vault.renderMode).toBe("obsidian");
  });

  it("resolves each agent into an isolated default vault while inheriting extension defaults", () => {
    const appConfig: OpenClawConfig = {
      memory: {
        extensions: {
          "memory-wiki": {
            search: {
              corpus: "memory",
            },
          },
        },
      },
      agents: {
        list: [
          { id: "research" },
          {
            id: "writer",
            memory: {
              extensions: {
                "memory-wiki": {
                  vault: {
                    path: "~/shared-writing-wiki",
                  },
                },
              },
            },
          },
        ],
      },
    };

    const research = resolveMemoryWikiConfigForAgent(appConfig, "research", {
      homedir: "/Users/tester",
    });
    const writer = resolveMemoryWikiConfigForAgent(appConfig, "writer", {
      homedir: "/Users/tester",
    });

    expect(research.vault.path).toBe("/Users/tester/.openclaw/wiki/research");
    expect(research.search.corpus).toBe("memory");
    expect(writer.vault.path).toBe("/Users/tester/shared-writing-wiki");
    expect(writer.search.corpus).toBe("memory");
  });

  it("normalizes agent ids before deriving the default vault path", () => {
    const config = resolveMemoryWikiConfigForAgent(
      {
        memory: {
          extensions: {
            "memory-wiki": {},
          },
        },
      },
      "../Research",
      { homedir: "/Users/tester" },
    );

    expect(config.vault.path).toBe("/Users/tester/.openclaw/wiki/research");
  });

  it("rejects invalid agent-scoped config instead of falling back to defaults", () => {
    expect(() =>
      resolveMemoryWikiConfigForAgent(
        {
          memory: {
            extensions: {
              "memory-wiki": {
                vault: {
                  path: "~/vaults/wiki",
                  unexpected: true,
                },
              },
            },
          },
        },
        "main",
        { homedir: "/Users/tester" },
      ),
    ).toThrow("Invalid memory-wiki config: vault: unknown config key: unexpected");
  });

  it("normalizes the bridge artifact toggle", () => {
    const canonical = resolveMemoryWikiConfig({
      bridge: {
        readMemoryArtifacts: false,
      },
    });

    expect(canonical.bridge.readMemoryArtifacts).toBe(false);
  });
});

describe("memory-wiki manifest config schema", () => {
  it("runs compatibility migration for configured agent lists", () => {
    expect(readManifest().configContracts?.compatibilityMigrationPaths).toContain("agents.list");
  });

  it("accepts the documented config shape", () => {
    const validate = compileManifestConfigSchema();
    const config = {
      vaultMode: "unsafe-local",
      vault: {
        path: "~/wiki",
        renderMode: "obsidian",
      },
      obsidian: {
        enabled: true,
        useOfficialCli: true,
      },
      bridge: {
        enabled: true,
        readMemoryArtifacts: true,
        followMemoryEvents: true,
      },
      unsafeLocal: {
        allowPrivateMemoryCoreAccess: true,
        paths: ["extensions/memory-core/src"],
      },
      search: {
        backend: "shared",
        corpus: "all",
      },
      context: {
        includeCompiledDigestPrompt: true,
      },
    };

    expect(validate(config)).toBe(true);
  });
});
