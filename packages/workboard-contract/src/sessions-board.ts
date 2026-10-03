import type { SessionPerson } from "../../gateway-protocol/src/schema/session-participant.js";
import type { SessionsListParams } from "../../gateway-protocol/src/schema/sessions-list.js";
import type { WorkboardBoardMetadata } from "./index.js";

const OBSERVER_HEALTH = [
  "on-track",
  "grinding",
  "stuck",
  "waiting-on-user",
  "wrapping-up",
  "done",
  "failed",
] as const;
const RUN_STATES = ["active", "idle", "failed"] as const;
const PULL_REQUEST_STATES = ["none", "open", "draft", "merged", "closed"] as const;
const COLUMN_COLORS = new Set([
  "red",
  "blue",
  "green",
  "yellow",
  "purple",
  "orange",
  "pink",
  "cyan",
]);

export type WorkboardSessionsObserverHealth = (typeof OBSERVER_HEALTH)[number];
export type WorkboardSessionsColumnMatch = {
  health?: WorkboardSessionsObserverHealth[];
  run?: Array<(typeof RUN_STATES)[number]>;
  pullRequest?: Array<(typeof PULL_REQUEST_STATES)[number]>;
  archived?: boolean;
};
export type WorkboardSessionsColumn = {
  id: string;
  label: string;
  color?: string;
  description: string;
  match?: WorkboardSessionsColumnMatch | WorkboardSessionsColumnMatch[];
  fallback?: boolean;
};
export type WorkboardSessionsBoardSpec = {
  columns: WorkboardSessionsColumn[];
  scope?: { agentIds?: string[]; includeArchived?: boolean; maxAgeHours?: number };
  agentSessionKey?: string;
};
export type WorkboardSessionsBoard = WorkboardBoardMetadata & {
  kind: "sessions";
  sessions: WorkboardSessionsBoardSpec;
};
export type WorkboardSessionFacts = {
  key: string;
  sessionId: string;
  lifecycleRevision?: string;
  agentId: string;
  label?: string;
  derivedTitle?: string;
  lastMessagePreview?: string;
  run: "active" | "idle" | "failed";
  observerDigest?: {
    health: WorkboardSessionsObserverHealth;
    headline: string;
    assessment?: string;
    revision: number;
  };
  pullRequests: Array<{ number: number; state: "open" | "draft" | "merged" | "closed" }>;
  pullRequestsUnavailable?: boolean;
  archived: boolean;
  lastActivityAt: number;
};
export type WorkboardSessionPlacement = {
  sessionKey: string;
  columnId: string;
  source: "state" | "operator";
  reason: string;
  factsHash: string;
  updatedAt: number;
};
export type WorkboardSessionsBoardView = Pick<
  SessionsListParams,
  "involvingMe" | "involvingProfileId" | "includePeople"
>;
export type WorkboardSessionsBoardRead = {
  board: WorkboardSessionsBoard;
  columns: WorkboardSessionsColumn[];
  sessions: Array<
    WorkboardSessionFacts & Pick<WorkboardSessionPlacement, "columnId" | "source" | "reason">
  >;
  people?: SessionPerson[];
  warning?: string;
};

export function createDefaultWorkboardSessionsBoardSpec(): WorkboardSessionsBoardSpec {
  return {
    columns: [
      {
        id: "needs-input",
        label: "Needs input",
        color: "yellow",
        description: "Observer health is waiting-on-user.",
        match: { health: ["waiting-on-user"] },
      },
      {
        id: "stuck",
        label: "Stuck",
        color: "red",
        description: "Observer health is stuck or failed, or the run failed.",
        match: [{ health: ["stuck", "failed"] }, { run: ["failed"] }],
      },
      {
        id: "working",
        label: "Working",
        color: "blue",
        description: "The run is active.",
        match: { run: ["active"] },
      },
      {
        id: "in-review",
        label: "In review",
        color: "orange",
        description: "A pull request is open or draft.",
        match: { pullRequest: ["open", "draft"] },
      },
      {
        id: "merged",
        label: "Merged",
        color: "purple",
        description: "A pull request is merged.",
        match: { pullRequest: ["merged"] },
      },
      {
        id: "done",
        label: "Done",
        color: "green",
        description: "Observer health is done, or no earlier column rule matches.",
        match: { health: ["done"] },
        fallback: true,
      },
    ],
  };
}

function record(value: unknown, name: string, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${name} must be an object.`);
  }
  const result: Record<string, unknown> = Object.fromEntries(Object.entries(value));
  const unexpected = Object.keys(result).find((key) => !keys.includes(key));
  if (unexpected) {
    throw new Error(`Unknown ${name} field: ${unexpected}.`);
  }
  return result;
}

function text(value: unknown, name: string, min: number, max = Number.MAX_SAFE_INTEGER): string {
  if (typeof value !== "string" || value.trim().length < min || value.trim().length > max) {
    throw new Error(`${name} must be a string with ${min}..${max} characters.`);
  }
  return value.trim();
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${name} must be a boolean.`);
  }
  return value;
}

function choices<T extends string>(value: unknown, name: string, allowed: readonly T[]): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`${name} must be an array.`);
  }
  return [
    ...new Set(
      value.map((entry: unknown) => {
        const selected = allowed.find((candidate) => candidate === entry);
        if (selected === undefined) {
          throw new Error(`${name} contains an unsupported value.`);
        }
        return selected;
      }),
    ),
  ];
}

function normalizeMatch(value: unknown): WorkboardSessionsColumnMatch {
  const input = record(value, "column match", ["health", "run", "pullRequest", "archived"]);
  return {
    ...(input.health !== undefined
      ? { health: choices(input.health, "match.health", OBSERVER_HEALTH) }
      : {}),
    ...(input.run !== undefined ? { run: choices(input.run, "match.run", RUN_STATES) } : {}),
    ...(input.pullRequest !== undefined
      ? { pullRequest: choices(input.pullRequest, "match.pullRequest", PULL_REQUEST_STATES) }
      : {}),
    ...(input.archived !== undefined
      ? { archived: boolean(input.archived, "match.archived") }
      : {}),
  };
}

function normalizeColumn(value: unknown): WorkboardSessionsColumn {
  const input = record(value, "column", [
    "id",
    "label",
    "color",
    "description",
    "match",
    "fallback",
  ]);
  const id = text(input.id, "column id", 1, 48);
  if (!/^[a-z0-9][a-z0-9-]{0,47}$/.test(id)) {
    throw new Error("column id must be a lowercase slug with 1..48 characters.");
  }
  const color = input.color === undefined ? undefined : text(input.color, "column color", 1, 40);
  if (color !== undefined && !COLUMN_COLORS.has(color)) {
    throw new Error("column color must be an existing board color token.");
  }
  const rules =
    input.match === undefined
      ? undefined
      : (Array.isArray(input.match) ? input.match : [input.match]).map(normalizeMatch);
  if (rules?.length === 0) {
    throw new Error("column match must contain at least one rule.");
  }
  return {
    id,
    label: text(input.label, "column label", 1, 60),
    ...(color !== undefined ? { color } : {}),
    description: text(input.description, "column description", 1, 400),
    ...(rules !== undefined ? { match: rules.length === 1 ? rules[0] : rules } : {}),
    ...(input.fallback !== undefined
      ? { fallback: boolean(input.fallback, "column fallback") }
      : {}),
  };
}

function normalizeScope(value: unknown): NonNullable<WorkboardSessionsBoardSpec["scope"]> {
  const input = record(value, "scope", ["agentIds", "includeArchived", "maxAgeHours"]);
  let agentIds: string[] | undefined;
  if (input.agentIds !== undefined) {
    if (!Array.isArray(input.agentIds)) {
      throw new Error("scope.agentIds must be an array.");
    }
    agentIds = [...new Set(input.agentIds.map((id: unknown) => text(id, "agent id", 1)))];
  }
  const maxAgeHours = input.maxAgeHours;
  if (
    maxAgeHours !== undefined &&
    (typeof maxAgeHours !== "number" || !Number.isFinite(maxAgeHours) || maxAgeHours <= 0)
  ) {
    throw new Error("scope.maxAgeHours must be a positive finite number.");
  }
  return {
    ...(agentIds !== undefined ? { agentIds } : {}),
    ...(input.includeArchived !== undefined
      ? { includeArchived: boolean(input.includeArchived, "scope.includeArchived") }
      : {}),
    ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
  };
}

const SPEC_KEYS = ["columns", "scope", "agentSessionKey"];

/** Shared validation for durable specifications, agent tools, and the board editor. */
export function normalizeWorkboardSessionsBoardSpec(value: unknown): WorkboardSessionsBoardSpec {
  const input = record(value, "sessions board specification", [...SPEC_KEYS, "instructions"]);
  if (!Array.isArray(input.columns) || input.columns.length < 2 || input.columns.length > 12) {
    throw new Error("sessions board columns must contain 2..12 columns.");
  }
  const columns = input.columns.map(normalizeColumn);
  if (new Set(columns.map((column) => column.id)).size !== columns.length) {
    throw new Error("sessions board column ids must be unique.");
  }
  if (columns.filter((column) => column.fallback).length !== 1) {
    throw new Error("sessions board must have exactly one fallback column.");
  }
  return {
    columns,
    ...(input.scope !== undefined ? { scope: normalizeScope(input.scope) } : {}),
    ...(input.agentSessionKey !== undefined
      ? { agentSessionKey: text(input.agentSessionKey, "agentSessionKey", 1) }
      : {}),
  };
}

/** Columns and scope replace their previous values; omitted fields stay unchanged. */
export function patchWorkboardSessionsBoardSpec(
  current: WorkboardSessionsBoardSpec,
  value: unknown,
): WorkboardSessionsBoardSpec {
  const patch = record(value, "sessions board patch", SPEC_KEYS);
  return normalizeWorkboardSessionsBoardSpec({ ...current, ...patch });
}
