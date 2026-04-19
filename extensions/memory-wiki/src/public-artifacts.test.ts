import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  clearMemoryPluginState,
  registerMemoryCapability,
} from "../../../src/plugins/memory-state.js";
import type { OpenClawConfig } from "../api.js";
import { listBridgeMemoryPublicArtifacts } from "./public-artifacts.js";

describe("listBridgeMemoryPublicArtifacts", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-pubarts-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    clearMemoryPluginState();
  });

  function nextCaseRoot(name: string): string {
    return path.join(fixtureRoot, `case-${caseId++}-${name}`);
  }

  it("returns runtime-registered artifacts when capability is present", async () => {
    const workspaceDir = nextCaseRoot("runtime-present");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Memory\n", "utf8");

    const runtimeArtifact = {
      kind: "memory-root" as const,
      workspaceDir,
      relativePath: "MEMORY.md",
      absolutePath: path.join(workspaceDir, "MEMORY.md"),
      agentIds: ["main"],
      contentType: "markdown" as const,
    };

    registerMemoryCapability("memory-core", {
      publicArtifacts: {
        async listArtifacts() {
          return [runtimeArtifact];
        },
      },
    });

    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    } as OpenClawConfig;

    const result = await listBridgeMemoryPublicArtifacts({ cfg });

    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("memory-root");
    expect(result[0]?.absolutePath).toBe(path.join(workspaceDir, "MEMORY.md"));
  });

  it("falls back to config-derived artifacts when runtime returns empty", async () => {
    const workspaceDir = nextCaseRoot("runtime-empty");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Durable Memory\n", "utf8");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-05.md"),
      "# Daily Note\n",
      "utf8",
    );

    // No runtime capability registered — listActiveMemoryPublicArtifacts returns []
    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    } as OpenClawConfig;

    const result = await listBridgeMemoryPublicArtifacts({ cfg });

    expect(result.length).toBeGreaterThan(0);
    const kinds = result.map((artifact) => artifact.kind);
    expect(kinds).toContain("memory-root");
    expect(kinds).toContain("daily-note");
  });

  it("returns empty when both runtime and config yield no artifacts", async () => {
    const workspaceDir = nextCaseRoot("both-empty");
    await fs.mkdir(workspaceDir, { recursive: true });
    // No MEMORY.md, no memory/ directory

    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    } as OpenClawConfig;

    const result = await listBridgeMemoryPublicArtifacts({ cfg });

    expect(result).toHaveLength(0);
  });

  it("prefers runtime artifacts over config-derived when both are available", async () => {
    const workspaceDir = nextCaseRoot("both-available");
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "# Memory\n", "utf8");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, "memory", "2026-04-05.md"),
      "# Daily Note\n",
      "utf8",
    );

    // Register a single runtime artifact — should be preferred even though
    // config-derived scan would find more
    const runtimeArtifact = {
      kind: "memory-root" as const,
      workspaceDir,
      relativePath: "MEMORY.md",
      absolutePath: path.join(workspaceDir, "MEMORY.md"),
      agentIds: ["main"],
      contentType: "markdown" as const,
    };

    registerMemoryCapability("memory-core", {
      publicArtifacts: {
        async listArtifacts() {
          return [runtimeArtifact];
        },
      },
    });

    const cfg = {
      agents: { list: [{ id: "main", default: true, workspace: workspaceDir }] },
    } as OpenClawConfig;

    const result = await listBridgeMemoryPublicArtifacts({ cfg });

    // Only the runtime artifact, not the config-derived daily-note
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("memory-root");
  });
});
