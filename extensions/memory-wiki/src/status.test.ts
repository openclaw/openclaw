import type { MemoryPluginPublicArtifact } from "openclaw/plugin-sdk/memory-host-core";
import * as memoryHost from "openclaw/plugin-sdk/memory-host-core";
import * as securityRuntime from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import * as obsidian from "./obsidian.js";
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

beforeEach(() => {
  vi.spyOn(obsidian, "probeObsidianCli").mockResolvedValue({ available: false, command: null });
});
afterEach(() => vi.restoreAllMocks());

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

function writeSource(
  page: Awaited<ReturnType<typeof createVault>>["page"],
  name: string,
  title: string,
  fields = {},
) {
  return page(`sources/${name}.md`, { pageType: "source", id: `source.${name}`, title, ...fields });
}

describe("memory wiki status and doctor", () => {
  it("warns when unsafe-local is selected without explicit private access", async () => {
    const config = statusConfig({ vaultMode: "unsafe-local" });

    vi.spyOn(securityRuntime, "pathExists").mockResolvedValue(true);
    vi.mocked(obsidian.probeObsidianCli).mockResolvedValue({
      available: true,
      command: "/usr/local/bin/obsidian",
    });
    const status = await resolveMemoryWikiStatus(config);

    expect(status.warnings.map((warning) => warning.code)).toContain("unsafe-local-disabled");
  });

  it("counts only artifacts owned by the resolved agent in agent scope", async () => {
    const config = {
      ...statusConfig({ ...bridgeOptions, vault: { scope: "agent", path: "/tmp/wiki/support" } }),
      agentId: "support",
    };
    const artifacts: MemoryPluginPublicArtifact[] = [
      publicArtifact("support", [" SUPPORT "]),
      publicArtifact("marketing", ["marketing"]),
      publicArtifact("shared", ["support", "marketing"], "daily-note"),
      publicArtifact("unknown", []),
    ];

    vi.spyOn(securityRuntime, "pathExists").mockResolvedValue(true);
    vi.spyOn(memoryHost, "listActiveMemoryPublicArtifacts").mockResolvedValue(artifacts);
    const status = await resolveMemoryWikiStatus(config, {
      appConfig: {
        agents: { entries: { support: { workspace: "/tmp/support" } } },
      },
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
    vi.spyOn(securityRuntime, "pathExists").mockResolvedValue(true);
    vi.spyOn(memoryHost, "listActiveMemoryPublicArtifacts").mockResolvedValue(artifacts);
    const options = {
      appConfig: {},
    };

    const agentStatus = await resolveMemoryWikiStatus(config, {
      ...options,
      callerAgentId: " SUPPORT ",
    });
    const operatorStatus = await resolveMemoryWikiStatus(config, options);

    expect(agentStatus).toMatchObject({
      vaultScope: "global",
      agentId: null,
      bridgePublicArtifactCount: 2,
    });
    expect(operatorStatus.bridgePublicArtifactCount).toBe(4);
  });

  it("counts source provenance while excluding malformed pages (#96125)", async () => {
    const { config, page, write } = await createVault({
      prefix: "memory-wiki-status-",
      initialize: true,
    });
    await write(
      "sources/broken.md",
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
    );
    await writeSource(page, "native", "Native Source");
    await writeSource(page, "bridge", "Bridge Source", { sourceType: "memory-bridge" });
    await writeSource(page, "events", "Event Source", { sourceType: "memory-bridge-events" });
    await writeSource(page, "unsafe", "Unsafe Source", {
      sourceType: "memory-unsafe-local",
      provenanceMode: "unsafe-local",
    });

    const status = await resolveMemoryWikiStatus(config);

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
    vi.spyOn(securityRuntime, "pathExists").mockResolvedValue(false);
    const rendered = renderMemoryWikiStatus(
      await resolveMemoryWikiStatus(
        statusConfig({
          vault: { path: "/tmp/wiki" },
          obsidian: { enabled: true, useOfficialCli: true },
        }),
      ),
    );

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
    vi.spyOn(securityRuntime, "pathExists").mockResolvedValue(true);
    vi.spyOn(memoryHost, "listActiveMemoryPublicArtifacts").mockResolvedValue([]);
    const status = await resolveMemoryWikiStatus(statusConfig(bridgeOptions), {
      appConfig: { agents: { entries: { main: { workspace: "/tmp/workspace" } } } },
    });
    expect(status.bridgePublicArtifactCount).toBe(0);
    expect(status.warnings.map((warning) => warning.code)).toContain("bridge-artifacts-missing");
    const report = buildMemoryWikiDoctorReport(status);

    expect(report.fixes.map((fix) => fix.code)).toContain("bridge-artifacts-missing");
    expect(renderMemoryWikiDoctor(report)).toContain("exports public artifacts");
  });
});
