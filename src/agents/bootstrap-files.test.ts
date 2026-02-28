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

describe("resolveBootstrapFilesForRun agentDir overrides", () => {
  it("prefers agentDir SOUL.md over workspace SOUL.md when agentDir is configured", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-workspace-");
    const agentDir = await makeTempWorkspace("openclaw-bootstrap-agentdir-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "workspace soul", "utf-8");
    await fs.writeFile(path.join(agentDir, "SOUL.md"), "agentdir soul", "utf-8");

    const config = {
      agents: { list: [{ id: "myagent", agentDir }] },
    } as unknown as import("../config/config.js").OpenClawConfig;

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config,
      agentId: "myagent",
    });

    const soul = files.find((f) => f.name === "SOUL.md");
    expect(soul?.missing).toBe(false);
    expect(soul?.content).toBe("agentdir soul");
  });

  it("falls back to workspace file when agentDir does not contain an override", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-workspace-");
    const agentDir = await makeTempWorkspace("openclaw-bootstrap-agentdir-");
    await fs.writeFile(path.join(workspaceDir, "AGENTS.md"), "workspace agents", "utf-8");
    // agentDir has no AGENTS.md

    const config = {
      agents: { list: [{ id: "myagent", agentDir }] },
    } as unknown as import("../config/config.js").OpenClawConfig;

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config,
      agentId: "myagent",
    });

    const agents = files.find((f) => f.name === "AGENTS.md");
    expect(agents?.missing).toBe(false);
    expect(agents?.content).toBe("workspace agents");
  });

  it("skips agentDir lookup when agentId is not provided", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-workspace-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "workspace soul", "utf-8");

    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const soul = files.find((f) => f.name === "SOUL.md");
    expect(soul?.content).toBe("workspace soul");
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
});
