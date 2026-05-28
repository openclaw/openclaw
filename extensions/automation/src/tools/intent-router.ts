import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

export type IntentClassification = {
  type: "coding" | "analysis" | "question" | "automation" | "deploy" | "review";
  provider: "claude-cli" | "codex";
  riskLevel: "low" | "medium" | "high";
  reasoning: string;
};

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

function buildIntentError(params: {
  errorCode: "INTENT_INPUT_INVALID";
  nextAction: string;
  detail: string;
}): string {
  return (
    `回覆狀態：FAILED\n` +
    `error_code=${params.errorCode}\n` +
    `next_action=${params.nextAction}\n` +
    `detail=${params.detail}`
  );
}

const RISK_KEYWORDS_HIGH = [
  "push",
  "deploy",
  "delete",
  "rm",
  "force",
  "production",
  "prod",
  "drop",
  "reset --hard",
  "發布",
  "部署",
  "刪除",
  "上線",
];

const RISK_KEYWORDS_MEDIUM = [
  "commit",
  "merge",
  "install",
  "update",
  "upgrade",
  "提交",
  "合併",
  "安裝",
  "更新",
];

const CODING_KEYWORDS = [
  "refactor",
  "implement",
  "build",
  "create",
  "write code",
  "fix bug",
  "重構",
  "實作",
  "建立",
  "寫程式",
  "修復",
  "修bug",
  "寫碼",
  "改碼",
  "generate",
  "scaffold",
  "migrate",
  "轉換",
];

export function classifyRiskLevel(message: string): "low" | "medium" | "high" {
  const lower = message.toLowerCase();
  if (RISK_KEYWORDS_HIGH.some((kw) => lower.includes(kw))) {
    return "high";
  }
  if (RISK_KEYWORDS_MEDIUM.some((kw) => lower.includes(kw))) {
    return "medium";
  }
  return "low";
}

export function classifyProviderHeuristic(message: string): "claude-cli" | "codex" {
  const lower = message.toLowerCase();
  if (CODING_KEYWORDS.some((kw) => lower.includes(kw))) {
    return "codex";
  }
  return "claude-cli";
}

export function createIntentRouterTool(_api: OpenClawPluginApi) {
  return {
    name: "automation_classify_intent",
    label: "意圖路由器",
    description:
      "將訊息分類為意圖、目標 provider（claude-cli 或 codex）與風險等級。" +
      "在分派任務前先使用，確保走正確執行路徑。",
    parameters: Type.Object({
      message: Type.String({ description: "要分類的使用者原始訊息" }),
      context: Type.Optional(Type.String({ description: "可選的上下文，提升分類準確度" })),
    }),

    async execute(_id: string, params: { message?: unknown; context?: unknown }) {
      const message = typeof params.message === "string" ? params.message.trim() : "";
      if (!message) {
        throw new Error(
          buildIntentError({
            errorCode: "INTENT_INPUT_INVALID",
            nextAction: "PROVIDE_MESSAGE",
            detail: "缺少 message 參數。",
          }),
        );
      }

      const riskLevel = classifyRiskLevel(message);
      const provider = classifyProviderHeuristic(message);

      let type: IntentClassification["type"] = "question";
      if (provider === "codex") {
        type = "coding";
      } else if (/review|審查|檢查|看看.*PR|code review/i.test(message)) {
        type = "review";
      } else if (/deploy|部署|上線|發布/i.test(message)) {
        type = "deploy";
      } else if (/每天|定時|排程|cron|schedule|自動/i.test(message)) {
        type = "automation";
      } else if (/分析|explain|為什麼|怎麼|analyze|investigate/i.test(message)) {
        type = "analysis";
      }

      const result: IntentClassification = {
        type,
        provider,
        riskLevel,
        reasoning: `分類結果：${type}（${provider}），風險等級：${riskLevel}`,
      };

      return jsonResult(result);
    },
  };
}
