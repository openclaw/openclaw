import syncFs from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { resolveBootstrapContextForRun, resolveBootstrapFilesForRun } from "./bootstrap-files.js";
import type { WorkspaceBootstrapFile } from "./workspace.js";

function registerExtraBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "EXTRA.md",
        path: path.join(context.workspaceDir, "EXTRA.md"),
        content: "extra",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

function registerMalformedBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "EXTRA.md",
        filePath: path.join(context.workspaceDir, "BROKEN.md"),
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
      {
        name: "EXTRA.md",
        path: 123,
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
      {
        name: "EXTRA.md",
        path: "   ",
        content: "broken",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("applies bootstrap hook overrides", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.some((file) => file.path === path.join(workspaceDir, "EXTRA.md"))).toBe(true);
  });

  it("drops malformed hook files with missing/invalid paths", async () => {
    registerMalformedBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const warnings: string[] = [];
    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      warn: (message) => warnings.push(message),
    });

    expect(
      files.every((file) => typeof file.path === "string" && file.path.trim().length > 0),
    ).toBe(true);
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toContain('missing or invalid "path" field');
  });
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns context files for hook-adjusted bootstrap files", async () => {
    registerExtraBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const result = await resolveBootstrapContextForRun({ workspaceDir });
    const extra = result.contextFiles.find(
      (file) => file.path === path.join(workspaceDir, "EXTRA.md"),
    );

    expect(extra?.content).toBe("extra");
  });

  it("uses heartbeat-only bootstrap files in lightweight heartbeat mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "persona", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "heartbeat",
    });

    expect(files.length).toBeGreaterThan(0);
    expect(files.every((file) => file.name === "HEARTBEAT.md")).toBe(true);
  });

  it("keeps bootstrap context empty in lightweight cron mode", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "check inbox", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "cron",
    });

    expect(files).toEqual([]);
  });
});

describe("PROJECT.md context injection", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("picks up PROJECT.md from workspaceDir via cwd walk-up", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-project-cwd-");
    await fs.writeFile(path.join(workspaceDir, "PROJECT.md"), "# My Project\nGoals here", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const projectFile = files.find((f) => f.name === "PROJECT.md");

    expect(projectFile).toBeDefined();
    expect(projectFile!.content).toBe("# My Project\nGoals here");
    expect(projectFile!.missing).toBe(false);
  });

  it("picks up PROJECT.md from parent directory via walk-up", async () => {
    const parentDir = await makeTempWorkspace("openclaw-project-parent-");
    const childDir = path.join(parentDir, "subdir");
    await fs.mkdir(childDir, { recursive: true });
    await fs.writeFile(path.join(parentDir, "PROJECT.md"), "# Parent Project", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir: childDir });
    const projectFile = files.find((f) => f.name === "PROJECT.md");

    expect(projectFile).toBeDefined();
    expect(projectFile!.content).toBe("# Parent Project");
    expect(projectFile!.path).toBe(path.join(parentDir, "PROJECT.md"));
  });

  it("picks nearest PROJECT.md for sub-projects (D-04)", async () => {
    const parentDir = await makeTempWorkspace("openclaw-project-nested-");
    const subDir = path.join(parentDir, "sub");
    await fs.mkdir(subDir, { recursive: true });
    await fs.writeFile(path.join(parentDir, "PROJECT.md"), "# Parent", "utf8");
    await fs.writeFile(path.join(subDir, "PROJECT.md"), "# Sub-project", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir: subDir });
    const projectFile = files.find((f) => f.name === "PROJECT.md");

    expect(projectFile).toBeDefined();
    expect(projectFile!.content).toBe("# Sub-project");
    expect(projectFile!.path).toBe(path.join(subDir, "PROJECT.md"));
  });

  it("excludes PROJECT.md for heartbeat runs (D-12)", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-project-heartbeat-");
    await fs.writeFile(path.join(workspaceDir, "PROJECT.md"), "# Project", "utf8");
    await fs.writeFile(path.join(workspaceDir, "HEARTBEAT.md"), "heartbeat content", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      contextMode: "lightweight",
      runKind: "heartbeat",
    });

    const projectFile = files.find((f) => f.name === "PROJECT.md");
    expect(projectFile).toBeUndefined();
  });

  it("gracefully skips when no PROJECT.md found", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-project-none-");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const projectFile = files.find((f) => f.name === "PROJECT.md");

    expect(projectFile).toBeUndefined();
  });

  it("preserves existing bootstrap files alongside PROJECT.md (AGNT-03)", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-project-preserve-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "agents content", "utf8");
    await fs.writeFile(path.join(workspaceDir, "IDENTITY.md"), "identity content", "utf8");
    await fs.writeFile(path.join(workspaceDir, "PROJECT.md"), "# Project", "utf8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    const agentsFile = files.find((f) => f.name === "AGENTS.md");
    const identityFile = files.find((f) => f.name === "IDENTITY.md");
    const projectFile = files.find((f) => f.name === "PROJECT.md");

    expect(agentsFile).toBeDefined();
    expect(agentsFile!.content).toBe("agents content");
    expect(identityFile).toBeDefined();
    expect(identityFile!.content).toBe("identity content");
    expect(projectFile).toBeDefined();
    expect(projectFile!.content).toBe("# Project");
  });

  it("deduplicates -- cwd takes priority over hook injection (D-06)", async () => {
    // Simulate: cwd walk-up already found PROJECT.md, then hook should skip
    const workspaceDir = await makeTempWorkspace("openclaw-project-dedup-");
    await fs.writeFile(path.join(workspaceDir, "PROJECT.md"), "# CWD Project", "utf8");

    // Register a hook that tries to inject a different PROJECT.md
    const hookProjectDir = await makeTempWorkspace("openclaw-project-hook-");
    await fs.writeFile(path.join(hookProjectDir, "PROJECT.md"), "# Hook Project", "utf8");

    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      // Only inject if not already present (same dedup logic as project-context-hook)
      if (!context.bootstrapFiles.some((f) => f.name === "PROJECT.md")) {
        context.bootstrapFiles.push({
          name: "PROJECT.md",
          path: path.join(hookProjectDir, "PROJECT.md"),
          content: syncFs.readFileSync(path.join(hookProjectDir, "PROJECT.md"), "utf-8"),
          missing: false,
        } as unknown as WorkspaceBootstrapFile);
      }
    });

    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const projectFiles = files.filter((f) => f.name === "PROJECT.md");

    // Only one PROJECT.md should be present, from cwd walk-up
    expect(projectFiles).toHaveLength(1);
    expect(projectFiles[0].content).toBe("# CWD Project");
  });
});
