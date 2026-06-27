export type HermesBridgePriority = "high" | "low" | "normal";

export type HermesBridgeRequest = {
  taskId: string;
  requestedBy: "hermes";
  intent: string;
  priority: HermesBridgePriority;
  requiresConfirmation: boolean;
  allowedTools: string[];
  input: Record<string, unknown>;
  dryRun: boolean;
  requestId?: string;
  idempotencyKey?: string;
};

export type HermesBridgeResultStatus =
  | "accepted"
  | "blocked"
  | "failed"
  | "needs_confirmation"
  | "running"
  | "succeeded";

export type HermesBridgeArtifact = {
  type: string;
  name?: string;
  uri?: string;
  value?: unknown;
};

export type HermesBridgeAuditEvent = {
  step: string;
  message: string;
  at: string;
};

export type HermesBridgeError = {
  type: string;
  message: string;
};

export type HermesBridgeResult = {
  ok: boolean;
  requestId?: string;
  idempotencyKey?: string;
  taskId?: string;
  mode: "live" | "mock";
  status: HermesBridgeResultStatus;
  summary: string;
  artifacts: HermesBridgeArtifact[];
  auditLog: HermesBridgeAuditEvent[];
  output?: unknown;
  error?: HermesBridgeError;
};

export type HermesBridgeValidationResult =
  | { ok: true; request: HermesBridgeRequest }
  | { ok: false; error: HermesBridgeError };

function readObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readPriority(value: unknown): HermesBridgePriority {
  return value === "high" || value === "low" ? value : "normal";
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const seen = new Set<string>();
  const items: string[] = [];
  for (const item of value) {
    const normalized = readString(item);
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    items.push(normalized);
  }
  return items;
}

export function createAuditEvent(step: string, message: string): HermesBridgeAuditEvent {
  return {
    step,
    message,
    at: new Date(0).toISOString(),
  };
}

export function normalizeHermesBridgeRequest(raw: unknown): HermesBridgeValidationResult {
  const record = readObject(raw);
  const taskId = readString(record.taskId);
  if (!taskId) {
    return {
      ok: false,
      error: {
        type: "invalid_request",
        message: "Hermes bridge request requires a string taskId.",
      },
    };
  }
  const requestId = readString(record.requestId);
  const idempotencyKey = readString(record.idempotencyKey) ?? requestId;
  return {
    ok: true,
    request: {
      taskId,
      requestedBy: "hermes",
      intent: readString(record.intent) ?? taskId,
      priority: readPriority(record.priority),
      requiresConfirmation: record.requiresConfirmation === true,
      allowedTools: readStringList(record.allowedTools),
      input: readObject(record.input),
      dryRun: record.dryRun !== false,
      ...(requestId ? { requestId } : {}),
      ...(idempotencyKey ? { idempotencyKey } : {}),
    },
  };
}

export function createHermesBridgeResult(params: {
  ok: boolean;
  request?: Pick<HermesBridgeRequest, "idempotencyKey" | "requestId" | "taskId">;
  mode?: "live" | "mock";
  status: HermesBridgeResultStatus;
  summary: string;
  output?: unknown;
  error?: HermesBridgeError;
  artifacts?: HermesBridgeArtifact[];
  auditLog?: HermesBridgeAuditEvent[];
}): HermesBridgeResult {
  return {
    ok: params.ok,
    ...(params.request?.requestId ? { requestId: params.request.requestId } : {}),
    ...(params.request?.idempotencyKey ? { idempotencyKey: params.request.idempotencyKey } : {}),
    ...(params.request?.taskId ? { taskId: params.request.taskId } : {}),
    mode: params.mode ?? "mock",
    status: params.status,
    summary: params.summary,
    artifacts: params.artifacts ?? [],
    auditLog: params.auditLog ?? [],
    ...(params.output !== undefined ? { output: params.output } : {}),
    ...(params.error ? { error: params.error } : {}),
  };
}
