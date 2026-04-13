import fs from "node:fs";
import AjvPkg from "ajv";
import { describe, expect, it } from "vitest";
import {
  containsVaultPathTemplate,
  DEFAULT_WIKI_RENDER_MODE,
  DEFAULT_WIKI_SEARCH_BACKEND,
  DEFAULT_WIKI_SEARCH_CORPUS,
  DEFAULT_WIKI_VAULT_MODE,
  expandVaultPathTemplate,
  resolveDefaultMemoryWikiVaultPath,
  resolveMemoryWikiConfig,
  resolveMemoryWikiConfigForCtx,
} from "./config.js";

function compileManifestConfigSchema() {
  const manifest = JSON.parse(
    fs.readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"),
  ) as { configSchema: Record<string, unknown> };
  const Ajv = AjvPkg as unknown as new (opts?: object) => import("ajv").default;
  const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
  return ajv.compile(manifest.configSchema);
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
    expect(config.vault.path).toBe("/Users/tester/vaults/wiki");
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
});

describe("vault path templating", () => {
  it("detects template tokens", () => {
    expect(containsVaultPathTemplate("/Users/a/wiki")).toBe(false);
    expect(containsVaultPathTemplate("/tmp/{workspaceDir}/wiki")).toBe(true);
    expect(containsVaultPathTemplate("{agentId}")).toBe(true);
    expect(containsVaultPathTemplate("{unknownToken}")).toBe(false);
  });

  it("expands known tokens and normalizes the result", () => {
    expect(
      expandVaultPathTemplate("{workspaceDir}/wiki", {
        workspaceDir: "/tmp/workspace",
      }),
    ).toBe("/tmp/workspace/wiki");

    // `..` traversal is applied only after expansion, not to the template.
    expect(
      expandVaultPathTemplate("{workspaceDir}/../shared-wiki", {
        workspaceDir: "/tmp/workspace",
      }),
    ).toBe("/tmp/shared-wiki");
  });

  it("leaves literal paths untouched (identity fast path)", () => {
    const base = resolveMemoryWikiConfig(
      { vault: { path: "/literal/wiki" } },
      { homedir: "/Users/tester" },
    );
    const resolved = resolveMemoryWikiConfigForCtx(base, { workspaceDir: "/tmp/w" });
    expect(resolved).toBe(base);
  });

  it("returns a new config with expanded vault.path when templates are present", () => {
    const base = resolveMemoryWikiConfig(
      { vault: { path: "{workspaceDir}/wiki" } },
      { homedir: "/Users/tester" },
    );
    expect(base.vault.path).toBe("{workspaceDir}/wiki");

    const resolved = resolveMemoryWikiConfigForCtx(base, {
      workspaceDir: "/tmp/workspace",
      agentId: "agent-a",
    });
    expect(resolved).not.toBe(base);
    expect(resolved.vault.path).toBe("/tmp/workspace/wiki");
    // Unrelated fields pass through unchanged.
    expect(resolved.vaultMode).toBe(base.vaultMode);
    expect(resolved.vault.renderMode).toBe(base.vault.renderMode);
  });

  it("supports agentId templating and leaves unresolved tokens as empty strings", () => {
    const base = resolveMemoryWikiConfig(
      { vault: { path: "/tmp/{agentId}/{sessionKey}/wiki" } },
      { homedir: "/Users/tester" },
    );
    const resolved = resolveMemoryWikiConfigForCtx(base, { agentId: "abc" });
    expect(resolved.vault.path).toBe("/tmp/abc/wiki");
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
