/** Browser-safe identity and replay rules shared by Gateway conversation clients. */

import { asNullableRecord as readRecord } from "@openclaw/normalization-core/record-coerce";
import {
  canRecoverSessionProjectionFinal,
  hasSessionProjectionAcceptedFinal,
  findUniqueSnapshotTerminalMatch,
  isUnsequencedLiveTerminal,
  isSessionProjectionToolContinuation,
  isToolUsePersistedFinalRow,
  readFinalContentIdentity,
  readSessionProjectionFinalMessageIdentity,
} from "./session-projection-final-identity.js";
import {
  hasDisplayableSessionMessage,
  isSessionProjectionErrorMessage,
} from "./session-projection-message-content.js";
import {
  createSessionProjectionEntry as createEntry,
  isLocallyOptimisticSessionMessage,
  sameTranscriptIdentity,
  normalizeSessionProjectionRunId,
  readAssistantStreamSegmentIdentity,
  sameAssistantPersistenceReceipt,
  readSessionProjectionString as readNonemptyString,
  type SessionMessageEnvelope,
  type SessionMessageIdentity,
  type SessionProjectionEntry,
} from "./session-projection-message-identity.js";
import { retainSessionProjectionRuns } from "./session-projection-run-retention.js";
export {
  hasSessionProjectionAcceptedFinal,
  readSessionProjectionFinalMessageIdentity,
} from "./session-projection-final-identity.js";
export {
  reduceSessionProjectionRunEvent,
  type SessionProjectionGatewayRunEvent,
  type SessionProjectionRunTransition,
} from "./session-projection-run-event.js";

export {
  isLocallyOptimisticSessionMessage,
  normalizeSessionProjectionRunId,
  readAssistantStreamSegmentIdentity,
  readSessionMessageIdentity,
  readSessionMessageSequence,
} from "./session-projection-message-identity.js";
export {
  isSessionProjectionErrorMessage,
  projectSessionTerminalReplyMessage,
} from "./session-projection-message-content.js";
export type {
  SessionProjectionEntry,
  SessionMessageEnvelope,
  SessionMessageIdentity,
} from "./session-projection-message-identity.js";

export type SessionProjectionScope = {
  sessionKey?: string;
  sessionId?: string;
  agentId?: string;
  lifecycleRevision?: number | string;
  activeLeafEntryId?: string | null;
};

export type SessionProjectionSnapshotOptions = {
  shouldIncludeMessage?: (message: unknown) => boolean;
};

export type SessionProjectionRunStatus =
  | "streaming"
  | "completed"
  | "error"
  | "aborted"
  | "timeout"
  | "yielded";

export type SessionProjectionRun = {
  runId: string;
  seq?: number;
  status: SessionProjectionRunStatus;
  message?: unknown;
  acceptedFinalMessageIdentities?: readonly string[];
  inferredSnapshotTerminal?: {
    entry: SessionProjectionEntry;
    matchedIdentity: SessionMessageIdentity;
  };
  stopReason?: string;
  errorKind?: string;
  errorMessage?: string;
};

export type SessionProjectionState = {
  scope: SessionProjectionScope;
  entries: readonly SessionProjectionEntry[];
  messages: readonly unknown[];
  runs: Readonly<Record<string, SessionProjectionRun>>;
  hasTransportGap: boolean;
};

const MAX_ACCEPTED_FINAL_MESSAGES_PER_RUN = 32;
const SESSION_PROJECTION_SCOPE_KEYS = [
  "sessionKey",
  "sessionId",
  "agentId",
  "lifecycleRevision",
  "activeLeafEntryId",
] as const;

type ScopedSessionProjectionEvent = SessionProjectionScope & { scope?: SessionProjectionScope };

export type SessionProjectionEvent = ScopedSessionProjectionEvent &
  (
    | {
        type: "snapshotLoaded";
        messages: readonly unknown[];
        options?: SessionProjectionSnapshotOptions;
      }
    | ({
        type: "messagePersisted";
        message: unknown;
        envelope?: SessionMessageEnvelope;
      } & SessionMessageEnvelope)
    | { type: "sendPending"; message: unknown; runId?: string; idempotencyKey?: string }
    | {
        type: "sendAcknowledged";
        runId?: string;
        idempotencyKey?: string;
        previousRunId?: string;
      }
    | { type: "sendFailed"; runId: string }
    | { type: "runDelta"; runId: string; seq?: number; message?: unknown }
    | (Omit<SessionProjectionRun, "acceptedFinalMessageIdentities"> & {
        type: "runTerminal";
        status: Exclude<SessionProjectionRunStatus, "streaming">;
      })
    | { type: "sessionReset" }
    | { type: "transportGap" }
    | { type: "reconnected" }
  );

function createProjectionEntries(messages: readonly unknown[]): SessionProjectionEntry[] {
  let pendingUserRunId: string | null = null;
  return messages.map((message) => {
    const entry = createEntry(message);
    if (entry.identity?.role === "user") {
      pendingUserRunId = entry.pending ? entry.pendingRunId : null;
      return entry;
    }
    if (
      pendingUserRunId &&
      entry.identity?.role === "assistant" &&
      !entry.pending &&
      isLocallyOptimisticSessionMessage(message)
    ) {
      return createEntry(message, { pendingRunId: pendingUserRunId });
    }
    if (!isLocallyOptimisticSessionMessage(message)) {
      pendingUserRunId = null;
    }
    return entry;
  });
}

export function createSessionProjection(
  scope: SessionProjectionScope = {},
  messages: readonly unknown[] = [],
): SessionProjectionState {
  const entries = createProjectionEntries(messages);
  return {
    scope: { ...scope },
    entries,
    messages: entries.map((entry) => entry.message),
    runs: {},
    hasTransportGap: false,
  };
}

function scopesMatch(left: SessionProjectionScope, right: SessionProjectionScope): boolean {
  return SESSION_PROJECTION_SCOPE_KEYS.every(
    (key) => left[key] === undefined || right[key] === undefined || left[key] === right[key],
  );
}

function readEventScope(event: ScopedSessionProjectionEvent): SessionProjectionScope {
  const scope: SessionProjectionScope = { ...event.scope };
  for (const key of SESSION_PROJECTION_SCOPE_KEYS) {
    if (event[key] !== undefined) {
      Object.assign(scope, { [key]: event[key] });
    }
  }
  return scope;
}

function entryMatches(
  left: SessionProjectionEntry,
  right: SessionProjectionEntry,
  allowSnapshotPromotion = false,
): boolean {
  const leftSegment = readAssistantStreamSegmentIdentity(left.message);
  const rightSegment = readAssistantStreamSegmentIdentity(right.message);
  // One transcript row can contain separate commentary and tool display parts.
  if (leftSegment?.itemId !== rightSegment?.itemId) {
    return false;
  }
  if (sameTranscriptIdentity(left.identity, right.identity)) {
    // A keyed commentary fallback and the full row share an id but are distinct display segments.
    const itemId = readAssistantStreamSegmentIdentity(left.message)?.itemId;
    return itemId === readAssistantStreamSegmentIdentity(right.message)?.itemId;
  }
  if (sameAssistantPersistenceReceipt(left.identity, right.identity)) {
    return true;
  }
  if (
    left.identity?.role === "assistant" &&
    right.identity?.role === "assistant" &&
    left.identity.idempotencyKey &&
    right.identity.idempotencyKey &&
    left.identity.idempotencyKey !== right.identity.idempotencyKey
  ) {
    return false;
  }
  const durableEntry = left.identity?.id ? left : right.identity?.id ? right : null;
  const provisionalEntry = durableEntry === left ? right : durableEntry === right ? left : null;
  const durableMetadata = readRecord(readRecord(durableEntry?.message)?.["__openclaw"]);
  if (
    durableEntry?.identity?.role === "assistant" &&
    provisionalEntry?.identity?.role === "assistant" &&
    !durableEntry.identity.isImported &&
    !provisionalEntry.identity.isImported &&
    !provisionalEntry.identity.id
  ) {
    const durableSegment = durableEntry === left ? leftSegment : rightSegment;
    const provisionalSegment = durableEntry === left ? rightSegment : leftSegment;
    // Terminal cleanup can materialize commentary before cursor history catches up.
    // Adopt its exact item/run without joining distinct durable rows or equal prose.
    if (
      provisionalEntry.identity.sequence === null &&
      durableSegment?.runId &&
      durableSegment.runId === provisionalSegment?.runId &&
      durableSegment.itemId === provisionalSegment.itemId
    ) {
      return true;
    }
    // Commentary and tool continuations cannot own an unkeyed final answer.
    if (
      provisionalEntry.live &&
      !durableSegment &&
      !isSessionProjectionToolContinuation(durableEntry.message) &&
      // Admitting a text-only toolUse-persisted final must not let it merge
      // with a *different* same-run answer in either direction: the kept side
      // suppresses or replaces the other without any content comparison
      // downstream. Scope the content requirement to that newly admitted
      // class only; pre-existing matches (identity promotions, non-toolUse
      // rows) keep their established semantics.
      (!isToolUsePersistedFinalRow(durableEntry.message) ||
        readFinalContentIdentity(durableEntry.message) ===
          readFinalContentIdentity(provisionalEntry.message)) &&
      provisionalEntry.identity.sequence === null &&
      (provisionalEntry.afterSequence === undefined ||
        (provisionalEntry.afterSequence !== null &&
          durableEntry.identity.sequence !== null &&
          durableEntry.identity.sequence > provisionalEntry.afterSequence)) &&
      durableEntry.identity.runId &&
      durableEntry.identity.runId === provisionalEntry.identity.runId &&
      (readNonemptyString(durableMetadata?.mirrorOrigin) === null ||
        durableMetadata?.runTerminal === true)
    ) {
      return true;
    }
  }
  const persisted = left.identity;
  const observed = right.identity;
  if (
    allowSnapshotPromotion &&
    right.live &&
    persisted &&
    observed &&
    persisted.role === observed.role &&
    !persisted.isImported &&
    !observed.isImported &&
    persisted.id &&
    !observed.id &&
    persisted.sequence !== null &&
    persisted.sequence === observed.sequence
  ) {
    // Only current-scope history can promote an observed native sequence.
    return true;
  }
  if (left.pending && right.pending) {
    return Boolean(
      left.identity?.role === right.identity?.role &&
      left.pendingRunId &&
      left.pendingRunId === right.pendingRunId,
    );
  }
  const pending = left.pending ? left : right.pending ? right : null;
  const authoritative = pending === left ? right : pending === right ? left : null;
  return Boolean(
    pending &&
    authoritative &&
    pending.identity &&
    authoritative.identity &&
    pending.identity.role === authoritative.identity.role &&
    !pending.identity.isImported &&
    !authoritative.identity.isImported &&
    pending.pendingRunId &&
    pending.pendingRunId === (authoritative.identity.sendId ?? authoritative.identity.runId) &&
    (pending.identity.sequence === null ||
      authoritative.identity.sequence === null ||
      pending.identity.sequence === authoritative.identity.sequence),
  );
}

function withEntries(
  state: SessionProjectionState,
  entries: readonly SessionProjectionEntry[],
): SessionProjectionState {
  return { ...state, entries, messages: entries.map((entry) => entry.message) };
}

function insertEntry(
  entries: readonly SessionProjectionEntry[],
  incoming: SessionProjectionEntry,
  runs?: Readonly<Record<string, SessionProjectionRun>>,
): SessionProjectionEntry[] {
  const sequence = incoming.identity?.sequence;
  let nextIndex =
    sequence === undefined || sequence === null
      ? -1
      : entries.findIndex((entry) => {
          const candidate = entry.identity?.sequence;
          return candidate !== undefined && candidate !== null && candidate > sequence;
        });
  if (sequence !== undefined && sequence !== null && nextIndex < 0) {
    nextIndex = entries.length;
  }
  if (incoming.identity?.role === "user" && incoming.identity.runId) {
    const runId = incoming.identity.runId;
    const terminalMessage = runs?.[runId]?.message;
    const belongsToRun = (entry: SessionProjectionEntry) =>
      entry.identity?.role === "assistant" &&
      (entry.identity.runId === runId || entry.message === terminalMessage);
    if (sequence !== undefined && sequence !== null) {
      // A run can deliver several replies before its prompt. Move every early
      // unsequenced reply together; durable sequence always wins over run ownership.
      const before: SessionProjectionEntry[] = [];
      const replies: SessionProjectionEntry[] = [];
      for (const entry of entries.slice(0, nextIndex)) {
        (entry.identity?.sequence === null && belongsToRun(entry) ? replies : before).push(entry);
      }
      return [...before, incoming, ...replies, ...entries.slice(nextIndex)];
    }
    const terminalIndex = entries.findIndex(belongsToRun);
    if (terminalIndex >= 0 && (nextIndex < 0 || terminalIndex < nextIndex)) {
      nextIndex = terminalIndex;
    }
  }
  return nextIndex < 0
    ? [...entries, incoming]
    : [...entries.slice(0, nextIndex), incoming, ...entries.slice(nextIndex)];
}

export function projectLiveSessionMessage(
  initialState: SessionProjectionState,
  message: unknown,
  envelope?: SessionMessageEnvelope,
  scope: SessionProjectionScope = {},
): SessionProjectionState {
  let state = initialState;
  if (!scopesMatch(state.scope, scope)) {
    return state;
  }
  const incoming = createEntry(message, { envelope, live: true });
  if (!incoming.identity) {
    return state;
  }
  const matches = state.entries.filter((entry) => entryMatches(entry, incoming));
  const existing =
    matches.find((entry) => sameTranscriptIdentity(entry.identity, incoming.identity)) ??
    (matches.length === 1 ? matches[0] : undefined);
  if (
    existing &&
    !sameTranscriptIdentity(existing.identity, incoming.identity) &&
    !sameAssistantPersistenceReceipt(existing.identity, incoming.identity)
  ) {
    const durable = existing.identity?.id ? existing : incoming.identity.id ? incoming : null;
    const provisional = durable === existing ? incoming : existing;
    if (durable && isToolUsePersistedFinalRow(durable.message)) {
      // Exact durable identities and persistence receipts never need inference.
      // For provisional adoption,
      // use the snapshot owner in both arrival orders, excluding the live copy
      // itself from the history that can contradict the terminal position.
      const history = state.entries.filter((entry) => entry !== provisional);
      const snapshot = durable === incoming ? insertEntry(history, durable) : history;
      const runId = provisional.identity?.runId;
      const run = runId ? state.runs[runId] : undefined;
      const terminalMatch = findUniqueSnapshotTerminalMatch(provisional, [durable], run, snapshot);
      if (!terminalMatch) {
        return withEntries(state, insertEntry(state.entries, incoming, state.runs));
      }
      if (terminalMatch.inferred && durable.identity && runId && run) {
        // Keep the original live entry until authoritative history confirms
        // the inference or restores it after revealing a later assistant row.
        const inferredSnapshotTerminal = { entry: provisional, matchedIdentity: durable.identity };
        state = {
          ...state,
          runs: { ...state.runs, [runId]: { ...run, inferredSnapshotTerminal } },
        };
      }
    }
  }
  if (!existing) {
    return withEntries(state, insertEntry(state.entries, incoming, state.runs));
  }
  const existingIndex = state.entries.indexOf(existing);
  if (existing.message === message && existing.live && !existing.pending) {
    return state;
  }
  if (!existing.pending && existing.identity?.id && !incoming.identity.id) {
    // A terminal projection carries no transcript identity; adopting it over the
    // durable row would lose the ID every later snapshot reconciles against.
    return state;
  }
  if (
    incoming.identity.sequence !== null &&
    (existing.pending || existing.identity?.sequence === null)
  ) {
    const sequence = incoming.identity.sequence;
    const violatesOrder = state.entries.some(
      ({ identity }, index) =>
        identity?.sequence != null &&
        (index < existingIndex ? identity.sequence > sequence : identity.sequence < sequence),
    );
    return withEntries(
      state,
      violatesOrder
        ? insertEntry(
            state.entries.filter((_, index) => index !== existingIndex),
            incoming,
            state.runs,
          )
        : state.entries.toSpliced(existingIndex, 1, incoming),
    );
  }
  return withEntries(state, state.entries.toSpliced(existingIndex, 1, incoming));
}

/** Only observed live events and this client's pending turns may survive an older snapshot. */
export function reconcileSessionProjectionSnapshot(
  state: SessionProjectionState,
  messages: readonly unknown[],
  scope: SessionProjectionScope = {},
  options: SessionProjectionSnapshotOptions = {},
): SessionProjectionState {
  const visibleMessages = options.shouldIncludeMessage
    ? messages.filter(options.shouldIncludeMessage)
    : messages;
  if (!scopesMatch(state.scope, scope)) {
    return createSessionProjection(scope, visibleMessages);
  }
  let entries = createProjectionEntries(visibleMessages);
  const runs: Record<string, SessionProjectionRun> = { ...state.runs };
  for (const current of state.entries) {
    if (
      (!current.live && !current.pending) ||
      options.shouldIncludeMessage?.(current.message) === false
    ) {
      continue;
    }
    const matches = entries.filter((entry) => entryMatches(entry, current, true));
    const uniqueMatch = matches.length === 1 ? matches[0] : undefined;
    const run = current.identity?.runId ? runs[current.identity.runId] : undefined;
    const terminalMatch = findUniqueSnapshotTerminalMatch(current, matches, run, entries);
    if (
      (uniqueMatch &&
        (sameAssistantPersistenceReceipt(uniqueMatch.identity, current.identity) ||
          !isUnsequencedLiveTerminal(current, run))) ||
      terminalMatch
    ) {
      if (
        terminalMatch?.inferred &&
        terminalMatch.entry.identity &&
        current.identity?.runId &&
        run
      ) {
        // Tentative history matches retain their original live ordering until confirmed.
        runs[current.identity.runId] = {
          ...run,
          inferredSnapshotTerminal: {
            entry: current,
            matchedIdentity: terminalMatch.entry.identity,
          },
        };
      }
      continue;
    }
    entries = insertEntry(entries, current, runs);
  }
  for (const [runId, run] of Object.entries(runs)) {
    const inferred = run.inferredSnapshotTerminal;
    if (!inferred) {
      continue;
    }
    // Removal and visibility policy retire a candidate; neither contradicts its identity.
    const candidateRemains = entries.some((entry) =>
      sameTranscriptIdentity(entry.identity, inferred.matchedIdentity),
    );
    const visible = options.shouldIncludeMessage?.(inferred.entry.message) !== false;
    const matches = entries.filter((entry) => entryMatches(entry, inferred.entry, true));
    const terminalMatch = findUniqueSnapshotTerminalMatch(inferred.entry, matches, run, entries);
    if (candidateRemains && visible && terminalMatch?.inferred) {
      continue;
    }
    if (candidateRemains && visible && !terminalMatch) {
      entries = insertEntry(entries, inferred.entry, runs);
    }
    const { inferredSnapshotTerminal: _inferred, ...settledRun } = run;
    runs[runId] = settledRun;
  }
  return {
    ...withEntries(state, entries),
    runs,
    scope: { ...state.scope, ...scope },
    hasTransportGap: false,
  };
}

function updateRun(
  state: SessionProjectionState,
  incoming: SessionProjectionRun,
): SessionProjectionState {
  const incomingErrorMessage = readNonemptyString(incoming.errorMessage);
  const incomingSeq =
    typeof incoming.seq === "number" && Number.isSafeInteger(incoming.seq) && incoming.seq >= 0
      ? incoming.seq
      : undefined;
  const normalizedIncoming = { ...incoming, seq: incomingSeq };
  if (incomingErrorMessage) {
    normalizedIncoming.errorMessage = incomingErrorMessage;
  } else {
    delete normalizedIncoming.errorMessage;
  }
  const current = state.runs[incoming.runId];
  // Only newer run-event order can distinguish resumed output from buffered stale deltas.
  const resumesErrorProjection =
    current?.status === "error" &&
    incoming.status === "streaming" &&
    current.seq !== undefined &&
    incomingSeq !== undefined &&
    incomingSeq > current.seq &&
    isSessionProjectionErrorMessage(current.message, current.errorMessage);
  if (current && current.status !== "streaming" && !resumesErrorProjection) {
    const incomingFinalIdentity = readSessionProjectionFinalMessageIdentity(incoming.message);
    const incomingIsFinal = incoming.status === "completed" || incoming.status === "yielded";
    const currentHasDisplayableMessage = hasDisplayableSessionMessage(current.message);
    const canAcceptFinal = currentHasDisplayableMessage
      ? current.status === incoming.status ||
        (current.acceptedFinalMessageIdentities?.length ?? 0) > 0
      : canRecoverSessionProjectionFinal(current.message, incoming.message);
    const acceptFinal =
      incomingIsFinal &&
      canAcceptFinal &&
      incomingFinalIdentity !== null &&
      !hasSessionProjectionAcceptedFinal(current, incoming.message);
    // Distinct valid finals are remembered; the first delivered reply remains immutable.
    const recoverMessage = acceptFinal && !currentHasDisplayableMessage;
    const recoverError =
      readNonemptyString(current.errorMessage) === null && incomingErrorMessage !== null;
    const updateTerminalSequence =
      incoming.status !== "streaming" &&
      (incomingSeq === undefined
        ? current.seq !== undefined
        : current.seq === undefined || incomingSeq > current.seq);
    if (!acceptFinal && !recoverError && !updateTerminalSequence) {
      return state;
    }
    const firstFinalIdentity = readSessionProjectionFinalMessageIdentity(current.message);
    const previousFinalIdentities =
      current.acceptedFinalMessageIdentities ?? (firstFinalIdentity ? [firstFinalIdentity] : []);
    return {
      ...state,
      runs: {
        ...state.runs,
        [incoming.runId]: {
          ...current,
          ...(updateTerminalSequence ? { seq: incomingSeq } : {}),
          ...(recoverMessage ? { message: incoming.message } : {}),
          ...(acceptFinal && incomingFinalIdentity
            ? {
                acceptedFinalMessageIdentities: [
                  ...previousFinalIdentities,
                  incomingFinalIdentity,
                ].slice(-MAX_ACCEPTED_FINAL_MESSAGES_PER_RUN),
              }
            : {}),
          ...(recoverError && incomingErrorMessage
            ? {
                errorMessage: incomingErrorMessage,
                ...(incoming.errorKind ? { errorKind: incoming.errorKind } : {}),
              }
            : {}),
        },
      },
    };
  }
  const resumedState = resumesErrorProjection
    ? withEntries(
        state,
        state.entries.filter(
          (entry) =>
            !(
              (entry.identity?.runId === incoming.runId || entry.message === current.message) &&
              (readRecord(entry.message)?.stopReason === "error" ||
                entry.message === current.message) &&
              isSessionProjectionErrorMessage(entry.message, current.errorMessage)
            ),
        ),
      )
    : state;
  // Completing a previously active run moves it behind older completed diagnostics.
  const previousRuns =
    current && current.status === "streaming" && incoming.status !== "streaming"
      ? Object.fromEntries(Object.entries(state.runs).filter(([runId]) => runId !== incoming.runId))
      : state.runs;
  const acceptedFinalIdentity =
    incoming.status === "completed" || incoming.status === "yielded"
      ? readSessionProjectionFinalMessageIdentity(incoming.message)
      : null;
  return {
    ...resumedState,
    runs: retainSessionProjectionRuns({
      ...previousRuns,
      [incoming.runId]: {
        ...(resumesErrorProjection ? {} : current),
        ...normalizedIncoming,
        ...(acceptedFinalIdentity
          ? { acceptedFinalMessageIdentities: [acceptedFinalIdentity] }
          : {}),
        ...(!resumesErrorProjection &&
        incoming.message === undefined &&
        current?.message !== undefined
          ? { message: current.message }
          : {}),
      },
    }),
  };
}

/** Reduces durable events, snapshots, and transport lifecycle without client-specific policy. */
export function reduceSessionProjection(
  state: SessionProjectionState,
  event: SessionProjectionEvent,
): SessionProjectionState {
  const scope = readEventScope(event);
  if (event.type === "snapshotLoaded") {
    // A delayed response cannot switch this reducer back into a reset or abandoned epoch.
    return scopesMatch(state.scope, scope)
      ? reconcileSessionProjectionSnapshot(state, event.messages, scope, event.options)
      : state;
  }
  if (event.type === "sessionReset") {
    const { sessionKey, sessionId, agentId } = state.scope;
    return scopesMatch({ sessionKey, sessionId, agentId }, scope)
      ? createSessionProjection({ ...state.scope, ...scope })
      : state;
  }
  if (!scopesMatch(state.scope, scope)) {
    return state;
  }
  switch (event.type) {
    case "messagePersisted":
      return projectLiveSessionMessage(state, event.message, event.envelope ?? event, scope);
    case "sendPending": {
      const pendingRunId = normalizeSessionProjectionRunId(event.idempotencyKey ?? event.runId);
      const incoming = createEntry(event.message, { pendingRunId });
      if (!pendingRunId || !incoming.identity) {
        return state;
      }
      const seed = state.entries.find((entry) => entry.message === event.message);
      // Explicit send ownership may promote its same native seed. Durable and
      // imported rows stay authoritative so send failure cannot remove them.
      if (
        seed &&
        !seed.pending &&
        incoming.identity.id === null &&
        !incoming.identity.isImported &&
        incoming.identity.runId === pendingRunId
      ) {
        return withEntries(
          state,
          state.entries.map((entry) =>
            entry === seed ? { ...seed, pending: true, pendingRunId } : entry,
          ),
        );
      }
      return seed || state.entries.some((entry) => entryMatches(entry, incoming))
        ? state
        : withEntries(state, insertEntry(state.entries, incoming, state.runs));
    }
    case "sendAcknowledged": {
      const runId = normalizeSessionProjectionRunId(event.idempotencyKey ?? event.runId);
      const previousRunId = normalizeSessionProjectionRunId(event.previousRunId);
      if (!runId || !previousRunId || previousRunId === runId) {
        // An acknowledgement is not transcript evidence; retain pending until persistence.
        return state;
      }
      let changed = false;
      const entries = state.entries.flatMap((entry) => {
        if (!entry.pending || entry.pendingRunId !== previousRunId) {
          return [entry];
        }
        changed = true;
        const rekeyed = { ...entry, pendingRunId: runId };
        return state.entries.some(
          (candidate) => !candidate.pending && entryMatches(rekeyed, candidate),
        )
          ? []
          : [rekeyed];
      });
      return changed ? withEntries(state, entries) : state;
    }
    case "sendFailed": {
      const runId = normalizeSessionProjectionRunId(event.runId);
      const entries = state.entries.filter(
        (entry) => !entry.pending || entry.pendingRunId !== runId,
      );
      return entries.length === state.entries.length ? state : withEntries(state, entries);
    }
    case "runDelta":
      return updateRun(state, {
        runId: event.runId,
        seq: event.seq,
        status: "streaming",
        ...(event.message === undefined ? {} : { message: event.message }),
      });
    case "runTerminal":
      return updateRun(state, {
        runId: event.runId,
        seq: event.seq,
        status: event.status,
        ...(event.message === undefined ? {} : { message: event.message }),
        ...(event.stopReason === undefined ? {} : { stopReason: event.stopReason }),
        ...(event.errorKind === undefined ? {} : { errorKind: event.errorKind }),
        ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
      });
    case "transportGap":
      return state.hasTransportGap ? state : { ...state, hasTransportGap: true };
    case "reconnected":
      // A successful reconnect cannot clear a known gap before authoritative history arrives.
      return state;
    default:
      return state;
  }
}
