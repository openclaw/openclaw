import type { SystemState } from "./agent-state.js";

export type SuggestedAction = {
  label: string;
  callbackData: string;
  reason: string;
};

export function generateSuggestions(state: SystemState): SuggestedAction[] {
  const suggestions: SuggestedAction[] = [];

  for (const item of state.attentionItems) {
    if (item.kind === "ci_fail") {
      suggestions.push({
        label: "🔍 分析 CI 失敗",
        callbackData: `sc:do:analyze-ci`,
        reason: "CI 失敗需要處理",
      });
    }
    if (item.kind === "pr_ready") {
      suggestions.push({
        label: "📋 Review PR",
        callbackData: `sc:do:review`,
        reason: "有 PR 等待 Review",
      });
    }
    if (item.kind === "stale_pr") {
      suggestions.push({
        label: "⏰ 處理過期 PR",
        callbackData: `sc:do:stale`,
        reason: "PR 超過 3 天未合",
      });
    }
  }

  if (state.lastCompletedTask?.success) {
    const title = state.lastCompletedTask.title.toLowerCase();
    suggestions.push(...getPostTaskSuggestions(title));
  }

  if (state.phase === "idle" && suggestions.length === 0) {
    suggestions.push(
      {
        label: "📊 掃描專案",
        callbackData: "sc:do:scan",
        reason: "定期檢查專案狀態",
      },
      {
        label: "🧹 程式碼清理",
        callbackData: "sc:do:cleanup",
        reason: "自動清理程式碼",
      },
    );
  }

  return suggestions.slice(0, 4);
}

function getPostTaskSuggestions(taskTitle: string): SuggestedAction[] {
  if (
    taskTitle.includes("fix") ||
    taskTitle.includes("修") ||
    taskTitle.includes("refactor") ||
    taskTitle.includes("重構")
  ) {
    return [
      { label: "🧪 跑測試", callbackData: "sc:do:test", reason: "修改後應該跑測試" },
      { label: "📝 提交", callbackData: "sc:do:commit", reason: "確認修改後提交" },
    ];
  }

  if (taskTitle.includes("test") || taskTitle.includes("測試")) {
    return [
      { label: "📝 提交", callbackData: "sc:do:commit", reason: "測試通過可以提交" },
      { label: "🚀 建 PR", callbackData: "sc:do:pr", reason: "準備發 PR" },
    ];
  }

  if (taskTitle.includes("commit") || taskTitle.includes("提交")) {
    return [
      { label: "🚀 建 PR", callbackData: "sc:do:pr", reason: "提交後建立 PR" },
      { label: "📤 Push", callbackData: "sc:do:push", reason: "推送到遠端" },
    ];
  }

  if (taskTitle.includes("review") || taskTitle.includes("審查")) {
    return [
      { label: "✅ 合併", callbackData: "sc:do:merge", reason: "審查完成可以合併" },
    ];
  }

  if (taskTitle.includes("deploy") || taskTitle.includes("部署")) {
    return [
      { label: "🔍 驗證部署", callbackData: "sc:do:verify", reason: "部署後驗證" },
      { label: "📊 監控", callbackData: "sc:do:monitor", reason: "觀察部署狀態" },
    ];
  }

  return [];
}

export function formatSuggestionMessage(suggestions: SuggestedAction[]): string {
  if (suggestions.length === 0) return "";
  return (
    "💡 <b>建議下一步</b>\n" +
    suggestions.map((s) => `  → ${s.label}: <i>${s.reason}</i>`).join("\n")
  );
}
