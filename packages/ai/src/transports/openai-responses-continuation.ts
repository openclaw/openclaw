import { isDeepStrictEqual } from "node:util";
import { isProxy } from "node:util/types";
import type { ModelRequestHeaders } from "@openclaw/llm-core";
import { sha256StableValue } from "@openclaw/normalization-core/node-crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { ResponseInput, ResponseOutputItem } from "openai/resources/responses/responses.js";
import { getAiTransportHost, resolveAiTransportHeaderSentinels } from "../host.js";
import {
  getSessionResourceOwnerId,
  registerSessionResourceCleanup,
  type SessionResourceOwner,
} from "../session-resources.js";
import { parseJsonObjectPreservingUnsafeIntegers } from "./json-unsafe-integers.js";
import type { OpenAIResponsesRequestParams } from "./openai-responses-contracts.js";
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

// Keep completed baselines across ordinary conversation gaps; ready entries are
// bounded by count and serialized content size so the longer idle window cannot
// retain an unbounded backlog. Session cleanup discards them earlier.
const HTTP_CONTINUATION_IDLE_TTL_MS = 90 * 60 * 1000;
const MAX_HTTP_CONTINUATION_READY_ENTRIES = 1000;
const MAX_HTTP_CONTINUATION_RETAINED_BYTES = 64 * 1024 * 1024;
const TURN_HEADERS = new Set(["traceparent", "x-openclaw-turn-id", "x-openclaw-turn-attempt"]);

export type ResponsesContinuationRequest = Record<string, unknown> &
  Pick<OpenAIResponsesRequestParams, "service_tier" | "max_output_tokens"> & {
    input?: Array<ResponseInput[number] | ResponsesConfigurationUpdate>;
    previous_response_id?: string;
  };
export type ResponsesSteeringContinuationMode = "automatic" | "required-input";
export type ResponsesContinuationState = {
  lastRequest: ResponsesContinuationRequest;
  lastResponseId: string;
  lastResponseItems: ResponseOutputItem[];
  pendingToolCalls?: Array<{ callId: string; itemId?: string }>;
};
type ContinuationResponse = { id: string; output: ResponseOutputItem[] };
export type ResponsesContinuationStatus =
  | "continued"
  | "explicit_previous_response_id"
  | "history_changed"
  | "history_shorter"
  | "no_previous_response"
  | "request_changed";

// Keep text by reference instead of encoding/parsing it solely for comparison.
// Hook-provided opaque values still use native JSON, including the property's key.
function projectJsonValue(value: unknown, key: string, ancestors: Set<object>): unknown {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value + 0 : null;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (value === undefined || typeof value === "symbol") {
    return undefined;
  }
  if (
    typeof value !== "object" ||
    isProxy(value) ||
    Object.getPrototypeOf(value) !== (Array.isArray(value) ? Array.prototype : Object.prototype) ||
    "toJSON" in value ||
    ancestors.has(value)
  ) {
    // oxlint-disable-next-line unicorn/prefer-structured-clone -- Preserve JSON/toJSON semantics, not object identity.
    const projected: Record<string, unknown> = JSON.parse(
      JSON.stringify({ __proto__: null, [key]: value }),
    );
    return Object.hasOwn(projected, key) ? projected[key] : undefined;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: unknown[] = [];
      const length = value.length;
      for (let index = 0; index < length; index++) {
        result.push(projectJsonValue(value[index], String(index), ancestors) ?? null);
      }
      return result;
    }
    const fields: [string, unknown][] = [];
    for (const name of Object.keys(value)) {
      const member = projectJsonValue(Reflect.get(value, name), name, ancestors);
      if (member !== undefined) {
        fields.push([name, member]);
      }
    }
    return Object.fromEntries(fields);
  } finally {
    ancestors.delete(value);
  }
}

function jsonValuesEqual(left: object, right: object): boolean {
  const normalize = (value: object) => {
    const projected = projectJsonValue(value, "", new Set());
    // A root toJSON returning undefined was not a valid JSON comparison either.
    return projected === undefined ? JSON.parse("undefined") : projected;
  };
  // Finish the left side before evaluating any right-side hook values.
  return isDeepStrictEqual(normalize(left), normalize(right));
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

// Match replay's ID shaping while keeping unrelated ID edits visible to history checks.
function canonicalizeToolCallId(callId: unknown, itemId: unknown): unknown {
  if (typeof callId !== "string") {
    return callId;
  }
  const paired = typeof itemId === "string" && itemId ? `${callId}|${itemId}` : callId;
  // Replay leaves provider-shaped IDs untouched; match that short-circuit.
  if (!shouldNormalizeOpenAIResponsesToolCallId(paired)) {
    return callId;
  }
  return splitOpenAIFunctionCallPairing(normalizeOpenAIResponsesFunctionCallId(paired)).callId;
}

type ResponsesContinuationToolCall = { callId: string; itemId?: string };

function responseToolCalls(items: readonly unknown[]): ResponsesContinuationToolCall[] {
  return items.flatMap((item) => {
    if (!isRecord(item) || item.type !== "function_call" || typeof item.call_id !== "string") {
      return [];
    }
    return [{ callId: item.call_id, ...(typeof item.id === "string" ? { itemId: item.id } : {}) }];
  });
}

function toolCallReplayShapes(call: ResponsesContinuationToolCall): Set<string> {
  return new Set(
    [
      call.callId,
      canonicalizeToolCallId(call.callId, call.itemId),
      canonicalizeToolCallId(call.callId, undefined),
    ].filter((shape): shape is string => typeof shape === "string"),
  );
}

function toolCallOwnerByReplayShape(
  calls: readonly ResponsesContinuationToolCall[],
): Map<string, number | null> {
  const ownerByReplayShape = new Map<string, number | null>();
  for (const [index, call] of calls.entries()) {
    for (const replayShape of toolCallReplayShapes(call)) {
      const owner = ownerByReplayShape.get(replayShape);
      ownerByReplayShape.set(replayShape, owner === undefined || owner === index ? index : null);
    }
  }
  return ownerByReplayShape;
}

export function recordResponsesContinuationState(
  previous: ResponsesContinuationState | undefined,
  lastRequest: ResponsesContinuationRequest,
  response: ContinuationResponse,
  continued = false,
): ResponsesContinuationState {
  const calls =
    previous && continued
      ? [...(previous.pendingToolCalls ?? []), ...responseToolCalls(previous.lastResponseItems)]
      : responseToolCalls(lastRequest.input ?? []);
  const seenCalls = new Set<string>();
  const uniqueCalls = calls.filter((call) => {
    const key = JSON.stringify([call.callId, call.itemId]);
    if (seenCalls.has(key)) {
      return false;
    }
    seenCalls.add(key);
    return true;
  });
  // A later response can supersede the one that introduced an unresolved async call.
  // Keep its raw ID while the full transcript still has the call but no output.
  const input: readonly unknown[] = lastRequest.input ?? [];
  const ownerByReplayShape = toolCallOwnerByReplayShape(uniqueCalls);
  const replayedCallIds = new Set<string>();
  const lastCallPosition = new Map<number, number>();
  const lastOutputPosition = new Map<number, number>();
  for (const [inputIndex, item] of input.entries()) {
    if (!isRecord(item) || typeof item.call_id !== "string") {
      continue;
    }
    const owner = ownerByReplayShape.get(item.call_id);
    if (item.type === "function_call") {
      replayedCallIds.add(item.call_id);
    }
    const positions =
      item.type === "function_call"
        ? lastCallPosition
        : item.type === "function_call_output"
          ? lastOutputPosition
          : undefined;
    if (positions && owner !== undefined && owner !== null) {
      positions.set(owner, inputIndex);
    }
  }
  const pendingToolCalls = uniqueCalls.filter((_call, index) => {
    const callPosition = lastCallPosition.get(index);
    return (
      [...toolCallReplayShapes(_call)].some((shape) => replayedCallIds.has(shape)) &&
      (callPosition === undefined || (lastOutputPosition.get(index) ?? -1) < callPosition)
    );
  });
  return {
    lastRequest,
    lastResponseId: response.id,
    // Hosted search runs on the server and has no transcript block, so replay never
    // sends it back. The server keeps it under previous_response_id.
    lastResponseItems: response.output.filter((item) => item.type !== "web_search_call"),
    pendingToolCalls,
  };
}

// Cached output keeps raw IDs; compare with and without the item ID because replay may omit it.
// `fromResponse` also gates provider-output argument normalization below.
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
    if (item.type === "function_call_output") {
      // Output ID and status affect replayed input; keep them in the prefix comparison.
      if ("id" in item) {
        stableItem.id = item.id;
      }
      if ("status" in item) {
        stableItem.status = item.status;
      }
    }
    if ("call_id" in stableItem) {
      // Only function_call pairs IDs; function_call_output references the bare call ID.
      const itemId =
        item.type === "function_call" && !(fromResponse && ignoreCachedItemIds) ? rawId : undefined;
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

// Compare tool results by their uniquely identified call occurrence, not a lossy ID alias.
function normalizeContinuationHistory(input: readonly unknown[]): unknown[] | undefined {
  const normalized = normalizeAssistantReplayInput(input);
  const calls = responseToolCalls(input);
  const ownerByReplayShape = toolCallOwnerByReplayShape(calls);
  let callIndex = 0;
  for (const [index, item] of input.entries()) {
    const normalizedItem = normalized[index];
    if (!isRecord(item) || !isRecord(normalizedItem)) {
      continue;
    }
    if (item.type === "function_call") {
      if (typeof normalizedItem.call_id !== "string") {
        return undefined;
      }
      const callOwner = ownerByReplayShape.get(normalizedItem.call_id);
      if (callOwner !== callIndex) {
        return undefined;
      }
      normalizedItem.call_id = { callOwner };
      callIndex += 1;
      continue;
    }
    if (item.type !== "function_call_output" || typeof item.call_id !== "string") {
      continue;
    }
    const owner = ownerByReplayShape.get(item.call_id);
    if (owner === null) {
      return undefined;
    }
    normalizedItem.call_id =
      owner === undefined
        ? { unknownCallId: canonicalizeToolCallId(item.call_id, undefined) }
        : { callOwner: owner };
  }
  return normalized;
}

export function responsesContinuationRequestFingerprint(
  request: ResponsesContinuationRequest,
): string {
  const serialized = JSON.stringify(requestWithoutInput(request));
  return sha256StableValue(JSON.parse(serialized)).digest;
}

export function responsesContinuationPrefixFingerprint(
  input: readonly unknown[],
  output: readonly unknown[] = [],
): string {
  const serialized = JSON.stringify([
    ...normalizeAssistantReplayInput(input),
    ...normalizeAssistantReplayInput(output, true),
  ]);
  return sha256StableValue(JSON.parse(serialized)).digest;
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
  const currentInput: readonly unknown[] = prepared.input ?? [];
  const previousInput: readonly unknown[] = continuation.lastRequest.input ?? [];
  const baselineLength = previousInput.length + continuation.lastResponseItems.length;
  if (currentInput.length < baselineLength) {
    return { request, continuationStatus: "history_shorter" };
  }
  const replayedToolRoundInput = currentInput.slice(previousInput.length, baselineLength);
  const replayedToolRound = normalizeAssistantReplayInput(replayedToolRoundInput);
  // Replay may keep or omit function_call.id, so compare both cached forms.
  const historyToolRoundUnchanged = [false, true].some((ignoreCachedItemIds) =>
    jsonValuesEqual(
      replayedToolRound,
      normalizeAssistantReplayInput(continuation.lastResponseItems, true, ignoreCachedItemIds),
    ),
  );
  const historyCurrentInput = currentInput.slice(0, previousInput.length);
  for (const [index, previousItem] of previousInput.entries()) {
    const currentItem = historyCurrentInput[index];
    if (!isRecord(previousItem) || !isRecord(currentItem)) {
      continue;
    }
    if (previousItem.type === "function_call" && currentItem.type === "function_call") {
      if (
        typeof previousItem.call_id === "string" &&
        typeof currentItem.call_id === "string" &&
        !toolCallReplayShapes({
          callId: previousItem.call_id,
          ...(typeof previousItem.id === "string" ? { itemId: previousItem.id } : {}),
        }).has(currentItem.call_id)
      ) {
        return { request, continuationStatus: "history_changed" };
      }
    }
    if (
      previousItem.type === "function_call_output" &&
      currentItem.type === "function_call_output" &&
      typeof previousItem.call_id === "string" &&
      typeof currentItem.call_id === "string" &&
      currentItem.call_id !== previousItem.call_id &&
      currentItem.call_id !== canonicalizeToolCallId(previousItem.call_id, undefined)
    ) {
      return { request, continuationStatus: "history_changed" };
    }
  }
  const normalizedPrevious = normalizeContinuationHistory(previousInput);
  const normalizedCurrent = normalizeContinuationHistory(historyCurrentInput);
  if (
    !(
      normalizedPrevious !== undefined &&
      normalizedCurrent !== undefined &&
      jsonValuesEqual(normalizedCurrent, normalizedPrevious)
    ) ||
    !historyToolRoundUnchanged
  ) {
    return { request, continuationStatus: "history_changed" };
  }
  // Restore accepted replay IDs in the delta to match the provider's cached call.
  const delta = currentInput.slice(baselineLength);
  const cachedResponseItems = continuation.lastResponseItems;
  const pendingToolCalls = continuation.pendingToolCalls ?? [];
  const currentResponseCalls = responseToolCalls(cachedResponseItems);
  const replayedCalls = replayedToolRoundInput.filter(
    (item): item is Record<string, unknown> => isRecord(item) && item.type === "function_call",
  );
  if (currentResponseCalls.length !== replayedCalls.length) {
    return { request, continuationStatus: "history_changed" };
  }

  const cachedCalls = [...pendingToolCalls, ...currentResponseCalls];
  const currentCallOffset = pendingToolCalls.length;
  const ownerByReplayShape = toolCallOwnerByReplayShape(cachedCalls);

  // Lossy shaping is safe only when a replayed call or output has one cached owner.
  for (const index of currentResponseCalls.keys()) {
    const replayedCallId = replayedCalls[index]?.call_id;
    if (
      typeof replayedCallId !== "string" ||
      ownerByReplayShape.get(replayedCallId) !== currentCallOffset + index
    ) {
      return { request, continuationStatus: "history_changed" };
    }
  }

  const restoredInput: unknown[] = [];
  for (const item of delta) {
    if (
      !isRecord(item) ||
      item.type !== "function_call_output" ||
      typeof item.call_id !== "string"
    ) {
      restoredInput.push(item);
      continue;
    }
    const owner = ownerByReplayShape.get(item.call_id);
    // Unknown or shared shapes cannot identify a cached call; resend full history to preserve pairing.
    if (owner === undefined || owner === null) {
      return { request, continuationStatus: "history_changed" };
    }
    const rawCallId = cachedCalls[owner]?.callId;
    if (!rawCallId) {
      return { request, continuationStatus: "history_changed" };
    }
    restoredInput.push(rawCallId === item.call_id ? item : { ...item, call_id: rawCallId });
  }
  // Restoration only changes output call IDs on items sliced from current input;
  // unknown or ambiguous IDs reject continuation before this cast.
  // SAFETY: restoration above preserves item shape as documented above.
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
      owner: SessionResourceOwner;
      state: ResponsesContinuationState;
      idleTimer: ReturnType<typeof setTimeout>;
      retainedBytes: number;
    }
  | { kind: "claimed"; sessionId: string; owner: SessionResourceOwner };

const httpContinuationEntries = new Map<string, HttpContinuationEntry>();
// Commit order owns eviction order. Index only ready entries so eviction work
// stays bounded even when many requests are still in flight.
const readyHttpContinuationEntries = new Map<
  string,
  Extract<HttpContinuationEntry, { kind: "ready" }>
>();
// Updated with ready-entry insertion/removal; no full-cache scan on commit.
let httpContinuationRetainedBytes = 0;

// Keep timer closures outside the attempt scope, which retains prior baselines and callers.
function createHttpContinuationTimer(key: string): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    const entry = httpContinuationEntries.get(key);
    if (entry?.kind === "ready" && entry.idleTimer === timer) {
      deleteHttpContinuationIfOwned(key, entry);
    }
  }, HTTP_CONTINUATION_IDLE_TTL_MS);
  timer.unref?.();
  return timer;
}

// Timers and released handles must not remove a replacement claim.
function deleteHttpContinuationIfOwned(key: string, entry: HttpContinuationEntry): void {
  if (httpContinuationEntries.get(key) !== entry) {
    return;
  }
  if (entry.kind === "ready") {
    clearTimeout(entry.idleTimer);
    httpContinuationRetainedBytes -= entry.retainedBytes;
    readyHttpContinuationEntries.delete(key);
  }
  httpContinuationEntries.delete(key);
}

// Evict oldest committed baselines until the incoming entry fits both bounds.
function evictReadyEntriesForCapacity(pendingBytes: number): void {
  for (;;) {
    const overCapacity = readyHttpContinuationEntries.size >= MAX_HTTP_CONTINUATION_READY_ENTRIES;
    const overBudget =
      httpContinuationRetainedBytes + pendingBytes > MAX_HTTP_CONTINUATION_RETAINED_BYTES;
    if (!overCapacity && !overBudget) {
      return;
    }
    const oldest = readyHttpContinuationEntries.entries().next();
    if (oldest.done) {
      return;
    }
    const [oldestKey, oldestEntry] = oldest.value;
    deleteHttpContinuationIfOwned(oldestKey, oldestEntry);
  }
}

type HttpContinuationIdentity = {
  apiKey: string;
  baseUrl: string;
  headers: ModelRequestHeaders;
};

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
  const owner = getAiTransportHost();
  const key = `${getSessionResourceOwnerId(owner)}\0${params.sessionId}\0${connectionIdentity(params)}`;
  const previous = httpContinuationEntries.get(key);
  if (previous?.kind === "claimed") {
    return undefined;
  }
  if (previous) {
    deleteHttpContinuationIfOwned(key, previous);
  }
  const request = previous ? params.request : (params.restoreRequest?.() ?? params.request);
  const resolved = resolveResponsesContinuationRequest(previous?.state, request);
  const fullRequest = resolved.fullRequest ?? request;
  const continuationRequest = params.request.store === false ? fullRequest : resolved.request;
  const claimed = { kind: "claimed", sessionId: params.sessionId, owner } as const;
  httpContinuationEntries.set(key, claimed);
  return {
    // Unstored HTTP responses cannot be referenced, but their prompt prefix can still be cached.
    request: continuationRequest,
    fullRequest,
    commit: (
      effectiveRequest: ResponsesContinuationRequest,
      response: ContinuationResponse,
      dispatchedPreviousResponseId?: string,
    ) => {
      if (httpContinuationEntries.get(key) !== claimed) {
        return;
      }
      const state = recordResponsesContinuationState(
        previous?.state,
        effectiveRequest,
        response,
        previous !== undefined && dispatchedPreviousResponseId === previous.state.lastResponseId,
      );
      // Serialized-content budget, not JavaScript heap overhead.
      const retainedBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
      if (retainedBytes > MAX_HTTP_CONTINUATION_RETAINED_BYTES) {
        // Keep other sessions when this baseline cannot fit alone. Its next
        // request sends full history; the completed response remains valid.
        deleteHttpContinuationIfOwned(key, claimed);
        return;
      }
      evictReadyEntriesForCapacity(retainedBytes);
      const ready = {
        ...claimed,
        kind: "ready",
        state,
        idleTimer: owner.runInDetachedAsyncContext(() => createHttpContinuationTimer(key)),
        retainedBytes,
      } satisfies Extract<HttpContinuationEntry, { kind: "ready" }>;
      httpContinuationRetainedBytes += retainedBytes;
      httpContinuationEntries.set(key, ready);
      readyHttpContinuationEntries.set(key, ready);
    },
    release: () => deleteHttpContinuationIfOwned(key, claimed),
  };
}

registerSessionResourceCleanup((sessionId, owner) => {
  for (const [key, entry] of httpContinuationEntries) {
    if ((!owner || entry.owner === owner) && (!sessionId || entry.sessionId === sessionId)) {
      deleteHttpContinuationIfOwned(key, entry);
    }
  }
});
