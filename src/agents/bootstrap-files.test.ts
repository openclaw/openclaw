import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace, writeWorkspaceFile } from "../test-helpers/workspace.js";
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

  it("redacts OWNER_ONLY sections for non-owner senders", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await writeWorkspaceFile({
      dir: workspaceDir,
      name: "USER.md",
      content:
        "visible\n<!-- OWNER_ONLY -->private-email@example.com<!-- /OWNER_ONLY -->\nvisible-2",
    });

    const result = await resolveBootstrapContextForRun({
      workspaceDir,
      senderIsOwner: false,
    });
    const userFile = result.contextFiles.find(
      (file) => file.path === path.join(workspaceDir, "USER.md"),
    );

    expect(userFile?.content).toContain("visible");
    expect(userFile?.content).toContain("[Content restricted to owner]");
    expect(userFile?.content).not.toContain("private-email@example.com");
  });

  it("does not flutter when sender role flips across turns", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await writeWorkspaceFile({
      dir: workspaceDir,
      name: "USER.md",
      content: "public\n<!-- OWNER_ONLY -->super-secret-token<!-- /OWNER_ONLY -->\npublic-tail",
    });

    const nonOwnerFirst = await resolveBootstrapContextForRun({
      workspaceDir,
      senderIsOwner: false,
    });
    const ownerSecond = await resolveBootstrapContextForRun({
      workspaceDir,
      senderIsOwner: true,
    });
    const ownerThird = await resolveBootstrapContextForRun({
      workspaceDir,
      senderIsOwner: true,
    });
    const nonOwnerFourth = await resolveBootstrapContextForRun({
      workspaceDir,
      senderIsOwner: false,
    });

    const pickUser = (files: { path: string; content: string }[]) =>
      files.find((file) => file.path === path.join(workspaceDir, "USER.md"))?.content ?? "";

    expect(pickUser(nonOwnerFirst.contextFiles)).not.toContain("super-secret-token");
    expect(pickUser(nonOwnerFirst.contextFiles)).toContain("[Content restricted to owner]");

    expect(pickUser(ownerSecond.contextFiles)).toContain("super-secret-token");
    expect(pickUser(ownerThird.contextFiles)).toContain("super-secret-token");

    expect(pickUser(nonOwnerFourth.contextFiles)).not.toContain("super-secret-token");
    expect(pickUser(nonOwnerFourth.contextFiles)).toContain("[Content restricted to owner]");
  });

  it("does not leak across concurrent owner/non-owner context builds", async () => {
    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    await writeWorkspaceFile({
      dir: workspaceDir,
      name: "USER.md",
      content: "visible\n<!-- OWNER_ONLY -->parallel-secret<!-- /OWNER_ONLY -->\ntail",
    });

    const [ownerRun, nonOwnerRun] = await Promise.all([
      resolveBootstrapContextForRun({ workspaceDir, senderIsOwner: true }),
      resolveBootstrapContextForRun({ workspaceDir, senderIsOwner: false }),
    ]);

    const pickUser = (files: { path: string; content: string }[]) =>
      files.find((file) => file.path === path.join(workspaceDir, "USER.md"))?.content ?? "";

    const ownerContent = pickUser(ownerRun.contextFiles);
    const nonOwnerContent = pickUser(nonOwnerRun.contextFiles);

    expect(ownerContent).toContain("parallel-secret");
    expect(ownerContent).not.toContain("[Content restricted to owner]");

    expect(nonOwnerContent).not.toContain("parallel-secret");
    expect(nonOwnerContent).toContain("[Content restricted to owner]");
  });
});
