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

const postgresContainer = "rd-story09-test";
const postgresPort = 55441;
const dispatchApiPort = 18091;
const baseUrl = `http://127.0.0.1:${dispatchApiPort}`;

const accountId = "00000000-0000-0000-0000-000000000061";
const siteId = "00000000-0000-0000-0000-000000000062";
const requestId = "91000000-0000-4000-8000-000000000001";
const correlationId = "corr-story09-create";
const traceId = "trace-story09-create";
const traceParent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

let app;
const infoLogs = [];
const errorLogs = [];

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

function parseLogs(lines) {
  return lines.map((line) => JSON.parse(line));
}

function findRequestCounter(snapshot, method, endpoint, status) {
  return snapshot.counters.requests_total.find(
    (entry) => entry.method === method && entry.endpoint === endpoint && entry.status === status,
  );
}

function findErrorCounter(snapshot, code) {
  return snapshot.counters.errors_total.find((entry) => entry.code === code);
}

function findTransitionCounter(snapshot, fromState, toState) {
  return snapshot.counters.transitions_total.find(
    (entry) => entry.from_state === fromState && entry.to_state === toState,
  );
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

  run("docker", [
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
    "-c",
    `INSERT INTO accounts (id, name) VALUES ('${accountId}', 'Story 09 Account');`,
  ]);
  run("docker", [
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
    "-c",
    `INSERT INTO sites (id, account_id, name, address1, city) VALUES ('${siteId}', '${accountId}', 'Story 09 Site', '9 Main St', 'Springfield');`,
  ]);

  process.env.DISPATCH_DATABASE_URL = `postgres://dispatch:dispatch@127.0.0.1:${postgresPort}/dispatch`;

  app = await startDispatchApi({
    host: "127.0.0.1",
    port: dispatchApiPort,
    logger: {
      info(message) {
        infoLogs.push(message);
      },
      error(message) {
        errorLogs.push(message);
      },
    },
  });
});

test.after(async () => {
  if (app) {
    await app.stop();
  }
  await closePool();
  spawnSync("docker", ["rm", "-f", postgresContainer], { encoding: "utf8" });
});

test("structured logs include request/correlation fields and metrics counters export deterministically", async () => {
  const create = await post(
    "/tickets",
    {
      "Idempotency-Key": requestId,
      "X-Actor-Id": "dispatcher-story09",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.create",
      "X-Correlation-Id": correlationId,
      "X-Trace-Id": traceId,
    },
    {
      account_id: accountId,
      site_id: siteId,
      summary: "Story 09 observability ticket",
    },
  );
  assert.equal(create.status, 201);

  const replay = await post(
    "/tickets",
    {
      "Idempotency-Key": requestId,
      "X-Actor-Id": "dispatcher-story09",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.create",
      "X-Correlation-Id": correlationId,
      "X-Trace-Id": traceId,
    },
    {
      account_id: accountId,
      site_id: siteId,
      summary: "Story 09 observability ticket",
    },
  );
  assert.equal(replay.status, 201);

  const conflict = await post(
    "/tickets",
    {
      "Idempotency-Key": requestId,
      "X-Actor-Id": "dispatcher-story09",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.create",
      "X-Correlation-Id": correlationId,
      "X-Trace-Id": traceId,
    },
    {
      account_id: accountId,
      site_id: siteId,
      summary: "Story 09 payload mismatch",
    },
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");

  const invalidTimeline = await get("/tickets/not-a-uuid/timeline", {
    "X-Actor-Id": "dispatcher-story09",
    "X-Actor-Role": "dispatcher",
    "X-Tool-Name": "ticket.timeline",
    "X-Correlation-Id": "corr-story09-invalid",
  });
  assert.equal(invalidTimeline.status, 400);
  assert.equal(invalidTimeline.body.error.code, "INVALID_TICKET_ID");

  const notFound = await get("/not-a-real-route");
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.code, "NOT_FOUND");

  const metricsResponse = await get("/metrics", {
    "X-Correlation-Id": "corr-story09-metrics",
  });
  assert.equal(metricsResponse.status, 200);

  const snapshot = metricsResponse.body;
  assert.equal(snapshot.service, "dispatch-api");
  assert.equal(typeof snapshot.generated_at, "string");

  assert.equal(findRequestCounter(snapshot, "POST", "/tickets", 201)?.count, 2);
  assert.equal(findRequestCounter(snapshot, "POST", "/tickets", 409)?.count, 1);
  assert.equal(findRequestCounter(snapshot, "GET", "/tickets/{ticketId}/timeline", 400)?.count, 1);
  assert.equal(findRequestCounter(snapshot, "GET", "UNMATCHED", 404)?.count, 1);
  assert.equal(findRequestCounter(snapshot, "GET", "/metrics", 200)?.count, 1);

  assert.equal(findErrorCounter(snapshot, "IDEMPOTENCY_PAYLOAD_MISMATCH")?.count, 1);
  assert.equal(findErrorCounter(snapshot, "INVALID_TICKET_ID")?.count, 1);
  assert.equal(findErrorCounter(snapshot, "NOT_FOUND")?.count, 1);

  assert.equal(findTransitionCounter(snapshot, null, "NEW")?.count, 1);
  assert.equal(snapshot.counters.idempotency_replay_total, 1);
  assert.equal(snapshot.counters.idempotency_conflict_total, 1);

  const infoEntries = parseLogs(infoLogs);
  const errorEntries = parseLogs(errorLogs);

  const createLog = infoEntries.find(
    (entry) =>
      entry.endpoint === "/tickets" &&
      entry.request_id === requestId &&
      entry.status === 201 &&
      entry.replay === false,
  );
  assert.ok(createLog);
  assert.equal(createLog.correlation_id, correlationId);
  assert.equal(createLog.trace_id, traceId);
  assert.equal(createLog.actor_type, "HUMAN");
  assert.equal(createLog.actor_id, "dispatcher-story09");
  assert.equal(createLog.actor_role, "dispatcher");
  assert.equal(createLog.tool_name, "ticket.create");
  assert.equal(createLog.ticket_id, null);

  const replayLog = infoEntries.find(
    (entry) =>
      entry.endpoint === "/tickets" &&
      entry.request_id === requestId &&
      entry.status === 201 &&
      entry.replay === true,
  );
  assert.ok(replayLog);

  const conflictLog = errorEntries.find(
    (entry) =>
      entry.endpoint === "/tickets" &&
      entry.request_id === requestId &&
      entry.error_code === "IDEMPOTENCY_PAYLOAD_MISMATCH",
  );
  assert.ok(conflictLog);
  assert.equal(conflictLog.correlation_id, correlationId);
  assert.equal(conflictLog.trace_id, traceId);

  const invalidTimelineLog = errorEntries.find(
    (entry) =>
      entry.endpoint === "/tickets/{ticketId}/timeline" &&
      entry.error_code === "INVALID_TICKET_ID" &&
      entry.request_id === null,
  );
  assert.ok(invalidTimelineLog);
  assert.equal(invalidTimelineLog.correlation_id, "corr-story09-invalid");

  const notFoundLog = errorEntries.find(
    (entry) => entry.endpoint === "UNMATCHED" && entry.error_code === "NOT_FOUND",
  );
  assert.ok(notFoundLog);
  assert.equal(typeof notFoundLog.correlation_id, "string");
  assert.notEqual(notFoundLog.correlation_id.trim(), "");
});

test("traceparent header is used for trace_id and takes precedence over legacy x-trace-id", async () => {
  const traceRequestId = "91000000-0000-4000-8000-000000000002";
  const precedenceCreate = await post(
    "/tickets",
    {
      "Idempotency-Key": traceRequestId,
      "X-Actor-Id": "dispatcher-story09",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.create",
      "X-Correlation-Id": "corr-story09-traceparent-precedence",
      traceparent: traceParent,
      tracestate: "congo=t61rcWkgMzE,rojo=00f067aa0ba902b7",
      "X-Trace-Id": "legacy-trace-id-ignored",
    },
    {
      account_id: accountId,
      site_id: siteId,
      summary: "Story 09 traceparent precedence",
    },
  );
  assert.equal(precedenceCreate.status, 201);

  const infoEntries = parseLogs(infoLogs);
  const precedenceLog = infoEntries.find(
    (entry) =>
      entry.endpoint === "/tickets" &&
      entry.request_id === traceRequestId &&
      entry.status === 201 &&
      entry.replay === false,
  );
  assert.ok(precedenceLog);
  assert.equal(precedenceLog.trace_id, "4bf92f3577b34da6a3ce929d0e0e4736");
  assert.equal(precedenceLog.trace_parent, traceParent);
});
