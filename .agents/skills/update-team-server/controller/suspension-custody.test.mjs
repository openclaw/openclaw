import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";

const directory = dirname(fileURLToPath(import.meta.url));
const pair = resolve(process.env.CUSTODY_PAIR ?? directory);
const contractModule = resolve(process.env.CUSTODY_CONTRACT_MODULE ?? join(directory, "gateway-suspension-contract.mjs"));
const contract = await import(pathToFileURL(contractModule).href);
const materialized = mkdtempSync(join(tmpdir(), "team-custody-library-"));
after(() => rmSync(materialized, { recursive: true, force: true }));
let materialization = 0;
function localLibrary(selectedPair, modulePath = contractModule) {
  const target = join(materialized, `library-${materialization++}.mjs`);
  const source = readFileSync(join(selectedPair, "release-lib.mjs"), "utf8");
  // Test-only binding substitution. Production has no path/hash environment override.
  writeFileSync(target, source.replace(
    'const suspensionContractPath = "/usr/local/lib/openclaw-team/gateway-suspension-contract.mjs";',
    `const suspensionContractPath = ${JSON.stringify(modulePath)};`,
  ));
  return target;
}
const library = localLibrary(pair);
const owner = readFileSync(join(pair, "openclaw-release-deploy"), "utf8");
const definitions = owner.slice(0, owner.indexOf("while (($#)); do"));
assert.ok(definitions.length > 1_000, "load existing owner definitions before CLI dispatch");
const expiry = () => Date.now() + 120_000;
const lease = "fixture-owned-lease";
const blocker = { kind: "root-request", count: 1, message: "one root" };
const held = [{ phase: "migration", count: 1 }];

function prepare(status = "ready", custody = []) {
  return {
    status,
    ...(status === "busy"
      ? { reason: "active-work" }
      : { suspensionId: lease, expiresAtMs: expiry() }),
    ...(status === "ready" ? {} : { retryAfterMs: 20_000 }),
    activeCount: status === "ready" ? 0 : 1,
    blockers: status === "ready" ? [] : [blocker],
    ...(custody === undefined ? {} : { writeCustody: custody }),
  };
}

function status(state = "ready", custody = []) {
  return {
    status: state,
    expiresAtMs: expiry(),
    ...(state === "ready" ? {} : { retryAfterMs: 20_000, activeCount: 1, blockers: [blocker] }),
    ...(custody === undefined ? {} : { writeCustody: custody }),
  };
}

function proofAt(selectedLibrary, command, payload, ...args) {
  return spawnSync(process.execPath, ["--no-warnings", selectedLibrary, command, "@stdin", ...args.map(String)], {
    input: JSON.stringify(payload), encoding: "utf8", timeout: 10_000,
  });
}
const proof = (command, payload, ...args) => proofAt(library, command, payload, ...args);

function parse(kind, payload, ...args) {
  return kind === "prepare"
    ? proof("suspension-prepare", payload, ...args)
    : proof("suspension-status", payload, lease, payload.expiresAtMs, ...args);
}

const nativeKinds = ["agent-run", "acp-run", "media-generation"];
const historicalKinds = ["queue", "reply", "embedded-run", "background-exec", "cron-run", "task", "root-request", "session-admission", "session-mutation", "chat-run", "queued-turn", "terminal-persistence", "terminal-session"];
const taskDetail = { taskId: "fixture-task", status: "running", runtime: "cli", runId: "fixture-run", label: "fixture label", title: "fixture title" };

function blockerPayload(kind, shape, task) {
  const value = shape === "status" ? status("draining") : prepare(shape);
  value.blockers = [{ kind, count: 1, message: "fixture work", ...(task ? { task } : {}) }];
  return value;
}

test("pinned contract accepts exact predecessor and current producer vocabularies without mutation", () => {
  for (const kind of [...historicalKinds, ...nativeKinds]) {
    for (const shape of ["draining", "busy", "status"]) {
      const value = blockerPayload(kind, shape);
      const before = JSON.stringify(value);
      const validate = shape === "status" ? contract.validateGatewaySuspendStatusResult : contract.validateGatewaySuspendPrepareResult;
      assert.equal(validate(value), true, `${shape}: ${kind}`);
      assert.equal(JSON.stringify(value), before);
    }
  }
  for (const kind of ["task", "background-exec"]) {
    for (const shape of ["draining", "busy", "status"]) {
      const value = blockerPayload(kind, shape, taskDetail);
      delete value.writeCustody;
      const validate = shape === "status" ? contract.validateGatewaySuspendStatusResult : contract.validateGatewaySuspendPrepareResult;
      assert.equal(validate(value), true, `${shape}: historical ${kind} detail`);
      const accepted = parse(shape === "status" ? "status" : "prepare", value);
      assert.equal(accepted.status, 0, accepted.stderr);
      assert.match(accepted.stdout.trim(), / unknown$/);
    }
  }
});

for (const kind of nativeKinds) {
  test(`native ${kind} passes the hash-checked prepare, both BUSY reasons and status boundary`, () => {
    for (const shape of ["draining", "busy", "status"]) {
      const value = blockerPayload(kind, shape);
      const result = parse(shape === "status" ? "status" : "prepare", value);
      assert.equal(result.status, 0, `${shape}: ${result.stderr}`);
      assert.match(result.stdout, new RegExp(`${kind}:1 clear`));
      if (shape === "busy") {
        value.reason = "gateway-draining";
        const draining = parse("prepare", value);
        assert.equal(draining.status, 0, draining.stderr);
        assert.match(draining.stdout, /^BUSY /);
      }
    }
  });
}

test("current-only kinds cannot acquire historical task details or unknown wire fields", () => {
  for (const shape of ["draining", "busy", "status"]) {
    const validate = shape === "status" ? contract.validateGatewaySuspendStatusResult : contract.validateGatewaySuspendPrepareResult;
    for (const kind of ["future-work", 1, null]) assert.equal(validate(blockerPayload(kind, shape)), false);
    for (const blockers of [null, {}, "blocked", [null]]) {
      assert.equal(validate({ ...blockerPayload("agent-run", shape), blockers }), false);
    }
    for (const kind of nativeKinds) {
      assert.equal(validate(blockerPayload(kind, shape, taskDetail)), false);
      const extra = blockerPayload(kind, shape);
      extra.blockers[0].unexpected = true;
      assert.equal(validate(extra), false);
    }
    for (const task of [
      { ...taskDetail, status: "finished" }, { ...taskDetail, runtime: "future" },
      { ...taskDetail, taskId: 1 }, { ...taskDetail, label: false }, { ...taskDetail, unexpected: true },
    ]) assert.equal(validate(blockerPayload("task", shape, task)), false);
  }
});

for (const [kind, state] of [
  ["prepare", "busy"], ["prepare", "draining"], ["prepare", "ready"],
  ["status", "draining"], ["status", "ready"],
]) {
  test(`${kind} ${state}: current empty custody and legacy absence are distinct`, () => {
    const payload = kind === "prepare" ? prepare(state) : status(state);
    const modern = parse(kind, payload);
    assert.equal(modern.status, 0, modern.stderr);
    assert.match(modern.stdout.trim(), / clear$/);
    delete payload.writeCustody;
    const legacy = parse(kind, payload);
    assert.equal(legacy.status, 0, legacy.stderr);
    assert.match(legacy.stdout.trim(), / unknown$/);
  });
}

for (const kind of ["prepare", "status"]) {
  test(`${kind}: custody-only draining is valid, including old and future phase names`, () => {
    for (const phase of ["migration", "backup", "coordinator-write", "future-owner"]) {
      const payload = kind === "prepare" ? prepare("draining", [{ phase, count: 1 }]) : status("draining", [{ phase, count: 1 }]);
      payload.blockers = [];
      const result = parse(kind, payload);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout.trim(), / none held$/);
    }
  });

  test(`${kind}: malformed custody and contradictory readiness remain rejected`, () => {
    for (const custody of [null, {}, "clear", [{ phase: "", count: 1 }], [{ phase: "backup", count: -1 }], [{ phase: "backup", count: 0.5 }], [{ phase: "backup", count: Number.MAX_SAFE_INTEGER + 1 }], [{ phase: "backup", count: "1" }], [{ phase: "backup", count: 1, extra: true }], [{ phase: "backup" }]]) {
      const payload = kind === "prepare" ? prepare("draining", custody) : status("draining", custody);
      assert.notEqual(parse(kind, payload).status, 0, JSON.stringify(custody));
    }
    const ready = kind === "prepare" ? prepare("ready", held) : status("ready", held);
    assert.notEqual(parse(kind, ready).status, 0);
    const clear = kind === "prepare" ? prepare("draining") : status("draining");
    clear.blockers = [];
    assert.notEqual(parse(kind, clear).status, 0, "positive work needs blockers or positive custody");
    const extra = kind === "prepare" ? prepare() : status();
    extra.unrecognized = true;
    assert.notEqual(parse(kind, extra).status, 0, "unrelated fields must not become accepted");
    const zero = kind === "prepare" ? prepare("ready", [{ phase: "backup", count: 0 }]) : status("ready", [{ phase: "backup", count: 0 }]);
    const result = parse(kind, zero);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout.trim(), / clear$/);
  });
}

test("lease expiry, renewal identity and renewal advancement remain enforced", () => {
  const value = prepare();
  assert.equal(parse("prepare", value, lease, value.expiresAtMs - 1000).status, 0);
  assert.notEqual(parse("prepare", value, "different", value.expiresAtMs - 1000).status, 0);
  assert.notEqual(parse("prepare", value, lease, value.expiresAtMs).status, 0);
  assert.notEqual(parse("prepare", prepare("busy"), lease, value.expiresAtMs).status, 0);
  assert.notEqual(parse("prepare", { ...value, expiresAtMs: Date.now() + 1000 }).status, 0);
  const ready = status();
  assert.notEqual(proof("suspension-status", ready, lease, ready.expiresAtMs + 1).status, 0);
  assert.notEqual(parse("status", { ...ready, expiresAtMs: Date.now() + 1000 }).status, 0);
});

test("running, resume and handoff wire shapes stay unchanged", () => {
  assert.equal(proof("suspension-running", { status: "running" }).status, 0);
  assert.notEqual(proof("suspension-running", { status: "running", writeCustody: [] }).status, 0);
  assert.equal(proof("suspension-resume", { ok: true, status: "running", resumed: true }).status, 0);
  assert.notEqual(proof("suspension-resume", { ok: true, status: "running", resumed: true, writeCustody: [] }).status, 0);
  const end = expiry();
  const armed = { status: "armed", suspensionId: lease, expiresAtMs: end };
  assert.equal(proof("suspension-handoff", armed, lease, end).status, 0);
  assert.notEqual(proof("suspension-handoff", { ...armed, writeCustody: [] }, lease, end).status, 0);
});

function ownerRun(body, first, next = first, options = {}, bindings = {}) {
  const root = mkdtempSync(join(tmpdir(), "team-custody-owner-"));
  try {
    writeFileSync(join(root, "definitions.sh"), bindings.definitions ?? definitions);
    writeFileSync(join(root, "first.json"), JSON.stringify(first));
    writeFileSync(join(root, "next.json"), JSON.stringify(next));
    writeFileSync(join(root, "calls"), "");
    const script = `
source "$FIXTURE/definitions.sh"
node_bin="$TEST_NODE"
release_lib="$TEST_LIBRARY"
run_gateway() {
  printf '%s\\n' "$4" >> "$FIXTURE/calls"
  [[ ! -e "$FIXTURE/fail-rpc" ]] || return 124
  case "$4" in
    gateway.suspend.prepare) cat "$FIXTURE/first.json" ;;
    gateway.suspend.status) cat "$FIXTURE/next.json" ;;
    gateway.suspend.resume) printf '%s\\n' '{"ok":true,"status":"running","resumed":true}' ;;
    *) return 99 ;;
  esac
}
recheck_generation() { [[ "$GENERATION_CURRENT" == yes ]]; }
profile_finish() { :; }
profile_close() { :; }
profile_maintenance() { :; }
suspension_scope=system
suspension_release=fixture
suspension_pid=42
suspension_generation=123
held_suspension=fixture-owned-lease
suspension_expiry="$EXPECTED_EXPIRY"
interrupt_after_drain=1
drain_budget_elapsed=1
${body}
`;
    const result = spawnSync("bash", ["-c", script], {
      encoding: "utf8", timeout: 10_000,
      env: { ...process.env, OPENCLAW_TEAM_RUNTIME_UID: "1000", OPENCLAW_TEAM_DEPLOY_UID: "1001", OPENCLAW_TEAM_DEPLOY_GID: "1001", FIXTURE: root, TEST_NODE: process.execPath, TEST_LIBRARY: bindings.library ?? library, EXPECTED_EXPIRY: String(next.expiresAtMs ?? expiry()), GENERATION_CURRENT: "yes", ...options },
    });
    return { ...result, calls: readFileSync(join(root, "calls"), "utf8").trim().split("\n") };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("owner allows ordinary bounded interruption for clear or unknown custody", () => {
  for (const presence of ["clear", "unknown"]) {
    const payload = status("draining");
    if (presence === "unknown") delete payload.writeCustody;
    const result = ownerRun("check_suspension", payload);
    assert.equal(result.status, 0, result.stderr);
  }
});

test("owner refuses positive write custody without treating it as malformed wire", () => {
  for (const phase of ["migration", "backup", "session-mutation", "terminal-persistence", "coordinator-write", "future-owner"]) {
    const payload = status("draining", [{ phase, count: 1 }]);
    payload.blockers = [];
    const result = ownerRun("check_suspension", payload);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /stage=policy.*custody=held/);
    assert.doesNotMatch(result.stderr, /malformed|stage=proof/);
  }
});

test("native blockers retain final-write, safe-count and write-custody policy", () => {
  for (const kind of nativeKinds) {
    const clear = blockerPayload(kind, "status");
    const accepted = ownerRun("check_suspension", clear);
    assert.equal(accepted.status, 0, accepted.stderr);
    const custody = { ...clear, writeCustody: held };
    const blocked = ownerRun("check_suspension", custody);
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stderr, /stage=policy.*custody=held/);
    const persistence = structuredClone(clear);
    delete persistence.writeCustody;
    persistence.blockers.push({ kind: "terminal-persistence", count: 1, message: "fixture final write" });
    assert.equal(ownerRun("check_suspension", persistence).status, 1);
    const unsafeCount = structuredClone(clear);
    unsafeCount.blockers[0].count = Number.MAX_SAFE_INTEGER + 1;
    assert.notEqual(parse("status", unsafeCount).status, 0);
    assert.notEqual(parse("prepare", blockerPayload(kind, "ready")).status, 0);
  }
});

test("late write custody overturns READY; fresh clearing permits the next check", () => {
  const ready = status();
  const draining = { ...status("draining", held), expiresAtMs: ready.expiresAtMs, blockers: [] };
  const result = ownerRun(`
cp "$FIXTURE/first.json" "$FIXTURE/next.json"
check_suspension
printf '%s' "$LATE_STATUS" > "$FIXTURE/next.json"
if check_suspension; then exit 92; fi
cp "$FIXTURE/first.json" "$FIXTURE/next.json"
check_suspension
`, ready, ready, { LATE_STATUS: JSON.stringify(draining) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.calls.filter((method) => method === "gateway.suspend.status").length, 3);
});

test("owner retains generation, deadline and terminal-persistence guards", () => {
  const ready = status();
  const stale = ownerRun("check_suspension", ready, ready, { GENERATION_CURRENT: "no" });
  assert.equal(stale.status, 1);
  assert.match(stale.stderr, /stage=generation/);
  const draining = status("draining");
  assert.equal(ownerRun("drain_budget_elapsed=0\ncheck_suspension", draining).status, 1);
  assert.equal(ownerRun("interrupt_after_drain=0\ncheck_suspension", draining).status, 1);
  draining.blockers = [{ kind: "terminal-persistence", count: 1, message: "pending write" }];
  delete draining.writeCustody;
  assert.equal(ownerRun("check_suspension", draining).status, 1);
});

test("failed fresh polling cannot reuse an earlier clear-custody observation", () => {
  const payload = status();
  const result = ownerRun(`
check_suspension
touch "$FIXTURE/fail-rpc"
check_suspension
`, payload);
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /SUSPENSION_POLL_FAILED stage=rpc/);
  assert.match(result.stderr, /SUSPENSION_CHECK_FAILED stage=status/);
});

test("owner accepts modern preparation without altering existing lease binding", () => {
  const payload = prepare("draining");
  const result = ownerRun(`
held_suspension=""
request_suspension fixture '{}'
[[ "$held_suspension" == fixture-owned-lease && "$suspension_write_custody" == clear ]]
`, payload);
  assert.equal(result.status, 0, result.stderr);
});

test("malformed preparation still retires its exact offered lease through existing exit owner", () => {
  const payload = prepare("draining", null);
  const result = ownerRun(`
held_suspension=""
trap on_exit EXIT
if request_suspension fixture '{}'; then exit 92; else exit "$?"; fi
`, payload);
  assert.equal(result.status, 75, result.stderr);
  assert.deepEqual(result.calls, ["gateway.suspend.prepare", "gateway.suspend.resume"]);
});

function journal(end) {
  const predecessor = "a".repeat(40);
  return {
    version: 1, phase: "A_PREPARED", topology: "system",
    predecessor: { sha: predecessor, schemaVersions: { state: 17, agent: 22 } },
    candidate: { sha: "b".repeat(40), schemaVersions: { state: 17, agent: 22 } },
    process: { pid: 42, generation: "123", instance: "fixture-instance" },
    pointerTopology: { current: { present: true, sha: predecessor }, previous: { present: false, sha: null } },
    services: { system: { unitFileState: "enabled", activeState: "active" }, user: { unitFileState: "disabled", activeState: "inactive" } },
    suspension: { id: lease, expiresAtMs: end, terminalPolicy: "preserve", status: "ready" },
    protectedPaths: [{ path: "/fixture/config", device: 1, inode: 1 }, { path: "/fixture/database", device: 1, inode: 2 }],
  };
}

test("recovery resumes exact READY journal lease after fresh custody makes it DRAINING", () => {
  const value = status("draining", held);
  value.blockers = [];
  const record = journal(value.expiresAtMs);
  const result = proof("suspension-recovery-status", value, JSON.stringify({ record }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "ACTIVE");
  assert.equal(record.suspension.status, "ready", "inspection must not rewrite historical phase");
  assert.notEqual(proof("suspension-recovery-status", { ...value, expiresAtMs: value.expiresAtMs + 1 }, JSON.stringify({ record })).status, 0);
  assert.notEqual(proof("suspension-recovery-status", value, JSON.stringify({ record: { ...record, process: { ...record.process, pid: 0 } } })).status, 0);
  assert.notEqual(proof("suspension-recovery-status", { status: "running" }, JSON.stringify({ record })).status, 0);
  record.suspension.expiresAtMs = Date.now() - 1;
  const resumed = proof("suspension-recovery-status", { status: "running" }, JSON.stringify({ record }));
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.equal(resumed.stdout.trim(), "ALREADY_RESUMED");
});


test("contract artifact tampering fails closed before parsing", () => {
  const corrupt = join(materialized, "corrupt-contract.mjs");
  writeFileSync(corrupt, 'throw new Error("must not execute unverified bytes");');
  const result = proofAt(localLibrary(pair, corrupt), "suspension-prepare", prepare());
  assert.equal(result.status, 2);
  assert.match(result.stderr, /contract artifact hash changed/);
  assert.doesNotMatch(result.stderr, /must not execute/);
});
