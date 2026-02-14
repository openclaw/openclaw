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

const postgresContainer = "rd-story07-test";
const postgresPort = 55440;
const dispatchApiPort = 18090;
const baseUrl = `http://127.0.0.1:${dispatchApiPort}`;

const accountId = "00000000-0000-0000-0000-000000000051";
const siteId = "00000000-0000-0000-0000-000000000052";
const techId = "00000000-0000-0000-0000-000000000053";

let app;
let requestCounter = 1;

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

function evidenceReadHeaders(correlationId) {
  return {
    "X-Actor-Id": "tech-story07",
    "X-Actor-Role": "tech",
    "X-Tool-Name": "closeout.list_evidence",
    "X-Correlation-Id": correlationId,
  };
}

function nextRequestId() {
  const suffix = String(requestCounter).padStart(12, "0");
  requestCounter += 1;
  return `71000000-0000-4000-8000-${suffix}`;
}

function assertOrderedByCreatedAtThenId(items, label) {
  for (let i = 0; i < items.length - 1; i += 1) {
    const current = items[i];
    const next = items[i + 1];
    const currentAt = Date.parse(current.created_at);
    const nextAt = Date.parse(next.created_at);

    assert.ok(Number.isFinite(currentAt), `${label}: created_at must be parseable`);
    assert.ok(Number.isFinite(nextAt), `${label}: created_at must be parseable`);
    assert.ok(currentAt <= nextAt, `${label}: ordering must be created_at ASC`);

    if (currentAt === nextAt) {
      assert.ok(current.id <= next.id, `${label}: tie-breaker must be id ASC`);
    }
  }
}

async function createInProgressTicket(summary, incidentType = "DOOR_WONT_LATCH") {
  const create = await post(
    "/tickets",
    {
      "Idempotency-Key": nextRequestId(),
      "X-Actor-Id": "dispatcher-story07",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.create",
      "X-Correlation-Id": `corr-story07-create-${requestCounter}`,
    },
    {
      account_id: accountId,
      site_id: siteId,
      summary,
    },
  );
  assert.equal(create.status, 201);
  const ticketId = create.body.id;

  const triage = await post(
    `/tickets/${ticketId}/triage`,
    {
      "Idempotency-Key": nextRequestId(),
      "X-Actor-Id": "dispatcher-story07",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.triage",
      "X-Correlation-Id": `corr-story07-triage-${requestCounter}`,
    },
    {
      priority: "URGENT",
      incident_type: incidentType,
    },
  );
  assert.equal(triage.status, 200);

  const dispatch = await post(
    `/tickets/${ticketId}/assignment/dispatch`,
    {
      "Idempotency-Key": nextRequestId(),
      "X-Actor-Id": "dispatcher-story07",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "assignment.dispatch",
      "X-Correlation-Id": `corr-story07-dispatch-${requestCounter}`,
    },
    {
      tech_id: techId,
      dispatch_mode: "EMERGENCY_BYPASS",
    },
  );
  assert.equal(dispatch.status, 200);

  psql(`
    UPDATE tickets
    SET state = 'IN_PROGRESS', version = version + 1
    WHERE id = '${ticketId}';
  `);

  return ticketId;
}

async function addEvidence(ticketId, evidenceKey, index) {
  return post(
    `/tickets/${ticketId}/evidence`,
    {
      "Idempotency-Key": nextRequestId(),
      "X-Actor-Id": "tech-story07",
      "X-Actor-Role": "tech",
      "X-Tool-Name": "closeout.add_evidence",
      "X-Correlation-Id": `corr-story07-evidence-${index}`,
    },
    {
      kind: "PHOTO",
      uri: `s3://dispatch-evidence/${ticketId}/${index}.jpg`,
      metadata: {
        evidence_key: evidenceKey,
        source: "story_07_test",
      },
    },
  );
}

async function completeTicket(ticketId, checklistStatus, options = {}) {
  const payload = {
    checklist_status: checklistStatus,
  };
  if (typeof options.no_signature_reason === "string" && options.no_signature_reason.trim() !== "") {
    payload.no_signature_reason = options.no_signature_reason.trim();
  }
  if (Array.isArray(options.evidence_refs)) {
    payload.evidence_refs = options.evidence_refs;
  }
  return post(
    `/tickets/${ticketId}/tech/complete`,
    {
      "Idempotency-Key": nextRequestId(),
      "X-Actor-Id": "tech-story07",
      "X-Actor-Role": "tech",
      "X-Tool-Name": "tech.complete",
      "X-Correlation-Id": `corr-story07-complete-${requestCounter}`,
    },
    payload,
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

  psql(`
    INSERT INTO accounts (id, name)
    VALUES ('${accountId}', 'Story 07 Account');
  `);
  psql(`
    INSERT INTO sites (id, account_id, name, address1, city)
    VALUES ('${siteId}', '${accountId}', 'Story 07 Site', '7 Main St', 'Springfield');
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

test("evidence can be attached/listed deterministically and writes audit events", async () => {
  const ticketId = await createInProgressTicket("Story 07 evidence list ticket");

  const firstEvidence = await addEvidence(ticketId, "photo_before_door_edge_and_strike", 1);
  assert.equal(firstEvidence.status, 201);

  const secondEvidence = await addEvidence(ticketId, "photo_after_latched_alignment", 2);
  assert.equal(secondEvidence.status, 201);

  const listed = await get(
    `/tickets/${ticketId}/evidence`,
    evidenceReadHeaders("corr-story07-evidence-list"),
  );
  assert.equal(listed.status, 200);
  assert.equal(listed.body.ticket_id, ticketId);
  assert.equal(Array.isArray(listed.body.evidence), true);
  assert.equal(listed.body.evidence.length, 2);

  assertOrderedByCreatedAtThenId(listed.body.evidence, "evidence list");

  const requiredKeys = [
    "id",
    "ticket_id",
    "kind",
    "uri",
    "checksum",
    "metadata",
    "created_by",
    "created_at",
  ];

  for (const item of listed.body.evidence) {
    for (const key of requiredKeys) {
      assert.ok(Object.prototype.hasOwnProperty.call(item, key), `missing evidence key ${key}`);
    }
    assert.equal(item.ticket_id, ticketId);
    assert.equal(item.kind, "PHOTO");
    assert.equal(typeof item.uri, "string");
    assert.match(item.uri, /^s3:\/\//);
    assert.equal(typeof item.metadata, "object");
    assert.equal(typeof item.metadata.evidence_key, "string");
    assert.equal(item.created_by, "tech-story07");
  }

  const evidenceAuditCount = Number(
    psql(`
      SELECT count(*)
      FROM audit_events
      WHERE ticket_id = '${ticketId}'
        AND tool_name = 'closeout.add_evidence';
    `),
  );
  assert.equal(evidenceAuditCount, 2);
});

test("tech.complete fails closed when required evidence keys are missing", async () => {
  const ticketId = await createInProgressTicket("Story 07 missing evidence ticket");

  const firstEvidence = await addEvidence(ticketId, "photo_before_door_edge_and_strike", 11);
  assert.equal(firstEvidence.status, 201);

  const secondEvidence = await addEvidence(ticketId, "photo_after_latched_alignment", 12);
  assert.equal(secondEvidence.status, 201);

  const complete = await completeTicket(
    ticketId,
    {
      work_performed: true,
      parts_used_or_needed: true,
      resolution_status: true,
      onsite_photos_after: true,
      billing_authorization: true,
    },
    {
      no_signature_reason: "Customer unavailable at time of completion",
    },
  );

  assert.equal(complete.status, 409);
  assert.equal(complete.body.error.code, "CLOSEOUT_REQUIREMENTS_INCOMPLETE");
  assert.equal(complete.body.error.requirement_code, "MISSING_EVIDENCE");
  assert.deepEqual(complete.body.error.missing_evidence_keys, ["note_adjustments_and_test_cycles"]);
  assert.deepEqual(complete.body.error.missing_checklist_keys, []);

  assert.equal(psql(`SELECT state FROM tickets WHERE id = '${ticketId}';`), "IN_PROGRESS");

  const completedTransitionCount = Number(
    psql(`
      SELECT count(*)
      FROM ticket_state_transitions
      WHERE ticket_id = '${ticketId}'
        AND to_state = 'COMPLETED_PENDING_VERIFICATION';
    `),
  );
  assert.equal(completedTransitionCount, 0);
});

test("tech.complete succeeds when persisted evidence and checklist are complete", async () => {
  const ticketId = await createInProgressTicket("Story 07 completion success ticket");

  for (const [index, evidenceKey] of [
    "photo_before_door_edge_and_strike",
    "photo_after_latched_alignment",
    "note_adjustments_and_test_cycles",
    "signature_or_no_signature_reason",
  ].entries()) {
    const response = await addEvidence(ticketId, evidenceKey, 20 + index);
    assert.equal(response.status, 201);
  }

  const complete = await completeTicket(ticketId, {
    work_performed: true,
    parts_used_or_needed: true,
    resolution_status: true,
    onsite_photos_after: true,
    billing_authorization: true,
  });

  assert.equal(complete.status, 200);
  assert.equal(complete.body.id, ticketId);
  assert.equal(complete.body.state, "COMPLETED_PENDING_VERIFICATION");

  const completedTransitionCount = Number(
    psql(`
      SELECT count(*)
      FROM ticket_state_transitions
      WHERE ticket_id = '${ticketId}'
        AND from_state = 'IN_PROGRESS'
        AND to_state = 'COMPLETED_PENDING_VERIFICATION';
    `),
  );
  assert.equal(completedTransitionCount, 1);

  const completeAudit = psql(`
    SELECT tool_name, before_state::text, after_state::text
    FROM audit_events
    WHERE ticket_id = '${ticketId}'
      AND tool_name = 'tech.complete'
    ORDER BY created_at DESC, id DESC
    LIMIT 1;
  `).split("|");

  assert.deepEqual(completeAudit, ["tech.complete", "IN_PROGRESS", "COMPLETED_PENDING_VERIFICATION"]);
});

test("evidence list rejects invalid ticket id format", async () => {
  const listed = await get(
    "/tickets/not-a-uuid/evidence",
    evidenceReadHeaders("corr-story07-evidence-list-400"),
  );
  assert.equal(listed.status, 400);
  assert.equal(listed.body.error.code, "INVALID_TICKET_ID");
});

test("evidence list returns 404 for unknown ticket id", async () => {
  const listed = await get(
    "/tickets/ffffffff-ffff-4fff-8fff-ffffffffffff/evidence",
    evidenceReadHeaders("corr-story07-evidence-list-404"),
  );
  assert.equal(listed.status, 404);
  assert.equal(listed.body.error.code, "TICKET_NOT_FOUND");
});
