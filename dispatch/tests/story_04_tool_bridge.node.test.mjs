import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { closePool } from "../api/src/db.mjs";
import { startDispatchApi } from "../api/src/server.mjs";
import { DispatchBridgeError, invokeDispatchAction, isUuid } from "../tools-plugin/src/bridge.mjs";

const repoRoot = process.cwd();
const migrationSql = fs.readFileSync(
  path.resolve(repoRoot, "dispatch/db/migrations/001_init.sql"),
  "utf8",
);

const postgresContainer = "rd-story04-test";
const postgresPort = 55438;
const dispatchApiPort = 18088;
const dispatchApiBaseUrl = `http://127.0.0.1:${dispatchApiPort}`;

const accountId = "00000000-0000-0000-0000-000000000031";
const siteId = "00000000-0000-0000-0000-000000000032";
const techId = "00000000-0000-0000-0000-000000000033";

let app;

function run(command, args, input = undefined) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
  });
  if (result.status !== 0) {
    throw new Error(
      [`Command failed: ${command} ${args.join(" ")}`, result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return result.stdout.trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function psql(sql) {
  return run("docker", [
    "exec",
    "-i",
    postgresContainer,
    "psql",
    "-v",
    "ON_ERROR_STOP=1",
    "-U",
    "dispatch",
    "-d",
    "dispatch",
    "-At",
    "-c",
    sql,
  ]);
}

function assertOrdered(events) {
  for (let i = 0; i < events.length - 1; i += 1) {
    const current = events[i];
    const next = events[i + 1];
    const left = Date.parse(current.created_at);
    const right = Date.parse(next.created_at);
    assert.ok(Number.isFinite(left));
    assert.ok(Number.isFinite(right));
    assert.ok(left <= right, "timeline must be ordered by created_at ASC");
    if (left === right) {
      assert.ok(current.id <= next.id, "timeline tie-breaker must be id ASC");
    }
  }
}

test.before(async () => {
  spawnSync("docker", ["rm", "-f", postgresContainer], { encoding: "utf8" });
  run("docker", [
    "run",
    "--rm",
    "-d",
    "--name",
    postgresContainer,
    "-e",
    "POSTGRES_USER=dispatch",
    "-e",
    "POSTGRES_PASSWORD=dispatch",
    "-e",
    "POSTGRES_DB=dispatch",
    "-p",
    `${postgresPort}:5432`,
    "postgres:16",
  ]);

  let ready = false;
  for (let i = 0; i < 30; i += 1) {
    const probe = spawnSync(
      "docker",
      ["exec", postgresContainer, "pg_isready", "-U", "dispatch", "-d", "dispatch"],
      { encoding: "utf8" },
    );
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await sleep(500);
  }

  if (!ready) {
    throw new Error("Postgres container did not become ready");
  }

  run(
    "docker",
    [
      "exec",
      "-i",
      postgresContainer,
      "psql",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "dispatch",
      "-d",
      "dispatch",
    ],
    migrationSql,
  );

  psql(`
    INSERT INTO accounts (id, name)
    VALUES ('${accountId}', 'Story 04 Account');
  `);
  psql(`
    INSERT INTO sites (id, account_id, name, address1, city)
    VALUES ('${siteId}', '${accountId}', 'Story 04 Site', '4 Main St', 'Springfield');
  `);

  process.env.DISPATCH_DATABASE_URL = `postgres://dispatch:dispatch@127.0.0.1:${postgresPort}/dispatch`;
  app = await startDispatchApi({
    host: "127.0.0.1",
    port: dispatchApiPort,
  });
});

test.after(async () => {
  if (app) {
    await app.stop();
  }
  await closePool();
  spawnSync("docker", ["rm", "-f", postgresContainer], { encoding: "utf8" });
});

test("bridge forwards allowlisted tools and propagates request + correlation into audit", async () => {
  const logs = [];
  const logger = {
    info(message) {
      logs.push(message);
    },
    error(message) {
      logs.push(message);
    },
  };

  const createRequestId = "31000000-0000-4000-8000-000000000001";
  const createCorrelationId = "corr-story04-create";

  const create = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "ticket.create",
    actorId: "dispatcher-bridge-1",
    actorRole: "dispatcher",
    actorType: "AGENT",
    requestId: createRequestId,
    correlationId: createCorrelationId,
    traceParent: "00-4bf92f3577b34da6a3ce929d0e0e4736a-00f067aa0ba902b7-01",
    traceState: "congo=t61rcWkgMzE,rojo=00f067aa0ba902b7",
    logger,
    payload: {
      account_id: accountId,
      site_id: siteId,
      summary: "Story 04 bridge ticket",
      description: "Bridge mapping validation",
    },
  });

  assert.equal(create.status, 201);
  assert.equal(create.request_id, createRequestId);
  assert.equal(create.correlation_id, createCorrelationId);

  const ticketId = create.data.id;
  assert.ok(isUuid(ticketId));

  const createAuditRow = psql(`
    SELECT actor_type, actor_id, actor_role, tool_name, request_id::text, correlation_id, trace_id, before_state::text, after_state::text
    FROM audit_events
    WHERE ticket_id = '${ticketId}'
    ORDER BY created_at ASC, id ASC
    LIMIT 1;
  `).split("|");

  assert.deepEqual(createAuditRow.slice(0, 6), [
    "AGENT",
    "dispatcher-bridge-1",
    "dispatcher",
    "ticket.create",
    createRequestId,
    createCorrelationId,
  ]);
  assert.equal(createAuditRow[6], "");
  assert.equal(createAuditRow[7], "");
  assert.equal(createAuditRow[8], "NEW");
  const createAuditPayloadRow = psql(`
    SELECT payload::text
    FROM audit_events
    WHERE ticket_id = '${ticketId}'
    ORDER BY created_at ASC, id ASC
    LIMIT 1;
  `).trim();
  const createAuditPayload = JSON.parse(createAuditPayloadRow);
  assert.equal(
    createAuditPayload.trace_parent,
    "00-4bf92f3577b34da6a3ce929d0e0e4736a-00f067aa0ba902b7-01",
  );
  assert.equal(createAuditPayload.trace_state, "congo=t61rcWkgMzE,rojo=00f067aa0ba902b7");

  const triage = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "ticket.triage",
    actorId: "dispatcher-bridge-1",
    actorRole: "dispatcher",
    correlationId: "corr-story04-triage",
    ticketId,
    payload: {
      priority: "EMERGENCY",
      incident_type: "DOOR_PANEL_FAILURE",
      nte_cents: 33000,
    },
  });
  assert.equal(triage.status, 200);
  assert.ok(isUuid(triage.request_id));

  const dispatch = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "assignment.dispatch",
    actorId: "dispatcher-bridge-1",
    actorRole: "dispatcher",
    requestId: "31000000-0000-4000-8000-000000000003",
    correlationId: "corr-story04-dispatch",
    ticketId,
    payload: {
      tech_id: techId,
      dispatch_mode: "EMERGENCY_BYPASS",
    },
  });
  assert.equal(dispatch.status, 200);

  const timeline = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "ticket.timeline",
    actorId: "dispatcher-bridge-1",
    actorRole: "dispatcher",
    correlationId: "corr-story04-timeline",
    ticketId,
  });

  assert.equal(timeline.status, 200);
  assert.equal(timeline.data.ticket_id, ticketId);
  assert.equal(Array.isArray(timeline.data.events), true);
  assert.equal(timeline.data.events.length, 3);
  assert.deepEqual(
    timeline.data.events.map((event) => event.tool_name),
    ["ticket.create", "ticket.triage", "assignment.dispatch"],
  );
  assertOrdered(timeline.data.events);

  const requestLog = logs
    .map((entry) => {
      try {
        return JSON.parse(entry);
      } catch {
        return null;
      }
    })
    .find(
      (entry) =>
        entry &&
        entry.component === "dispatch-tool-bridge" &&
        entry.phase === "request" &&
        entry.tool_name === "ticket.create",
    );

  assert.ok(requestLog);
  assert.equal(requestLog.request_id, createRequestId);
  assert.equal(requestLog.correlation_id, createCorrelationId);
});

test("bridge rejects unknown tools fail closed", async () => {
  await assert.rejects(
    invokeDispatchAction({
      baseUrl: dispatchApiBaseUrl,
      toolName: "unknown.tool",
      actorId: "dispatcher-bridge-2",
      actorRole: "dispatcher",
    }),
    (error) => {
      assert.ok(error instanceof DispatchBridgeError);
      assert.equal(error.code, "UNKNOWN_TOOL");
      assert.equal(error.status, 400);
      return true;
    },
  );
});

test("bridge enforces role allowlist before mutation", async () => {
  const create = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "ticket.create",
    actorId: "dispatcher-bridge-3",
    actorRole: "dispatcher",
    payload: {
      account_id: accountId,
      site_id: siteId,
      summary: "Role gate ticket",
    },
  });

  const ticketId = create.data.id;
  const beforeAuditCount = Number(
    psql(`SELECT count(*) FROM audit_events WHERE ticket_id = '${ticketId}';`),
  );

  await assert.rejects(
    invokeDispatchAction({
      baseUrl: dispatchApiBaseUrl,
      toolName: "assignment.dispatch",
      actorId: "customer-bridge-1",
      actorRole: "customer",
      ticketId,
      payload: {
        tech_id: techId,
        dispatch_mode: "EMERGENCY_BYPASS",
      },
    }),
    (error) => {
      assert.ok(error instanceof DispatchBridgeError);
      assert.equal(error.code, "TOOL_ROLE_FORBIDDEN");
      assert.equal(error.status, 403);
      return true;
    },
  );

  const afterAuditCount = Number(
    psql(`SELECT count(*) FROM audit_events WHERE ticket_id = '${ticketId}';`),
  );
  assert.equal(afterAuditCount, beforeAuditCount);
});
