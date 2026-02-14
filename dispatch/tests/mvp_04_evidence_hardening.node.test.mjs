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

const postgresContainer = "rd-mvp04-test";
const postgresPort = 55445;
const dispatchApiPort = 18095;
const baseUrl = `http://127.0.0.1:${dispatchApiPort}`;

const accountId = "00000000-0000-0000-0000-000000000101";
const siteId = "00000000-0000-0000-0000-000000000102";
const techId = "00000000-0000-0000-0000-000000000103";

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

function nextRequestId() {
  const suffix = String(requestCounter).padStart(12, "0");
  requestCounter += 1;
  return `84000000-0000-4000-8000-${suffix}`;
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

async function createInProgressTicket(summary) {
  const create = await post(
    "/tickets",
    {
      "Idempotency-Key": nextRequestId(),
      "X-Actor-Id": "dispatcher-mvp04",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.create",
      "X-Correlation-Id": "corr-mvp04-create",
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
      "X-Actor-Id": "dispatcher-mvp04",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "ticket.triage",
      "X-Correlation-Id": "corr-mvp04-triage",
    },
    {
      priority: "URGENT",
      incident_type: "DOOR_WONT_LATCH",
    },
  );
  assert.equal(triage.status, 200);

  const dispatch = await post(
    `/tickets/${ticketId}/assignment/dispatch`,
    {
      "Idempotency-Key": nextRequestId(),
      "X-Actor-Id": "dispatcher-mvp04",
      "X-Actor-Role": "dispatcher",
      "X-Tool-Name": "assignment.dispatch",
      "X-Correlation-Id": "corr-mvp04-dispatch",
    },
    {
      tech_id: techId,
      dispatch_mode: "EMERGENCY_BYPASS",
    },
  );
  assert.equal(dispatch.status, 200);

  const checkIn = await post(
    `/tickets/${ticketId}/tech/check-in`,
    {
      "Idempotency-Key": nextRequestId(),
      "X-Actor-Id": "tech-mvp04",
      "X-Actor-Role": "tech",
      "X-Tool-Name": "tech.check_in",
      "X-Correlation-Id": "corr-mvp04-checkin",
    },
    {
      timestamp: "2026-02-16T16:00:00.000Z",
      location: {
        lat: 37.777,
        lng: -122.416,
      },
    },
  );
  assert.equal(checkIn.status, 200);
  assert.equal(checkIn.body.state, "IN_PROGRESS");

  return ticketId;
}

async function addEvidence(ticketId, evidenceKey, uri, kind = "PHOTO") {
  const response = await post(
    `/tickets/${ticketId}/evidence`,
    {
      "Idempotency-Key": nextRequestId(),
      "X-Actor-Id": "tech-mvp04",
      "X-Actor-Role": "tech",
      "X-Tool-Name": "closeout.add_evidence",
      "X-Correlation-Id": "corr-mvp04-evidence",
    },
    {
      kind,
      uri,
      metadata: {
        evidence_key: evidenceKey,
        source: "mvp_04_test",
      },
    },
  );
  assert.equal(response.status, 201);
  return response.body;
}

async function completeTicket(ticketId, options = {}) {
  const payload = {
    checklist_status: {
      work_performed: true,
      parts_used_or_needed: true,
      resolution_status: true,
      onsite_photos_after: true,
      billing_authorization: true,
    },
  };
  if (typeof options.noSignatureReason === "string" && options.noSignatureReason.trim() !== "") {
    payload.no_signature_reason = options.noSignatureReason.trim();
  }
  if (Array.isArray(options.evidenceRefs)) {
    payload.evidence_refs = options.evidenceRefs;
  }

  return post(
    `/tickets/${ticketId}/tech/complete`,
    {
      "Idempotency-Key": nextRequestId(),
      "X-Actor-Id": "tech-mvp04",
      "X-Actor-Role": "tech",
      "X-Tool-Name": "tech.complete",
      "X-Correlation-Id": "corr-mvp04-complete",
    },
    payload,
  );
}

async function verifyTicket(ticketId) {
  return post(
    `/tickets/${ticketId}/qa/verify`,
    {
      "Idempotency-Key": nextRequestId(),
      "X-Actor-Id": "qa-mvp04",
      "X-Actor-Role": "qa",
      "X-Tool-Name": "qa.verify",
      "X-Correlation-Id": "corr-mvp04-verify",
    },
    {
      timestamp: "2026-02-16T17:00:00.000Z",
      result: "PASS",
      notes: "QA verification for MVP-04",
    },
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
    VALUES ('${accountId}', 'MVP 04 Account');
  `);
  psql(`
    INSERT INTO sites (id, account_id, name, address1, city)
    VALUES ('${siteId}', '${accountId}', 'MVP 04 Site', '104 Main St', 'Springfield');
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

test("tech.complete fails closed when signature and no-signature reason are both absent", async () => {
  const ticketId = await createInProgressTicket("MVP-04 missing signature gate");

  await addEvidence(
    ticketId,
    "photo_before_door_edge_and_strike",
    `s3://dispatch-mvp04/${ticketId}/photo-before.jpg`,
  );
  await addEvidence(
    ticketId,
    "photo_after_latched_alignment",
    `s3://dispatch-mvp04/${ticketId}/photo-after.jpg`,
  );
  await addEvidence(
    ticketId,
    "note_adjustments_and_test_cycles",
    `s3://dispatch-mvp04/${ticketId}/note.txt`,
    "NOTE",
  );

  const complete = await completeTicket(ticketId);
  assert.equal(complete.status, 409);
  assert.equal(complete.body.error.code, "CLOSEOUT_REQUIREMENTS_INCOMPLETE");
  assert.equal(complete.body.error.requirement_code, "MISSING_SIGNATURE_CONFIRMATION");
  assert.deepEqual(complete.body.error.missing_evidence_keys, ["signature_or_no_signature_reason"]);
});

test("tech.complete accepts explicit no_signature_reason when signature evidence is absent", async () => {
  const ticketId = await createInProgressTicket("MVP-04 no-signature reason path");

  await addEvidence(
    ticketId,
    "photo_before_door_edge_and_strike",
    `s3://dispatch-mvp04/${ticketId}/photo-before.jpg`,
  );
  await addEvidence(
    ticketId,
    "photo_after_latched_alignment",
    `s3://dispatch-mvp04/${ticketId}/photo-after.jpg`,
  );
  await addEvidence(
    ticketId,
    "note_adjustments_and_test_cycles",
    `s3://dispatch-mvp04/${ticketId}/note.txt`,
    "NOTE",
  );

  const complete = await completeTicket(ticketId, {
    noSignatureReason: "Customer unavailable for signature after documented contact attempts",
  });
  assert.equal(complete.status, 200);
  assert.equal(complete.body.state, "COMPLETED_PENDING_VERIFICATION");
});

test("tech.complete fails closed for non-object-store evidence references", async () => {
  const ticketId = await createInProgressTicket("MVP-04 invalid evidence reference on complete");

  await addEvidence(
    ticketId,
    "photo_before_door_edge_and_strike",
    `s3://dispatch-mvp04/${ticketId}/photo-before.jpg`,
  );
  await addEvidence(
    ticketId,
    "photo_after_latched_alignment",
    `s3://dispatch-mvp04/${ticketId}/photo-after.jpg`,
  );
  await addEvidence(
    ticketId,
    "note_adjustments_and_test_cycles",
    "file:///tmp/not-object-store.txt",
    "NOTE",
  );
  await addEvidence(
    ticketId,
    "signature_or_no_signature_reason",
    `s3://dispatch-mvp04/${ticketId}/signature.txt`,
    "SIGNATURE",
  );

  const complete = await completeTicket(ticketId);
  assert.equal(complete.status, 409);
  assert.equal(complete.body.error.code, "CLOSEOUT_REQUIREMENTS_INCOMPLETE");
  assert.equal(complete.body.error.requirement_code, "INVALID_EVIDENCE_REFERENCE");
  assert.deepEqual(complete.body.error.invalid_evidence_refs, ["file:///tmp/not-object-store.txt"]);
});

test("qa.verify re-validates references and fails closed when evidence URI becomes invalid", async () => {
  const ticketId = await createInProgressTicket("MVP-04 invalid evidence reference on verify");

  await addEvidence(
    ticketId,
    "photo_before_door_edge_and_strike",
    `s3://dispatch-mvp04/${ticketId}/photo-before.jpg`,
  );
  await addEvidence(
    ticketId,
    "photo_after_latched_alignment",
    `s3://dispatch-mvp04/${ticketId}/photo-after.jpg`,
  );
  await addEvidence(
    ticketId,
    "note_adjustments_and_test_cycles",
    `s3://dispatch-mvp04/${ticketId}/note.txt`,
    "NOTE",
  );
  await addEvidence(
    ticketId,
    "signature_or_no_signature_reason",
    `s3://dispatch-mvp04/${ticketId}/signature.txt`,
    "SIGNATURE",
  );

  const complete = await completeTicket(ticketId);
  assert.equal(complete.status, 200);
  assert.equal(complete.body.state, "COMPLETED_PENDING_VERIFICATION");

  psql(`
    UPDATE evidence_items
    SET uri = 'https://example.com/not-object-store'
    WHERE ticket_id = '${ticketId}'
      AND metadata->>'evidence_key' = 'note_adjustments_and_test_cycles';
  `);

  const verify = await verifyTicket(ticketId);
  assert.equal(verify.status, 409);
  assert.equal(verify.body.error.code, "CLOSEOUT_REQUIREMENTS_INCOMPLETE");
  assert.equal(verify.body.error.requirement_code, "INVALID_EVIDENCE_REFERENCE");
  assert.deepEqual(verify.body.error.invalid_evidence_refs, ["https://example.com/not-object-store"]);
  assert.equal(
    psql(`SELECT state FROM tickets WHERE id = '${ticketId}';`),
    "COMPLETED_PENDING_VERIFICATION",
  );
});
