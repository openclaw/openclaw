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

  function createBridgeVault(name: string, config: MemoryWikiPluginConfig = {}) {
    return createVault({
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

  async function createBridge(name: string, options: MemoryWikiPluginConfig = {}) {
    const workspaceDir = await createBridgeWorkspace(`${name}-workspace`);
    const { rootDir: vaultDir, config } = await createBridgeVault(`${name}-vault`, options);
    return { workspaceDir, vaultDir, config, appConfig: appFor(workspaceDir) };
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

  it("imports public memory artifacts and stays idempotent across reruns", async () => {
    const { workspaceDir, vaultDir, config, appConfig } = await createBridge("import", {
      bridge: { indexDailyNotes: true, indexDreamReports: true },
    });

    await writeArtifacts([
      [artifact(workspaceDir), "# Durable Memory\n"],
      [artifact(workspaceDir, "memory/2026-04-05.md", "daily-note"), "# Daily Note\n"],
      [artifact(workspaceDir, "memory/dreaming/2026-04-05.md", "dream-report"), "# Dream Report\n"],
    ]);

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

    const second = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(second).toMatchObject({
      importedCount: 0,
      updatedCount: 0,
      skippedCount: 3,
      removedCount: 0,
    });

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
    const { workspaceDir, vaultDir, config, appConfig } = await createBridge("legacy-agentids");
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
    const unknownMemory = path.join(unknownWorkspace, "MEMORY.md");
    await writeArtifacts([
      [
        artifact(supportWorkspace, "MEMORY.md", "memory-root", [" SUPPORT "]),
        "# Support Sentinel\n",
      ],
      [
        artifact(marketingWorkspace, "MEMORY.md", "memory-root", ["marketing"]),
        "# Marketing Sentinel\n",
      ],
      [
        artifact(sharedWorkspace, "MEMORY.md", "memory-root", ["support", "MARKETING"]),
        "# Shared Sentinel\n",
      ],
      [
        {
          kind: "memory-root",
          workspaceDir: unknownWorkspace,
          relativePath: "MEMORY.md",
          absolutePath: unknownMemory,
          contentType: "markdown",
        } as Omit<MemoryPluginPublicArtifact, "agentIds"> as MemoryPluginPublicArtifact,
        "# Unknown Sentinel\n",
      ],
    ]);
    const appConfig: OpenClawConfig = {
      agents: {
        entries: {
          support: { workspace: supportWorkspace },
          marketing: { workspace: marketingWorkspace },
        },
      },
    };

    for (const [agentId, included, excluded] of [
      ["support", "Support Sentinel", "Marketing Sentinel"],
      ["marketing", "Marketing Sentinel", "Support Sentinel"],
    ]) {
      const { rootDir, config } = await createBridgeVault(`${agentId}-vault`, {
        vault: { scope: "agent" },
      });
      const result = await syncMemoryWikiBridgeSources({
        config: { ...config, agentId },
        appConfig,
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

  it("imports the public memory event journal when followMemoryEvents is enabled", async () => {
    const { workspaceDir, vaultDir, config, appConfig } = await createBridge("events", {
      bridge: { followMemoryEvents: true },
    });

    const eventContent = '{"type":"memory.recall.recorded"}\n';
    await writeArtifacts([
      [artifact(workspaceDir, "memory/events/memory-host-events.jsonl", "event-log"), eventContent],
    ]);

    const result = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(result).toMatchObject({ artifactCount: 1, importedCount: 1, removedCount: 0 });
    const page = await fs.readFile(path.join(vaultDir, result.pagePaths[0] ?? ""), "utf8");
    expect(page).toContain("sourceType: memory-bridge-events");
    expect(page).toContain('"type":"memory.recall.recorded"');
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
