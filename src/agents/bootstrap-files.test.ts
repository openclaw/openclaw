import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { clearAllBootstrapSnapshots } from "./bootstrap-cache.js";
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

function registerDuplicateBootstrapFileHook() {
  registerInternalHook("agent:bootstrap", (event) => {
    const context = event.context as AgentBootstrapHookContext;
    const duplicateDir = path.join(context.workspaceDir, "extras");
    const duplicatePath = path.join(duplicateDir, "SELF_IMPROVEMENT_REMINDER.md");
    context.bootstrapFiles = [
      ...context.bootstrapFiles,
      {
        name: "SELF_IMPROVEMENT_REMINDER.md",
        path: `${duplicateDir}${path.sep}.${path.sep}SELF_IMPROVEMENT_REMINDER.md`,
        content: "first",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
      {
        name: "SELF_IMPROVEMENT_REMINDER.md",
        path: duplicatePath,
        content: "second",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
      {
        name: "SELF_IMPROVEMENT_REMINDER.md",
        path: path.join(context.workspaceDir, "other", "SELF_IMPROVEMENT_REMINDER.md"),
        content: "third",
        missing: false,
      } as unknown as WorkspaceBootstrapFile,
    ];
  });
}

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => {
    clearInternalHooks();
    clearAllBootstrapSnapshots();
  });
  afterEach(() => {
    clearInternalHooks();
    clearAllBootstrapSnapshots();
  });

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

  it("deduplicates hook-injected bootstrap files by normalized path while preserving order", async () => {
    registerDuplicateBootstrapFileHook();

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });
    const duplicates = files.filter((file) => file.path.endsWith("SELF_IMPROVEMENT_REMINDER.md"));

    expect(duplicates).toHaveLength(2);
    expect(duplicates[0]?.path).toBe(
      `${path.join(workspaceDir, "extras")}${path.sep}.${path.sep}SELF_IMPROVEMENT_REMINDER.md`,
    );
    expect(duplicates[0]?.content).toBe("first");
    expect(duplicates[1]?.path).toBe(
      path.join(workspaceDir, "other", "SELF_IMPROVEMENT_REMINDER.md"),
    );
  });

  it("does not accumulate duplicate hook-injected files across cached runs", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles.push({
        name: "EXTRA.md",
        path: path.join(context.workspaceDir, "EXTRA.md"),
        content: "extra",
        missing: false,
      } as unknown as WorkspaceBootstrapFile);
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const sessionKey = "agent:main:main";
    const injectedPath = path.join(workspaceDir, "EXTRA.md");

    const first = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey });
    const second = await resolveBootstrapFilesForRun({ workspaceDir, sessionKey });

    expect(first.filter((file) => file.path === injectedPath)).toHaveLength(1);
    expect(second.filter((file) => file.path === injectedPath)).toHaveLength(1);
  });
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => {
    clearInternalHooks();
    clearAllBootstrapSnapshots();
  });
  afterEach(() => {
    clearInternalHooks();
    clearAllBootstrapSnapshots();
  });

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
