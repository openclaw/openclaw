// Client receipt offsets are per-turn measurements. Existing diagnostics.scope events
// contain overlapping stage totals, not ordered spans or per-turn correlation IDs.
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";

export function observeTurnStartReceipt(
  turn: {
    sessionKey: string;
    runId: string;
    awaitingCreatedRunId?: boolean;
    receivedRunId?: string;
    firstAssistantDeltaMs?: number;
    firstToolStartMs?: number;
  },
  event: { event: string; payload?: unknown },
  elapsedMs: number,
) {
  const payload = event.payload;
  if (
    !isRecord(payload) ||
    payload.sessionKey !== turn.sessionKey ||
    typeof payload.runId !== "string" ||
    !payload.runId
  ) {
    return;
  }
  const expectedRunId = turn.awaitingCreatedRunId ? turn.receivedRunId : turn.runId;
  if (expectedRunId !== undefined && payload.runId !== expectedRunId) {
    return;
  }
  const nonempty = (value: unknown) => typeof value === "string" && value.trim().length > 0;
  const message = isRecord(payload.message) ? payload.message : undefined;
  const data = isRecord(payload.data) ? payload.data : undefined;
  const assistantDelta =
    (event.event === "chat" &&
      payload.state === "delta" &&
      message?.role === "assistant" &&
      (nonempty(message.content) ||
        (Array.isArray(message.content) &&
          message.content.some(
            (part: unknown) => isRecord(part) && part.type === "text" && nonempty(part.text),
          )))) ||
    (event.event === "agent" &&
      payload.stream === "assistant" &&
      (nonempty(data?.delta) || nonempty(data?.text))) ||
    (event.event === "agent" &&
      payload.stream === "item" &&
      data?.kind === "preamble" &&
      data.phase === "update" &&
      nonempty(data.progressText));
  const toolStart =
    (event.event === "session.tool" || event.event === "agent") &&
    payload.stream === "tool" &&
    data?.phase === "start";
  if (!assistantDelta && !toolStart) {
    return;
  }
  // sessions.create can publish before its response provides the accepted run ID.
  turn.receivedRunId ??= payload.runId;
  if (assistantDelta) {
    turn.firstAssistantDeltaMs ??= elapsedMs;
  }
  if (toolStart) {
    turn.firstToolStartMs ??= elapsedMs;
  }
}

export type TurnStartSample = {
  round: number;
  sessionKey: string;
  runId: string;
  startedAtEpochMs: number;
  admissionMethod: "sessions.create" | "chat.send";
  acknowledgedMs: number;
  providerRequestMs: number;
  firstAssistantDeltaMs: number;
  firstToolStartMs: number;
  completedMs: number;
};

export type TurnStartPhase = {
  round: number;
  name: string;
  durationMs: number;
  startedAt: number;
  endedAt: number;
  details?: Record<string, unknown>;
};

const milestoneFields = [
  ["acknowledgedMs", "admission.ack"],
  ["providerRequestMs", "provider.request"],
  ["firstAssistantDeltaMs", "assistant.delta.received"],
  ["firstToolStartMs", "tool.start.received"],
  ["completedMs", "turn.completed"],
] as const;

function distribution(samples: number[]) {
  const sorted = samples.toSorted((a, b) => a - b);
  const percentile = (fraction: number) => sorted[Math.ceil(sorted.length * fraction) - 1]!;
  return {
    count: sorted.length,
    p50: percentile(0.5),
    p90: percentile(0.9),
    p95: percentile(0.95),
    max: sorted.at(-1)!,
  };
}

export function summarizeTurnStarts({
  turns,
  phases,
  coldRounds,
}: {
  turns: TurnStartSample[];
  phases: TurnStartPhase[];
  coldRounds: number;
}) {
  if (!Number.isSafeInteger(coldRounds) || coldRounds < 0) {
    throw new Error("coldRounds must be a nonnegative integer");
  }
  if (!turns.length || !phases.length) {
    throw new Error("Turn-start evidence requires completed turns and diagnostic phases");
  }
  const cohortFor = (round: number) => {
    if (!Number.isSafeInteger(round) || round < 0) {
      throw new Error("Turn-start evidence requires a nonnegative integer round");
    }
    return round < coldRounds ? "fresh" : "warm";
  };
  const waterfalls = turns.map((turn) => {
    const cohort = cohortFor(turn.round);
    if (
      !turn.sessionKey ||
      !turn.runId ||
      !["sessions.create", "chat.send"].includes(turn.admissionMethod) ||
      !Number.isFinite(turn.startedAtEpochMs) ||
      turn.startedAtEpochMs < 0
    ) {
      throw new Error(
        "Turn-start evidence requires a session, run, admission method, and start time",
      );
    }
    const milestones = milestoneFields.map(([field, name]) => {
      const offsetMs = turn[field];
      if (!Number.isFinite(offsetMs) || offsetMs < 0) {
        throw new Error(`Incomplete or invalid turn-start milestone ${field} for ${turn.runId}`);
      }
      return { name, offsetMs };
    });
    return {
      round: turn.round,
      cohort,
      sessionKey: turn.sessionKey,
      runId: turn.runId,
      startedAtEpochMs: turn.startedAtEpochMs,
      admissionMethod: turn.admissionMethod,
      // agent.wait can finish before the separate subscriber socket drains its frames.
      milestones: [{ name: "admission.start", offsetMs: 0 }, ...milestones].toSorted(
        (a, b) => a.offsetMs - b.offsetMs,
      ),
    };
  });
  const milestones = (["fresh", "warm"] as const).flatMap((cohort) => {
    const selected = turns.filter((turn) => cohortFor(turn.round) === cohort);
    return selected.length
      ? milestoneFields.map(([field, name]) =>
          Object.assign({ cohort, name }, distribution(selected.map((turn) => turn[field]))),
        )
      : [];
  });
  const phaseGroups = new Map<
    string,
    { cohort: "fresh" | "warm"; stage: string; name: string; durations: number[] }
  >();
  for (const phase of phases) {
    const cohort = cohortFor(phase.round);
    if (
      !phase.name ||
      !Number.isFinite(phase.durationMs) ||
      phase.durationMs < 0 ||
      !Number.isFinite(phase.startedAt) ||
      !Number.isFinite(phase.endedAt) ||
      phase.startedAt < 0 ||
      phase.endedAt < phase.startedAt
    ) {
      throw new Error(`Invalid turn-start diagnostic phase ${phase.name}`);
    }
    const stage = typeof phase.details?.stage === "string" ? phase.details.stage : "worktree";
    const key = JSON.stringify([cohort, stage, phase.name]);
    const group = phaseGroups.get(key) ?? { cohort, stage, name: phase.name, durations: [] };
    group.durations.push(phase.durationMs);
    phaseGroups.set(key, group);
  }
  return {
    milestones,
    phases: [...phaseGroups.values()].map(({ durations, ...group }) =>
      Object.assign(
        group,
        {
          measurement: "overlapping-stage-aggregate" as const,
          attribution: "round/cohort only; no per-turn correlation",
          totalMs: durations.reduce((sum, value) => sum + value, 0),
        },
        distribution(durations),
      ),
    ),
    waterfalls,
  };
}
