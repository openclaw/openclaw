import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PlanStepStatus = "pending" | "running" | "done" | "blocked" | "skipped";

export type PlanStep = {
  index: number;
  text: string;
  status: PlanStepStatus;
  result?: string;
};

export type PlanStatus = "active" | "complete" | "abandoned";

export type SessionPlan = {
  planId: string;
  sessionKey: string;
  goal: string;
  doneWhen: string;
  steps: PlanStep[];
  status: PlanStatus;
  createdAt: number;
  completedAt?: number;
  summary?: string;
};

// ---------------------------------------------------------------------------
// State — keyed by sessionKey (one plan per session at a time)
// ---------------------------------------------------------------------------

const plans = new Map<string, SessionPlan>();

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createPlan(
  sessionKey: string,
  goal: string,
  steps: string[],
  doneWhen: string,
): SessionPlan {
  const plan: SessionPlan = {
    planId: crypto.randomUUID(),
    sessionKey,
    goal,
    doneWhen,
    steps: steps.map((text, i) => ({
      index: i + 1,
      text,
      status: i === 0 ? "running" : "pending",
    })),
    status: "active",
    createdAt: Date.now(),
  };
  plans.set(sessionKey, plan);
  return plan;
}

export function updateStep(
  sessionKey: string,
  stepIndex: number,
  status: PlanStepStatus,
  result?: string,
): SessionPlan | null {
  const plan = plans.get(sessionKey);
  if (!plan || plan.status !== "active") {
    return null;
  }

  const step = plan.steps.find((s) => s.index === stepIndex);
  if (!step) {
    return null;
  }

  step.status = status;
  if (result) {
    step.result = result;
  }

  // Auto-advance: if this step is done, mark the next pending step as running
  if (status === "done") {
    const next = plan.steps.find((s) => s.status === "pending");
    if (next) {
      next.status = "running";
    }
  }

  return plan;
}

export function completePlan(sessionKey: string, summary?: string): SessionPlan | null {
  const plan = plans.get(sessionKey);
  if (!plan) {
    return null;
  }

  plan.status = "complete";
  plan.completedAt = Date.now();
  if (summary) {
    plan.summary = summary;
  }

  // Mark any remaining pending/running steps as skipped
  for (const step of plan.steps) {
    if (step.status === "pending" || step.status === "running") {
      step.status = "skipped";
    }
  }

  return plan;
}

export function getPlan(sessionKey: string): SessionPlan | undefined {
  return plans.get(sessionKey);
}

// ---------------------------------------------------------------------------
// Formatting — ASCII checklist for tool responses
// ---------------------------------------------------------------------------

const STATUS_ICONS: Record<PlanStepStatus, string> = {
  pending: "[ ]",
  running: "[>]",
  done: "[x]",
  blocked: "[!]",
  skipped: "[-]",
};

export function formatPlan(plan: SessionPlan): string {
  const lines: string[] = [];
  lines.push(`Goal: ${plan.goal}`);
  lines.push("");

  for (const step of plan.steps) {
    const icon = STATUS_ICONS[step.status];
    const resultSuffix = step.result ? ` — ${step.result}` : "";
    lines.push(`${icon} ${step.index}. ${step.text}${resultSuffix}`);
  }

  lines.push("");
  lines.push(`Done when: ${plan.doneWhen}`);

  if (plan.status === "complete") {
    const doneCount = plan.steps.filter((s) => s.status === "done").length;
    lines.push("");
    lines.push(`Status: COMPLETE (${doneCount}/${plan.steps.length} steps done)`);
    if (plan.summary) {
      lines.push(`Summary: ${plan.summary}`);
    }
  }

  return lines.join("\n");
}

/**
 * Remove plan for a session (cleanup on session end).
 */
export function removePlan(sessionKey: string): boolean {
  return plans.delete(sessionKey);
}

/**
 * For testing only — clear all plans.
 */
export function resetPlanStoreForTests(): void {
  plans.clear();
}
