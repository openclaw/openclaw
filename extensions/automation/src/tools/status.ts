import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  details: unknown;
};

function jsonResult(payload: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

export function createStatusTool(api: OpenClawPluginApi) {
  return {
    name: "automation_status",
    label: "自動化狀態",
    description:
      "顯示目前自動化系統狀態：可用 provider、工作流與指令總覽。" +
      "當使用者輸入 /status 或要求總覽時使用。",
    parameters: Type.Object({
      verbose: Type.Optional(
        Type.Boolean({ description: "是否顯示詳細資訊（含設定）", default: false }),
      ),
    }),

    async execute(_id: string, params: { verbose?: unknown }) {
      const verbose = params.verbose === true;

      const status = {
        回覆狀態: "SUCCESS",
        error_code: "NONE",
        next_action: "NEXT_TASK",
        系統: "OpenClaw 自動化中控",
        providers: {
          "claude-cli": { 狀態: "可用", harness: "claude-cli", 說明: "對話/分析/規劃/審查" },
          codex: { 狀態: "可用", harness: "codex-app-server", 說明: "程式碼生成/修改/重構" },
        },
        工具: [
          "automation_classify_intent — 智能意圖分類",
          "automation_codex_execute — Codex 程式碼執行",
          "automation_workflow — 多步工作流引擎",
          "automation_confirm_gate — 操作確認閘門",
          "automation_status — 系統狀態",
        ],
        工作流: ["auto-pr", "code-review", "daily-scan", "refactor"],
        指令: {
          "/code <instruction>": "用 Codex 執行程式碼任務",
          "/ask <question>": "用 Claude 回答問題",
          "/workflow <name>": "執行預定義工作流",
          "/status": "查看系統狀態",
        },
      };

      if (verbose) {
        Object.assign(status, {
          設定: {
            defaultAgent: api.config?.agents?.defaults?.model ?? "自動",
            channelsActive: ["telegram"],
          },
        });
      }

      return jsonResult(status);
    },
  };
}
