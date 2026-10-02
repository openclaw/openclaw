import type {
  WorkboardSessionFacts,
  WorkboardSessionsBoard,
  WorkboardSessionsColumn,
} from "@openclaw/workboard-contract";

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
