// Bridges an agent-harness user-input request into the global QuestionManager so
// it renders on every question surface (Control UI card, channel buttons) and can
// be answered from any of them — converging plugin harnesses (Codex) onto the
// same structured-question lane as the native ask_user_question tool.
import { getGlobalQuestionManager, type QuestionAnswers } from "../../gateway/question-manager.js";
import type {
  AgentHarnessUserInputAnswers,
  AgentHarnessUserInputQuestion,
} from "./user-input-bridge.js";

export type AgentHarnessQuestionRegistration = {
  /** The QuestionManager record id. */
  id: string;
  /** Resolves with harness answers when a surface answers, or null when expired/cancelled. */
  wait: Promise<AgentHarnessUserInputAnswers | null>;
  /** Expire the pending question so every surface dismisses it. Idempotent. */
  cancel: (reason: string) => void;
};

function toHarnessAnswers(
  questions: readonly AgentHarnessUserInputQuestion[],
  answers: QuestionAnswers,
): AgentHarnessUserInputAnswers {
  const out: AgentHarnessUserInputAnswers["answers"] = {};
  for (const question of questions) {
    const answer = answers[question.id];
    const text = answer?.text?.trim();
    out[question.id] = { answers: text ? [text] : [] };
  }
  return { answers: out };
}

/**
 * Registers the harness questions with the global QuestionManager and returns a
 * promise that resolves with harness-shaped answers when any surface answers
 * (or null on expiry), plus a cancel() to dismiss the pending question when the
 * caller's own resolution (e.g. a legacy free-text reply) wins the race.
 */
export function registerAgentHarnessQuestion(input: {
  questions: readonly AgentHarnessUserInputQuestion[];
  sessionKey?: string | null;
  agentId?: string | null;
  turnSourceChannel?: string | null;
  turnSourceTo?: string | null;
  turnSourceAccountId?: string | null;
  turnSourceThreadId?: string | number | null;
}): AgentHarnessQuestionRegistration {
  const manager = getGlobalQuestionManager();
  const { record, wait } = manager.register({
    questions: input.questions,
    sessionKey: input.sessionKey ?? null,
    agentId: input.agentId ?? null,
    turnSourceChannel: input.turnSourceChannel ?? null,
    turnSourceTo: input.turnSourceTo ?? null,
    turnSourceAccountId: input.turnSourceAccountId ?? null,
    turnSourceThreadId: input.turnSourceThreadId ?? null,
  });
  return {
    id: record.id,
    wait: wait.then((answers) => (answers ? toHarnessAnswers(input.questions, answers) : null)),
    cancel: (reason) => {
      manager.expire(record.id, reason);
    },
  };
}
