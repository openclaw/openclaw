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

  it.each(["agent", "global"] as const)("scopes %s vault status to the caller", async (scope) => {
    const config = {
      ...statusConfig({ ...bridgeOptions, vault: { scope, path: "/tmp/wiki/support" } }),
      ...(scope === "agent" ? { agentId: "support" } : {}),
    };
    const artifacts: MemoryPluginPublicArtifact[] = [
      publicArtifact("support", [" SUPPORT "]),
      publicArtifact("marketing", ["marketing"]),
      publicArtifact("shared", ["support", "marketing"], "daily-note"),
      publicArtifact("unknown", []),
    ];
    vi.spyOn(securityRuntime, "pathExists").mockResolvedValue(true);
    vi.spyOn(memoryHost, "listActiveMemoryPublicArtifacts").mockResolvedValue(artifacts);
    const options = {
      appConfig: {
        agents: { entries: { support: { workspace: "/tmp/support" } } },
      },
    };
    expect(
      await resolveMemoryWikiStatus(config, {
        ...options,
        ...(scope === "global" ? { callerAgentId: " SUPPORT " } : {}),
      }),
    ).toMatchObject({
      vaultScope: scope,
      agentId: scope === "agent" ? "support" : null,
      bridgePublicArtifactCount: 2,
    });
    expect((await resolveMemoryWikiStatus(config, options)).bridgePublicArtifactCount).toBe(
      scope === "agent" ? 2 : 4,
    );
  });

  it("counts source provenance while excluding malformed pages (#96125)", async () => {
    const { config, page, write } = await createVault({
      prefix: "memory-wiki-status-",
      initialize: true,
    });
    await write(
      "sources/broken.md",
      '---\npageType: source\nid: source.broken\nsourceIds:\n  - **MEMORY.md line 235**:"some quoted, value"\n---\n\n# Broken',
    );
    for (const [name, fields] of [
      ["native", {}],
      ["bridge", { sourceType: "memory-bridge" }],
      ["events", { sourceType: "memory-bridge-events" }],
      ["unsafe", { sourceType: "memory-unsafe-local", provenanceMode: "unsafe-local" }],
    ] as const) {
      await page(`sources/${name}.md`, {
        pageType: "source",
        id: `source.${name}`,
        title: name,
        ...fields,
      });
    }

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
