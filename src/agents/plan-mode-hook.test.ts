import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  formatPlanModeBlockReason,
  isPlanModeMutationTool,
  runPlanModeBeforeToolCallHook,
} from "./plan-mode-hook.js";
import { createEnterPlanModeTool, createExitPlanModeTool } from "./tools/plan-mode-tools.js";

const ORIGINAL_STATE_DIR = process.env.OPENCLAW_STATE_DIR;
const SESSION_KEY = "agent:main:main";

function createTempConfig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plan-mode-hook-"));
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

describe("plan mode before_tool_call hook", () => {
  const tempDirs = new Set<string>();

  afterEach(() => {
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

  it("blocks configured mutation tools while plan mode is active", async () => {
    const { root, cfg } = createTempConfig();
    tempDirs.add(root);
    process.env.OPENCLAW_STATE_DIR = root;
    const enterPlanMode = createEnterPlanModeTool({
      agentSessionKey: SESSION_KEY,
      config: cfg,
    });
    await enterPlanMode.execute("enter-plan", {});

    const result = await runPlanModeBeforeToolCallHook(
      { toolName: "exec", params: {} },
      { toolName: "exec", sessionKey: SESSION_KEY },
    );

    expect(result).toEqual({
      block: true,
      blockReason: formatPlanModeBlockReason({ toolName: "exec" }),
    });
  });

  it("allows mutation tools again after exiting plan mode", async () => {
    const { root, cfg } = createTempConfig();
    tempDirs.add(root);
    process.env.OPENCLAW_STATE_DIR = root;
    const enterPlanMode = createEnterPlanModeTool({
      agentSessionKey: SESSION_KEY,
      config: cfg,
    });
    const exitPlanMode = createExitPlanModeTool({
      agentSessionKey: SESSION_KEY,
      config: cfg,
    });
    await enterPlanMode.execute("enter-plan", {});
    await exitPlanMode.execute("exit-plan", {});

    const result = await runPlanModeBeforeToolCallHook(
      { toolName: "exec", params: {} },
      { toolName: "exec", sessionKey: SESSION_KEY },
    );

    expect(result).toBeUndefined();
  });

  it("supports configurable mutation tool lists", async () => {
    expect(isPlanModeMutationTool("message", { mutationToolNames: ["message"] })).toBe(true);
    expect(isPlanModeMutationTool("exec", { mutationToolNames: ["message"] })).toBe(false);
    expect(isPlanModeMutationTool("feishu_doc.write")).toBe(true);
  });
});
