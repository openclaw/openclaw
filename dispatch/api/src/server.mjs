import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import {
  getDispatchToolPolicy,
  getCommandEndpointPolicy,
} from "../../shared/authorization-policy.mjs";
import {
  IncidentTemplatePolicyError,
  evaluateCloseoutRequirements,
  getIncidentTemplate,
} from "../../workflow-engine/rules/closeout-required-evidence.mjs";
import { createAuthRuntime } from "./auth.mjs";
import { canonicalJsonHash } from "./canonical-json.mjs";
import { closePool, getPool } from "./db.mjs";
import {
  HttpError,
  buildCorrelationId,
  buildTraceId,
  ensureObject,
  errorBody,
  isUuid,
  lowerHeader,
  nowIso,
  parseJsonBody,
  requireUuidField,
  sendJson,
} from "./http-utils.mjs";

const ticketRouteRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCHEDULING_STATES = Object.freeze(["READY_TO_SCHEDULE", "SCHEDULE_PROPOSED", "SCHEDULED"]);
const AUTH_POLICY_ALERT_ERROR_CODES = new Set([
  "FORBIDDEN",
  "FORBIDDEN_SCOPE",
  "TOOL_NOT_ALLOWED",
  "AUTH_REQUIRED",
  "INVALID_AUTH_TOKEN",
  "INVALID_AUTH_CLAIMS",
  "AUTH_CONFIG_ERROR",
]);
const RUNBOOK_PATHS = Object.freeze({
  STUCK_SCHEDULING: "dispatch/ops/runbooks/stuck_scheduling.md",
  COMPLETION_REJECTION_SPIKE: "dispatch/ops/runbooks/completion_rejection.md",
  IDEMPOTENCY_CONFLICT_SPIKE: "dispatch/ops/runbooks/idempotency_conflict.md",
  AUTH_POLICY_FAILURE_SPIKE: "dispatch/ops/runbooks/auth_policy_failure.md",
});
const VALID_TICKET_STATES = Object.freeze([
  "NEW",
  "NEEDS_INFO",
  "TRIAGED",
  "APPROVAL_REQUIRED",
  "READY_TO_SCHEDULE",
  "SCHEDULE_PROPOSED",
  "SCHEDULED",
  "DISPATCHED",
  "ON_SITE",
  "IN_PROGRESS",
  "ON_HOLD",
  "COMPLETED_PENDING_VERIFICATION",
  "VERIFIED",
  "INVOICED",
  "CLOSED",
]);
const VALID_PRIORITIES = Object.freeze(["EMERGENCY", "URGENT", "ROUTINE"]);
const VALID_SLA_STATUSES = Object.freeze(["healthy", "warning", "breach"]);
const SLA_TARGET_MINUTES_BY_PRIORITY = Object.freeze({
  EMERGENCY: 60,
  URGENT: 240,
  ROUTINE: 1440,
});
const SLA_WARNING_THRESHOLD_MINUTES = 30;
const PRIORITY_SORT_ORDER = Object.freeze({
  EMERGENCY: 0,
  URGENT: 1,
  ROUTINE: 2,
});
const POLICY_ERROR_DIMENSION_BY_CODE = Object.freeze({
  FORBIDDEN: "role",
  TOOL_NOT_ALLOWED: "tool",
  INVALID_STATE_TRANSITION: "state",
  FORBIDDEN_SCOPE: "scope",
  CLOSEOUT_REQUIREMENTS_INCOMPLETE: "evidence",
  INVALID_EVIDENCE_REFERENCE: "evidence",
  MISSING_SIGNATURE_CONFIRMATION: "evidence",
  DUPLICATE_INTAKE: "identity",
  LOW_IDENTITY_CONFIDENCE: "identity",
  LOW_CLASSIFICATION_CONFIDENCE: "identity",
  SOP_HANDOFF_REQUIRED: "policy",
  BLIND_INTAKE_VALIDATION_FAILED: "identity",
});
const DISPATCHER_QUEUE_ACTION_BLUEPRINTS = Object.freeze([
  Object.freeze({ action_id: "schedule_propose", tool_name: "schedule.propose" }),
  Object.freeze({ action_id: "schedule_confirm", tool_name: "schedule.confirm" }),
  Object.freeze({ action_id: "dispatch_assignment", tool_name: "assignment.dispatch" }),
  Object.freeze({ action_id: "open_timeline", tool_name: "ticket.timeline" }),
  Object.freeze({ action_id: "open_technician_packet", tool_name: "tech.job_packet" }),
]);
const TECH_PACKET_ACTION_BLUEPRINTS = Object.freeze([
  Object.freeze({ action_id: "check_in", tool_name: "tech.check_in" }),
  Object.freeze({ action_id: "add_evidence", tool_name: "closeout.add_evidence" }),
  Object.freeze({ action_id: "request_change", tool_name: "tech.request_change" }),
  Object.freeze({ action_id: "complete_work", tool_name: "tech.complete" }),
  Object.freeze({ action_id: "open_timeline", tool_name: "ticket.timeline" }),
  Object.freeze({ action_id: "open_evidence", tool_name: "closeout.list_evidence" }),
]);
const BLIND_INTAKE_DEFAULTS = Object.freeze({
  IDENTITY_CONFIDENCE_THRESHOLD: 85,
  CLASSIFICATION_CONFIDENCE_THRESHOLD: 85,
  DUPLICATE_WINDOW_MINUTES: 120,
  SOP_HANDOFF_PROMPT: "Confirm onsite access and completion scope before scheduling.",
});

function normalizeOptionalFilePath(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return null;
  }
  return path.resolve(trimmed);
}

function ensureParentDirectory(filePath) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true });
}

function appendJsonLine(filePath, payload) {
  if (!filePath) {
    return;
  }
  ensureParentDirectory(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function writeJsonSnapshot(filePath, payload) {
  if (!filePath) {
    return;
  }
  ensureParentDirectory(filePath);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function parseNonNegativeInteger(value, fallbackValue) {
  if (value == null || value === "") {
    return fallbackValue;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallbackValue;
  }
  return parsed;
}

function parseConfidencePercent(value, fallbackValue) {
  if (value == null || value === "") {
    return fallbackValue;
  }
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    return fallbackValue;
  }
  return parsed;
}

function resolveBlindIntakePolicy(config = {}) {
  return Object.freeze({
    identityConfidenceThreshold: parseConfidencePercent(
      config.identityConfidenceThreshold ??
        process.env.DISPATCH_INTAKE_IDENTITY_CONFIDENCE_THRESHOLD,
      BLIND_INTAKE_DEFAULTS.IDENTITY_CONFIDENCE_THRESHOLD,
    ),
    classificationConfidenceThreshold: parseConfidencePercent(
      config.classificationConfidenceThreshold ??
        process.env.DISPATCH_INTAKE_CLASSIFICATION_CONFIDENCE_THRESHOLD,
      BLIND_INTAKE_DEFAULTS.CLASSIFICATION_CONFIDENCE_THRESHOLD,
    ),
    duplicateWindowMinutes: parseNonNegativeInteger(
      config.duplicateWindowMinutes ?? process.env.DISPATCH_INTAKE_DUPLICATE_WINDOW_MINUTES,
      BLIND_INTAKE_DEFAULTS.DUPLICATE_WINDOW_MINUTES,
    ),
    sopHandoffPrompt:
      typeof config.sopHandoffPrompt === "string" && config.sopHandoffPrompt.trim() !== ""
        ? config.sopHandoffPrompt.trim()
        : BLIND_INTAKE_DEFAULTS.SOP_HANDOFF_PROMPT,
  });
}

function resolveAlertThresholds(config = {}) {
  return Object.freeze({
    stuck_scheduling_count: parseNonNegativeInteger(
      config.stuckSchedulingCount ?? process.env.DISPATCH_ALERT_STUCK_SCHEDULING_COUNT_THRESHOLD,
      5,
    ),
    stuck_scheduling_minutes: parseNonNegativeInteger(
      config.stuckSchedulingMinutes ?? process.env.DISPATCH_ALERT_STUCK_SCHEDULING_MINUTES,
      60,
    ),
    completion_rejection_count: parseNonNegativeInteger(
      config.completionRejectionCount ?? process.env.DISPATCH_ALERT_COMPLETION_REJECTION_THRESHOLD,
      3,
    ),
    idempotency_conflict_count: parseNonNegativeInteger(
      config.idempotencyConflictCount ?? process.env.DISPATCH_ALERT_IDEMPOTENCY_CONFLICT_THRESHOLD,
      2,
    ),
    auth_policy_rejection_count: parseNonNegativeInteger(
      config.authPolicyRejectionCount ?? process.env.DISPATCH_ALERT_AUTH_POLICY_REJECTION_THRESHOLD,
      5,
    ),
  });
}

function emitStructuredLog(logger, level, payload, options = {}) {
  const record = {
    level,
    service: "dispatch-api",
    ...payload,
  };

  if (options.logSinkPath) {
    try {
      appendJsonLine(options.logSinkPath, record);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          service: "dispatch-api",
          message: "failed to append structured log to sink",
          sink_path: options.logSinkPath,
          error: error?.message ?? String(error),
        }),
      );
    }
  }

  const line = JSON.stringify(record);

  if (level === "error") {
    if (logger && typeof logger.error === "function") {
      logger.error(line);
      return;
    }
    console.error(line);
    return;
  }

  if (logger && typeof logger.info === "function") {
    logger.info(line);
    return;
  }
  if (logger && typeof logger.log === "function") {
    logger.log(line);
    return;
  }
  console.log(line);
}

function createMetricsRegistry(options = {}) {
  const requestsTotal = new Map();
  const errorsTotal = new Map();
  const transitionsTotal = new Map();
  let idempotencyReplayTotal = 0;
  let idempotencyConflictTotal = 0;
  const onChange = typeof options.onChange === "function" ? options.onChange : null;

  function incrementCounter(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  function buildSnapshot() {
    const requests = Array.from(requestsTotal.entries())
      .map(([key, count]) => {
        const [method, endpoint, status] = JSON.parse(key);
        return {
          method,
          endpoint,
          status: Number(status),
          count,
        };
      })
      .toSorted(
        (left, right) =>
          left.method.localeCompare(right.method) ||
          left.endpoint.localeCompare(right.endpoint) ||
          left.status - right.status,
      );

    const errors = Array.from(errorsTotal.entries())
      .map(([code, count]) => ({
        code,
        count,
      }))
      .toSorted((left, right) => left.code.localeCompare(right.code));

    const transitions = Array.from(transitionsTotal.entries())
      .map(([key, count]) => {
        const [fromState, toState] = JSON.parse(key);
        return {
          from_state: fromState,
          to_state: toState,
          count,
        };
      })
      .toSorted((left, right) => {
        const leftFrom = left.from_state ?? "";
        const rightFrom = right.from_state ?? "";
        const fromOrder = leftFrom.localeCompare(rightFrom);
        if (fromOrder !== 0) {
          return fromOrder;
        }

        const leftTo = left.to_state ?? "";
        const rightTo = right.to_state ?? "";
        return leftTo.localeCompare(rightTo);
      });

    return {
      service: "dispatch-api",
      generated_at: nowIso(),
      counters: {
        requests_total: requests,
        errors_total: errors,
        transitions_total: transitions,
        idempotency_replay_total: idempotencyReplayTotal,
        idempotency_conflict_total: idempotencyConflictTotal,
      },
    };
  }

  function publishSnapshot() {
    if (!onChange) {
      return;
    }
    try {
      onChange(buildSnapshot());
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          service: "dispatch-api",
          message: "metrics onChange callback failed",
          error: error?.message ?? String(error),
        }),
      );
    }
  }

  const registry = {
    incrementRequest(method, endpoint, status) {
      const key = JSON.stringify([String(method), String(endpoint), Number(status)]);
      incrementCounter(requestsTotal, key);
      publishSnapshot();
    },
    incrementError(code) {
      const normalized =
        typeof code === "string" && code.trim() !== "" ? code.trim() : "UNKNOWN_ERROR";
      incrementCounter(errorsTotal, normalized);
      publishSnapshot();
    },
    incrementTransition(fromState, toState) {
      const key = JSON.stringify([fromState ?? null, toState ?? null]);
      incrementCounter(transitionsTotal, key);
      publishSnapshot();
    },
    incrementIdempotencyReplay() {
      idempotencyReplayTotal += 1;
      publishSnapshot();
    },
    incrementIdempotencyConflict() {
      idempotencyConflictTotal += 1;
      publishSnapshot();
    },
    snapshot() {
      return buildSnapshot();
    },
  };

  publishSnapshot();
  return registry;
}

function findErrorCounterCount(snapshot, code) {
  const counter = snapshot.counters.errors_total.find((entry) => entry.code === code);
  return Number(counter?.count ?? 0);
}

function sumAuthPolicyFailureCount(snapshot) {
  return snapshot.counters.errors_total.reduce((total, entry) => {
    if (!AUTH_POLICY_ALERT_ERROR_CODES.has(entry.code)) {
      return total;
    }
    return total + Number(entry.count ?? 0);
  }, 0);
}

async function queryStuckSchedulingCount(pool, staleMinutes) {
  const result = await pool.query(
    `
      SELECT count(*)::int AS count
      FROM tickets t
      INNER JOIN LATERAL (
        SELECT max(created_at) AS entered_at
        FROM ticket_state_transitions tr
        WHERE tr.ticket_id = t.id
          AND tr.to_state = t.state
      ) latest ON true
      WHERE t.state = ANY($1::ticket_state[])
        AND latest.entered_at IS NOT NULL
        AND latest.entered_at <= now() - ($2::int * interval '1 minute')
    `,
    [SCHEDULING_STATES, staleMinutes],
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function buildOperationalAlertsSnapshot(params) {
  const { pool, metrics, alertThresholds } = params;

  const metricsSnapshot = metrics.snapshot();
  const stuckSchedulingCount = await queryStuckSchedulingCount(
    pool,
    alertThresholds.stuck_scheduling_minutes,
  );
  const completionRejectionCount = findErrorCounterCount(
    metricsSnapshot,
    "CLOSEOUT_REQUIREMENTS_INCOMPLETE",
  );
  const idempotencyConflictCount = Number(metricsSnapshot.counters.idempotency_conflict_total ?? 0);
  const authPolicyFailureCount = sumAuthPolicyFailureCount(metricsSnapshot);

  const alerts = [];
  if (stuckSchedulingCount >= alertThresholds.stuck_scheduling_count) {
    alerts.push({
      code: "STUCK_SCHEDULING",
      severity: "warning",
      count: stuckSchedulingCount,
      threshold: alertThresholds.stuck_scheduling_count,
      stale_minutes: alertThresholds.stuck_scheduling_minutes,
      runbook: RUNBOOK_PATHS.STUCK_SCHEDULING,
    });
  }
  if (completionRejectionCount >= alertThresholds.completion_rejection_count) {
    alerts.push({
      code: "COMPLETION_REJECTION_SPIKE",
      severity: "warning",
      count: completionRejectionCount,
      threshold: alertThresholds.completion_rejection_count,
      runbook: RUNBOOK_PATHS.COMPLETION_REJECTION_SPIKE,
    });
  }
  if (idempotencyConflictCount >= alertThresholds.idempotency_conflict_count) {
    alerts.push({
      code: "IDEMPOTENCY_CONFLICT_SPIKE",
      severity: "warning",
      count: idempotencyConflictCount,
      threshold: alertThresholds.idempotency_conflict_count,
      runbook: RUNBOOK_PATHS.IDEMPOTENCY_CONFLICT_SPIKE,
    });
  }
  if (authPolicyFailureCount >= alertThresholds.auth_policy_rejection_count) {
    alerts.push({
      code: "AUTH_POLICY_FAILURE_SPIKE",
      severity: "warning",
      count: authPolicyFailureCount,
      threshold: alertThresholds.auth_policy_rejection_count,
      runbook: RUNBOOK_PATHS.AUTH_POLICY_FAILURE_SPIKE,
    });
  }

  return {
    service: "dispatch-api",
    generated_at: nowIso(),
    thresholds: alertThresholds,
    signals: {
      stuck_scheduling_count: stuckSchedulingCount,
      completion_rejection_count: completionRejectionCount,
      idempotency_conflict_count: idempotencyConflictCount,
      auth_policy_rejection_count: authPolicyFailureCount,
    },
    alerts,
    runbooks: RUNBOOK_PATHS,
    metrics: {
      generated_at: metricsSnapshot.generated_at,
      counters: metricsSnapshot.counters,
    },
  };
}

function classifyPolicyError(errorCode, details = {}) {
  if (errorCode === "CLOSEOUT_REQUIREMENTS_INCOMPLETE") {
    return {
      dimension: "evidence",
      requirement_code: details.requirement_code ?? "UNKNOWN_REQUIREMENT",
    };
  }

  const dimension = POLICY_ERROR_DIMENSION_BY_CODE[errorCode];
  if (!dimension) {
    return null;
  }

  return {
    dimension,
  };
}

function attachPolicyErrorContext(errorPayload) {
  if (!errorPayload || typeof errorPayload !== "object") {
    return;
  }

  const policyError = classifyPolicyError(errorPayload.code, errorPayload);
  if (!policyError) {
    return;
  }

  errorPayload.policy_error = policyError;
}

function serializeTicket(row) {
  return {
    id: row.id,
    account_id: row.account_id,
    site_id: row.site_id,
    asset_id: row.asset_id,
    state: row.state,
    priority: row.priority,
    incident_type: row.incident_type,
    summary: row.summary,
    description: row.description,
    customer_name: row.customer_name,
    customer_phone: row.customer_phone,
    customer_email: row.customer_email,
    nte_cents: Number(row.nte_cents),
    scheduled_start: row.scheduled_start ? new Date(row.scheduled_start).toISOString() : null,
    scheduled_end: row.scheduled_end ? new Date(row.scheduled_end).toISOString() : null,
    identity_signature: row.identity_signature,
    identity_confidence: row.identity_confidence == null ? 0 : Number(row.identity_confidence),
    classification_confidence:
      row.classification_confidence == null ? 0 : Number(row.classification_confidence),
    sop_handoff_required: Boolean(row.sop_handoff_required ?? false),
    sop_handoff_acknowledged: Boolean(row.sop_handoff_acknowledged ?? false),
    sop_handoff_prompt: row.sop_handoff_prompt ?? null,
    assigned_provider_id: row.assigned_provider_id,
    assigned_tech_id: row.assigned_tech_id,
    version: Number(row.version),
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

function serializeAuditEvent(row) {
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    actor_type: row.actor_type,
    actor_id: row.actor_id,
    actor_role: row.actor_role,
    tool_name: row.tool_name,
    request_id: row.request_id,
    correlation_id: row.correlation_id,
    trace_id: row.trace_id,
    before_state: row.before_state,
    after_state: row.after_state,
    payload: row.payload,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function serializeEvidenceItem(row) {
  return {
    id: row.id,
    ticket_id: row.ticket_id,
    kind: row.kind,
    uri: row.uri,
    checksum: row.checksum,
    metadata: row.metadata ?? {},
    created_by: row.created_by,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

function getCommandPolicy(endpoint) {
  const policy = getCommandEndpointPolicy(endpoint);
  if (!policy) {
    throw new HttpError(500, "INTERNAL_ERROR", "Missing command authorization policy");
  }
  return policy;
}

function parseIdempotencyKey(headers) {
  const requestId = lowerHeader(headers, "idempotency-key");
  if (!requestId || requestId.trim() === "") {
    throw new HttpError(
      400,
      "MISSING_IDEMPOTENCY_KEY",
      "Header 'Idempotency-Key' is required for command endpoints",
    );
  }

  if (!isUuid(requestId.trim())) {
    throw new HttpError(
      400,
      "INVALID_IDEMPOTENCY_KEY",
      "Header 'Idempotency-Key' must be a valid UUID",
    );
  }

  return requestId.trim();
}

async function insertAuditEvent(client, params) {
  const {
    ticketId,
    beforeState,
    afterState,
    actorType,
    actorId,
    actorRole,
    toolName,
    requestId,
    correlationId,
    traceId,
    payload,
  } = params;

  const auditResult = await client.query(
    `
      INSERT INTO audit_events (
        ticket_id,
        actor_type,
        actor_id,
        actor_role,
        tool_name,
        request_id,
        correlation_id,
        trace_id,
        before_state,
        after_state,
        payload
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
      RETURNING id
    `,
    [
      ticketId,
      actorType,
      actorId,
      actorRole,
      toolName,
      requestId,
      correlationId,
      traceId,
      beforeState,
      afterState,
      payload,
    ],
  );

  return auditResult.rows[0].id;
}

async function insertTransitionRow(client, params) {
  const { ticketId, fromState, toState, auditEventId, metrics } = params;

  await client.query(
    `
      INSERT INTO ticket_state_transitions (
        ticket_id,
        from_state,
        to_state,
        audit_event_id
      )
      VALUES ($1,$2,$3,$4)
    `,
    [ticketId, fromState, toState, auditEventId],
  );

  if (metrics && typeof metrics.incrementTransition === "function") {
    metrics.incrementTransition(fromState, toState);
  }
}

async function insertAuditAndTransition(client, params) {
  const { ticketId, beforeState, afterState, metrics } = params;
  const auditEventId = await insertAuditEvent(client, params);
  await insertTransitionRow(client, {
    ticketId,
    fromState: beforeState,
    toState: afterState,
    auditEventId,
    metrics,
  });
}

async function getTicketForUpdate(client, ticketId) {
  const result = await client.query("SELECT * FROM tickets WHERE id = $1 FOR UPDATE", [ticketId]);
  if (result.rowCount === 0) {
    throw new HttpError(404, "TICKET_NOT_FOUND", "Ticket not found");
  }
  return result.rows[0];
}

function assertCommandStateAllowed(endpoint, fromState, body) {
  const policy = getCommandPolicy(endpoint);
  const allowedFromStates = policy.allowed_from_states;

  if (Array.isArray(allowedFromStates) && !allowedFromStates.includes(fromState)) {
    throw new HttpError(409, "INVALID_STATE_TRANSITION", "Transition is not allowed", {
      from_state: fromState,
      to_state: policy.expected_to_state,
    });
  }

  if (endpoint === "/tickets/{ticketId}/assignment/dispatch" && fromState === "TRIAGED") {
    const dispatchMode = typeof body.dispatch_mode === "string" ? body.dispatch_mode.trim() : null;
    if (dispatchMode !== "EMERGENCY_BYPASS") {
      throw new HttpError(
        409,
        "INVALID_STATE_TRANSITION",
        "TRIAGED -> DISPATCHED requires explicit emergency bypass reason",
        {
          from_state: fromState,
          to_state: policy.expected_to_state,
        },
      );
    }
  }
}

function validateTicketId(ticketId) {
  if (!isUuid(ticketId)) {
    throw new HttpError(400, "INVALID_TICKET_ID", "Path parameter 'ticketId' must be a valid UUID");
  }
}

async function assertTicketExists(pool, ticketId) {
  const ticketExists = await pool.query("SELECT 1 FROM tickets WHERE id = $1", [ticketId]);
  if (ticketExists.rowCount === 0) {
    throw new HttpError(404, "TICKET_NOT_FOUND", "Ticket not found");
  }
}

async function getTicket(pool, ticketId) {
  validateTicketId(ticketId);
  const result = await pool.query("SELECT * FROM tickets WHERE id = $1", [ticketId]);
  if (result.rowCount === 0) {
    throw new HttpError(404, "TICKET_NOT_FOUND", "Ticket not found");
  }
  return serializeTicket(result.rows[0]);
}

async function getTicketTimeline(pool, ticketId) {
  validateTicketId(ticketId);
  await assertTicketExists(pool, ticketId);

  const result = await pool.query(
    `
      SELECT
        id,
        ticket_id,
        actor_type,
        actor_id,
        actor_role,
        tool_name,
        request_id,
        correlation_id,
        trace_id,
        before_state,
        after_state,
        payload,
        created_at
      FROM audit_events
      WHERE ticket_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [ticketId],
  );

  return {
    ticket_id: ticketId,
    events: result.rows.map(serializeAuditEvent),
  };
}

async function getTicketEvidence(pool, ticketId) {
  validateTicketId(ticketId);
  await assertTicketExists(pool, ticketId);

  const result = await pool.query(
    `
      SELECT
        id,
        ticket_id,
        kind,
        uri,
        checksum,
        metadata,
        created_by,
        created_at
      FROM evidence_items
      WHERE ticket_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [ticketId],
  );

  return {
    ticket_id: ticketId,
    evidence: result.rows.map(serializeEvidenceItem),
  };
}

function parseSearchValues(searchParams, key, options = {}) {
  const { uppercase = false } = options;
  const values = [];

  for (const rawValue of searchParams.getAll(key)) {
    const normalizedRaw = typeof rawValue === "string" ? rawValue : String(rawValue ?? "");
    for (const entry of normalizedRaw.split(",")) {
      const trimmed = entry.trim();
      if (trimmed === "") {
        continue;
      }
      values.push(uppercase ? trimmed.toUpperCase() : trimmed);
    }
  }

  return uniqueSorted(values);
}

function parseEnumSearchFilter(searchParams, key, allowedValues, options = {}) {
  const values = parseSearchValues(searchParams, key, options);
  if (values.length === 0) {
    return [];
  }

  for (const value of values) {
    if (!allowedValues.includes(value)) {
      throw new HttpError(400, "INVALID_QUERY", `Query '${key}' has unsupported value '${value}'`);
    }
  }

  return values;
}

function parseUuidSearchFilter(searchParams, key) {
  const values = parseSearchValues(searchParams, key, { uppercase: false });
  if (values.length === 0) {
    return [];
  }
  for (const value of values) {
    if (!isUuid(value)) {
      throw new HttpError(400, "INVALID_QUERY", `Query '${key}' must contain UUID values`);
    }
  }
  return values.map((value) => value.toLowerCase());
}

function resolveActorScopeFilter(actor) {
  const accountScope = actor?.scope?.account_ids ?? [];
  const siteScope = actor?.scope?.site_ids ?? [];
  const accountWildcard = accountScope.includes("*");
  const siteWildcard = siteScope.includes("*");

  const accountIds = [];
  for (const entry of accountScope) {
    if (entry === "*") {
      continue;
    }
    if (!isUuid(entry)) {
      throw new HttpError(403, "FORBIDDEN_SCOPE", "Actor scope does not include account_id", {
        scope_field: "account_id",
      });
    }
    accountIds.push(entry.toLowerCase());
  }

  const siteIds = [];
  for (const entry of siteScope) {
    if (entry === "*") {
      continue;
    }
    if (!isUuid(entry)) {
      throw new HttpError(403, "FORBIDDEN_SCOPE", "Actor scope does not include site_id", {
        scope_field: "site_id",
      });
    }
    siteIds.push(entry.toLowerCase());
  }

  if (!accountWildcard && accountIds.length === 0) {
    throw new HttpError(403, "FORBIDDEN_SCOPE", "Actor is missing 'account_id' scope", {
      scope_field: "account_id",
    });
  }
  if (!siteWildcard && siteIds.length === 0) {
    throw new HttpError(403, "FORBIDDEN_SCOPE", "Actor is missing 'site_id' scope", {
      scope_field: "site_id",
    });
  }

  return {
    account_wildcard: accountWildcard,
    site_wildcard: siteWildcard,
    account_ids: uniqueSorted(accountIds),
    site_ids: uniqueSorted(siteIds),
  };
}

function formatSignedDurationMinutes(totalMinutes) {
  const normalized = Number.isFinite(totalMinutes) ? Math.trunc(totalMinutes) : 0;
  const sign = normalized < 0 ? "-" : "";
  const absolute = Math.abs(normalized);
  const hours = Math.floor(absolute / 60);
  const minutes = absolute % 60;
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function resolveSlaDelayAttribution(state) {
  if (state === "APPROVAL_REQUIRED") {
    return "customer";
  }
  if (
    state === "SCHEDULED" ||
    state === "DISPATCHED" ||
    state === "ON_SITE" ||
    state === "IN_PROGRESS" ||
    state === "ON_HOLD" ||
    state === "COMPLETED_PENDING_VERIFICATION"
  ) {
    return "provider";
  }
  return "unknown";
}

function computeSlaSnapshot(ticketRow, nowAt = new Date()) {
  const priority =
    typeof ticketRow.priority === "string" && VALID_PRIORITIES.includes(ticketRow.priority)
      ? ticketRow.priority
      : "ROUTINE";
  const targetMinutes =
    SLA_TARGET_MINUTES_BY_PRIORITY[priority] ?? SLA_TARGET_MINUTES_BY_PRIORITY.ROUTINE;
  const baseDate = ticketRow.scheduled_start
    ? new Date(ticketRow.scheduled_start)
    : new Date(ticketRow.created_at);
  const deadlineMs = baseDate.getTime() + targetMinutes * 60_000;
  const remainingMinutes = Math.floor((deadlineMs - nowAt.getTime()) / 60_000);
  const slaStatus =
    remainingMinutes < 0
      ? "breach"
      : remainingMinutes <= SLA_WARNING_THRESHOLD_MINUTES
        ? "warning"
        : "healthy";

  return {
    sla_target_minutes: targetMinutes,
    sla_deadline_at: new Date(deadlineMs).toISOString(),
    sla_timer_remaining_minutes: remainingMinutes,
    sla_timer_remaining: formatSignedDurationMinutes(remainingMinutes),
    sla_status: slaStatus,
    sla_delay_attribution: resolveSlaDelayAttribution(ticketRow.state),
  };
}

function createActionPolicyError(code, message, details = {}) {
  const classification = classifyPolicyError(code, details);
  return {
    code,
    message,
    dimension: classification?.dimension ?? "unknown",
    ...details,
  };
}

function buildActionDescriptor(params) {
  const {
    actionId,
    toolName,
    actorRole,
    ticketId,
    ticketState = null,
    extraPolicyError = null,
  } = params;
  const policy = getDispatchToolPolicy(toolName);
  if (!policy) {
    throw new HttpError(500, "INTERNAL_ERROR", `Missing action tool policy '${toolName}'`);
  }

  const endpoint = policy.requires_ticket_id
    ? policy.endpoint.replace("{ticketId}", String(ticketId ?? ""))
    : policy.endpoint;
  let policyError = null;

  if (!policy.allowed_roles.includes(actorRole)) {
    policyError = createActionPolicyError(
      "FORBIDDEN",
      `Actor role '${actorRole}' is not allowed for action`,
      {
        actor_role: actorRole,
        allowed_roles: policy.allowed_roles,
      },
    );
  } else if (
    Array.isArray(policy.allowed_from_states) &&
    ticketState &&
    !policy.allowed_from_states.includes(ticketState)
  ) {
    policyError = createActionPolicyError(
      "INVALID_STATE_TRANSITION",
      "Ticket state does not allow this action",
      {
        from_state: ticketState,
        allowed_from_states: policy.allowed_from_states,
        to_state: policy.expected_to_state ?? null,
      },
    );
  } else if (extraPolicyError) {
    policyError = extraPolicyError;
  }

  return {
    action_id: actionId,
    tool_name: policy.tool_name,
    endpoint,
    method: policy.method,
    mutating: policy.mutating,
    enabled: policyError == null,
    policy_error: policyError,
  };
}

function normalizeStringTrimmed(value, fieldName, { required = false, fallback = null } = {}) {
  if (value == null || value === "") {
    if (required) {
      throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' is required`);
    }
    return fallback;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' must be a non-empty string`);
  }
  return value.trim();
}

function normalizeBoolean(value, fieldName, { required = false, fallback = null } = {}) {
  if (value == null) {
    if (required) {
      throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' is required`);
    }
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' must be a boolean`);
  }
  return value;
}

function normalizeConfidence(value, fieldName) {
  if (value == null) {
    throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' is required`);
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      `Field '${fieldName}' must be a confidence number from 0 to 100`,
    );
  }
  return Math.trunc(parsed);
}

function normalizePhone(value, fieldName) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' must be a non-empty string`);
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 16) {
    throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' must include 7-16 digits`);
  }
  return digits;
}

function normalizeEmail(value, fieldName) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' must be a non-empty string`);
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized.includes("@") || normalized.includes(" ")) {
    throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' must be a valid email`);
  }
  return normalized;
}

function isPriorityAllowed(value) {
  return value && VALID_PRIORITIES.includes(value);
}

function evaluateBlindIntakeReadiness(intake, policy) {
  const reasons = [];
  if (intake.identity_confidence < policy.identityConfidenceThreshold) {
    reasons.push("IDENTITY_CONFIDENCE");
  }
  if (intake.classification_confidence < policy.classificationConfidenceThreshold) {
    reasons.push("CLASSIFICATION_CONFIDENCE");
  }
  if (!intake.sop_handoff_acknowledged) {
    reasons.push("SOP_HANDOFF_REQUIRED");
  }

  return {
    ready: reasons.length === 0,
    readiness_reasons: reasons,
  };
}

function parseBlindIntakePayload(body, policy) {
  const accountId = normalizeStringTrimmed(body.account_id, "account_id", { required: true });
  const siteId = normalizeStringTrimmed(body.site_id, "site_id", { required: true });
  if (!isUuid(accountId)) {
    throw new HttpError(400, "INVALID_REQUEST", "Field 'account_id' must be a valid UUID");
  }
  if (!isUuid(siteId)) {
    throw new HttpError(400, "INVALID_REQUEST", "Field 'site_id' must be a valid UUID");
  }
  const summary = normalizeStringTrimmed(body.summary, "summary", { required: true });
  const incidentType = normalizeStringTrimmed(body.incident_type, "incident_type", {
    required: true,
  });
  const customerName = normalizeStringTrimmed(body.customer_name, "customer_name", {
    required: true,
  });
  const customerPhone = normalizePhone(body.contact_phone, "contact_phone");
  const customerEmail = normalizeEmail(body.contact_email, "contact_email");
  if (customerPhone == null && customerEmail == null) {
    throw new HttpError(
      400,
      "BLIND_INTAKE_VALIDATION_FAILED",
      "Either 'contact_phone' or 'contact_email' is required",
      {
        missing_contact_channel: true,
      },
    );
  }

  const priorityRaw = normalizeStringTrimmed(body.priority, "priority", {
    required: true,
  }).toUpperCase();
  if (!isPriorityAllowed(priorityRaw)) {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      "Field 'priority' must be EMERGENCY, URGENT, or ROUTINE",
    );
  }

  const description = normalizeStringTrimmed(body.description, "description", {
    required: false,
    fallback: null,
  });
  const nteCents = body.nte_cents == null ? 0 : Number(body.nte_cents);
  if (!Number.isFinite(nteCents) || nteCents < 0) {
    throw new HttpError(400, "INVALID_REQUEST", "Field 'nte_cents' must be a non-negative number");
  }
  const identityConfidence = normalizeConfidence(body.identity_confidence, "identity_confidence");
  const classificationConfidence = normalizeConfidence(
    body.classification_confidence,
    "classification_confidence",
  );
  const sopHandoffAcknowledged = normalizeBoolean(
    body.sop_handoff_acknowledged,
    "sop_handoff_acknowledged",
    {
      fallback: false,
    },
  );
  const contactPhone = customerPhone;
  const readiness = evaluateBlindIntakeReadiness(
    {
      identity_confidence: identityConfidence,
      classification_confidence: classificationConfidence,
      sop_handoff_acknowledged: sopHandoffAcknowledged,
    },
    policy,
  );

  const requestedSopPrompt = normalizeStringTrimmed(body.sop_handoff_prompt, "sop_handoff_prompt", {
    required: false,
    fallback: null,
  });

  return {
    accountId,
    siteId,
    summary,
    incidentType,
    description,
    customerName,
    customerPhone: contactPhone,
    customerEmail,
    priority: priorityRaw,
    nteCents,
    identityConfidence,
    classificationConfidence,
    sopHandoffAcknowledged,
    readiness,
    sopHandoffPrompt: requestedSopPrompt ?? policy.sopHandoffPrompt,
  };
}

function buildIntakeIdentitySignature(payload) {
  return canonicalJsonHash({
    account_id: payload.accountId.toLowerCase(),
    site_id: payload.siteId.toLowerCase(),
    incident_type: payload.incidentType.trim().toUpperCase(),
    summary: payload.summary.trim().toLowerCase(),
    customer_name: payload.customerName.trim().toLowerCase(),
    contact_phone: payload.customerPhone || null,
    contact_email: payload.customerEmail || null,
  });
}

function toBlindIntakeEligibilityPayload(ticketRow, policy) {
  const identityConfidence = Number(ticketRow.identity_confidence ?? 0);
  const classificationConfidence = Number(ticketRow.classification_confidence ?? 0);
  return {
    identity_confidence: identityConfidence,
    classification_confidence: classificationConfidence,
    identity_threshold: policy.identityConfidenceThreshold,
    classification_threshold: policy.classificationConfidenceThreshold,
    sop_handoff_required: Boolean(ticketRow.sop_handoff_required ?? false),
    sop_handoff_acknowledged: Boolean(ticketRow.sop_handoff_acknowledged ?? false),
  };
}

function assertReadyToScheduleGuard(ticket, body, policy) {
  const requestedSopAck = normalizeBoolean(
    body.sop_handoff_acknowledged,
    "sop_handoff_acknowledged",
    { fallback: false },
  );
  const context = toBlindIntakeEligibilityPayload(ticket, policy);
  if (context.identity_confidence < policy.identityConfidenceThreshold) {
    throw new HttpError(
      409,
      "LOW_IDENTITY_CONFIDENCE",
      "Identity confidence is below schedulability threshold",
      {
        evidence: "identity_confidence_below_threshold",
        identity_confidence: context.identity_confidence,
        identity_threshold: context.identity_threshold,
      },
    );
  }
  if (context.classification_confidence < policy.classificationConfidenceThreshold) {
    throw new HttpError(
      409,
      "LOW_CLASSIFICATION_CONFIDENCE",
      "Classification confidence is below schedulability threshold",
      {
        evidence: "classification_confidence_below_threshold",
        classification_confidence: context.classification_confidence,
        classification_threshold: context.classification_threshold,
      },
    );
  }
  if (context.sop_handoff_required && !requestedSopAck && !context.sop_handoff_acknowledged) {
    throw new HttpError(
      409,
      "SOP_HANDOFF_REQUIRED",
      "SOP handoff acknowledgment is required before scheduling",
      {
        evidence: "sop_handoff_acknowledgment_missing",
      },
    );
  }
}

async function findOpenIntakeDuplicate(client, payload) {
  const result = await client.query(
    `
      SELECT id, state, created_at
      FROM tickets
      WHERE account_id = $1
        AND site_id = $2
        AND identity_signature = $3
        AND state <> 'CLOSED'
        AND created_at >= (now() - ($4::int * interval '1 minute'))
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [
      payload.accountId,
      payload.siteId,
      payload.identity_signature,
      payload.duplicate_window_minutes,
    ],
  );
  if (result.rowCount === 0) {
    return null;
  }
  return result.rows[0];
}

async function linkDuplicateIntakeAttempt(client, context) {
  const { payload, existingTicket, actor, requestId, correlationId, traceId, blindIntakePolicy } =
    context;
  await insertAuditEvent(client, {
    ticketId: existingTicket.id,
    beforeState: existingTicket.state,
    afterState: existingTicket.state,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    toolName: actor.toolName,
    requestId,
    correlationId,
    traceId,
    payload: {
      endpoint: "/tickets/intake",
      requested_at: nowIso(),
      error_code: "DUPLICATE_INTAKE",
      duplicate_window_minutes: blindIntakePolicy.duplicateWindowMinutes,
      identity_signature: payload.identity_signature,
      request: payload.request,
      duplicate_ticket_id: existingTicket.id,
    },
  });
}

function parseCompletionChecklistStatus(payload) {
  const checklist = payload?.request?.checklist_status;
  if (!checklist || typeof checklist !== "object" || Array.isArray(checklist)) {
    return {};
  }
  return checklist;
}

function normalizeChecklistStatus(requiredChecklistKeys, sourceStatus) {
  const normalized = {};
  for (const key of requiredChecklistKeys) {
    normalized[key] = sourceStatus[key] === true;
  }
  return normalized;
}

async function getLatestCompletionPayload(pool, ticketId) {
  const result = await pool.query(
    `
      SELECT payload
      FROM audit_events
      WHERE ticket_id = $1
        AND tool_name = 'tech.complete'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [ticketId],
  );
  if (result.rowCount === 0) {
    return null;
  }
  return result.rows[0].payload ?? null;
}

function evaluatePacketCloseoutGate(params) {
  const { incidentType, evidenceRows, checklistStatus, noSignatureReason, objectStoreSchemes } =
    params;

  if (typeof incidentType !== "string" || incidentType.trim() === "") {
    return {
      ready: false,
      code: "TEMPLATE_NOT_FOUND",
      incident_type: null,
      template_version: null,
      missing_evidence_keys: [],
      missing_checklist_keys: [],
      invalid_evidence_refs: [],
      signature_satisfied: false,
      no_signature_reason: noSignatureReason,
    };
  }

  const normalizedIncidentType = incidentType.trim().toUpperCase();
  let evidenceValidation;
  try {
    evidenceValidation = resolveCloseoutValidationContext({
      incidentType: normalizedIncidentType,
      noSignatureReason,
      explicitEvidenceRefs: [],
      evidenceRows,
      objectStoreSchemes,
    });
  } catch (error) {
    if (error instanceof HttpError && error.code === "CLOSEOUT_REQUIREMENTS_INCOMPLETE") {
      return {
        ready: false,
        code: error.details.requirement_code ?? "MISSING_REQUIREMENTS",
        incident_type: error.details.incident_type ?? normalizedIncidentType,
        template_version: error.details.template_version ?? null,
        missing_evidence_keys: error.details.missing_evidence_keys ?? [],
        missing_checklist_keys: error.details.missing_checklist_keys ?? [],
        invalid_evidence_refs: error.details.invalid_evidence_refs ?? [],
        signature_satisfied: false,
        no_signature_reason: noSignatureReason,
      };
    }
    throw error;
  }

  if (evidenceValidation.invalid_evidence_refs.length > 0) {
    return {
      ready: false,
      code: "INVALID_EVIDENCE_REFERENCE",
      incident_type: normalizedIncidentType,
      template_version: null,
      missing_evidence_keys: [],
      missing_checklist_keys: [],
      invalid_evidence_refs: evidenceValidation.invalid_evidence_refs,
      signature_satisfied: evidenceValidation.signature_satisfied,
      no_signature_reason: noSignatureReason,
    };
  }

  const evidenceKeys = [];
  for (const row of evidenceRows) {
    const evidenceKey = readEvidenceKeyFromMetadata(row.metadata);
    if (evidenceKey) {
      evidenceKeys.push(evidenceKey);
    }
  }
  if (
    evidenceValidation.signature_satisfied &&
    !evidenceKeys.includes("signature_or_no_signature_reason")
  ) {
    evidenceKeys.push("signature_or_no_signature_reason");
  }

  let closeoutEvaluation;
  try {
    closeoutEvaluation = evaluateCloseoutRequirements({
      incident_type: normalizedIncidentType,
      evidence_items: evidenceKeys,
      checklist_status: checklistStatus,
    });
  } catch (error) {
    if (error instanceof IncidentTemplatePolicyError) {
      return {
        ready: false,
        code: "TEMPLATE_NOT_FOUND",
        incident_type: normalizedIncidentType,
        template_version: null,
        missing_evidence_keys: [],
        missing_checklist_keys: [],
        invalid_evidence_refs: [],
        signature_satisfied: evidenceValidation.signature_satisfied,
        no_signature_reason: noSignatureReason,
      };
    }
    throw error;
  }

  return {
    ready: closeoutEvaluation.ready,
    code: closeoutEvaluation.code,
    incident_type: closeoutEvaluation.incident_type,
    template_version: closeoutEvaluation.template_version,
    missing_evidence_keys: closeoutEvaluation.missing_evidence_keys,
    missing_checklist_keys: closeoutEvaluation.missing_checklist_keys,
    invalid_evidence_refs: [],
    signature_satisfied: evidenceValidation.signature_satisfied,
    no_signature_reason: noSignatureReason,
  };
}

async function buildDispatcherCockpitView(params) {
  const { pool, actor, searchParams } = params;
  const scopeFilter = resolveActorScopeFilter(actor);
  const stateFilter = parseEnumSearchFilter(searchParams, "state", VALID_TICKET_STATES, {
    uppercase: true,
  });
  const priorityFilter = parseEnumSearchFilter(searchParams, "priority", VALID_PRIORITIES, {
    uppercase: true,
  });
  const slaStatusFilter = parseEnumSearchFilter(searchParams, "sla_status", VALID_SLA_STATUSES);
  const accountIdFilter = parseUuidSearchFilter(searchParams, "account_id");
  const siteIdFilter = parseUuidSearchFilter(searchParams, "site_id");
  const assignedTechFilter = parseUuidSearchFilter(searchParams, "assigned_tech_id");
  const incidentTypeFilter = parseSearchValues(searchParams, "incident_type", { uppercase: true });
  const selectedTicketIdRaw = searchParams.get("ticket_id");
  const selectedTicketId =
    selectedTicketIdRaw == null || selectedTicketIdRaw.trim() === ""
      ? null
      : selectedTicketIdRaw.trim();
  if (selectedTicketId && !isUuid(selectedTicketId)) {
    throw new HttpError(400, "INVALID_QUERY", "Query 'ticket_id' must be a valid UUID");
  }

  const values = [];
  const where = [];

  if (stateFilter.length > 0) {
    values.push(stateFilter);
    where.push(`t.state = ANY($${values.length}::ticket_state[])`);
  } else {
    where.push("t.state <> 'CLOSED'");
  }

  if (priorityFilter.length > 0) {
    values.push(priorityFilter);
    where.push(`t.priority = ANY($${values.length}::priority_level[])`);
  }
  if (incidentTypeFilter.length > 0) {
    values.push(incidentTypeFilter);
    where.push(`upper(coalesce(t.incident_type, '')) = ANY($${values.length}::text[])`);
  }
  if (accountIdFilter.length > 0) {
    values.push(accountIdFilter);
    where.push(`t.account_id = ANY($${values.length}::uuid[])`);
  }
  if (siteIdFilter.length > 0) {
    values.push(siteIdFilter);
    where.push(`t.site_id = ANY($${values.length}::uuid[])`);
  }
  if (assignedTechFilter.length > 0) {
    values.push(assignedTechFilter);
    where.push(`t.assigned_tech_id = ANY($${values.length}::uuid[])`);
  }
  if (!scopeFilter.account_wildcard) {
    values.push(scopeFilter.account_ids);
    where.push(`t.account_id = ANY($${values.length}::uuid[])`);
  }
  if (!scopeFilter.site_wildcard) {
    values.push(scopeFilter.site_ids);
    where.push(`t.site_id = ANY($${values.length}::uuid[])`);
  }

  const result = await pool.query(
    `
      SELECT
        t.*,
        s.name AS site_name,
        s.city AS site_city,
        s.region AS site_region,
        last_transition.last_transition_at,
        last_audit.last_update_at
      FROM tickets t
      INNER JOIN sites s ON s.id = t.site_id
      LEFT JOIN LATERAL (
        SELECT max(created_at) AS last_transition_at
        FROM ticket_state_transitions tr
        WHERE tr.ticket_id = t.id
      ) last_transition ON true
      LEFT JOIN LATERAL (
        SELECT max(created_at) AS last_update_at
        FROM audit_events ae
        WHERE ae.ticket_id = t.id
      ) last_audit ON true
      WHERE ${where.join(" AND ")}
      ORDER BY t.updated_at DESC, t.id ASC
      LIMIT 200
    `,
    values,
  );

  const nowAt = new Date();
  const queueRows = result.rows
    .map((row) => {
      const sla = computeSlaSnapshot(row, nowAt);
      const actions = DISPATCHER_QUEUE_ACTION_BLUEPRINTS.map((blueprint) =>
        buildActionDescriptor({
          actionId: blueprint.action_id,
          toolName: blueprint.tool_name,
          actorRole: actor.actorRole,
          ticketState: row.state,
          ticketId: row.id,
        }),
      );
      const lastUpdateAt = row.last_update_at ?? row.updated_at;
      const lastTransitionAt = row.last_transition_at ?? row.updated_at;
      return {
        ticket_id: row.id,
        state: row.state,
        priority: row.priority,
        incident_type: row.incident_type,
        site: {
          id: row.site_id,
          name: row.site_name,
          city: row.site_city,
          region: row.site_region,
        },
        assigned_tech: row.assigned_tech_id,
        scheduled_start: row.scheduled_start ? new Date(row.scheduled_start).toISOString() : null,
        last_update_at: lastUpdateAt ? new Date(lastUpdateAt).toISOString() : null,
        last_transition_at: lastTransitionAt ? new Date(lastTransitionAt).toISOString() : null,
        ...sla,
        actions,
      };
    })
    .filter((row) =>
      slaStatusFilter.length > 0 ? slaStatusFilter.includes(row.sla_status) : true,
    );

  queueRows.sort((left, right) => {
    const leftBreach = left.sla_status === "breach" ? 0 : left.sla_status === "warning" ? 1 : 2;
    const rightBreach = right.sla_status === "breach" ? 0 : right.sla_status === "warning" ? 1 : 2;
    if (leftBreach !== rightBreach) {
      return leftBreach - rightBreach;
    }

    if (left.sla_timer_remaining_minutes !== right.sla_timer_remaining_minutes) {
      return left.sla_timer_remaining_minutes - right.sla_timer_remaining_minutes;
    }

    const leftPriority = PRIORITY_SORT_ORDER[left.priority] ?? 9;
    const rightPriority = PRIORITY_SORT_ORDER[right.priority] ?? 9;
    if (leftPriority !== rightPriority) {
      return leftPriority - rightPriority;
    }

    const leftUpdate = Date.parse(left.last_update_at ?? "");
    const rightUpdate = Date.parse(right.last_update_at ?? "");
    if (Number.isFinite(leftUpdate) && Number.isFinite(rightUpdate) && leftUpdate !== rightUpdate) {
      return rightUpdate - leftUpdate;
    }

    return left.ticket_id.localeCompare(right.ticket_id);
  });

  let selectedTicket = null;
  if (selectedTicketId) {
    const ticket = await getTicket(pool, selectedTicketId);
    const withinScope =
      (scopeFilter.account_wildcard ||
        scopeFilter.account_ids.includes(ticket.account_id.toLowerCase())) &&
      (scopeFilter.site_wildcard || scopeFilter.site_ids.includes(ticket.site_id.toLowerCase()));
    if (!withinScope) {
      throw new HttpError(403, "FORBIDDEN_SCOPE", "Actor scope does not include selected ticket", {
        scope_field: "ticket_id",
        target_id: selectedTicketId,
      });
    }
    const timeline = await getTicketTimeline(pool, selectedTicketId);
    const evidence = await getTicketEvidence(pool, selectedTicketId);
    selectedTicket = {
      ticket,
      timeline,
      evidence_summary: {
        total_items: evidence.evidence.length,
      },
    };
  }

  return {
    generated_at: nowIso(),
    actor: {
      actor_id: actor.actorId,
      actor_role: actor.actorRole,
      actor_type: actor.actorType,
      tool_name: actor.toolName,
    },
    filters_applied: {
      state: stateFilter,
      priority: priorityFilter,
      sla_status: slaStatusFilter,
      account_id: accountIdFilter,
      site_id: siteIdFilter,
      assigned_tech_id: assignedTechFilter,
      incident_type: incidentTypeFilter,
      ticket_id: selectedTicketId,
    },
    queue: queueRows,
    selected_ticket: selectedTicket,
  };
}

async function buildTechnicianJobPacketView(params) {
  const { pool, actor, authRuntime, ticketId, objectStoreSchemes } = params;
  validateTicketId(ticketId);

  const ticketResult = await pool.query(
    `
      SELECT
        t.*,
        s.name AS site_name,
        s.address1 AS site_address1,
        s.address2 AS site_address2,
        s.city AS site_city,
        s.region AS site_region,
        s.postal_code AS site_postal_code,
        s.country AS site_country,
        s.access_instructions,
        s.timezone AS site_timezone
      FROM tickets t
      INNER JOIN sites s ON s.id = t.site_id
      WHERE t.id = $1
    `,
    [ticketId],
  );
  if (ticketResult.rowCount === 0) {
    throw new HttpError(404, "TICKET_NOT_FOUND", "Ticket not found");
  }
  const ticketRow = ticketResult.rows[0];
  assertTicketScope(authRuntime, actor, ticketRow);

  const contactResult = await pool.query(
    `
      SELECT name, phone, role
      FROM contacts
      WHERE site_id = $1
      ORDER BY is_authorized_requester DESC, escalation_level ASC NULLS LAST, created_at ASC
      LIMIT 1
    `,
    [ticketRow.site_id],
  );
  const primaryContact = contactResult.rowCount > 0 ? contactResult.rows[0] : null;

  const evidenceRowsResult = await pool.query(
    `
      SELECT
        id,
        ticket_id,
        kind,
        uri,
        checksum,
        metadata,
        created_by,
        created_at
      FROM evidence_items
      WHERE ticket_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [ticketId],
  );
  const evidenceRows = evidenceRowsResult.rows;
  const evidence = evidenceRows.map(serializeEvidenceItem);

  const timeline = await getTicketTimeline(pool, ticketId);
  const latestCompletionPayload = await getLatestCompletionPayload(pool, ticketId);
  const noSignatureReasonRaw = latestCompletionPayload?.no_signature_reason;
  const noSignatureReason =
    typeof noSignatureReasonRaw === "string" && noSignatureReasonRaw.trim() !== ""
      ? noSignatureReasonRaw.trim()
      : null;
  const template = ticketRow.incident_type
    ? getIncidentTemplate(ticketRow.incident_type.trim())
    : null;
  const requiredEvidenceKeys = template?.required_evidence_keys ?? [];
  const requiredChecklistKeys = template?.required_checklist_keys ?? [];
  const checklistStatusRaw = parseCompletionChecklistStatus(latestCompletionPayload);
  const checklistStatus = normalizeChecklistStatus(requiredChecklistKeys, checklistStatusRaw);
  const closeoutGate = evaluatePacketCloseoutGate({
    incidentType: ticketRow.incident_type,
    evidenceRows,
    checklistStatus,
    noSignatureReason,
    objectStoreSchemes,
  });

  const evidenceKeySet = new Set();
  for (const row of evidenceRows) {
    const evidenceKey = readEvidenceKeyFromMetadata(row.metadata);
    if (evidenceKey) {
      evidenceKeySet.add(evidenceKey);
    }
  }
  if (closeoutGate.signature_satisfied) {
    evidenceKeySet.add("signature_or_no_signature_reason");
  }

  const requiredEvidence = requiredEvidenceKeys.map((key) => ({
    key,
    present: evidenceKeySet.has(key),
  }));
  const checklistItems = requiredChecklistKeys.map((key) => ({
    key,
    checked: checklistStatus[key] === true,
  }));

  const completeWorkPolicyError = closeoutGate.ready
    ? null
    : createActionPolicyError(
        "CLOSEOUT_REQUIREMENTS_INCOMPLETE",
        "Closeout requirements are incomplete",
        {
          requirement_code: closeoutGate.code,
          incident_type: closeoutGate.incident_type,
          template_version: closeoutGate.template_version,
          missing_evidence_keys: closeoutGate.missing_evidence_keys,
          missing_checklist_keys: closeoutGate.missing_checklist_keys,
          invalid_evidence_refs: closeoutGate.invalid_evidence_refs,
        },
      );

  const actions = TECH_PACKET_ACTION_BLUEPRINTS.map((blueprint) =>
    buildActionDescriptor({
      actionId: blueprint.action_id,
      toolName: blueprint.tool_name,
      actorRole: actor.actorRole,
      ticketState: ticketRow.state,
      ticketId: ticketRow.id,
      extraPolicyError: blueprint.action_id === "complete_work" ? completeWorkPolicyError : null,
    }),
  );

  return {
    generated_at: nowIso(),
    actor: {
      actor_id: actor.actorId,
      actor_role: actor.actorRole,
      actor_type: actor.actorType,
      tool_name: actor.toolName,
    },
    packet: {
      header: {
        ticket_id: ticketRow.id,
        priority: ticketRow.priority,
        incident_type: ticketRow.incident_type,
        current_state: ticketRow.state,
        scheduled_window: {
          start: ticketRow.scheduled_start
            ? new Date(ticketRow.scheduled_start).toISOString()
            : null,
          end: ticketRow.scheduled_end ? new Date(ticketRow.scheduled_end).toISOString() : null,
        },
        assigned_provider_id: ticketRow.assigned_provider_id,
        assigned_tech_id: ticketRow.assigned_tech_id,
      },
      site_and_access: {
        site_id: ticketRow.site_id,
        site_name: ticketRow.site_name,
        address: {
          address1: ticketRow.site_address1,
          address2: ticketRow.site_address2,
          city: ticketRow.site_city,
          region: ticketRow.site_region,
          postal_code: ticketRow.site_postal_code,
          country: ticketRow.site_country,
        },
        timezone: ticketRow.site_timezone,
        access_instructions: ticketRow.access_instructions,
        onsite_contact: primaryContact
          ? {
              name: primaryContact.name,
              phone: primaryContact.phone,
              role: primaryContact.role,
            }
          : null,
      },
      work_scope: {
        summary: ticketRow.summary,
        customer_description: ticketRow.description,
        nte_cents: Number(ticketRow.nte_cents),
        authorized_scope_constraints: null,
      },
      evidence_requirements: {
        template_version: template?.version ?? null,
        required_evidence: requiredEvidence,
        evidence_items: evidence,
      },
      checklist: {
        required_items: checklistItems,
        source: latestCompletionPayload ? "latest_completion_attempt" : "none_recorded",
      },
      closeout_gate: closeoutGate,
      timeline: {
        events: timeline.events,
        latest_events: timeline.events.slice(-10),
      },
      actions,
    },
  };
}

function ensureString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' is required`);
  }
}

function ensureObjectField(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' must be a JSON object`);
  }
}

function ensureArrayField(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' must be an array`);
  }
}

function normalizeOptionalString(value, fieldName) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(
      400,
      "INVALID_REQUEST",
      `Field '${fieldName}' must be a non-empty string when provided`,
    );
  }
  return value.trim();
}

function normalizeOptionalStringArray(value, fieldName) {
  if (value == null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' must be an array`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        `Field '${fieldName}[${index}]' must be a non-empty string`,
      );
    }
    return entry.trim();
  });
}

function readEvidenceKeyFromMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return null;
  }

  const evidenceKey = metadata.evidence_key;
  if (typeof evidenceKey !== "string" || evidenceKey.trim() === "") {
    return null;
  }
  return evidenceKey.trim();
}

function parseIsoDate(value, fieldName) {
  ensureString(value, fieldName);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' must be ISO date-time`);
  }
  return parsed.toISOString();
}

function assertTicketScope(authRuntime, actor, ticketLike) {
  authRuntime.assertActorScopeForTarget(actor, {
    accountId: ticketLike.account_id,
    siteId: ticketLike.site_id,
  });
}

function parseObjectStoreSchemes(value) {
  const raw = typeof value === "string" && value.trim() !== "" ? value : "s3,minio";
  const entries = raw
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (entries.length === 0) {
    return new Set(["s3", "minio"]);
  }
  return new Set(entries);
}

function isObjectStoreResolvableUri(uri, objectStoreSchemes) {
  if (typeof uri !== "string" || uri.trim() === "") {
    return false;
  }
  try {
    const parsed = new URL(uri.trim());
    const protocol = parsed.protocol.endsWith(":")
      ? parsed.protocol.slice(0, -1).toLowerCase()
      : parsed.protocol.toLowerCase();
    if (!objectStoreSchemes.has(protocol)) {
      return false;
    }
    if (typeof parsed.hostname !== "string" || parsed.hostname.trim() === "") {
      return false;
    }
    if (
      typeof parsed.pathname !== "string" ||
      parsed.pathname.trim() === "" ||
      parsed.pathname === "/"
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function buildEvidenceLookup(rows) {
  const byId = new Map();
  const byUri = new Map();
  const byEvidenceKey = new Map();

  for (const row of rows) {
    const rowId = String(row.id);
    const rowUri = typeof row.uri === "string" ? row.uri.trim() : "";
    byId.set(rowId, row);

    if (rowUri !== "") {
      if (!byUri.has(rowUri)) {
        byUri.set(rowUri, []);
      }
      byUri.get(rowUri).push(row);
    }

    const evidenceKey = readEvidenceKeyFromMetadata(row.metadata);
    if (evidenceKey) {
      if (!byEvidenceKey.has(evidenceKey)) {
        byEvidenceKey.set(evidenceKey, []);
      }
      byEvidenceKey.get(evidenceKey).push(row);
    }
  }

  return {
    byId,
    byUri,
    byEvidenceKey,
  };
}

function resolveEvidenceReferenceCandidate(reference, lookup) {
  if (isUuid(reference)) {
    return lookup.byId.get(reference) ?? null;
  }
  const byUriMatches = lookup.byUri.get(reference);
  if (Array.isArray(byUriMatches) && byUriMatches.length > 0) {
    return byUriMatches[0];
  }
  return null;
}

function uniqueSorted(values) {
  return [...new Set(values)].toSorted((left, right) => left.localeCompare(right));
}

function resolveCloseoutValidationContext(params) {
  const {
    incidentType,
    noSignatureReason,
    explicitEvidenceRefs,
    evidenceRows,
    objectStoreSchemes,
  } = params;

  const lookup = buildEvidenceLookup(evidenceRows);
  const invalidEvidenceRefs = [];

  const signatureEvidenceRows = evidenceRows.filter((row) => {
    const kind = typeof row.kind === "string" ? row.kind.trim().toUpperCase() : "";
    const evidenceKey = readEvidenceKeyFromMetadata(row.metadata);
    return kind === "SIGNATURE" || evidenceKey === "signature_or_no_signature_reason";
  });

  if (signatureEvidenceRows.length === 0 && noSignatureReason === null) {
    throw new HttpError(
      409,
      "CLOSEOUT_REQUIREMENTS_INCOMPLETE",
      "Closeout requirements are incomplete",
      {
        requirement_code: "MISSING_SIGNATURE_CONFIRMATION",
        incident_type: String(incidentType).trim().toUpperCase(),
        template_version: null,
        missing_evidence_keys: ["signature_or_no_signature_reason"],
        missing_checklist_keys: [],
        invalid_evidence_refs: [],
      },
    );
  }

  const template = getIncidentTemplate(incidentType);
  const requiredEvidenceKeys = template ? template.required_evidence_keys : [];

  for (const evidenceKey of requiredEvidenceKeys) {
    if (
      evidenceKey === "signature_or_no_signature_reason" &&
      noSignatureReason !== null &&
      signatureEvidenceRows.length === 0
    ) {
      continue;
    }

    const matchingRows = lookup.byEvidenceKey.get(evidenceKey) ?? [];
    for (const row of matchingRows) {
      const candidateUri = typeof row.uri === "string" ? row.uri.trim() : "";
      if (!isObjectStoreResolvableUri(candidateUri, objectStoreSchemes)) {
        invalidEvidenceRefs.push(candidateUri || String(row.id));
      }
    }
  }

  const referencesToValidate =
    Array.isArray(explicitEvidenceRefs) && explicitEvidenceRefs.length > 0
      ? explicitEvidenceRefs
      : evidenceRows.map((row) => String(row.uri).trim()).filter((value) => value !== "");

  for (const reference of referencesToValidate) {
    const resolved = resolveEvidenceReferenceCandidate(reference, lookup);
    if (!resolved) {
      invalidEvidenceRefs.push(reference);
      continue;
    }
    const resolvedUri = typeof resolved.uri === "string" ? resolved.uri.trim() : "";
    if (!isObjectStoreResolvableUri(resolvedUri, objectStoreSchemes)) {
      invalidEvidenceRefs.push(reference);
    }
  }

  const invalidEvidenceRefsSorted = uniqueSorted(
    invalidEvidenceRefs.filter((entry) => typeof entry === "string" && entry.trim() !== ""),
  );

  return {
    signature_satisfied: signatureEvidenceRows.length > 0 || noSignatureReason !== null,
    invalid_evidence_refs: invalidEvidenceRefsSorted,
  };
}

async function runWithIdempotency(params) {
  const { pool, actorId, endpoint, requestId, requestBody, runMutation } = params;
  const requestHash = canonicalJsonHash(requestBody);
  const client = await pool.connect();

  try {
    const existing = await client.query(
      `
        SELECT request_hash, response_code, response_body
        FROM idempotency_keys
        WHERE actor_id = $1
          AND endpoint = $2
          AND request_id = $3
      `,
      [actorId, endpoint, requestId],
    );

    if (existing.rowCount > 0) {
      const row = existing.rows[0];
      if (row.request_hash !== requestHash) {
        throw new HttpError(
          409,
          "IDEMPOTENCY_PAYLOAD_MISMATCH",
          "Idempotency key reuse with different payload",
          { request_id: requestId },
        );
      }
      return {
        status: Number(row.response_code),
        body: row.response_body,
        replay: true,
      };
    }

    await client.query("BEGIN");
    try {
      const response = await runMutation(client);
      await client.query(
        `
          INSERT INTO idempotency_keys (
            actor_id,
            endpoint,
            request_id,
            request_hash,
            response_code,
            response_body
          )
          VALUES ($1,$2,$3,$4,$5,$6)
        `,
        [actorId, endpoint, requestId, requestHash, response.status, response.body],
      );
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      if (
        error &&
        error.code === "23505" &&
        typeof error.constraint === "string" &&
        error.constraint.includes("idempotency_keys")
      ) {
        const replay = await client.query(
          `
            SELECT request_hash, response_code, response_body
            FROM idempotency_keys
            WHERE actor_id = $1
              AND endpoint = $2
              AND request_id = $3
          `,
          [actorId, endpoint, requestId],
        );

        if (replay.rowCount > 0) {
          const row = replay.rows[0];
          if (row.request_hash !== requestHash) {
            throw new HttpError(
              409,
              "IDEMPOTENCY_PAYLOAD_MISMATCH",
              "Idempotency key reuse with different payload",
              { request_id: requestId },
            );
          }
          return {
            status: Number(row.response_code),
            body: row.response_body,
            replay: true,
          };
        }
      }
      throw error;
    }
  } finally {
    client.release();
  }
}

async function createTicketMutation(client, context) {
  const { body, actor, requestId, correlationId, traceId, metrics, authRuntime } = context;
  ensureObject(body);
  requireUuidField(body.account_id, "account_id");
  requireUuidField(body.site_id, "site_id");
  if (body.asset_id != null) {
    requireUuidField(body.asset_id, "asset_id");
  }
  ensureString(body.summary, "summary");
  authRuntime.assertActorScopeForTarget(actor, {
    accountId: body.account_id,
    siteId: body.site_id,
  });

  const insertResult = await client.query(
    `
      INSERT INTO tickets (
        account_id,
        site_id,
        asset_id,
        summary,
        description,
        nte_cents
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
    `,
    [
      body.account_id,
      body.site_id,
      body.asset_id ?? null,
      body.summary.trim(),
      body.description ?? null,
      typeof body.nte_cents === "number" ? body.nte_cents : 0,
    ],
  );
  const ticket = insertResult.rows[0];

  await insertAuditAndTransition(client, {
    ticketId: ticket.id,
    beforeState: null,
    afterState: "NEW",
    metrics,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    toolName: actor.toolName,
    requestId,
    correlationId,
    traceId,
    payload: {
      endpoint: "/tickets",
      requested_at: nowIso(),
      request: body,
    },
  });

  return {
    status: 201,
    body: serializeTicket(ticket),
  };
}

async function blindIntakeMutation(client, context) {
  const {
    body,
    actor,
    requestId,
    correlationId,
    traceId,
    metrics,
    authRuntime,
    blindIntakePolicy,
  } = context;
  ensureObject(body);
  const payload = parseBlindIntakePayload(body, blindIntakePolicy);
  authRuntime.assertActorScopeForTarget(actor, {
    accountId: payload.accountId,
    siteId: payload.siteId,
  });

  payload.identity_signature = buildIntakeIdentitySignature(payload);
  payload.duplicate_window_minutes = blindIntakePolicy.duplicateWindowMinutes;
  payload.request = body;

  const existingOpenTicket = await findOpenIntakeDuplicate(client, payload);
  if (existingOpenTicket) {
    await linkDuplicateIntakeAttempt({
      payload,
      existingTicket: existingOpenTicket,
      actor,
      requestId,
      correlationId,
      traceId,
      blindIntakePolicy,
    });

    throw new HttpError(409, "DUPLICATE_INTAKE", "Duplicate blind intake request detected", {
      duplicate_ticket_id: existingOpenTicket.id,
      duplicate_ticket_state: existingOpenTicket.state,
      duplicate_created_at: new Date(existingOpenTicket.created_at).toISOString(),
      identity_signature: payload.identity_signature,
      duplicate_within_minutes: blindIntakePolicy.duplicateWindowMinutes,
    });
  }

  if (payload.readiness.ready === false) {
    if (payload.readiness.readiness_reasons.includes("SOP_HANDOFF_REQUIRED")) {
      payload.sop_handoff_prompt = payload.sopHandoffPrompt;
    }
  }

  const targetState = payload.readiness.ready ? "READY_TO_SCHEDULE" : "TRIAGED";
  const insertResult = await client.query(
    `
      INSERT INTO tickets (
        account_id,
        site_id,
        state,
        summary,
        description,
        incident_type,
        priority,
        nte_cents,
        customer_name,
        customer_phone,
        customer_email,
        identity_signature,
        identity_confidence,
        classification_confidence,
        sop_handoff_required,
        sop_handoff_acknowledged,
        sop_handoff_prompt
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      RETURNING *
    `,
    [
      payload.accountId,
      payload.siteId,
      targetState,
      payload.summary,
      payload.description,
      payload.incidentType,
      payload.priority,
      payload.nteCents,
      payload.customerName,
      payload.customerPhone,
      payload.customerEmail,
      payload.identity_signature,
      payload.identityConfidence,
      payload.classificationConfidence,
      targetState === "TRIAGED",
      payload.readiness.ready,
      targetState === "TRIAGED" ? payload.sopHandoffPrompt : null,
    ],
  );
  const ticket = insertResult.rows[0];

  await insertAuditAndTransition(client, {
    ticketId: ticket.id,
    beforeState: null,
    afterState: targetState,
    metrics,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    toolName: actor.toolName,
    requestId,
    correlationId,
    traceId,
    payload: {
      endpoint: "/tickets/intake",
      requested_at: nowIso(),
      request: body,
      state_recommendation: targetState,
      readiness: payload.readiness,
      identity_signature: payload.identity_signature,
      policy: {
        identity_confidence_threshold: blindIntakePolicy.identityConfidenceThreshold,
        classification_confidence_threshold: blindIntakePolicy.classificationConfidenceThreshold,
      },
      sop_handoff_required: targetState === "TRIAGED",
      sop_handoff_acknowledged: payload.sopHandoffAcknowledged,
    },
  });

  return {
    status: 201,
    body: serializeTicket(ticket),
  };
}

function resolveTriageTargetState(body) {
  const explicitOutcome =
    typeof body.workflow_outcome === "string" ? body.workflow_outcome.trim().toUpperCase() : null;
  if (explicitOutcome) {
    if (!["TRIAGED", "READY_TO_SCHEDULE", "APPROVAL_REQUIRED"].includes(explicitOutcome)) {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "Field 'workflow_outcome' must be TRIAGED, READY_TO_SCHEDULE, or APPROVAL_REQUIRED",
      );
    }
    return explicitOutcome;
  }

  if (body.requires_approval === true) {
    return "APPROVAL_REQUIRED";
  }
  if (body.ready_to_schedule === true) {
    return "READY_TO_SCHEDULE";
  }
  return "TRIAGED";
}

async function triageTicketMutation(client, context) {
  const {
    ticketId,
    body,
    actor,
    requestId,
    correlationId,
    traceId,
    metrics,
    authRuntime,
    blindIntakePolicy,
  } = context;
  ensureObject(body);
  ensureString(body.priority, "priority");
  ensureString(body.incident_type, "incident_type");

  const priority = body.priority.trim().toUpperCase();
  if (!["EMERGENCY", "URGENT", "ROUTINE"].includes(priority)) {
    throw new HttpError(400, "INVALID_REQUEST", "Field 'priority' is invalid");
  }
  if (body.nte_cents != null && (typeof body.nte_cents !== "number" || body.nte_cents < 0)) {
    throw new HttpError(400, "INVALID_REQUEST", "Field 'nte_cents' must be a non-negative number");
  }
  const targetState = resolveTriageTargetState(body);
  const resolvedBlindIntakePolicy = resolveBlindIntakePolicy(blindIntakePolicy ?? {});

  const existing = await getTicketForUpdate(client, ticketId);
  const isBlindIntakeTicket =
    typeof existing.identity_signature === "string" && existing.identity_signature.trim() !== "";
  assertTicketScope(authRuntime, actor, existing);
  assertCommandStateAllowed("/tickets/{ticketId}/triage", existing.state, body);

  if (isBlindIntakeTicket && targetState === "READY_TO_SCHEDULE") {
    assertReadyToScheduleGuard(existing, body, resolvedBlindIntakePolicy);
  }

  const update = await client.query(
    `
      UPDATE tickets
      SET
        state = $2,
        priority = $3,
        incident_type = $4,
        nte_cents = COALESCE($5, nte_cents),
        sop_handoff_acknowledged = CASE WHEN $2 = 'READY_TO_SCHEDULE' THEN true ELSE sop_handoff_acknowledged END,
        sop_handoff_required = CASE WHEN $2 = 'READY_TO_SCHEDULE' THEN false ELSE sop_handoff_required END,
        version = version + 1
      WHERE id = $1
      RETURNING *
    `,
    [ticketId, targetState, priority, body.incident_type.trim(), body.nte_cents ?? null],
  );

  const ticket = update.rows[0];

  if (targetState === "APPROVAL_REQUIRED") {
    const approvalReason =
      typeof body.approval_reason === "string" && body.approval_reason.trim() !== ""
        ? body.approval_reason.trim()
        : "TRIAGE_REQUIRES_APPROVAL";
    const amountDelta =
      typeof body.approval_amount_delta_cents === "number" && body.approval_amount_delta_cents >= 0
        ? Math.floor(body.approval_amount_delta_cents)
        : null;
    await client.query(
      `
        INSERT INTO approvals (
          ticket_id,
          status,
          requested_by,
          approval_type,
          amount_delta_cents,
          reason,
          evidence
        )
        VALUES ($1,'PENDING',$2,$3,$4,$5,$6)
      `,
      [
        ticketId,
        actor.actorId,
        "NTE_INCREASE",
        amountDelta,
        approvalReason,
        {
          source: "ticket.triage",
          return_state: "READY_TO_SCHEDULE",
        },
      ],
    );
  }

  if (targetState === "TRIAGED") {
    await insertAuditAndTransition(client, {
      ticketId,
      beforeState: existing.state,
      afterState: targetState,
      metrics,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorRole: actor.actorRole,
      toolName: actor.toolName,
      requestId,
      correlationId,
      traceId,
      payload: {
        endpoint: "/tickets/{ticketId}/triage",
        requested_at: nowIso(),
        request: body,
        workflow_outcome: targetState,
      },
    });
  } else {
    const auditEventId = await insertAuditEvent(client, {
      ticketId,
      beforeState: existing.state,
      afterState: targetState,
      actorType: actor.actorType,
      actorId: actor.actorId,
      actorRole: actor.actorRole,
      toolName: actor.toolName,
      requestId,
      correlationId,
      traceId,
      payload: {
        endpoint: "/tickets/{ticketId}/triage",
        requested_at: nowIso(),
        request: body,
        workflow_outcome: targetState,
        derived_transitions: [`${existing.state}->TRIAGED`, `TRIAGED->${targetState}`],
      },
    });

    await insertTransitionRow(client, {
      ticketId,
      fromState: existing.state,
      toState: "TRIAGED",
      auditEventId,
      metrics,
    });
    await insertTransitionRow(client, {
      ticketId,
      fromState: "TRIAGED",
      toState: targetState,
      auditEventId,
      metrics,
    });
  }

  return {
    status: 200,
    body: serializeTicket(ticket),
  };
}

async function proposeScheduleMutation(client, context) {
  const { ticketId, body, actor, requestId, correlationId, traceId, metrics, authRuntime } =
    context;
  ensureObject(body);
  ensureArrayField(body.options, "options");
  if (body.options.length === 0) {
    throw new HttpError(400, "INVALID_REQUEST", "Field 'options' must include at least one window");
  }

  const options = body.options.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new HttpError(400, "INVALID_REQUEST", `Field 'options[${index}]' must be an object`);
    }
    const start = parseIsoDate(entry.start, `options[${index}].start`);
    const end = parseIsoDate(entry.end, `options[${index}].end`);
    if (new Date(end).getTime() <= new Date(start).getTime()) {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        `Field 'options[${index}]' end must be after start`,
      );
    }
    return { start, end };
  });

  const existing = await getTicketForUpdate(client, ticketId);
  assertTicketScope(authRuntime, actor, existing);
  assertCommandStateAllowed("/tickets/{ticketId}/schedule/propose", existing.state, body);

  const firstWindow = options[0];
  const update = await client.query(
    `
      UPDATE tickets
      SET
        state = 'SCHEDULE_PROPOSED',
        scheduled_start = $2,
        scheduled_end = $3,
        version = version + 1
      WHERE id = $1
      RETURNING *
    `,
    [ticketId, firstWindow.start, firstWindow.end],
  );
  const ticket = update.rows[0];

  await insertAuditAndTransition(client, {
    ticketId,
    beforeState: existing.state,
    afterState: "SCHEDULE_PROPOSED",
    metrics,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    toolName: actor.toolName,
    requestId,
    correlationId,
    traceId,
    payload: {
      endpoint: "/tickets/{ticketId}/schedule/propose",
      requested_at: nowIso(),
      request: body,
      options,
      selected_window_hint: firstWindow,
    },
  });

  return {
    status: 200,
    body: serializeTicket(ticket),
  };
}

async function confirmScheduleMutation(client, context) {
  const { ticketId, body, actor, requestId, correlationId, traceId, metrics, authRuntime } =
    context;
  ensureObject(body);
  const start = parseIsoDate(body.start, "start");
  const end = parseIsoDate(body.end, "end");

  if (new Date(end).getTime() <= new Date(start).getTime()) {
    throw new HttpError(400, "INVALID_REQUEST", "Field 'end' must be after 'start'");
  }

  const existing = await getTicketForUpdate(client, ticketId);
  assertTicketScope(authRuntime, actor, existing);
  assertCommandStateAllowed("/tickets/{ticketId}/schedule/confirm", existing.state, body);

  const update = await client.query(
    `
      UPDATE tickets
      SET
        state = 'SCHEDULED',
        scheduled_start = $2,
        scheduled_end = $3,
        version = version + 1
      WHERE id = $1
      RETURNING *
    `,
    [ticketId, start, end],
  );
  const ticket = update.rows[0];

  await insertAuditAndTransition(client, {
    ticketId,
    beforeState: existing.state,
    afterState: "SCHEDULED",
    metrics,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    toolName: actor.toolName,
    requestId,
    correlationId,
    traceId,
    payload: {
      endpoint: "/tickets/{ticketId}/schedule/confirm",
      requested_at: nowIso(),
      request: body,
    },
  });

  return {
    status: 200,
    body: serializeTicket(ticket),
  };
}

async function dispatchAssignmentMutation(client, context) {
  const { ticketId, body, actor, requestId, correlationId, traceId, metrics, authRuntime } =
    context;
  ensureObject(body);
  requireUuidField(body.tech_id, "tech_id");
  if (body.provider_id != null) {
    requireUuidField(body.provider_id, "provider_id");
  }

  const existing = await getTicketForUpdate(client, ticketId);
  assertTicketScope(authRuntime, actor, existing);
  const dispatchMode = typeof body.dispatch_mode === "string" ? body.dispatch_mode.trim() : null;
  assertCommandStateAllowed("/tickets/{ticketId}/assignment/dispatch", existing.state, body);

  const update = await client.query(
    `
      UPDATE tickets
      SET
        state = 'DISPATCHED',
        assigned_tech_id = $2,
        assigned_provider_id = $3,
        version = version + 1
      WHERE id = $1
      RETURNING *
    `,
    [ticketId, body.tech_id, body.provider_id ?? null],
  );
  const ticket = update.rows[0];

  await insertAuditAndTransition(client, {
    ticketId,
    beforeState: existing.state,
    afterState: "DISPATCHED",
    metrics,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    toolName: actor.toolName,
    requestId,
    correlationId,
    traceId,
    payload: {
      endpoint: "/tickets/{ticketId}/assignment/dispatch",
      requested_at: nowIso(),
      request: body,
      dispatch_mode: dispatchMode,
    },
  });

  return {
    status: 200,
    body: serializeTicket(ticket),
  };
}

async function techCheckInMutation(client, context) {
  const { ticketId, body, actor, requestId, correlationId, traceId, metrics, authRuntime } =
    context;
  ensureObject(body);
  const timestamp = parseIsoDate(body.timestamp, "timestamp");
  if (body.location != null) {
    ensureObjectField(body.location, "location");
  }

  const existing = await getTicketForUpdate(client, ticketId);
  assertTicketScope(authRuntime, actor, existing);
  assertCommandStateAllowed("/tickets/{ticketId}/tech/check-in", existing.state, body);

  const update = await client.query(
    `
      UPDATE tickets
      SET
        state = 'IN_PROGRESS',
        version = version + 1
      WHERE id = $1
      RETURNING *
    `,
    [ticketId],
  );
  const ticket = update.rows[0];

  const auditEventId = await insertAuditEvent(client, {
    ticketId,
    beforeState: existing.state,
    afterState: "IN_PROGRESS",
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    toolName: actor.toolName,
    requestId,
    correlationId,
    traceId,
    payload: {
      endpoint: "/tickets/{ticketId}/tech/check-in",
      requested_at: nowIso(),
      request: body,
      check_in_timestamp: timestamp,
      derived_transitions: ["DISPATCHED->ON_SITE", "ON_SITE->IN_PROGRESS"],
    },
  });

  await insertTransitionRow(client, {
    ticketId,
    fromState: "DISPATCHED",
    toState: "ON_SITE",
    auditEventId,
    metrics,
  });
  await insertTransitionRow(client, {
    ticketId,
    fromState: "ON_SITE",
    toState: "IN_PROGRESS",
    auditEventId,
    metrics,
  });

  return {
    status: 200,
    body: serializeTicket(ticket),
  };
}

async function techRequestChangeMutation(client, context) {
  const { ticketId, body, actor, requestId, correlationId, traceId, metrics, authRuntime } =
    context;
  ensureObject(body);
  ensureString(body.approval_type, "approval_type");
  ensureString(body.reason, "reason");

  const approvalType = body.approval_type.trim().toUpperCase();
  if (!["NTE_INCREASE", "PROPOSAL"].includes(approvalType)) {
    throw new HttpError(400, "INVALID_REQUEST", "Field 'approval_type' is invalid");
  }

  let amountDeltaCents = null;
  if (body.amount_delta_cents != null) {
    if (
      typeof body.amount_delta_cents !== "number" ||
      !Number.isFinite(body.amount_delta_cents) ||
      body.amount_delta_cents < 0
    ) {
      throw new HttpError(
        400,
        "INVALID_REQUEST",
        "Field 'amount_delta_cents' must be a non-negative number",
      );
    }
    amountDeltaCents = Math.floor(body.amount_delta_cents);
  }

  const evidenceRefs = normalizeOptionalStringArray(body.evidence_refs, "evidence_refs");

  const existing = await getTicketForUpdate(client, ticketId);
  assertTicketScope(authRuntime, actor, existing);
  assertCommandStateAllowed("/tickets/{ticketId}/tech/request-change", existing.state, body);

  const approvalInsert = await client.query(
    `
      INSERT INTO approvals (
        ticket_id,
        status,
        requested_by,
        approval_type,
        amount_delta_cents,
        reason,
        evidence
      )
      VALUES ($1,'PENDING',$2,$3,$4,$5,$6)
      RETURNING id, status::text, approval_type, amount_delta_cents, reason, requested_at
    `,
    [
      ticketId,
      actor.actorId,
      approvalType,
      amountDeltaCents,
      body.reason.trim(),
      {
        source: "tech.request_change",
        return_state: "IN_PROGRESS",
        evidence_refs: evidenceRefs,
      },
    ],
  );
  const approval = approvalInsert.rows[0];

  const update = await client.query(
    `
      UPDATE tickets
      SET
        state = 'APPROVAL_REQUIRED',
        version = version + 1
      WHERE id = $1
      RETURNING *
    `,
    [ticketId],
  );
  const ticket = update.rows[0];

  await insertAuditAndTransition(client, {
    ticketId,
    beforeState: existing.state,
    afterState: "APPROVAL_REQUIRED",
    metrics,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    toolName: actor.toolName,
    requestId,
    correlationId,
    traceId,
    payload: {
      endpoint: "/tickets/{ticketId}/tech/request-change",
      requested_at: nowIso(),
      request: body,
      approval_id: approval.id,
      approval_status: approval.status,
    },
  });

  return {
    status: 200,
    body: {
      ticket: serializeTicket(ticket),
      approval: {
        id: approval.id,
        status: approval.status,
        approval_type: approval.approval_type,
        amount_delta_cents:
          approval.amount_delta_cents == null ? null : Number(approval.amount_delta_cents),
        reason: approval.reason,
        requested_at: approval.requested_at ? new Date(approval.requested_at).toISOString() : null,
      },
    },
  };
}

async function approvalDecideMutation(client, context) {
  const { ticketId, body, actor, requestId, correlationId, traceId, metrics, authRuntime } =
    context;
  ensureObject(body);
  requireUuidField(body.approval_id, "approval_id");
  ensureString(body.decision, "decision");

  const decision = body.decision.trim().toUpperCase();
  if (!["APPROVED", "DENIED"].includes(decision)) {
    throw new HttpError(400, "INVALID_REQUEST", "Field 'decision' is invalid");
  }
  const notes = normalizeOptionalString(body.notes, "notes");

  const existing = await getTicketForUpdate(client, ticketId);
  assertTicketScope(authRuntime, actor, existing);
  assertCommandStateAllowed("/tickets/{ticketId}/approval/decide", existing.state, body);

  const approvalResult = await client.query(
    `
      SELECT id, status::text, evidence
      FROM approvals
      WHERE id = $1
        AND ticket_id = $2
      FOR UPDATE
    `,
    [body.approval_id, ticketId],
  );
  if (approvalResult.rowCount === 0) {
    throw new HttpError(404, "APPROVAL_NOT_FOUND", "Approval not found for ticket");
  }

  const approval = approvalResult.rows[0];
  if (approval.status !== "PENDING") {
    throw new HttpError(409, "APPROVAL_NOT_PENDING", "Approval has already been decided");
  }

  let targetState = "TRIAGED";
  if (decision === "APPROVED") {
    const returnStateRaw =
      approval.evidence && typeof approval.evidence === "object"
        ? approval.evidence.return_state
        : null;
    const returnState =
      typeof returnStateRaw === "string" && returnStateRaw.trim() !== ""
        ? returnStateRaw.trim().toUpperCase()
        : "READY_TO_SCHEDULE";
    if (!["READY_TO_SCHEDULE", "IN_PROGRESS"].includes(returnState)) {
      throw new HttpError(
        409,
        "INVALID_APPROVAL_TARGET_STATE",
        "Approval return state is invalid",
        { return_state: returnState },
      );
    }
    targetState = returnState;
  }

  await client.query(
    `
      UPDATE approvals
      SET
        status = $2::approval_status,
        decided_by = $3,
        decided_at = now(),
        reason = COALESCE($4, reason)
      WHERE id = $1
    `,
    [body.approval_id, decision, actor.actorId, notes],
  );

  const update = await client.query(
    `
      UPDATE tickets
      SET
        state = $2,
        version = version + 1
      WHERE id = $1
      RETURNING *
    `,
    [ticketId, targetState],
  );
  const ticket = update.rows[0];

  await insertAuditAndTransition(client, {
    ticketId,
    beforeState: existing.state,
    afterState: targetState,
    metrics,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    toolName: actor.toolName,
    requestId,
    correlationId,
    traceId,
    payload: {
      endpoint: "/tickets/{ticketId}/approval/decide",
      requested_at: nowIso(),
      request: body,
      approval_id: body.approval_id,
      decision,
      target_state: targetState,
      notes,
    },
  });

  return {
    status: 200,
    body: serializeTicket(ticket),
  };
}

async function qaVerifyMutation(client, context) {
  const {
    ticketId,
    body,
    actor,
    requestId,
    correlationId,
    traceId,
    metrics,
    authRuntime,
    objectStoreSchemes,
  } = context;
  ensureObject(body);
  const verifiedAt = parseIsoDate(body.timestamp, "timestamp");
  ensureString(body.result, "result");
  const notes = normalizeOptionalString(body.notes, "notes");
  const result = body.result.trim().toUpperCase();
  if (!["PASS", "FAIL"].includes(result)) {
    throw new HttpError(400, "INVALID_REQUEST", "Field 'result' is invalid");
  }

  const existing = await getTicketForUpdate(client, ticketId);
  assertTicketScope(authRuntime, actor, existing);
  assertCommandStateAllowed("/tickets/{ticketId}/qa/verify", existing.state, body);

  if (result === "FAIL") {
    throw new HttpError(409, "QA_VERIFICATION_FAILED", "QA verification failed", {
      ticket_id: ticketId,
      notes,
    });
  }

  if (typeof existing.incident_type !== "string" || existing.incident_type.trim() === "") {
    throw new HttpError(
      409,
      "CLOSEOUT_REQUIREMENTS_INCOMPLETE",
      "Closeout requirements are incomplete",
      {
        requirement_code: "TEMPLATE_NOT_FOUND",
        incident_type: null,
        template_version: null,
        missing_evidence_keys: [],
        missing_checklist_keys: [],
        invalid_evidence_refs: [],
      },
    );
  }

  const latestCompletion = await client.query(
    `
      SELECT payload
      FROM audit_events
      WHERE ticket_id = $1
        AND tool_name = 'tech.complete'
        AND after_state = 'COMPLETED_PENDING_VERIFICATION'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `,
    [ticketId],
  );

  if (latestCompletion.rowCount === 0) {
    throw new HttpError(
      409,
      "CLOSEOUT_REQUIREMENTS_INCOMPLETE",
      "Closeout requirements are incomplete",
      {
        requirement_code: "MISSING_COMPLETION_CONTEXT",
        incident_type: existing.incident_type ? existing.incident_type.trim().toUpperCase() : null,
        template_version: null,
        missing_evidence_keys: [],
        missing_checklist_keys: [],
        invalid_evidence_refs: [],
      },
    );
  }

  const completionPayload = latestCompletion.rows[0].payload;
  const completionRequest =
    completionPayload &&
    typeof completionPayload === "object" &&
    !Array.isArray(completionPayload) &&
    completionPayload.request &&
    typeof completionPayload.request === "object" &&
    !Array.isArray(completionPayload.request)
      ? completionPayload.request
      : {};

  const completionChecklist =
    completionRequest.checklist_status &&
    typeof completionRequest.checklist_status === "object" &&
    !Array.isArray(completionRequest.checklist_status)
      ? completionRequest.checklist_status
      : {};

  const completionNoSignatureReason =
    typeof completionRequest.no_signature_reason === "string" &&
    completionRequest.no_signature_reason.trim() !== ""
      ? completionRequest.no_signature_reason.trim()
      : null;

  const completionEvidenceRefs = normalizeOptionalStringArray(
    completionRequest.evidence_refs,
    "completion_context.evidence_refs",
  );

  const evidenceResult = await client.query(
    `
      SELECT id, kind, uri, metadata
      FROM evidence_items
      WHERE ticket_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [ticketId],
  );

  const verificationEvidenceValidation = resolveCloseoutValidationContext({
    incidentType: existing.incident_type.trim(),
    noSignatureReason: completionNoSignatureReason,
    explicitEvidenceRefs: completionEvidenceRefs,
    evidenceRows: evidenceResult.rows,
    objectStoreSchemes,
  });

  if (verificationEvidenceValidation.invalid_evidence_refs.length > 0) {
    throw new HttpError(
      409,
      "CLOSEOUT_REQUIREMENTS_INCOMPLETE",
      "Closeout requirements are incomplete",
      {
        requirement_code: "INVALID_EVIDENCE_REFERENCE",
        incident_type: existing.incident_type.trim().toUpperCase(),
        template_version: null,
        missing_evidence_keys: [],
        missing_checklist_keys: [],
        invalid_evidence_refs: verificationEvidenceValidation.invalid_evidence_refs,
      },
    );
  }

  const evidenceKeys = [];
  for (const row of evidenceResult.rows) {
    const evidenceKey = readEvidenceKeyFromMetadata(row.metadata);
    if (evidenceKey) {
      evidenceKeys.push(evidenceKey);
    }
  }
  if (
    verificationEvidenceValidation.signature_satisfied &&
    !evidenceKeys.includes("signature_or_no_signature_reason")
  ) {
    evidenceKeys.push("signature_or_no_signature_reason");
  }

  const verifyCloseout = evaluateCloseoutRequirements({
    incident_type: existing.incident_type.trim(),
    evidence_items: evidenceKeys,
    checklist_status: completionChecklist,
  });
  if (!verifyCloseout.ready) {
    throw new HttpError(
      409,
      "CLOSEOUT_REQUIREMENTS_INCOMPLETE",
      "Closeout requirements are incomplete",
      {
        requirement_code: verifyCloseout.code,
        incident_type: verifyCloseout.incident_type,
        template_version: verifyCloseout.template_version,
        missing_evidence_keys: verifyCloseout.missing_evidence_keys,
        missing_checklist_keys: verifyCloseout.missing_checklist_keys,
        invalid_evidence_refs: [],
      },
    );
  }

  const update = await client.query(
    `
      UPDATE tickets
      SET
        state = 'VERIFIED',
        version = version + 1
      WHERE id = $1
      RETURNING *
    `,
    [ticketId],
  );
  const ticket = update.rows[0];

  await insertAuditAndTransition(client, {
    ticketId,
    beforeState: existing.state,
    afterState: "VERIFIED",
    metrics,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    toolName: actor.toolName,
    requestId,
    correlationId,
    traceId,
    payload: {
      endpoint: "/tickets/{ticketId}/qa/verify",
      requested_at: nowIso(),
      request: body,
      verification_result: result,
      verified_at: verifiedAt,
      notes,
      verification_closeout_check: verifyCloseout,
      verification_evidence_refs: completionEvidenceRefs,
    },
  });

  return {
    status: 200,
    body: serializeTicket(ticket),
  };
}

async function billingGenerateInvoiceMutation(client, context) {
  const { ticketId, body, actor, requestId, correlationId, traceId, metrics, authRuntime } =
    context;
  ensureObject(body);

  const existing = await getTicketForUpdate(client, ticketId);
  assertTicketScope(authRuntime, actor, existing);
  assertCommandStateAllowed("/tickets/{ticketId}/billing/generate-invoice", existing.state, body);

  const update = await client.query(
    `
      UPDATE tickets
      SET
        state = 'INVOICED',
        version = version + 1
      WHERE id = $1
      RETURNING *
    `,
    [ticketId],
  );
  const ticket = update.rows[0];

  await insertAuditAndTransition(client, {
    ticketId,
    beforeState: existing.state,
    afterState: "INVOICED",
    metrics,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    toolName: actor.toolName,
    requestId,
    correlationId,
    traceId,
    payload: {
      endpoint: "/tickets/{ticketId}/billing/generate-invoice",
      requested_at: nowIso(),
      request: body,
      invoice_generated: true,
    },
  });

  return {
    status: 200,
    body: serializeTicket(ticket),
  };
}

async function addEvidenceMutation(client, context) {
  const { ticketId, body, actor, requestId, correlationId, traceId, authRuntime } = context;
  ensureObject(body);
  ensureString(body.kind, "kind");
  ensureString(body.uri, "uri");

  const checksum = normalizeOptionalString(body.checksum, "checksum");
  const evidenceKey = normalizeOptionalString(body.evidence_key, "evidence_key");

  if (body.metadata != null) {
    ensureObjectField(body.metadata, "metadata");
  }
  const metadata = body.metadata ? { ...body.metadata } : {};

  if (evidenceKey) {
    metadata.evidence_key = evidenceKey;
  }

  const existing = await getTicketForUpdate(client, ticketId);
  assertTicketScope(authRuntime, actor, existing);
  assertCommandStateAllowed("/tickets/{ticketId}/evidence", existing.state, body);

  const insert = await client.query(
    `
      INSERT INTO evidence_items (
        ticket_id,
        kind,
        uri,
        checksum,
        metadata,
        created_by
      )
      VALUES ($1,$2,$3,$4,$5,$6)
      RETURNING *
    `,
    [ticketId, body.kind.trim(), body.uri.trim(), checksum, metadata, actor.actorId],
  );
  const evidenceItem = insert.rows[0];

  await insertAuditEvent(client, {
    ticketId,
    beforeState: existing.state,
    afterState: existing.state,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    toolName: actor.toolName,
    requestId,
    correlationId,
    traceId,
    payload: {
      endpoint: "/tickets/{ticketId}/evidence",
      requested_at: nowIso(),
      request: body,
      evidence_item_id: evidenceItem.id,
    },
  });

  return {
    status: 201,
    body: serializeEvidenceItem(evidenceItem),
  };
}

async function techCompleteMutation(client, context) {
  const {
    ticketId,
    body,
    actor,
    requestId,
    correlationId,
    traceId,
    metrics,
    authRuntime,
    objectStoreSchemes,
  } = context;
  ensureObject(body);
  ensureObjectField(body.checklist_status, "checklist_status");
  const noSignatureReason = normalizeOptionalString(
    body.no_signature_reason,
    "no_signature_reason",
  );
  const explicitEvidenceRefs = normalizeOptionalStringArray(body.evidence_refs, "evidence_refs");

  const existing = await getTicketForUpdate(client, ticketId);
  assertTicketScope(authRuntime, actor, existing);
  assertCommandStateAllowed("/tickets/{ticketId}/tech/complete", existing.state, body);

  if (typeof existing.incident_type !== "string" || existing.incident_type.trim() === "") {
    throw new HttpError(
      409,
      "CLOSEOUT_REQUIREMENTS_INCOMPLETE",
      "Closeout requirements are incomplete",
      {
        requirement_code: "TEMPLATE_NOT_FOUND",
        incident_type: null,
        template_version: null,
        missing_evidence_keys: [],
        missing_checklist_keys: [],
      },
    );
  }

  const evidenceResult = await client.query(
    `
      SELECT id, kind, uri, metadata
      FROM evidence_items
      WHERE ticket_id = $1
      ORDER BY created_at ASC, id ASC
    `,
    [ticketId],
  );

  const evidenceValidation = resolveCloseoutValidationContext({
    incidentType: existing.incident_type.trim(),
    noSignatureReason,
    explicitEvidenceRefs,
    evidenceRows: evidenceResult.rows,
    objectStoreSchemes,
  });

  if (evidenceValidation.invalid_evidence_refs.length > 0) {
    throw new HttpError(
      409,
      "CLOSEOUT_REQUIREMENTS_INCOMPLETE",
      "Closeout requirements are incomplete",
      {
        requirement_code: "INVALID_EVIDENCE_REFERENCE",
        incident_type: existing.incident_type.trim().toUpperCase(),
        template_version: null,
        missing_evidence_keys: [],
        missing_checklist_keys: [],
        invalid_evidence_refs: evidenceValidation.invalid_evidence_refs,
      },
    );
  }

  const evidenceKeys = [];
  for (const row of evidenceResult.rows) {
    const evidenceKey = readEvidenceKeyFromMetadata(row.metadata);
    if (evidenceKey) {
      evidenceKeys.push(evidenceKey);
    }
  }
  if (
    evidenceValidation.signature_satisfied &&
    !evidenceKeys.includes("signature_or_no_signature_reason")
  ) {
    evidenceKeys.push("signature_or_no_signature_reason");
  }

  let closeoutEvaluation;
  try {
    closeoutEvaluation = evaluateCloseoutRequirements({
      incident_type: existing.incident_type.trim(),
      evidence_items: evidenceKeys,
      checklist_status: body.checklist_status,
    });
  } catch (error) {
    if (error instanceof IncidentTemplatePolicyError) {
      throw new HttpError(
        409,
        "CLOSEOUT_REQUIREMENTS_INCOMPLETE",
        "Closeout requirements are incomplete",
        {
          requirement_code: "TEMPLATE_NOT_FOUND",
          incident_type: existing.incident_type.trim().toUpperCase(),
          template_version: null,
          missing_evidence_keys: [],
          missing_checklist_keys: [],
        },
      );
    }
    throw error;
  }

  if (!closeoutEvaluation.ready) {
    throw new HttpError(
      409,
      "CLOSEOUT_REQUIREMENTS_INCOMPLETE",
      "Closeout requirements are incomplete",
      {
        requirement_code: closeoutEvaluation.code,
        incident_type: closeoutEvaluation.incident_type,
        template_version: closeoutEvaluation.template_version,
        missing_evidence_keys: closeoutEvaluation.missing_evidence_keys,
        missing_checklist_keys: closeoutEvaluation.missing_checklist_keys,
      },
    );
  }

  const update = await client.query(
    `
      UPDATE tickets
      SET
        state = 'COMPLETED_PENDING_VERIFICATION',
        version = version + 1
      WHERE id = $1
      RETURNING *
    `,
    [ticketId],
  );
  const ticket = update.rows[0];

  await insertAuditAndTransition(client, {
    ticketId,
    beforeState: existing.state,
    afterState: "COMPLETED_PENDING_VERIFICATION",
    metrics,
    actorType: actor.actorType,
    actorId: actor.actorId,
    actorRole: actor.actorRole,
    toolName: actor.toolName,
    requestId,
    correlationId,
    traceId,
    payload: {
      endpoint: "/tickets/{ticketId}/tech/complete",
      requested_at: nowIso(),
      request: body,
      closeout_check: closeoutEvaluation,
      no_signature_reason: noSignatureReason,
      evidence_refs: explicitEvidenceRefs,
      persisted_evidence_count: evidenceResult.rowCount,
    },
  });

  return {
    status: 200,
    body: serializeTicket(ticket),
  };
}

function resolveRoute(method, pathname) {
  if (method === "GET" && pathname === "/health") {
    return {
      kind: "health",
      endpoint: "/health",
    };
  }

  if (method === "GET" && pathname === "/metrics") {
    return {
      kind: "metrics",
      endpoint: "/metrics",
    };
  }

  if (method === "GET" && pathname === "/ops/alerts") {
    return {
      kind: "alerts",
      endpoint: "/ops/alerts",
    };
  }

  if (method === "GET" && pathname === "/ux/dispatcher/cockpit") {
    return {
      kind: "dispatcher_cockpit",
      endpoint: "/ux/dispatcher/cockpit",
      ticketId: null,
    };
  }

  const techPacketMatch = pathname.match(/^\/ux\/technician\/job-packet\/([^/]+)$/);
  if (method === "GET" && techPacketMatch && ticketRouteRegex.test(techPacketMatch[1])) {
    return {
      kind: "tech_job_packet",
      endpoint: "/ux/technician/job-packet/{ticketId}",
      ticketId: techPacketMatch[1],
    };
  }

  const ticketMatch = pathname.match(/^\/tickets\/([^/]+)$/);
  if (method === "GET" && ticketMatch) {
    return {
      kind: "ticket",
      endpoint: "/tickets/{ticketId}",
      ticketId: ticketMatch[1],
    };
  }

  const timelineMatch = pathname.match(/^\/tickets\/([^/]+)\/timeline$/);
  if (method === "GET" && timelineMatch) {
    return {
      kind: "timeline",
      endpoint: "/tickets/{ticketId}/timeline",
      ticketId: timelineMatch[1],
    };
  }

  const evidenceMatch = pathname.match(/^\/tickets\/([^/]+)\/evidence$/);
  if (method === "GET" && evidenceMatch) {
    return {
      kind: "evidence",
      endpoint: "/tickets/{ticketId}/evidence",
      ticketId: evidenceMatch[1],
    };
  }

  if (method === "POST" && pathname === "/tickets") {
    return {
      kind: "command",
      endpoint: "/tickets",
      handler: createTicketMutation,
      ticketId: null,
    };
  }

  if (method === "POST" && pathname === "/tickets/intake") {
    return {
      kind: "command",
      endpoint: "/tickets/intake",
      handler: blindIntakeMutation,
      ticketId: null,
    };
  }

  const triageMatch = pathname.match(/^\/tickets\/([^/]+)\/triage$/);
  if (method === "POST" && triageMatch && ticketRouteRegex.test(triageMatch[1])) {
    return {
      kind: "command",
      endpoint: "/tickets/{ticketId}/triage",
      handler: triageTicketMutation,
      ticketId: triageMatch[1],
    };
  }

  const scheduleProposeMatch = pathname.match(/^\/tickets\/([^/]+)\/schedule\/propose$/);
  if (method === "POST" && scheduleProposeMatch && ticketRouteRegex.test(scheduleProposeMatch[1])) {
    return {
      kind: "command",
      endpoint: "/tickets/{ticketId}/schedule/propose",
      handler: proposeScheduleMutation,
      ticketId: scheduleProposeMatch[1],
    };
  }

  const scheduleConfirmMatch = pathname.match(/^\/tickets\/([^/]+)\/schedule\/confirm$/);
  if (method === "POST" && scheduleConfirmMatch && ticketRouteRegex.test(scheduleConfirmMatch[1])) {
    return {
      kind: "command",
      endpoint: "/tickets/{ticketId}/schedule/confirm",
      handler: confirmScheduleMutation,
      ticketId: scheduleConfirmMatch[1],
    };
  }

  const dispatchMatch = pathname.match(/^\/tickets\/([^/]+)\/assignment\/dispatch$/);
  if (method === "POST" && dispatchMatch && ticketRouteRegex.test(dispatchMatch[1])) {
    return {
      kind: "command",
      endpoint: "/tickets/{ticketId}/assignment/dispatch",
      handler: dispatchAssignmentMutation,
      ticketId: dispatchMatch[1],
    };
  }

  const techCheckInMatch = pathname.match(/^\/tickets\/([^/]+)\/tech\/check-in$/);
  if (method === "POST" && techCheckInMatch && ticketRouteRegex.test(techCheckInMatch[1])) {
    return {
      kind: "command",
      endpoint: "/tickets/{ticketId}/tech/check-in",
      handler: techCheckInMutation,
      ticketId: techCheckInMatch[1],
    };
  }

  const techRequestChangeMatch = pathname.match(/^\/tickets\/([^/]+)\/tech\/request-change$/);
  if (
    method === "POST" &&
    techRequestChangeMatch &&
    ticketRouteRegex.test(techRequestChangeMatch[1])
  ) {
    return {
      kind: "command",
      endpoint: "/tickets/{ticketId}/tech/request-change",
      handler: techRequestChangeMutation,
      ticketId: techRequestChangeMatch[1],
    };
  }

  const approvalDecideMatch = pathname.match(/^\/tickets\/([^/]+)\/approval\/decide$/);
  if (method === "POST" && approvalDecideMatch && ticketRouteRegex.test(approvalDecideMatch[1])) {
    return {
      kind: "command",
      endpoint: "/tickets/{ticketId}/approval/decide",
      handler: approvalDecideMutation,
      ticketId: approvalDecideMatch[1],
    };
  }

  if (method === "POST" && evidenceMatch && ticketRouteRegex.test(evidenceMatch[1])) {
    return {
      kind: "command",
      endpoint: "/tickets/{ticketId}/evidence",
      handler: addEvidenceMutation,
      ticketId: evidenceMatch[1],
    };
  }

  const techCompleteMatch = pathname.match(/^\/tickets\/([^/]+)\/tech\/complete$/);
  if (method === "POST" && techCompleteMatch && ticketRouteRegex.test(techCompleteMatch[1])) {
    return {
      kind: "command",
      endpoint: "/tickets/{ticketId}/tech/complete",
      handler: techCompleteMutation,
      ticketId: techCompleteMatch[1],
    };
  }

  const qaVerifyMatch = pathname.match(/^\/tickets\/([^/]+)\/qa\/verify$/);
  if (method === "POST" && qaVerifyMatch && ticketRouteRegex.test(qaVerifyMatch[1])) {
    return {
      kind: "command",
      endpoint: "/tickets/{ticketId}/qa/verify",
      handler: qaVerifyMutation,
      ticketId: qaVerifyMatch[1],
    };
  }

  const billingGenerateInvoiceMatch = pathname.match(
    /^\/tickets\/([^/]+)\/billing\/generate-invoice$/,
  );
  if (
    method === "POST" &&
    billingGenerateInvoiceMatch &&
    ticketRouteRegex.test(billingGenerateInvoiceMatch[1])
  ) {
    return {
      kind: "command",
      endpoint: "/tickets/{ticketId}/billing/generate-invoice",
      handler: billingGenerateInvoiceMutation,
      ticketId: billingGenerateInvoiceMatch[1],
    };
  }

  return null;
}

export function createDispatchApiServer(options = {}) {
  const pool = options.pool ?? getPool();
  const host = options.host ?? process.env.DISPATCH_API_HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.DISPATCH_API_PORT ?? "8080");
  const logger = options.logger ?? console;
  const logSinkPath = normalizeOptionalFilePath(
    options.logSinkPath ?? process.env.DISPATCH_LOG_SINK_PATH,
  );
  const metricsSinkPath = normalizeOptionalFilePath(
    options.metricsSinkPath ?? process.env.DISPATCH_METRICS_SINK_PATH,
  );
  const alertsSinkPath = normalizeOptionalFilePath(
    options.alertsSinkPath ?? process.env.DISPATCH_ALERTS_SINK_PATH,
  );
  const alertThresholds = resolveAlertThresholds(options.alertThresholds ?? {});
  const blindIntakePolicy = resolveBlindIntakePolicy(options.blindIntakePolicy ?? {});
  const metrics =
    options.metrics ??
    createMetricsRegistry({
      onChange: metricsSinkPath
        ? (snapshot) => {
            writeJsonSnapshot(metricsSinkPath, snapshot);
          }
        : null,
    });
  const authRuntime = createAuthRuntime(options.auth ?? {});
  const objectStoreSchemes = parseObjectStoreSchemes(
    options.objectStoreSchemes ?? process.env.DISPATCH_OBJECT_STORE_SCHEMES,
  );
  const emitLog = (level, payload) => emitStructuredLog(logger, level, payload, { logSinkPath });

  if (metricsSinkPath && options.metrics) {
    writeJsonSnapshot(metricsSinkPath, metrics.snapshot());
  }

  const server = createServer(async (request, response) => {
    const requestStart = Date.now();
    const requestMethod = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = resolveRoute(requestMethod, url.pathname);
    const correlationId = buildCorrelationId(request.headers);
    const traceId = buildTraceId(request.headers);

    if (!route) {
      sendJson(response, 404, {
        error: {
          code: "NOT_FOUND",
          message: "Route not found",
          request_id: null,
        },
      });
      metrics.incrementRequest(requestMethod, "UNMATCHED", 404);
      metrics.incrementError("NOT_FOUND");
      emitLog("error", {
        method: requestMethod,
        path: url.pathname,
        endpoint: "UNMATCHED",
        request_id: null,
        correlation_id: correlationId,
        trace_id: traceId,
        actor_type: null,
        actor_id: null,
        actor_role: null,
        tool_name: null,
        ticket_id: null,
        replay: false,
        status: 404,
        error_code: "NOT_FOUND",
        message: "Route not found",
        duration_ms: Date.now() - requestStart,
      });
      return;
    }

    if (route.kind === "health") {
      sendJson(response, 200, {
        status: "ok",
        service: "dispatch-api",
        now: nowIso(),
      });
      metrics.incrementRequest(requestMethod, route.endpoint, 200);
      emitLog("info", {
        method: requestMethod,
        path: url.pathname,
        endpoint: route.endpoint,
        request_id: null,
        correlation_id: correlationId,
        trace_id: traceId,
        actor_type: null,
        actor_id: null,
        actor_role: null,
        tool_name: null,
        ticket_id: null,
        replay: false,
        status: 200,
        duration_ms: Date.now() - requestStart,
      });
      return;
    }

    if (route.kind === "metrics") {
      metrics.incrementRequest(requestMethod, route.endpoint, 200);
      const snapshot = metrics.snapshot();
      sendJson(response, 200, snapshot);
      emitLog("info", {
        method: requestMethod,
        path: url.pathname,
        endpoint: route.endpoint,
        request_id: null,
        correlation_id: correlationId,
        trace_id: traceId,
        actor_type: null,
        actor_id: null,
        actor_role: null,
        tool_name: null,
        ticket_id: null,
        replay: false,
        status: 200,
        duration_ms: Date.now() - requestStart,
      });
      return;
    }

    if (route.kind === "alerts") {
      metrics.incrementRequest(requestMethod, route.endpoint, 200);
      const snapshot = await buildOperationalAlertsSnapshot({
        pool,
        metrics,
        alertThresholds,
      });
      sendJson(response, 200, snapshot);
      if (alertsSinkPath) {
        appendJsonLine(alertsSinkPath, snapshot);
      }
      emitLog("info", {
        method: requestMethod,
        path: url.pathname,
        endpoint: route.endpoint,
        request_id: null,
        correlation_id: correlationId,
        trace_id: traceId,
        actor_type: null,
        actor_id: null,
        actor_role: null,
        tool_name: null,
        ticket_id: null,
        replay: false,
        status: 200,
        duration_ms: Date.now() - requestStart,
      });
      return;
    }

    let requestId = null;
    let actor = null;
    try {
      if (route.kind === "dispatcher_cockpit") {
        actor = authRuntime.resolveActor(request.headers, route);
        const cockpit = await buildDispatcherCockpitView({
          pool,
          actor,
          searchParams: url.searchParams,
        });
        sendJson(response, 200, cockpit);
        metrics.incrementRequest(requestMethod, route.endpoint, 200);
        emitLog("info", {
          method: requestMethod,
          path: url.pathname,
          endpoint: route.endpoint,
          request_id: null,
          correlation_id: correlationId,
          trace_id: traceId,
          actor_type: actor.actorType,
          actor_id: actor.actorId,
          actor_role: actor.actorRole,
          tool_name: actor.toolName,
          ticket_id: null,
          replay: false,
          status: 200,
          duration_ms: Date.now() - requestStart,
        });
        return;
      }

      if (route.kind === "tech_job_packet") {
        actor = authRuntime.resolveActor(request.headers, route);
        const packet = await buildTechnicianJobPacketView({
          pool,
          actor,
          authRuntime,
          ticketId: route.ticketId,
          objectStoreSchemes,
        });
        sendJson(response, 200, packet);
        metrics.incrementRequest(requestMethod, route.endpoint, 200);
        emitLog("info", {
          method: requestMethod,
          path: url.pathname,
          endpoint: route.endpoint,
          request_id: null,
          correlation_id: correlationId,
          trace_id: traceId,
          actor_type: actor.actorType,
          actor_id: actor.actorId,
          actor_role: actor.actorRole,
          tool_name: actor.toolName,
          ticket_id: route.ticketId,
          replay: false,
          status: 200,
          duration_ms: Date.now() - requestStart,
        });
        return;
      }

      if (route.kind === "ticket") {
        actor = authRuntime.resolveActor(request.headers, route);
        const ticket = await getTicket(pool, route.ticketId);
        authRuntime.assertActorScopeForTarget(actor, {
          accountId: ticket.account_id,
          siteId: ticket.site_id,
        });
        sendJson(response, 200, ticket);
        metrics.incrementRequest(requestMethod, route.endpoint, 200);
        emitLog("info", {
          method: requestMethod,
          path: url.pathname,
          endpoint: route.endpoint,
          request_id: null,
          correlation_id: correlationId,
          trace_id: traceId,
          actor_type: actor.actorType,
          actor_id: actor.actorId,
          actor_role: actor.actorRole,
          tool_name: actor.toolName,
          ticket_id: route.ticketId,
          replay: false,
          status: 200,
          duration_ms: Date.now() - requestStart,
        });
        return;
      }

      if (route.kind === "timeline") {
        actor = authRuntime.resolveActor(request.headers, route);
        const ticket = await getTicket(pool, route.ticketId);
        authRuntime.assertActorScopeForTarget(actor, {
          accountId: ticket.account_id,
          siteId: ticket.site_id,
        });
        const timeline = await getTicketTimeline(pool, route.ticketId);
        sendJson(response, 200, timeline);
        metrics.incrementRequest(requestMethod, route.endpoint, 200);
        emitLog("info", {
          method: requestMethod,
          path: url.pathname,
          endpoint: route.endpoint,
          request_id: null,
          correlation_id: correlationId,
          trace_id: traceId,
          actor_type: actor.actorType,
          actor_id: actor.actorId,
          actor_role: actor.actorRole,
          tool_name: actor.toolName,
          ticket_id: route.ticketId,
          replay: false,
          status: 200,
          duration_ms: Date.now() - requestStart,
        });
        return;
      }

      if (route.kind === "evidence") {
        actor = authRuntime.resolveActor(request.headers, route);
        const ticket = await getTicket(pool, route.ticketId);
        authRuntime.assertActorScopeForTarget(actor, {
          accountId: ticket.account_id,
          siteId: ticket.site_id,
        });
        const evidence = await getTicketEvidence(pool, route.ticketId);
        sendJson(response, 200, evidence);
        metrics.incrementRequest(requestMethod, route.endpoint, 200);
        emitLog("info", {
          method: requestMethod,
          path: url.pathname,
          endpoint: route.endpoint,
          request_id: null,
          correlation_id: correlationId,
          trace_id: traceId,
          actor_type: actor.actorType,
          actor_id: actor.actorId,
          actor_role: actor.actorRole,
          tool_name: actor.toolName,
          ticket_id: route.ticketId,
          replay: false,
          status: 200,
          duration_ms: Date.now() - requestStart,
        });
        return;
      }

      if (route.kind !== "command") {
        throw new HttpError(500, "INTERNAL_ERROR", "Unsupported route handler");
      }

      const body = await parseJsonBody(request);
      requestId = parseIdempotencyKey(request.headers);
      actor = authRuntime.resolveActor(request.headers, route);

      const result = await runWithIdempotency({
        pool,
        actorId: actor.actorId,
        endpoint: route.endpoint,
        requestId,
        requestBody: body,
        runMutation: async (client) =>
          route.handler(client, {
            body,
            ticketId: route.ticketId,
            actor,
            requestId,
            correlationId,
            traceId,
            metrics,
            authRuntime,
            objectStoreSchemes,
            blindIntakePolicy,
          }),
      });

      sendJson(response, result.status, result.body);
      metrics.incrementRequest(requestMethod, route.endpoint, result.status);
      if (result.replay) {
        metrics.incrementIdempotencyReplay();
      }
      emitLog("info", {
        method: requestMethod,
        path: url.pathname,
        endpoint: route.endpoint,
        request_id: requestId,
        correlation_id: correlationId,
        trace_id: traceId,
        actor_type: actor.actorType,
        actor_id: actor.actorId,
        actor_role: actor.actorRole,
        tool_name: actor.toolName,
        ticket_id: route.ticketId ?? null,
        replay: result.replay ?? false,
        status: result.status,
        duration_ms: Date.now() - requestStart,
      });
    } catch (error) {
      const known = error instanceof HttpError;
      const status = known ? error.status : 500;
      const body = errorBody(
        known
          ? error
          : new HttpError(500, "INTERNAL_ERROR", "Internal server error", {
              reference: randomUUID(),
            }),
        requestId,
      );
      attachPolicyErrorContext(body.error);
      sendJson(response, status, body);
      const endpoint = route?.endpoint ?? "UNMATCHED";
      metrics.incrementRequest(requestMethod, endpoint, status);
      metrics.incrementError(body.error.code);
      if (body.error.code === "IDEMPOTENCY_PAYLOAD_MISMATCH") {
        metrics.incrementIdempotencyConflict();
      }

      emitLog("error", {
        method: requestMethod,
        path: url.pathname,
        endpoint,
        request_id: requestId,
        correlation_id: correlationId,
        trace_id: traceId,
        actor_type: actor?.actorType ?? null,
        actor_id: actor?.actorId ?? null,
        actor_role: actor?.actorRole ?? null,
        tool_name: actor?.toolName ?? null,
        ticket_id: route?.ticketId ?? null,
        replay: false,
        status,
        error_code: body.error.code,
        message: body.error.message,
        reason: known ? null : error instanceof Error ? error.message : String(error),
        duration_ms: Date.now() - requestStart,
      });
    }
  });

  return {
    host,
    port,
    server,
    getMetricsSnapshot() {
      return metrics.snapshot();
    },
    async getAlertsSnapshot() {
      return buildOperationalAlertsSnapshot({
        pool,
        metrics,
        alertThresholds,
      });
    },
    start() {
      return new Promise((resolve) => {
        server.listen(port, host, () => {
          resolve({ host, port });
        });
      });
    },
    stop() {
      return new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

export async function startDispatchApi(options = {}) {
  const app = createDispatchApiServer(options);
  await app.start();
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const app = createDispatchApiServer();
  app
    .start()
    .then(({ host, port }) => {
      console.log(
        JSON.stringify({
          level: "info",
          service: "dispatch-api",
          message: "dispatch-api started",
          host,
          port,
        }),
      );
    })
    .catch((error) => {
      console.error(
        JSON.stringify({
          level: "error",
          service: "dispatch-api",
          message: "dispatch-api failed to start",
          error: error?.message ?? String(error),
        }),
      );
      process.exitCode = 1;
    });

  const shutdown = async () => {
    await app.stop();
    await closePool();
  };

  process.on("SIGINT", () => {
    shutdown().finally(() => process.exit(0));
  });
  process.on("SIGTERM", () => {
    shutdown().finally(() => process.exit(0));
  });
}
