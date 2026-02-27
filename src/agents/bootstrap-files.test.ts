import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
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

describe("resolveBootstrapFilesForRun agentDir overrides (#29387)", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("prefers agentDir SOUL.md over workspace SOUL.md when agentDir is explicitly configured", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-workspace-");
    const agentDir = await makeTempWorkspace("openclaw-bootstrap-agentdir-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "workspace soul", "utf-8");
    await fs.writeFile(path.join(agentDir, "SOUL.md"), "agentdir soul", "utf-8");

    const config = {
      agents: { list: [{ id: "myagent", agentDir }] },
    } as unknown as OpenClawConfig;

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
    } as unknown as OpenClawConfig;

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

  it("does NOT apply agentDir overrides when agentDir is not explicitly configured", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-workspace-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "workspace soul", "utf-8");

    // Config has an agent entry but no explicit agentDir
    const config = {
      agents: { list: [{ id: "myagent" }] },
    } as unknown as OpenClawConfig;

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config,
      agentId: "myagent",
    });
    const soul = files.find((f) => f.name === "SOUL.md");
    expect(soul?.content).toBe("workspace soul");
  });

  it("emits a diagnostic warning when agentDir files override workspace copies", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-workspace-");
    const agentDir = await makeTempWorkspace("openclaw-bootstrap-agentdir-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "workspace soul", "utf-8");
    await fs.writeFile(path.join(agentDir, "SOUL.md"), "agentdir soul", "utf-8");

    const config = {
      agents: { list: [{ id: "myagent", agentDir }] },
    } as unknown as OpenClawConfig;

    const warnings: string[] = [];
    await resolveBootstrapFilesForRun({
      workspaceDir,
      config,
      agentId: "myagent",
      warn: (msg) => warnings.push(msg),
    });
    expect(warnings.some((w) => w.includes("agentDir override"))).toBe(true);
    expect(warnings.some((w) => w.includes("SOUL.md"))).toBe(true);
  });

  it("includes agentDir-only files not present in workspace (union merge)", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-workspace-");
    const agentDir = await makeTempWorkspace("openclaw-bootstrap-agentdir-");
    // Workspace has SOUL.md but NOT MEMORY.md
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "workspace soul", "utf-8");
    // agentDir has both SOUL.md and MEMORY.md
    await fs.writeFile(path.join(agentDir, "SOUL.md"), "agentdir soul", "utf-8");
    await fs.writeFile(path.join(agentDir, "MEMORY.md"), "agentdir memory", "utf-8");

    const config = {
      agents: { list: [{ id: "myagent", agentDir }] },
    } as unknown as OpenClawConfig;

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config,
      agentId: "myagent",
    });
    const soul = files.find((f) => f.name === "SOUL.md");
    expect(soul?.content).toBe("agentdir soul");
    // MEMORY.md should be included even though workspace doesn't have it
    const memory = files.find((f) => f.name === "MEMORY.md");
    expect(memory).toBeDefined();
    expect(memory?.missing).toBe(false);
    expect(memory?.content).toBe("agentdir memory");
  });

  it("filters agentDir-only files through session allowlist for cron/subagent sessions", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-workspace-");
    const agentDir = await makeTempWorkspace("openclaw-bootstrap-agentdir-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "workspace soul", "utf-8");
    // agentDir has SOUL.md (allowed) and MEMORY.md (not in minimal allowlist)
    await fs.writeFile(path.join(agentDir, "SOUL.md"), "agentdir soul", "utf-8");
    await fs.writeFile(path.join(agentDir, "MEMORY.md"), "agentdir memory", "utf-8");

    const config = {
      agents: { list: [{ id: "myagent", agentDir }] },
    } as unknown as OpenClawConfig;

    // Use a cron session key — filterBootstrapFilesForSession should apply
    // the minimal allowlist, which does NOT include MEMORY.md
    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config,
      agentId: "myagent",
      sessionKey: "agent:default:cron:daily-check",
    });
    const soul = files.find((f) => f.name === "SOUL.md");
    expect(soul?.content).toBe("agentdir soul");
    // MEMORY.md must NOT appear — it is outside the minimal allowlist
    const memory = files.find((f) => f.name === "MEMORY.md");
    expect(memory).toBeUndefined();
  });

  it("preserves hook overrides even when agentDir files exist", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-workspace-");
    const agentDir = await makeTempWorkspace("openclaw-bootstrap-agentdir-");
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "workspace soul", "utf-8");
    await fs.writeFile(path.join(agentDir, "SOUL.md"), "agentdir soul", "utf-8");

    // Register a hook that overrides SOUL.md
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = context.bootstrapFiles.map((f) =>
        f.name === "SOUL.md"
          ? ({ ...f, content: "hook soul", missing: false } as WorkspaceBootstrapFile)
          : f,
      );
    });

    const config = {
      agents: { list: [{ id: "myagent", agentDir }] },
    } as unknown as OpenClawConfig;

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      config,
      agentId: "myagent",
    });
    const soul = files.find((f) => f.name === "SOUL.md");
    // Hook should win over agentDir because hooks are applied last
    expect(soul?.content).toBe("hook soul");
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
