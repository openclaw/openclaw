import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord as asRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionTranscriptContextMessages } from "../../config/sessions/session-accessor.sqlite-model-context.js";
import {
  canonicalizePersistedUserMessageMedia,
  readPersistedMediaFacts,
  readRuntimePromptMediaFacts,
} from "../../media/media-facts.js";
import { resolveAdmittedRunActiveAssertion } from "../admitted-run-context.js";
import type { AgentMessage } from "../runtime/index.js";
import { hasCommittedOutboundDeliveryEvidence } from "./delivery-evidence.js";
import {
  assertQuotaPrefixInProviderPayload,
  createQuotaSuccessorInventory,
  QUOTA_CONTINUATION_APIS,
} from "./quota-continuation-context.js";
import { hasAttemptTerminalState } from "./run/attempt-terminal-evidence.js";
import type { RunEmbeddedAgentInternalParams } from "./run/internal-params.js";
import {
  readPersistedMediaImageLayout,
  readPersistedImageBlockFactIndexes,
} from "./run/prompt-image-metadata.js";
import type { EmbeddedRunAttemptResult } from "./run/types.js";
import type { EmbeddedAgentRunResult } from "./types.js";

/** In-process, single-use host custody. Serializing or copying it grants nothing. */
export type QuotaContinuation = Readonly<{ kind: "settled-quota-continuation" }>;

type ContinuationState = {
  params: RunEmbeddedAgentInternalParams;
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

/** This first handoff contract does not authorize transferring historical media. */
function hasTextOnlyHistoryContent(message: AgentMessage): boolean {
  const record = asRecord(message);
  const role = record?.role;
  if (!record || (role !== "user" && role !== "assistant" && role !== "toolResult")) {
    return false;
  }
  try {
    const persisted =
      role === "user" ? canonicalizePersistedUserMessageMedia(record).message : record;
    // Text captions can hydrate into images/video on the destination. Consult the
    // same media-fact owner as normal replay, including legacy persisted envelopes.
    if (
      readRuntimePromptMediaFacts(record)?.length ||
      readPersistedMediaFacts(persisted)?.length ||
      readPersistedMediaImageLayout(message) ||
      readPersistedImageBlockFactIndexes(message)?.length
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const content: unknown = record.content;
  if (typeof content === "string") {
    return true;
  }
  if (!Array.isArray(content)) {
    return false;
  }
  return content.every((part: unknown) => {
    const block = asRecord(part);
    if (block?.type === "text") {
      return typeof block.text === "string";
    }
    if (role === "assistant" && block?.type === "thinking") {
      return typeof block.thinking === "string";
    }
    if (role === "assistant" && block?.type === "toolCall") {
      return (
        typeof block.id === "string" &&
        typeof block.name === "string" &&
        Boolean(asRecord(block.arguments))
      );
    }
    return (
      role === "toolResult" &&
      block?.type === "toolResult" &&
      typeof block.text === "string" &&
      block.content === block.text
    );
  });
}

/** Validate the entire current turn, not just its last tool batch. */
export function isSettledQuotaTranscript(messages: readonly AgentMessage[]): boolean {
  const rawMessages: unknown = messages;
  if (
    !Array.isArray(rawMessages) ||
    messages.length < 3 ||
    messages.length > 256 ||
    messages[0]?.role !== "user"
  ) {
    return false;
  }
  const calls = new Map<string, string>();
  const results = new Set<string>();
  let bytes = 0;
  for (const [index, message] of messages.entries()) {
    if (!message || typeof message !== "object" || !hasTextOnlyHistoryContent(message)) {
      return false;
    }
    try {
      bytes += Buffer.byteLength(JSON.stringify(message));
    } catch {
      return false;
    }
    if (bytes > 512 * 1024) {
      return false;
    }
    if (message.role === "user") {
      if (
        index !== 0 ||
        (typeof message.content !== "string" && !Array.isArray(message.content)) ||
        (Array.isArray(message.content) && message.content.some((part) => part.type !== "text"))
      ) {
        return false;
      }
    } else if (message.role === "assistant") {
      if (calls.size !== results.size || !Array.isArray(message.content)) {
        return false;
      }
      for (const part of message.content) {
        if (!part || typeof part !== "object") {
          return false;
        }
        if (part.type !== "toolCall") {
          continue;
        }
        if (
          typeof part.id !== "string" ||
          !part.id.trim() ||
          typeof part.name !== "string" ||
          !part.name.trim() ||
          calls.has(part.id)
        ) {
          return false;
        }
        calls.set(part.id, part.name);
      }
    } else if (message.role === "toolResult") {
      if (
        typeof message.toolCallId !== "string" ||
        !message.toolCallId.trim() ||
        typeof message.toolName !== "string" ||
        !message.toolName.trim() ||
        calls.get(message.toolCallId) !== message.toolName ||
        results.has(message.toolCallId) ||
        asRecord(message)?.isError !== false ||
        !Array.isArray(message.content) ||
        message.content.some((part) => {
          const block = asRecord(part);
          if (block?.type === "text" && typeof block.text === "string") {
            return false;
          }
          // The persisted native mirror uses a text-bearing toolResult block.
          // Validate its complete call identity instead of treating it as new work.
          return !(
            block?.type === "toolResult" &&
            typeof block.text === "string" &&
            block.content === block.text &&
            ["id", "toolCallId", "toolUseId", "tool_use_id"].every(
              (key) => block[key] === message.toolCallId,
            ) &&
            ["name", "toolName"].every((key) => block[key] === message.toolName)
          );
        })
      ) {
        return false;
      }
      results.add(message.toolCallId);
    } else {
      return false;
    }
  }
  return calls.size > 0 && calls.size === results.size;
}

function assertTranscriptCurrent(state: ContinuationState): void {
  state.assertActive();
  if (state.canContinue && !state.canContinue()) {
    throw new Error("Quota continuation has committed delivery or lost its caller");
  }
  const target = state.params.sessionTarget;
  if (!target?.agentId || !target.sessionId || !target.sessionKey || !target.storePath) {
    throw new Error("Quota continuation has no durable transcript target");
  }
  const matches = readSessionTranscriptContextMessages(
    {
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
    },
    (history) => {
      // Only the latest user turn can be continued. Earlier matching text is not a receipt.
      let tail: AgentMessage[] = [];
      const admittedHistory: AgentMessage[] = [];
      let bytes = 0;
      for (const message of history) {
        // The successor loads the entire model context, not merely the settled suffix.
        // A text-only current turn must not silently transfer older attachments.
        if (!hasTextOnlyHistoryContent(message)) {
          return false;
        }
        bytes += Buffer.byteLength(JSON.stringify(message));
        if (admittedHistory.length >= 4096 || bytes > 4 * 1024 * 1024) {
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
    },
  );
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
export function offerQuotaContinuation(input: QuotaContinuationOfferInput): void {
  try {
    offerQuotaContinuationIfSettled(input);
  } catch {
    // Optional proof must never turn an unsafe result into a generic thrown retry.
    // Keep the original quota and replay-veto diagnostics even for malformed evidence.
    offers.delete(input.result);
  }
}

function offerQuotaContinuationIfSettled(input: QuotaContinuationOfferInput): void {
  const { params, attempt, result } = input;
  const evidence = attempt.settledQuotaContinuation;
  const admitted = params.admittedRunContext;
  const recorder = params.userTurnTranscriptRecorder;
  const user = recorder?.getPersistedMessage?.();
  const admission = recorder?.getAdmissionReceipt();
  const hostUser =
    recorder?.hasPersisted() &&
    user &&
    admission &&
    admission.agentId === params.sessionTarget?.agentId &&
    admission.sessionId === params.sessionId &&
    admission.sessionKey === params.sessionKey &&
    admission.storePath === params.sessionTarget?.storePath
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
    messages,
    assertActive,
    quiescent: false,
    claimed: false,
  };
  try {
    assertTranscriptCurrent(state);
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
    assertTranscriptCurrent(state);
    state.quiescent = true;
  } catch {
    offers.delete(result);
    states.delete(token);
  } finally {
    clearTimeout(timer);
  }
}

export function readQuotaContinuation(
  result: EmbeddedAgentRunResult,
  identity: { runId: string; sessionId: string; sessionKey?: string },
  canContinue: () => boolean,
): QuotaContinuation | undefined {
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
    assertTranscriptCurrent(state);
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
export function claimQuotaContinuation(
  token: QuotaContinuation,
  params: RunEmbeddedAgentInternalParams,
  harnessId: string,
  modelApi = "",
): void {
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
  assertTranscriptCurrent(state);
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
export function assertQuotaContinuationProviderPayload(
  token: QuotaContinuation,
  payload: unknown,
  api: string,
  continuationPrompt: string,
): void {
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
  readSessionTranscriptContextMessages(
    {
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      storePath: target.storePath,
    },
    (history) => {
      const current = [...history];
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
    },
  );
  state.assertActive();
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
