/* oxlint-disable eslint/curly -- Keep lifecycle and claim guards adjacent to their authority checks. */
import { isDeepStrictEqual } from "node:util";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { readSessionEntryRow } from "../config/sessions/session-accessor.sqlite-entry-store.js";
import { loadExactSessionEntry } from "../config/sessions/session-accessor.sqlite-entry.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../config/sessions/session-accessor.sqlite-scope.js";
import { readTranscriptMirrorFacts } from "../config/sessions/session-accessor.sqlite-transcript-mirror.js";
import {
  commitExpectedSessionTranscriptPrefix,
  type SessionTranscriptPrefixEntry,
} from "../config/sessions/session-accessor.sqlite-transcript-prefix.js";
import { readMessageIdempotencyKey } from "../config/sessions/session-accessor.sqlite-transcript-store.js";
import type {
  CodeModeWaitingClaimIntent,
  SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.types.js";
import { sessionTranscriptIndexNeedsReconcile } from "../config/sessions/session-transcript-index.js";
import type { TranscriptEntryAnchor } from "../config/sessions/transcript-entry-anchor.js";
import type { CodeModeWaitingClaim, InternalSessionEntry } from "../config/sessions/types.js";
import {
  openOpenClawAgentDatabase,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { activeRuns, resumingRunIds } from "./code-mode-state.js";
import type { AgentMessage } from "./runtime/index.js";

export type CodeModeTranscriptReservation = Readonly<{
  attach: (message: AgentMessage) => AgentMessage & { idempotencyKey: string };
  assertCurrent: (database?: OpenClawAgentDatabase) => void;
  consume: () => void;
  intent: CodeModeWaitingClaimIntent;
}>;
export const codeModeTranscriptReservationSlot = Symbol("codeModeTranscriptReservation");

type CodeModeResultMessage = AgentMessage & {
  idempotencyKey: string;
  role: "toolResult";
  toolCallId: string;
  toolName: string;
};

function attachCodeModeResultIdentity(
  message: AgentMessage,
  toolCallId: string,
  toolName: string,
): CodeModeResultMessage | undefined {
  if (
    message.role !== "toolResult" ||
    message.toolCallId !== toolCallId ||
    message.toolName !== toolName
  )
    return undefined;
  return { ...message, idempotencyKey: `code-mode-result:${toolCallId}` };
}

function attachProviderSourceFingerprint(
  message: AgentMessage,
  sourceFingerprint: string | undefined,
): AgentMessage {
  if (!sourceFingerprint) return message;
  if (!/^sha256:[a-f0-9]{64}$/u.test(sourceFingerprint))
    throw new Error("provider transcript source fingerprint must be a full sha256 digest");
  const metadata = asOptionalRecord(Reflect.get(message, "__openclaw")) ?? {};
  return Object.assign({}, message, {
    __openclaw: { ...metadata, providerSourceFingerprint: sourceFingerprint },
  }) as AgentMessage; // SAFETY: Object.assign preserves AgentMessage fields and adds metadata.
}

function readProviderSourceFingerprint(message: unknown): string | undefined {
  const metadata = asOptionalRecord(Reflect.get(asOptionalRecord(message) ?? {}, "__openclaw"));
  return typeof metadata?.providerSourceFingerprint === "string"
    ? metadata.providerSourceFingerprint
    : undefined;
}

export class CodeModeTranscriptAuthority {
  readonly #target: Readonly<
    SessionTranscriptRuntimeTarget & { lifecycleRevision: string; writerRunId: string }
  >;
  readonly #pending = new Map<string, CodeModeWaitingClaimIntent>();
  readonly #seenCallIds = new Set<string>();
  #active = true;

  constructor(params: {
    scope: SessionTranscriptRuntimeTarget;
    lifecycleRevision: string;
    writerRunId: string;
  }) {
    this.#target = Object.freeze({
      ...params.scope,
      lifecycleRevision: params.lifecycleRevision,
      writerRunId: params.writerRunId,
    });
  }
  close(): void {
    this.#active = false;
    this.#pending.clear();
    this.#seenCallIds.clear();
  }
  assertActive(): void {
    this.#current();
  }
  #current(database?: OpenClawAgentDatabase): InternalSessionEntry {
    if (!this.#active) throw new Error("code mode transcript authority is closed");
    const entry = (
      database
        ? readSessionEntryRow(database, resolveSqliteTranscriptScope(this.#target).sessionKey)
            ?.entry
        : loadExactSessionEntry({ ...this.#target, clone: false })?.entry
    ) as InternalSessionEntry | undefined; // SAFETY: both accessors return canonical session entries.
    if (
      !entry ||
      entry.sessionId !== this.#target.sessionId ||
      entry.lifecycleRevision !== this.#target.lifecycleRevision ||
      entry.activeWriterRunId !== this.#target.writerRunId
    )
      throw new Error("code mode transcript authority is stale");
    return entry;
  }
  verify(runId: string): CodeModeWaitingClaim | undefined {
    const run = activeRuns.get(runId);
    const claim = this.#current().codeModeWaitingClaims?.[runId];
    if (
      !run ||
      resumingRunIds.has(runId) ||
      !claim ||
      claim.sourceDigest !== run.replayId ||
      claim.expiresAt <= Date.now() ||
      claim.sourceToolCallId !== run.parentToolCallId
    )
      return undefined;
    const identity = claim.anchor.idempotencyKey;
    if (!identity) return undefined;
    const scope = resolveSqliteTranscriptScope(this.#target);
    const facts = readTranscriptMirrorFacts(
      openOpenClawAgentDatabase(toDatabaseOptions(scope)),
      scope,
      [identity],
    );
    const message = asOptionalRecord(facts.messagesByIdempotencyKey.get(identity));
    return isDeepStrictEqual(facts.anchorsByIdempotencyKey.get(identity), claim.anchor) &&
      message?.role === "toolResult" &&
      message.toolCallId === claim.sourceToolCallId &&
      message.toolName === claim.sourceToolName &&
      asOptionalRecord(message.details)?.status === "waiting" &&
      asOptionalRecord(message.details)?.runId === runId
      ? claim
      : undefined;
  }
  capture(
    input: Pick<
      CodeModeWaitingClaimIntent,
      "outcome" | "runId" | "sourceToolCallId" | "sourceToolName"
    > & { predecessor?: CodeModeWaitingClaim },
  ): void {
    this.#current();
    const run = activeRuns.get(input.runId);
    const expiresAt = run?.expiresAt ?? input.predecessor?.expiresAt;
    if (!expiresAt || expiresAt <= Date.now())
      throw new Error("code mode transcript claim is expired");
    for (const [callId, intent] of this.#pending)
      if (intent.expiresAt <= Date.now()) this.#pending.delete(callId);
    if (this.#seenCallIds.has(input.sourceToolCallId))
      throw new Error(`code mode transcript call id was reused: ${input.sourceToolCallId}`);
    if (this.#pending.size >= 64) this.#pending.delete(this.#pending.keys().next().value!);
    this.#seenCallIds.add(input.sourceToolCallId);
    this.#pending.set(input.sourceToolCallId, {
      ...input,
      expiresAt,
      lifecycleRevision: this.#target.lifecycleRevision,
      predecessorEntryId: input.predecessor?.anchor.entryId,
      sourceDigest: run?.replayId ?? input.predecessor!.sourceDigest,
      writerRunId: this.#target.writerRunId,
    });
  }
  reserve(message: unknown): CodeModeTranscriptReservation | undefined {
    this.#current();
    const source = asOptionalRecord(message);
    const callId = typeof source?.toolCallId === "string" ? source.toolCallId : undefined;
    const intent = callId ? this.#pending.get(callId) : undefined;
    if (!intent || source?.role !== "toolResult" || source.toolName !== intent.sourceToolName)
      return undefined;
    const reservedCallId = callId!;
    return Object.freeze({
      attach: (candidate: AgentMessage) => {
        this.#current();
        const attached = attachCodeModeResultIdentity(
          candidate,
          reservedCallId,
          intent.sourceToolName,
        );
        if (!attached) throw new Error("code mode transcript reservation identity changed");
        return attached;
      },
      assertCurrent: (database?: OpenClawAgentDatabase) => void this.#current(database),
      consume: () => {
        if (this.#active && this.#pending.get(reservedCallId) === intent)
          this.#pending.delete(reservedCallId);
      },
      intent,
    });
  }
  commitPrefix(
    params: {
      baseAnchor?: TranscriptEntryAnchor;
      entries: readonly Pick<
        SessionTranscriptPrefixEntry<AgentMessage>,
        "eventId" | "identity" | "message" | "sourceFingerprint"
      >[];
    },
    prepareMessage: (message: AgentMessage) => AgentMessage | null,
    assertHostActive?: () => void,
  ) {
    this.#current();
    const pending: CodeModeTranscriptReservation[] = [];
    const entries: SessionTranscriptPrefixEntry<AgentMessage>[] = [];
    const candidates = params.entries.map((entry) => {
      const reservation = this.reserve(entry.message);
      const message = attachProviderSourceFingerprint(entry.message, entry.sourceFingerprint);
      const source = asOptionalRecord(entry.message);
      const replay =
        !reservation &&
        source?.role === "toolResult" &&
        typeof source.toolCallId === "string" &&
        typeof source.toolName === "string"
          ? attachCodeModeResultIdentity(message, source.toolCallId, source.toolName)
          : undefined;
      return { entry, message, replay, reservation };
    });
    const replayIdentities = candidates.flatMap(({ entry, replay, reservation }) =>
      reservation ? [] : [entry.identity, ...(replay ? [replay.idempotencyKey] : [])],
    );
    const replayScope = resolveSqliteTranscriptScope(this.#target);
    const replayDatabase = openOpenClawAgentDatabase(toDatabaseOptions(replayScope));
    // A dirty projection cannot prove an active replay cheaply. Let the canonical
    // prefix transaction rebuild it once instead of adding another full scan.
    const replayFacts =
      replayIdentities.length > 0 &&
      !sessionTranscriptIndexNeedsReconcile(replayDatabase.db, replayScope.sessionId)
        ? readTranscriptMirrorFacts(replayDatabase, replayScope, replayIdentities)
        : undefined;
    // Prepared bytes may differ from provider input. Only immutable source evidence and
    // stored topology may bypass host preparation; the commit transaction revalidates both.
    const exactReplay = (
      eventId: string,
      identity: string,
      sourceMessage: AgentMessage,
      sourceFingerprint: string | undefined,
    ):
      | {
          anchor: TranscriptEntryAnchor;
          identity: string;
          message: AgentMessage;
        }
      | undefined => {
      const anchor = replayFacts?.anchorsByIdempotencyKey.get(identity);
      const stored = replayFacts?.messagesByIdempotencyKey.get(identity);
      const source = asOptionalRecord(sourceMessage);
      const storedRecord = asOptionalRecord(stored);
      const sourceMatches =
        sourceFingerprint !== undefined
          ? readProviderSourceFingerprint(stored) === sourceFingerprint
          : isDeepStrictEqual(stored, sourceMessage);
      return anchor?.entryId === eventId &&
        readMessageIdempotencyKey(stored) === identity &&
        sourceMatches &&
        (source?.role !== "toolResult" ||
          (storedRecord?.role === "toolResult" &&
            storedRecord.toolCallId === source.toolCallId &&
            storedRecord.toolName === source.toolName))
        ? {
            anchor,
            identity,
            // SAFETY: the role and required tool-result identity fields were validated above.
            message: stored as AgentMessage,
          }
        : undefined;
    };
    let replayPrefix = true;
    let replayParentId = params.baseAnchor?.entryId;
    let replayPosition = params.baseAnchor?.activeMessagePosition;
    for (const { entry, message: sourceMessage, replay, reservation } of candidates) {
      if (replayPrefix && !reservation) {
        const stored =
          exactReplay(entry.eventId, entry.identity, sourceMessage, entry.sourceFingerprint) ??
          (replay
            ? exactReplay(entry.eventId, replay.idempotencyKey, replay, entry.sourceFingerprint)
            : undefined);
        if (
          stored &&
          (replayParentId === undefined || stored.anchor.effectiveParentId === replayParentId) &&
          (replayPosition === undefined ||
            stored.anchor.activeMessagePosition === replayPosition + 1)
        ) {
          entries.push({
            ...(stored.identity !== entry.identity
              ? { codeModeReplay: { identity: stored.identity, message: stored.message } }
              : {}),
            eventId: entry.eventId,
            identity: entry.identity,
            message: stored.message,
            sourceFingerprint: entry.sourceFingerprint,
          });
          replayParentId = stored.anchor.entryId;
          replayPosition = stored.anchor.activeMessagePosition;
          continue;
        }
      }
      replayPrefix = false;
      const prepared = prepareMessage(entry.message);
      if (!prepared) return Promise.resolve({ kind: "suppressed" as const });
      const message = attachProviderSourceFingerprint(prepared, entry.sourceFingerprint);
      if (reservation) {
        const attached = reservation.attach(message);
        entries.push({
          codeModeClaimIntent: reservation.intent,
          eventId: entry.eventId,
          identity: attached.idempotencyKey,
          message: attached,
          sourceFingerprint: entry.sourceFingerprint,
        });
        pending.push(reservation);
        continue;
      }
      const source = asOptionalRecord(entry.message);
      const preparedReplay =
        source?.role === "toolResult" &&
        typeof source.toolCallId === "string" &&
        typeof source.toolName === "string"
          ? attachCodeModeResultIdentity(message, source.toolCallId, source.toolName)
          : undefined;
      entries.push({
        ...(preparedReplay
          ? {
              codeModeReplay: {
                identity: preparedReplay.idempotencyKey,
                message: preparedReplay,
              },
            }
          : {}),
        eventId: entry.eventId,
        identity: entry.identity,
        message,
        sourceFingerprint: entry.sourceFingerprint,
      });
    }
    return commitExpectedSessionTranscriptPrefix(this.#target, {
      ...params,
      entries,
      expectedLifecycleRevision: this.#target.lifecycleRevision,
      expectedWriterRunId: this.#target.writerRunId,
      assertBeforeAppend: (database) => {
        assertHostActive?.();
        this.#current(database);
      },
    }).then((result) => {
      if (result.kind === "committed" || result.kind === "replayed")
        pending.forEach((reservation) => reservation.consume());
      return result;
    });
  }
}
