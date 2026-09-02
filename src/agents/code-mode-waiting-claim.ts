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
import type {
  CodeModeWaitingClaimIntent,
  SessionTranscriptRuntimeTarget,
} from "../config/sessions/session-accessor.types.js";
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
    ) as InternalSessionEntry | undefined;
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
        "eventId" | "identity" | "message"
      >[];
    },
    prepareMessage: (message: AgentMessage) => AgentMessage | null,
    assertHostActive?: () => void,
  ) {
    this.#current();
    const pending: CodeModeTranscriptReservation[] = [];
    const entries: SessionTranscriptPrefixEntry<AgentMessage>[] = [];
    for (const entry of params.entries) {
      const reservation = this.reserve(entry.message);
      const message = prepareMessage(entry.message);
      if (!message) return Promise.resolve({ kind: "suppressed" as const });
      if (reservation) {
        const attached = reservation.attach(message);
        entries.push({
          codeModeClaimIntent: reservation.intent,
          eventId: entry.eventId,
          identity: attached.idempotencyKey,
          message: attached,
        });
        pending.push(reservation);
        continue;
      }
      const source = asOptionalRecord(entry.message);
      const replay =
        source?.role === "toolResult" &&
        typeof source.toolCallId === "string" &&
        typeof source.toolName === "string"
          ? attachCodeModeResultIdentity(message, source.toolCallId, source.toolName)
          : undefined;
      entries.push({
        ...(replay ? { codeModeReplay: { identity: replay.idempotencyKey, message: replay } } : {}),
        eventId: entry.eventId,
        identity: entry.identity,
        message,
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
