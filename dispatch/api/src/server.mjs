import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
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
  requireHeader,
  requireUuidField,
  sendJson,
} from "./http-utils.mjs";
import {
  getCommandEndpointPolicy,
  isRoleAllowedForCommandEndpoint,
  isToolAllowedForCommandEndpoint,
} from "../../shared/authorization-policy.mjs";

const ticketRouteRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function getCommandPolicy(endpoint) {
  const policy = getCommandEndpointPolicy(endpoint);
  if (!policy) {
    throw new HttpError(500, "INTERNAL_ERROR", "Missing command authorization policy");
  }
  return policy;
}

function parseActorFromHeaders(headers, endpoint) {
  const policy = getCommandPolicy(endpoint);
  const actorId = requireHeader(
    headers,
    "x-actor-id",
    "MISSING_ACTOR_CONTEXT",
    "Header 'X-Actor-Id' is required",
  );
  const actorRole = requireHeader(
    headers,
    "x-actor-role",
    "MISSING_ACTOR_CONTEXT",
    "Header 'X-Actor-Role' is required",
  ).toLowerCase();
  const actorTypeRaw = lowerHeader(headers, "x-actor-type");
  const actorType = actorTypeRaw ? actorTypeRaw.trim().toUpperCase() : "HUMAN";
  const toolNameHeader = lowerHeader(headers, "x-tool-name");
  const toolName = toolNameHeader?.trim() || policy.default_tool_name;

  if (!["HUMAN", "AGENT", "SERVICE", "SYSTEM"].includes(actorType)) {
    throw new HttpError(400, "INVALID_ACTOR_CONTEXT", "Header 'X-Actor-Type' must be valid");
  }

  if (!isRoleAllowedForCommandEndpoint(endpoint, actorRole)) {
    throw new HttpError(403, "FORBIDDEN", `Actor role '${actorRole}' is not allowed for endpoint`);
  }

  if (!isToolAllowedForCommandEndpoint(endpoint, toolName)) {
    throw new HttpError(403, "TOOL_NOT_ALLOWED", `Tool '${toolName}' is not allowed for endpoint`, {
      endpoint,
      tool_name: toolName,
    });
  }

  return {
    actorId,
    actorRole,
    actorType,
    toolName,
  };
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

async function insertAuditAndTransition(client, params) {
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

  const auditEventId = auditResult.rows[0].id;
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
    [ticketId, beforeState, afterState, auditEventId],
  );
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

async function getTicketTimeline(pool, ticketId) {
  validateTicketId(ticketId);

  const ticketExists = await pool.query("SELECT 1 FROM tickets WHERE id = $1", [ticketId]);
  if (ticketExists.rowCount === 0) {
    throw new HttpError(404, "TICKET_NOT_FOUND", "Ticket not found");
  }

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

function ensureString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' is required`);
  }
}

function parseIsoDate(value, fieldName) {
  ensureString(value, fieldName);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' must be ISO date-time`);
  }
  return parsed.toISOString();
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
  const { body, actor, requestId, correlationId, traceId } = context;
  ensureObject(body);
  requireUuidField(body.account_id, "account_id");
  requireUuidField(body.site_id, "site_id");
  if (body.asset_id != null) {
    requireUuidField(body.asset_id, "asset_id");
  }
  ensureString(body.summary, "summary");

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

async function triageTicketMutation(client, context) {
  const { ticketId, body, actor, requestId, correlationId, traceId } = context;
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

  const existing = await getTicketForUpdate(client, ticketId);
  assertCommandStateAllowed("/tickets/{ticketId}/triage", existing.state, body);

  const update = await client.query(
    `
      UPDATE tickets
      SET
        state = 'TRIAGED',
        priority = $2,
        incident_type = $3,
        nte_cents = COALESCE($4, nte_cents),
        version = version + 1
      WHERE id = $1
      RETURNING *
    `,
    [ticketId, priority, body.incident_type.trim(), body.nte_cents ?? null],
  );

  const ticket = update.rows[0];

  await insertAuditAndTransition(client, {
    ticketId,
    beforeState: existing.state,
    afterState: "TRIAGED",
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
    },
  });

  return {
    status: 200,
    body: serializeTicket(ticket),
  };
}

async function confirmScheduleMutation(client, context) {
  const { ticketId, body, actor, requestId, correlationId, traceId } = context;
  ensureObject(body);
  const start = parseIsoDate(body.start, "start");
  const end = parseIsoDate(body.end, "end");

  if (new Date(end).getTime() <= new Date(start).getTime()) {
    throw new HttpError(400, "INVALID_REQUEST", "Field 'end' must be after 'start'");
  }

  const existing = await getTicketForUpdate(client, ticketId);
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
  const { ticketId, body, actor, requestId, correlationId, traceId } = context;
  ensureObject(body);
  requireUuidField(body.tech_id, "tech_id");
  if (body.provider_id != null) {
    requireUuidField(body.provider_id, "provider_id");
  }

  const existing = await getTicketForUpdate(client, ticketId);
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

function resolveRoute(method, pathname) {
  if (method === "GET" && pathname === "/health") {
    return { kind: "health" };
  }

  const timelineMatch = pathname.match(/^\/tickets\/([^/]+)\/timeline$/);
  if (method === "GET" && timelineMatch) {
    return {
      kind: "timeline",
      endpoint: "/tickets/{ticketId}/timeline",
      ticketId: timelineMatch[1],
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

  return null;
}

export function createDispatchApiServer(options = {}) {
  const pool = options.pool ?? getPool();
  const host = options.host ?? process.env.DISPATCH_API_HOST ?? "127.0.0.1";
  const port = Number(options.port ?? process.env.DISPATCH_API_PORT ?? "8080");

  const server = createServer(async (request, response) => {
    const requestStart = Date.now();
    const requestMethod = request.method ?? "GET";
    const url = new URL(request.url ?? "/", "http://localhost");
    const route = resolveRoute(requestMethod, url.pathname);

    if (!route) {
      sendJson(response, 404, {
        error: {
          code: "NOT_FOUND",
          message: "Route not found",
          request_id: null,
        },
      });
      return;
    }

    if (route.kind === "health") {
      sendJson(response, 200, {
        status: "ok",
        service: "dispatch-api",
        now: nowIso(),
      });
      return;
    }

    let requestId = null;
    try {
      if (route.kind === "timeline") {
        const timeline = await getTicketTimeline(pool, route.ticketId);
        sendJson(response, 200, timeline);
        console.log(
          JSON.stringify({
            level: "info",
            service: "dispatch-api",
            method: requestMethod,
            path: url.pathname,
            endpoint: route.endpoint,
            request_id: null,
            correlation_id: null,
            replay: false,
            status: 200,
            duration_ms: Date.now() - requestStart,
          }),
        );
        return;
      }

      if (route.kind !== "command") {
        throw new HttpError(500, "INTERNAL_ERROR", "Unsupported route handler");
      }

      const body = await parseJsonBody(request);
      requestId = parseIdempotencyKey(request.headers);
      const actor = parseActorFromHeaders(request.headers, route.endpoint);
      const correlationId = buildCorrelationId(request.headers);
      const traceId = buildTraceId(request.headers);

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
          }),
      });

      sendJson(response, result.status, result.body);
      console.log(
        JSON.stringify({
          level: "info",
          service: "dispatch-api",
          method: requestMethod,
          path: url.pathname,
          endpoint: route.endpoint,
          request_id: requestId,
          correlation_id: correlationId,
          replay: result.replay ?? false,
          status: result.status,
          duration_ms: Date.now() - requestStart,
        }),
      );
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

      console.error(
        JSON.stringify({
          level: "error",
          service: "dispatch-api",
          method: requestMethod,
          path: url.pathname,
          request_id: requestId,
          status,
          error_code: body.error.code,
          message: body.error.message,
          duration_ms: Date.now() - requestStart,
        }),
      );
    }
  });

  return {
    host,
    port,
    server,
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
