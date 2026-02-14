import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { closePool } from "../api/src/db.mjs";
import { startDispatchApi } from "../api/src/server.mjs";
import {
  DISPATCH_COMMAND_ENDPOINT_POLICIES,
  DISPATCH_TOOL_POLICIES,
} from "../shared/authorization-policy.mjs";
import { TOOL_SPECS } from "../tools-plugin/src/bridge.mjs";

const repoRoot = process.cwd();
const migrationSql = fs.readFileSync(
  path.resolve(repoRoot, "dispatch/db/migrations/001_init.sql"),
  "utf8",
);

const postgresContainer = "rd-story05-test";
const postgresPort = 55439;
const dispatchApiPort = 18089;
const baseUrl = `http://127.0.0.1:${dispatchApiPort}`;

const accountId = "00000000-0000-0000-0000-000000000041";
const siteId = "00000000-0000-0000-0000-000000000042";
const techId = "00000000-0000-0000-0000-000000000043";

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
    VALUES ('${accountId}', 'Story 05 Account');
  `);
  psql(`
    INSERT INTO sites (id, account_id, name, address1, city)
    VALUES ('${siteId}', '${accountId}', 'Story 05 Site', '5 Main St', 'Springfield');
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

test("server rejects tool mismatch for endpoint fail closed", async () => {
  const validDefaultToolCall = await post(
    "/tickets",
    {
      "Idempotency-Key": "41000000-0000-4000-8000-000000000001",
      "X-Actor-Id": "dispatcher-auth-1",
      "X-Actor-Role": "dispatcher",
    },
    {
      account_id: accountId,
      site_id: siteId,
      summary: "Story 05 default tool behavior",
    },
  );

  assert.equal(validDefaultToolCall.status, 201);

  const mismatchedToolCall = await post(
    "/tickets",
    {
      "Idempotency-Key": "41000000-0000-4000-8000-000000000002",
      "X-Actor-Id": "dispatcher-auth-1",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "schedule.confirm",
    },
    {
      account_id: accountId,
      site_id: siteId,
      summary: "Story 05 should be blocked by tool mismatch",
    },
  );

  assert.equal(mismatchedToolCall.status, 403);
  assert.equal(mismatchedToolCall.body.error.code, "TOOL_NOT_ALLOWED");

  const blockedSummaryCount = Number(
    psql("SELECT count(*) FROM tickets WHERE summary = 'Story 05 should be blocked by tool mismatch';"),
  );
  assert.equal(blockedSummaryCount, 0);
});

test("server rejects forbidden role and preserves ticket state", async () => {
  const create = await post(
    "/tickets",
    {
      "Idempotency-Key": "41000000-0000-4000-8000-000000000003",
      "X-Actor-Id": "dispatcher-auth-2",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.create",
    },
    {
      account_id: accountId,
      site_id: siteId,
      summary: "Story 05 role guard ticket",
    },
  );

  assert.equal(create.status, 201);
  const ticketId = create.body.id;

  const forbiddenTriage = await post(
    `/tickets/${ticketId}/triage`,
    {
      "Idempotency-Key": "41000000-0000-4000-8000-000000000004",
      "X-Actor-Id": "customer-auth-1",
      "X-Actor-Role": "customer",
      "X-Tool-Name": "ticket.triage",
    },
    {
      priority: "URGENT",
      incident_type: "AUTH_ROLE_GUARD",
    },
  );

  assert.equal(forbiddenTriage.status, 403);
  assert.equal(forbiddenTriage.body.error.code, "FORBIDDEN");
  assert.equal(psql(`SELECT state FROM tickets WHERE id = '${ticketId}';`), "NEW");

  const auditCount = Number(psql(`SELECT count(*) FROM audit_events WHERE ticket_id = '${ticketId}';`));
  assert.equal(auditCount, 1);
});

test("server rejects invalid state context deterministically", async () => {
  const create = await post(
    "/tickets",
    {
      "Idempotency-Key": "41000000-0000-4000-8000-000000000005",
      "X-Actor-Id": "dispatcher-auth-3",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.create",
    },
    {
      account_id: accountId,
      site_id: siteId,
      summary: "Story 05 state guard ticket",
    },
  );

  assert.equal(create.status, 201);
  const ticketId = create.body.id;

  const invalidDispatch = await post(
    `/tickets/${ticketId}/assignment/dispatch`,
    {
      "Idempotency-Key": "41000000-0000-4000-8000-000000000006",
      "X-Actor-Id": "dispatcher-auth-3",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "assignment.dispatch",
    },
    {
      tech_id: techId,
      dispatch_mode: "EMERGENCY_BYPASS",
    },
  );

  assert.equal(invalidDispatch.status, 409);
  assert.equal(invalidDispatch.body.error.code, "INVALID_STATE_TRANSITION");
  assert.equal(invalidDispatch.body.error.from_state, "NEW");
  assert.equal(invalidDispatch.body.error.to_state, "DISPATCHED");

  const auditCount = Number(psql(`SELECT count(*) FROM audit_events WHERE ticket_id = '${ticketId}';`));
  assert.equal(auditCount, 1);
});

test("bridge and api policy maps remain synchronized", () => {
  const sharedToolNames = Object.keys(DISPATCH_TOOL_POLICIES).sort();
  const bridgeToolNames = Object.keys(TOOL_SPECS).sort();
  assert.deepEqual(bridgeToolNames, sharedToolNames);

  for (const toolName of sharedToolNames) {
    const shared = DISPATCH_TOOL_POLICIES[toolName];
    const bridge = TOOL_SPECS[toolName];
    assert.equal(bridge.endpoint, shared.endpoint);
    assert.equal(bridge.method, shared.method);
    assert.deepEqual(bridge.allowed_roles, shared.allowed_roles);
    assert.equal(bridge.mutating, shared.mutating);
  }

  for (const endpointPolicy of Object.values(DISPATCH_COMMAND_ENDPOINT_POLICIES)) {
    for (const toolName of endpointPolicy.allowed_tool_names) {
      const toolPolicy = DISPATCH_TOOL_POLICIES[toolName];
      assert.ok(toolPolicy);
      assert.equal(toolPolicy.endpoint, endpointPolicy.endpoint);
      assert.equal(toolPolicy.method, endpointPolicy.method);
    }
  }
});
