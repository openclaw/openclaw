import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import {
  registerTaskEnforcerHook,
  clearTaskEnforcerState,
} from "../plugins/core-hooks/task-enforcer.js";
import {
  forceReinitializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "../plugins/hook-runner-global.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import { createOpenClawCodingTools } from "./pi-tools.js";

async function withTempDir<T>(prefix: string, fn: (dir: string) => Promise<T>) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function getTextContent(result?: { content?: Array<{ type: string; text?: string }> }) {
  const textBlock = result?.content?.find((block) => block.type === "text");
  return textBlock?.text ?? "";
}

describe("task-enforcer integration", () => {
  afterEach(() => {
    clearTaskEnforcerState();
    resetGlobalHookRunner();
  });

  it("blocks exec for non-simple tasks until steps are defined", async () => {
    await withTempDir("openclaw-task-enforcer-", async (workspaceDir) => {
      const cfg: OpenClawConfig = {
        agents: {
          list: [{ id: "main", default: true, workspace: workspaceDir }],
        },
      };
      const registry = createEmptyPluginRegistry();
      registerTaskEnforcerHook(registry);
      forceReinitializeGlobalHookRunner(registry);

      const tools = createOpenClawCodingTools({
        agentId: "main",
        sessionKey: "agent:main:main",
        workspaceDir,
        config: cfg,
        exec: { host: "gateway", ask: "off", security: "full" },
      });
      const taskStartTool = tools.find((tool) => tool.name === "task_start");
      const taskUpdateTool = tools.find((tool) => tool.name === "task_update");
      const execTool = tools.find((tool) => tool.name === "exec");

      expect(taskStartTool?.execute).toBeDefined();
      expect(taskUpdateTool?.execute).toBeDefined();
      expect(execTool?.execute).toBeDefined();

      const taskId = "task_legacycomplex0001";
      await fs.mkdir(path.join(workspaceDir, "tasks"), { recursive: true });
      await fs.writeFile(
        path.join(workspaceDir, "tasks", `${taskId}.md`),
        [
          `# Task: ${taskId}`,
          "",
          "## Metadata",
          "- **Status:** in_progress",
          "- **Priority:** high",
          "- **Created:** 2026-03-09T00:00:00.000Z",
          "- **Created By Session:** agent:main:main",
          "",
          "## Description",
          "Complex local task",
          "",
          "## Progress",
          "- Started without steps",
          "",
          "## Last Activity",
          "2026-03-09T00:00:00.000Z",
          "",
          "---",
          "*Managed by task tools*",
        ].join("\n"),
        "utf8",
      );
      await fs.writeFile(
        path.join(workspaceDir, "CURRENT_TASK.md"),
        [
          "# Current Task",
          "",
          `**Focus:** ${taskId}`,
          "",
          "## Complex local task",
          "",
          "**Status:** in_progress",
          "**Priority:** high",
          "**Created:** 2026-03-09T00:00:00.000Z",
          "",
          "### Progress",
          "- Started without steps",
          "",
          "---",
          "*Managed by task tools*",
        ].join("\n"),
        "utf8",
      );

      await expect(
        execTool?.execute?.("exec-before-steps", {
          command: "printf 'blocked-before-steps\\n'",
          workdir: workspaceDir,
        }),
      ).rejects.toThrow(/STEPS REQUIRED/);

      const taskFile = await fs.readFile(path.join(workspaceDir, "tasks", `${taskId}.md`), "utf8");
      expect(taskFile).not.toContain("## Steps");

      await taskUpdateTool?.execute?.("task-set-steps", {
        task_id: taskId,
        action: "set_steps",
        steps: [{ content: "Print marker" }, { content: "Summarize result" }],
      });

      const execResult = await execTool?.execute?.("exec-after-steps", {
        command: "printf 'allowed-after-steps\\n'",
        workdir: workspaceDir,
      });
      expect(getTextContent(execResult)).toContain("allowed-after-steps");
    });
  });
});
