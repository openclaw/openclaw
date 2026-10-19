import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryPluginPublicArtifact } from "openclaw/plugin-sdk/memory-host-core";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { resolveMemoryWikiConfig } from "./config.js";
import { renderWikiMarkdown } from "./markdown.js";
import {
  buildMemoryWikiDoctorReport,
  renderMemoryWikiDoctor,
  renderMemoryWikiStatus,
  resolveMemoryWikiStatus,
} from "./status.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

function statusConfig(config: Parameters<typeof resolveMemoryWikiConfig>[0]) {
  return resolveMemoryWikiConfig(config, { homedir: "/Users/tester" });
}

const bridgeOptions = {
  vaultMode: "bridge",
  bridge: { enabled: true, readMemoryArtifacts: true },
} as const;

const statusDeps = { pathExists: async () => true, resolveCommand: async () => null };

function publicArtifact(
  workspace: string,
  agentIds: string[],
  kind: "memory-root" | "daily-note" = "memory-root",
): MemoryPluginPublicArtifact {
  const relativePath = kind === "daily-note" ? "memory/2026-07-09.md" : "MEMORY.md";
  return {
    kind,
    workspaceDir: "/tmp/" + workspace,
    relativePath,
    absolutePath: "/tmp/" + workspace + "/" + relativePath,
    agentIds,
    contentType: "markdown",
  };
}

async function writeSource(rootDir: string, name: string, title: string, fields = {}) {
  await fs.writeFile(
    path.join(rootDir, "sources", name + ".md"),
    renderWikiMarkdown({
      frontmatter: { pageType: "source", id: "source." + name, title, ...fields },
      body: "# " + title + "\n",
    }),
    "utf8",
  );
}

async function resolveBridgeMissingArtifactsStatus() {
  const config = statusConfig(bridgeOptions);

  return resolveMemoryWikiStatus(config, {
    appConfig: {
      agents: {
        entries: { main: { workspace: "/tmp/workspace" } },
      },
    } as OpenClawConfig,
    listPublicArtifacts: async () => [],
    ...statusDeps,
  });
}

async function resolveMissingVaultStatus() {
  const config = statusConfig({
    vault: { path: "/tmp/wiki" },
    obsidian: { enabled: true, useOfficialCli: true },
  });

  return resolveMemoryWikiStatus(config, {
    pathExists: async () => false,
    resolveCommand: async () => null,
  });
}

describe("memory wiki status and doctor", () => {
  it("warns when unsafe-local is selected without explicit private access", async () => {
    const config = statusConfig({
      vaultMode: "unsafe-local",
    });

    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => true,
      resolveCommand: async () => "/usr/local/bin/obsidian",
    });

    expect(status.warnings.map((warning) => warning.code)).toContain("unsafe-local-disabled");
  });

  it("counts only artifacts owned by the resolved agent in agent scope", async () => {
    const unresolvedConfig = statusConfig({
      ...bridgeOptions,
      vault: { scope: "agent", path: "/tmp/wiki/support" },
    });
    const config = { ...unresolvedConfig, agentId: "support" };
    const artifacts: MemoryPluginPublicArtifact[] = [
      publicArtifact("support", [" SUPPORT "]),
      publicArtifact("marketing", ["marketing"]),
      publicArtifact("shared", ["support", "marketing"], "daily-note"),
      publicArtifact("unknown", []),
    ];

    const status = await resolveMemoryWikiStatus(config, {
      appConfig: {
        agents: { entries: { support: { workspace: "/tmp/support" } } },
      },
      listPublicArtifacts: async () => artifacts,
      ...statusDeps,
    });

    expect(status).toMatchObject({
      vaultScope: "agent",
      agentId: "support",
      bridgePublicArtifactCount: 2,
    });
  });

  it("scopes global-vault status metadata when called by an agent tool", async () => {
    const config = statusConfig(bridgeOptions);
    const artifacts: MemoryPluginPublicArtifact[] = [
      publicArtifact("support", ["support"]),
      publicArtifact("marketing", ["marketing"]),
      publicArtifact("shared", ["support", "marketing"], "daily-note"),
      publicArtifact("legacy", []),
    ];
    const deps = {
      appConfig: {} as OpenClawConfig,
      listPublicArtifacts: async () => artifacts,
      ...statusDeps,
    };

    const agentStatus = await resolveMemoryWikiStatus(config, {
      ...deps,
      callerAgentId: " SUPPORT ",
    });
    const operatorStatus = await resolveMemoryWikiStatus(config, deps);

    expect(agentStatus).toMatchObject({
      vaultScope: "global",
      agentId: null,
      bridgePublicArtifactCount: 2,
    });
    expect(operatorStatus.bridgePublicArtifactCount).toBe(4);
  });

  it("rejects status for an unresolved agent-scoped config", async () => {
    const config = statusConfig({ vault: { scope: "agent", path: "/tmp/wiki/support" } });

    await expect(resolveMemoryWikiStatus(config, statusDeps)).rejects.toThrow(
      "Memory Wiki agent-scoped vault requires a resolved agent id",
    );
  });

  it("excludes malformed pages from status counts (#96125)", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-status-invalid-frontmatter-",
      initialize: true,
    });
    await fs.writeFile(
      path.join(rootDir, "sources", "broken.md"),
      [
        "---",
        "pageType: source",
        "id: source.broken",
        "sourceIds:",
        '  - **MEMORY.md line 235**:"some quoted, value"',
        "---",
        "",
        "# Broken",
      ].join("\n"),
      "utf8",
    );
    await writeSource(rootDir, "healthy", "Healthy");

    const status = await resolveMemoryWikiStatus(config, statusDeps);

    expect(status.pageCounts.source).toBe(1);
    expect(status.sourceCounts.native).toBe(1);
  });

  it("counts source provenance from the vault", async () => {
    const { rootDir, config } = await createVault({
      prefix: "memory-wiki-status-",
      initialize: true,
    });
    await writeSource(rootDir, "native", "Native Source");
    await writeSource(rootDir, "bridge", "Bridge Source", { sourceType: "memory-bridge" });
    await writeSource(rootDir, "events", "Event Source", { sourceType: "memory-bridge-events" });
    await writeSource(rootDir, "unsafe", "Unsafe Source", {
      sourceType: "memory-unsafe-local",
      provenanceMode: "unsafe-local",
    });

    const status = await resolveMemoryWikiStatus(config, statusDeps);

    expect(status.pageCounts.source).toBe(4);
    expect(status.sourceCounts).toEqual({
      native: 1,
      bridge: 1,
      bridgeEvents: 1,
      unsafeLocal: 1,
      other: 0,
    });
  });

  it("includes warnings in the text output", async () => {
    const rendered = renderMemoryWikiStatus(await resolveMissingVaultStatus());

    expect(rendered).toContain("Wiki vault mode: isolated");
    expect(rendered).toContain("Vault scope: global");
    expect(rendered).toContain("Pages: 0 sources, 0 entities, 0 concepts, 0 syntheses, 0 reports");
    expect(rendered).toContain(
      "Source provenance: 0 native, 0 bridge, 0 bridge-events, 0 unsafe-local, 0 other",
    );
    expect(rendered).toContain("Warnings:");
    expect(rendered).toContain("Wiki vault has not been initialized yet.");
  });

  it("suggests bridge fixes when no public artifacts are exported", async () => {
    const status = await resolveBridgeMissingArtifactsStatus();
    expect(status.bridgePublicArtifactCount).toBe(0);
    expect(status.warnings.map((warning) => warning.code)).toContain("bridge-artifacts-missing");
    const report = buildMemoryWikiDoctorReport(status);

    expect(report.fixes.map((fix) => fix.code)).toContain("bridge-artifacts-missing");
    expect(renderMemoryWikiDoctor(report)).toContain("exports public artifacts");
  });
});
