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

const postgresContainer = "rd-story08-test";
const postgresPort = 55442;
const dispatchApiPort = 18092;
const dispatchApiBaseUrl = `http://127.0.0.1:${dispatchApiPort}`;

const accountId = "00000000-0000-0000-0000-000000000071";
const siteId = "00000000-0000-0000-0000-000000000072";
const techId = "00000000-0000-0000-0000-000000000073";

const correlationId = "corr-story08-emergency-chain";
const requestIds = {
  create: "81000000-0000-4000-8000-000000000001",
  triage: "81000000-0000-4000-8000-000000000002",
  dispatch: "81000000-0000-4000-8000-000000000003",
  checkIn: "81000000-0000-4000-8000-000000000010",
  completeFail: "81000000-0000-4000-8000-000000000004",
  evidence1: "81000000-0000-4000-8000-000000000005",
  evidence2: "81000000-0000-4000-8000-000000000006",
  evidence3: "81000000-0000-4000-8000-000000000007",
  evidence4: "81000000-0000-4000-8000-000000000008",
  completeSuccess: "81000000-0000-4000-8000-000000000009",
  verify: "81000000-0000-4000-8000-000000000011",
  invoice: "81000000-0000-4000-8000-000000000012",
};

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

function assertOrderedByCreatedAtAndId(events) {
  for (let i = 0; i < events.length - 1; i += 1) {
    const current = events[i];
    const next = events[i + 1];
    const currentAt = Date.parse(current.created_at);
    const nextAt = Date.parse(next.created_at);

    assert.ok(Number.isFinite(currentAt), "timeline created_at must be parseable");
    assert.ok(Number.isFinite(nextAt), "timeline created_at must be parseable");
    assert.ok(currentAt <= nextAt, "timeline must be sorted by created_at ASC");

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
    VALUES ('${accountId}', 'Story 08 Account');
  `);
  psql(`
    INSERT INTO sites (id, account_id, name, address1, city)
    VALUES ('${siteId}', '${accountId}', 'Story 08 Site', '8 Main St', 'Springfield');
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

test("canonical emergency scenario passes command-only with fail-closed missing-evidence branch", async () => {
  const create = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "ticket.create",
    actorId: "dispatcher-story08",
    actorRole: "dispatcher",
    actorType: "AGENT",
    requestId: requestIds.create,
    correlationId,
    payload: {
      account_id: accountId,
      site_id: siteId,
      summary: "Emergency - cannot secure storefront",
      description: "Story 08 canonical chain",
    },
  });

  assert.equal(create.status, 201);
  const ticketId = create.data.id;
  assert.ok(isUuid(ticketId));
  assert.equal(create.request_id, requestIds.create);
  assert.equal(create.correlation_id, correlationId);

  const triage = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "ticket.triage",
    actorId: "dispatcher-story08",
    actorRole: "dispatcher",
    actorType: "AGENT",
    requestId: requestIds.triage,
    correlationId,
    ticketId,
    payload: {
      priority: "EMERGENCY",
      incident_type: "CANNOT_SECURE_ENTRY",
      nte_cents: 95000,
    },
  });

  assert.equal(triage.status, 200);
  assert.equal(triage.data.state, "TRIAGED");

  const dispatch = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "assignment.dispatch",
    actorId: "dispatcher-story08",
    actorRole: "dispatcher",
    actorType: "AGENT",
    requestId: requestIds.dispatch,
    correlationId,
    ticketId,
    payload: {
      tech_id: techId,
      dispatch_mode: "EMERGENCY_BYPASS",
    },
  });

  assert.equal(dispatch.status, 200);
  assert.equal(dispatch.data.state, "DISPATCHED");

  const checkIn = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "tech.check_in",
    actorId: "tech-story08",
    actorRole: "tech",
    actorType: "AGENT",
    requestId: requestIds.checkIn,
    correlationId,
    ticketId,
    payload: {
      timestamp: "2026-02-15T15:25:00.000Z",
      location: {
        lat: 47.6097,
        lon: -122.3331,
      },
    },
  });

  assert.equal(checkIn.status, 200);
  assert.equal(checkIn.data.state, "IN_PROGRESS");

  await assert.rejects(
    invokeDispatchAction({
      baseUrl: dispatchApiBaseUrl,
      toolName: "tech.complete",
      actorId: "tech-story08",
      actorRole: "tech",
      actorType: "AGENT",
      requestId: requestIds.completeFail,
      correlationId,
      ticketId,
      payload: {
        checklist_status: {
          work_performed: true,
          parts_used_or_needed: true,
          resolution_status: true,
          onsite_photos_after: true,
          billing_authorization: true,
        },
      },
    }),
    (error) => {
      assert.ok(error instanceof DispatchBridgeError);
      assert.equal(error.status, 409);
      assert.equal(error.code, "DISPATCH_API_ERROR");
      assert.equal(
        error.details.dispatch_error.error.code,
        "CLOSEOUT_REQUIREMENTS_INCOMPLETE",
      );
      assert.equal(error.details.dispatch_error.error.requirement_code, "MISSING_EVIDENCE");
      assert.deepEqual(error.details.dispatch_error.error.missing_evidence_keys, [
        "note_risk_mitigation_and_customer_handoff",
        "photo_after_temporary_or_permanent_securement",
        "photo_before_security_risk",
        "signature_or_no_signature_reason",
      ]);
      return true;
    },
  );

  assert.equal(psql(`SELECT state FROM tickets WHERE id = '${ticketId}';`), "IN_PROGRESS");
  assert.equal(psql(`SELECT count(*) FROM idempotency_keys WHERE request_id = '${requestIds.completeFail}';`), "0");

  const firstEvidencePayload = {
    kind: "PHOTO",
    uri: `s3://dispatch-e2e/${ticketId}/before.jpg`,
    metadata: {
      evidence_key: "photo_before_security_risk",
      capture_phase: "before",
    },
  };

  const evidence1 = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "closeout.add_evidence",
    actorId: "tech-story08",
    actorRole: "tech",
    actorType: "AGENT",
    requestId: requestIds.evidence1,
    correlationId,
    ticketId,
    payload: firstEvidencePayload,
  });
  assert.equal(evidence1.status, 201);

  const evidence1Replay = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "closeout.add_evidence",
    actorId: "tech-story08",
    actorRole: "tech",
    actorType: "AGENT",
    requestId: requestIds.evidence1,
    correlationId,
    ticketId,
    payload: firstEvidencePayload,
  });
  assert.equal(evidence1Replay.status, 201);
  assert.equal(evidence1Replay.data.id, evidence1.data.id);

  const evidence2 = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "closeout.add_evidence",
    actorId: "tech-story08",
    actorRole: "tech",
    actorType: "AGENT",
    requestId: requestIds.evidence2,
    correlationId,
    ticketId,
    payload: {
      kind: "PHOTO",
      uri: `s3://dispatch-e2e/${ticketId}/after.jpg`,
      metadata: {
        evidence_key: "photo_after_temporary_or_permanent_securement",
        capture_phase: "after",
      },
    },
  });
  assert.equal(evidence2.status, 201);

  const evidence3 = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "closeout.add_evidence",
    actorId: "tech-story08",
    actorRole: "tech",
    actorType: "AGENT",
    requestId: requestIds.evidence3,
    correlationId,
    ticketId,
    payload: {
      kind: "NOTE",
      uri: `s3://dispatch-e2e/${ticketId}/mitigation-note.txt`,
      metadata: {
        evidence_key: "note_risk_mitigation_and_customer_handoff",
      },
    },
  });
  assert.equal(evidence3.status, 201);

  const evidence4 = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "closeout.add_evidence",
    actorId: "tech-story08",
    actorRole: "tech",
    actorType: "AGENT",
    requestId: requestIds.evidence4,
    correlationId,
    ticketId,
    payload: {
      kind: "SIGNATURE",
      uri: `s3://dispatch-e2e/${ticketId}/signature.txt`,
      metadata: {
        evidence_key: "signature_or_no_signature_reason",
      },
    },
  });
  assert.equal(evidence4.status, 201);

  const evidenceList = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "closeout.list_evidence",
    actorId: "dispatcher-story08",
    actorRole: "dispatcher",
    actorType: "AGENT",
    correlationId,
    ticketId,
  });

  assert.equal(evidenceList.status, 200);
  assert.equal(evidenceList.data.ticket_id, ticketId);
  assert.equal(Array.isArray(evidenceList.data.evidence), true);
  assert.equal(evidenceList.data.evidence.length, 4);

  assertOrderedByCreatedAtAndId(evidenceList.data.evidence);

  const evidenceKeys = evidenceList.data.evidence
    .map((item) => item.metadata?.evidence_key)
    .sort((left, right) => left.localeCompare(right));
  assert.deepEqual(evidenceKeys, [
    "note_risk_mitigation_and_customer_handoff",
    "photo_after_temporary_or_permanent_securement",
    "photo_before_security_risk",
    "signature_or_no_signature_reason",
  ]);

  const replayEvidenceCount = Number(
    psql(`
      SELECT count(*)
      FROM evidence_items
      WHERE ticket_id = '${ticketId}'
        AND metadata->>'evidence_key' = 'photo_before_security_risk';
    `),
  );
  assert.equal(replayEvidenceCount, 1);

  assert.equal(
    Number(
      psql(`
        SELECT count(*)
        FROM idempotency_keys
        WHERE actor_id = 'tech-story08'
          AND endpoint = '/tickets/{ticketId}/evidence';
      `),
    ),
    4,
  );

  const complete = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "tech.complete",
    actorId: "tech-story08",
    actorRole: "tech",
    actorType: "AGENT",
    requestId: requestIds.completeSuccess,
    correlationId,
    ticketId,
    payload: {
      checklist_status: {
        work_performed: true,
        parts_used_or_needed: true,
        resolution_status: true,
        onsite_photos_after: true,
        billing_authorization: true,
      },
    },
  });

  assert.equal(complete.status, 200);
  assert.equal(complete.data.id, ticketId);
  assert.equal(complete.data.state, "COMPLETED_PENDING_VERIFICATION");

  const verify = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "qa.verify",
    actorId: "qa-story08",
    actorRole: "qa",
    actorType: "AGENT",
    requestId: requestIds.verify,
    correlationId,
    ticketId,
    payload: {
      timestamp: "2026-02-15T16:15:00.000Z",
      result: "PASS",
      notes: "QA verified emergency mitigation package",
    },
  });

  assert.equal(verify.status, 200);
  assert.equal(verify.data.id, ticketId);
  assert.equal(verify.data.state, "VERIFIED");

  const invoice = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "billing.generate_invoice",
    actorId: "finance-story08",
    actorRole: "finance",
    actorType: "AGENT",
    requestId: requestIds.invoice,
    correlationId,
    ticketId,
    payload: {},
  });

  assert.equal(invoice.status, 200);
  assert.equal(invoice.data.id, ticketId);
  assert.equal(invoice.data.state, "INVOICED");

  const finalTicket = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "ticket.get",
    actorId: "dispatcher-story08",
    actorRole: "dispatcher",
    actorType: "AGENT",
    correlationId,
    ticketId,
  });

  assert.equal(finalTicket.status, 200);
  assert.equal(finalTicket.data.id, ticketId);
  assert.equal(finalTicket.data.state, "INVOICED");

  const timeline = await invokeDispatchAction({
    baseUrl: dispatchApiBaseUrl,
    toolName: "ticket.timeline",
    actorId: "dispatcher-story08",
    actorRole: "dispatcher",
    actorType: "AGENT",
    correlationId,
    ticketId,
  });

  assert.equal(timeline.status, 200);
  assert.equal(timeline.data.ticket_id, ticketId);
  assert.equal(Array.isArray(timeline.data.events), true);
  assert.equal(timeline.data.events.length, 11);

  assertOrderedByCreatedAtAndId(timeline.data.events);

  assert.deepEqual(
    timeline.data.events.map((event) => event.tool_name),
    [
      "ticket.create",
      "ticket.triage",
      "assignment.dispatch",
      "tech.check_in",
      "closeout.add_evidence",
      "closeout.add_evidence",
      "closeout.add_evidence",
      "closeout.add_evidence",
      "tech.complete",
      "qa.verify",
      "billing.generate_invoice",
    ],
  );

  for (const event of timeline.data.events) {
    assert.equal(event.ticket_id, ticketId);
    assert.equal(event.correlation_id, correlationId);
  }

  const auditCount = Number(psql(`SELECT count(*) FROM audit_events WHERE ticket_id = '${ticketId}';`));
  assert.equal(auditCount, timeline.data.events.length);

  const transitionCount = Number(
    psql(`SELECT count(*) FROM ticket_state_transitions WHERE ticket_id = '${ticketId}';`),
  );
  assert.equal(transitionCount, 8);

  const completionTransitionCount = Number(
    psql(`
      SELECT count(*)
      FROM ticket_state_transitions
      WHERE ticket_id = '${ticketId}'
        AND from_state = 'IN_PROGRESS'
        AND to_state = 'COMPLETED_PENDING_VERIFICATION';
    `),
  );
  assert.equal(completionTransitionCount, 1);

  const checkInTransitions = psql(`
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
  assert.deepEqual(checkInTransitions, [
    "DISPATCHED->ON_SITE:1",
    "ON_SITE->IN_PROGRESS:1",
  ]);
});
