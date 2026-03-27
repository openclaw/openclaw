import type {
  SessionFailureReport,
  SessionRetryReport,
  SessionSystemPromptReport,
  SessionVerifyReport,
} from "../config/sessions/types.js";

export type FailureRuleSuggestion = {
  key: string;
  title: string;
  rule: string;
  evidence: string;
};

function buildContextBudgetSuggestion(
  report: SessionSystemPromptReport,
): FailureRuleSuggestion | undefined {
  const budget = report.promptBudget;
  if (!budget) {
    return undefined;
  }
  const top = [
    { label: "tool schemas", chars: budget.toolSchemaChars },
    { label: "workspace files", chars: budget.workspaceInjectedChars },
    { label: "skills list", chars: budget.skillsPromptChars },
  ].toSorted((a, b) => b.chars - a.chars)[0];
  if (!top || top.chars <= 0) {
    return undefined;
  }
  if (top.label === "tool schemas" && top.chars >= 10_000) {
    return {
      key: "trim-tool-surface",
      title: "Trim tool surface first",
      rule: "Prefer the smallest tool surface that can finish the task; only expand tools after a concrete need appears.",
      evidence: `tool schemas are the largest prompt cost at ${top.chars} chars`,
    };
  }
  if (top.label === "workspace files" && top.chars >= 6_000) {
    return {
      key: "slice-workspace-policy",
      title: "Slice workspace policy sooner",
      rule: "When workspace policy dominates prompt cost, slice or trim repo guidance before retrying the task.",
      evidence: `workspace files are the largest prompt cost at ${top.chars} chars`,
    };
  }
  if (top.label === "skills list" && top.chars >= 2_000) {
    return {
      key: "trim-skill-surface",
      title: "Trim skill surface first",
      rule: "Prefer the smallest skill set for the task profile; only keep skills with a clear signal in the prompt.",
      evidence: `skills are the largest prompt cost at ${top.chars} chars`,
    };
  }
  return undefined;
}

export function buildFailureRuleSuggestions(params: {
  report: SessionSystemPromptReport;
  failureReport?: SessionFailureReport;
  retryReport?: SessionRetryReport;
  verifyReport?: SessionVerifyReport;
}): FailureRuleSuggestion[] {
  const suggestions: FailureRuleSuggestion[] = [];
  const pushUnique = (suggestion: FailureRuleSuggestion | undefined) => {
    if (!suggestion || suggestions.some((entry) => entry.key === suggestion.key)) {
      return;
    }
    suggestions.push(suggestion);
  };

  if (
    params.failureReport?.category === "verification" ||
    params.verifyReport?.status === "failed"
  ) {
    pushUnique({
      key: "verify-before-final",
      title: "Verify before final reply",
      rule: "After code or runtime changes, run the smallest relevant verification command before claiming success.",
      evidence:
        params.verifyReport?.status === "failed"
          ? `${params.verifyReport.checksFailed}/${params.verifyReport.checksRun} verification checks failed`
          : (params.failureReport?.summary ?? "verification failure detected"),
    });
  }

  if (params.retryReport?.status === "exhausted" || (params.retryReport?.retriesUsed ?? 0) >= 2) {
    pushUnique({
      key: "stop-repeat-retries",
      title: "Stop repeated retries sooner",
      rule: "If the same run has already retried twice, stop and surface the first concrete failing check instead of retrying again.",
      evidence:
        params.retryReport?.status === "exhausted"
          ? `retry budget exhausted after ${params.retryReport.attemptsUsed}/${params.retryReport.maxAttempts} attempts`
          : `${params.retryReport?.retriesUsed ?? 0} retries were already used in this run`,
    });
  }

  if (params.failureReport?.category === "tool" && params.failureReport.toolName) {
    pushUnique({
      key: "tool-preflight",
      title: "Add a tool preflight rule",
      rule: `Before using ${params.failureReport.toolName}, do a lightweight preflight step that confirms targets and required arguments.`,
      evidence: params.failureReport.summary,
    });
  }

  if (params.failureReport?.category === "context") {
    pushUnique({
      key: "shrink-context-before-retry",
      title: "Shrink context before retry",
      rule: "When a run fails for context reasons, reduce policy, tool, or skill exposure before retrying on the same model.",
      evidence: params.failureReport.summary,
    });
  }

  pushUnique(buildContextBudgetSuggestion(params.report));

  return suggestions.slice(0, 3);
}
