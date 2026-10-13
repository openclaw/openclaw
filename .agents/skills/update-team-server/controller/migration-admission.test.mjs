import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { makeReleaseFixture } from "./worker-config-owner-fixture.mjs";

const library = new URL("./release-lib.mjs", import.meta.url);

function classifyMigration(from, to, configPath) {
  return spawnSync(process.execPath, [
    "--no-warnings",
    fileURLToPath(library),
    "migration-kind",
    JSON.stringify({ sha: "a".repeat(40), schemaVersions: from }),
    JSON.stringify({ sha: "b".repeat(40), schemaVersions: to }),
    ...(configPath ? [configPath] : []),
  ], {
    encoding: "utf8",
    env: { OPENCLAW_TEAM_OPERATOR_PROFILE: process.env.OPENCLAW_TEAM_OPERATOR_PROFILE },
    timeout: 10_000,
  });
}

test("routes state 16 to 17 with agent 19 through native migration admission", () => {
  const result = classifyMigration({ state: 16, agent: 19 }, { state: 17, agent: 19 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "state-16-17");
});

test("routes only state 19/agent 24 to state 20/agent 24 through native Doctor", t => {
  const f = makeReleaseFixture(t);
  const from = { state: 19, agent: 24 }, to = { state: 20, agent: 24 };
  const result = classifyMigration(from, to);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "state-19-20");
  for (const [before, after] of [[{ state: 19, agent: 23 }, to], [from, { state: 21, agent: 24 }], [to, from]])
    assert.notEqual(classifyMigration(before, after).status, 0);
  writeFileSync(f.configPath, JSON.stringify({ session: { maintenance: { coldStorage: { enabled: true } } } }));
  assert.match(classifyMigration(from, to, f.configPath).stderr, /cold transcript extraction disabled/);
});

for (const source of [17, 18]) test(`routes state ${source} to ${source + 1} with unchanged agent 23 through native Doctor`, () => {
  const result = classifyMigration({ state: source, agent: 23 }, { state: source + 1, agent: 23 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `state-${source}-${source + 1}`);
});

for (const source of [17, 18]) test(`state ${source + 1} retains the agent 23 cold-history backup boundary`, t => {
  const fixture = makeReleaseFixture(t);
  for (const enabled of [true, "false", 1]) {
    writeFileSync(fixture.configPath, JSON.stringify({ session: { maintenance: { coldStorage: { enabled } } } }));
    const result = classifyMigration({ state: source, agent: 23 }, { state: source + 1, agent: 23 }, fixture.configPath);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /cold transcript extraction disabled/);
  }
});

for (const source of [19, 20, 21, 22, 23, 24]) test(`agent ${source}-to-${source + 1} refuses enabled cold extraction before migration activation`, (t) => {
  const fixture = makeReleaseFixture(t);
  const state = source === 24 ? 20 : source === 23 ? 19 : 17;
  const from = { state, agent: source }, to = { state, agent: source + 1 };
  for (const enabled of [true, "false", 1]) {
    writeFileSync(fixture.configPath, JSON.stringify({ session: { maintenance: { coldStorage: { enabled } } } }));
    const result = classifyMigration(from, to, fixture.configPath);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /cold transcript extraction disabled/);
  }
  writeFileSync(fixture.configPath, JSON.stringify({ session: { maintenance: { coldStorage: { enabled: false } } } }));
  const result = classifyMigration(from, to, fixture.configPath);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `agent-${source}-${source + 1}`);
});

for (const [state, source] of [[17, 19], [17, 20], [17, 21], [17, 22], [19, 23], [20, 24]]) test(`routes only the exact state ${state} and agent ${source} to ${source + 1} edge through agent migration`, () => {
  const result = classifyMigration({ state, agent: source }, { state, agent: source + 1 });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), `agent-${source}-${source + 1}`);
});

for (const schemas of [{ state: 16, agent: 19 }, { state: 17, agent: 21 }, { state: 17, agent: 22 }, { state: 17, agent: 23 }, { state: 18, agent: 23 }, { state: 19, agent: 23 }, { state: 19, agent: 24 }, { state: 20, agent: 24 }, { state: 20, agent: 25 }]) test(`keeps unchanged state ${schemas.state} and agent ${schemas.agent} on ordinary activation`, () => {
  const result = classifyMigration(schemas, schemas);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "none");
});

for (const [name, from, to] of [
  ["state downgrade", { state: 17, agent: 19 }, { state: 16, agent: 19 }],
  ["unqualified state jump", { state: 16, agent: 19 }, { state: 18, agent: 19 }],
  ["unqualified agent change", { state: 16, agent: 19 }, { state: 17, agent: 20 }],
  ["agent downgrade", { state: 17, agent: 20 }, { state: 17, agent: 19 }],
  ["unqualified agent jump", { state: 17, agent: 19 }, { state: 17, agent: 21 }],
  ["agent 21 downgrade", { state: 17, agent: 21 }, { state: 17, agent: 20 }],
  ["agent 21 with a simultaneous state change", { state: 17, agent: 20 }, { state: 18, agent: 21 }],
  ["agent 21 from an unqualified shared schema", { state: 16, agent: 20 }, { state: 16, agent: 21 }],
  ["agent 22 downgrade", { state: 17, agent: 22 }, { state: 17, agent: 21 }],
  ["agent 22 with a simultaneous state change", { state: 17, agent: 21 }, { state: 18, agent: 22 }],
  ["agent 22 from an unqualified shared schema", { state: 16, agent: 21 }, { state: 16, agent: 22 }],
  ["unqualified agent 20-to-22 jump", { state: 17, agent: 20 }, { state: 17, agent: 22 }],
  ["agent 23 downgrade", { state: 17, agent: 23 }, { state: 17, agent: 22 }],
  ["agent 23 simultaneous state change", { state: 17, agent: 22 }, { state: 18, agent: 23 }],
  ["agent 23 unqualified shared schema", { state: 16, agent: 22 }, { state: 16, agent: 23 }],
  ["unqualified agent 21-to-23 jump", { state: 17, agent: 21 }, { state: 17, agent: 23 }],
  ["agent 24 downgrade", { state: 19, agent: 24 }, { state: 19, agent: 23 }],
  ["agent 24 simultaneous state change", { state: 18, agent: 23 }, { state: 19, agent: 24 }],
  ["agent 24 skipped predecessor", { state: 19, agent: 22 }, { state: 19, agent: 24 }],
  ["agent 25 unqualified state 19", { state: 19, agent: 24 }, { state: 19, agent: 25 }],
  ["agent 24 unqualified state 17", { state: 17, agent: 23 }, { state: 17, agent: 24 }],
  ["agent 25 downgrade", { state: 20, agent: 25 }, { state: 20, agent: 24 }],
  ["agent 25 simultaneous state change", { state: 19, agent: 24 }, { state: 20, agent: 25 }],
  ["agent 25 skipped predecessor", { state: 20, agent: 23 }, { state: 20, agent: 25 }],
  ["agent 25 future target", { state: 20, agent: 24 }, { state: 20, agent: 26 }],
  ["agent 25 future edge", { state: 20, agent: 25 }, { state: 20, agent: 26 }],
  ["agent 25 unqualified state 21", { state: 21, agent: 24 }, { state: 21, agent: 25 }],
  ["state 18 with agent 22", { state: 17, agent: 22 }, { state: 18, agent: 22 }],
  ["state 18 with future agent", { state: 17, agent: 24 }, { state: 18, agent: 24 }],
  ["state 18 skipped predecessor", { state: 16, agent: 23 }, { state: 18, agent: 23 }],
  ["state 18 downgrade", { state: 18, agent: 23 }, { state: 17, agent: 23 }],
  ["state 19 with agent 22", { state: 18, agent: 22 }, { state: 19, agent: 22 }],
  ["state 19 with future agent", { state: 18, agent: 24 }, { state: 19, agent: 24 }],
  ["state 19 with a simultaneous agent change", { state: 18, agent: 22 }, { state: 19, agent: 23 }],
  ["state 19 skipped predecessor", { state: 17, agent: 23 }, { state: 19, agent: 23 }],
  ["state 19 downgrade", { state: 19, agent: 23 }, { state: 18, agent: 23 }],
  ["state 19 future edge", { state: 19, agent: 23 }, { state: 20, agent: 23 }],
]) {
  test(`refuses ${name} before migration activation`, () => {
    const result = classifyMigration(from, to);
    assert.equal(result.error, undefined);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /unsupported shared or agent schema crossing/);
    assert.equal(result.stdout, "");
  });
}

for (const [label, from, to, stagePrefix, wrongStage] of [
  ["state 17", { state: 16, agent: 19 }, { state: 17, agent: 19 }, "state16-17-", "state15-16-"],
  ["agent 20", { state: 17, agent: 19 }, { state: 17, agent: 20 }, "agent19-20-", "agent18-19-"],
  ["agent 21", { state: 17, agent: 20 }, { state: 17, agent: 21 }, "agent20-21-", "agent19-20-"],
  ["agent 22", { state: 17, agent: 21 }, { state: 17, agent: 22 }, "agent21-22-", "agent20-21-"],
  ["agent 23", { state: 17, agent: 22 }, { state: 17, agent: 23 }, "agent22-23-", "agent21-22-"],
  ["agent 24", { state: 19, agent: 23 }, { state: 19, agent: 24 }, "agent23-24-", "agent22-23-"],
  ["agent 25", { state: 20, agent: 24 }, { state: 20, agent: 25 }, "agent24-25-", "agent23-24-"],
  ["state 18", { state: 17, agent: 23 }, { state: 18, agent: 23 }, "state17-18-", "state16-17-"],
  ["state 19", { state: 18, agent: 23 }, { state: 19, agent: 23 }, "state18-19-", "state17-18-"],
]) test(`binds the ${label} journal and refuses unverified start or ordinary recovery`, (t) => {
  const fixture = makeReleaseFixture(t);
  const candidateSha = "b".repeat(40);
  const candidate = fixture.addRelease(candidateSha);
  const proof = (args, input) => spawnSync(process.execPath,
    ["--no-warnings", fileURLToPath(library), ...args], {
      encoding: "utf8", env: fixture.env, cwd: fixture.root, input, timeout: 10_000,
    });
  const succeeds = (result) => {
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const jsonProof = (args, input) => JSON.parse(succeeds(proof(args, input)));
  const releases = [];
  for (const [directory, sha, schemas] of [
    [fixture.initial, fixture.sha, from], [candidate, candidateSha, to],
  ]) {
    chmodSync(directory, 0o755);
    const packagePath = join(directory, "package.json");
    const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
    manifest.openclaw.schemaVersions = schemas;
    chmodSync(packagePath, 0o644);
    writeFileSync(packagePath, JSON.stringify(manifest));
    succeeds(proof(["manifest", directory, sha, String(process.getuid()), sha]));
    succeeds(proof(["seal-tree", directory]));
    releases.push(jsonProof(["validate-release", directory, sha, String(process.getuid()), "sealed"]));
  }
  const record = {
    version: 1,
    topology: "system",
    predecessor: releases[0],
    candidate: releases[1],
    process: { pid: 111, generation: "1110", instance: "fixture-instance-111" },
    services: {
      system: { unitFileState: "enabled", activeState: "active" },
      user: { unitFileState: "disabled", activeState: "inactive" },
    },
    suspension: null,
    protectedPaths: jsonProof(["fingerprint", fixture.configPath, fixture.databasePath]),
    pointerTopology: {
      current: { present: true, sha: fixture.sha },
      previous: { present: false, sha: null },
    },
  };
  const evidence = jsonProof(["migration-create", fixture.serving, "@stdin"], JSON.stringify(record));
  assert.ok(evidence.record.agentMigration.stage.startsWith(stagePrefix));
  assert.equal(evidence.record.agentMigration.phase, "rehearsal");
  const original = readFileSync(fixture.journal);
  unlinkSync(fixture.permit);
  for (const [args, message] of [
    [["migration-permit-publish", fixture.journal, fixture.serving, JSON.stringify(evidence),
      fixture.env.OPENCLAW_TEAM_PROC_ROOT], /Gateway permit requires durable verified stores/],
    [["migration-finish", fixture.journal, fixture.serving, JSON.stringify(evidence)],
      /migration retirement requires verified stores/],
    [["recovery-snapshot", fixture.journal, fixture.serving, JSON.stringify(record), "selected"],
      /migration requires its bound migration helpers/],
  ]) {
    const result = proof(args);
    assert.ifError(result.error);
    assert.equal(result.status, 2);
    assert.match(result.stderr, message);
    assert.equal(existsSync(fixture.permit), false);
    assert.deepEqual(readFileSync(fixture.journal), original);
  }
  const changed = JSON.parse(original);
  changed.agentMigration.stage = changed.agentMigration.stage.replace(stagePrefix, wrongStage);
  writeFileSync(fixture.journal, JSON.stringify(changed));
  const mismatched = proof(["migration-load", fixture.journal, fixture.serving]);
  assert.equal(mismatched.status, 2);
  assert.match(mismatched.stderr, /agent migration phase, release edge, or system topology is invalid/);
});
