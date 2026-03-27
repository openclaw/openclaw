import type {
  SessionFailureReport,
  SessionRetryReport,
  SessionSystemPromptReport,
  SessionVerifyReport,
} from "../config/sessions/types.js";

export type CronHealthCheckSuggestion = {
  name: string;
  cadence: "daily" | "weekly";
  schedule: {
    kind: "cron";
    expr: string;
  };
  sessionTarget: "isolated";
  lightContext: boolean;
  focus: string[];
  rationale: string[];
  message: string;
};

function buildPromptBudgetFocus(report: SessionSystemPromptReport): {
  focus?: string;
  rationale?: string;
} {
  const budget = report.promptBudget;
  if (!budget) {
    return {};
  }
  const top = [
    { label: "tool schemas", chars: budget.toolSchemaChars },
    { label: "workspace files", chars: budget.workspaceInjectedChars },
    { label: "skills list", chars: budget.skillsPromptChars },
    { label: "other system prompt", chars: budget.otherSystemPromptChars },
    { label: "tool list", chars: budget.toolListChars },
  ].toSorted((a, b) => b.chars - a.chars)[0];
  if (!top || top.chars <= 0) {
    return {};
  }
  return {
    focus: `${top.label} prompt cost`,
    rationale: `${top.label} is currently the largest prompt component at ${top.chars} chars`,
  };
}

export function buildCronHealthCheckSuggestion(params: {
  report: SessionSystemPromptReport;
  failureReport?: SessionFailureReport;
  retryReport?: SessionRetryReport;
  verifyReport?: SessionVerifyReport;
}): CronHealthCheckSuggestion {
  const focus: string[] = [];
  const rationale: string[] = [];
  const pushUnique = (list: string[], value?: string) => {
    if (!value || list.includes(value)) {
      return;
    }
    list.push(value);
  };

  const verifyFailed =
    params.failureReport?.category === "verification" || params.verifyReport?.status === "failed";
  if (verifyFailed) {
    pushUnique(focus, "verification failures");
    pushUnique(
      rationale,
      params.verifyReport?.status === "failed"
        ? `${params.verifyReport.checksFailed}/${params.verifyReport.checksRun} verification checks failed in the latest run`
        : params.failureReport?.summary,
    );
  }

  if (params.retryReport?.status === "exhausted" || (params.retryReport?.retriesUsed ?? 0) >= 2) {
    pushUnique(focus, "repeat retries");
    pushUnique(
      rationale,
      params.retryReport?.status === "exhausted"
        ? `retry budget exhausted after ${params.retryReport.attemptsUsed}/${params.retryReport.maxAttempts} attempts`
        : `${params.retryReport?.retriesUsed ?? 0} retries were already used in the latest run`,
    );
  }

  if (params.report.workspacePolicyDiscovery?.candidateCount) {
    pushUnique(focus, "candidate-only policy files");
    pushUnique(
      rationale,
      `${params.report.workspacePolicyDiscovery.candidateCount} discovered policy file(s) were not auto-injected`,
    );
  }

  if ((params.report.policySlicing?.slicedFileCount ?? 0) > 0) {
    pushUnique(focus, "sliced policy files");
    pushUnique(
      rationale,
      `${params.report.policySlicing?.slicedFileCount ?? 0} workspace policy file(s) were sliced in the latest run`,
    );
  }

  const budgetFocus = buildPromptBudgetFocus(params.report);
  pushUnique(focus, budgetFocus.focus);
  pushUnique(rationale, budgetFocus.rationale);

  if (params.failureReport?.category === "tool" && params.failureReport.toolName) {
    pushUnique(focus, `${params.failureReport.toolName} tool failures`);
    pushUnique(rationale, params.failureReport.summary);
  }

  const cadence = verifyFailed || params.retryReport?.status === "exhausted" ? "daily" : "weekly";
  const scheduleExpr = cadence === "daily" ? "0 9 * * *" : "0 9 * * 1";
  const focusList = focus.slice(0, 4);
  const messageFocus = focusList.length > 0 ? `Focus on ${focusList.join(", ")}. ` : "";
  const message =
    "Review OpenClaw harness health for this workspace. " +
    messageFocus +
    "Report prompt-budget hotspots, policy drift, verification failures, retry pressure, and candidate rules worth adding. Keep the result short, concrete, and action-oriented.";

  return {
    name: "Harness health check",
    cadence,
    schedule: {
      kind: "cron",
      expr: scheduleExpr,
    },
    sessionTarget: "isolated",
    lightContext: true,
    focus: focusList,
    rationale: rationale.slice(0, 4),
    message,
  };
}
