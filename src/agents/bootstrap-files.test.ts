import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearInternalHooks,
  registerInternalHook,
  type AgentBootstrapHookContext,
} from "../hooks/internal-hooks.js";
import { makeTempWorkspace } from "../test-helpers/workspace.js";
import { resolveBootstrapContextForRun, resolveBootstrapFilesForRun } from "./bootstrap-files.js";

describe("resolveBootstrapFilesForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("applies bootstrap hook overrides", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: path.join(context.workspaceDir, "EXTRA.md"),
          content: "extra",
          missing: false,
        },
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const files = await resolveBootstrapFilesForRun({ workspaceDir });

    expect(files.some((file) => file.name === "EXTRA.md")).toBe(true);
  });

  it("injects continuity rollup into non-group sessions when present", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const rollupPath = path.join(stateDir, "agents", "main", "continuity", "ROLLUP.md");
      await fs.mkdir(path.dirname(rollupPath), { recursive: true });
      await fs.writeFile(rollupPath, "rollup-content", "utf-8");

      const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
      const files = await resolveBootstrapFilesForRun({
        workspaceDir,
        agentId: "main",
        sessionKey: "main",
      });

      const rollup = files.find((file) => file.name === "ROLLUP.md");
      expect(rollup?.missing).toBe(false);
      expect(rollup?.content).toContain("rollup-content");
    } finally {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("does not inject continuity rollup into group sessions", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const rollupPath = path.join(stateDir, "agents", "main", "continuity", "ROLLUP.md");
      await fs.mkdir(path.dirname(rollupPath), { recursive: true });
      await fs.writeFile(rollupPath, "rollup-content", "utf-8");

      const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
      const files = await resolveBootstrapFilesForRun({
        workspaceDir,
        agentId: "main",
        sessionKey: "telegram:group:abc",
      });

      expect(files.some((file) => file.name === "ROLLUP.md")).toBe(false);
    } finally {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });

  it("does not inject continuity rollup into subagent sessions", async () => {
    const previousStateDir = process.env.OPENCLAW_STATE_DIR;
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-state-"));
    process.env.OPENCLAW_STATE_DIR = stateDir;
    try {
      const rollupPath = path.join(stateDir, "agents", "main", "continuity", "ROLLUP.md");
      await fs.mkdir(path.dirname(rollupPath), { recursive: true });
      await fs.writeFile(rollupPath, "rollup-content", "utf-8");

      const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
      const files = await resolveBootstrapFilesForRun({
        workspaceDir,
        agentId: "main",
        sessionKey: "subagent:foo",
      });

      expect(files.some((file) => file.name === "ROLLUP.md")).toBe(false);
    } finally {
      process.env.OPENCLAW_STATE_DIR = previousStateDir;
    }
  });
});

describe("resolveBootstrapContextForRun", () => {
  beforeEach(() => clearInternalHooks());
  afterEach(() => clearInternalHooks());

  it("returns context files for hook-adjusted bootstrap files", async () => {
    registerInternalHook("agent:bootstrap", (event) => {
      const context = event.context as AgentBootstrapHookContext;
      context.bootstrapFiles = [
        ...context.bootstrapFiles,
        {
          name: "EXTRA.md",
          path: path.join(context.workspaceDir, "EXTRA.md"),
          content: "extra",
          missing: false,
        },
      ];
    });

    const workspaceDir = await makeTempWorkspace("openclaw-bootstrap-");
    const result = await resolveBootstrapContextForRun({ workspaceDir });
    const extra = result.contextFiles.find((file) => file.path === "EXTRA.md");

    expect(extra?.content).toBe("extra");
  });
});
