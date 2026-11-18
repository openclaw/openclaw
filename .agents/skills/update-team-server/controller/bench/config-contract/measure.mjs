import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import "../../test-environment.mjs";

// Run only in a disposable Linux container with the synthetic /scale btrfs fixture.
const [candidate, controller, root, output, sha] = process.argv
  .slice(2)
  .map((value, i) => (i < 4 ? resolve(value) : value));
assert.match(sha, /^[a-f0-9]{40}$/);
assert.equal(process.platform, "linux");
assert.equal(process.getuid(), 0);
assert.equal(existsSync(join(root, "state")), false, "use a fresh benchmark namespace");
assert.equal(
  Number(statfsSync("/scale").type),
  0x9123683e,
  "mount a disposable btrfs filesystem at /scale",
);
if (!existsSync("/scale/agent.sqlite")) {
  const db = new DatabaseSync("/scale/agent.sqlite");
  db.exec(
    "CREATE TABLE sessions (key TEXT PRIMARY KEY, session_id TEXT, generation TEXT); CREATE TABLE synthetic_padding (payload BLOB); BEGIN",
  );
  const insert = db.prepare("INSERT INTO sessions VALUES (?,?,?)");
  for (let i = 0; i < 6000; i++)
    insert.run(`agent:synthetic:session-${i}`, `session-${i}`, `generation-${i}`);
  db.exec("COMMIT");
  const padding = db.prepare("INSERT INTO synthetic_padding VALUES (zeroblob(?))");
  for (let i = 0; i < 560; i++) padding.run(64 * 1024 * 1024);
  db.close();
}
if (!existsSync("/scale/workspace")) {
  mkdirSync("/scale/workspace");
  const bytes = Buffer.alloc(17742, 120);
  for (let i = 0; i < 62000; i++) writeFileSync(`/scale/workspace/synthetic-${i}`, bytes);
}
const shape = {
  agentDatabaseBytes: statSync("/scale/agent.sqlite").size,
  workspaceFiles: readdirSync("/scale/workspace").length,
  workspaceBytes: 62000 * 17742,
  sessions: 6000,
  filesystem: "btrfs compress=zstd:1",
  padding: "compressible zero BLOBs",
};
assert.ok(shape.agentDatabaseBytes >= 35 * 1024 ** 3);
assert.equal(shape.workspaceFiles, 62000);
const state = join(root, "state"),
  serving = join(root, "serving"),
  library = join(controller, "release-lib.mjs");
for (const dir of [
  root,
  state,
  join(state, "state"),
  join(state, "agents/controller-test-agent/agent"),
  serving,
  join(serving, "releases"),
  join(serving, "journal"),
  output,
])
  mkdirSync(dir, { recursive: true, mode: dir.endsWith("journal") ? 0o700 : 0o755 });
const release = join(serving, "releases", sha),
  configPath = join(state, "openclaw.json"),
  database = join(state, "state/openclaw.sqlite"),
  lock = join(root, "deploy.lock");
// Only namespace/pointer facts are synthetic; both commands execute the actual same candidate build.
symlinkSync(candidate, release);
symlinkSync(
  "/scale/agent.sqlite",
  join(state, "agents/controller-test-agent/agent/openclaw-agent.sqlite"),
);
new DatabaseSync(database).close();
chmodSync(database, 0o600);
writeFileSync(lock, "benchmark lock\n", { mode: 0o600 });
const profile = JSON.parse(process.env.OPENCLAW_TEAM_OPERATOR_PROFILE);
profile.policy.appServer.defaultWorkspaceDir = "/scale/workspace";
const env = {
  PATH: process.env.PATH,
  HOME: root,
  OPENCLAW_HOME: root,
  OPENCLAW_STATE_DIR: state,
  OPENCLAW_CONFIG_PATH: configPath,
  OPENCLAW_SUPERVISOR_MODE: "external",
  OPENCLAW_SERVICE_REPAIR_POLICY: "external",
  OPENCLAW_TEAM_OPERATOR_PROFILE: JSON.stringify(profile),
  OPENCLAW_TEAM_RELEASE_ROOT: serving,
  OPENCLAW_TEAM_ANCESTOR_BOUNDARY: root,
  OPENCLAW_TEAM_ROOT_UID: "0",
  OPENCLAW_TEAM_ROOT_GID: "0",
  OPENCLAW_TEAM_LOCK_FILE: lock,
  OPENCLAW_TEAM_RELEASE_LIB: library,
  OPENCLAW_TEAM_NODE_BIN: process.execPath,
  NODE_NO_WARNINGS: "1",
};
const seed = {
  meta: { migrations: { modelPolicyAllowlist: true, skillWorkshopPlugin: true } },
  update: { auto: { enabled: false } },
  channels: { clickclack: { commandMenu: false } },
  tools: { exec: { mode: "full" }, fs: { workspaceOnly: true } },
  agents: {
    defaults: { workspace: "/scale/workspace" },
    entries: { "controller-test-agent": { model: { primary: "fixture/exact-model" } } },
  },
  plugins: {
    allow: ["codex", "clickclack", "skill-workshop"],
    entries: { codex: { config: { appServer: { ...profile.policy.appServer } } } },
  },
};
const save = (value) => writeFileSync(configPath, JSON.stringify(value) + "\n", { mode: 0o600 });
const worker = join(candidate, "dist/infra/update-config-projection.worker.js");
const commands = {
  base: [
    "bash",
    "-c",
    'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9; exec "$@"',
    "config-contract-baseline",
    process.execPath,
    join(candidate, "dist/index.js"),
    "config",
    "validate",
    "--json",
  ],
  fixed: [
    "bash",
    "-c",
    `set -euo pipefail
exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"
flock -n 9
"$1" "$2" | "$1" "$3" config-contract prepare "$4" "$5" "$6" "$7" @stdin`,
    "config-contract-benchmark",
    process.execPath,
    worker,
    library,
    serving,
    release,
    configPath,
    database,
  ],
};
const timedChild = `import json,resource,subprocess,sys,time
r=json.load(sys.stdin); start=time.perf_counter_ns()
p=subprocess.run(r['args'],env=r['env'],capture_output=True,text=True,timeout=120)
u=resource.getrusage(resource.RUSAGE_CHILDREN)
print(json.dumps(dict(wallMs=(time.perf_counter_ns()-start)/1e6,cpuMs=(u.ru_utime+u.ru_stime)*1000,maxRssKiB=u.ru_maxrss,code=p.returncode,stdout=p.stdout,stderr=p.stderr)))`;
const digest = (value) => createHash("sha256").update(value).digest("hex");
const records = [];
function record(value) {
  records.push(value);
  appendFileSync(join(output, "samples.jsonl"), JSON.stringify(value) + "\n");
}
function fixture(scenario) {
  const config = structuredClone(seed);
  if (scenario === "retired")
    config.plugins.entries.codex.config.appServer.loopDetectionPreToolUseRelay = false;
  if (scenario === "invalid") config.unknownDeploymentKey = true;
  save(config);
  return readFileSync(configPath);
}
function check(arm, scenario, result, original) {
  const refused = scenario === "invalid" || (arm === "base" && scenario === "retired");
  assert.equal(result.code === 0, !refused, result.stderr);
  assert.deepEqual(readFileSync(configPath), original, "pre-stop admission wrote the live config");
  if (scenario === "retired" && arm === "base")
    assert.match(result.stderr + result.stdout, /loopDetectionPreToolUseRelay/);
  if (scenario === "invalid")
    assert.match(result.stderr + result.stdout, /unknownDeploymentKey|remains invalid at: <root>/);
  if (arm === "fixed" && !refused) {
    const descriptor = JSON.parse(result.stdout);
    if (scenario === "retired") {
      const plan = JSON.parse(readFileSync(join(serving, "journal", descriptor.name)));
      assert.deepEqual(plan.changedPaths, [
        "plugins.entries.codex.config.appServer.loopDetectionPreToolUseRelay",
      ]);
      assert.equal(plan.originalBytes, original.toString());
      assert.equal(
        Object.hasOwn(
          JSON.parse(plan.nextBytes).plugins.entries.codex.config.appServer,
          "loopDetectionPreToolUseRelay",
        ),
        false,
      );
    } else assert.equal(descriptor, null);
  }
}
function run(
  arm,
  scenario,
  repetition,
  iteration,
  extraEnv = {},
  prefix = [],
  command = commands[arm],
) {
  const original = fixture(scenario);
  const r = spawnSync("python3", ["-c", timedChild], {
    input: JSON.stringify({ args: [...prefix, ...command], env: { ...env, ...extraEnv } }),
    encoding: "utf8",
    timeout: 125000,
  });
  assert.equal(r.status, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  check(arm, scenario, result, original);
  return { arm, scenario, repetition, iteration, ...result };
}
for (const scenario of ["retired", "unchanged", "invalid"]) {
  for (const arm of ["base", "fixed"]) run(arm, scenario, "warmup", -1);
  for (const repetition of ["A1", "A2"]) {
    for (let iteration = 0; iteration < 5; iteration++) {
      for (const arm of ["base", "fixed"]) record(run(arm, scenario, repetition, iteration));
    }
    for (const arm of ["base", "fixed"]) {
      const allocationDir = join(output, `${arm}-${scenario}-${repetition}-alloc`);
      mkdirSync(allocationDir);
      const measured = run(arm, scenario, repetition, "allocation", {
        NODE_OPTIONS: `--import ${join(controller, "bench/retained-continuity/alloc-profile.mjs")}`,
        OPENCLAW_CONTINUITY_ALLOCATION_DIR: allocationDir,
      });
      const allocations = readdirSync(allocationDir).map((name) =>
        JSON.parse(readFileSync(join(allocationDir, name))),
      );
      record({
        ...measured,
        allocationInstrumented: true,
        sampledAllocatedBytes: allocations.reduce((sum, row) => sum + row.sampledAllocatedBytes, 0),
        allocationProcesses: allocations.length,
      });
    }
  }
  for (const arm of ["base", "fixed"]) {
    const trace = join(output, `${arm}-${scenario}.strace`);
    const result = run(arm, scenario, "trace", 0, {}, [
      "strace",
      "-f",
      "-qq",
      "-yy",
      "-e",
      "trace=%file,getdents64",
      "-o",
      trace,
    ]);
    const lines = readFileSync(trace, "utf8").split("\n");
    const stateOpens = lines.filter(
      (line) =>
        /(?:open|creat)\w*\(/.test(line) &&
        /(?:openclaw-agent\.sqlite|\/agent\.sqlite|\/state\/openclaw\.sqlite)/.test(line),
    );
    const agentOpens = stateOpens.filter((line) =>
      /(?:openclaw-agent\.sqlite|\/agent\.sqlite)/.test(line),
    );
    const databaseWriteOpens = stateOpens.filter((line) => /O_RDWR|O_WRONLY|O_CREAT/.test(line));
    const workspace = lines.filter((line) => /\/scale\/workspace/.test(line));
    const workspaceTraversal = workspace.filter((line) =>
      /(?:open|creat|opendir|getdents)\w*\(/.test(line),
    );
    if (arm === "fixed") {
      assert.equal(agentOpens.length, 0, agentOpens.join("\n"));
      assert.equal(databaseWriteOpens.length, 0, databaseWriteOpens.join("\n"));
      assert.equal(workspaceTraversal.length, 0, workspaceTraversal.join("\n"));
    }
    record({
      ...result,
      traceInstrumented: true,
      databaseOpens: stateOpens.length,
      agentDatabaseOpens: agentOpens.length,
      databaseWriteOpens: databaseWriteOpens.length,
      workspaceOperations: workspace.length,
      workspaceTraversal: workspaceTraversal.length,
    });
  }
}
const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
for (const arm of ["base", "fixed"]) {
  const directory = join(output, `${arm}-cpu-profile`),
    wrapper = join(directory, "node-profile");
  mkdirSync(directory);
  writeFileSync(
    wrapper,
    `#!/usr/bin/env bash\nexec ${shellQuote(process.execPath)} --cpu-prof --cpu-prof-dir=${shellQuote(directory)} "$@"\n`,
    { mode: 0o700 },
  );
  const command = commands[arm].map((value) => (value === process.execPath ? wrapper : value));
  record({
    ...run(arm, "retired", "cpu-profile", 0, {}, [], command),
    cpuProfileInstrumented: true,
  });
}
const percentile = (values, p) =>
  values.toSorted((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const summary = [];
for (const scenario of ["retired", "unchanged", "invalid"])
  for (const arm of ["base", "fixed"])
    for (const repetition of ["A1", "A2"]) {
      const rows = records.filter(
        (r) => r.arm === arm && r.scenario === scenario && r.repetition === repetition,
      );
      const timing = rows.filter((r) => !r.allocationInstrumented && !r.traceInstrumented),
        allocation = rows.find((r) => r.allocationInstrumented);
      const metrics = {};
      for (const key of ["wallMs", "cpuMs", "maxRssKiB"]) {
        const values = timing.map((r) => r[key]);
        metrics[key] = {
          median: percentile(values, 0.5),
          p95: percentile(values, 0.95),
          min: Math.min(...values),
          max: Math.max(...values),
        };
      }
      summary.push({
        scenario,
        arm,
        repetition,
        outcome: timing[0].code === 0 ? "admitted" : "refused",
        samples: timing.length,
        ...metrics,
        sampledAllocatedBytes: allocation.sampledAllocatedBytes,
      });
    }
writeFileSync(
  join(output, "measurements.json"),
  JSON.stringify(
    {
      shape,
      runtime: process.version,
      baselineSha: sha,
      candidateWorkerHash: digest(readFileSync(worker)),
      controllerHash: digest(readFileSync(library)),
      load: readFileSync("/proc/loadavg", "utf8").trim(),
      records,
    },
    null,
    2,
  ) + "\n",
);
writeFileSync(join(output, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
