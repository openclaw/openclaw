import { getActiveRun } from "@/lib/active-runs";
import { listSubagentsForRequesterSession } from "@/lib/subagent-registry";
import { resolveActiveAgentId } from "@/lib/workspace";
import { readIndex, resolveSessionKey } from "@/app/api/web-sessions/shared";

export const runtime = "nodejs";

export function GET() {
  const sessions = readIndex();
  const fallbackAgentId = resolveActiveAgentId();
  const parentSessionKeys = new Map(
    sessions.map((session) => [resolveSessionKey(session.id, fallbackAgentId), session.id]),
  );

  const parentRuns = sessions
    .map((session) => {
      const run = getActiveRun(session.id);
      if (!run) {
        return null;
      }
      return {
        sessionId: session.id,
        status: run.status,
      };
    })
    .filter((run): run is { sessionId: string; status: "running" | "waiting-for-subagents" | "completed" | "error" } => Boolean(run));

  const subagents = [...parentSessionKeys.entries()]
    .flatMap(([requesterSessionKey, parentSessionId]) =>
      listSubagentsForRequesterSession(requesterSessionKey).map((entry) => ({
        childSessionKey: entry.childSessionKey,
        parentSessionId,
        runId: entry.runId,
        task: entry.task,
        label: entry.label || undefined,
        status: entry.status,
        startedAt: entry.createdAt,
        endedAt: entry.endedAt,
      })),
    )
    .toSorted((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));

  return Response.json({
    parentRuns,
    subagents,
  });
}
