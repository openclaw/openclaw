import { Type } from "typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";

export type IntentClassification = {
  type: "coding" | "analysis" | "question" | "automation" | "deploy" | "review";
  provider: "claude-cli" | "codex";
  riskLevel: "low" | "medium" | "high";
  reasoning: string;
};

const RISK_KEYWORDS_HIGH = [
  "push", "deploy", "delete", "rm", "force", "production", "prod",
  "drop", "reset --hard", "發布", "部署", "刪除", "上線",
];

const RISK_KEYWORDS_MEDIUM = [
  "commit", "merge", "install", "update", "upgrade",
  "提交", "合併", "安裝", "更新",
];

const CODING_KEYWORDS = [
  "refactor", "implement", "build", "create", "write code", "fix bug",
  "重構", "實作", "建立", "寫程式", "修復", "修bug", "寫碼", "改碼",
  "generate", "scaffold", "migrate", "轉換",
];

export function classifyRiskLevel(message: string): "low" | "medium" | "high" {
  const lower = message.toLowerCase();
  if (RISK_KEYWORDS_HIGH.some((kw) => lower.includes(kw))) return "high";
  if (RISK_KEYWORDS_MEDIUM.some((kw) => lower.includes(kw))) return "medium";
  return "low";
}

export function classifyProviderHeuristic(message: string): "claude-cli" | "codex" {
  const lower = message.toLowerCase();
  if (CODING_KEYWORDS.some((kw) => lower.includes(kw))) return "codex";
  return "claude-cli";
}

export function createIntentRouterTool(api: OpenClawPluginApi) {
  return {
    name: "automation_classify_intent",
    label: "Intent Router",
    description:
      "Classify a user message into intent type, target provider (claude-cli or codex), " +
      "and risk level. Use this before dispatching complex tasks to determine the correct execution path.",
    parameters: Type.Object({
      message: Type.String({ description: "The user's raw message to classify" }),
      context: Type.Optional(
        Type.String({ description: "Optional conversation context for better classification" }),
      ),
    }),

    async execute(_id: string, params: { message?: unknown; context?: unknown }) {
      const message = typeof params.message === "string" ? params.message.trim() : "";
      if (!message) {
        throw new Error("message is required");
      }

      const riskLevel = classifyRiskLevel(message);
      const provider = classifyProviderHeuristic(message);

      let type: IntentClassification["type"] = "question";
      if (provider === "codex") {
        type = "coding";
      } else if (message.match(/review|審查|檢查|看看.*PR|code review/i)) {
        type = "review";
      } else if (message.match(/deploy|部署|上線|發布/i)) {
        type = "deploy";
      } else if (message.match(/每天|定時|排程|cron|schedule|自動/i)) {
        type = "automation";
      } else if (message.match(/分析|explain|為什麼|怎麼|analyze|investigate/i)) {
        type = "analysis";
      }

      const result: IntentClassification = {
        type,
        provider,
        riskLevel,
        reasoning: `Classified as ${type} (${provider}), risk=${riskLevel}`,
      };

      return [{ type: "text" as const, text: JSON.stringify(result, null, 2) }];
    },
  };
}
