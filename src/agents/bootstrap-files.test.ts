import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import {
  resolveBootstrapContextForRun,
  resolveBootstrapFilesForRun,
  resolveContextForRun,
} from "./bootstrap-files.js";
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

  it("returns empty bootstrap and context when injectMode is once and bootstrapInjected is true", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-once-");
    const result = await resolveBootstrapContextForRun({
      workspaceDir,
      injectMode: "once",
      bootstrapInjected: true,
    });
    expect(result.bootstrapFiles).toEqual([]);
    expect(result.contextFiles).toEqual([]);
  });
});

describe("resolveContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("uses raw path when context.mode is unset or raw", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-context-raw-");
    const raw = await resolveBootstrapContextForRun({ workspaceDir });
    const viaContextUnset = await resolveContextForRun({ workspaceDir });
    const viaContextRaw = await resolveContextForRun({
      workspaceDir,
      config: {
        agents: { defaults: { context: { mode: "raw" } } },
      } as import("../config/config.js").OpenClawConfig,
    });
    expect(viaContextUnset.contextFiles.length).toBe(raw.contextFiles.length);
    expect(viaContextRaw.contextFiles.length).toBe(raw.contextFiles.length);
    expect(viaContextUnset.bootstrapFiles.length).toBe(raw.bootstrapFiles.length);
    expect(viaContextRaw.bootstrapFiles.length).toBe(raw.bootstrapFiles.length);
  });

  it("uses index-rank-compact path when context.mode is index-rank-compact (stub delegates to raw)", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-context-index-");
    const raw = await resolveBootstrapContextForRun({ workspaceDir });
    const viaCompact = await resolveContextForRun({
      workspaceDir,
      config: {
        agents: { defaults: { context: { mode: "index-rank-compact" } } },
      } as import("../config/config.js").OpenClawConfig,
    });
    expect(viaCompact.bootstrapFiles.length).toBe(raw.bootstrapFiles.length);
    expect(viaCompact.contextFiles.length).toBe(raw.contextFiles.length);
  });
});
