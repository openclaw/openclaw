// Memory Wiki tests cover bridge plugin behavior.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  clearMemoryPluginState,
  type MemoryPluginPublicArtifact,
  registerMemoryCapability,
} from "openclaw/plugin-sdk/memory-host-core";
import {
  appendMemoryHostEvent,
  resolveMemoryHostEventLogPath,
} from "openclaw/plugin-sdk/memory-host-events";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../api.js";
import { syncMemoryWikiBridgeSources } from "./bridge.js";
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

  function registerBridgeArtifacts(artifacts: MemoryPluginPublicArtifact[]) {
    registerMemoryCapability("memory-core", {
      publicArtifacts: {
        async listArtifacts({ agentId }) {
          return agentId
            ? artifacts.filter((artifact) => artifact.agentIds.includes(agentId))
            : artifacts;
        },
      },
    });
  }

  it("imports public memory artifacts and stays idempotent across reruns", async () => {
    const workspaceDir = await createBridgeWorkspace("workspace");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexMemoryRoot: true,
          indexDailyNotes: true,
          indexDreamReports: true,
        },
      },
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
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "MEMORY.md",
        absolutePath: path.join(workspaceDir, "MEMORY.md"),
        agentIds: ["main"],
        contentType: "markdown",
      },
      {
        kind: "daily-note",
        workspaceDir,
        relativePath: "memory/2026-04-05.md",
        absolutePath: path.join(workspaceDir, "memory", "2026-04-05.md"),
        agentIds: ["main"],
        contentType: "markdown",
      },
      {
        kind: "dream-report",
        workspaceDir,
        relativePath: "memory/dreaming/2026-04-05.md",
        absolutePath: path.join(workspaceDir, "memory", "dreaming", "2026-04-05.md"),
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);

    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const first = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(first.workspaces).toBe(1);
    expect(first.artifactCount).toBe(3);
    expect(first.importedCount).toBe(3);
    expect(first.updatedCount).toBe(0);
    expect(first.skippedCount).toBe(0);
    expect(first.removedCount).toBe(0);
    expect(first.pagePaths).toHaveLength(3);

    const sourcePages = await fs.readdir(path.join(vaultDir, "sources"));
    expect(
      sourcePages.reduce((count, name) => count + (name.startsWith("bridge-") ? 1 : 0), 0),
    ).toBe(3);

    const memoryPage = await fs.readFile(path.join(vaultDir, first.pagePaths[0] ?? ""), "utf8");
    expect(memoryPage).toContain("sourceType: memory-bridge");
    expect(memoryPage).toContain("## Bridge Source");

    const second = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(second.importedCount).toBe(0);
    expect(second.updatedCount).toBe(0);
    expect(second.skippedCount).toBe(3);
    expect(second.removedCount).toBe(0);

    const logLines = (await fs.readFile(path.join(vaultDir, ".openclaw-wiki", "log.jsonl"), "utf8"))
      .trim()
      .split("\n");
    expect(logLines).toHaveLength(2);
  });

  it("scopes bridge imports to the active wiki agent", async () => {
    const researchWorkspace = await createBridgeWorkspace("research-workspace");
    const writerWorkspace = await createBridgeWorkspace("writer-workspace");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("agent-scoped-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexMemoryRoot: true,
        },
      },
    });
    const researchMemoryPath = path.join(researchWorkspace, "MEMORY.md");
    const writerMemoryPath = path.join(writerWorkspace, "MEMORY.md");
    await fs.writeFile(researchMemoryPath, "# Research Memory\n", "utf8");
    await fs.writeFile(writerMemoryPath, "# Writer Memory\n", "utf8");
    registerBridgeArtifacts([
      {
        kind: "memory-root",
        workspaceDir: researchWorkspace,
        relativePath: "MEMORY.md",
        absolutePath: researchMemoryPath,
        agentIds: ["research"],
        contentType: "markdown",
      },
      {
        kind: "memory-root",
        workspaceDir: writerWorkspace,
        relativePath: "MEMORY.md",
        absolutePath: writerMemoryPath,
        agentIds: ["writer"],
        contentType: "markdown",
      },
    ]);

    const result = await syncMemoryWikiBridgeSources({
      config: { ...config, agentId: "research" },
      appConfig: {
        agents: {
          list: [
            { id: "research", workspace: researchWorkspace },
            { id: "writer", workspace: writerWorkspace },
          ],
        },
      },
    });

    expect(result.artifactCount).toBe(1);
    expect(result.workspaces).toBe(1);
    const page = await fs.readFile(path.join(vaultDir, result.pagePaths[0] ?? ""), "utf8");
    expect(page).toContain("# Research Memory");
    expect(page).not.toContain("# Writer Memory");
  });

  it("preserves another agent's bridge pages in a shared vault", async () => {
    const researchWorkspace = await createBridgeWorkspace("shared-vault-research");
    const writerWorkspace = await createBridgeWorkspace("shared-vault-writer");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("shared-agent-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexMemoryRoot: true,
        },
      },
    });
    const researchMemoryPath = path.join(researchWorkspace, "MEMORY.md");
    const writerMemoryPath = path.join(writerWorkspace, "MEMORY.md");
    await fs.writeFile(researchMemoryPath, "# Research Memory\n", "utf8");
    await fs.writeFile(writerMemoryPath, "# Writer Memory\n", "utf8");
    registerBridgeArtifacts([
      {
        kind: "memory-root",
        workspaceDir: researchWorkspace,
        relativePath: "MEMORY.md",
        absolutePath: researchMemoryPath,
        agentIds: ["research"],
        contentType: "markdown",
      },
      {
        kind: "memory-root",
        workspaceDir: writerWorkspace,
        relativePath: "MEMORY.md",
        absolutePath: writerMemoryPath,
        agentIds: ["writer"],
        contentType: "markdown",
      },
    ]);
    const appConfig: OpenClawConfig = {
      agents: {
        list: [
          {
            id: "research",
            workspace: researchWorkspace,
            memory: {
              extensions: {
                "memory-wiki": {
                  vaultMode: "bridge",
                  vault: { path: vaultDir },
                  bridge: {
                    enabled: true,
                    readMemoryArtifacts: true,
                    indexMemoryRoot: true,
                  },
                },
              },
            },
          },
          {
            id: "writer",
            workspace: writerWorkspace,
            memory: {
              extensions: {
                "memory-wiki": {
                  vaultMode: "bridge",
                  vault: { path: vaultDir },
                  bridge: {
                    enabled: true,
                    readMemoryArtifacts: true,
                    indexMemoryRoot: true,
                  },
                },
              },
            },
          },
        ],
      },
    };

    const research = await syncMemoryWikiBridgeSources({
      config: { ...config, agentId: "research" },
      appConfig,
    });
    const researchPagePath = research.pagePaths[0] ?? "";
    const writer = await syncMemoryWikiBridgeSources({
      config: { ...config, agentId: "writer" },
      appConfig,
    });

    expect(research.importedCount).toBe(1);
    expect(writer.importedCount).toBe(1);
    expect(writer.removedCount).toBe(0);
    await expect(fs.readFile(path.join(vaultDir, researchPagePath), "utf8")).resolves.toContain(
      "# Research Memory",
    );
  });

  it("imports bridge artifacts from legacy providers without agent ids", async () => {
    const workspaceDir = await createBridgeWorkspace("legacy-agentids-workspace");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("legacy-agentids-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexMemoryRoot: true,
        },
      },
    });
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

    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const result = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(result.importedCount).toBe(1);
    expect(result.artifactCount).toBe(1);
    const page = await fs.readFile(path.join(vaultDir, result.pagePaths[0] ?? ""), "utf8");
    expect(page).toContain("# Memory Bridge: MEMORY");
    expect(page).toContain("- Agents: unknown");
  });

  it("returns a no-op result outside bridge mode", async () => {
    const { config } = await createVault({ rootDir: nextCaseRoot("isolated") });

    const result = await syncMemoryWikiBridgeSources({ config });

    expect(result.importedCount).toBe(0);
    expect(result.updatedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.removedCount).toBe(0);
    expect(result.artifactCount).toBe(0);
    expect(result.workspaces).toBe(0);
    expect(result.pagePaths).toEqual([]);
  });

  it("returns a no-op result when bridge mode is enabled without exported memory artifacts", async () => {
    const workspaceDir = await createBridgeWorkspace("no-memory-core");
    const { config } = await createVault({
      rootDir: nextCaseRoot("no-memory-core-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexMemoryRoot: true,
        },
      },
    });

    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Durable Memory\n", "utf8");

    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const result = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(result.importedCount).toBe(0);
    expect(result.updatedCount).toBe(0);
    expect(result.skippedCount).toBe(0);
    expect(result.removedCount).toBe(0);
    expect(result.artifactCount).toBe(0);
    expect(result.workspaces).toBe(0);
    expect(result.pagePaths).toEqual([]);
  });

  it("imports the public memory event journal when followMemoryEvents is enabled", async () => {
    const workspaceDir = await createBridgeWorkspace("events-workspace");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("events-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          followMemoryEvents: true,
        },
      },
    });

    await appendMemoryHostEvent(workspaceDir, {
      type: "memory.recall.recorded",
      timestamp: "2026-04-05T12:00:00.000Z",
      query: "bridge events",
      resultCount: 1,
      results: [
        {
          path: "memory/2026-04-05.md",
          startLine: 1,
          endLine: 2,
          score: 0.8,
        },
      ],
    });
    registerBridgeArtifacts([
      {
        kind: "event-log",
        workspaceDir,
        relativePath: "memory/.dreams/events.jsonl",
        absolutePath: resolveMemoryHostEventLogPath(workspaceDir),
        agentIds: ["main"],
        contentType: "json",
      },
    ]);

    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const result = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(result.artifactCount).toBe(1);
    expect(result.importedCount).toBe(1);
    expect(result.removedCount).toBe(0);
    const page = await fs.readFile(path.join(vaultDir, result.pagePaths[0] ?? ""), "utf8");
    expect(page).toContain("sourceType: memory-bridge-events");
    expect(page).toContain('"type":"memory.recall.recorded"');
  });

  it("imports only the active agent's event journal from a shared workspace", async () => {
    const workspaceDir = await createBridgeWorkspace("shared-events-workspace");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("shared-events-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          followMemoryEvents: true,
        },
      },
    });

    await appendMemoryHostEvent(
      workspaceDir,
      {
        type: "memory.recall.recorded",
        timestamp: "2026-04-05T12:00:00.000Z",
        query: "research-only",
        resultCount: 0,
        results: [],
      },
      "research",
    );
    await appendMemoryHostEvent(
      workspaceDir,
      {
        type: "memory.recall.recorded",
        timestamp: "2026-04-05T12:01:00.000Z",
        query: "writer-only",
        resultCount: 0,
        results: [],
      },
      "writer",
    );
    registerBridgeArtifacts([
      {
        kind: "event-log",
        workspaceDir,
        relativePath: "memory/.dreams/agents/research/events.jsonl",
        absolutePath: resolveMemoryHostEventLogPath(workspaceDir, "research"),
        agentIds: ["research"],
        contentType: "json",
      },
      {
        kind: "event-log",
        workspaceDir,
        relativePath: "memory/.dreams/agents/writer/events.jsonl",
        absolutePath: resolveMemoryHostEventLogPath(workspaceDir, "writer"),
        agentIds: ["writer"],
        contentType: "json",
      },
    ]);

    const result = await syncMemoryWikiBridgeSources({
      config: { ...config, agentId: "research" },
      appConfig: {
        agents: {
          list: [
            { id: "research", default: true, workspace: workspaceDir },
            { id: "writer", workspace: workspaceDir },
          ],
        },
      },
    });

    expect(result.artifactCount).toBe(1);
    const page = await fs.readFile(path.join(vaultDir, result.pagePaths[0] ?? ""), "utf8");
    expect(page).toContain("bridgeAgentIds:");
    expect(page).toContain("- research");
    expect(page).toContain("research-only");
    expect(page).not.toContain("writer-only");
  });

  it("refuses symlinked event journals supplied by a public artifact provider", async () => {
    const workspaceDir = await createBridgeWorkspace("symlinked-events-workspace");
    const { config } = await createVault({
      rootDir: nextCaseRoot("symlinked-events-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          followMemoryEvents: true,
        },
      },
    });
    const eventLogPath = resolveMemoryHostEventLogPath(workspaceDir, "main");
    const outsidePath = path.join(workspaceDir, "outside-events.jsonl");
    await fs.mkdir(path.dirname(eventLogPath), { recursive: true });
    await fs.writeFile(outsidePath, '{"type":"memory.recall.recorded"}\n', "utf8");
    await fs.symlink(outsidePath, eventLogPath);
    registerBridgeArtifacts([
      {
        kind: "event-log",
        workspaceDir,
        relativePath: "memory/.dreams/agents/main/events.jsonl",
        absolutePath: eventLogPath,
        agentIds: ["main"],
        contentType: "json",
      },
    ]);

    await expect(
      syncMemoryWikiBridgeSources({
        config,
        appConfig: {
          agents: {
            list: [{ id: "main", default: true, workspace: workspaceDir }],
          },
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses bridge artifacts with symlinked parent directories", async () => {
    const workspaceDir = await createBridgeWorkspace("symlinked-parent-workspace");
    const { config } = await createVault({
      rootDir: nextCaseRoot("symlinked-parent-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexDailyNotes: true,
        },
      },
    });
    const outsideDir = nextCaseRoot("symlinked-parent-outside");
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, "2026-04-05.md"), "# Outside\n", "utf8");
    await fs.symlink(outsideDir, path.join(workspaceDir, "memory"));
    registerBridgeArtifacts([
      {
        kind: "daily-note",
        workspaceDir,
        relativePath: "memory/2026-04-05.md",
        absolutePath: path.join(workspaceDir, "memory", "2026-04-05.md"),
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);

    await expect(
      syncMemoryWikiBridgeSources({
        config,
        appConfig: {
          agents: {
            list: [{ id: "main", default: true, workspace: workspaceDir }],
          },
        },
      }),
    ).rejects.toThrow();
  });

  it("prunes stale bridge pages when the source artifact disappears", async () => {
    const workspaceDir = await createBridgeWorkspace("prune-workspace");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("prune-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          indexMemoryRoot: true,
          indexDailyNotes: false,
          indexDreamReports: false,
          followMemoryEvents: false,
        },
      },
    });

    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Durable Memory\n", "utf8");
    registerBridgeArtifacts([
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "MEMORY.md",
        absolutePath: path.join(workspaceDir, "MEMORY.md"),
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);
    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const first = await syncMemoryWikiBridgeSources({ config, appConfig });
    const firstPagePath = first.pagePaths[0] ?? "";
    await expect(fs.readFile(path.join(vaultDir, firstPagePath), "utf8")).resolves.toContain(
      "# Durable Memory",
    );

    await fs.rm(path.join(workspaceDir, "MEMORY.md"));
    registerBridgeArtifacts([]);
    const second = await syncMemoryWikiBridgeSources({ config, appConfig });

    expect(second.artifactCount).toBe(0);
    expect(second.removedCount).toBe(1);
    await expect(fs.stat(path.join(vaultDir, firstPagePath))).rejects.toHaveProperty(
      "code",
      "ENOENT",
    );
  });

  it("refuses to overwrite bridge source pages through vault symlinks", async () => {
    const workspaceDir = await createBridgeWorkspace("symlink-workspace");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("symlink-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexMemoryRoot: true,
        },
      },
    });
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(memoryPath, "# Durable Memory\n", "utf8");
    registerBridgeArtifacts([
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "MEMORY.md",
        absolutePath: memoryPath,
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);
    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };
    const first = await syncMemoryWikiBridgeSources({ config, appConfig });
    const pagePath = first.pagePaths[0] ?? "";
    const pageAbsPath = path.join(vaultDir, pagePath);
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

  async function createDirectoryCollisionFixture(params: {
    workspaceName: string;
    vaultName: string;
    populateDirectory?: boolean;
  }) {
    const workspaceDir = await createBridgeWorkspace(params.workspaceName);
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot(params.vaultName),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexMemoryRoot: true,
        },
      },
    });
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(memoryPath, "# Durable Memory\n", "utf8");
    registerBridgeArtifacts([
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "MEMORY.md",
        absolutePath: memoryPath,
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);
    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };
    const first = await syncMemoryWikiBridgeSources({ config, appConfig });
    const pagePath = first.pagePaths[0] ?? "";
    const pageAbsPath = path.join(vaultDir, pagePath);
    await fs.rm(pageAbsPath);
    await fs.mkdir(pageAbsPath);
    if (params.populateDirectory) {
      await fs.writeFile(path.join(pageAbsPath, "child.md"), "blocking child\n", "utf8");
    }
    await fs.writeFile(memoryPath, "# Updated Durable Memory\n", "utf8");
    return { appConfig, config, pageAbsPath };
  }

  it("reports non-symlink bridge source write safety failures without symlink wording", async () => {
    const { appConfig, config } = await createDirectoryCollisionFixture({
      workspaceName: "not-file-workspace",
      vaultName: "not-file-vault",
      populateDirectory: true,
    });

    const second = syncMemoryWikiBridgeSources({ config, appConfig });
    await expect(second).rejects.toThrow(
      /Refusing to write imported source page \((not-empty|not-file|path-mismatch)\): sources\//u,
    );
    await expect(second).rejects.not.toThrow("through symlink");
  });

  it("does not remove empty directory bridge source collisions as hardlinks", async () => {
    const { appConfig, config, pageAbsPath } = await createDirectoryCollisionFixture({
      workspaceName: "empty-directory-workspace",
      vaultName: "empty-directory-vault",
    });

    const second = syncMemoryWikiBridgeSources({ config, appConfig });
    await expect(second).rejects.toThrow(
      /Refusing to write imported source page \((not-file|path-mismatch)\): sources\//u,
    );
    await expect(second).rejects.not.toThrow("through symlink");
    await expect(fs.stat(pageAbsPath)).resolves.toSatisfy((stat) => stat.isDirectory());
  });

  it("replaces bridge source page hardlinks without clobbering their target", async () => {
    const workspaceDir = await createBridgeWorkspace("hardlink-workspace");
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("hardlink-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexMemoryRoot: true,
        },
      },
    });
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(memoryPath, "# Durable Memory\n", "utf8");
    registerBridgeArtifacts([
      {
        kind: "memory-root",
        workspaceDir,
        relativePath: "MEMORY.md",
        absolutePath: memoryPath,
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);
    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };
    const first = await syncMemoryWikiBridgeSources({ config, appConfig });
    const pagePath = first.pagePaths[0] ?? "";
    const pageAbsPath = path.join(vaultDir, pagePath);
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

  it("caps composed bridge source filenames to the filesystem component limit", async () => {
    const workspaceDir = await createBridgeWorkspace(`${"漢".repeat(50)}-workspace`);
    const { rootDir: vaultDir, config } = await createVault({
      rootDir: nextCaseRoot("long-bridge-vault"),
      config: {
        vaultMode: "bridge",
        bridge: {
          enabled: true,
          readMemoryArtifacts: true,
          indexDailyNotes: true,
        },
      },
    });

    const relativePath = `${"語".repeat(50)}/${"録".repeat(50)}.md`;
    const absolutePath = path.join(workspaceDir, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, "# Deep Unicode Note\n", "utf8");
    registerBridgeArtifacts([
      {
        kind: "daily-note",
        workspaceDir,
        relativePath,
        absolutePath,
        agentIds: ["main"],
        contentType: "markdown",
      },
    ]);

    const appConfig: OpenClawConfig = {
      agents: {
        list: [{ id: "main", default: true, workspace: workspaceDir }],
      },
    };

    const result = await syncMemoryWikiBridgeSources({ config, appConfig });
    const pagePath = result.pagePaths[0] ?? "";

    expect(result.importedCount).toBe(1);
    expect(Buffer.byteLength(path.basename(pagePath))).toBeLessThanOrEqual(255);
    await expect(fs.readFile(path.join(vaultDir, pagePath), "utf8")).resolves.toContain(
      "# Deep Unicode Note",
    );
  });
});
