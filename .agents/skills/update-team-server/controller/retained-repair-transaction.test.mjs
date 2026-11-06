import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  test,
  fixture,
  call,
  success,
  untouched,
  descriptor,
  addSession,
} from "./retained-repair-test-support.mjs";

function git(directory, ...args) {
  const result = spawnSync("/usr/bin/git", ["-C", directory, ...args], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Synthetic",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Synthetic",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
function ready(t) {
  const repo = mkdtempSync(join(tmpdir(), "retained-git-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, "init");
  git(repo, "commit", "--allow-empty", "-m", "synthetic B");
  const b = git(repo, "rev-parse", "HEAD");
  git(repo, "commit", "--allow-empty", "-m", "synthetic C");
  const c = git(repo, "rev-parse", "HEAD");
  const f = fixture(t, { b, c });
  f.buildHome = f.env.OPENCLAW_TEAM_BUILD_HOME;
  f.mirror = join(f.buildHome, "mirror/mirror.git");
  git(f.mirror, "init", "--bare");
  git(f.mirror, "fetch", repo, "HEAD:refs/remotes/origin/main");
  git(f.mirror, "remote", "add", "origin", "https://github.com/openclaw/openclaw.git");
  f.request = { ...f.request, target: { sha: c } };
  f.operation = { operation: f.request.operation };
  return f;
}
function invoke(f, command, action, input, preload) {
  return spawnSync(
    "bash",
    [
      "-c",
      'exec 9>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec "$@"',
      "retained-v2",
      process.execPath,
      ...(preload ? ["--import", preload] : []),
      f.library,
      command,
      action,
      f.serving,
      "@stdin",
    ],
    { env: f.env, encoding: "utf8", input: JSON.stringify(input), timeout: 30000 },
  );
}
function ok(f, command, action, input, preload) {
  const result = invoke(f, command, action, input, preload);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
const build = (f, action, input = f.operation) => ok(f, "retained-repair-build", action, input);
const transaction = (f, action, input, preload) =>
  ok(f, "retained-repair-transaction", action, input, preload);
function completed(f) {
  build(f, "begin", f.request);
  build(f, "origin");
  return build(f, "finish");
}

test("P2 direct check retries final capsule durability and preserves its inode", (t) => {
  const f = fixture(t),
    snapshot = success(f, "snapshot", f.request);
  const capsule = join(f.serving, "journal", `repair-${f.request.operation}.prepared.json`);
  const preload = join(f.root, "capsule-fsync.mjs"),
    trace = join(f.root, "sync-trace");
  writeFileSync(
    preload,
    `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const sync=fs.fsyncSync;
    fs.fsyncSync=(fd)=>{const path=fs.readlinkSync('/proc/self/fd/'+fd);fs.appendFileSync(${JSON.stringify(trace)},path+'\\n');
      if(path===${JSON.stringify(join(f.serving, "journal"))}&&fs.existsSync(${JSON.stringify(capsule)}))throw Error('synthetic final capsule directory fsync');return sync(fd)};
    syncBuiltinESMExports();`,
  );
  const failed = call(f, "seal", snapshot, { preload });
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /synthetic final capsule directory fsync/);
  const original = descriptor(capsule);
  const checked = call(f, "check", snapshot, { preload });
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /synthetic final capsule directory fsync/);
  assert.deepEqual(descriptor(capsule), original);
  assert.equal(success(f, "check", snapshot).phase, "PREPARED");
  assert.deepEqual(descriptor(capsule), original);
  assert.match(readFileSync(trace, "utf8"), /prepared.json/);
  untouched(f);
});

test("pending build binds absent target without changing failed journal", (t) => {
  const f = ready(t),
    parked = f.c + ".parked";
  renameSync(f.c, parked);
  const admitted = build(f, "begin", f.request);
  assert.equal(admitted.phase, "BUILD_PREPARED");
  assert.deepEqual(build(f, "begin", f.request), admitted);
  assert.deepEqual(build(f, "check").intent, admitted.intent);
  build(f, "origin");
  renameSync(parked, f.c);
  const done = build(f, "finish");
  assert.equal(done.phase, "BUILD_COMPLETED");
  assert.deepEqual(build(f, "finish"), done);
  untouched(f);
});

test("origin proof uses real git facts and rejects foreign origin or unrelated target", (t) => {
  const f = ready(t);
  build(f, "begin", f.request);
  git(f.mirror, "remote", "set-url", "origin", "https://example.invalid/foreign.git");
  assert.notEqual(invoke(f, "retained-repair-build", "origin", f.operation).status, 0);
  git(f.mirror, "remote", "set-url", "origin", "https://github.com/openclaw/openclaw.git");
  git(f.mirror, "update-ref", "refs/remotes/origin/main", f.record.candidate.sha);
  assert.notEqual(invoke(f, "retained-repair-build", "origin", f.operation).status, 0);
  git(f.mirror, "update-ref", "refs/remotes/origin/main", f.request.target.sha);
  assert.equal(build(f, "origin").origin.frozenMain, f.request.target.sha);
  untouched(f);
});

test("transaction preserves old journal bytes and consumes only complete bound evidence", (t) => {
  const f = ready(t),
    done = completed(f);
  addSession(f, "during-build");
  const begun = transaction(f, "begin", done.completed);
  assert.equal(begun.record.phase, "REPAIR_PREPARED");
  assert.notEqual(begun.journal.inode, f.originalJournalIdentity.inode);
  const receipt = JSON.parse(readFileSync(done.completed.path));
  assert.deepEqual(readFileSync(receipt.original.path), f.original);
  assert.deepEqual(transaction(f, "begin", done.completed), begun);
  const verified = transaction(f, "verify", begun.journal);
  assert.equal(verified.record.phase, "REPAIR_EVIDENCE_VERIFIED");
  assert.deepEqual(transaction(f, "resume", verified.journal), verified);
  assert.notEqual(invoke(f, "retained-repair-transaction", "verify", begun.journal).status, 0);
  assert.notEqual(invoke(f, "retained-repair-transaction", "stop", verified.journal).status, 0);
  assert.deepEqual(readFileSync(f.originalPath), f.originalWitness);
  assert.deepEqual(readFileSync(f.databasePath), f.beforeDatabase);
  const ordinary = spawnSync(process.execPath, [f.library, "journal-read", f.journal], {
    env: f.env,
    encoding: "utf8",
  });
  assert.notEqual(ordinary.status, 0, "ordinary v1 owner must not consume a repair journal");
});

for (const change of [
  "journal-bytes",
  "journal-inode",
  "config",
  "pointer",
  "target",
  "original-witness",
  "build-floor",
  "build-witness",
  "new-history",
]) {
  test(`transaction rejects changed ${change} without canonical overwrite`, (t) => {
    const f = ready(t),
      done = completed(f);
    if (change === "journal-bytes") writeFileSync(f.journal, f.original.toString() + " ");
    if (change === "journal-inode") {
      writeFileSync(f.journal + ".new", f.original, { mode: 0o600 });
      renameSync(f.journal + ".new", f.journal);
    }
    if (change === "config") writeFileSync(f.config, readFileSync(f.config, "utf8") + " ");
    if (change === "pointer") {
      renameSync(join(f.serving, "previous"), join(f.serving, "unexpected-previous"));
    }
    if (change === "target") {
      chmodSync(join(f.c, "deployment.json"), 0o644);
    }
    if (change === "original-witness") writeFileSync(f.originalPath, "[]");
    if (change === "build-floor")
      writeFileSync(
        join(f.serving, "journal", `repair-${f.request.operation}.build-intent.json`),
        "{}",
      );
    if (change === "build-witness")
      writeFileSync(
        join(f.serving, "journal", `repair-${f.request.operation}.build-witness.json`),
        "[]",
      );
    if (change === "new-history") {
      addSession(f, "after-completion");
      const begun = transaction(f, "begin", done.completed);
      const db = new DatabaseSync(f.agentDatabasePath);
      db.exec("DELETE FROM session_nodes WHERE session_key LIKE '%after-completion'");
      db.close();
      const before = readFileSync(f.journal);
      assert.notEqual(invoke(f, "retained-repair-transaction", "verify", begun.journal).status, 0);
      assert.deepEqual(readFileSync(f.journal), before);
      return;
    }
    const before = readFileSync(f.journal);
    assert.notEqual(invoke(f, "retained-repair-transaction", "begin", done.completed).status, 0);
    assert.deepEqual(readFileSync(f.journal), before);
  });
}

for (const sequence of [0, 1])
  for (const boundary of ["before", "after"]) {
    test(
      "canonical step " +
        sequence +
        " resumes " +
        boundary +
        " actual rename without replaying effects",
      (t) => {
        const f = ready(t),
          done = completed(f);
        const previous = sequence ? transaction(f, "begin", done.completed) : undefined;
        const action = sequence ? "verify" : "begin",
          input = sequence ? previous.journal : done.completed;
        const preload = join(f.root, "rename-crash.mjs");
        writeFileSync(
          preload,
          `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
      const rename=fs.renameSync;fs.renameSync=(from,to)=>{
        const match=to===${JSON.stringify(f.journal)}&&JSON.parse(fs.readFileSync(from)).sequence===${sequence};
        if(match&&${JSON.stringify(boundary)}==='before')process.kill(process.pid,'SIGKILL');
        const result=rename(from,to);if(match)process.kill(process.pid,'SIGKILL');return result;};syncBuiltinESMExports();`,
        );
        const crashed = invoke(f, "retained-repair-transaction", action, input, preload);
        assert.equal(crashed.signal, "SIGKILL", crashed.stderr);
        const result =
          boundary === "after" && sequence
            ? transaction(f, "resume", input)
            : transaction(f, action, input);
        assert.equal(result.record.sequence, sequence);
        assert.deepEqual(transaction(f, "check", result.journal), result);
        assert.equal(JSON.parse(readFileSync(f.journal)).sequence, sequence);
        assert.deepEqual(
          readFileSync(JSON.parse(readFileSync(done.completed.path)).original.path),
          f.original,
        );
      },
    );
  }

test("post-rename directory fsync fault cannot report verified and resumes same inode", (t) => {
  const f = ready(t),
    done = completed(f),
    begun = transaction(f, "begin", done.completed);
  const preload = join(f.root, "transaction-fsync.mjs");
  writeFileSync(
    preload,
    `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const sync=fs.fsyncSync;fs.fsyncSync=fd=>{if(fs.readlinkSync('/proc/self/fd/'+fd)===${JSON.stringify(join(f.serving, "journal"))}&&JSON.parse(fs.readFileSync(${JSON.stringify(f.journal)})).sequence===1)throw Error('synthetic canonical directory fsync');return sync(fd)};syncBuiltinESMExports();`,
  );
  const failed = invoke(f, "retained-repair-transaction", "verify", begun.journal, preload);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /canonical directory fsync/);
  const applied = descriptor(f.journal);
  assert.notEqual(
    invoke(f, "retained-repair-transaction", "resume", begun.journal, preload).status,
    0,
  );
  const resumed = transaction(f, "resume", begun.journal);
  assert.deepEqual(resumed.journal, applied);
  assert.equal(resumed.record.phase, "REPAIR_EVIDENCE_VERIFIED");
});

test("compare-transition refuses source mutation after durable intent", (t) => {
  const f = ready(t),
    done = completed(f),
    preload = join(f.root, "cas-race.mjs");
  writeFileSync(
    preload,
    `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
    const link=fs.linkSync;fs.linkSync=(from,to)=>{const result=link(from,to);if(to.endsWith('.transition-0.json'))fs.appendFileSync(${JSON.stringify(f.journal)},' ');return result;};syncBuiltinESMExports();`,
  );
  const failed = invoke(f, "retained-repair-transaction", "begin", done.completed, preload);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /slot changed/);
  assert.deepEqual(readFileSync(f.journal), Buffer.concat([f.original, Buffer.from(" ")]));
});

for (const suffix of [
  "build-intent",
  "build-original",
  "build-witness",
  "origin",
  "prepared",
  "build-completed",
]) {
  test("build replays exact " + suffix + " hardlink publication", (t) => {
    const f = ready(t),
      preload = join(f.root, "build-crash.mjs");
    const action = ["origin", "prepared", "build-completed"].includes(suffix)
      ? suffix === "origin"
        ? "origin"
        : "finish"
      : "begin";
    if (action !== "begin") build(f, "begin", f.request);
    if (action === "finish") build(f, "origin");
    const pathname = join(
      f.serving,
      "journal",
      "repair-" + f.request.operation + "." + suffix + ".json",
    );
    writeFileSync(
      preload,
      `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const link=fs.linkSync;fs.linkSync=(from,to)=>{const result=link(from,to);if(to===${JSON.stringify(pathname)})process.kill(process.pid,'SIGKILL');return result;};syncBuiltinESMExports();`,
    );
    const input = action === "begin" ? f.request : f.operation;
    assert.equal(invoke(f, "retained-repair-build", action, input, preload).signal, "SIGKILL");
    const inode = descriptor(pathname).inode;
    build(f, action, input);
    assert.equal(descriptor(pathname).inode, inode);
    untouched(f);
  });
}

const deploySource = readFileSync(new URL("./openclaw-release-deploy", import.meta.url), "utf8");
const prepareOwner = deploySource.match(/^prepare_retained_repair\(\) \{[\s\S]*?^\}/m)?.[0];
assert.ok(prepareOwner);
const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
for (const scenario of [
  "success",
  "fetch-fails",
  "build-fails",
  "timer-active",
  "foreign-origin",
]) {
  test(
    "pending-journal shell composition " +
      scenario +
      " retains original owner and no lifecycle effects",
    (t) => {
      const f = ready(t),
        trace = join(f.root, "prepare-events");
      if (scenario === "foreign-origin")
        git(f.mirror, "remote", "set-url", "origin", "https://example.invalid/foreign.git");
      const program = `set -Eeuo pipefail
node_bin=${quote(process.execPath)};release_lib=${quote(f.library)}
serving_root=${quote(f.serving)};releases_root="$serving_root/releases"
current_link="$serving_root/current";requested_sha=${quote(f.request.target.sha)}
operator_expected_sha=${quote(f.record.candidate.sha)};operator_expected_pid=${f.pid};operator_expected_generation=${quote(f.start)}
repair_operation=${quote(f.request.operation)};repair_journal_hash=${quote(f.request.source.sha256)}
mirror=${quote(f.mirror)};frozen_main=""
exec 9>"$OPENCLAW_TEAM_LOCK_FILE";flock -n 9
fail(){ printf '%s\\n' "$*" >&2;return 1; }
event(){ printf '%s\\n' "$*" >>${quote(trace)}; }
proof(){ event "proof $1 $2";"$node_bin" "$release_lib" "$@"; }
operator_check_lock(){ event held; }
assert_exclusive_owner(){ event owner; }
recheck_generation(){ event generation; }
read_pointer(){ printf '%s\\n' ${quote(f.b)}; }
system_systemctl(){ if [[ "$1" == is-enabled ]];then printf '%s\\n' ${scenario === "timer-active" ? "enabled" : "disabled"};else printf '%s\\n' inactive;fi; }
freeze_origin_main(){ event fetch;${scenario === "fetch-fails" ? "return 71;" : "frozen_main=$requested_sha;"} }
publish_release(){ event publish;${scenario === "build-fails" ? "return 72;" : 'proof validate-release "$releases_root/$1" "$1" "$OPENCLAW_TEAM_ROOT_UID" sealed;'} }
${prepareOwner}
prepare_retained_repair
`;
      const result = spawnSync("bash", ["-c", program], {
        env: f.env,
        encoding: "utf8",
        timeout: 30000,
      });
      const observed = existsSync(trace) ? readFileSync(trace, "utf8") : "";
      if (scenario === "success") {
        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /action=prepare-retained-repair restart=0 activation=0/);
        assert.ok(
          observed.indexOf("proof retained-repair-build begin") < observed.indexOf("fetch"),
        );
        assert.ok(
          observed.indexOf("fetch") < observed.indexOf("proof retained-repair-build origin"),
        );
        assert.ok(
          observed.indexOf("proof retained-repair-build origin") < observed.indexOf("publish"),
        );
        assert.ok(
          observed.indexOf("publish") < observed.indexOf("proof retained-repair-build finish"),
        );
      } else {
        assert.notEqual(result.status, 0);
        assert.doesNotMatch(observed, /proof retained-repair-build finish/);
        if (scenario !== "build-fails") assert.doesNotMatch(observed, /publish/);
      }
      untouched(f);
    },
  );
}

test("origin proof ignores local grafts that would counterfeit official ancestry", (t) => {
  const f = ready(t);
  const tree = git(f.mirror, "rev-parse", f.request.target.sha + "^{tree}");
  const orphan = git(f.mirror, "commit-tree", tree, "-m", "unrelated synthetic C");
  git(f.mirror, "update-ref", "refs/remotes/origin/main", orphan);
  writeFileSync(join(f.mirror, "info/grafts"), orphan + " " + f.record.candidate.sha + "\n");
  // The fixture proves the local graft would fool an unsanitized Git query.
  git(f.mirror, "merge-base", "--is-ancestor", f.record.candidate.sha, orphan);
  f.request.target.sha = orphan;
  build(f, "begin", f.request);
  const refused = invoke(f, "retained-repair-build", "origin", f.operation);
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /official ancestry observation failed/);
  assert.equal(
    existsSync(join(f.serving, "journal", "repair-" + f.request.operation + ".origin.json")),
    false,
  );
  untouched(f);
});

test("build check retries final witness directory durability without minting a new inode", (t) => {
  const f = ready(t);
  const witness = join(
    f.serving,
    "journal",
    "repair-" + f.request.operation + ".build-witness.json",
  );
  const preload = join(f.root, "build-check-fsync.mjs");
  writeFileSync(
    preload,
    "import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';" +
      "const sync=fs.fsyncSync;fs.fsyncSync=fd=>{if(fs.readlinkSync('/proc/self/fd/'+fd)===" +
      JSON.stringify(join(f.serving, "journal")) +
      "&&fs.existsSync(" +
      JSON.stringify(witness) +
      "))throw Error('synthetic build witness directory fsync');return sync(fd)};syncBuiltinESMExports();",
  );
  const failed = invoke(f, "retained-repair-build", "begin", f.request, preload);
  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /synthetic build witness directory fsync/);
  const published = descriptor(witness);
  const checked = invoke(f, "retained-repair-build", "check", f.operation, preload);
  assert.notEqual(checked.status, 0);
  assert.match(checked.stderr, /synthetic build witness directory fsync/);
  assert.equal(build(f, "check").phase, "BUILD_PREPARED");
  assert.deepEqual(descriptor(witness), published);
  untouched(f);
});
