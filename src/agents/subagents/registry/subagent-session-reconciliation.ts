import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getRuntimeConfig } from "../../../config/config.js";
import type { InternalSessionEntry as SessionEntry } from "../../../config/sessions.js";
import {
  readSessionEntryReadOnlyInWorker,
  withSessionEntryReadOnlyInWorker,
} from "../../../config/sessions/session-entry-read-runtime.js";
import { findTranscriptEvent } from "../../../config/sessions/session-transcript-match.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { waitForAgentJob } from "../../../gateway/agent-turn/agent-job.js";
import { isAgentEventLifecycleGenerationCurrent } from "../../../infra/agent-events.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import { isIncognitoSessionKey } from "../../../routing/session-key.js";
import { buildAgentRunTerminalOutcomeFromWaitResult } from "../../agent-run-terminal-outcome.js";
import { sanitizeAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
import type { AgentRunTerminalReplySnapshot } from "../../agent-run-terminal-reply.types.js";
import { extractStoredAssistantText } from "../../tools/chat-history-text.js";
import { withSubagentSessionSource } from "../spawn/subagent-session-source.js";
import type { SubagentRunOutcome } from "../subagent-run-outcome.types.js";
import { classifySubagentTerminalOutcome } from "../subagent-terminal-outcome.js";
import { resolveSubagentChildAuthority } from "./subagent-child-owner-match.js";
import { resolveSubagentChildSessionOwner } from "./subagent-child-session-owner.js";
import { hasRetainedRequiredCompletionDelivery } from "./subagent-delivery-state.js";
import {
  SUBAGENT_ENDED_REASON_COMPLETE,
  SUBAGENT_ENDED_REASON_ERROR,
  SUBAGENT_ENDED_REASON_KILLED,
  type SubagentLifecycleEndedReason,
} from "./subagent-lifecycle-events.js";
import { resolveRecoveredSubagentExecutions } from "./subagent-recovered-executions.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { isStaleUnendedSubagentRun } from "./subagent-run-liveness.js";

export type SubagentRunOrphanReason =
  | "missing-session-entry"
  | "missing-session-id"
  | "stale-unended-run";

export type SubagentSessionCompletion = {
  startedAt?: number;
  endedAt: number;
  outcome: SubagentRunOutcome;
  reason: SubagentLifecycleEndedReason;
  terminalReply?: AgentRunTerminalReplySnapshot;
};

export async function resolveCompletionForSubagentRun(
  entry: SubagentRunRecord,
  session: SessionEntry | undefined,
  assertCurrent: () => void,
): Promise<SubagentSessionCompletion | null> {
  const authority = resolveSubagentChildAuthority(entry, session);
  if (!session || authority.status !== "verified") {
    return null;
  }
  const recovered = entry.runId.startsWith("announce:requester-settle:")
    ? [...resolveRecoveredSubagentExecutions(session)].findLast(
        ([, source]) => source === entry.runId,
      )
    : undefined;
  const executionRunId = recovered?.[0] ?? entry.runId;
  const snapshot = await waitForAgentJob({ runId: executionRunId, timeoutMs: 0 });
  assertCurrent();
  if (!snapshot) {
    // A previous boot has no job snapshot; persisted timing must name this execution.
    if (session.lastRunId !== executionRunId) {
      return null;
    }
    const completion = resolveCompletionFromSessionEntry(session, entry.createdAt, {
      notBeforeMs: entry.execution.startedAt ?? entry.createdAt,
    });
    if (!completion) {
      return null;
    }
    const { agentId, storePath } = resolveSubagentChildSessionOwner(entry, getRuntimeConfig());
    const final = await withSubagentSessionSource(
      { agentId, storePath, sessionKey: entry.childSessionKey, assertCurrent },
      async (source) => {
        if (!source && isIncognitoSessionKey(entry.childSessionKey)) {
          return undefined;
        }
        return findTranscriptEvent(
          {
            agentId,
            storePath: source?.path ?? storePath,
            sessionKey: entry.childSessionKey,
            sessionId: session.sessionId,
          },
          { kind: "visible-final", runId: executionRunId },
        );
      },
    );
    assertCurrent();
    const text = extractStoredAssistantText(
      isRecord(final?.event) ? final.event.message : undefined,
    );
    return {
      ...completion,
      terminalReply: text ? sanitizeAgentRunTerminalReply(text) : undefined,
    };
  }
  if (
    !snapshot.session ||
    snapshot.session.sessionId !== session.sessionId ||
    snapshot.session.sessionKey !== entry.childSessionKey ||
    (snapshot.session.agentId !== undefined &&
      snapshot.session.agentId !== authority.childAgentId) ||
    !isAgentEventLifecycleGenerationCurrent(snapshot.session.lifecycleGeneration) ||
    (snapshot.yielded && !entry.collect) ||
    typeof snapshot.endedAt !== "number"
  ) {
    return null;
  }
  const terminal = buildAgentRunTerminalOutcomeFromWaitResult(snapshot);
  if (!terminal) {
    return null;
  }
  const classification =
    snapshot.yielded && terminal.status !== "timeout" && terminal.reason !== "blocked"
      ? "success"
      : classifySubagentTerminalOutcome(terminal);
  return {
    startedAt: snapshot.startedAt,
    endedAt: snapshot.endedAt,
    terminalReply: snapshot.terminalReply,
    outcome:
      classification === "success"
        ? { status: "ok" }
        : classification === "timeout"
          ? { status: "timeout" }
          : {
              status: "error",
              error: classification === "cancellation" ? "subagent run terminated" : terminal.error,
            },
    reason:
      classification === "cancellation"
        ? SUBAGENT_ENDED_REASON_KILLED
        : classification === "success" || classification === "timeout"
          ? SUBAGENT_ENDED_REASON_COMPLETE
          : SUBAGENT_ENDED_REASON_ERROR,
  };
}

function terminalSessionTimestamp(sessionEntry: SessionEntry | undefined): number | undefined {
  return asFiniteNumber(sessionEntry?.endedAt) ?? asFiniteNumber(sessionEntry?.updatedAt);
}

function isFreshForRun(
  sessionEntry: SessionEntry | undefined,
  notBeforeMs: number | undefined,
): boolean {
  if (notBeforeMs === undefined) {
    return true;
  }
  const terminalAt = terminalSessionTimestamp(sessionEntry);
  return terminalAt !== undefined && terminalAt >= notBeforeMs;
}

function freshSessionStartedAt(
  sessionEntry: SessionEntry | undefined,
  notBeforeMs: number | undefined,
): number | undefined {
  const startedAt = asFiniteNumber(sessionEntry?.startedAt);
  if (startedAt === undefined) {
    return undefined;
  }
  return notBeforeMs === undefined || startedAt >= notBeforeMs ? startedAt : undefined;
}

/** Read the current child entry; session-key scope also selects incognito storage. */
export async function loadSubagentSessionEntry(params: {
  childSessionKey: string;
  childAgentId?: string;
  cfg?: OpenClawConfig;
  assertCurrent?: () => void;
}): Promise<SessionEntry | undefined> {
  const key = params.childSessionKey.trim();
  if (!key) {
    return undefined;
  }
  const cfg = params.cfg ?? getRuntimeConfig();
  const { agentId, storePath } = resolveSubagentChildSessionOwner(params, cfg);
  if (isIncognitoSessionKey(key)) {
    return withSubagentSessionEntry({ ...params, cfg }, (entry) => entry);
  }
  return readSessionEntryReadOnlyInWorker(
    { agentId, storePath, sessionKey: key, projection: "list" },
    params.assertCurrent,
  );
}

export function resolveSubagentRunOrphanReason(params: {
  entry: SubagentRunRecord;
  includeStaleUnended?: boolean;
  now?: number;
  cfg?: OpenClawConfig;
}):
  | SubagentRunOrphanReason
  | null
  | {
      read: (assertCurrent: () => void) => Promise<{
        orphanReason: SubagentRunOrphanReason | null;
        sessionEntry: SessionEntry | undefined;
      }>;
    } {
  const { entry } = params;
  // Execution, recovery, and completion obligations outlive individual turns.
  // Missing session metadata must not steal those owners or manufacture success.
  if (
    entry.execution.outcome ||
    entry.collectorCompletion ||
    entry.requesterSettleWake ||
    hasRetainedRequiredCompletionDelivery(entry) ||
    entry.pauseReason ||
    entry.killIntent ||
    entry.killReconciliation ||
    entry.execution.restartRecovery ||
    entry.terminalOwner === "interrupted-recovery" ||
    entry.suppressAnnounceReason === "steer-restart" ||
    entry.execution.status === "queued" ||
    getAgentRunContext(entry.runId)
  ) {
    return null;
  }
  const childSessionKey = params.entry.childSessionKey?.trim();
  if (!childSessionKey) {
    return "missing-session-entry";
  }
  return {
    async read(assertCurrent) {
      const sessionEntry = await loadSubagentSessionEntry({
        childSessionKey,
        childAgentId: entry.childAgentId,
        cfg: params.cfg,
        assertCurrent,
      });
      let orphanReason: SubagentRunOrphanReason | null = null;
      if (!sessionEntry) {
        orphanReason = "missing-session-entry";
      } else if (typeof sessionEntry.sessionId !== "string" || !sessionEntry.sessionId.trim()) {
        orphanReason = "missing-session-id";
      } else if (
        params.includeStaleUnended === true &&
        sessionEntry.abortedLastRun !== true &&
        entry.execution.status !== "interrupted" &&
        isStaleUnendedSubagentRun(entry, params.now)
      ) {
        orphanReason = "stale-unended-run";
      }
      return { orphanReason, sessionEntry };
    },
  };
}

export function resolveCompletionFromSessionEntry(
  sessionEntry: SessionEntry | undefined,
  fallbackEndedAt: number,
  opts?: { notBeforeMs?: number },
): SubagentSessionCompletion | null {
  const status = sessionEntry?.status;
  // Interruption leaves registry settlement with the recovery owner.
  if (status === "interrupted" || !isFreshForRun(sessionEntry, opts?.notBeforeMs)) {
    return null;
  }
  let outcome: SubagentRunOutcome;
  let reason: SubagentLifecycleEndedReason = SUBAGENT_ENDED_REASON_COMPLETE;
  switch (status) {
    case "failed":
      outcome = {
        status: "error",
        error: sessionEntry?.lastRunError || "session completed before registry settled",
      };
      reason = SUBAGENT_ENDED_REASON_ERROR;
      break;
    case "killed":
      outcome = { status: "error", error: "subagent run terminated" };
      reason = SUBAGENT_ENDED_REASON_KILLED;
      break;
    case "timeout":
      outcome = { status: "timeout", error: sessionEntry?.lastRunError };
      break;
    default:
      if (status !== "done" && typeof sessionEntry?.endedAt !== "number") {
        return null;
      }
      outcome = { status: "ok" };
  }
  return {
    startedAt: freshSessionStartedAt(sessionEntry, opts?.notBeforeMs),
    endedAt: terminalSessionTimestamp(sessionEntry) ?? fallbackEndedAt,
    outcome,
    reason,
  };
}

export async function resolveSubagentSessionCompletion(params: {
  childSessionKey: string;
  childAgentId?: string;
  fallbackEndedAt: number;
  notBeforeMs?: number;
  cfg?: OpenClawConfig;
  assertCurrent?: () => void;
}): Promise<SubagentSessionCompletion | null> {
  return withSubagentSessionEntry(params, (entry) =>
    resolveCompletionFromSessionEntry(entry, params.fallbackEndedAt, {
      notBeforeMs: params.notBeforeMs,
    }),
  );
}

export async function withSubagentSessionEntry<T>(
  params: {
    childSessionKey: string;
    childAgentId?: string;
    cfg?: OpenClawConfig;
    assertCurrent?: () => void;
  },
  consume: (entry: SessionEntry | undefined) => T | Promise<T>,
): Promise<T> {
  const cfg = params.cfg ?? getRuntimeConfig();
  const { agentId, storePath } = resolveSubagentChildSessionOwner(params, cfg);
  return withSubagentSessionSource(
    { agentId, storePath, sessionKey: params.childSessionKey, assertCurrent: params.assertCurrent },
    async (source) => {
      if (source) {
        return consume(source.actor.snapshot(source.authority)?.entry);
      }
      if (isIncognitoSessionKey(params.childSessionKey)) {
        return consume(undefined);
      }
      return withSessionEntryReadOnlyInWorker(
        { agentId, storePath, sessionKey: params.childSessionKey, projection: "list" },
        () => params.assertCurrent?.(),
        async (result) => {
          if (!result.ok) {
            throw result.error;
          }
          return consume(result.value);
        },
      );
    },
  );
}

export async function resolveSubagentSessionStartedAt(params: {
  childSessionKey: string;
  childAgentId?: string;
  notBeforeMs?: number;
  cfg?: OpenClawConfig;
  assertCurrent?: () => void;
}): Promise<number | undefined> {
  return withSubagentSessionEntry(params, (entry) =>
    isFreshForRun(entry, params.notBeforeMs)
      ? freshSessionStartedAt(entry, params.notBeforeMs)
      : undefined,
  );
}
