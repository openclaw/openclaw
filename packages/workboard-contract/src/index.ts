import type { SchemaContract } from "../../gateway-protocol/src/schema-contract.js";
import type { SessionPerson } from "../../gateway-protocol/src/schema/session-participant.js";
import type { SessionsListParams } from "../../gateway-protocol/src/schema/sessions-list.js";

export type WorkboardDatabasePortApi<Database, Input> = {
  inspectWorkboardPortSource(db: Database): {
    version: number;
    migrationRequired: boolean;
    pendingColumns: Record<string, string[]>;
  };
  admitWorkboardPort(dbPath: string, input?: Input): void;
  WorkboardPortSchemaError: new (message?: string) => Error;
};

export const WORKBOARD_STATUSES = [
  "triage",
  "backlog",
  "todo",
  "scheduled",
  "ready",
  "running",
  "review",
  "blocked",
  "done",
] as const;

export const WORKBOARD_PRIORITIES = ["low", "normal", "high", "urgent"] as const;
/** Built-in launch choices. Persisted execution engines remain an open runtime identifier. */
export const WORKBOARD_EXECUTION_ENGINES = ["codex", "claude"] as const;
export const WORKBOARD_EXECUTION_MODES = ["autonomous", "manual"] as const;
export const WORKBOARD_EXECUTION_STATUSES = [
  "idle",
  "running",
  "review",
  "blocked",
  "done",
] as const;
export const WORKBOARD_EVENT_KINDS = [
  "created",
  "edited",
  "moved",
  "linked",
  "specified",
  "decomposed",
  "claimed",
  "heartbeat",
  "execution_updated",
  "attempt_started",
  "attempt_updated",
  "comment_added",
  "link_added",
  "proof_added",
  "artifact_added",
  "attachment_added",
  "diagnostic",
  "notification",
  "dispatch",
  "orchestration",
  "protocol_violation",
  "archived",
  "unarchived",
  "stale",
] as const;
export const WORKBOARD_ATTEMPT_STATUSES = [
  "running",
  "succeeded",
  "failed",
  "blocked",
  "stopped",
] as const;
export const WORKBOARD_LINK_TYPES = [
  "parent",
  "child",
  "blocks",
  "blocked_by",
  "relates_to",
] as const;
export const WORKBOARD_PROOF_STATUSES = ["passed", "failed", "skipped", "unknown"] as const;
export const WORKBOARD_TEMPLATE_IDS = ["bugfix", "docs", "release", "pr_review", "plugin"] as const;
export const WORKBOARD_DIAGNOSTIC_KINDS = [
  "stranded_ready",
  "running_without_heartbeat",
  "blocked_too_long",
  "repeated_failures",
  "missing_proof",
  "orphaned_session",
  "archived_but_active",
] as const;
export const WORKBOARD_DIAGNOSTIC_SEVERITIES = ["warning", "error", "critical"] as const;
export const WORKBOARD_NOTIFICATION_KINDS = ["completed", "failed", "stale"] as const;
export const WORKBOARD_BOARD_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,79}$/;

export function isValidWorkboardBoardId(value: unknown): value is string {
  return typeof value === "string" && WORKBOARD_BOARD_ID_PATTERN.test(value);
}

export type WorkboardDeleteResult = {
  deleted: boolean;
  referenceUpdates?: Array<{ id: string; previousUpdatedAt: number; updatedAt: number }>;
};

export type WorkboardStatus = (typeof WORKBOARD_STATUSES)[number];
export type WorkboardPriority = (typeof WORKBOARD_PRIORITIES)[number];
export type WorkboardExecutionEngine = string;
export type WorkboardExecutionMode = (typeof WORKBOARD_EXECUTION_MODES)[number];
export type WorkboardExecutionStatus = (typeof WORKBOARD_EXECUTION_STATUSES)[number];
export type WorkboardEventKind = (typeof WORKBOARD_EVENT_KINDS)[number];
export type WorkboardAttemptStatus = (typeof WORKBOARD_ATTEMPT_STATUSES)[number];
export type WorkboardLinkType = (typeof WORKBOARD_LINK_TYPES)[number];
export type WorkboardProofStatus = (typeof WORKBOARD_PROOF_STATUSES)[number];
export type WorkboardTemplateId = (typeof WORKBOARD_TEMPLATE_IDS)[number];
export type WorkboardDiagnosticKind = (typeof WORKBOARD_DIAGNOSTIC_KINDS)[number];
export type WorkboardDiagnosticSeverity = (typeof WORKBOARD_DIAGNOSTIC_SEVERITIES)[number];
export type WorkboardNotificationKind = (typeof WORKBOARD_NOTIFICATION_KINDS)[number];

export type WorkboardExecution = {
  id: string;
  kind: "agent-session";
  engine?: WorkboardExecutionEngine;
  mode: WorkboardExecutionMode;
  status: WorkboardExecutionStatus;
  model?: string;
  sessionKey?: string;
  runId?: string;
  startedAt: number;
  updatedAt: number;
};

export type WorkboardEvent = {
  id: string;
  kind: WorkboardEventKind;
  at: number;
  fromStatus?: WorkboardStatus;
  toStatus?: WorkboardStatus;
  sessionKey?: string;
  runId?: string;
};

export type WorkboardRunAttempt = {
  id: string;
  status: WorkboardAttemptStatus;
  startedAt: number;
  endedAt?: number;
  engine?: WorkboardExecutionEngine;
  mode?: WorkboardExecutionMode;
  model?: string;
  sessionKey?: string;
  runId?: string;
  error?: string;
};

export type WorkboardComment = {
  id: string;
  body: string;
  createdAt: number;
  updatedAt?: number;
};

export type WorkboardLink = {
  id: string;
  type: WorkboardLinkType;
  createdAt: number;
  targetCardId?: string;
  title?: string;
  url?: string;
};

export type WorkboardProof = {
  id: string;
  status: WorkboardProofStatus;
  createdAt: number;
  label?: string;
  command?: string;
  url?: string;
  note?: string;
};

export type WorkboardArtifact = {
  id: string;
  createdAt: number;
  label?: string;
  url?: string;
  path?: string;
  mimeType?: string;
};

export type WorkboardAttachment = {
  id: string;
  cardId: string;
  createdAt: number;
  fileName: string;
  byteSize: number;
  mimeType?: string;
  note?: string;
};

export type WorkboardWorkerLog = {
  id: string;
  createdAt: number;
  level: "info" | "warning" | "error";
  message: string;
  sessionKey?: string;
  runId?: string;
};

export const WORKBOARD_WORKER_STATES = [
  "idle",
  "running",
  "completed",
  "blocked",
  "violated",
] as const;
export type WorkboardWorkerProtocol = {
  state: (typeof WORKBOARD_WORKER_STATES)[number];
  updatedAt: number;
  detail?: string;
};

export type WorkboardStaleState = {
  detectedAt: number;
  lastSessionUpdatedAt?: number;
  reason: string;
};

export type WorkboardClaim = {
  ownerId: string;
  token: string;
  claimedAt: number;
  lastHeartbeatAt: number;
  expiresAt?: number;
};

export const WORKBOARD_DIAGNOSTIC_ACTION_KINDS = [
  "claim",
  "unblock",
  "promote",
  "reclaim",
  "reassign",
  "add_proof",
  "open_session",
] as const;
export type WorkboardDiagnosticAction = {
  kind: (typeof WORKBOARD_DIAGNOSTIC_ACTION_KINDS)[number];
  label: string;
};

export type WorkboardDiagnostic = {
  kind: WorkboardDiagnosticKind;
  severity: WorkboardDiagnosticSeverity;
  title: string;
  detail: string;
  firstSeenAt: number;
  lastSeenAt: number;
  count: number;
  actions: WorkboardDiagnosticAction[];
};

export type WorkboardNotification = {
  id: string;
  kind: WorkboardNotificationKind;
  createdAt: number;
  sequence?: number;
  message: string;
  sessionKey?: string;
  runId?: string;
};

export const WORKBOARD_CHANGED_EVENT = "plugin.workboard.changed";

export type WorkboardChange = {
  epoch: string;
  revision: number;
  cardsRevision?: number;
  sessionsRevision?: number;
};

export type WorkboardWorkspace = {
  kind: "scratch" | "dir" | "worktree";
  path?: string;
  branch?: string;
  sourcePath?: string;
  sourceBranch?: string;
};

export type WorkboardWorkspaceAccess =
  | { unrestricted: true }
  | { unrestricted: false; roots: string[]; writable: boolean };

type WorkboardLaunchIdentity = {
  requestedSessionKey: string;
  provisionalRunId: string;
  preparedAt: number;
};

export type WorkboardLaunchState =
  | (WorkboardLaunchIdentity & { phase: "prepared" })
  | (WorkboardLaunchIdentity & {
      phase: "accepted";
      acceptedAt: number;
      acceptedSessionKey: string;
      acceptedRunId?: string;
    })
  | (WorkboardLaunchIdentity & {
      phase: "failed";
      failedAt: number;
      reason: string;
    });

export type WorkboardAutomation = {
  tenant?: string;
  boardId?: string;
  createdByCardId?: string;
  idempotencyKey?: string;
  skills?: string[];
  workspace?: WorkboardWorkspace;
  workspaceAccess?: WorkboardWorkspaceAccess;
  maxRuntimeSeconds?: number;
  maxRetries?: number;
  scheduledAt?: number;
  summary?: string;
  createdCardIds?: string[];
  dispatchCount?: number;
  lastDispatchAt?: number;
  launch?: WorkboardLaunchState;
};

export type WorkboardBoardMetadata = {
  id: string;
  kind?: "cards" | "sessions";
  sessions?: WorkboardSessionsBoardSpec;
  name?: string;
  description?: string;
  icon?: string;
  color?: string;
  automationJobId?: string;
  defaultWorkspace?: WorkboardWorkspace;
  orchestration?: WorkboardOrchestrationSettings;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number;
};

export type WorkboardBoardSummary = Omit<WorkboardBoardMetadata, "createdAt" | "updatedAt"> & {
  total: number;
  active: number;
  archived: number;
  byStatus: Partial<Record<WorkboardStatus, number>>;
  updatedAt?: number;
};

export type WorkboardOrchestrationSettings = {
  autoDecompose?: boolean;
  autoDecomposePerDispatch?: number;
  defaultAssignee?: string;
  orchestratorProfile?: string;
};

export type WorkboardNotificationSubscription = {
  id: string;
  boardId: string;
  cardId?: string;
  sessionKey?: string;
  runId?: string;
  target?: string;
  eventKinds?: WorkboardNotificationKind[];
  lastEventAt?: number;
  lastEventId?: string;
  lastEventSequence?: number;
  deliveredEventIds?: string[];
  createdAt: number;
  updatedAt: number;
};

export type WorkboardMetadata = {
  attempts?: WorkboardRunAttempt[];
  comments?: WorkboardComment[];
  links?: WorkboardLink[];
  proof?: WorkboardProof[];
  artifacts?: WorkboardArtifact[];
  attachments?: WorkboardAttachment[];
  workerLogs?: WorkboardWorkerLog[];
  workerProtocol?: WorkboardWorkerProtocol;
  automation?: WorkboardAutomation;
  claim?: WorkboardClaim;
  diagnostics?: WorkboardDiagnostic[];
  notifications?: WorkboardNotification[];
  templateId?: WorkboardTemplateId;
  archivedAt?: number;
  stale?: WorkboardStaleState;
  lifecycleStatusSourceUpdatedAt?: number;
  failureCount?: number;
};

export type WorkboardCard = {
  id: string;
  title: string;
  notes?: string;
  status: WorkboardStatus;
  priority: WorkboardPriority;
  labels: string[];
  agentId?: string;
  sessionKey?: string;
  runId?: string;
  sourceUrl?: string;
  execution?: WorkboardExecution;
  position: number;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  events?: WorkboardEvent[];
  metadata?: WorkboardMetadata;
};

export type WorkboardCardCursor = {
  position: number;
  createdAt: number;
  id: string;
};

export type WorkboardListResult = {
  cards: WorkboardCard[];
  statuses: readonly WorkboardStatus[];
  nextCursor?: WorkboardCardCursor;
};

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
export type WorkboardSessionsColumnMatch = SchemaContract<ReturnType<typeof normalizeMatch>>;
export type WorkboardSessionsColumn = SchemaContract<ReturnType<typeof normalizeColumn>>;
export type WorkboardSessionsBoardSpec = {
  columns: WorkboardSessionsColumn[];
  scope?: SchemaContract<ReturnType<typeof normalizeScope>>;
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
  pullRequests: Array<{
    number: number;
    state: "open" | "draft" | "merged" | "closed";
    url?: string;
    title?: string;
  }>;
  pullRequestsUnavailable?: boolean;
  pullRequestsRateLimited?: true;
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
export type WorkboardSessionsBoardRevision = WorkboardChange & { boardId: string; scope: string };
export type WorkboardSessionsBoardRead = {
  revision?: WorkboardSessionsBoardRevision;
  board: WorkboardSessionsBoard;
  columns: WorkboardSessionsColumn[];
  sessions: Array<
    WorkboardSessionFacts & Pick<WorkboardSessionPlacement, "columnId" | "source" | "reason">
  >;
  nextCursor?: string;
  total?: number;
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
  const trimmed = typeof value === "string" ? value.trim() : undefined;
  if (trimmed === undefined || trimmed.length < min || trimmed.length > max) {
    throw new Error(`${name} must be a string with ${min}..${max} characters.`);
  }
  return trimmed;
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

function normalizeMatch(value: unknown) {
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

function normalizeColumn(value: unknown) {
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

function normalizeScope(value: unknown) {
  const input = record(value, "scope", [
    "agentIds",
    "includeArchived",
    "includeAutomation",
    "includeHome",
    "maxAgeHours",
  ]);
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
    ...(input.includeAutomation !== undefined
      ? { includeAutomation: boolean(input.includeAutomation, "scope.includeAutomation") }
      : {}),
    ...(input.includeHome !== undefined
      ? { includeHome: boolean(input.includeHome, "scope.includeHome") }
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
