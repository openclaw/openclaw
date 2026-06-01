import crypto from "node:crypto";
import type { MessagePresentation } from "openclaw/plugin-sdk/interactive-runtime";
import type { PluginCommandContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import {
  buildUserInputResponse,
  formatUserInputPrompt,
  type UserInputQuestion,
} from "./app-server/user-input-shared.js";

const PENDING_CONTROL_TTL_MS = 10 * 60_000;
const MAX_PENDING_CONTROLS = 200;
const PROPOSED_PLAN_RE = /<proposed_plan>[\s\S]*?<\/proposed_plan>/i;
const CODEX_INTERACTIVE_NAMESPACE = "codex";
const CODEX_USER_INPUT_CALLBACK_PREFIX = "input:";

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
  createdAt: number;
  resolveText: (text: string) => void;
};

const pendingPlanDecisions = new Map<string, PendingPlanDecision>();
const pendingUserInputs = new Map<string, PendingUserInput>();

export type CodexPlanDecisionResult =
  | { ok: true; sessionFile: string; threadId: string; planText: string }
  | { ok: false; message: string };

export function resetCodexConversationChatControlsForTests(): void {
  pendingPlanDecisions.clear();
  pendingUserInputs.clear();
}

export function hasCodexProposedPlan(text: string): boolean {
  return PROPOSED_PLAN_RE.test(text);
}

export function buildCodexPlanDecisionReply(params: {
  text: string;
  scope: ControlScope;
}): ReplyPayload {
  const token = createPendingPlanDecision({
    scope: params.scope,
    planText: extractCodexProposedPlan(params.text) ?? params.text,
  });
  return {
    text: params.text,
    presentation: {
      blocks: [
        {
          type: "buttons",
          buttons: [
            {
              label: "Approve and execute",
              value: `/codex plan approve ${token}`,
              style: "success",
            },
            {
              label: "Approve and execute with clean context",
              value: `/codex plan approve-clean ${token}`,
              style: "primary",
            },
            {
              label: "Stay in plan mode",
              value: `/codex plan stay ${token}`,
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
  const token = createPendingUserInput(params);
  const presentation = buildUserInputInteractive(params.questions, token);
  return {
    text: formatUserInputPrompt(params.questions),
    ...(presentation ? { presentation } : {}),
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
  pruneExpiredControls(params.now);
  const pending = pendingUserInputs.get(params.token);
  if (!pending) {
    return "No pending Codex input request was found. The request may have expired.";
  }
  const mismatch = readControlScopeMismatch(pending, params.ctx, params.sessionFile);
  if (mismatch) {
    return mismatch;
  }
  pendingUserInputs.delete(params.token);
  pending.resolveText(params.answerText);
  return "Sent answer to Codex.";
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
  const parsed = parseCodexUserInputCallback(params.payload);
  if (!parsed) {
    return undefined;
  }
  return answerCodexUserInput({
    token: parsed.token,
    answerText: parsed.answerText,
    ctx: params.ctx,
    sessionFile: params.sessionFile,
    now: params.now,
  });
}

export function buildCodexUserInputCallbackValue(params: {
  token: string;
  answerIndex: number;
}): string {
  return `${CODEX_INTERACTIVE_NAMESPACE}:${CODEX_USER_INPUT_CALLBACK_PREFIX}${params.token}:${
    params.answerIndex
  }`;
}

function extractCodexProposedPlan(text: string): string | undefined {
  const match = PROPOSED_PLAN_RE.exec(text);
  const raw = match?.[0];
  if (!raw) {
    return undefined;
  }
  return raw
    .replace(/^<proposed_plan>/i, "")
    .replace(/<\/proposed_plan>$/i, "")
    .trim();
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
}): string {
  pruneExpiredControls();
  const token = createToken();
  pendingUserInputs.set(token, {
    ...params.scope,
    token,
    questions: params.questions,
    resolveText: params.resolveText,
    createdAt: Date.now(),
  });
  trimOldest(pendingUserInputs);
  return token;
}

function buildUserInputInteractive(
  questions: UserInputQuestion[],
  token: string,
): MessagePresentation | undefined {
  const question = questions.length === 1 ? questions[0] : undefined;
  if (!question || question.isSecret || !question.options?.length) {
    return undefined;
  }
  const buttons = question.options.slice(0, 8).map((option, index) => ({
    label: option.label,
    value: buildCodexUserInputCallbackValue({ token, answerIndex: index + 1 }),
    style: index === 0 ? ("primary" as const) : ("secondary" as const),
  }));
  return buttons.length > 0 ? { blocks: [{ type: "buttons", buttons }] } : undefined;
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
): { token: string; answerText: string } | undefined {
  if (!payload.startsWith(CODEX_USER_INPUT_CALLBACK_PREFIX)) {
    return undefined;
  }
  const remainder = payload.slice(CODEX_USER_INPUT_CALLBACK_PREFIX.length);
  const separator = remainder.lastIndexOf(":");
  if (separator <= 0 || separator === remainder.length - 1) {
    return undefined;
  }
  const token = remainder.slice(0, separator);
  const answerText = remainder.slice(separator + 1);
  return token && answerText ? { token, answerText } : undefined;
}

function pruneExpiredControls(now = Date.now()): void {
  pruneExpired(pendingPlanDecisions, now);
  pruneExpired(pendingUserInputs, now);
}

function pruneExpired<T extends { createdAt: number }>(entries: Map<string, T>, now: number): void {
  for (const [token, entry] of entries) {
    if (now - entry.createdAt >= PENDING_CONTROL_TTL_MS) {
      entries.delete(token);
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
  }
}

function createToken(): string {
  return crypto.randomBytes(9).toString("base64url");
}
