import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { canonicalJsonHash } from "./canonical-json.mjs";
import { closePool, getPool } from "./db.mjs";
import { createAuthRuntime } from "./auth.mjs";
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
import {
  getCommandEndpointPolicy,
} from "../../shared/authorization-policy.mjs";
import {
  IncidentTemplatePolicyError,
  evaluateCloseoutRequirements,
  getIncidentTemplate,
} from "../../workflow-engine/rules/closeout-required-evidence.mjs";

const ticketRouteRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emitStructuredLog(logger, level, payload) {
  const line = JSON.stringify({
    level,
    service: "dispatch-api",
    ...payload,
  });

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

function createMetricsRegistry() {
  const requestsTotal = new Map();
  const errorsTotal = new Map();
  const transitionsTotal = new Map();
  let idempotencyReplayTotal = 0;
  let idempotencyConflictTotal = 0;

  function incrementCounter(map, key) {
    map.set(key, (map.get(key) ?? 0) + 1);
  }

  return {
    incrementRequest(method, endpoint, status) {
      const key = JSON.stringify([String(method), String(endpoint), Number(status)]);
      incrementCounter(requestsTotal, key);
    },
    incrementError(code) {
      const normalized = typeof code === "string" && code.trim() !== "" ? code.trim() : "UNKNOWN_ERROR";
      incrementCounter(errorsTotal, normalized);
    },
    incrementTransition(fromState, toState) {
      const key = JSON.stringify([fromState ?? null, toState ?? null]);
      incrementCounter(transitionsTotal, key);
    },
    incrementIdempotencyReplay() {
      idempotencyReplayTotal += 1;
    },
    incrementIdempotencyConflict() {
      idempotencyConflictTotal += 1;
    },
    snapshot() {
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
        .sort(
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
        .sort((left, right) => left.code.localeCompare(right.code));

      const transitions = Array.from(transitionsTotal.entries())
        .map(([key, count]) => {
          const [fromState, toState] = JSON.parse(key);
          return {
            from_state: fromState,
            to_state: toState,
            count,
          };
        })
        .sort((left, right) => {
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
    },
  };
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
    nte_cents: Number(row.nte_cents),
    scheduled_start: row.scheduled_start ? new Date(row.scheduled_start).toISOString() : null,
    scheduled_end: row.scheduled_end ? new Date(row.scheduled_end).toISOString() : null,
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
  const {
    ticketId,
    fromState,
    toState,
    auditEventId,
    metrics,
  } = params;

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
  const {
    ticketId,
    beforeState,
    afterState,
    metrics,
  } = params;
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
  const raw =
    typeof value === "string" && value.trim() !== ""
      ? value
      : "s3,minio";
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
    if (typeof parsed.pathname !== "string" || parsed.pathname.trim() === "" || parsed.pathname === "/") {
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
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
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
    throw new HttpError(409, "CLOSEOUT_REQUIREMENTS_INCOMPLETE", "Closeout requirements are incomplete", {
      requirement_code: "MISSING_SIGNATURE_CONFIRMATION",
      incident_type: String(incidentType).trim().toUpperCase(),
      template_version: null,
      missing_evidence_keys: ["signature_or_no_signature_reason"],
      missing_checklist_keys: [],
      invalid_evidence_refs: [],
    });
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
  const {
    pool,
    actorId,
    endpoint,
    requestId,
    requestBody,
    runMutation,
  } = params;
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
  const { ticketId, body, actor, requestId, correlationId, traceId, metrics, authRuntime } = context;
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

  const existing = await getTicketForUpdate(client, ticketId);
  assertTicketScope(authRuntime, actor, existing);
  assertCommandStateAllowed("/tickets/{ticketId}/triage", existing.state, body);

  const update = await client.query(
    `
      UPDATE tickets
      SET
        state = $2,
        priority = $3,
        incident_type = $4,
        nte_cents = COALESCE($5, nte_cents),
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
        derived_transitions: [
          `${existing.state}->TRIAGED`,
          `TRIAGED->${targetState}`,
        ],
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
  const { ticketId, body, actor, requestId, correlationId, traceId, metrics, authRuntime } = context;
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
  const { ticketId, body, actor, requestId, correlationId, traceId, metrics, authRuntime } = context;
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
  const { ticketId, body, actor, requestId, correlationId, traceId, metrics, authRuntime } = context;
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
  const { ticketId, body, actor, requestId, correlationId, traceId, metrics, authRuntime } = context;
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
  const { ticketId, body, actor, requestId, correlationId, traceId, metrics, authRuntime } = context;
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
  const { ticketId, body, actor, requestId, correlationId, traceId, metrics, authRuntime } = context;
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
    throw new HttpError(409, "CLOSEOUT_REQUIREMENTS_INCOMPLETE", "Closeout requirements are incomplete", {
      requirement_code: "TEMPLATE_NOT_FOUND",
      incident_type: null,
      template_version: null,
      missing_evidence_keys: [],
      missing_checklist_keys: [],
      invalid_evidence_refs: [],
    });
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
    throw new HttpError(409, "CLOSEOUT_REQUIREMENTS_INCOMPLETE", "Closeout requirements are incomplete", {
      requirement_code: "MISSING_COMPLETION_CONTEXT",
      incident_type: existing.incident_type ? existing.incident_type.trim().toUpperCase() : null,
      template_version: null,
      missing_evidence_keys: [],
      missing_checklist_keys: [],
      invalid_evidence_refs: [],
    });
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
    throw new HttpError(409, "CLOSEOUT_REQUIREMENTS_INCOMPLETE", "Closeout requirements are incomplete", {
      requirement_code: "INVALID_EVIDENCE_REFERENCE",
      incident_type: existing.incident_type.trim().toUpperCase(),
      template_version: null,
      missing_evidence_keys: [],
      missing_checklist_keys: [],
      invalid_evidence_refs: verificationEvidenceValidation.invalid_evidence_refs,
    });
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
    throw new HttpError(409, "CLOSEOUT_REQUIREMENTS_INCOMPLETE", "Closeout requirements are incomplete", {
      requirement_code: verifyCloseout.code,
      incident_type: verifyCloseout.incident_type,
      template_version: verifyCloseout.template_version,
      missing_evidence_keys: verifyCloseout.missing_evidence_keys,
      missing_checklist_keys: verifyCloseout.missing_checklist_keys,
      invalid_evidence_refs: [],
    });
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
  const { ticketId, body, actor, requestId, correlationId, traceId, metrics, authRuntime } = context;
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
  const noSignatureReason = normalizeOptionalString(body.no_signature_reason, "no_signature_reason");
  const explicitEvidenceRefs = normalizeOptionalStringArray(body.evidence_refs, "evidence_refs");

  const existing = await getTicketForUpdate(client, ticketId);
  assertTicketScope(authRuntime, actor, existing);
  assertCommandStateAllowed("/tickets/{ticketId}/tech/complete", existing.state, body);

  if (typeof existing.incident_type !== "string" || existing.incident_type.trim() === "") {
    throw new HttpError(409, "CLOSEOUT_REQUIREMENTS_INCOMPLETE", "Closeout requirements are incomplete", {
      requirement_code: "TEMPLATE_NOT_FOUND",
      incident_type: null,
      template_version: null,
      missing_evidence_keys: [],
      missing_checklist_keys: [],
    });
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
    throw new HttpError(409, "CLOSEOUT_REQUIREMENTS_INCOMPLETE", "Closeout requirements are incomplete", {
      requirement_code: "INVALID_EVIDENCE_REFERENCE",
      incident_type: existing.incident_type.trim().toUpperCase(),
      template_version: null,
      missing_evidence_keys: [],
      missing_checklist_keys: [],
      invalid_evidence_refs: evidenceValidation.invalid_evidence_refs,
    });
  }

  const evidenceKeys = [];
  for (const row of evidenceResult.rows) {
    const evidenceKey = readEvidenceKeyFromMetadata(row.metadata);
    if (evidenceKey) {
      evidenceKeys.push(evidenceKey);
    }
  }
  if (evidenceValidation.signature_satisfied && !evidenceKeys.includes("signature_or_no_signature_reason")) {
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
      throw new HttpError(409, "CLOSEOUT_REQUIREMENTS_INCOMPLETE", "Closeout requirements are incomplete", {
        requirement_code: "TEMPLATE_NOT_FOUND",
        incident_type: existing.incident_type.trim().toUpperCase(),
        template_version: null,
        missing_evidence_keys: [],
        missing_checklist_keys: [],
      });
    }
    throw error;
  }

  if (!closeoutEvaluation.ready) {
    throw new HttpError(409, "CLOSEOUT_REQUIREMENTS_INCOMPLETE", "Closeout requirements are incomplete", {
      requirement_code: closeoutEvaluation.code,
      incident_type: closeoutEvaluation.incident_type,
      template_version: closeoutEvaluation.template_version,
      missing_evidence_keys: closeoutEvaluation.missing_evidence_keys,
      missing_checklist_keys: closeoutEvaluation.missing_checklist_keys,
    });
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
  if (method === "POST" && techRequestChangeMatch && ticketRouteRegex.test(techRequestChangeMatch[1])) {
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
  const metrics = options.metrics ?? createMetricsRegistry();
  const authRuntime = createAuthRuntime(options.auth ?? {});
  const objectStoreSchemes = parseObjectStoreSchemes(
    options.objectStoreSchemes ?? process.env.DISPATCH_OBJECT_STORE_SCHEMES,
  );

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
      emitStructuredLog(logger, "error", {
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
      emitStructuredLog(logger, "info", {
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
      emitStructuredLog(logger, "info", {
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
      if (route.kind === "ticket") {
        actor = authRuntime.resolveActor(request.headers, route);
        const ticket = await getTicket(pool, route.ticketId);
        authRuntime.assertActorScopeForTarget(actor, {
          accountId: ticket.account_id,
          siteId: ticket.site_id,
        });
        sendJson(response, 200, ticket);
        metrics.incrementRequest(requestMethod, route.endpoint, 200);
        emitStructuredLog(logger, "info", {
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
        emitStructuredLog(logger, "info", {
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
        emitStructuredLog(logger, "info", {
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
          }),
      });

      sendJson(response, result.status, result.body);
      metrics.incrementRequest(requestMethod, route.endpoint, result.status);
      if (result.replay) {
        metrics.incrementIdempotencyReplay();
      }
      emitStructuredLog(logger, "info", {
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
      sendJson(response, status, body);
      const endpoint = route?.endpoint ?? "UNMATCHED";
      metrics.incrementRequest(requestMethod, endpoint, status);
      metrics.incrementError(body.error.code);
      if (body.error.code === "IDEMPOTENCY_PAYLOAD_MISMATCH") {
        metrics.incrementIdempotencyConflict();
      }

      emitStructuredLog(logger, "error", {
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
