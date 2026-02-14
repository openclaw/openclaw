import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { closePool } from "../api/src/db.mjs";
import { startDispatchApi } from "../api/src/server.mjs";

const repoRoot = process.cwd();
const migrationSql = fs.readFileSync(
  path.resolve(repoRoot, "dispatch/db/migrations/001_init.sql"),
  "utf8",
);

const postgresContainer = "rd-story02-test";
const postgresPort = 55437;
const dispatchApiPort = 18087;
const baseUrl = `http://127.0.0.1:${dispatchApiPort}`;

const accountId = "00000000-0000-0000-0000-000000000021";
const siteId = "00000000-0000-0000-0000-000000000022";
const techId = "00000000-0000-0000-0000-000000000023";

let app;

function run(command, args, input = undefined) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    input,
  });
  if (result.status !== 0) {
    throw new Error(
      [
        `Command failed: ${command} ${args.join(" ")}`,
        result.stdout,
        result.stderr,
      ]
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

async function post(pathname, headers, payload) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
  const bodyText = await response.text();
  return {
    status: response.status,
    body: bodyText ? JSON.parse(bodyText) : null,
  };
}

async function get(pathname, headers = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: "GET",
    headers,
  });
  const bodyText = await response.text();
  return {
    status: response.status,
    body: bodyText ? JSON.parse(bodyText) : null,
  };
}

function assertTimelineOrdered(events) {
  for (let i = 0; i < events.length - 1; i += 1) {
    const current = events[i];
    const next = events[i + 1];
    const currentAt = Date.parse(current.created_at);
    const nextAt = Date.parse(next.created_at);

    assert.ok(Number.isFinite(currentAt), "created_at must be parseable");
    assert.ok(Number.isFinite(nextAt), "created_at must be parseable");
    assert.ok(currentAt <= nextAt, "timeline must be ordered by created_at ASC");

    if (currentAt === nextAt) {
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
    VALUES ('${accountId}', 'Story 02 Account');
  `);
  psql(`
    INSERT INTO sites (id, account_id, name, address1, city)
    VALUES ('${siteId}', '${accountId}', 'Story 02 Site', '2 Main St', 'Springfield');
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

test("timeline returns ordered complete audit events for each successful mutation", async () => {
  const create = await post(
    "/tickets",
    {
      "Idempotency-Key": "21000000-0000-4000-8000-000000000001",
      "X-Actor-Id": "dispatcher-2",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.create",
      "X-Correlation-Id": "corr-story-02-create",
    },
    {
      account_id: accountId,
      site_id: siteId,
      summary: "Story 02 timeline ticket",
      description: "Timeline contract validation",
    },
  );
  assert.equal(create.status, 201);
  const ticketId = create.body.id;

  const triage = await post(
    `/tickets/${ticketId}/triage`,
    {
      "Idempotency-Key": "21000000-0000-4000-8000-000000000002",
      "X-Actor-Id": "dispatcher-2",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.triage",
      "X-Correlation-Id": "corr-story-02-triage",
    },
    {
      priority: "URGENT",
      incident_type: "ACCESS_CONTROL_FAULT",
      nte_cents: 17500,
    },
  );
  assert.equal(triage.status, 200);

  const dispatch = await post(
    `/tickets/${ticketId}/assignment/dispatch`,
    {
      "Idempotency-Key": "21000000-0000-4000-8000-000000000003",
      "X-Actor-Id": "dispatcher-2",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "assignment.dispatch",
      "X-Correlation-Id": "corr-story-02-dispatch",
    },
    {
      tech_id: techId,
      dispatch_mode: "EMERGENCY_BYPASS",
    },
  );
  assert.equal(dispatch.status, 200);
  assert.equal(dispatch.body.state, "DISPATCHED");

  const timeline = await get(`/tickets/${ticketId}/timeline`);
  assert.equal(timeline.status, 200);
  assert.equal(timeline.body.ticket_id, ticketId);
  assert.equal(Array.isArray(timeline.body.events), true);
  assert.equal(timeline.body.events.length, 3);

  const auditCount = Number(psql(`SELECT count(*) FROM audit_events WHERE ticket_id = '${ticketId}';`));
  assert.equal(timeline.body.events.length, auditCount);

  assertTimelineOrdered(timeline.body.events);

  assert.deepEqual(
    timeline.body.events.map((event) => event.tool_name),
    ["ticket.create", "ticket.triage", "assignment.dispatch"],
  );

  const requiredKeys = [
    "id",
    "ticket_id",
    "actor_type",
    "actor_id",
    "actor_role",
    "tool_name",
    "request_id",
    "correlation_id",
    "trace_id",
    "before_state",
    "after_state",
    "payload",
    "created_at",
  ];

  for (const event of timeline.body.events) {
    for (const key of requiredKeys) {
      assert.ok(Object.prototype.hasOwnProperty.call(event, key), `missing timeline key ${key}`);
    }
    assert.ok(["HUMAN", "AGENT", "SERVICE", "SYSTEM"].includes(event.actor_type));
    assert.equal(typeof event.actor_id, "string");
    assert.notEqual(event.actor_id.trim(), "");
    assert.equal(typeof event.tool_name, "string");
    assert.notEqual(event.tool_name.trim(), "");
    assert.match(event.request_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    assert.equal(typeof event.correlation_id, "string");
    assert.notEqual(event.correlation_id.trim(), "");
    assert.equal(event.trace_id, null);
    assert.equal(typeof event.payload, "object");
  }

  assert.equal(timeline.body.events[0].before_state, null);
  assert.equal(timeline.body.events[0].after_state, "NEW");

  for (const event of timeline.body.events.slice(1)) {
    assert.notEqual(event.before_state, null);
    assert.notEqual(event.after_state, null);
  }
});

test("timeline returns 404 for unknown ticket id", async () => {
  const response = await get("/tickets/ffffffff-ffff-4fff-8fff-ffffffffffff/timeline");
  assert.equal(response.status, 404);
  assert.equal(response.body.error.code, "TICKET_NOT_FOUND");
});

test("timeline returns 400 for invalid ticket id format", async () => {
  const response = await get("/tickets/not-a-uuid/timeline");
  assert.equal(response.status, 400);
  assert.equal(response.body.error.code, "INVALID_TICKET_ID");
});
