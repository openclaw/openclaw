/** Real file-coding workload with a host-owned oracle and a persisted worker handoff. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const [runtime, model, outputPath] = process.argv.slice(2);
if ((runtime !== "codex" && runtime !== "claude-cli") || !model?.includes("/") || !outputPath) {
  throw new Error(
    "Usage: supervised-task-coding-proof.ts <codex|claude-cli> <provider/model> <report.json>",
  );
}
const attemptTimeoutMs = 180_000;
const root = mkdtempSync(path.join(tmpdir(), "openclaw-supervised-coding-"));
const workspace = path.join(root, "workspace");
const stateDir = path.join(root, "state");
mkdirSync(workspace);
mkdirSync(stateDir);
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, "openclaw.json");
writeFileSync(
  process.env.OPENCLAW_CONFIG_PATH,
  JSON.stringify({
    agents: {
      defaults: {
        model,
        models: { [model]: { agentRuntime: { id: runtime } } },
        thinkingDefault: "medium",
        timeoutSeconds: 180,
      },
      entries: {
        poc: { workspace, cwd: workspace, agentDir: path.join(stateDir, "agents", "poc", "agent") },
      },
    },
    plugins: { allow: ["anthropic", "codex", "openai"] },
    tools: { fs: { workspaceOnly: true } },
  }),
  { mode: 0o600 },
);

const specification = `Implement a dependency-aware batch planner in two ES modules, using only file tools.
graph.mjs exports validateJobs(jobs). A job is {id: nonempty string, deps: array of job ids}.
Return a Map keyed by id with independent copies of the dependency arrays. Never mutate inputs.
Reject nonarrays, malformed jobs/deps, duplicate ids/deps, unknown dependencies, self-dependencies and cycles by throwing Error.
planner.mjs imports validateJobs and exports planJobs(jobs, capacity).
Capacity must be a positive safe integer. Return an array of batches (arrays of ids).
In each round find ALL jobs whose dependencies completed in PRIOR rounds, sort by JavaScript default string ordering, and take the first capacity ids.
Jobs that depend on a job in the current batch cannot run in that batch. Empty jobs gives [].
Reject invalid graphs/capacities. Results must not depend on input ordering and inputs must remain unchanged.
No dependencies, network, shell, subprocesses, automations, or changes outside these two modules.
Work in TWO attempts: first implement graph.mjs ONLY and return wait with the exact wakeAt supplied in the task request and a next field handing off all relevant context.
In the second attempt, reread the files, implement planner.mjs, and return succeeded with evidence for graph and planner.
The host will replace the supervisor during that persisted wait, then execute independent tests outside this workspace.
Do not claim that you ran tests: execution tools are intentionally unavailable. Explain that host verification remains required.
`;
writeFileSync(path.join(workspace, "SPEC.md"), specification);
writeFileSync(
  path.join(workspace, "AGENTS.md"),
  "Read SPEC.md. Only modify graph.mjs and planner.mjs. Preserve the two-attempt handoff.\n",
);
const graphStub =
  "export function validateJobs(jobs) { return new Map(jobs.map(j => [j.id, j.deps])); }\n";
const plannerStub = "export function planJobs(jobs, capacity) { return [jobs.map(j => j.id)]; }\n";
writeFileSync(path.join(workspace, "graph.mjs"), graphStub);
writeFileSync(path.join(workspace, "planner.mjs"), plannerStub);

// This verifier lives outside the model's workspace. Its assertions come from
// the specified behavior, not the model's final response or a copied solution.
const verifier = path.join(root, "verify.mjs");
writeFileSync(
  verifier,
  `
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const workspace = process.argv[2];
const { validateJobs } = await import(pathToFileURL(path.join(workspace, 'graph.mjs')).href);
const { planJobs } = await import(pathToFileURL(path.join(workspace, 'planner.mjs')).href);
const failures = []; let cases = 0;
function check(name, fn) { cases++; try { fn(); } catch(e) { failures.push({name, error:String(e).slice(0,1000)}); } }
check('empty', () => assert.deepEqual(planJobs([], 2), []));
const diamond = [{id:'d',deps:['b','c']},{id:'c',deps:['a']},{id:'b',deps:['a']},{id:'a',deps:[]}];
check('diamond', () => assert.deepEqual(planJobs(diamond,2), [['a'],['b','c'],['d']]));
check('round barrier', () => assert.deepEqual(planJobs([{id:'a',deps:[]},{id:'b',deps:['a']},{id:'c',deps:[]}],3), [['a','c'],['b']]));
check('lexical capacity', () => assert.deepEqual(planJobs([{id:'z',deps:[]},{id:'10',deps:[]},{id:'2',deps:[]},{id:'A',deps:[]}],2), [['10','2'],['A','z']]));
for (const bad of [0,-1,1.2,NaN,Infinity,'2',Number.MAX_SAFE_INTEGER+1]) check('invalid capacity '+String(bad), () => assert.throws(() => planJobs([],bad)));
const badGraphs = [null, {}, [{id:'',deps:[]}], [{id:'a',deps:'b'}], [{id:1,deps:[]}], [{id:'a',deps:[2]}], [{id:'a',deps:[]},{id:'a',deps:[]}], [{id:'a',deps:['b','b']},{id:'b',deps:[]}], [{id:'a',deps:['missing']}], [{id:'a',deps:['a']}], [{id:'a',deps:['b']},{id:'b',deps:['a']}], [{id:'ok',deps:[]},{id:'a',deps:['b']},{id:'b',deps:['c']},{id:'c',deps:['a']}]];
badGraphs.forEach((g,i) => check('reject graph '+i, () => { assert.throws(() => validateJobs(g)); assert.throws(() => planJobs(g,2)); }));
check('defensive copy', () => { const g = structuredClone(diamond); const original = JSON.stringify(g); const m = validateJobs(g); assert.ok(m instanceof Map); assert.deepEqual([...m.keys()].sort(),['a','b','c','d']); m.get('d').push('other'); assert.equal(JSON.stringify(g),original); });
// Seeded DAGs: verify independent schedule properties, then permutation invariance.
let seed = 83117; const rand = () => { seed = (Math.imul(seed,1664525)+1013904223) >>> 0; return seed/4294967296; };
for (let n=1; n<=60; n++) {
  const jobs = Array.from({length:n},(_,i) => ({id:'j'+String(i).padStart(3,'0'),deps:Array.from({length:i},(_,j)=>'j'+String(j).padStart(3,'0')).filter(()=>rand()<0.12)}));
  const capacity = 1+(n%7);
  check('DAG '+n, () => {
    const before = JSON.stringify(jobs); const schedule = planJobs(jobs,capacity); const done = new Set();
    for (const batch of schedule) {
      const ready = jobs.filter(j=>!done.has(j.id)&&j.deps.every(d=>done.has(d))).map(j=>j.id).sort();
      assert.deepEqual(batch,ready.slice(0,capacity)); assert.ok(batch.length>0);
      batch.forEach(id=>{assert.ok(!done.has(id));done.add(id);});
    }
    assert.equal(done.size,n); assert.equal(JSON.stringify(jobs),before);
    assert.deepEqual(planJobs([...jobs].reverse(),capacity),schedule);
  });
}
console.log(JSON.stringify({cases, failures})); process.exitCode = failures.length ? 1 : 0;
`,
);
const digest = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
const verifierHash = digest(verifier);
const verify = () => {
  // Linux namespace isolation: generated modules see only read-only fixture and
  // oracle mounts, system runtime libraries, and an empty private /tmp. No host
  // home, credentials, network, writable host paths, or subprocess permission.
  const result = spawnSync(
    "/usr/bin/bwrap",
    [
      "--unshare-all",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
      "--ro-bind",
      "/usr",
      "/usr",
      "--ro-bind",
      "/lib",
      "/lib",
      "--ro-bind",
      "/lib64",
      "/lib64",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--tmpfs",
      "/tmp",
      "--ro-bind",
      workspace,
      "/work",
      "--ro-bind",
      process.execPath,
      "/runtime/node",
      "--ro-bind",
      verifier,
      "/oracle/verify.mjs",
      "--chdir",
      "/work",
      "/runtime/node",
      "--permission",
      "--allow-fs-read=/work",
      "--allow-fs-read=/oracle/verify.mjs",
      "/oracle/verify.mjs",
      "/work",
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
      env: { PATH: process.env.PATH ?? "", LANG: "C.UTF-8" },
    },
  );
  return {
    exit: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
    error: result.error?.message,
  };
};
const baseline = verify();
assert.equal(baseline.exit, 1, "Original buggy fixture must fail the independent verifier");
assert.match(baseline.stdout, /diamond/);

const { createSupervisedTask, getSupervisedTask } =
  await import("../../src/tasks/supervised-task.store.js");
const { startSupervisedTaskWorker } = await import("../../src/tasks/supervised-task.worker.js");
const { prepareSupervisedAgentRuntime, runSupervisedAgentAttempt } =
  await import("../../src/tasks/supervised-task.agent.js");
const { closeOpenClawStateDatabaseForTest } = await import("../../src/state/openclaw-state-db.js");
const { redactSensitiveText } = await import("../../src/logging/redact.js");
type Task = NonNullable<ReturnType<typeof getSupervisedTask>>;
const errors: string[] = [];
const decisions: Array<{ attempt: string; kind: string; owner: string }> = [];
const pending = new Set<Promise<unknown>>();
const owners: string[] = [];
const start = () => {
  const next = startSupervisedTaskWorker({
    runAttempt: async (task, context) => {
      const execution = runSupervisedAgentAttempt(task, context);
      pending.add(execution);
      try {
        const decision = await execution;
        decisions.push({
          attempt: task.attempt!.id,
          kind: decision.kind,
          owner: task.attempt!.ownerId,
        });
        return decision;
      } finally {
        pending.delete(execution);
      }
    },
    onError: (error) =>
      errors.push(
        redactSensitiveText(error instanceof Error ? error.message : String(error), {
          mode: "tools",
        }).slice(0, 2000),
      ),
    onChange: (task) =>
      console.log(
        JSON.stringify({ phase: task.phase, attempts: task.attempts, episode: task.episode }),
      ),
  });
  owners.push(next.ownerId);
  return next;
};
let worker: ReturnType<typeof start> | undefined;
let admitted: Task | undefined;
let waiting: Task | undefined;
let endpoint: Task | undefined;
let finalVerification: ReturnType<typeof verify> | undefined;
let passed = false;
const waitFor = async (predicate: () => boolean, deadline: number, description: string) => {
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`Deadline exceeded: ${description}`);
    }
    await delay(50);
  }
};
try {
  await prepareSupervisedAgentRuntime();
  worker = start();
  admitted = createSupervisedTask(
    {
      flowId: `coding-${randomUUID()}`,
      agentId: "poc",
      runtime,
      model,
      prompt: `Read SPEC.md and repair graph.mjs then planner.mjs in separate attempts. In THIS FIRST attempt, use file tools to read SPEC.md and BOTH modules, then IMPLEMENT and SAVE the complete graph.mjs repair. Leave planner.mjs unchanged. Only AFTER saving graph.mjs, return wait with wakeAt=${Date.now() + attemptTimeoutMs + 30_000} and next context instructing the replacement to implement planner.mjs. Returning wait without doing the first repair is a failed attempt. The second attempt must implement and save planner.mjs before reporting success. Host tests will independently judge correctness.`,
      goal: {
        objective:
          "Implement the specified dependency-aware batch planner across a supervisor replacement",
        success: [
          {
            id: "graph",
            description:
              "graph.mjs validates all graph invariants and returns independent dependency arrays",
          },
          {
            id: "planner",
            description:
              "planner.mjs produces deterministic capacity-bounded prior-round dependency schedules without input mutation",
          },
        ],
        partial: [],
      },
      policy: { deadlineAt: Date.now() + 600_000, maxAttempts: 4, attemptTimeoutMs },
    },
    worker.ownerId,
    Date.now(),
  );
  const flowId = admitted.flowId;
  await waitFor(
    () => {
      const row = getSupervisedTask(flowId);
      if (row?.endpoint) {
        throw new Error(`Expected durable handoff before endpoint, got ${row.phase}`);
      }
      if (row?.phase === "waiting") {
        waiting = row;
        return true;
      }
      return false;
    },
    admitted.policy.deadlineAt,
    "first attempt durable wait",
  );
  assert.ok(waiting);
  assert.equal(waiting.attempts, 1);
  assert.notEqual(readFileSync(path.join(workspace, "graph.mjs"), "utf8"), graphStub);
  assert.equal(
    readFileSync(path.join(workspace, "planner.mjs"), "utf8"),
    plannerStub,
    "First attempt must not perform the next step",
  );
  await waitFor(() => pending.size === 0, Date.now() + 30_000, "first runtime cleanup");
  // Allow the worker's promise finally to relinquish its local active slot.
  await delay(0);
  worker.stop();
  assert.deepEqual(
    getSupervisedTask(flowId),
    waiting,
    "Stopping an idle owner must preserve durable waiting work",
  );
  closeOpenClawStateDatabaseForTest();
  worker = start();
  assert.notEqual(owners[0], owners[1]);
  await waitFor(
    () => {
      const row = getSupervisedTask(flowId);
      if (row?.endpoint) {
        endpoint = row;
        return true;
      }
      if (worker?.stopped) {
        throw new Error("Replacement supervisor stopped before endpoint");
      }
      return false;
    },
    admitted.policy.deadlineAt + 5000,
    "replacement completes coding task",
  );
  assert.equal(endpoint?.phase, "succeeded");
  assert.equal(endpoint?.attempts, 2);
  assert.equal(decisions[0]?.kind, "wait");
  assert.equal(decisions[1]?.kind, "succeeded");
  assert.notEqual(decisions[0]?.owner, decisions[1]?.owner);
  assert.equal(digest(verifier), verifierHash, "Model must not alter the host verifier");
  finalVerification = verify();
  assert.equal(finalVerification.exit, 0, finalVerification.stdout + finalVerification.stderr);
  assert.deepEqual(JSON.parse(finalVerification.stdout), { cases: 84, failures: [] });
  assert.equal(errors.length, 0);
  passed = true;
} catch (error) {
  errors.push(
    redactSensitiveText(error instanceof Error ? error.message : String(error), {
      mode: "tools",
    }).slice(0, 4000),
  );
  process.exitCode = 1;
} finally {
  worker?.stop();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      (async () => {
        await Promise.allSettled(pending);
        const { disposeRegisteredAgentHarnesses } =
          await import("../../src/agents/harness/registry.js");
        await disposeRegisteredAgentHarnesses();
        const { disposeAllSessionMcpRuntimes } =
          await import("../../src/agents/agent-bundle-mcp-manager-api.js");
        await disposeAllSessionMcpRuntimes();
        const { closeMcpLoopbackServer } = await import("../../src/gateway/mcp-http.js");
        await closeMcpLoopbackServer();
      })(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Runtime cleanup exceeded 30 seconds")), 30_000);
      }),
    ]);
  } catch {
    errors.push("Runtime cleanup failed or exceeded deadline");
    passed = false;
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
  }
  closeOpenClawStateDatabaseForTest();
  mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
  writeFileSync(
    outputPath,
    JSON.stringify(
      {
        proof: "supervised-task-coding-and-replacement",
        runtime,
        model,
        passed,
        isolatedRoot: root,
        verifierHash,
        baseline,
        finalVerification,
        owners,
        decisions,
        waiting,
        endpoint,
        errors,
      },
      null,
      2,
    ),
  );
}
