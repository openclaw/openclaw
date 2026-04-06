import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { wrapToolWithBeforeToolCallHook } from "./pi-tools.before-tool-call.js";
import {
  createEnterPlanModeTool,
  createExitPlanModeTool,
  createTodoWriteTool,
} from "./tools/plan-mode-tools.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const SESSION_KEY = "agent:main:main";

function createTempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plan-mode-integration-"));
  const storePath = path.join(root, "agents", "main", "sessions", "sessions.json");
  return {
    root,
    cfg: {
      session: {
        store: storePath,
        mainKey: "main",
      },
    } as OpenClawConfig,
  };
}

describe("plan mode before_tool_call integration", () => {
  const tempDirs = new Set<string>();

  afterEach(() => {
    resetGlobalHookRunner();
    for (const dir of tempDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
    if (ORIGINAL_STATE_DIR === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = ORIGINAL_STATE_DIR;
    }
  });

  it("persists plan state across hook-runner reinitialization and blocks mutation tools until exit", async () => {
    const { root, cfg } = createTempConfig();
    tempDirs.add(root);
    process.env.OPENCLAW_STATE_DIR = root;

    const enterPlanMode = createEnterPlanModeTool({
      agentSessionKey: SESSION_KEY,
      config: cfg,
    });
    const todoWrite = createTodoWriteTool({
      agentSessionKey: SESSION_KEY,
      config: cfg,
    });
    const exitPlanMode = createExitPlanModeTool({
      agentSessionKey: SESSION_KEY,
      config: cfg,
    });

    await enterPlanMode.execute("enter-plan", {});
    await todoWrite.execute("todo-write", {
      content: "1. Inspect\n2. Confirm",
      todos: [
        {
          id: "todo-1",
          text: "Inspect the affected files",
          status: "in_progress",
        },
      ],
    });

    initializeGlobalHookRunner(createEmptyPluginRegistry());

    const execute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const blockedTool = wrapToolWithBeforeToolCallHook(
      {
        name: "exec",
        execute,
      } as never,
      {
        agentId: "main",
        sessionKey: SESSION_KEY,
      },
    );

    await expect(blockedTool.execute("call-1", { cmd: "ls" })).rejects.toThrow(
      "code: plan_mode_mutation_blocked",
    );
    expect(execute).not.toHaveBeenCalled();

    // Simulate a resumed session with a fresh hook runner and wrapped tool.
    resetGlobalHookRunner();
    initializeGlobalHookRunner(createEmptyPluginRegistry());
    const resumedExecute = vi.fn().mockResolvedValue({ content: [], details: { ok: true } });
    const resumedTool = wrapToolWithBeforeToolCallHook(
      {
        name: "exec",
        execute: resumedExecute,
      } as never,
      {
        agentId: "main",
        sessionKey: SESSION_KEY,
      },
    );

    await expect(resumedTool.execute("call-2", { cmd: "pwd" })).rejects.toThrow("planMode: plan");
    expect(resumedExecute).not.toHaveBeenCalled();

    await exitPlanMode.execute("exit-plan", {});

    await expect(resumedTool.execute("call-3", { cmd: "pwd" })).resolves.toEqual({
      content: [],
      details: { ok: true },
    });
    expect(resumedExecute).toHaveBeenCalledWith("call-3", { cmd: "pwd" }, undefined, undefined);
  });
});
