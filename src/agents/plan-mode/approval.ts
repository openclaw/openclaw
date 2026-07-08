import type { QuestionAnswers } from "../../gateway/question-manager.js";
// Shared plan-mode approval question shape + answer classification.
// exit_plan_mode and the /plan channel commands both resolve the SAME PR-A question,
// so the option labels and the approve/reject decision live in one place.
import type { AgentHarnessUserInputQuestion } from "../harness/user-input-bridge.js";

export const PLAN_APPROVAL_QUESTION_ID_PREFIX = "plan-approval";
export const PLAN_APPROVAL_HEADER = "Plan";
export const PLAN_APPROVE_LABEL = "Approve plan";
export const PLAN_KEEP_PLANNING_LABEL = "Keep planning";
/** Model-facing question id inside the record (single question). */
export const PLAN_APPROVAL_QUESTION_KEY = "q1";

export type PlanApprovalDecision = { kind: "approved" } | { kind: "revise"; feedback?: string };

/** Builds the single approve/keep-planning question (a free-text "Other" is auto-added). */
export function buildPlanApprovalQuestion(summary: string): AgentHarnessUserInputQuestion {
  return {
    id: PLAN_APPROVAL_QUESTION_KEY,
    header: PLAN_APPROVAL_HEADER,
    question: `Approve this plan and start executing?\n\n${summary}`,
    isOther: true,
    options: [
      { label: `${PLAN_APPROVE_LABEL} (Recommended)` },
      { label: PLAN_KEEP_PLANNING_LABEL },
    ],
  };
}

function normalizeLabel(text: string): string {
  return text
    .trim()
    .replace(/\s*\(recommended\)\s*$/i, "")
    .trim()
    .toLowerCase();
}

/**
 * Classifies a resolved answer into approve vs revise. Selecting the approve option
 * approves; anything else (Keep planning, or free-text Other) revises with the text as
 * feedback for the model.
 */
export function classifyPlanApprovalAnswer(answers: QuestionAnswers): PlanApprovalDecision {
  const answer = answers[PLAN_APPROVAL_QUESTION_KEY]?.text ?? "";
  const normalized = normalizeLabel(answer);
  if (normalized === normalizeLabel(PLAN_APPROVE_LABEL)) {
    return { kind: "approved" };
  }
  if (!answer.trim() || normalized === normalizeLabel(PLAN_KEEP_PLANNING_LABEL)) {
    return { kind: "revise" };
  }
  return { kind: "revise", feedback: answer.trim() };
}
