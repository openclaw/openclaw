import crypto from "node:crypto";
import { resolveGlobalMap } from "openclaw/plugin-sdk/global-singleton";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  buildUserInputResponse,
  formatUserInputPrompt,
  type UserInputQuestion,
} from "./app-server/user-input-shared.js";

export const CODEX_PENDING_CONTROL_TTL_MS = 10 * 60_000;
const MAX_PENDING_CONTROLS = 200;
const PROPOSED_PLAN_RE = /<proposed_plan>[\s\S]*?<\/proposed_plan>/i;
const CODEX_INTERACTIVE_NAMESPACE = "codex";
const CODEX_USER_INPUT_CALLBACK_PREFIX = "input:";
const CODEX_PLAN_DECISION_CALLBACK_PREFIX = "plan:";
const CODEX_CONTROL_DELIVERY_RESOLVERS_KEY = Symbol.for("openclaw.codex.controlDeliveryResolvers");

type CodexControlDeliveryResolver = () => Promise<void> | void;

type ControlScope = {
  sessionFile: string;
  threadId: string;
  channel?: string;
  senderId?: string;
  accountId?: string;
  sessionKey?: string;
  messageThreadId?: string | number;
};

type PendingPlanDecision = ControlScope & {
  token: string;
  planText: string;
  createdAt: number;
};

type PendingUserInput = ControlScope & {
  token: string;
  questions: UserInputQuestion[];
  selectedAnswers: Record<string, string>;
  /**
   * Index of the question currently shown to the user. Always 0 for the
   * legacy one-shot path; advances after each partial answer on the
   * sequential path. Drives which question's freeform "Other" answer
   * is consumed and which question's button row gets posted next.
   *
   * Ownership boundary: chat-controls advances this when a button click
   * records a partial answer; the bridge observes the new value the
   * next time the user responds, never the other way around.
   */
  currentQuestionIndex: number;
  /**
   * Posts the next question as a brand-new reply on the channel. The
   * closure is built once at request time in the user-input bridge so
   * chat-controls.ts does not need to know the channel surface; it
   * just calls this with the next index after recording a partial
   * answer. Sequential path only; undefined for one-shot.
   */
  emitNextPrompt?: (nextIndex: number) => Promise<void>;
  createdAt: number;
  resolveText: (text: string) => void;
};

const pendingPlanDecisions = new Map<string, PendingPlanDecision>();
const pendingUserInputs = new Map<string, PendingUserInput>();

function getControlDeliveryResolvers(): Map<string, CodexControlDeliveryResolver> {
  return resolveGlobalMap<string, CodexControlDeliveryResolver>(
    CODEX_CONTROL_DELIVERY_RESOLVERS_KEY,
  );
}

export type CodexPlanDecisionResult =
  | { ok: true; sessionFile: string; threadId: string; planText: string }
  | { ok: false; message: string };

export type CodexPlanDecisionAction = "approve" | "approve-clean" | "stay";

export type CodexUserInputCallbackResult =
  | { matched: false }
  | { matched: true; consumed: boolean; message: string };

export type CodexUserInputFreeformResult =
  | { matched: false }
  | { matched: true; consumed: boolean; message: string };

export function resetCodexConversationChatControlsForTests(): void {
  pendingPlanDecisions.clear();
  pendingUserInputs.clear();
  getControlDeliveryResolvers().clear();
}

export function hasCodexProposedPlan(text: string): boolean {
  return PROPOSED_PLAN_RE.test(text);
}

export function buildCodexPlanDecisionReply(params: {
  text: string;
  scope: ControlScope;
}): ReplyPayload {
  const planText = extractCodexProposedPlan(params.text) ?? params.text;
  const token = createPendingPlanDecision({
    scope: params.scope,
    planText,
  });
  return {
    text: planText,
    presentation: {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Approve and execute",
              action: {
                type: "callback",
                value: buildCodexPlanDecisionCallbackValue({ token, action: "approve" }),
              },
              style: "success",
            },
            {
              label: "Approve and execute with clean context",
              action: {
                type: "callback",
                value: buildCodexPlanDecisionCallbackValue({
                  token,
                  action: "approve-clean",
                }),
              },
              style: "primary",
            },
            {
              label: "Stay in plan mode",
              action: {
                type: "callback",
                value: buildCodexPlanDecisionCallbackValue({ token, action: "stay" }),
              },
              style: "secondary",
            },
          ],
        },
      ],
    },
  };
}

export function consumeCodexPlanDecision(params: {
  token: string;
  ctx: Pick<
    PluginCommandContext,
    "senderId" | "channel" | "accountId" | "sessionKey" | "messageThreadId"
  >;
  sessionFile?: string;
  now?: number;
}): CodexPlanDecisionResult {
  pruneExpiredControls(params.now);
  const pending = pendingPlanDecisions.get(params.token);
  if (!pending) {
    return {
      ok: false,
      message: "No pending Codex plan decision was found. The request may have expired.",
    };
  }
  const mismatch = readControlScopeMismatch(pending, params.ctx, params.sessionFile);
  if (mismatch) {
    return { ok: false, message: mismatch };
  }
  pendingPlanDecisions.delete(params.token);
  return {
    ok: true,
    sessionFile: pending.sessionFile,
    threadId: pending.threadId,
    planText: pending.planText,
  };
}

export function createCodexUserInputPrompt(params: {
  questions: UserInputQuestion[];
  scope: ControlScope;
  resolveText: (text: string) => void;
}): ReplyPayload {
  return createCodexUserInputPromptControl(params).payload;
}

export function createCodexUserInputPromptControl(params: {
  questions: UserInputQuestion[];
  scope: ControlScope;
  resolveText: (text: string) => void;
}): { token: string; payload: ReplyPayload } {
  const token = createPendingUserInput(params);
  const presentation = buildUserInputInteractive(params.questions, token);
  return {
    token,
    payload: {
      text: formatUserInputPrompt(params.questions),
      ...(presentation ? { presentation } : {}),
      channelData: {
        codex: {
          userInputControlToken: token,
        },
      },
    },
  };
}

export function createCodexUserInputSequentialControl(params: {
  questions: UserInputQuestion[];
  scope: ControlScope;
  resolveText: (text: string) => void;
  emitNextPrompt: (nextIndex: number) => Promise<void>;
}): { token: string; payload: ReplyPayload } {
  const token = createPendingUserInput({ ...params, currentQuestionIndex: 0 });
  const firstQuestion = params.questions[0];
  if (!firstQuestion) {
    return {
      token,
      payload: {
        text: "",
        channelData: { codex: { userInputControlToken: token } },
      },
    };
  }
  return {
    token,
    payload: buildCodexUserInputSequentialPrompt({
      token,
      questions: params.questions,
      questionIndex: 0,
    }),
  };
}

export function buildCodexUserInputSequentialPrompt(params: {
  token: string;
  questions: UserInputQuestion[];
  questionIndex: number;
}): ReplyPayload {
  const question = params.questions[params.questionIndex];
  if (!question) {
    return {
      text: "",
      channelData: { codex: { userInputControlToken: params.token } },
    };
  }
  const presentation = buildUserInputInteractiveForQuestion(
    question,
    params.token,
    params.questionIndex,
  );
  return {
    text: formatUserInputPrompt([question]),
    ...(presentation ? { presentation } : {}),
    channelData: {
      codex: {
        userInputControlToken: params.token,
      },
    },
  };
}

export function answerCodexUserInput(params: {
  token: string;
  answerText: string;
  ctx: Pick<
    PluginCommandContext,
    "senderId" | "channel" | "accountId" | "sessionKey" | "messageThreadId"
  >;
  sessionFile?: string;
  now?: number;
}): string {
  return consumeCodexUserInput(params).message;
}

export function answerCodexUserInputCallback(params: {
  payload: string;
  ctx: Pick<
    PluginCommandContext,
    "senderId" | "channel" | "accountId" | "sessionKey" | "messageThreadId"
  >;
  sessionFile?: string;
  now?: number;
}): string | undefined {
  const result = resolveCodexUserInputCallback(params);
  return result.matched ? result.message : undefined;
}

export function resolveCodexUserInputCallback(params: {
  payload: string;
  ctx: Pick<
    PluginCommandContext,
    "senderId" | "channel" | "accountId" | "sessionKey" | "messageThreadId"
  >;
  sessionFile?: string;
  now?: number;
}): CodexUserInputCallbackResult {
  const parsed = parseCodexUserInputCallback(params.payload);
  if (!parsed) {
    return { matched: false };
  }
  const result = consumeCodexUserInput({
    token: parsed.token,
    answerText: parsed.answerText,
    questionIndex: parsed.questionIndex,
    ctx: params.ctx,
    sessionFile: params.sessionFile,
    now: params.now,
  });
  return { matched: true, ...result };
}

export function answerCodexUserInputFreeform(params: {
  answerText: string;
  ctx: Pick<
    PluginCommandContext,
    "senderId" | "channel" | "accountId" | "sessionKey" | "messageThreadId"
  >;
  sessionFile?: string;
  now?: number;
}): CodexUserInputFreeformResult {
  const answerText = params.answerText.trim();
  if (!answerText || answerText.startsWith("/")) {
    return { matched: false };
  }
  pruneExpiredControls(params.now);
  const matches = [...pendingUserInputs.values()].filter((pending) => {
    // Sequential entries that show a numbered/label button row are
    // accepted even when no question has isOther. The option-match
    // check below is sufficient to validate the reply.
    const isSequentialWithButtons = Boolean(
      pending.emitNextPrompt && pending.questions.length > 1,
    );
    if (!isSequentialWithButtons && !pending.questions.some((question) => question.isOther)) {
      return false;
    }
    // Sequential pending entries answer only the currently-shown
    // question per click, so the legacy "can this freeform text
    // answer all remaining questions" merge rule would reject
    // perfectly valid single-question freeform replies (upstream
    // Codex normalizes request_user_input questions to isOther=true
    // and the prompt tells users they may reply with their own
    // answer). Match on the currently-shown question's isOther
    // instead and let the sequential branch do the per-question
    // bookkeeping below.
    if (isSequentialWithButtons) {
      const current = pending.questions[pending.currentQuestionIndex];
      if (!current) {
        return false;
      }
      // Sequential entries show a numbered/label button row for the
      // current question. A user that replies with the numeric
      // prefix (e.g. "1") or pastes the label instead of clicking
      // should still resolve the active turn; do not require the
      // currently-shown question to be isOther. Reject replies that
      // do not normalize to one of the rendered options so a stray
      // message does not consume the request.
      const resolved = resolveFreeformOptionAnswer(current, answerText);
      if (!resolved.matched && !current.isOther) {
        return false;
      }
      return !readControlScopeMismatch(pending, params.ctx, params.sessionFile);
    }
    if (!buildCodexMergedFreeformAnswerText(pending, answerText)) {
      return false;
    }
    return !readControlScopeMismatch(pending, params.ctx, params.sessionFile);
  });
  if (matches.length === 0) {
    return { matched: false };
  }
  if (matches.length > 1) {
    return {
      matched: true,
      consumed: false,
      message:
        "More than one Codex input request is pending here. Use a button or /codex input with the request token.",
    };
  }
  const pending = matches[0];
  if (!pending) {
    return { matched: false };
  }
  // Sequential pending entries (created via
  // createCodexUserInputSequentialControl) have an emitNextPrompt closure
  // and render one question at a time. Freeform text answers only the
  // currently-shown question, then the next question is posted as a
  // brand-new reply. Legacy one-shot pending entries fall through to
  // the multi-line merge below.
  if (pending.emitNextPrompt && pending.questions.length > 1) {
    const currentQuestion = pending.questions[pending.currentQuestionIndex];
    if (!currentQuestion) {
      return { matched: false };
    }
    // Normalize typed numeric/label replies against the rendered
    // options. Users who reply '1' or paste the option label instead
    // of pressing the button should still resolve the active turn
    // (the channel may not be able to render or keep the buttons).
    const resolved = resolveFreeformOptionAnswer(currentQuestion, answerText);
    pending.selectedAnswers[currentQuestion.id] = resolved.answer;
    const complete = pending.questions.every((entry) => pending.selectedAnswers[entry.id]);
    if (!complete) {
      const nextIndex = pending.currentQuestionIndex + 1;
      pending.currentQuestionIndex = nextIndex;
      void pending.emitNextPrompt(nextIndex).catch(() => undefined);
      return { matched: true, consumed: true, message: "" };
    }
    // All questions answered by this freeform. Build the merged
    // response directly from selectedAnswers; the legacy freeform
    // merge helper bails when nothing is unselected.
    const merged = pending.questions
      .map((question) => `${question.id}: ${pending.selectedAnswers[question.id]}`)
      .join("\n");
    pendingUserInputs.delete(pending.token);
    pending.resolveText(merged);
    void resolveCodexControlDelivery(pending.token).catch(() => undefined);
    return { matched: true, consumed: true, message: "Sent answer to Codex." };
  }
  const mergedAnswerText = buildCodexMergedFreeformAnswerText(pending, answerText);
  if (!mergedAnswerText) {
    return { matched: false };
  }
  pendingUserInputs.delete(pending.token);
  pending.resolveText(mergedAnswerText);
  void resolveCodexControlDelivery(pending.token).catch(() => undefined);
  return { matched: true, consumed: true, message: "Sent answer to Codex." };
}

export function cancelCodexUserInput(params: { token: string; now?: number }): boolean {
  pruneExpiredControls(params.now);
  const deleted = pendingUserInputs.delete(params.token);
  if (deleted) {
    getControlDeliveryResolvers().delete(params.token);
  }
  return deleted;
}

export function resolveCodexUserInputControlDelivery(params: {
  token: string;
  now?: number;
}): boolean {
  pruneExpiredControls(params.now);
  const deleted = pendingUserInputs.delete(params.token);
  if (!deleted) {
    return false;
  }
  void resolveCodexControlDelivery(params.token).catch(() => undefined);
  return true;
}

export function buildCodexUserInputCallbackValue(params: {
  token: string;
  answerIndex: number;
}): string {
  return `${CODEX_INTERACTIVE_NAMESPACE}:${CODEX_USER_INPUT_CALLBACK_PREFIX}${params.token}:${
    params.answerIndex
  }`;
}

export function buildCodexPlanDecisionCallbackValue(params: {
  token: string;
  action: CodexPlanDecisionAction;
}): string {
  return `${CODEX_INTERACTIVE_NAMESPACE}:${CODEX_PLAN_DECISION_CALLBACK_PREFIX}${params.token}:${
    params.action
  }`;
}

export function parseCodexPlanDecisionCallback(
  payload: string,
): { token: string; action: CodexPlanDecisionAction } | undefined {
  const normalizedPayload = payload.startsWith(`${CODEX_INTERACTIVE_NAMESPACE}:`)
    ? payload.slice(`${CODEX_INTERACTIVE_NAMESPACE}:`.length)
    : payload;
  if (!normalizedPayload.startsWith(CODEX_PLAN_DECISION_CALLBACK_PREFIX)) {
    return undefined;
  }
  const remainder = normalizedPayload.slice(CODEX_PLAN_DECISION_CALLBACK_PREFIX.length);
  const separator = remainder.lastIndexOf(":");
  if (separator <= 0 || separator === remainder.length - 1) {
    return undefined;
  }
  const token = remainder.slice(0, separator);
  const action = remainder.slice(separator + 1);
  if (action !== "approve" && action !== "approve-clean" && action !== "stay") {
    return undefined;
  }
  return token ? { token, action } : undefined;
}

function extractCodexProposedPlan(text: string): string | undefined {
  const match = PROPOSED_PLAN_RE.exec(text);
  const raw = match?.[0];
  if (!raw) {
    return undefined;
  }
  const planText = raw
    .replace(/^<proposed_plan>/i, "")
    .replace(/<\/proposed_plan>$/i, "")
    .trim();
  return planText || undefined;
}

function createPendingPlanDecision(params: { scope: ControlScope; planText: string }): string {
  pruneExpiredControls();
  const token = createToken();
  pendingPlanDecisions.set(token, {
    ...params.scope,
    token,
    planText: params.planText,
    createdAt: Date.now(),
  });
  trimOldest(pendingPlanDecisions);
  return token;
}

function createPendingUserInput(params: {
  questions: UserInputQuestion[];
  scope: ControlScope;
  resolveText: (text: string) => void;
  currentQuestionIndex?: number;
  emitNextPrompt?: (nextIndex: number) => Promise<void>;
}): string {
  pruneExpiredControls();
  const token = createToken();
  pendingUserInputs.set(token, {
    ...params.scope,
    token,
    questions: params.questions,
    selectedAnswers: {},
    currentQuestionIndex: params.currentQuestionIndex ?? 0,
    ...(params.emitNextPrompt ? { emitNextPrompt: params.emitNextPrompt } : {}),
    resolveText: params.resolveText,
    createdAt: Date.now(),
  });
  trimOldest(pendingUserInputs);
  return token;
}

function consumeCodexUserInput(params: {
  token: string;
  answerText: string;
  questionIndex?: number;
  ctx: Pick<
    PluginCommandContext,
    "senderId" | "channel" | "accountId" | "sessionKey" | "messageThreadId"
  >;
  sessionFile?: string;
  now?: number;
}): { consumed: boolean; message: string } {
  pruneExpiredControls(params.now);
  const pending = pendingUserInputs.get(params.token);
  if (!pending) {
    return {
      consumed: false,
      message: "No pending Codex input request was found. The request may have expired.",
    };
  }
  const mismatch = readControlScopeMismatch(pending, params.ctx, params.sessionFile);
  if (mismatch) {
    return { consumed: false, message: mismatch };
  }
  if (params.questionIndex != null && pending.questions.length > 1) {
    // Sequential pending entries render one question at a time. Only
    // the currently-shown question accepts button clicks; any other
    // question index is from an already-answered row (a stale button
    // kept around by the channel until it is fully replaced) or a
    // not-yet-shown row. Legacy one-shot entries accept any order
    // because the user is reading the combined button card.
    if (pending.emitNextPrompt && params.questionIndex !== pending.currentQuestionIndex) {
      const shown = pending.questions[pending.currentQuestionIndex];
      return {
        consumed: false,
        message: shown
          ? `Awaiting answer for ${shown.header}.`
          : "No pending Codex input request was found. The request may have expired.",
      };
    }
    const question = pending.questions[params.questionIndex];
    const optionIndex = /^\d+$/.test(params.answerText.trim())
      ? Number(params.answerText.trim()) - 1
      : -1;
    const answer = question?.options?.[optionIndex]?.label;
    if (!question || !answer) {
      return {
        consumed: false,
        message: "No pending Codex input request was found. The request may have expired.",
      };
    }
    pending.selectedAnswers[question.id] = answer;
    const complete = pending.questions.every((entry) => pending.selectedAnswers[entry.id]);
    if (!complete) {
      // Sequential path: advance the index and ask the bridge to post
      // the next question as a new reply. The next reply is the visible
      // feedback; we do not also surface a "Recorded answer for X"
      // status message because that would put two replies on top of a
      // single click. The Discord adapter treats "consumed" as
      // "disable the used row" so the user cannot double-click the
      // just-answered button before the next question is posted.
      // Legacy one-shot path: the user is reading the combined button
      // card and can click one button per question, so we keep
      // consumed=false (do not disable the row) and surface the
      // recorded answer in a follow-up message.
      if (pending.emitNextPrompt) {
        const nextIndex = pending.currentQuestionIndex + 1;
        pending.currentQuestionIndex = nextIndex;
        void pending.emitNextPrompt(nextIndex).catch(() => undefined);
        return { consumed: true, message: "" };
      }
      return {
        consumed: false,
        message: `Recorded answer for ${question.header}.`,
      };
    }
    pendingUserInputs.delete(params.token);
    pending.resolveText(
      pending.questions
        .map((entry) => `${entry.id}: ${pending.selectedAnswers[entry.id]}`)
        .join("\n"),
    );
    void resolveCodexControlDelivery(params.token).catch(() => undefined);
    return { consumed: true, message: "Sent answer to Codex." };
  }
  pendingUserInputs.delete(params.token);
  pending.resolveText(params.answerText);
  void resolveCodexControlDelivery(params.token).catch(() => undefined);
  return { consumed: true, message: "Sent answer to Codex." };
}

function buildUserInputInteractive(
  questions: UserInputQuestion[],
  token: string,
): MessagePresentation | undefined {
  if (
    questions.length > 1 &&
    !questions.every((question) => !question.isSecret && question.options?.length)
  ) {
    return undefined;
  }
  const buttons = questions.flatMap((question, questionIndex) => {
    if (question.isSecret || !question.options?.length) {
      return [];
    }
    return question.options.slice(0, 8).map((option, index) => ({
      label: questions.length === 1 ? option.label : `${question.header}: ${option.label}`,
      value:
        questions.length === 1
          ? buildCodexUserInputCallbackValue({ token, answerIndex: index + 1 })
          : buildCodexUserInputQuestionCallbackValue({
              token,
              questionIndex,
              answerIndex: index + 1,
            }),
      style: index === 0 ? ("primary" as const) : ("secondary" as const),
    }));
  });
  if (buttons.length === 0) {
    return undefined;
  }
  return { blocks: [{ type: "buttons", buttons }] };
}

function buildUserInputInteractiveForQuestion(
  question: UserInputQuestion,
  token: string,
  questionIndex: number,
): MessagePresentation | undefined {
  if (question.isSecret || !question.options?.length) {
    return undefined;
  }
  const buttons = question.options.slice(0, 8).map((option, index) => ({
    label: option.label,
    value: buildCodexUserInputQuestionCallbackValue({
      token,
      questionIndex,
      answerIndex: index + 1,
    }),
    style: index === 0 ? ("primary" as const) : ("secondary" as const),
  }));
  if (buttons.length === 0) {
    return undefined;
  }
  return { blocks: [{ type: "buttons", buttons }] };
}

export function buildCodexUserInputAnswerText(
  questions: UserInputQuestion[],
  answerText: string,
): string {
  const response = buildUserInputResponse(questions, answerText);
  return JSON.stringify(response);
}

function readControlScopeMismatch(
  pending: ControlScope,
  ctx: Pick<
    PluginCommandContext,
    "senderId" | "channel" | "accountId" | "sessionKey" | "messageThreadId"
  >,
  sessionFile?: string,
): string | undefined {
  if (sessionFile && sessionFile !== pending.sessionFile) {
    return "This Codex control belongs to a different OpenClaw session.";
  }
  if (pending.senderId && ctx.senderId && pending.senderId !== ctx.senderId) {
    return "Only the user who received this Codex control can use it.";
  }
  if (pending.channel && ctx.channel !== pending.channel) {
    return "This Codex control belongs to a different channel.";
  }
  if (pending.accountId && ctx.accountId !== pending.accountId) {
    return "This Codex control belongs to a different channel account.";
  }
  if (pending.sessionKey && ctx.sessionKey && pending.sessionKey !== ctx.sessionKey) {
    return "This Codex control belongs to a different OpenClaw session.";
  }
  if (
    pending.messageThreadId != null &&
    ctx.messageThreadId != null &&
    String(pending.messageThreadId) !== String(ctx.messageThreadId)
  ) {
    return "This Codex control belongs to a different thread.";
  }
  return undefined;
}

function parseCodexUserInputCallback(
  payload: string,
): { token: string; answerText: string; questionIndex?: number } | undefined {
  if (!payload.startsWith(CODEX_USER_INPUT_CALLBACK_PREFIX)) {
    return undefined;
  }
  const remainder = payload.slice(CODEX_USER_INPUT_CALLBACK_PREFIX.length);
  const parts = remainder.split(":");
  if (parts.length !== 2 && parts.length !== 3) {
    return undefined;
  }
  const token = parts[0];
  if (!token) {
    return undefined;
  }
  if (parts.length === 2) {
    const answerText = parts[1];
    return answerText ? { token, answerText } : undefined;
  }
  const questionIndex = Number(parts[1]) - 1;
  const answerText = parts[2];
  return Number.isInteger(questionIndex) && questionIndex >= 0 && answerText
    ? { token, questionIndex, answerText }
    : undefined;
}

function buildCodexUserInputQuestionCallbackValue(params: {
  token: string;
  questionIndex: number;
  answerIndex: number;
}): string {
  return `${CODEX_INTERACTIVE_NAMESPACE}:${CODEX_USER_INPUT_CALLBACK_PREFIX}${params.token}:${
    params.questionIndex + 1
  }:${params.answerIndex}`;
}

function buildCodexMergedFreeformAnswerText(
  pending: Pick<PendingUserInput, "questions" | "selectedAnswers">,
  answerText: string,
): string | undefined {
  const questions = pending.questions;
  if (questions.length <= 1) {
    return answerText;
  }
  const selectedAnswerCount = Object.keys(pending.selectedAnswers).length;
  if (selectedAnswerCount === 0) {
    return canFreeformAnswerAllQuestions(questions, answerText) ? answerText : undefined;
  }
  const freeformAnswers = parseCodexFreeformAnswersForUnselectedQuestions(
    questions,
    pending.selectedAnswers,
    answerText,
  );
  if (!freeformAnswers) {
    return undefined;
  }
  return questions
    .map(
      (question) =>
        `${question.id}: ${pending.selectedAnswers[question.id] ?? freeformAnswers[question.id]}`,
    )
    .join("\n");
}

function parseCodexFreeformAnswersForUnselectedQuestions(
  questions: UserInputQuestion[],
  selectedAnswers: Record<string, string>,
  answerText: string,
): Record<string, string> | undefined {
  const pendingQuestions = questions.filter((question) => !selectedAnswers[question.id]);
  if (pendingQuestions.length === 0 || pendingQuestions.some((question) => !question.isOther)) {
    return undefined;
  }
  const lines = readCodexFreeformAnswerLines(answerText);
  const keyed = readCodexFreeformKeyedAnswers(lines);
  const answers: Record<string, string> = {};
  const usePendingLineOrder =
    lines.length === pendingQuestions.length ||
    (pendingQuestions.length === 1 &&
      !readKeyedAnswerForQuestion(keyed, questions, pendingQuestions[0]));
  for (const question of pendingQuestions) {
    const questionIndex = questions.indexOf(question);
    const pendingQuestionIndex = pendingQuestions.indexOf(question);
    const answer =
      readKeyedAnswerForQuestion(keyed, questions, question) ??
      (usePendingLineOrder ? lines[pendingQuestionIndex] : lines[questionIndex]);
    if (!answer) {
      return undefined;
    }
    answers[question.id] = answer;
  }
  return answers;
}

/**
 * Normalize a typed freeform reply against a single question's rendered
 * options. Accepts: the numeric prefix the prompt renders (e.g. "1"),
 * the exact option label (case-insensitive), or the raw text. Returns
 * the canonical option label when one matched, or the raw answer
 * with matched: false so callers can decide whether to consume the
 * freeform fallback.
 */
function resolveFreeformOptionAnswer(
  question: UserInputQuestion,
  answerText: string,
): { matched: boolean; answer: string } {
  const options = question.options ?? [];
  if (options.length === 0) {
    return { matched: false, answer: answerText };
  }
  const trimmed = answerText.trim();
  if (!trimmed) {
    return { matched: false, answer: answerText };
  }
  // Numeric prefix: the prompt renders "1. label", "2. label" etc.
  if (/^\d+$/.test(trimmed)) {
    const index = Number(trimmed) - 1;
    const option = options[index];
    if (option) {
      return { matched: true, answer: option.label };
    }
    return { matched: false, answer: answerText };
  }
  // Exact label match (case-insensitive).
  const lowered = trimmed.toLowerCase();
  const exact = options.find((option) => option.label.toLowerCase() === lowered);
  if (exact) {
    return { matched: true, answer: exact.label };
  }
  return { matched: false, answer: answerText };
}

function canFreeformAnswerAllQuestions(
  questions: UserInputQuestion[],
  answerText: string,
): boolean {
  const lines = readCodexFreeformAnswerLines(answerText);
  if (lines.length >= questions.length) {
    return true;
  }
  const keyed = readCodexFreeformKeyedAnswers(lines);
  return questions.every((question) => {
    return Boolean(readKeyedAnswerForQuestion(keyed, questions, question));
  });
}

function readCodexFreeformAnswerLines(answerText: string): string[] {
  return answerText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function readCodexFreeformKeyedAnswers(lines: string[]): Map<string, string> {
  const keyed = new Map<string, string>();
  for (const line of lines) {
    const match = line.match(/^\s*([^:=-]+?)\s*[:=-]\s*(.+?)\s*$/);
    const key = match?.[1]?.trim().toLowerCase();
    const value = match?.[2]?.trim();
    if (key && value) {
      keyed.set(key, value);
    }
  }
  return keyed;
}

function readKeyedAnswerForQuestion(
  keyed: Map<string, string>,
  questions: UserInputQuestion[],
  question: UserInputQuestion,
): string | undefined {
  const index = questions.indexOf(question);
  return (
    keyed.get(question.id.toLowerCase()) ??
    keyed.get(question.header.toLowerCase()) ??
    keyed.get(question.question.toLowerCase()) ??
    keyed.get(String(index + 1))
  );
}

function pruneExpiredControls(now = Date.now()): void {
  pruneExpired(pendingPlanDecisions, now);
  pruneExpired(pendingUserInputs, now);
}

function pruneExpired<T extends { createdAt: number }>(entries: Map<string, T>, now: number): void {
  for (const [token, entry] of entries) {
    if (now - entry.createdAt >= CODEX_PENDING_CONTROL_TTL_MS) {
      entries.delete(token);
      getControlDeliveryResolvers().delete(token);
    }
  }
}

function trimOldest<T extends { createdAt: number }>(entries: Map<string, T>): void {
  while (entries.size > MAX_PENDING_CONTROLS) {
    const oldest = [...entries.entries()].toSorted(
      ([, left], [, right]) => left.createdAt - right.createdAt,
    )[0]?.[0];
    if (!oldest) {
      return;
    }
    entries.delete(oldest);
    getControlDeliveryResolvers().delete(oldest);
  }
}

function createToken(): string {
  return crypto.randomBytes(9).toString("base64url");
}

async function resolveCodexControlDelivery(token: string): Promise<void> {
  const resolvers = getControlDeliveryResolvers();
  const resolver = resolvers.get(token);
  if (!resolver) {
    return;
  }
  resolvers.delete(token);
  await resolver();
}
