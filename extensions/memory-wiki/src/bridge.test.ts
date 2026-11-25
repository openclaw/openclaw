import fs from "node:fs/promises";
import path from "node:path";
import {
  clearMemoryPluginState,
  type MemoryPluginPublicArtifact,
  registerMemoryCapability,
} from "openclaw/plugin-sdk/memory-host-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { syncMemoryWikiBridgeSources } from "./bridge.js";
import type { MemoryWikiPluginConfig } from "./config.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const { createTempDir, createVault } = createMemoryWikiTestHarness();

describe("syncMemoryWikiBridgeSources", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    clearMemoryPluginState();
  });

  const createBridgeWorkspace = (name: string) => createTempDir(`memory-wiki-${name}-`);

  function createBridgeVault(name: string, config: MemoryWikiPluginConfig = {}, rootDir?: string) {
    return createVault({
      rootDir,
      prefix: `memory-wiki-${name}-`,
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

  function legacyArtifact(workspaceDir: string) {
    const { agentIds: _agentIds, ...entry } = artifact(workspaceDir);
    return entry as MemoryPluginPublicArtifact;
  }

  const ownedArtifact = (workspace: string, owners: string[]) =>
    artifact(workspace, "MEMORY.md", "memory-root", owners);

  async function createBridge(name: string, options: MemoryWikiPluginConfig = {}) {
    const workspaceDir = await createBridgeWorkspace(`${name}-workspace`);
    const { rootDir: vaultDir, config } = await createBridgeVault(`${name}-vault`, options);
    const appConfig = appFor(workspaceDir);
    return {
      workspaceDir,
      vaultDir,
      config,
      appConfig,
      sync: () => syncMemoryWikiBridgeSources({ config, appConfig }),
      readPage: (pagePath: string) => fs.readFile(path.join(vaultDir, pagePath), "utf8"),
    };
  }

  async function writeArtifacts(entries: Array<[MemoryPluginPublicArtifact, string]>) {
    for (const [entry, content] of entries) {
      await fs.mkdir(path.dirname(entry.absolutePath), { recursive: true });
      await fs.writeFile(entry.absolutePath, content, "utf8");
    }
    registerBridgeArtifacts(entries.map(([entry]) => entry));
  }

  async function createImportedMemory(name: string) {
    const { workspaceDir, vaultDir, config, appConfig } = await createBridge(name);
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(memoryPath, "# Durable Memory\n", "utf8");
    registerBridgeArtifacts([artifact(workspaceDir)]);
    const first = await syncMemoryWikiBridgeSources({ config, appConfig });
    const pageAbsPath = path.join(vaultDir, first.pagePaths[0] ?? "");
    return { workspaceDir, config, memoryPath, appConfig, pageAbsPath };
  }

  it("imports public artifact kinds and legacy ownership, staying idempotent across reruns", async () => {
    const { workspaceDir, sync, readPage } = await createBridge("import", {
      bridge: { indexDailyNotes: true, indexDreamReports: true, followMemoryEvents: true },
    });
    const legacyWorkspace = await createBridgeWorkspace("legacy");
    await writeArtifacts([
      [legacyArtifact(legacyWorkspace), "# Durable Memory\n"],
      [artifact(workspaceDir, "memory/2026-04-05.md", "daily-note"), "# Daily Note\n"],
      [artifact(workspaceDir, "memory/dreaming/2026-04-05.md", "dream-report"), "# Dream Report\n"],
      [
        artifact(workspaceDir, "memory/events/events.jsonl", "event-log"),
        '{"type":"memory.recall.recorded"}\n',
      ],
    ]);
    const first = await sync();
    expect(first).toMatchObject({
      workspaces: 2,
      artifactCount: 4,
      importedCount: 4,
      updatedCount: 0,
      skippedCount: 0,
      removedCount: 0,
    });
    expect(first.pagePaths).toHaveLength(4);
    const importedPages = await Promise.all(first.pagePaths.map(readPage));
    const memoryPage = importedPages.find((page) => page.includes("# Memory Bridge: MEMORY"));
    expect(memoryPage).toContain("sourceType: memory-bridge");
    expect(memoryPage).toContain("## Bridge Source");
    expect(memoryPage).toContain("# Memory Bridge: MEMORY");
    expect(memoryPage).toContain("- Agents: unknown");
    const pages = importedPages.join("\n");
    expect(pages).toContain("sourceType: memory-bridge-events");
    expect(pages).toContain('"type":"memory.recall.recorded"');
    const second = await sync();
    expect(second).toMatchObject({
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 4,
      removedCount: 0,
    });
  });

  it("skips generated artifacts from its own vault", async () => {
    const workspaceDir = await createBridgeWorkspace("self-import-workspace");
    const vaultDir = path.join(workspaceDir, "memory", "wiki");
    const { config } = await createBridgeVault(
      "self-import",
      { bridge: { indexDailyNotes: true } },
      vaultDir,
    );
    await writeArtifacts([
      [artifact(workspaceDir, "memory/2026-06-22.md", "daily-note"), "# Daily Note\n"],
      [artifact(workspaceDir, "memory/wiki/sources/bridge-old.md", "daily-note"), "# Imported\n"],
      [artifact(workspaceDir, "memory/wiki/index.md", "daily-note"), "# Index\n"],
    ]);

    const appConfig = appFor(workspaceDir);

    const result = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(result).toMatchObject({ artifactCount: 1, importedCount: 1 });
    const sourcePages = await fs.readdir(path.join(vaultDir, "sources"));
    expect(sourcePages.filter((name) => name.startsWith("bridge-"))).toHaveLength(2);
  });

  it("isolates agent-scoped bridge artifacts while preserving shared ownership", async () => {
    const supportWorkspace = await createBridgeWorkspace("support");
    const marketingWorkspace = await createBridgeWorkspace("marketing");
    const sharedWorkspace = await createBridgeWorkspace("shared");
    const unknownWorkspace = await createBridgeWorkspace("unknown");
    await writeArtifacts([
      [ownedArtifact(supportWorkspace, [" SUPPORT "]), "# Support Sentinel\n"],
      [ownedArtifact(marketingWorkspace, ["marketing"]), "# Marketing Sentinel\n"],
      [ownedArtifact(sharedWorkspace, ["support", "MARKETING"]), "# Shared Sentinel\n"],
      [legacyArtifact(unknownWorkspace), "# Unknown Sentinel\n"],
    ]);

    for (const [agentId, included, excluded] of [
      ["support", "Support Sentinel", "Marketing Sentinel"],
      ["marketing", "Marketing Sentinel", "Support Sentinel"],
    ]) {
      const { rootDir, config } = await createBridgeVault(`${agentId}-vault`, {
        vault: { scope: "agent" },
      });
      const result = await syncMemoryWikiBridgeSources({
        config: { ...config, agentId },
        appConfig: {},
      });
      expect(result).toMatchObject({ artifactCount: 2, importedCount: 2, workspaces: 2 });
      const pages = (
        await Promise.all(
          result.pagePaths.map((pagePath) => fs.readFile(path.join(rootDir, pagePath), "utf8")),
        )
      ).join("\n");
      expect(pages).toContain(included);
      expect(pages).toContain("Shared Sentinel");
      expect(pages).not.toContain(excluded);
      expect(pages).not.toContain("Unknown Sentinel");
    }
  });

  it("rejects an unresolved agent-scoped bridge config", async () => {
    const { config } = await createVault({
      config: { vault: { scope: "agent" } },
    });

    await expect(syncMemoryWikiBridgeSources({ config })).rejects.toThrow(
      "Memory Wiki agent-scoped vault requires a resolved agent id",
    );
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

  it.each(["symlink", "hardlink"] as const)("safely handles a replaced source %s", async (kind) => {
    const { workspaceDir, config, memoryPath, appConfig, pageAbsPath } =
      await createImportedMemory(kind);
    const externalTarget = path.join(workspaceDir, "outside.md");
    await fs.writeFile(externalTarget, "external target\n", "utf8");
    await fs.rm(pageAbsPath);
    await (kind === "symlink" ? fs.symlink : fs.link)(externalTarget, pageAbsPath);
    await fs.writeFile(memoryPath, "# Updated Durable Memory\n", "utf8");

    const sync = syncMemoryWikiBridgeSources({ config, appConfig });
    if (kind === "symlink") {
      await expect(sync).rejects.toThrow("Refusing to write imported source page through symlink");
    } else {
      expect((await sync).updatedCount).toBe(1);
      await expect(fs.readFile(pageAbsPath, "utf8")).resolves.toContain("# Updated Durable Memory");
    }
    await expect(fs.readFile(externalTarget, "utf8")).resolves.toBe("external target\n");
  });
});
