import fs from "node:fs";
import path from "node:path";
import AjvPkg from "ajv";
import type { JsonSchemaObject } from "openclaw/plugin-sdk/config-schema";
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
  ) as { configSchema: JsonSchemaObject };
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

  it("throws when a compound template leaves a known token unresolved", () => {
    // Returning `/tmp/abc/{sessionKey}/wiki` would not prevent downstream
    // write flows: `fs.mkdir(path, { recursive: true })` in writeWikiPage
    // happily creates a literal `{sessionKey}` subdirectory under the
    // partially-resolved parent and mixes data across sessions. Throwing at
    // expansion time fails the tool invocation before any filesystem side
    // effect.
    const base = resolveMemoryWikiConfig(
      { vault: { path: "/tmp/{agentId}/{sessionKey}/wiki" } },
      { homedir: "/Users/tester" },
    );
    expect(() => resolveMemoryWikiConfigForCtx(base, { agentId: "abc" })).toThrow(
      /unresolved placeholder\(s\) \{sessionKey\}/,
    );
  });

  it("throws on an entirely unresolved template rather than returning a CWD-relative path", () => {
    // Without the throw, `{workspaceDir}/wiki` invoked with an empty context
    // is returned as-is and `fs.mkdir(..., { recursive: true })` creates a
    // `./{workspaceDir}/wiki` tree under process.cwd(). Tool callers then
    // write into a shared CWD-backed vault.
    const base = resolveMemoryWikiConfig(
      { vault: { path: "{workspaceDir}/wiki" } },
      { homedir: "/Users/tester" },
    );
    expect(() => resolveMemoryWikiConfigForCtx(base, {})).toThrow(
      /unresolved placeholder\(s\) \{workspaceDir\}/,
    );
  });

  it("throws on unresolved tokens even when `..` is present so `path.normalize` cannot eat the placeholder", () => {
    // `path.normalize("{workspaceDir}/../wiki")` returns `"wiki"`. Throwing
    // before normalization guarantees the misconfiguration surfaces instead
    // of silently collapsing to a CWD-relative path that downstream writes
    // would succeed against.
    expect(() => expandVaultPathTemplate("{workspaceDir}/../wiki", {})).toThrow(
      /unresolved placeholder\(s\) \{workspaceDir\}/,
    );

    // Once the token is resolved, normalization is safe and collapses `..`
    // against real segments as usual.
    expect(
      expandVaultPathTemplate("{workspaceDir}/../wiki", {
        workspaceDir: "/tmp/workspace",
      }),
    ).toBe("/tmp/wiki");
  });

  it("throws when unknown placeholders (typos) remain after expansion of known tokens", () => {
    // A typo like `{tenant}` is not a known token, so the replace step
    // leaves it in place. Normalizing `/tmp/workspace/{tenant}/../wiki`
    // collapses to `/tmp/workspace/wiki` and silently breaches tenant
    // isolation. Throwing surfaces the config error at tool-invocation time.
    expect(() =>
      expandVaultPathTemplate("{workspaceDir}/{tenant}/../wiki", {
        workspaceDir: "/tmp/workspace",
      }),
    ).toThrow(/unresolved placeholder\(s\) \{tenant\}/);
  });

  it("throws on paths whose only placeholder is unknown (no known tokens ever trigger expansion)", () => {
    // Regression: the prior early-return gated on the narrow
    // known-tokens regex, so a path like `{tenant}/wiki` exited
    // `expandVaultPathTemplate` before the unresolved-placeholder guard
    // could fire, returning the literal string. Downstream writes via
    // `fs.mkdir(..., { recursive: true })` would then create a literal
    // `{tenant}/wiki` directory under CWD.
    expect(() => expandVaultPathTemplate("{tenant}/wiki", { workspaceDir: "/tmp/w" })).toThrow(
      /unresolved placeholder\(s\) \{tenant\}/,
    );

    // A case-typo of a known token (`{workspaceDIR}` instead of
    // `{workspaceDir}`) is indistinguishable from an unknown placeholder
    // at this layer and must throw for the same reason.
    expect(() =>
      expandVaultPathTemplate("{workspaceDIR}/wiki", { workspaceDir: "/tmp/w" }),
    ).toThrow(/unresolved placeholder\(s\) \{workspaceDIR\}/);
  });

  it("propagates the unknown-only throw through resolveMemoryWikiConfigForCtx's identity fast path", () => {
    // The identity fast path previously used the narrow known-tokens
    // regex, so a config with only unknown placeholders would return the
    // base config unchanged — tool factories would then use the literal
    // `{tenant}/wiki` as the resolved vault path.
    const base = resolveMemoryWikiConfig(
      { vault: { path: "{tenant}/wiki" } },
      { homedir: "/Users/tester" },
    );
    expect(() => resolveMemoryWikiConfigForCtx(base, { workspaceDir: "/tmp/w" })).toThrow(
      /unresolved placeholder\(s\) \{tenant\}/,
    );
  });

  it("lists all unresolved placeholders in the error message, deduplicated and sorted", () => {
    // Multiple missing tokens should be reported together so the operator
    // can fix the config in one pass instead of re-running the tool four
    // times. The list is deduplicated (`{sessionKey}` appearing twice shows
    // up once) and sorted for stable error messages.
    expect(() =>
      expandVaultPathTemplate("{workspaceDir}/{sessionKey}/{agentId}/{sessionKey}/wiki", {}),
    ).toThrow(/\{agentId\}, \{sessionKey\}, \{workspaceDir\}/);
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
