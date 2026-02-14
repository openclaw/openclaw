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

const postgresContainer = "rd-story-glz01-test";
const postgresPort = 55449;
const dispatchApiPort = 18100;
const baseUrl = `http://127.0.0.1:${dispatchApiPort}`;
const accountId = "00000000-0000-0000-0000-000000001111";
const siteId = "00000000-0000-0000-0000-000000001122";

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
    VALUES ('${accountId}', 'Blind Intake Account');
  `);
  psql(`
    INSERT INTO sites (id, account_id, name, address1, city)
    VALUES ('${siteId}', '${accountId}', 'Blind Intake Site', '123 Intake Way', 'Springfield');
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

test("blind intake persists triaged tickets when policy thresholds are not met", async () => {
  const response = await post(
    "/tickets/intake",
    {
      "Idempotency-Key": "b1d7c6a0-0000-4000-8000-111111111111",
      "X-Actor-Id": "dispatcher-blind-1",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.blind_intake",
    },
    {
      account_id: accountId,
      site_id: siteId,
      customer_name: "Jordan Sample",
      contact_phone: "+1 (555) 010-1234",
      summary: "Kitchen panel loose latch",
      incident_type: "DOOR_PANEL_FAILURE",
      description: "Customer says exterior latch is intermittently loose.",
      priority: "URGENT",
      identity_confidence: 75,
      classification_confidence: 72,
      sop_handoff_acknowledged: false,
    },
  );

  assert.equal(response.status, 201);
  assert.equal(response.body.state, "TRIAGED");
  assert.equal(response.body.customer_name, "Jordan Sample");
  assert.equal(response.body.customer_phone, "15550101234");
  assert.equal(response.body.sop_handoff_required, true);
  assert.equal(response.body.sop_handoff_acknowledged, false);
  assert.equal(typeof response.body.identity_signature, "string");
  assert.equal(response.body.identity_confidence, 75);
  assert.equal(response.body.classification_confidence, 72);
  assert.equal(typeof response.body.sop_handoff_prompt, "string");

  const ticketId = response.body.id;
  const transitionCount = Number(
    psql(`SELECT count(*) FROM ticket_state_transitions WHERE ticket_id = '${ticketId}';`),
  );
  assert.equal(transitionCount, 1);
});

test("blind intake creates READY_TO_SCHEDULE when all policy gates pass", async () => {
  const response = await post(
    "/tickets/intake",
    {
      "Idempotency-Key": "b1d7c6a0-0000-4000-8000-111111111112",
      "X-Actor-Id": "dispatcher-blind-2",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.blind_intake",
    },
    {
      account_id: accountId,
      site_id: siteId,
      customer_name: "Taylor High",
      contact_phone: "(555) 555-0199",
      contact_email: "taylor@example.com",
      summary: "Sliding glass door rattling",
      incident_type: "GLAZING_MAINTENANCE",
      description: "Vibration noise during wind events.",
      priority: "ROUTINE",
      identity_confidence: 98,
      classification_confidence: 97,
      sop_handoff_acknowledged: true,
    },
  );

  assert.equal(response.status, 201);
  assert.equal(response.body.state, "READY_TO_SCHEDULE");
  assert.equal(response.body.sop_handoff_required, false);
  assert.equal(response.body.sop_handoff_acknowledged, true);
  assert.equal(response.body.sop_handoff_prompt, null);
});

test("blind intake returns deterministic duplicate error inside policy window", async () => {
  const first = await post(
    "/tickets/intake",
    {
      "Idempotency-Key": "b1d7c6a0-0000-4000-8000-111111111113",
      "X-Actor-Id": "dispatcher-blind-3",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.blind_intake",
    },
    {
      account_id: accountId,
      site_id: siteId,
      customer_name: "Morgan Repeat",
      contact_email: "repeat@example.com",
      summary: "Repeatable blind intake check",
      incident_type: "WINDOW_GLAZING",
      description: "First request should be unique.",
      priority: "ROUTINE",
      identity_confidence: 99,
      classification_confidence: 99,
      sop_handoff_acknowledged: true,
    },
  );

  assert.equal(first.status, 201);

  const duplicate = await post(
    "/tickets/intake",
    {
      "Idempotency-Key": "b1d7c6a0-0000-4000-8000-111111111114",
      "X-Actor-Id": "dispatcher-blind-4",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.blind_intake",
    },
    {
      account_id: accountId,
      site_id: siteId,
      customer_name: "Morgan Repeat",
      contact_email: "repeat@example.com",
      summary: "Repeatable blind intake check",
      incident_type: "WINDOW_GLAZING",
      description: "Second request should dedupe.",
      priority: "ROUTINE",
      identity_confidence: 99,
      classification_confidence: 99,
      sop_handoff_acknowledged: true,
    },
  );

  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, "DUPLICATE_INTAKE");
  assert.equal(duplicate.body.error.duplicate_ticket_id, first.body.id);

  const count = Number(
    psql(`
      SELECT count(*) FROM tickets
      WHERE identity_signature = '${first.body.identity_signature}'
    `),
  );
  assert.equal(count, 1);
});

test("triage to READY_TO_SCHEDULE enforces blind-intake policy before scheduling", async () => {
  const intake = await post(
    "/tickets/intake",
    {
      "Idempotency-Key": "b1d7c6a0-0000-4000-8000-111111111115",
      "X-Actor-Id": "dispatcher-blind-5",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.blind_intake",
    },
    {
      account_id: accountId,
      site_id: siteId,
      customer_name: "Pat Policy",
      contact_phone: "555-010-9999",
      summary: "Need triage policy check",
      incident_type: "GLAZING_MAINTENANCE",
      description: "Needs manual confirmation.",
      priority: "URGENT",
      identity_confidence: 20,
      classification_confidence: 20,
      sop_handoff_acknowledged: false,
    },
  );

  assert.equal(intake.status, 201);
  const ticketId = intake.body.id;
  const triage = await post(
    `/tickets/${ticketId}/triage`,
    {
      "Idempotency-Key": "b1d7c6a0-0000-4000-8000-111111111116",
      "X-Actor-Id": "dispatcher-blind-5",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.triage",
    },
    {
      priority: "EMERGENCY",
      incident_type: "GLAZING_MAINTENANCE",
      workflow_outcome: "READY_TO_SCHEDULE",
      sop_handoff_acknowledged: false,
    },
  );

  assert.equal(triage.status, 409);
  assert.equal(triage.body.error.code, "LOW_IDENTITY_CONFIDENCE");

  const updatedState = psql(`SELECT state FROM tickets WHERE id = '${ticketId}';`);
  assert.equal(updatedState, "TRIAGED");
});
