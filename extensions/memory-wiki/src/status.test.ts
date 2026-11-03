import * as memoryHost from "openclaw/plugin-sdk/memory-host-core";
import * as securityRuntime from "openclaw/plugin-sdk/security-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as boundedWalk from "./bounded-walk.js";
import { compileMemoryWikiVault } from "./compile.js";
import * as cache from "./compiled-cache.js";
import { resolveMemoryWikiConfig } from "./config.js";
import { loadMemoryWikiVaultIdentity } from "./log.js";
import * as obsidian from "./obsidian.js";
import * as sourceSync from "./source-sync.js";
import {
  buildMemoryWikiDoctorReport,
  renderMemoryWikiDoctor,
  renderMemoryWikiStatus,
  resolveMemoryWikiStatus,
} from "./status.js";
import {
  createCompiledSnapshot,
  createMemoryWikiTestHarness,
  publishCompiledSnapshot,
} from "./test-helpers.js";
import { createWikiStatusTool } from "./tool.js";

const { createVault } = createMemoryWikiTestHarness();

beforeEach(() => {
  vi.spyOn(obsidian, "probeObsidianCli").mockResolvedValue({ available: false, command: null });
});
afterEach(() => vi.restoreAllMocks());

describe("memory wiki status and doctor", () => {
  it("warns when unsafe-local is selected without explicit private access", async () => {
    const { config } = await createVault({ config: { vaultMode: "unsafe-local" } });
    const status = await resolveMemoryWikiStatus(config);
    expect(status.warnings.map((warning) => warning.code)).toContain("unsafe-local-disabled");
  });

  it.each(["agent", "global"] as const)("preserves the %s diagnostic lifecycle", async (scope) => {
    const { config: base, page, write } = await createVault({ initialize: true });
    const config = {
      ...base,
      vault: { ...base.vault, scope },
      ...(scope === "agent" ? { agentId: "support" } : {}),
      vaultMode: "bridge" as const,
      bridge: { ...base.bridge, enabled: true },
    };
    const readStatus = () =>
      resolveMemoryWikiStatus(config, { appConfig: {}, callerAgentId: "support" });
    const unknown = async (state = "unavailable") => {
      const status = await readStatus();
      expect(status.snapshot?.state).toBe(state);
      expect(status.bridgePublicArtifactCount).toBeNull();
      expect(Object.values(status.pageCounts)).toEqual([null, null, null, null, null]);
      expect(status.warnings.map(({ code }) => code)).toEqual([
        state === "failed" ? "compiled-snapshot-unreadable" : "compiled-snapshot-missing",
      ]);
      const report = buildMemoryWikiDoctorReport(status);
      expect(report.healthy).toBe(false);
      expect(renderMemoryWikiDoctor(report)).toContain("unknown sources");
    };
    // Before publication, snapshot counts are unknown; released clients still see live counts.
    await unknown();
    for (const [name, sourceType] of [
      ["native", undefined],
      ["bridge", "memory-bridge"],
    ]) {
      await page(`sources/${name}.md`, { pageType: "source", title: name, sourceType });
    }
    await write("sources/broken.md", "---\nbroken: [\n---\n");
    const exporter = vi.spyOn(memoryHost, "listActiveMemoryPublicArtifacts").mockResolvedValue([]);
    const live = await resolveMemoryWikiStatus(config, { appConfig: {}, mode: "live" });
    const sourceCounts = { native: 1, bridge: 1, bridgeEvents: 0, unsafeLocal: 0, other: 0 };
    expect(live.pageCounts).toEqual({ entity: 0, concept: 0, source: 2, synthesis: 0, report: 0 });
    expect(live.sourceCounts).toEqual(sourceCounts);
    expect(live.bridgePublicArtifactCount).toBe(0);
    expect(live.snapshot).toBeUndefined();
    expect(live.warnings.map(({ code }) => code)).toEqual(["bridge-artifacts-missing"]);
    expect(buildMemoryWikiDoctorReport(live).healthy).toBe(false);
    // Compile publishes provenance; a cold offline read does not warm the active cache.
    for (const sourceType of ["memory-bridge-events", "memory-unsafe-local"]) {
      await page(`sources/${sourceType}.md`, { pageType: "source", title: sourceType, sourceType });
    }
    await compileMemoryWikiVault(config);
    cache.deactivateMemoryWikiCompiledCacheOwnersExcept(new Set());
    exporter.mockClear().mockRejectedValue(new Error("status must not export"));
    const walk = vi.spyOn(boundedWalk, "listMemoryWikiPagePaths");
    const cold = await readStatus();
    expect(walk).not.toHaveBeenCalled();
    expect(cold.pageCounts.source).toBe(4);
    expect(cold.sourceCounts).toEqual({ ...sourceCounts, bridgeEvents: 1, unsafeLocal: 1 });
    expect(cold.snapshot).toEqual({ state: "published", compiledAt: expect.any(String) });
    expect(await cache.loadMemoryWikiCompiledCache(config)).toBeNull();
    // A rebuilding owner serves its last publication through both status and the tool.
    const identity = await loadMemoryWikiVaultIdentity(config.vault.path);
    cache.activateMemoryWikiCompiledCacheOwner(config, identity.vaultGeneration!);
    const snapshot = createCompiledSnapshot();
    snapshot.dashboards.overview.pageCounts.source = 12_416;
    await publishCompiledSnapshot(config, snapshot);
    cache.setMemoryWikiDashboardState(config, { state: "rebuilding" });
    walk.mockClear();
    const sync = vi
      .spyOn(sourceSync, "syncMemoryWikiImportedSources")
      .mockRejectedValue(new Error("Status must not synchronize"));
    const published = await readStatus();
    const expected = {
      vaultScope: scope,
      agentId: scope === "agent" ? "support" : null,
      bridgePublicArtifactCount: null,
      snapshot: { state: "published", compiledAt: null },
      pageCounts: { source: 12_416 },
      sourceCounts: { native: null, bridge: null },
    };
    expect(published).toMatchObject(expected);
    expect((await createWikiStatusTool(config).execute("status", {})).details).toMatchObject(
      expected,
    );
    expect(renderMemoryWikiStatus(published)).toContain("live export count not checked");
    expect(renderMemoryWikiStatus(published)).toContain("last publication, not current files");
    // Quarantine must not revive the durable publication; read failures must not scan.
    cache.activateMemoryWikiCompiledCacheOwner(config, identity.vaultGeneration!, null);
    await unknown();
    vi.spyOn(cache, "loadMemoryWikiDiagnosticSnapshot").mockRejectedValue(new Error("read failed"));
    await unknown("failed");
    expect(exporter).not.toHaveBeenCalled();
    expect(walk).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("includes configuration warnings in text output", async () => {
    vi.spyOn(securityRuntime, "pathExists").mockResolvedValue(false);
    const status = await resolveMemoryWikiStatus(
      resolveMemoryWikiConfig({
        vault: { path: "/tmp/wiki" },
        obsidian: { enabled: true, useOfficialCli: true },
      }),
    );
    expect(renderMemoryWikiStatus(status)).toContain("Wiki vault has not been initialized yet.");
    expect(buildMemoryWikiDoctorReport(status).fixes.map((fix) => fix.code)).toContain(
      "obsidian-cli-missing",
    );
  });
});
