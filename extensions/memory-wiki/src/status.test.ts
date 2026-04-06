import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveMemoryWikiConfig } from "./config.js";
import { renderWikiMarkdown } from "./markdown.js";
import {
  buildMemoryWikiDoctorReport,
  renderMemoryWikiDoctor,
  renderMemoryWikiStatus,
  resolveMemoryWikiStatus,
} from "./status.js";

describe("resolveMemoryWikiStatus", () => {
  it("reports missing vault and missing requested obsidian cli", async () => {
    const config = resolveMemoryWikiConfig(
      {
        vault: { path: "/tmp/wiki" },
        obsidian: { enabled: true, useOfficialCli: true },
      },
      { homedir: "/Users/tester" },
    );

    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => false,
      resolveCommand: async () => null,
    });

    expect(status.vaultExists).toBe(false);
    expect(status.obsidianCli.requested).toBe(true);
    expect(status.warnings.map((warning) => warning.code)).toEqual([
      "vault-missing",
      "obsidian-cli-missing",
    ]);
    expect(status.sourceCounts).toEqual({
      native: 0,
      bridge: 0,
      bridgeEvents: 0,
      unsafeLocal: 0,
      other: 0,
    });
  });

  it("warns when unsafe-local is selected without explicit private access", async () => {
    const config = resolveMemoryWikiConfig(
      {
        vaultMode: "unsafe-local",
      },
      { homedir: "/Users/tester" },
    );

    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => true,
      resolveCommand: async () => "/usr/local/bin/obsidian",
    });

    expect(status.warnings.map((warning) => warning.code)).toContain("unsafe-local-disabled");
  });

  it("counts source provenance from the vault", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-status-"));
    await fs.mkdir(path.join(rootDir, "sources"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "entities"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "concepts"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "syntheses"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "reports"), { recursive: true });
    await fs.writeFile(
      path.join(rootDir, "sources", "native.md"),
      renderWikiMarkdown({
        frontmatter: { pageType: "source", id: "source.native", title: "Native Source" },
        body: "# Native Source\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "bridge.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.bridge",
          title: "Bridge Source",
          sourceType: "memory-bridge",
        },
        body: "# Bridge Source\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "events.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.events",
          title: "Event Source",
          sourceType: "memory-bridge-events",
        },
        body: "# Event Source\n",
      }),
      "utf8",
    );
    await fs.writeFile(
      path.join(rootDir, "sources", "unsafe.md"),
      renderWikiMarkdown({
        frontmatter: {
          pageType: "source",
          id: "source.unsafe",
          title: "Unsafe Source",
          sourceType: "memory-unsafe-local",
          provenanceMode: "unsafe-local",
        },
        body: "# Unsafe Source\n",
      }),
      "utf8",
    );

    const config = resolveMemoryWikiConfig(
      { vault: { path: rootDir } },
      { homedir: "/Users/tester" },
    );
    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => true,
      resolveCommand: async () => null,
    });

    expect(status.pageCounts.source).toBe(4);
    expect(status.sourceCounts).toEqual({
      native: 1,
      bridge: 1,
      bridgeEvents: 1,
      unsafeLocal: 1,
      other: 0,
    });

    await fs.rm(rootDir, { recursive: true, force: true });
  });
});

describe("renderMemoryWikiStatus", () => {
  it("includes warnings in the text output", () => {
    const rendered = renderMemoryWikiStatus({
      vaultMode: "isolated",
      renderMode: "native",
      vaultPath: "/tmp/wiki",
      vaultExists: false,
      bridge: {
        enabled: false,
        readMemoryCore: true,
        indexDreamReports: true,
        indexDailyNotes: true,
        indexMemoryRoot: true,
        followMemoryEvents: true,
      },
      obsidianCli: {
        enabled: true,
        requested: true,
        available: false,
        command: null,
      },
      unsafeLocal: {
        allowPrivateMemoryCoreAccess: false,
        pathCount: 0,
      },
      pageCounts: {
        source: 0,
        entity: 0,
        concept: 0,
        synthesis: 0,
        report: 0,
      },
      sourceCounts: {
        native: 0,
        bridge: 0,
        bridgeEvents: 0,
        unsafeLocal: 0,
        other: 0,
      },
      warnings: [{ code: "vault-missing", message: "Wiki vault has not been initialized yet." }],
    });

    expect(rendered).toContain("Wiki vault mode: isolated");
    expect(rendered).toContain("Pages: 0 sources, 0 entities, 0 concepts, 0 syntheses, 0 reports");
    expect(rendered).toContain(
      "Source provenance: 0 native, 0 bridge, 0 bridge-events, 0 unsafe-local, 0 other",
    );
    expect(rendered).toContain("Warnings:");
    expect(rendered).toContain("Wiki vault has not been initialized yet.");
  });
});

describe("memory wiki doctor", () => {
  it("builds actionable fixes from status warnings", async () => {
    const config = resolveMemoryWikiConfig(
      {
        vault: { path: "/tmp/wiki" },
        obsidian: { enabled: true, useOfficialCli: true },
      },
      { homedir: "/Users/tester" },
    );

    const status = await resolveMemoryWikiStatus(config, {
      pathExists: async () => false,
      resolveCommand: async () => null,
    });
    const report = buildMemoryWikiDoctorReport(status);
    const rendered = renderMemoryWikiDoctor(report);

    expect(report.healthy).toBe(false);
    expect(report.warningCount).toBe(2);
    expect(report.fixes.map((fix) => fix.code)).toEqual(["vault-missing", "obsidian-cli-missing"]);
    expect(rendered).toContain("Suggested fixes:");
    expect(rendered).toContain("openclaw wiki init");
  });
});
