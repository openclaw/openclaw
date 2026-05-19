import { Type } from "typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export function createStatusTool(api: OpenClawPluginApi) {
  return {
    name: "automation_status",
    label: "Automation Status",
    description:
      "Show the current automation system status: available providers, active tasks, " +
      "registered workflows, and system health. Use when user asks /status or wants overview.",
    parameters: Type.Object({
      verbose: Type.Optional(
        Type.Boolean({ description: "Show detailed information including config", default: false }),
      ),
    }),

    async execute(_id: string, params: { verbose?: unknown }) {
      const verbose = params.verbose === true;

      const status = {
        system: "OpenClaw Automation Gateway",
        providers: {
          "claude-cli": { status: "available", harness: "claude-cli", description: "對話/分析/規劃/審查" },
          codex: { status: "available", harness: "codex-app-server", description: "程式碼生成/修改/重構" },
        },
        tools: [
          "automation_classify_intent — 智能意圖分類",
          "automation_codex_execute — Codex 程式碼執行",
          "automation_workflow — 多步工作流引擎",
          "automation_confirm_gate — 操作確認閘門",
          "automation_status — 系統狀態",
        ],
        workflows: ["auto-pr", "code-review", "daily-scan", "refactor"],
        commands: {
          "/code <instruction>": "用 Codex 執行程式碼任務",
          "/ask <question>": "用 Claude 回答問題",
          "/workflow <name>": "執行預定義工作流",
          "/status": "查看系統狀態",
        },
      };

      if (verbose) {
        Object.assign(status, {
          config: {
            defaultAgent: api.config?.agents?.defaults?.model ?? "auto",
            channelsActive: ["telegram"],
          },
        });
      }

      return [{ type: "text" as const, text: JSON.stringify(status, null, 2) }];
    },
  };
}
