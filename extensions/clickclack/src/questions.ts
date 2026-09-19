/**
 * Delivers agent ask_user questions as native ClickClack question cards and
 * connects card answers and Gateway outcomes back to each other.
 *
 * The Gateway owns the question and the waiting agent. ClickClack owns the card,
 * its answer validation, and the first-answer-wins rule. This module settles a
 * card from the Gateway outcome and forwards a submitted card to the Gateway.
 * That work belongs to the account start that delivered or adopted the card and
 * ends with it; the account's next start adopts cards that are still unresolved.
 */
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { questionGatewayRuntime } from "openclaw/plugin-sdk/question-gateway-runtime";
import type { ReplyPayload } from "openclaw/plugin-sdk/reply-payload";
import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { resolveClickClackInboundAccess } from "./access.js";
import {
  ClickClackHttpError,
  createClickClackClient,
  type ClickClackClient,
} from "./http-client.js";
import { sendClickClackQuestionMessage } from "./outbound.js";
import type {
  ClickClackAccountLifetime,
  ClickClackMessage,
  ClickClackMessageProvenance,
  ClickClackQuestionItem,
  ClickClackQuestionResolution,
  ClickClackQuestionSpec,
  ClickClackUser,
  ResolvedClickClackAccount,
} from "./types.js";

type QuestionRecord = NonNullable<Awaited<ReturnType<typeof questionGatewayRuntime.getQuestion>>>;

// Mirrors the ClickClack question contract. A record outside these limits keeps
// the plain-text prompt instead of failing delivery.
const CARD_ITEM_ID = /^[a-z][a-z0-9_]{0,63}$/u;
const GATEWAY_QUESTION_ID = /^ask_[a-f0-9]{32}$/u;
const MAX_CARD_ITEMS = 5;
const MAX_CARD_OPTIONS = 10;
const MAX_HEADER_LENGTH = 24;
const MAX_PROMPT_LENGTH = 1_000;
const MAX_LABEL_LENGTH = 80;
const MAX_DESCRIPTION_LENGTH = 200;
const MAX_URL_LENGTH = 2_048;
const MAX_NOTE_LENGTH = 200;
// ClickClack requires 10 seconds; the margin covers the send itself.
const MIN_CARD_LIFETIME_MS = 15_000;
const MAX_CARD_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;
const ANSWER_RETRY_DELAYS_MS = [2_000, 10_000] as const;

const NO_LONGER_WAITING_NOTE = "No longer waiting for this answer.";
const ANSWERED_ELSEWHERE_NOTE = "Answered in the conversation.";
const RESPONDER_NOT_ALLOWED_NOTE = "This agent does not accept answers from that person.";

type CardOutcome = Omit<ClickClackQuestionResolution, "expected_version">;

function characterCount(value: string): number {
  return [...value].length;
}

function hasLength(value: string, min: number, max: number): boolean {
  const count = characterCount(value);
  return count >= min && count <= max;
}

function truncateNote(value: string): string {
  const characters = [...value.trim()];
  return characters.length <= MAX_NOTE_LENGTH
    ? characters.join("")
    : `${characters.slice(0, MAX_NOTE_LENGTH - 1).join("")}…`;
}

function buildCardItem(
  question: QuestionRecord["questions"][number],
): ClickClackQuestionItem | null {
  const header = question.header.trim();
  const prompt = question.question.trim();
  if (
    question.isSecret ||
    question.secretStore ||
    !CARD_ITEM_ID.test(question.questionId) ||
    !hasLength(header, 1, MAX_HEADER_LENGTH) ||
    !hasLength(prompt, 1, MAX_PROMPT_LENGTH) ||
    question.options.length > MAX_CARD_OPTIONS
  ) {
    return null;
  }
  const seenLabels = new Set<string>();
  const options: NonNullable<ClickClackQuestionItem["options"]> = [];
  for (const option of question.options) {
    const label = option.label.trim();
    const description = option.description?.trim();
    // ClickClack compares labels without case; a record that differs only by
    // case cannot be represented faithfully on a card.
    const labelKey = label.toLowerCase();
    if (
      !hasLength(label, 1, MAX_LABEL_LENGTH) ||
      (description && characterCount(description) > MAX_DESCRIPTION_LENGTH) ||
      seenLabels.has(labelKey)
    ) {
      return null;
    }
    seenLabels.add(labelKey);
    options.push(description ? { label, description } : { label });
  }
  if (question.multiSelect && options.length < 2) {
    return null;
  }
  const url = question.url?.trim();
  if (url && (!/^https?:\/\//iu.test(url) || url.length > MAX_URL_LENGTH)) {
    return null;
  }
  return {
    id: question.questionId,
    header,
    prompt,
    ...(url ? { url } : {}),
    ...(options.length > 0 ? { options } : {}),
    ...(question.multiSelect ? { multi_select: true } : {}),
    ...(question.isOther ? { allow_other: true } : {}),
  };
}

/** Maps a pending Gateway question to a card, or returns null to keep the text prompt. */
export function buildClickClackQuestionSpec(
  record: QuestionRecord,
  nowMs = Date.now(),
): ClickClackQuestionSpec | null {
  const lifetimeMs = record.expiresAtMs - nowMs;
  if (
    record.status !== "pending" ||
    record.questions.length === 0 ||
    record.questions.length > MAX_CARD_ITEMS ||
    lifetimeMs < MIN_CARD_LIFETIME_MS ||
    lifetimeMs > MAX_CARD_LIFETIME_MS
  ) {
    return null;
  }
  const items: ClickClackQuestionItem[] = [];
  for (const question of record.questions) {
    const item = buildCardItem(question);
    if (!item) {
      return null;
    }
    items.push(item);
  }
  return {
    external_id: record.id,
    expires_at: new Date(record.expiresAtMs).toISOString(),
    allow_skip: true,
    items,
  };
}

function createAccountClient(account: ResolvedClickClackAccount): ClickClackClient {
  return createClickClackClient({ baseUrl: account.apiEndpoint, token: account.token });
}

async function readCardMessage(
  client: ClickClackClient,
  messageId: string,
): Promise<ClickClackMessage | null> {
  try {
    return await client.message(messageId);
  } catch (error) {
    if (error instanceof ClickClackHttpError && error.status === 404) {
      return null;
    }
    throw error;
  }
}

/**
 * Records an outcome unless the card changed first; the newer state wins.
 * Returns false when ClickClack reports that change or the account start stopped.
 */
async function recordCardOutcome(
  lifetime: ClickClackAccountLifetime,
  client: ClickClackClient,
  messageId: string,
  version: number,
  outcome: CardOutcome,
): Promise<boolean> {
  if (lifetime.abortSignal.aborted) {
    return false;
  }
  try {
    await client.resolveQuestion(messageId, { ...outcome, expected_version: version });
    return true;
  } catch (error) {
    if (error instanceof ClickClackHttpError && (error.status === 404 || error.status === 409)) {
      return false;
    }
    throw error;
  }
}

function outcomeForGatewayRecord(record: QuestionRecord | null): CardOutcome {
  switch (record?.status) {
    case "answered":
      return { status: "answered", note: ANSWERED_ELSEWHERE_NOTE };
    case "cancelled":
      return { status: "cancelled" };
    case "expired":
      return { status: "expired" };
    default:
      return { status: "failed", note: NO_LONGER_WAITING_NOTE };
  }
}

/** Settles an open card from its Gateway record; a live question leaves it open. */
async function settleOpenCard(params: {
  lifetime: ClickClackAccountLifetime;
  client: ClickClackClient;
  messageId: string;
  questionId: string;
  version: number;
}): Promise<void> {
  if (params.lifetime.abortSignal.aborted) {
    return;
  }
  // Finished records stay readable briefly, which covers the finalizer and a
  // watch that sees the card right after the question ended.
  const record = await questionGatewayRuntime.getQuestion({
    cfg: params.lifetime.cfg as OpenClawConfig,
    questionId: params.questionId,
  });
  if (record?.status !== "pending") {
    await recordCardOutcome(
      params.lifetime,
      params.client,
      params.messageId,
      params.version,
      outcomeForGatewayRecord(record),
    );
  }
}

/** Settles an open card after its Gateway question ended by another path. */
async function settleCardAfterGatewayOutcome(params: {
  lifetime: ClickClackAccountLifetime;
  messageId: string;
  questionId: string;
}): Promise<void> {
  if (params.lifetime.abortSignal.aborted) {
    return;
  }
  const client = createAccountClient(params.lifetime.account);
  const card = (await readCardMessage(client, params.messageId))?.question;
  // A submitted card belongs to the answer path, which records the result it gets.
  if (card?.status === "open") {
    await settleOpenCard({ ...params, client, version: card.version });
  }
}

const CARD_WATCH_INTERVAL_MS = 5_000;
const CARD_WATCH_GRACE_MS = 2 * 60_000;
// Each watched card maps to the signal of the account start watching it.
const watchedCards = new Map<string, AbortSignal>();

/**
 * Checks a delivered card until it settles. Realtime events forward answers
 * sooner, but an account's event socket cannot reconnect while the turn that
 * asked is still running, so this watch keeps answers and outcomes moving.
 */
function watchCard(params: {
  lifetime: ClickClackAccountLifetime;
  messageId: string;
  questionId: string;
  expiresAtMs: number;
}): void {
  const { lifetime } = params;
  const signal = lifetime.abortSignal;
  const key = `${lifetime.account.accountId} ${params.messageId}`;
  if (signal.aborted || watchedCards.get(key)?.aborted === false) {
    return;
  }
  watchedCards.set(key, signal);
  const client = createAccountClient(lifetime.account);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    clearTimeout(timer);
    signal.removeEventListener("abort", stop);
    if (watchedCards.get(key) === signal) {
      watchedCards.delete(key);
    }
  };
  signal.addEventListener("abort", stop, { once: true });
  const check = async (): Promise<boolean> => {
    if (Date.now() > params.expiresAtMs + CARD_WATCH_GRACE_MS) {
      return false;
    }
    const card = (await readCardMessage(client, params.messageId))?.question;
    if (signal.aborted) {
      return false;
    }
    if (card?.status === "submitted") {
      await forwardClickClackQuestionAnswer(params);
      return true;
    }
    if (card?.status === "open") {
      await settleOpenCard({ ...params, client, version: card.version });
      return true;
    }
    return false;
  };
  const tick = () => {
    void check()
      .catch(() => true)
      .then((keepWatching) => {
        if (keepWatching && !signal.aborted) {
          schedule();
        } else {
          stop();
        }
      });
  };
  const schedule = () => {
    // Checks run in the account start's context. A card delivered during a turn
    // would otherwise keep that turn's caller identity, which the Gateway rejects
    // once the turn ends.
    timer = setTimeout(() => lifetime.runInAccountContext(tick), CARD_WATCH_INTERVAL_MS);
    timer.unref?.();
  };
  schedule();
}

/**
 * Sends an ask_user prompt as a question card when the Gateway record fits one.
 * Returns false when the caller should send the plain-text prompt instead.
 */
export async function deliverClickClackQuestionPrompt(params: {
  lifetime: ClickClackAccountLifetime;
  payload: ReplyPayload;
  to: string;
  text: string;
  threadId?: string;
  replyToId?: string;
  provenance?: ClickClackMessageProvenance;
  correlationId?: string;
}): Promise<boolean> {
  const { lifetime } = params;
  const questionId = questionGatewayRuntime.readAskUserQuestionId(params.payload);
  // Only a running account start can follow a card to its outcome.
  if (!questionId || !GATEWAY_QUESTION_ID.test(questionId) || lifetime.abortSignal.aborted) {
    return false;
  }
  // A card is an upgrade over the text prompt, so a failed read keeps the text.
  const record = await questionGatewayRuntime
    .getQuestion({ cfg: lifetime.cfg as OpenClawConfig, questionId })
    .catch(() => null);
  const question = record ? buildClickClackQuestionSpec(record) : null;
  if (!record || !question || lifetime.abortSignal.aborted) {
    return false;
  }
  let message: ClickClackMessage;
  try {
    message = await sendClickClackQuestionMessage({
      cfg: lifetime.cfg,
      accountId: lifetime.account.accountId,
      to: params.to,
      text: params.text,
      question,
      threadId: params.threadId,
      replyToId: params.replyToId,
      provenance: params.provenance,
      correlationId: params.correlationId,
    });
  } catch (error) {
    // The server rejected the card itself; the text prompt still works.
    if (error instanceof ClickClackHttpError && error.status === 400) {
      return false;
    }
    throw error;
  }
  // Servers without questions store the body as an ordinary text prompt.
  if (message.question) {
    const card = { lifetime, messageId: message.id, questionId };
    questionGatewayRuntime.registerChannelDelivery({
      questionId,
      deliveryId: `clickclack:${lifetime.account.accountId}:${message.id}`,
      finalize: () => lifetime.runInAccountContext(() => settleCardAfterGatewayOutcome(card)),
    });
    watchCard({ ...card, expiresAtMs: record.expiresAtMs });
  }
  return true;
}

async function responderMayAnswer(params: {
  lifetime: ClickClackAccountLifetime;
  message: ClickClackMessage;
  responder: ClickClackUser;
}): Promise<boolean> {
  // Card answers follow the same sender policy as a typed reply in that conversation.
  const access = await resolveClickClackInboundAccess({
    account: params.lifetime.account,
    config: params.lifetime.cfg,
    message: {
      ...params.message,
      author_id: params.responder.id,
      author: params.responder,
      body: "",
      kind: "message",
      question: undefined,
    },
  });
  return !access.preparedRoute.revoked && access.channelIngress?.senderAccess.allowed === true;
}

const REOPEN_FOR_ALLOWED_RESPONDER: CardOutcome = {
  status: "open",
  note: RESPONDER_NOT_ALLOWED_NOTE,
};
const NO_LONGER_WAITING: CardOutcome = { status: "failed", note: NO_LONGER_WAITING_NOTE };

/**
 * Maps a terminal Gateway result for this card. A retry after a lost
 * acknowledgement also reads as terminal, so the record shows whether this card
 * already resolved the question.
 */
async function outcomeAfterTerminalResult(
  gateway: { cfg: OpenClawConfig; questionId: string; senderId: string },
  resolvedAs: "answered" | "cancelled",
): Promise<CardOutcome> {
  const record = await questionGatewayRuntime.getQuestion(gateway);
  return record?.status === resolvedAs && record.resolvedBy === gateway.senderId
    ? { status: resolvedAs }
    : NO_LONGER_WAITING;
}

async function forwardSubmittedCard(params: {
  lifetime: ClickClackAccountLifetime;
  messageId: string;
}): Promise<void> {
  const { lifetime } = params;
  const client = createAccountClient(lifetime.account);
  const message = await readCardMessage(client, params.messageId);
  const card = message?.question;
  const questionId = card?.external_id ?? "";
  const responder = card?.response?.responder;
  if (
    lifetime.abortSignal.aborted ||
    !message ||
    card?.status !== "submitted" ||
    !responder ||
    message.author_id !== lifetime.account.botUserId ||
    !GATEWAY_QUESTION_ID.test(questionId)
  ) {
    return;
  }
  // The Gateway asks again right before it records the answer, so a responder
  // who lost access or an account start that stopped cannot resolve it.
  const authorize = async () =>
    !lifetime.abortSignal.aborted &&
    (await responderMayAnswer({ lifetime, message, responder })) &&
    !lifetime.abortSignal.aborted;
  const gateway = {
    cfg: lifetime.cfg as OpenClawConfig,
    questionId,
    senderId: `clickclack:${responder.id}`,
    clientDisplayName: `ClickClack question (${responder.id})`,
    authorize,
  };
  let outcome: CardOutcome;
  if (!(await authorize())) {
    outcome = REOPEN_FOR_ALLOWED_RESPONDER;
  } else if (card.response?.skipped) {
    const result = await questionGatewayRuntime.cancelQuestion(gateway);
    outcome =
      result.status === "cancelled"
        ? { status: "cancelled" }
        : result.status === "denied"
          ? REOPEN_FOR_ALLOWED_RESPONDER
          : await outcomeAfterTerminalResult(gateway, "cancelled");
  } else {
    const result = await questionGatewayRuntime.resolveAnswers({
      ...gateway,
      answers: card.response?.answers ?? {},
    });
    outcome =
      result.status === "answered"
        ? { status: "answered" }
        : result.status === "invalid"
          ? { status: "open", note: truncateNote(result.message) }
          : result.status === "denied"
            ? REOPEN_FOR_ALLOWED_RESPONDER
            : await outcomeAfterTerminalResult(gateway, "answered");
  }
  const recorded = await recordCardOutcome(lifetime, client, message.id, card.version, outcome);
  if (recorded && outcome.status === "open") {
    // The question can end while the card reopens; its finalizer saw a
    // submitted card and left it alone.
    const reopened = (await readCardMessage(client, message.id))?.question;
    if (reopened?.status === "open") {
      await settleOpenCard({
        lifetime,
        client,
        messageId: message.id,
        questionId,
        version: reopened.version,
      });
    }
  }
}

const answersInFlight = new Map<string, { signal: AbortSignal; run: Promise<void> }>();

/**
 * Forwards a submitted card to the Gateway. Concurrent calls from one account
 * start share a run, and replays of a card that is no longer submitted do nothing.
 */
export function forwardClickClackQuestionAnswer(params: {
  lifetime: ClickClackAccountLifetime;
  messageId: string;
}): Promise<void> {
  const signal = params.lifetime.abortSignal;
  const key = `${params.lifetime.account.accountId} ${params.messageId}`;
  const inFlight = answersInFlight.get(key);
  // A newer start of the account does not join a run its stopped start began.
  if (inFlight?.signal === signal) {
    return inFlight.run;
  }
  const run: Promise<void> = (async () => {
    for (let attempt = 0; !signal.aborted; attempt += 1) {
      try {
        await forwardSubmittedCard(params);
        return;
      } catch (error) {
        const delayMs = ANSWER_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined || signal.aborted) {
          throw error;
        }
        await sleepWithAbort(delayMs, signal);
      }
    }
  })().finally(() => {
    if (answersInFlight.get(key)?.run === run) {
      answersInFlight.delete(key);
    }
  });
  answersInFlight.set(key, { signal, run });
  return run;
}

/**
 * Settles this bot's unresolved cards when an account starts and watches the
 * ones still waiting. Gateway questions do not survive a Gateway restart, so
 * open cards whose record is gone stop accepting answers; cards left by an
 * earlier start of the account in this process move to this start.
 */
export async function reconcileClickClackQuestions(params: {
  lifetime: ClickClackAccountLifetime;
  log?: { warn?: (message: string) => void };
}): Promise<void> {
  const { lifetime } = params;
  const client = createAccountClient(lifetime.account);
  let after: string | undefined;
  do {
    let page: Awaited<ReturnType<ClickClackClient["unresolvedQuestions"]>>;
    try {
      page = await client.unresolvedQuestions(after);
    } catch (error) {
      // Servers without questions have no cards to settle.
      if (error instanceof ClickClackHttpError && error.status === 404) {
        return;
      }
      throw error;
    }
    for (const row of page.questions) {
      if (lifetime.abortSignal.aborted) {
        return;
      }
      const questionId = row.external_id ?? "";
      if (!GATEWAY_QUESTION_ID.test(questionId)) {
        continue;
      }
      // Earlier starts no longer follow their cards. The watch settles a card this
      // pass leaves unresolved: still waiting, reopened, or unreachable just now.
      watchCard({
        lifetime,
        messageId: row.message_id,
        questionId,
        expiresAtMs: Date.parse(row.expires_at),
      });
      try {
        if (row.status === "submitted") {
          await forwardClickClackQuestionAnswer({ lifetime, messageId: row.message_id });
          continue;
        }
        const record = await questionGatewayRuntime.getQuestion({
          cfg: lifetime.cfg as OpenClawConfig,
          questionId,
        });
        if (record?.status === "pending") {
          continue;
        }
        const recorded = await recordCardOutcome(
          lifetime,
          client,
          row.message_id,
          row.version,
          outcomeForGatewayRecord(record),
        );
        if (!recorded) {
          // Someone answered after the listing; its event can predate the tail cursor.
          await forwardClickClackQuestionAnswer({ lifetime, messageId: row.message_id });
        }
      } catch (error) {
        if (lifetime.abortSignal.aborted) {
          return;
        }
        // One unreachable card must not keep the others open.
        params.log?.warn?.(
          `[${lifetime.account.accountId}] ClickClack question ${row.message_id} was not settled: ${String(error)}`,
        );
      }
    }
    after = page.nextCursor;
  } while (after && !lifetime.abortSignal.aborted);
}
