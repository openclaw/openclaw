/**
 * Pure assignment model for the secret-assignment broker.
 *
 * The store is keyed per agent id. Each agent has exactly one record:
 * - `none`     => the agent is authorized for no store entry (an empty/absent
 *                 selection is never global access).
 * - `selected` => only the named entries.
 * - `all`      => every entry the run resolved (explicit global opt-in).
 *
 * No function here ever sees a secret value: candidates carry names and kinds.
 */

export type AgentAssignmentMode = "none" | "selected" | "all";

export type AgentAssignment = {
  mode: AgentAssignmentMode;
  names: readonly string[];
};

/** Absent record: authorize nothing. Empty selected never implies global. */
export const EMPTY_ASSIGNMENT: AgentAssignment = Object.freeze({
  mode: "none",
  names: Object.freeze([]) as unknown as readonly string[],
});

export type CandidateEntry = { name: string; kind: "secret" | "env" };

/** Coerces persisted/raw input into a valid record; unknown shapes authorize nothing. */
export function normalizeAssignment(value: unknown): AgentAssignment {
  if (!value || typeof value !== "object") {
    return EMPTY_ASSIGNMENT;
  }
  const record = value as { mode?: unknown; names?: unknown };
  const mode: AgentAssignmentMode =
    record.mode === "all" || record.mode === "selected" ? record.mode : "none";
  const names = Array.isArray(record.names)
    ? [...new Set(record.names.filter((name): name is string => typeof name === "string"))]
    : [];
  return { mode, names };
}

/**
 * Authorizes a run's resolved candidates for one agent. Returns the allowed
 * NAME set. The caller (core seam) withholds every name not returned, so a
 * smaller set is a per-entry denial, not a metadata-only hint.
 */
export function allowedNamesForCandidate(input: {
  assignment: AgentAssignment;
  candidates: readonly CandidateEntry[];
}): string[] {
  const { assignment, candidates } = input;
  if (assignment.mode === "none") {
    return [];
  }
  if (assignment.mode === "all") {
    return candidates.map((candidate) => candidate.name);
  }
  const selected = new Set(assignment.names);
  return candidates.filter((candidate) => selected.has(candidate.name)).map((c) => c.name);
}

/** Applies an operator edit, producing the next record. */
export function applyAssignmentEdit(input: {
  mode: AgentAssignmentMode;
  names?: readonly string[];
}): AgentAssignment {
  if (input.mode !== "selected") {
    return { mode: input.mode, names: [] };
  }
  const names = [
    ...new Set((input.names ?? []).filter((name): name is string => typeof name === "string")),
  ];
  return { mode: "selected", names };
}
