import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  _resetBootstrapWarningCacheForTest,
  resolveBootstrapFilesForRun,
} from "./bootstrap-files.js";
import { makeTempWorkspace } from "../../test/test-helpers/workspace.js";

describe("agentDir bootstrap file warnings", () => {
  let workspaceDir: string;
  let agentDir: string;
  const warnings: string[] = [];

  beforeEach(async () => {
    _resetBootstrapWarningCacheForTest();
    workspaceDir = await makeTempWorkspace("openclaw-test-");
    agentDir = await makeTempWorkspace("openclaw-agent-");
    warnings.length = 0;
  });

  afterEach(async () => {
    _resetBootstrapWarningCacheForTest();
  });

  it("should warn when SOUL.md exists in agentDir but not in workspace", async () => {
    // Create SOUL.md in agentDir only
    await fs.writeFile(path.join(agentDir, "SOUL.md"), "agent soul", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      agentDir,
      warn: (msg) => warnings.push(msg),
    });

    // Should have warned about SOUL.md in agentDir
    expect(warnings.some((w) => w.includes("SOUL.md") && w.includes("agentDir"))).toBe(true);
    // SOUL.md should not be in loaded files (since it's not in workspace)
    expect(files.some((f) => f.name === "SOUL.md")).toBe(false);
  });

  it("should warn when AGENTS.md exists in agentDir but not in workspace", async () => {
    // Create AGENTS.md in agentDir only
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "agent rules", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      agentDir,
      warn: (msg) => warnings.push(msg),
    });

    expect(warnings.some((w) => w.includes("AGENTS.md") && w.includes("agentDir"))).toBe(true);
    expect(files.some((f) => f.name === "AGENTS.md")).toBe(false);
  });

  it("should not warn when bootstrap files exist in both agentDir and workspace", async () => {
    // Create same file in both locations
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "workspace soul", "utf8");
    await fs.writeFile(path.join(agentDir, "SOUL.md"), "agent soul", "utf8");

    const files = await resolveBootstrapFilesForRun({
      workspaceDir,
      agentDir,
      warn: (msg) => warnings.push(msg),
    });

    // Should load from workspace (no warning needed since workspace version is used)
    expect(files.some((f) => f.name === "SOUL.md")).toBe(true);
    // Should NOT warn because workspace has the file
    expect(warnings.some((w) => w.includes("SOUL.md") && w.includes("agentDir"))).toBe(false);
  });

  it("should not warn when no bootstrap files exist in agentDir", async () => {
    // Create a non-bootstrap file in agentDir
    await fs.mkdir(path.join(agentDir, "data"), { recursive: true });
    await fs.writeFile(path.join(agentDir, "data", "notes.txt"), "some notes", "utf8");

    await resolveBootstrapFilesForRun({
      workspaceDir,
      agentDir,
      warn: (msg) => warnings.push(msg),
    });

    expect(warnings.some((w) => w.includes("agentDir"))).toBe(false);
  });

  it("should not warn when agentDir is not provided", async () => {
    await fs.writeFile(path.join(workspaceDir, "SOUL.md"), "workspace soul", "utf8");

    await resolveBootstrapFilesForRun({
      workspaceDir,
      warn: (msg) => warnings.push(msg),
    });

    expect(warnings.some((w) => w.includes("agentDir"))).toBe(false);
  });

  it("should warn for multiple bootstrap files in agentDir", async () => {
    // Create multiple bootstrap files in agentDir
    await fs.writeFile(path.join(agentDir, "SOUL.md"), "agent soul", "utf8");
    await fs.writeFile(path.join(agentDir, "AGENTS.md"), "agent rules", "utf8");
    await fs.writeFile(path.join(agentDir, "TOOLS.md"), "agent tools", "utf8");

    await resolveBootstrapFilesForRun({
      workspaceDir,
      agentDir,
      warn: (msg) => warnings.push(msg),
    });

    expect(warnings.some((w) => w.includes("SOUL.md") && w.includes("agentDir"))).toBe(true);
    expect(warnings.some((w) => w.includes("AGENTS.md") && w.includes("agentDir"))).toBe(true);
    expect(warnings.some((w) => w.includes("TOOLS.md") && w.includes("agentDir"))).toBe(true);
  });

  it("should not warn when agentDir does not exist", async () => {
    const nonExistentAgentDir = path.join(workspaceDir, "non-existent-agent");

    await resolveBootstrapFilesForRun({
      workspaceDir,
      agentDir: nonExistentAgentDir,
      warn: (msg) => warnings.push(msg),
    });

    expect(warnings.some((w) => w.includes("agentDir"))).toBe(false);
  });

  it("should include helpful message with paths in warning", async () => {
    await fs.writeFile(path.join(agentDir, "SOUL.md"), "agent soul", "utf8");

    await resolveBootstrapFilesForRun({
      workspaceDir,
      agentDir,
      warn: (msg) => warnings.push(msg),
    });

    const soulWarning = warnings.find((w) => w.includes("SOUL.md"));
    expect(soulWarning).toBeDefined();
    expect(soulWarning).toContain(agentDir);
    expect(soulWarning).toContain(workspaceDir);
    expect(soulWarning).toContain("will not be loaded");
    expect(soulWarning).toContain("workspace directory");
  });
});
