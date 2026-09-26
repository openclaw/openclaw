import { stableStringify } from "@openclaw/normalization-core";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseInput, ResponseOutputItem } from "openai/resources/responses/responses.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import { registerSessionResourceCleanup } from "../session-resources.js";
import { parseJsonObjectPreservingUnsafeIntegers } from "./json-unsafe-integers.js";
import {
  canReferenceResponsesReasoningHistory,
  replayResponsesReasoningUpdates,
  type ResponsesConfigurationUpdate,
} from "./openai-responses-reasoning-update.js";
import {
  normalizeOpenAIResponsesFunctionCallId,
  shouldNormalizeOpenAIResponsesToolCallId,
  splitOpenAIFunctionCallPairing,
} from "./openai-responses-tool-call-id-shape.js";
import { sha256Hex } from "./transport-utils.js";

const HTTP_CONTINUATION_IDLE_TTL_MS = 5 * 60 * 1000;
const TURN_HEADERS = new Set(["traceparent", "x-openclaw-turn-id", "x-openclaw-turn-attempt"]);

export type ResponsesContinuationRequest = Record<string, unknown> & {
  input?: Array<ResponseInput[number] | ResponsesConfigurationUpdate>;
  previous_response_id?: string;
};
export type ResponsesSteeringContinuationMode = "automatic" | "required-input";
export type ResponsesContinuationState = {
  lastRequest: ResponsesContinuationRequest;
  lastResponseId: string;
  lastResponseItems: ResponseOutputItem[];
};
export type ResponsesContinuationStatus =
  | "continued"
  | "explicit_previous_response_id"
  | "history_changed"
  | "history_shorter"
  | "no_previous_response"
  | "request_changed";

function jsonValuesEqual(left: object, right: object): boolean {
  // Normalize the left side first to preserve serialization errors and toJSON ordering.
  const leftJson = JSON.stringify(left) as string;
  const normalizedLeft = stableStringify(JSON.parse(leftJson));
  const rightJson = JSON.stringify(right) as string;
  return leftJson === rightJson || normalizedLeft === stableStringify(JSON.parse(rightJson));
}

function requestWithoutInput(request: ResponsesContinuationRequest): ResponsesContinuationRequest {
  // Instructions and tools apply to the current response and remain on every wire request.
  const {
    input: _input,
    previous_response_id: _previousResponseId,
    instructions: _instructions,
    tools: _tools,
    ...rest
  } = request;
  if (!isRecord(rest.metadata)) {
    return rest;
  }
  const metadata = Object.fromEntries(
    Object.entries(rest.metadata).filter(
      ([key]) => key !== "openclaw_turn_id" && key !== "openclaw_turn_attempt",
    ),
  );
  return { ...rest, metadata };
}

// Canonicalizes a call_id/fc_id through the exact same shaping replay applies
// (normalizeOpenAIResponsesToolCallIds in embedded-agent-helpers, mirrored
// here as normalizeOpenAIResponsesFunctionCallId since packages/ai cannot
// import from src/agents), for BOTH sides of the comparison -- the cached
// raw provider function_call still carries its separate, un-reshaped
// `call_id` and item `id` fields exactly as the provider returned them, and
// a replayed item can equally arrive either already agent-reshaped (pass
// through an AgentMessage[] transform) or, for a direct transport caller
// that preserves same-model tool-call ids verbatim
// (transcript-transform.ts's transformMessages), completely unreshaped --
// still carrying the provider's own separate call_id/id pair, identically
// to the cached side. Pairing call_id with id (when present) before
// reshaping, on both sides, is required for that unchanged-raw-id replay to
// canonicalize to the very same value the cached side computed: reshaping
// only the bare call_id (dropping id) hashes a different input than the
// cached side's pair and permanently, incorrectly forces history_changed.
// Idempotent on an already-reshaped id -- it only touches ids that don't
// already match the provider's own call_*/fc_* shape -- so a raw provider
// id and the client's replayed reshaping of that same id both canonicalize
// to the same value. This replaces a blanket call_id drop: dropping it
// entirely would treat *any* changed function-call id as the same known
// reshape, masking a genuinely different tool call.
function canonicalizeToolCallId(callId: unknown, itemId: unknown): unknown {
  if (typeof callId !== "string") {
    return callId;
  }
  const paired = typeof itemId === "string" && itemId ? `${callId}|${itemId}` : callId;
  // Already-valid call_*/fc_* ids (the common case once a provider itself
  // returns provider-shaped ids) never get reshaped by replay either --
  // mirror that exact idempotent short-circuit, or a validly-shaped pair
  // would be needlessly re-hashed here into a value replay never produces.
  if (!shouldNormalizeOpenAIResponsesToolCallId(paired)) {
    return callId;
  }
  return splitOpenAIFunctionCallPairing(normalizeOpenAIResponsesFunctionCallId(paired)).callId;
}

// fromResponse is true only for continuation.lastResponseItems (the cached
// raw provider output), never for the replayed request's own input -- both
// the call_id pairing above and the unsafe-integer handling below need to
// know which side they're on, so this one flag drives both.
//
// ignoreCachedItemIds (fromResponse side only) computes the cached call_id
// as if it had no item id to pair with, even though the cached raw response
// always has one. This exists for a real replay shape the pairing above
// can't otherwise match: a direct transport caller can configure
// replayResponsesItemIds:false, which omits function_call.id from the wire
// while preserving its raw, non-canonical call_id verbatim -- that replayed
// item structurally has no id to pair with, so it always canonicalizes via
// the bare-call_id branch. The cached side must be compared against both
// candidates (see resolveResponsesContinuationRequest) since either shape
// is a legitimate "unchanged" replay depending on that per-connection
// setting, not something this function can know on its own.
function normalizeAssistantReplayInput(
  input: readonly unknown[],
  fromResponse = false,
  ignoreCachedItemIds = false,
): unknown[] {
  return input.map((item) => {
    if (!isRecord(item)) {
      return item;
    }
    if (item.type === "reasoning") {
      return { type: "reasoning" };
    }
    if (
      item.type !== "function_call" &&
      item.type !== "function_call_output" &&
      !(item.type === "message" && item.role === "assistant")
    ) {
      return item;
    }
    const { id: rawId, status: _status, ...stableItem } = item;
    if ("call_id" in stableItem) {
      // Pair with the item's own raw id on both sides (see
      // canonicalizeToolCallId): a replayed item can arrive either already
      // agent-reshaped or, for a direct transport caller that preserves
      // same-model tool-call ids verbatim, completely unreshaped and paired
      // exactly like the cached side.
      const itemId = fromResponse && ignoreCachedItemIds ? undefined : rawId;
      stableItem.call_id = canonicalizeToolCallId(stableItem.call_id, itemId);
    }
    if (fromResponse && item.type === "function_call") {
      // Only provider output crosses terminal admission; sent arguments must retain real type edits.
      const args = parseJsonObjectPreservingUnsafeIntegers(stableItem.arguments);
      stableItem.arguments = args ? JSON.stringify(args) : stableItem.arguments;
    }
    if (item.type === "message" && Array.isArray(stableItem.content)) {
      stableItem.content = stableItem.content.map((part) => {
        if (!isRecord(part) || part.type !== "output_text") {
          return part;
        }
        const { annotations: _annotations, logprobs: _logprobs, ...stablePart } = part;
        return stablePart;
      });
    }
    return stableItem;
  });
}

export function responsesContinuationRequestFingerprint(
  request: ResponsesContinuationRequest,
): string {
  const serialized = JSON.stringify(requestWithoutInput(request));
  return sha256Hex(stableStringify(JSON.parse(serialized)));
}

export function responsesContinuationPrefixFingerprint(
  input: readonly unknown[],
  output: readonly unknown[] = [],
): string {
  const serialized = JSON.stringify([
    ...normalizeAssistantReplayInput(input),
    ...normalizeAssistantReplayInput(output, true),
  ]);
  return sha256Hex(stableStringify(JSON.parse(serialized)));
}

// The wire-bound delta (sent under previous_response_id) still carries
// whatever call_id the client's own replay reshaping produced for a
// function_call_output referencing a call from continuation.lastResponseItems
// -- that's the exact id mismatch normalizeAssistantReplayInput tolerates
// for the eligibility comparison above, but the comparison result is never
// sent. Rewrite it back to the raw id the provider actually returned (and
// this module cached) before the delta goes out, so a server that
// reconstructs full history from its own cached copy of that raw response
// (e.g. a proxy virtualizing previous_response_id server-side) sees a
// function_call_output whose call_id matches the function_call it's pairing
// against, instead of an orphaned id it silently drops.
function restoreRawCallIdsInDelta(
  delta: readonly unknown[],
  cachedResponseItems: readonly unknown[],
): unknown[] {
  const rawCallIdByReshaped = new Map<string, string>();
  for (const item of cachedResponseItems) {
    if (!isRecord(item) || item.type !== "function_call" || typeof item.call_id !== "string") {
      continue;
    }
    const rawCallId = item.call_id;
    // Mirror the eligibility comparison's pairing: the delta's call_id was
    // reshaped from the paired call_id|id, not the bare call_id alone.
    const reshaped = canonicalizeToolCallId(rawCallId, item.id);
    if (typeof reshaped === "string" && reshaped !== rawCallId) {
      rawCallIdByReshaped.set(reshaped, rawCallId);
    }
  }
  if (rawCallIdByReshaped.size === 0) {
    // No rewrite needed: `delta` is returned as-is.
    // SAFETY: callers only read the result (assign to `input`) and never mutate it in place, so the `readonly` -> mutable widening is inert.
    return delta as unknown[];
  }
  return delta.map((item) => {
    if (!isRecord(item) || typeof item.call_id !== "string") {
      return item;
    }
    const rawCallId = rawCallIdByReshaped.get(item.call_id);
    return rawCallId ? { ...item, call_id: rawCallId } : item;
  });
}

export function resolveResponsesContinuationRequest(
  continuation: ResponsesContinuationState | undefined,
  request: ResponsesContinuationRequest,
  steering?: ResponsesSteeringContinuationMode,
): {
  request: ResponsesContinuationRequest;
  fullRequest?: ResponsesContinuationRequest;
  continuationStatus: ResponsesContinuationStatus;
} {
  if (!continuation) {
    return { request, continuationStatus: "no_previous_response" };
  }
  if (request.previous_response_id) {
    return { request, continuationStatus: "explicit_previous_response_id" };
  }
  // Referenced controls remain active even when omitted from the wire delta.
  // Check compatibility whether the caller supplied them or needs rehydration.
  if (!canReferenceResponsesReasoningHistory(continuation.lastRequest, request)) {
    return { request, continuationStatus: "request_changed" };
  }
  const prepared = replayResponsesReasoningUpdates(
    continuation.lastRequest,
    request,
    continuation.lastResponseItems.length,
    steering,
  );
  // Required input creates a new response with current settings. The same
  // history validation below still binds it to the accepted steering's parent.
  if (
    steering !== "required-input" &&
    !jsonValuesEqual(requestWithoutInput(prepared), requestWithoutInput(continuation.lastRequest))
  ) {
    return { request, continuationStatus: "request_changed" };
  }
  const currentInput = prepared.input ?? [];
  const previousInput = continuation.lastRequest.input ?? [];
  const baselineLength = previousInput.length + continuation.lastResponseItems.length;
  if (currentInput.length < baselineLength) {
    return { request, continuationStatus: "history_shorter" };
  }
  const replayedToolRound = normalizeAssistantReplayInput(
    currentInput.slice(previousInput.length, baselineLength),
  );
  // Compared against two candidate cached-history shapes: normally paired
  // with the cached response item's own id (matches both an agent-reshaped
  // replay and a direct-transport replay that preserves the full raw
  // call_id/id pair unchanged), or, failing that, ignoring the cached id
  // entirely (matches a direct-transport replay whose connection disables
  // item-id replay -- see normalizeAssistantReplayInput's own note). Both
  // are legitimate "nothing about this call actually changed" shapes; which
  // one a given connection produces depends on its own replayResponsesItemIds
  // setting, not something knowable here.
  const historyToolRoundUnchanged =
    jsonValuesEqual(
      replayedToolRound,
      normalizeAssistantReplayInput(continuation.lastResponseItems, true),
    ) ||
    jsonValuesEqual(
      replayedToolRound,
      normalizeAssistantReplayInput(continuation.lastResponseItems, true, true),
    );
  if (
    !jsonValuesEqual(
      normalizeAssistantReplayInput(currentInput.slice(0, previousInput.length)),
      normalizeAssistantReplayInput(previousInput),
    ) ||
    !historyToolRoundUnchanged
  ) {
    return { request, continuationStatus: "history_changed" };
  }
  const restoredInput = restoreRawCallIdsInDelta(
    currentInput.slice(baselineLength),
    continuation.lastResponseItems,
  );
  // restoreRawCallIdsInDelta only rewrites `call_id` string fields on items
  // already sliced from `currentInput` (itself a ResponseInput); it never
  // adds, removes, or reshapes an item, so the result is still valid input.
  // SAFETY: shape preserved by restoreRawCallIdsInDelta as documented above.
  const restoredResponseInput = restoredInput as ResponseInput;
  return {
    request: {
      ...prepared,
      previous_response_id: continuation.lastResponseId,
      input: restoredResponseInput,
    },
    ...(prepared !== request ? { fullRequest: prepared } : {}),
    continuationStatus: "continued",
  };
}

type HttpContinuationEntry =
  | {
      kind: "ready";
      sessionId: string;
      state: ResponsesContinuationState;
      idleTimer: ReturnType<typeof setTimeout>;
    }
  | { kind: "claimed"; sessionId: string };

const httpContinuationEntries = new Map<string, HttpContinuationEntry>();

function deleteHttpContinuationIfOwned(key: string, entry: HttpContinuationEntry): void {
  if (httpContinuationEntries.get(key) === entry) {
    httpContinuationEntries.delete(key);
  }
}

type HttpContinuationIdentity = {
  apiKey: string;
  baseUrl: string;
  headers: Record<string, string>;
};
type ContinuationResponse = { id: string; output: ResponseOutputItem[] };

function connectionIdentity(params: HttpContinuationIdentity): string {
  const headers = Object.entries(resolveAiTransportHeaderSentinels(params.headers) ?? {})
    .map(([name, value]) => [name.toLowerCase(), value] as const)
    .filter(([name]) => !TURN_HEADERS.has(name))
    .toSorted(([a], [b]) => a.localeCompare(b));
  return sha256Hex(
    JSON.stringify([
      getAiTransportHost().resolveSecretSentinel(params.apiKey),
      params.baseUrl,
      headers,
    ]),
  );
}

export function claimOpenAIResponsesHttpContinuation(
  params: HttpContinuationIdentity & {
    sessionId: string;
    request: ResponsesContinuationRequest;
    restoreRequest?: () => ResponsesContinuationRequest;
  },
) {
  const key = `${params.sessionId}\0${connectionIdentity(params)}`;
  const previous = httpContinuationEntries.get(key);
  if (previous?.kind === "claimed") {
    return undefined;
  }
  if (previous?.kind === "ready") {
    clearTimeout(previous.idleTimer);
  }
  const claimed = { kind: "claimed", sessionId: params.sessionId } as const;
  httpContinuationEntries.set(key, claimed);
  try {
    const request =
      previous?.kind === "ready" ? params.request : (params.restoreRequest?.() ?? params.request);
    const resolved = resolveResponsesContinuationRequest(
      previous?.kind === "ready" ? previous.state : undefined,
      request,
    );
    const fullRequest = resolved.fullRequest ?? request;
    return {
      // Unstored HTTP responses cannot be referenced, but their prompt prefix can still be cached.
      request: params.request.store === false ? fullRequest : resolved.request,
      fullRequest,
      commit: (effectiveRequest: ResponsesContinuationRequest, response: ContinuationResponse) => {
        if (httpContinuationEntries.get(key) !== claimed) {
          return;
        }
        const ready = {
          ...claimed,
          kind: "ready",
          state: {
            lastRequest: effectiveRequest,
            lastResponseId: response.id,
            lastResponseItems: response.output,
          },
          idleTimer: setTimeout(
            () => deleteHttpContinuationIfOwned(key, ready),
            HTTP_CONTINUATION_IDLE_TTL_MS,
          ),
        } satisfies Extract<HttpContinuationEntry, { kind: "ready" }>;
        ready.idleTimer.unref?.();
        httpContinuationEntries.set(key, ready);
      },
      release: () => deleteHttpContinuationIfOwned(key, claimed),
    };
  } catch (error) {
    // Preparation failed before the caller received a handle that could release this claim.
    deleteHttpContinuationIfOwned(key, claimed);
    throw error;
  }
}

registerSessionResourceCleanup((sessionId) => {
  for (const [key, entry] of httpContinuationEntries) {
    if (!sessionId || entry.sessionId === sessionId) {
      if (entry.kind === "ready") {
        clearTimeout(entry.idleTimer);
      }
      httpContinuationEntries.delete(key);
    }
  }
});
