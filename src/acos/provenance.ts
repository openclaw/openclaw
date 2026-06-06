export const ACOS_CONTROLLED_REJECTION_MESSAGE =
  "OpenClaw is running in ACOS-controlled mode. This action requires ACOS task provenance.";

export const ACOS_APPROVAL_REJECTION_MESSAGE =
  "OpenClaw is running in ACOS-controlled mode. This action requires ACOS approval metadata.";

export const ACOS_DIAGNOSTIC_REJECTION_MESSAGE =
  "OpenClaw diagnostic mode is limited to non-mutating checks.";

export type AcosActionClass =
  | "agent_turn"
  | "channel_agent_turn"
  | "cron_agent_turn"
  | "gateway_agent_turn"
  | "shell_exec"
  | "apply_patch";

export type AcosProvenance = {
  acos_dispatch: true;
  dispatcher: "acos";
  acos_task_id: string;
  run_id: string;
  queue_id: string;
  dispatched_at: string;
  approval_granted?: boolean;
  approval_scope?: unknown;
  diagnostic_mode?: boolean;
};

type AcosProvenanceCarrier = {
  acosProvenance?: unknown;
  metadata?: unknown;
};

type AssertAcosActionParams = {
  action: AcosActionClass;
  provenance?: unknown;
  env?: NodeJS.ProcessEnv;
  diagnosticMode?: boolean;
  mutating?: boolean;
  requiresApproval?: boolean;
};

const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes", "on"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isTruthyEnvValue(value: string | undefined): boolean {
  return TRUTHY_ENV_VALUES.has(value?.trim().toLowerCase() ?? "");
}

function readStringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseProvenanceJson(raw: string | undefined): unknown {
  if (!raw?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function isAcosControlledMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    isTruthyEnvValue(env.OPENCLAW_ACOS_CONTROLLED) ||
    isTruthyEnvValue(env.OPENCLAW_DISABLE_AUTONOMOUS_INTAKE)
  );
}

export function readAcosProvenanceFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): AcosProvenance | undefined {
  return normalizeAcosProvenance(parseProvenanceJson(env.OPENCLAW_ACOS_PROVENANCE));
}

export function normalizeAcosProvenance(value: unknown): AcosProvenance | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const carrier: AcosProvenanceCarrier = value;
  const record =
    isRecord(value.metadata) && value.metadata.acos_dispatch === true
      ? value.metadata
      : isRecord(carrier.acosProvenance)
        ? carrier.acosProvenance
        : value;
  if (record.acos_dispatch !== true || record.dispatcher !== "acos") {
    return undefined;
  }
  const acosTaskId = readStringField(record, "acos_task_id");
  const runId = readStringField(record, "run_id");
  const queueId = readStringField(record, "queue_id");
  const dispatchedAt = readStringField(record, "dispatched_at");
  if (!acosTaskId || !runId || !queueId || !dispatchedAt) {
    return undefined;
  }
  return {
    acos_dispatch: true,
    dispatcher: "acos",
    acos_task_id: acosTaskId,
    run_id: runId,
    queue_id: queueId,
    dispatched_at: dispatchedAt,
    approval_granted: record.approval_granted === true,
    approval_scope: record.approval_scope,
    diagnostic_mode: record.diagnostic_mode === true,
  };
}

export function resolveAcosProvenance(
  value: unknown,
  env: NodeJS.ProcessEnv = process.env,
): AcosProvenance | undefined {
  return normalizeAcosProvenance(value) ?? readAcosProvenanceFromEnv(env);
}

function approvalScopeIncludes(scope: unknown, action: AcosActionClass): boolean {
  if (scope === "*") {
    return true;
  }
  if (typeof scope === "string") {
    return scope === action || scope === "repo_mutation" || scope === "dangerous_tools";
  }
  if (Array.isArray(scope)) {
    return scope.some((entry) => approvalScopeIncludes(entry, action));
  }
  if (isRecord(scope)) {
    const direct = scope[action];
    const broad = scope.repo_mutation ?? scope.dangerous_tools;
    return direct === true || broad === true;
  }
  return false;
}

export function hasAcosApproval(
  provenance: AcosProvenance | undefined,
  action: AcosActionClass,
): boolean {
  return (
    provenance?.approval_granted === true &&
    approvalScopeIncludes(provenance.approval_scope, action)
  );
}

export function assertAcosControlledActionAllowed(params: AssertAcosActionParams): void {
  const env = params.env ?? process.env;
  if (!isAcosControlledMode(env)) {
    return;
  }
  const provenance = resolveAcosProvenance(params.provenance, env);
  const diagnosticMode =
    params.diagnosticMode === true ||
    provenance?.diagnostic_mode === true ||
    isTruthyEnvValue(env.OPENCLAW_ACOS_DIAGNOSTIC_MODE);
  if (diagnosticMode) {
    if (params.mutating || params.requiresApproval === true) {
      throw new Error(ACOS_DIAGNOSTIC_REJECTION_MESSAGE);
    }
    return;
  }
  if (!provenance) {
    throw new Error(ACOS_CONTROLLED_REJECTION_MESSAGE);
  }
  if (params.requiresApproval && !hasAcosApproval(provenance, params.action)) {
    throw new Error(ACOS_APPROVAL_REJECTION_MESSAGE);
  }
}
