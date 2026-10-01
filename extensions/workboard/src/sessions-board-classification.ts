import { createHash } from "node:crypto";
import type {
  WorkboardSessionFacts,
  WorkboardSessionsBoard,
  WorkboardSessionsColumn,
} from "@openclaw/workboard-contract";
import { redactToolPayloadText } from "openclaw/plugin-sdk/logging-core";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export const SESSIONS_BOARD_BATCH_SIZE = 40;
// Full session keys, column ids and short reasons must fit the 600-token response.
export const SESSIONS_BOARD_MODEL_BATCH_SIZE = 8;
export const SESSIONS_BOARD_MODEL_INTERVAL_MS = 30_000;
// Background sweeps only keep boards fresh that an operator or tool read recently.
export const SESSIONS_BOARD_VIEWER_IDLE_MS = 15 * 60_000;

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function sessionsBoardSpecHash(board: WorkboardSessionsBoard): string {
  const { agentSessionKey: _conversation, ...spec } = board.sessions;
  return hash({ spec, agentId: board.orchestration?.defaultAssignee });
}

export function sessionFactsHash(facts: WorkboardSessionFacts): string {
  return hash({
    key: facts.key,
    sessionId: facts.sessionId,
    lifecycleRevision: facts.lifecycleRevision,
    agentId: facts.agentId,
    label: facts.label,
    derivedTitle: facts.derivedTitle,
    lastMessagePreview: facts.lastMessagePreview,
    run: facts.run,
    observerDigest: facts.observerDigest
      ? {
          health: facts.observerDigest.health,
          headline: facts.observerDigest.headline,
          assessment: facts.observerDigest.assessment,
          revision: facts.observerDigest.revision,
        }
      : undefined,
    pullRequestsUnavailable: facts.pullRequestsUnavailable === true,
    // Activity time only scopes a session; hashing it would retire pins on every tick.
    archived: facts.archived,
    pullRequests: facts.pullRequests.toSorted(
      (left, right) => left.number - right.number || left.state.localeCompare(right.state),
    ),
  });
}

export function sessionMatchesColumn(
  facts: WorkboardSessionFacts,
  column: WorkboardSessionsColumn,
): boolean {
  const match = column.match;
  if (!match) {
    return false;
  }
  return (
    (match.health === undefined ||
      (facts.observerDigest !== undefined && match.health.includes(facts.observerDigest.health))) &&
    (match.run === undefined || match.run.includes(facts.run)) &&
    (match.archived === undefined || match.archived === facts.archived) &&
    (match.pullRequest === undefined ||
      (!facts.pullRequestsUnavailable &&
        (facts.pullRequests.length === 0
          ? match.pullRequest.includes("none")
          : facts.pullRequests.some((pr) => match.pullRequest?.includes(pr.state)))))
  );
}

export function sessionsBoardFallback(board: WorkboardSessionsBoard): WorkboardSessionsColumn {
  const column = board.sessions.columns.find((entry) => entry.fallback);
  if (!column) {
    throw new Error("Sessions board requires a fallback column.");
  }
  return column;
}

/** Utility models often fence their JSON despite strict-output instructions. */
function unfenceJson(text: string): string {
  const trimmed = text.trim();
  const body = /^```[a-zA-Z0-9_-]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed)?.[1];
  return body === undefined ? trimmed : body.trim();
}

export function parseSessionPlacements(
  text: string,
  board: WorkboardSessionsBoard,
  sessions: readonly WorkboardSessionFacts[],
): Map<string, { columnId: string; reason: string }> {
  const output: unknown = JSON.parse(unfenceJson(text));
  if (!isRecord(output) || Object.keys(output).length !== 1 || !Array.isArray(output.placements)) {
    throw new Error("Utility model returned an invalid placements object.");
  }
  const allowedSessions = new Set(sessions.map((entry) => entry.key));
  const columns = new Set(board.sessions.columns.map((column) => column.id));
  const fallback = { columnId: sessionsBoardFallback(board).id, reason: "unresolved" };
  const placements = new Map<string, { columnId: string; reason: string }>();
  const seen = new Set<string>();
  for (const value of output.placements) {
    if (
      !isRecord(value) ||
      typeof value.sessionKey !== "string" ||
      !allowedSessions.has(value.sessionKey)
    ) {
      continue;
    }
    const valid =
      !seen.has(value.sessionKey) &&
      Object.keys(value).every((key) => ["sessionKey", "columnId", "reason"].includes(key)) &&
      typeof value.columnId === "string" &&
      columns.has(value.columnId) &&
      typeof value.reason === "string" &&
      value.reason.trim().length > 0;
    placements.set(
      value.sessionKey,
      valid && typeof value.columnId === "string" && typeof value.reason === "string"
        ? {
            columnId: value.columnId,
            reason: redactToolPayloadText(value.reason).replace(/\s+/g, " ").trim().slice(0, 240),
          }
        : fallback,
    );
    seen.add(value.sessionKey);
  }
  for (const session of sessions) {
    if (!placements.has(session.key)) {
      placements.set(session.key, fallback);
    }
  }
  return placements;
}
