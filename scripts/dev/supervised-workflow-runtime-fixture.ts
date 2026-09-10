/** Host-owned workload/oracle bytes. Never import model-written modules in the proof host. */
export const graphStub =
  "export function validateJobs(jobs) { return new Map(jobs.map(j => [j.id, j.deps])); }\n";
export const plannerStub =
  "export function planJobs(jobs, capacity) { return [jobs.map(j => j.id)]; }\n";
export const expectedArtifact = '{"batches":[["a"],["b","c"],["d"]]}\n';
export const specification = `Implement a dependency-aware batch planner in graph.mjs and planner.mjs.
graph.mjs exports validateJobs(jobs). A job is {id: nonempty string, deps: array of job ids}.
Return a Map keyed by id with independent copies of dependency arrays. Never mutate inputs.
Reject nonarrays, malformed jobs/deps, duplicate ids/deps, unknown dependencies, self-dependencies and cycles by throwing Error.
planner.mjs imports validateJobs and exports planJobs(jobs, capacity).
Capacity must be a positive safe integer. Return an array of batches (arrays of ids).
In each round find ALL jobs whose dependencies completed in PRIOR rounds, sort by JavaScript default string ordering, and take the first capacity ids.
Jobs depending on a job in the current batch cannot run in that batch. Empty jobs gives [].
Reject invalid graphs/capacities. Results must not depend on input ordering and inputs must remain unchanged.
No dependencies, network, process APIs, shell, subprocesses, automations or changes outside graph.mjs, planner.mjs and plan.json.
Deliver plan.json containing exactly {"batches":[["a"],["b","c"],["d"]]} followed by one newline.
That artifact is the capacity-2 schedule for [{"id":"d","deps":["b","c"]},{"id":"c","deps":["a"]},{"id":"b","deps":["a"]},{"id":"a","deps":[]}].
Use only OpenClaw file tools. Request host operations to execute checks and independent review.
FIRST attempt: inspect the specification and source, change NO files, then request command profile oracle with key baseline.
The baseline is intentionally broken. Its failed receipt is expected; it is not a reason to stop or ask for input.
After that receipt, implement both modules and plan.json and request oracle using a NEW operation key.
After passing checks, request profile independent-review (kind review). Repair any reported defects and re-request both profiles with new keys after any source change.
Only after both pass on the same final source return succeeded with evidence for criteria checks, review and artifact.
Do not claim you ran shell commands yourself, bypass the oracle, or interpret the expected initial failure as a terminal task failure.
`;

// This script is copied to a frozen host path outside every model workspace.
// Its only execution site is the real networkless, cgroup-bounded command adapter.
// Delay opens an observable process-replacement window; it is not a test retry.
export const oracleSource = String.raw`
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
await delay(20_000);
const { validateJobs } = await import('file:///work/graph.mjs');
const { planJobs } = await import('file:///work/planner.mjs');
const failures = []; let cases = 0;
function check(name, fn) { cases++; try { fn(); } catch { failures.push(name); } }
check('empty', () => assert.deepEqual(planJobs([], 2), []));
const diamond = [{id:'d',deps:['b','c']},{id:'c',deps:['a']},{id:'b',deps:['a']},{id:'a',deps:[]}];
check('diamond', () => assert.deepEqual(planJobs(diamond,2), [['a'],['b','c'],['d']]));
check('round barrier', () => assert.deepEqual(planJobs([{id:'a',deps:[]},{id:'b',deps:['a']},{id:'c',deps:[]}],3), [['a','c'],['b']]));
check('lexical capacity', () => assert.deepEqual(planJobs([{id:'z',deps:[]},{id:'10',deps:[]},{id:'2',deps:[]},{id:'A',deps:[]}],2), [['10','2'],['A','z']]));
for (const bad of [0,-1,1.2,NaN,Infinity,'2',Number.MAX_SAFE_INTEGER+1]) check('invalid capacity '+String(bad), () => assert.throws(() => planJobs([],bad)));
const badGraphs = [null, {}, [{id:'',deps:[]}], [{id:'a',deps:'b'}], [{id:1,deps:[]}], [{id:'a',deps:[2]}], [{id:'a',deps:[]},{id:'a',deps:[]}], [{id:'a',deps:['b','b']},{id:'b',deps:[]}], [{id:'a',deps:['missing']}], [{id:'a',deps:['a']}], [{id:'a',deps:['b']},{id:'b',deps:['a']}], [{id:'ok',deps:[]},{id:'a',deps:['b']},{id:'b',deps:['c']},{id:'c',deps:['a']}]];
badGraphs.forEach((g,i) => check('reject graph '+i, () => { assert.throws(() => validateJobs(g)); assert.throws(() => planJobs(g,2)); }));
check('defensive copy', () => { const g = structuredClone(diamond); const original = JSON.stringify(g); const m = validateJobs(g); assert.ok(m instanceof Map); assert.deepEqual([...m.keys()].sort(),['a','b','c','d']); m.get('d').push('other'); assert.equal(JSON.stringify(g),original); });
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
check('delivered schedule', () => assert.deepEqual(JSON.parse(readFileSync('/work/plan.json','utf8')), {batches:[['a'],['b','c'],['d']]}));
console.log(JSON.stringify({cases, failures})); process.exitCode = failures.length ? 1 : 0;
`;
