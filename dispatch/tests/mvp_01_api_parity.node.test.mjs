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

const postgresContainer = "rd-mvp01-test";
const postgresPort = 55443;
const dispatchApiPort = 18093;
const baseUrl = `http://127.0.0.1:${dispatchApiPort}`;

const accountId = "00000000-0000-0000-0000-000000000081";
const siteId = "00000000-0000-0000-0000-000000000082";
const techId = "00000000-0000-0000-0000-000000000083";

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

async function post(pathname, headers, payload = {}) {
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
    VALUES ('${accountId}', 'MVP 01 Account');
  `);
  psql(`
    INSERT INTO sites (id, account_id, name, address1, city)
    VALUES ('${siteId}', '${accountId}', 'MVP 01 Site', '10 Main St', 'Springfield');
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

test("MVP-01 endpoint parity path succeeds end-to-end with audit/idempotency guarantees", async () => {
  const create = await post(
    "/tickets",
    {
      "Idempotency-Key": "a1000000-0000-4000-8000-000000000001",
      "X-Actor-Id": "dispatcher-mvp01",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.create",
      "X-Correlation-Id": "corr-mvp01",
    },
    {
      account_id: accountId,
      site_id: siteId,
      summary: "MVP-01 full command chain",
      description: "API parity verification",
    },
  );
  assert.equal(create.status, 201);
  const ticketId = create.body.id;

  const triage = await post(
    `/tickets/${ticketId}/triage`,
    {
      "Idempotency-Key": "a1000000-0000-4000-8000-000000000002",
      "X-Actor-Id": "dispatcher-mvp01",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.triage",
      "X-Correlation-Id": "corr-mvp01",
    },
    {
      priority: "EMERGENCY",
      incident_type: "DOOR_WONT_LATCH",
      ready_to_schedule: true,
      nte_cents: 55000,
    },
  );
  assert.equal(triage.status, 200);
  assert.equal(triage.body.state, "READY_TO_SCHEDULE");

  const proposePayload = {
    options: [
      {
        start: "2026-02-15T15:00:00.000Z",
        end: "2026-02-15T17:00:00.000Z",
      },
      {
        start: "2026-02-15T18:00:00.000Z",
        end: "2026-02-15T20:00:00.000Z",
      },
    ],
  };

  const propose = await post(
    `/tickets/${ticketId}/schedule/propose`,
    {
      "Idempotency-Key": "a1000000-0000-4000-8000-000000000003",
      "X-Actor-Id": "dispatcher-mvp01",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "schedule.propose",
      "X-Correlation-Id": "corr-mvp01",
    },
    proposePayload,
  );
  assert.equal(propose.status, 200);
  assert.equal(propose.body.state, "SCHEDULE_PROPOSED");

  const proposeReplay = await post(
    `/tickets/${ticketId}/schedule/propose`,
    {
      "Idempotency-Key": "a1000000-0000-4000-8000-000000000003",
      "X-Actor-Id": "dispatcher-mvp01",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "schedule.propose",
      "X-Correlation-Id": "corr-mvp01",
    },
    proposePayload,
  );
  assert.equal(proposeReplay.status, 200);
  assert.deepEqual(proposeReplay.body, propose.body);

  const confirm = await post(
    `/tickets/${ticketId}/schedule/confirm`,
    {
      "Idempotency-Key": "a1000000-0000-4000-8000-000000000004",
      "X-Actor-Id": "dispatcher-mvp01",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "schedule.confirm",
      "X-Correlation-Id": "corr-mvp01",
    },
    {
      start: "2026-02-15T15:00:00.000Z",
      end: "2026-02-15T17:00:00.000Z",
    },
  );
  assert.equal(confirm.status, 200);
  assert.equal(confirm.body.state, "SCHEDULED");

  const dispatch = await post(
    `/tickets/${ticketId}/assignment/dispatch`,
    {
      "Idempotency-Key": "a1000000-0000-4000-8000-000000000005",
      "X-Actor-Id": "dispatcher-mvp01",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "assignment.dispatch",
      "X-Correlation-Id": "corr-mvp01",
    },
    {
      tech_id: techId,
    },
  );
  assert.equal(dispatch.status, 200);
  assert.equal(dispatch.body.state, "DISPATCHED");

  const checkIn = await post(
    `/tickets/${ticketId}/tech/check-in`,
    {
      "Idempotency-Key": "a1000000-0000-4000-8000-000000000006",
      "X-Actor-Id": "tech-mvp01",
      "X-Actor-Role": "tech",
      "X-Tool-Name": "tech.check_in",
      "X-Correlation-Id": "corr-mvp01",
    },
    {
      timestamp: "2026-02-15T15:05:00.000Z",
      location: {
        lat: 47.61,
        lon: -122.33,
      },
    },
  );
  assert.equal(checkIn.status, 200);
  assert.equal(checkIn.body.state, "IN_PROGRESS");

  const requestChange = await post(
    `/tickets/${ticketId}/tech/request-change`,
    {
      "Idempotency-Key": "a1000000-0000-4000-8000-000000000007",
      "X-Actor-Id": "tech-mvp01",
      "X-Actor-Role": "tech",
      "X-Tool-Name": "tech.request_change",
      "X-Correlation-Id": "corr-mvp01",
    },
    {
      approval_type: "NTE_INCREASE",
      amount_delta_cents: 12000,
      reason: "Replacement closer needed",
      evidence_refs: ["evidence://onsite-findings/closer-crack"],
    },
  );
  assert.equal(requestChange.status, 200);
  assert.equal(requestChange.body.ticket.state, "APPROVAL_REQUIRED");
  assert.equal(typeof requestChange.body.approval.id, "string");

  const approve = await post(
    `/tickets/${ticketId}/approval/decide`,
    {
      "Idempotency-Key": "a1000000-0000-4000-8000-000000000008",
      "X-Actor-Id": "approver-mvp01",
      "X-Actor-Role": "approver",
      "X-Tool-Name": "approval.decide",
      "X-Correlation-Id": "corr-mvp01",
    },
    {
      approval_id: requestChange.body.approval.id,
      decision: "APPROVED",
      notes: "Approved emergency change",
    },
  );
  assert.equal(approve.status, 200);
  assert.equal(approve.body.state, "IN_PROGRESS");

  for (const [idx, evidenceKey] of [
    "photo_before_door_edge_and_strike",
    "photo_after_latched_alignment",
    "note_adjustments_and_test_cycles",
    "signature_or_no_signature_reason",
  ].entries()) {
    const evidence = await post(
      `/tickets/${ticketId}/evidence`,
      {
        "Idempotency-Key": `a1000000-0000-4000-8000-00000000001${idx + 1}`,
        "X-Actor-Id": "tech-mvp01",
        "X-Actor-Role": "tech",
        "X-Tool-Name": "closeout.add_evidence",
        "X-Correlation-Id": "corr-mvp01",
      },
      {
        kind: idx === 2 ? "NOTE" : "PHOTO",
        uri: `s3://dispatch-mvp01/${ticketId}/${evidenceKey}`,
        metadata: { evidence_key: evidenceKey },
      },
    );
    assert.equal(evidence.status, 201);
  }

  const complete = await post(
    `/tickets/${ticketId}/tech/complete`,
    {
      "Idempotency-Key": "a1000000-0000-4000-8000-000000000020",
      "X-Actor-Id": "tech-mvp01",
      "X-Actor-Role": "tech",
      "X-Tool-Name": "tech.complete",
      "X-Correlation-Id": "corr-mvp01",
    },
    {
      checklist_status: {
        work_performed: true,
        parts_used_or_needed: true,
        resolution_status: true,
        onsite_photos_after: true,
        billing_authorization: true,
      },
    },
  );
  assert.equal(complete.status, 200);
  assert.equal(complete.body.state, "COMPLETED_PENDING_VERIFICATION");

  const verify = await post(
    `/tickets/${ticketId}/qa/verify`,
    {
      "Idempotency-Key": "a1000000-0000-4000-8000-000000000021",
      "X-Actor-Id": "qa-mvp01",
      "X-Actor-Role": "qa",
      "X-Tool-Name": "qa.verify",
      "X-Correlation-Id": "corr-mvp01",
    },
    {
      timestamp: "2026-02-15T17:35:00.000Z",
      result: "PASS",
      notes: "Verified work package",
    },
  );
  assert.equal(verify.status, 200);
  assert.equal(verify.body.state, "VERIFIED");

  const invoice = await post(
    `/tickets/${ticketId}/billing/generate-invoice`,
    {
      "Idempotency-Key": "a1000000-0000-4000-8000-000000000022",
      "X-Actor-Id": "finance-mvp01",
      "X-Actor-Role": "finance",
      "X-Tool-Name": "billing.generate_invoice",
      "X-Correlation-Id": "corr-mvp01",
    },
    {},
  );
  assert.equal(invoice.status, 200);
  assert.equal(invoice.body.state, "INVOICED");

  const ticket = await get(`/tickets/${ticketId}`);
  assert.equal(ticket.status, 200);
  assert.equal(ticket.body.id, ticketId);
  assert.equal(ticket.body.state, "INVOICED");

  const invalidTicket = await get("/tickets/not-a-uuid");
  assert.equal(invalidTicket.status, 400);
  assert.equal(invalidTicket.body.error.code, "INVALID_TICKET_ID");

  const approvalStatus = psql(`
    SELECT status::text
    FROM approvals
    WHERE id = '${requestChange.body.approval.id}'
      AND ticket_id = '${ticketId}';
  `);
  assert.equal(approvalStatus, "APPROVED");

  const transitionCounts = psql(`
    SELECT from_state::text || '->' || to_state::text || ':' || count(*)::text
    FROM ticket_state_transitions
    WHERE ticket_id = '${ticketId}'
      AND (
        (from_state = 'DISPATCHED' AND to_state = 'ON_SITE')
        OR (from_state = 'ON_SITE' AND to_state = 'IN_PROGRESS')
      )
    GROUP BY from_state, to_state
    ORDER BY from_state, to_state;
  `)
    .split("\n")
    .filter(Boolean);

  assert.deepEqual(transitionCounts, [
    "DISPATCHED->ON_SITE:1",
    "ON_SITE->IN_PROGRESS:1",
  ]);

  const timeline = await get(`/tickets/${ticketId}/timeline`);
  assert.equal(timeline.status, 200);
  assert.equal(Array.isArray(timeline.body.events), true);
  assert.equal(timeline.body.events.length >= 12, true);

  const toolNames = timeline.body.events.map((event) => event.tool_name);
  for (const expectedTool of [
    "ticket.create",
    "ticket.triage",
    "schedule.propose",
    "schedule.confirm",
    "assignment.dispatch",
    "tech.check_in",
    "tech.request_change",
    "approval.decide",
    "tech.complete",
    "qa.verify",
    "billing.generate_invoice",
  ]) {
    assert.equal(toolNames.includes(expectedTool), true, `timeline missing tool ${expectedTool}`);
  }

  const scheduleProposeTransitionCount = Number(
    psql(`
      SELECT count(*)
      FROM ticket_state_transitions
      WHERE ticket_id = '${ticketId}'
        AND from_state = 'READY_TO_SCHEDULE'
        AND to_state = 'SCHEDULE_PROPOSED';
    `),
  );
  assert.equal(scheduleProposeTransitionCount, 1);
});
