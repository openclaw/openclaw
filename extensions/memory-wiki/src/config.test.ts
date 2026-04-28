import fs from "node:fs";
import path from "node:path";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIKI_RENDER_MODE,
  DEFAULT_WIKI_SEARCH_BACKEND,
  DEFAULT_WIKI_SEARCH_CORPUS,
  DEFAULT_WIKI_VAULT_MODE,
  resolveDefaultMemoryWikiVaultPath,
  resolveMemoryWikiConfig,
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

  it("normalizes the bridge artifact toggle", () => {
    const canonical = resolveMemoryWikiConfig({
      bridge: {
        readMemoryArtifacts: false,
      },
    });

    expect(canonical.bridge.readMemoryArtifacts).toBe(false);
  });

  it("scopes vault path to instanceId when set (Phase D2.1)", () => {
    const config = resolveMemoryWikiConfig(undefined, {
      homedir: "/Users/tester",
      instanceId: "acme-corp",
    });
    expect(config.vault.path).toBe("/Users/tester/.openclaw/wiki/acme-corp");
  });

  it("falls back to main vault when instanceId is absent (Tier A)", () => {
    const config = resolveMemoryWikiConfig(undefined, { homedir: "/Users/tester" });
    expect(config.vault.path).toBe("/Users/tester/.openclaw/wiki/main");
  });

  it("rejects path-traversal instanceIds and falls back to main", () => {
    const config = resolveMemoryWikiConfig(undefined, {
      homedir: "/Users/tester",
      instanceId: "../evil",
    });
    expect(config.vault.path).toBe("/Users/tester/.openclaw/wiki/main");
  });

  it("respects an explicit vault.path override even when instanceId is set", () => {
    const config = resolveMemoryWikiConfig(
      { vault: { path: "~/custom/wiki" } },
      { homedir: "/Users/tester", instanceId: "acme-corp" },
    );
    expect(config.vault.path).toBe("/Users/tester/custom/wiki");
  });
});

describe("resolveDefaultMemoryWikiVaultPath", () => {
  it("returns the main vault when no instanceId is given", () => {
    expect(resolveDefaultMemoryWikiVaultPath("/Users/tester")).toBe(
      "/Users/tester/.openclaw/wiki/main",
    );
  });

  it("scopes to the instanceId when valid", () => {
    expect(resolveDefaultMemoryWikiVaultPath("/Users/tester", "bench-prod-01")).toBe(
      "/Users/tester/.openclaw/wiki/bench-prod-01",
    );
  });

  it("falls back to main on invalid instanceId", () => {
    expect(resolveDefaultMemoryWikiVaultPath("/Users/tester", "has/slash")).toBe(
      "/Users/tester/.openclaw/wiki/main",
    );
    expect(resolveDefaultMemoryWikiVaultPath("/Users/tester", "")).toBe(
      "/Users/tester/.openclaw/wiki/main",
    );
  });
});

describe("memory-wiki manifest config schema", () => {
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
