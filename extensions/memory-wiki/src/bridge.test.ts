import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
import {
  clearMemoryPluginState,
  type MemoryPluginPublicArtifact,
  registerMemoryCapability,
} from "openclaw/plugin-sdk/memory-host-core";
import { root } from "openclaw/plugin-sdk/security-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { syncMemoryWikiBridgeSources } from "./bridge.js";
import type { MemoryWikiPluginConfig } from "./config.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createVault } = createMemoryWikiTestHarness();

describe("syncMemoryWikiBridgeSources", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-bridge-suite-"));
  });

  afterAll(async () => {
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    __setFsSafeTestHooksForTest(undefined);
    vi.restoreAllMocks();
    clearMemoryPluginState();
  });

  function nextCaseRoot(name: string): string {
    return path.join(fixtureRoot, `case-${caseId++}-${name}`);
  }

  async function createBridgeWorkspace(name: string): Promise<string> {
    const workspaceDir = nextCaseRoot(name);
    await fs.mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  function createBridgeVault(name: string, config: MemoryWikiPluginConfig = {}) {
    return createVault({
      rootDir: nextCaseRoot(name),
      config: {
        ...config,
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexMemoryRoot: true,
          ...config.bridge,
        },
      },
    });
  }

  function artifact(
    workspaceDir: string,
    relativePath = "MEMORY.md",
    kind: MemoryPluginPublicArtifact["kind"] = "memory-root",
    agentIds = ["main"],
  ): MemoryPluginPublicArtifact {
    return {
      kind,
      workspaceDir,
      relativePath,
      absolutePath: path.join(workspaceDir, relativePath),
      agentIds,
      contentType: kind === "event-log" ? "json" : "markdown",
    };
  }

  const appFor = (workspaceDir: string): OpenClawConfig => ({
    agents: { entries: { main: { workspace: workspaceDir } } },
  });

  function registerBridgeArtifacts(artifacts: MemoryPluginPublicArtifact[]) {
    registerMemoryCapability("memory-core", {
      publicArtifacts: {
        async listArtifacts() {
          return artifacts;
        },
      },
    });
  }

  async function createImportedMemory(name: string) {
    const workspaceDir = await createBridgeWorkspace(`${name}-workspace`);
    const { rootDir: vaultDir, config } = await createBridgeVault(`${name}-vault`);
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(memoryPath, "# Durable Memory\n", "utf8");
    registerBridgeArtifacts([artifact(workspaceDir)]);
    const appConfig = appFor(workspaceDir);
    const first = await syncMemoryWikiBridgeSources({ config, appConfig });
    const pageAbsPath = path.join(vaultDir, first.pagePaths[0] ?? "");
    return { workspaceDir, config, memoryPath, appConfig, pageAbsPath };
  }

  it("imports public memory artifacts and stays idempotent across reruns", async () => {
    const workspaceDir = await createBridgeWorkspace("workspace");
    const { rootDir: vaultDir, config } = await createBridgeVault("vault", {
      bridge: { indexDailyNotes: true, indexDreamReports: true },
    });

    await fs.mkdir(path.join(workspaceDir, "memory", "dreaming"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Durable Memory\n", "utf8");
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-05.md"),
      "# Daily Note\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(workspaceDir, "memory", "dreaming", "2026-04-05.md"),
      "# Dream Report\n",
      "utf8",
    );
    registerBridgeArtifacts([
      artifact(workspaceDir, "MEMORY.md", "memory-root"),
      artifact(workspaceDir, "memory/2026-04-05.md", "daily-note"),
      artifact(workspaceDir, "memory/dreaming/2026-04-05.md", "dream-report"),
    ]);

    const appConfig = appFor(workspaceDir);

    const first = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(first).toMatchObject({
      workspaces: 1,
      artifactCount: 3,
      importedCount: 3,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
    });
    expect(first.pagePaths).toHaveLength(3);

    const sourcePages = await fs.readdir(path.join(vaultDir, "sources"));
    expect(
      sourcePages.reduce((count, name) => count + (name.startsWith("bridge-") ? 1 : 0), 0),
    ).toBe(3);

    const memoryPage = await fs.readFile(path.join(vaultDir, first.pagePaths[0] ?? ""), "utf8");
    expect(memoryPage).toContain("sourceType: memory-bridge");
    expect(memoryPage).toContain("## Bridge Source");

    const retainedPages = new Set(first.pagePaths.map((pagePath) => path.join(vaultDir, pagePath)));
    const openedPages: string[] = [];
    __setFsSafeTestHooksForTest({
      beforeOpen: (filePath) => {
        if (retainedPages.has(filePath)) {
          openedPages.push(filePath);
        }
      },
    });
    const readFile = vi.spyOn(fs, "readFile");
    const second = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(second).toMatchObject({
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 3,
      removedCount: 0,
    });
    expect(
      readFile.mock.calls.some(
        ([filePath]) => typeof filePath === "string" && filePath.startsWith(vaultDir),
      ),
    ).toBe(false);
    expect(openedPages).toEqual([]);
    // Vault pages are read through fs-safe handles; prove the observer sees those reads.
    await (await root(vaultDir)).readText(first.pagePaths[0] ?? "");
    expect(openedPages).toEqual([path.join(vaultDir, first.pagePaths[0] ?? "")]);

    const logLines = (await fs.readFile(path.join(vaultDir, ".openclaw-wiki", "log.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(logLines).toHaveLength(3);
  });

  it("skips generated artifacts from its own vault", async () => {
    const workspaceDir = await createBridgeWorkspace("self-import-workspace");
    const vaultDir = path.join(workspaceDir, "memory", "wiki");
    const { config } = await createVault({
      rootDir: vaultDir,
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexDailyNotes: true,
        },
      },
    });

    const dailyNotePath = path.join(workspaceDir, "memory", "2026-06-22.md");
    const generatedSourcePath = path.join(
      vaultDir,
      "sources",
      "bridge-workspace-remote-memory-daily-old.md",
    );
    const generatedIndexPath = path.join(vaultDir, "index.md");
    await fs.mkdir(path.dirname(dailyNotePath), { recursive: true });
    await fs.mkdir(path.dirname(generatedSourcePath), { recursive: true });
    await fs.writeFile(dailyNotePath, "# Daily Note\n", "utf8");
    await fs.writeFile(generatedSourcePath, "# Previously Imported Source\n", "utf8");
    await fs.writeFile(generatedIndexPath, "# Generated Index\n", "utf8");

    registerBridgeArtifacts([
      artifact(workspaceDir, "memory/2026-06-22.md", "daily-note"),
      artifact(
        workspaceDir,
        "memory/wiki/sources/bridge-workspace-remote-memory-daily-old.md",
        "daily-note",
      ),
      artifact(workspaceDir, "memory/wiki/index.md", "daily-note"),
    ]);

    const appConfig = appFor(workspaceDir);

    const result = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(result).toMatchObject({ artifactCount: 1, importedCount: 1 });
    expect(result.pagePaths).toHaveLength(1);
    expect(result.pagePaths[0]).not.toContain("memory-wiki-sources");
    const sourcePages = await fs.readdir(path.join(vaultDir, "sources"));
    expect(sourcePages.filter((name) => name.startsWith("bridge-"))).toHaveLength(2);
    expect(sourcePages.filter((name) => name.includes("memory-wiki-sources-"))).toEqual([]);
  });

  it("imports bridge artifacts from legacy providers without agent ids", async () => {
    const workspaceDir = await createBridgeWorkspace("legacy-agentids-workspace");
    const { rootDir: vaultDir, config } = await createBridgeVault("legacy-agentids-vault");
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(memoryPath, "# Durable Memory\n", "utf8");
    registerBridgeArtifacts([
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "MEMORY.md",
        absolutePath: memoryPath,
        contentType: "markdown",
      } as Omit<MemoryPluginPublicArtifact, "agentIds"> as MemoryPluginPublicArtifact,
    ]);

    const appConfig = appFor(workspaceDir);

    const result = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(result).toMatchObject({ importedCount: 1, artifactCount: 1 });
    const page = await fs.readFile(path.join(vaultDir, result.pagePaths[0] ?? ""), "utf8");
    expect(page).toContain("# Memory Bridge: MEMORY");
    expect(page).toContain("- Agents: unknown");
  });

  it("isolates agent-scoped bridge artifacts while preserving shared ownership", async () => {
    const supportWorkspace = await createBridgeWorkspace("support-workspace");
    const marketingWorkspace = await createBridgeWorkspace("marketing-workspace");
    const sharedWorkspace = await createBridgeWorkspace("shared-workspace");
    const unknownWorkspace = await createBridgeWorkspace("unknown-workspace");
    const supportMemory = path.join(supportWorkspace, "MEMORY.md");
    const marketingMemory = path.join(marketingWorkspace, "MEMORY.md");
    const sharedMemory = path.join(sharedWorkspace, "MEMORY.md");
    const unknownMemory = path.join(unknownWorkspace, "MEMORY.md");
    await fs.writeFile(supportMemory, "# Support Sentinel\n", "utf8");
    await fs.writeFile(marketingMemory, "# Marketing Sentinel\n", "utf8");
    await fs.writeFile(sharedMemory, "# Shared Sentinel\n", "utf8");
    await fs.writeFile(unknownMemory, "# Unknown Sentinel\n", "utf8");

    registerBridgeArtifacts([
      artifact(supportWorkspace, "MEMORY.md", "memory-root", [" SUPPORT "]),
      artifact(marketingWorkspace, "MEMORY.md", "memory-root", ["marketing"]),
      artifact(sharedWorkspace, "MEMORY.md", "memory-root", ["support", "MARKETING"]),
      {
        kind: "memory-root",
        workspaceDir: unknownWorkspace,
        relativePath: "MEMORY.md",
        absolutePath: unknownMemory,
        contentType: "markdown",
      } as Omit<MemoryPluginPublicArtifact, "agentIds"> as MemoryPluginPublicArtifact,
    ]);

    const { rootDir: supportVault, config: unresolvedSupportConfig } = await createBridgeVault(
      "support-vault",
      { vault: { scope: "agent" } },
    );
    const { rootDir: marketingVault, config: unresolvedMarketingConfig } = await createBridgeVault(
      "marketing-vault",
      { vault: { scope: "agent" } },
    );
    const supportConfig = { ...unresolvedSupportConfig, agentId: "support" };
    const marketingConfig = { ...unresolvedMarketingConfig, agentId: "marketing" };
    const appConfig: OpenClawConfig = {
      agents: {
        entries: {
          support: { workspace: supportWorkspace },
          marketing: { workspace: marketingWorkspace },
        },
      },
    };

    const supportResult = await syncMemoryWikiBridgeSources({ config: supportConfig, appConfig });
    const marketingResult = await syncMemoryWikiBridgeSources({
      config: marketingConfig,
      appConfig,
    });

    expect(supportResult).toMatchObject({ artifactCount: 2, importedCount: 2, workspaces: 2 });
    expect(marketingResult).toMatchObject({ artifactCount: 2, importedCount: 2, workspaces: 2 });
    const supportPages = await Promise.all(
      supportResult.pagePaths.map((pagePath) =>
        fs.readFile(path.join(supportVault, pagePath), "utf8"),
      ),
    );
    const marketingPages = await Promise.all(
      marketingResult.pagePaths.map((pagePath) =>
        fs.readFile(path.join(marketingVault, pagePath), "utf8"),
      ),
    );
    expect(supportPages.join("\n")).toContain("Support Sentinel");
    expect(supportPages.join("\n")).toContain("Shared Sentinel");
    expect(supportPages.join("\n")).not.toContain("Marketing Sentinel");
    expect(supportPages.join("\n")).not.toContain("Unknown Sentinel");
    expect(marketingPages.join("\n")).toContain("Marketing Sentinel");
    expect(marketingPages.join("\n")).toContain("Shared Sentinel");
    expect(marketingPages.join("\n")).not.toContain("Support Sentinel");
    expect(marketingPages.join("\n")).not.toContain("Unknown Sentinel");
  });

  it("rejects an unresolved agent-scoped bridge config", async () => {
    const { config } = await createVault({
      rootDir: nextCaseRoot("unresolved-agent-vault"),
      config: { vault: { scope: "agent" } },
    });

    await expect(syncMemoryWikiBridgeSources({ config })).rejects.toThrow(
      "Memory Wiki agent-scoped vault requires a resolved agent id",
    );
  });

  it("imports the public memory event journal when followMemoryEvents is enabled", async () => {
    const workspaceDir = await createBridgeWorkspace("events-workspace");
    const { rootDir: vaultDir, config } = await createBridgeVault("events-vault", {
      bridge: { followMemoryEvents: true },
    });

    const eventContent = '{"type":"memory.recall.recorded"}\n';
    const eventPath = path.join(workspaceDir, "memory", "events", "memory-host-events.jsonl");
    await fs.mkdir(path.dirname(eventPath), { recursive: true });
    await fs.writeFile(eventPath, eventContent, "utf8");
    registerBridgeArtifacts([
      artifact(workspaceDir, "memory/events/memory-host-events.jsonl", "event-log"),
    ]);

    const appConfig = appFor(workspaceDir);

    const result = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(result).toMatchObject({ artifactCount: 1, importedCount: 1, removedCount: 0 });
    const page = await fs.readFile(path.join(vaultDir, result.pagePaths[0] ?? ""), "utf8");
    expect(page).toContain("sourceType: memory-bridge-events");
    expect(page).toContain('"type":"memory.recall.recorded"');
  });

  it("salvages bridge page Notes when the source artifact disappears", async () => {
    const humanNotes = "Durable bridge annotation";
    const workspaceDir = await createBridgeWorkspace("prune-workspace");
    const { rootDir: vaultDir, config } = await createBridgeVault("prune-vault", {
      bridge: { indexDailyNotes: false, indexDreamReports: false, followMemoryEvents: false },
    });

    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Durable Memory\n", "utf8");
    registerBridgeArtifacts([artifact(workspaceDir, "MEMORY.md", "memory-root")]);
    const appConfig = appFor(workspaceDir);

    const first = await syncMemoryWikiBridgeSources({ config, appConfig });
    const firstPagePath = first.pagePaths[0] ?? "";
    const firstPageAbsPath = path.join(vaultDir, firstPagePath);
    const firstPage = await fs.readFile(firstPageAbsPath, "utf8");
    expect(firstPage).toContain("# Durable Memory");
    await fs.writeFile(
      firstPageAbsPath,
      firstPage.replace(
        "<!-- openclaw:human:start -->\n<!-- openclaw:human:end -->",
        `<!-- openclaw:human:start -->\n${humanNotes}\n<!-- openclaw:human:end -->`,
      ),
      "utf8",
    );

    await fs.rm(path.join(workspaceDir, "MEMORY.md"));
    registerBridgeArtifacts([]);
    const second = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(second).toMatchObject({ artifactCount: 0, removedCount: 1 });
    await expect(fs.stat(firstPageAbsPath)).rejects.toHaveProperty("code", "ENOENT");
    const salvageDir = path.join(vaultDir, ".salvage");
    await expect(
      fs.readFile(path.join(salvageDir, `${firstPagePath.replace(/\//g, "_")}.notes.md`), "utf8"),
    ).resolves.toContain(humanNotes);
  });

  it("keeps stale pages when the memory capability closes during a source read", async () => {
    const workspaceDir = await createBridgeWorkspace("closing-capability-workspace");
    const { rootDir: vaultDir, config } = await createBridgeVault("closing-capability-vault");
    const artifacts = ["previous.md", "current.md"].map((name) => artifact(workspaceDir, name));
    for (const entry of artifacts) {
      await fs.writeFile(entry.absolutePath, `# ${entry.relativePath}\n`, "utf8");
    }
    registerBridgeArtifacts(artifacts.slice(0, 1));
    const appConfig: OpenClawConfig = {};
    const first = await syncMemoryWikiBridgeSources({ config, appConfig });
    const previousPage = path.join(vaultDir, first.pagePaths[0] ?? "");
    const previousContent = await fs.readFile(previousPage, "utf8");

    registerBridgeArtifacts(artifacts.slice(1));
    const readFile = fs.readFile.bind(fs);
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(
        async (...args: Parameters<typeof fs.readFile>): ReturnType<typeof fs.readFile> => {
          const content = await readFile(...args);
          if (args[0] === artifacts[1]?.absolutePath) {
            clearMemoryPluginState();
          }
          return content;
        },
      );
    const second = await syncMemoryWikiBridgeSources({ config, appConfig });
    readSpy.mockRestore();

    expect(second).toMatchObject({ importedCount: 1, removedCount: 0 });
    await expect(fs.readFile(previousPage, "utf8")).resolves.toBe(previousContent);

    registerBridgeArtifacts(artifacts.slice(1));
    const third = await syncMemoryWikiBridgeSources({ config, appConfig });
    expect(third).toMatchObject({ skippedCount: 1, removedCount: 1 });
    await expect(fs.access(previousPage)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to overwrite bridge source pages through vault symlinks", async () => {
    const { workspaceDir, config, memoryPath, appConfig, pageAbsPath } =
      await createImportedMemory("symlink");
    const externalTarget = path.join(workspaceDir, "outside.md");
    await fs.writeFile(externalTarget, "external target\n", "utf8");
    await fs.rm(pageAbsPath);
    await fs.symlink(externalTarget, pageAbsPath);
    await fs.writeFile(memoryPath, "# Updated Durable Memory\n", "utf8");

    await expect(syncMemoryWikiBridgeSources({ config, appConfig })).rejects.toThrow(
      "Refusing to write imported source page through symlink",
    );
    await expect(fs.readFile(externalTarget, "utf8")).resolves.toBe("external target\n");
  });

  it("reports non-symlink bridge source write safety failures without symlink wording", async () => {
    const { config, memoryPath, appConfig, pageAbsPath } = await createImportedMemory("not-file");
    await fs.rm(pageAbsPath);
    await fs.mkdir(pageAbsPath);
    await fs.writeFile(path.join(pageAbsPath, "child.md"), "blocking child\n", "utf8");
    await fs.writeFile(memoryPath, "# Updated Durable Memory\n", "utf8");

    const second = syncMemoryWikiBridgeSources({ config, appConfig });
    await expect(second).rejects.toThrow(
      /Refusing to write imported source page \((not-empty|not-file|path-mismatch)\): sources\//u,
    );
    await expect(second).rejects.not.toThrow("through symlink");
  });

  it("replaces bridge source page hardlinks without clobbering their target", async () => {
    const { workspaceDir, config, memoryPath, appConfig, pageAbsPath } =
      await createImportedMemory("hardlink");
    const externalTarget = path.join(workspaceDir, "outside-hardlink.md");
    await fs.writeFile(externalTarget, "external target\n", "utf8");
    await fs.rm(pageAbsPath);
    await fs.link(externalTarget, pageAbsPath);
    await fs.writeFile(memoryPath, "# Updated Durable Memory\n", "utf8");

    const second = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(second.updatedCount).toBe(1);
    await expect(fs.readFile(externalTarget, "utf8")).resolves.toBe("external target\n");
    await expect(fs.readFile(pageAbsPath, "utf8")).resolves.toContain("# Updated Durable Memory");
  });
});
