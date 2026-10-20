// Installed-package identity proof; reads only the scenario's isolated audit state.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const PSEUDONYM = /^hmac-sha256:v1:[a-f0-9]{32}:[a-f0-9]{64}$/u;

export function readIdentityRows(stateDir) {
  const file = path.join(stateDir, "state", "openclaw.sqlite");
  if (!fs.existsSync(file)) {
    return [];
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_schema WHERE name = ? AND type = 'table'")
        .get("execution_identity_contexts")
    ) {
      return [];
    }
    // Two rows suffice to reject cross-test contamination or duplicate admission.
    return db
      .prepare("SELECT context_json FROM execution_identity_contexts LIMIT 2")
      .all()
      .map((row) => row.context_json);
  } finally {
    db.close();
  }
}

function assertIdentityPrivacy(text, needles) {
  for (const needle of needles) {
    if (needle && text.includes(needle)) {
      throw new Error("execution identity exposed private fixture data");
    }
  }
}

export function assertIdentityProjection(result, persisted, needles) {
  assertIdentityPrivacy(JSON.stringify(result), needles);
  assertIdentityPrivacy(persisted, needles);
  const persistedContext = JSON.parse(persisted);
  const expectedRunId = persistedContext.runId;
  assert.ok(
    typeof expectedRunId === "string" && expectedRunId.length > 0,
    "missing persisted run id",
  );
  assert.equal(result.identity?.state, "present", "installed CLI omitted execution identity");
  assert.equal(result.run?.runId, expectedRunId, "installed CLI selected another run");
  assert.equal(Object.hasOwn(result, "decisions"), false, "private receipts reached the CLI");
  const context = result.identity.context;
  assert.equal(context.runId, expectedRunId);
  assert.equal(context.schemaVersion, 1);
  for (const id of [context.contextId, context.executionId]) {
    assert.ok(typeof id === "string" && id.length > 0, "missing opaque identity id");
  }
  assert.equal(result.run.executionId, context.executionId);
  assert.deepEqual(context.ingress, {
    kind: "local-cli",
    boundary: "agent-command.local",
    state: "present",
  });
  assert.deepEqual(context.invoker, { state: "absent" });
  assert.equal(context.coverageState, "unattributed");
  assert.equal(context.agentPrincipal?.principalRef, "main");
  assert.equal(context.agentDefinition?.definitionRef, "main");
  assert.equal(context.representedSubject, undefined);
  assert.equal(context.sponsor, undefined);
  assert.equal(context.lineage, undefined);
  assert.match(context.trustDomain?.domainRef, PSEUDONYM);
  assert.equal(context.agentPrincipal.domainRef, context.trustDomain.domainRef);
  assert.match(context.runtimeInstance?.runtimeRef, PSEUDONYM);
  for (const item of context.assurance) {
    assert.match(item.evidenceRef, PSEUDONYM);
  }
  for (const grant of context.applicableGrants) {
    assert.match(grant.grantRef, PSEUDONYM);
  }
  const admission = result.decisionDisplays?.find(
    (display) =>
      display.provenance?.state === "verified" && display.provenance.producer === "run-admission",
  );
  assert.equal(admission?.decision?.outcome, "not-applicable");
  assert.equal(admission?.decision?.reasonCode, "run_admission_identity_not_evaluated");
  assert.notEqual(admission?.enforcement?.coverageState, "enforced");
  assert.equal(JSON.stringify(context), persisted, "CLI context differs from persisted bytes");
  return context.executionId;
}

function isolatedStateDir() {
  const home = process.env.OPENCLAW_TEST_STATE_HOME;
  assert.ok(home, "missing isolated test HOME");
  assert.equal(process.env.HOME, home);
  assert.equal(process.env.OPENCLAW_HOME, home);
  const stateDir = path.join(home, ".openclaw");
  assert.equal(process.env.OPENCLAW_STATE_DIR, stateDir);
  assert.equal(process.env.OPENCLAW_CONFIG_PATH, path.join(stateDir, "openclaw.json"));
  return stateDir;
}

function main() {
  const [command, file, beforeFile] = process.argv.slice(2);
  const stateDir = isolatedStateDir();
  if (command === "clean-home") {
    assert.deepEqual(fs.readdirSync(stateDir), [], "package proof inherited existing state");
    return;
  }
  const rows = readIdentityRows(stateDir);
  if (command === "empty") {
    assert.equal(rows.length, 0, "identity state existed before the opted-in turn");
    return;
  }
  if (command === "run-id") {
    assert.equal(rows.length, 1, "expected exactly one admitted execution identity");
    const runId = JSON.parse(rows[0]).runId;
    assert.ok(typeof runId === "string" && runId.length > 0, "missing persisted run id");
    process.stdout.write(runId);
    return;
  }
  assert.equal(command, "verify");
  assert.equal(rows.length, 1, "expected exactly one admitted execution identity");
  const cfg = JSON.parse(fs.readFileSync(process.env.OPENCLAW_CONFIG_PATH, "utf8"));
  const channel = cfg.channels?.[process.env.OPENCLAW_NPM_ONBOARD_CHANNEL];
  const needles = [
    process.env.HOME,
    stateDir,
    process.env.OPENCLAW_TEST_WORKSPACE_DIR,
    process.env.OPENAI_API_KEY,
    process.env.OPENCLAW_GATEWAY_TOKEN,
    channel?.token,
    channel?.botToken,
    channel?.appToken,
    cfg.models?.providers?.openai?.baseUrl,
    process.env.SUCCESS_MARKER,
    "Return the success marker from the test server.",
  ];
  const result = JSON.parse(fs.readFileSync(file, "utf8"));
  const executionId = assertIdentityProjection(result, rows[0], needles);
  if (beforeFile) {
    const before = JSON.parse(fs.readFileSync(beforeFile, "utf8"));
    assertIdentityProjection(before, rows[0], needles);
    assert.equal(
      JSON.stringify(result.identity.context),
      JSON.stringify(before.identity.context),
      "execution identity changed across Gateway restart",
    );
  }
  process.stdout.write(executionId);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
