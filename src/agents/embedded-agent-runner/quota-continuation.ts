import { isDeepStrictEqual } from "node:util";
import { readSessionTranscriptContextMessagesAsync } from "../../config/sessions/session-transcript-read-worker-runtime.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { resolveAdmittedRunActiveAssertion } from "../admitted-run-context.js";
import type { AgentMessage } from "../runtime/index.js";
import { hasCommittedOutboundDeliveryEvidence } from "./delivery-evidence.js";
import {
  assertQuotaPrefixInProviderPayload,
  createQuotaSuccessorInventory,
  QUOTA_CONTINUATION_APIS,
} from "./quota-continuation-context.js";
import {
  hasTextOnlyHistoryContent,
  isSettledQuotaTranscript,
} from "./quota-continuation-transcript.js";
import { hasAttemptTerminalState } from "./run/attempt-terminal-evidence.js";
import type { RunEmbeddedAgentInternalParams } from "./run/internal-params.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";
import type { EmbeddedAgentRunResult } from "./types.js";

/** In-process, single-use host custody. Serializing or copying it grants nothing. */
export type QuotaContinuation = Readonly<{ kind: "settled-quota-continuation" }>;

type ContinuationState = {
  params: RunEmbeddedAgentInternalParams;
  transcriptAdmission: UserTurnTranscriptAdmissionReceipt;
  messages: readonly AgentMessage[];
  assertActive: () => void;
  quiescent: boolean;
  claimed: boolean;
  admittedHistory?: readonly AgentMessage[];
  successor?: ReturnType<typeof createQuotaSuccessorInventory>;
  canContinue?: () => boolean;
};
const offers = new WeakMap<EmbeddedAgentRunResult, QuotaContinuation>();
const states = new WeakMap<QuotaContinuation, ContinuationState>();
const MAX_CONTINUATION_MESSAGES = 4_096;
const MAX_CONTINUATION_BYTES = 4 * 1024 * 1024;

function assertTranscriptAdmissionCurrent(state: ContinuationState): void {
  const current = state.params.userTurnTranscriptRecorder?.getAdmissionReceipt();
  if (!current || !isDeepStrictEqual(current, state.transcriptAdmission)) {
    throw new Error("Quota continuation transcript admission changed");
  }
}

async function readCurrentTranscript(state: ContinuationState): Promise<AgentMessage[]> {
  state.assertActive();
  assertTranscriptAdmissionCurrent(state);
  if (state.canContinue && !state.canContinue()) {
    throw new Error("Quota continuation has committed delivery or lost its caller");
  }
  const target = state.params.sessionTarget;
  if (!target?.agentId || !target.sessionId || !target.sessionKey || !target.storePath) {
    throw new Error("Quota continuation has no durable transcript target");
  }
  const result = await readSessionTranscriptContextMessagesAsync(
    {
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
    },
    { maxMessages: MAX_CONTINUATION_MESSAGES, maxBytes: MAX_CONTINUATION_BYTES },
    undefined,
    state.params.abortSignal,
  );
  state.assertActive();
  assertTranscriptAdmissionCurrent(state);
  if (state.canContinue && !state.canContinue()) {
    throw new Error("Quota continuation has committed delivery or lost its caller");
  }
  if (result.kind === "limit-exceeded") {
    throw new Error("Quota continuation transcript exceeds bounded worker limits");
  }
  return result.messages;
}

async function assertTranscriptCurrent(state: ContinuationState): Promise<void> {
  const history = await readCurrentTranscript(state);
  const matches = (() => {
    // Only the latest user turn can be continued. Earlier matching text is not a receipt.
    let tail: AgentMessage[] = [];
    const admittedHistory: AgentMessage[] = [];
    for (const message of history) {
      // The successor loads the entire model context, not merely the settled suffix.
      // A text-only current turn must not silently transfer older attachments.
      if (!hasTextOnlyHistoryContent(message)) {
        return false;
      }
      admittedHistory.push(message);
      if (message.role === "user") {
        tail = [];
      }
      tail.push(message);
      if (tail.length > state.messages.length) {
        // Keep scanning for a later user boundary, without retaining an unbounded suffix.
        tail = tail.slice(-state.messages.length - 1);
      }
    }
    if (!isDeepStrictEqual(tail, state.messages)) {
      return false;
    }
    if (state.admittedHistory && !isDeepStrictEqual(state.admittedHistory, admittedHistory)) {
      return false;
    }
    state.admittedHistory ??= structuredClone(admittedHistory);
    return true;
  })();
  state.assertActive();
  if (!matches) {
    throw new Error("Quota continuation transcript changed or is not durably settled");
  }
}

type QuotaContinuationOfferInput = {
  params: RunEmbeddedAgentInternalParams;
  attempt: EmbeddedRunAttemptResult;
  result: EmbeddedAgentRunResult;
  tainted: boolean;
};

/** Called by the host after a harness returned, with its tool capabilities already closed. */
export async function offerQuotaContinuation(input: QuotaContinuationOfferInput): Promise<void> {
  try {
    await offerQuotaContinuationIfSettled(input);
  } catch {
    // Optional proof must never turn an unsafe result into a generic thrown retry.
    // Keep the original quota and replay-veto diagnostics even for malformed evidence.
    offers.delete(input.result);
  }
}

async function offerQuotaContinuationIfSettled(input: QuotaContinuationOfferInput): Promise<void> {
  const { params, attempt, result } = input;
  const evidence = attempt.settledQuotaContinuation;
  const admitted = params.admittedRunContext;
  const recorder = params.userTurnTranscriptRecorder;
  const user = recorder?.getPersistedMessage?.();
  const admission = recorder?.getAdmissionReceipt();
  const target = params.sessionTarget;
  const hostUser =
    recorder?.hasPersisted() &&
    user &&
    admission &&
    admission.agentId === target?.agentId &&
    admission.sessionId === params.sessionId &&
    admission.sessionKey === params.sessionKey &&
    admission.storePath === target?.storePath
      ? user
      : undefined;
  // Native attempts omit the prompt when the host already owns its durable row.
  const evidenceMessages =
    evidence && Array.isArray(evidence.messages)
      ? evidence.messages[0]?.role !== "user" && hostUser
        ? [hostUser, ...evidence.messages]
        : evidence.messages
      : undefined;
  if (
    !evidence ||
    evidence.reason !== "quota_exhausted" ||
    !admitted ||
    !admission ||
    !hostUser ||
    input.tainted ||
    params.sessionPersistence === "detached" ||
    params.sessionManager ||
    params.modelSelectionLocked ||
    params.authProfileIdSource === "user" ||
    params.pluginRuntimeRefreshContinuation ||
    !params.quotaBudget ||
    params.quotaBudget.remainingMs(params.timeoutMs) <= 0 ||
    params.clientTools?.length ||
    params.images?.length ||
    params.media?.length ||
    attempt.terminal.kind !== "failed" ||
    attempt.runtimeContinuationStarted ||
    attempt.itemLifecycle.activeCount !== 0 ||
    attempt.itemLifecycle.startedCount === 0 ||
    attempt.itemLifecycle.completedCount !== attempt.itemLifecycle.startedCount ||
    attempt.toolMetas.length === 0 ||
    attempt.toolMetas.some(
      (tool) => tool.isError !== false || tool.asyncStarted || tool.codeModeSuspended,
    ) ||
    hasAttemptTerminalState(attempt) ||
    hasCommittedOutboundDeliveryEvidence(result) ||
    result.meta.aborted ||
    result.meta.timeoutPhase ||
    result.meta.modelFallbackStopReason ||
    result.meta.error?.kind !== "incomplete_turn" ||
    !evidenceMessages ||
    !isSettledQuotaTranscript(evidenceMessages)
  ) {
    return;
  }
  const assertActive = resolveAdmittedRunActiveAssertion(admitted, params.abortSignal);
  if (!assertActive) {
    return;
  }
  let messages: readonly AgentMessage[];
  try {
    messages = structuredClone(evidenceMessages);
  } catch {
    return;
  }
  const token: QuotaContinuation = Object.freeze({ kind: "settled-quota-continuation" });
  const state: ContinuationState = {
    params,
    transcriptAdmission: structuredClone(admission),
    messages,
    assertActive,
    quiescent: false,
    claimed: false,
  };
  try {
    await assertTranscriptCurrent(state);
    states.set(token, state);
    offers.set(result, token);
  } catch {
    // Failure to prove custody retains the original quota and replay veto.
  }
}

/** A logical result can precede tracked cleanup; it is not a handoff barrier. */
export async function settleQuotaContinuation(
  result: EmbeddedAgentRunResult,
  cleanup: Promise<void>,
): Promise<void> {
  const token = offers.get(result);
  const state = token && states.get(token);
  if (!token || !state) {
    return;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const settled = await Promise.race([
      cleanup.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), 5_000);
        timer.unref?.();
      }),
    ]);
    if (!settled) {
      offers.delete(result);
      states.delete(token);
      return;
    }
    await assertTranscriptCurrent(state);
    state.quiescent = true;
  } catch {
    offers.delete(result);
    states.delete(token);
  } finally {
    clearTimeout(timer);
  }
}

export async function readQuotaContinuation(
  result: EmbeddedAgentRunResult,
  identity: { runId: string; sessionId: string; sessionKey?: string },
  canContinue: () => boolean,
): Promise<QuotaContinuation | undefined> {
  const token = offers.get(result);
  const state = token && states.get(token);
  if (
    !state ||
    !state.quiescent ||
    state.claimed ||
    state.params.runId !== identity.runId ||
    state.params.sessionId !== identity.sessionId ||
    state.params.sessionKey !== identity.sessionKey
  ) {
    return undefined;
  }
  try {
    state.canContinue ??= canContinue;
    await assertTranscriptCurrent(state);
    return token;
  } catch {
    return undefined;
  }
}

/** Once dispatch consumed custody, even a thrown failure cannot advance the model chain. */
export function isQuotaContinuationClaimed(token: QuotaContinuation): boolean {
  return states.get(token)?.claimed === true;
}

/** The successor must reuse the exact live admission; matching run IDs are insufficient. */
export async function claimQuotaContinuation(
  token: QuotaContinuation,
  params: RunEmbeddedAgentInternalParams,
  harnessId: string,
  modelApi = "",
): Promise<void> {
  const state = states.get(token);
  if (
    !state ||
    !state.quiescent ||
    state.claimed ||
    !state.canContinue ||
    harnessId !== "openclaw" ||
    !QUOTA_CONTINUATION_APIS.has(modelApi) ||
    params.quotaBudget !== state.params.quotaBudget ||
    remainingQuotaContinuationMs(token, params.timeoutMs) <= 0 ||
    params.admittedRunContext !== state.params.admittedRunContext ||
    params.runId !== state.params.runId ||
    params.sessionId !== state.params.sessionId ||
    params.sessionKey !== state.params.sessionKey ||
    !isDeepStrictEqual(params.sessionTarget, state.params.sessionTarget) ||
    params.modelSelectionLocked ||
    params.authProfileIdSource === "user" ||
    params.images?.length ||
    params.media?.length ||
    params.provider === state.params.provider
  ) {
    throw new Error("Quota continuation lost its exact admitted turn or fallback target");
  }
  await assertTranscriptCurrent(state);
  state.claimed = true;
}

/** The existing timeout owner arms this remainder; no second watchdog is created. */
export function remainingQuotaContinuationMs(token: QuotaContinuation, cap: number): number {
  const state = states.get(token);
  if (!state) {
    return 0;
  }
  state.assertActive();
  return state.params.quotaBudget?.remainingMs(cap) ?? 0;
}

/** Called after provider transforms/onPayload, immediately before transport admission. */
export async function assertQuotaContinuationProviderPayload(
  token: QuotaContinuation,
  payload: unknown,
  api: string,
  continuationPrompt: string,
): Promise<void> {
  const state = states.get(token);
  if (
    !state?.claimed ||
    !state.quiescent ||
    remainingQuotaContinuationMs(token, Number.POSITIVE_INFINITY) <= 0
  ) {
    throw new Error(
      "Quota continuation custody or execution budget expired before provider dispatch",
    );
  }
  state.assertActive();
  const target = state.params.sessionTarget;
  const admitted = state.admittedHistory;
  const outcomes = state.successor;
  if (
    !target?.agentId ||
    !target.sessionId ||
    !target.sessionKey ||
    !target.storePath ||
    !admitted ||
    !outcomes
  ) {
    throw new Error("Quota continuation has no owned context inventory");
  }
  const current = await readCurrentTranscript(state);
  if (
    !isDeepStrictEqual(current.slice(0, admitted.length), admitted) ||
    current.some((message) => !hasTextOnlyHistoryContent(message))
  ) {
    throw new Error("Quota continuation admitted context changed");
  }
  const successor = outcomes.assert(current.slice(admitted.length));
  assertQuotaPrefixInProviderPayload(state.messages, payload, api, {
    before: admitted.slice(0, admitted.length - state.messages.length),
    after: [{ role: "user", content: continuationPrompt }, ...successor],
  });
}

/** Attach only to the owned agent loop, before extension callbacks can transform facts. */
export function bindQuotaContinuationSuccessor(token: QuotaContinuation) {
  const state = states.get(token);
  if (!state?.claimed || state.successor) {
    throw new Error("Quota continuation successor observation already bound or unclaimed");
  }
  state.successor = createQuotaSuccessorInventory();
  return state.successor.record;
}
