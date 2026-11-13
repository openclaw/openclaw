/**
 * Compare GitHub action owners with synthetic GitHub I/O and real authority/storage.
 * Freeze once with local-workspace-checkpoint-measure.ts --freeze-source <capsule>
 * --revision <base>, then run this script with --capsule <capsule> --output <new-dir>.
 * --counts records work; --allocation samples allocation separately from timing.
 * --publication measures the durable publication coordinator and real local Git.
 * Baseline and candidate function bodies come from Git and the working tree. Both
 * execute in the same process, interleaved A/A then A/B, through the registered
 * action handler or publication coordinator. Observers do not change authority.
 * --lineage records baseline A/A at depth 1/4/16/64 through real principal and
 * admitted-run owners. --large-fixture <root> reflinks a completed synthetic
 * state/ database and workspace/ into the isolated test fixture (requires btrfs).
 * This is boundary/owner evidence, not a running Gateway transport measurement.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    capsule: { type: "string" },
    output: { type: "string" },
    counts: { type: "boolean" },
    allocation: { type: "boolean" },
    "cpu-profile": { type: "boolean" },
    publication: { type: "boolean" },
    lineage: { type: "boolean" },
    "large-fixture": { type: "string" },
    sessions: { type: "string", default: "2000" },
    runs: { type: "string", default: "20000" },
    roles: { type: "string", default: "2000" },
    pairs: { type: "string", default: "5" },
  },
});
assert(values.capsule && values.output, "--capsule and --output are required");
assert(
  [values.counts, values.allocation, values["cpu-profile"]].filter(Boolean).length <= 1,
  "Separate census, allocation and CPU profile runs",
);
const root = fileURLToPath(new URL("../../", import.meta.url));
const capsule = path.resolve(values.capsule);
assert(capsule !== root);
const manifest = JSON.parse(fs.readFileSync(path.join(capsule, "checkpoint-source.json"), "utf8"));
const pairs = Number(values.pairs);
assert(Number.isInteger(pairs) && pairs > 0, "--pairs must be a positive integer");
const readSource = (relative: string) =>
  values.lineage
    ? execFileSync("git", ["show", `${manifest.revision}:${relative}`], {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 8 * 1024 ** 2,
      })
    : fs.readFileSync(path.join(root, relative), "utf8");
const output = path.resolve(values.output);
fs.mkdirSync(output);
const key = 'globalThis[Symbol.for("openclaw.benchmark.githubActionScope")]';
const variants: [string, string, string][] = values.lineage
  ? []
  : [
      ["src/gateway/github-publication-actions.ts", "performSessionGitHubAction", ""],
      [
        "src/gateway/github-publication-action-target.ts",
        "preparePublishingSession",
        "\nexport function pullRequestState",
      ],
      [
        "src/gateway/github-publication-requester.ts",
        "prepareRequesterPolicy",
        "\nfunction prepareRequesterSource",
      ],
      [
        "src/gateway/github-publication-inspect.ts",
        "readOwnGitHubPullRequest",
        "\nexport async function performSessionGitHubInspection",
      ],
      [
        "src/agents/subagents/registry/subagent-registry-read.ts",
        "listSubagentRunsForRequester",
        "\nexport async function getLatestSubagentRunByChildSessionKey",
      ],
    ];
const hashes: Record<string, { baseline: string; candidate: string }> = {};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function region(source: string, name: string, end: string) {
  const declaration = new RegExp(`^(export )?(async )?function ${name}\\(`, "m");
  const match = declaration.exec(source);
  assert(match, name);
  const finish = end ? source.indexOf(end, match.index) : source.length;
  assert(finish > match.index, name);
  return {
    start: match.index,
    finish,
    body: source.slice(match.index, finish),
    exported: Boolean(match[1]),
  };
}
for (const [relative, name, end] of variants) {
  const baseline = execFileSync("git", ["show", `${manifest.revision}:${relative}`], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 ** 2,
  });
  const candidate = fs.readFileSync(path.join(root, relative), "utf8");
  const a = region(baseline, name, end),
    b = region(candidate, name, end);
  hashes[relative] = { baseline: hash(a.body), candidate: hash(b.body) };
  const rename = (body: string, suffix: string) =>
    body.replace(/^export /, "").replace(`function ${name}(`, `function ${name}${suffix}(`);
  const wrapper = `${b.exported ? "export " : ""}function ${name}(...args: Parameters<typeof ${name}Candidate>): ReturnType<typeof ${name}Candidate> {
    return (${key}?.arm === "candidate" ? ${name}Candidate : ${name}Baseline)(...args);
  }\n`;
  fs.writeFileSync(
    path.join(capsule, relative),
    candidate.slice(0, b.start) +
      rename(a.body, "Baseline") +
      rename(b.body, "Candidate") +
      wrapper +
      candidate.slice(b.finish),
  );
}
// Candidate's optional prepared-index parameter preserves the baseline's full-index path.
const query = "src/agents/subagents/registry/subagent-registry-queries.ts";
fs.writeFileSync(path.join(capsule, query), readSource(query));
const counters: [string, string, string][] = [
  [
    "src/plugins/plugin-instance.ts",
    "private enter<T>(token: object, run: () => T, held?: { registry?: PluginRegistry }): T {",
    "plugin.enter",
  ],
  [
    "src/plugins/plugin-instance.ts",
    "  ): T {\n    const current = this.activeCall();\n    if (current) {",
    "plugin.runInRegistry",
  ],
  [
    "src/plugins/runtime/gateway-request-scope.ts",
    "): T {\n  const current = getPluginExecutionFrame();",
    "plugin.gatewayScope",
  ],
  [
    "src/gateway/github-publication-action-target.ts",
    "  const assertSessions = () => {",
    "action.sessions",
  ],
  [
    "src/gateway/github-publication-actions.ts",
    "  const assertRequester = () => {",
    "action.requester",
  ],
  [
    "src/gateway/github-publication-requester.ts",
    "    const assertInvocationCurrent = () => {",
    "requester.invocation",
  ],
  [
    "src/gateway/github-publication-requester.ts",
    "  const assertPrepared = (config: OpenClawConfig) => {",
    "requester.policy",
  ],
  [
    "src/config/sessions/session-source-authority.ts",
    "  const assertSources = () => {",
    "authority.sources",
  ],
  [
    "src/gateway/operator-run-authority.ts",
    "  const assertRoleCurrent = () => {",
    "authority.role",
  ],
  [
    "src/gateway/operator-role-policy.ts",
    '): { effectiveRole?: string; roleSource: "assigned" | "githubLogin" | "default" } {',
    "role.selection",
  ],
  [
    "src/gateway/session-sharing-read.ts",
    "  const operatorActor = resolveGatewayOperatorRoleActor(params.client);\n  const identity = sharingIdentity(params.client, operatorActor);",
    "sharing.filter",
  ],
  [query, "): LatestSubagentRunReadIndex<T> {", "runs.index"],
];
const rewritten = new Set(variants.map(([relative]) => relative).concat(query));
for (const [relative] of counters) {
  if (!rewritten.has(relative)) {
    fs.writeFileSync(path.join(capsule, relative), readSource(relative));
    rewritten.add(relative);
  }
}
if (values.counts) {
  for (const [relative, needle, counter] of counters) {
    const file = path.join(capsule, relative),
      source = fs.readFileSync(file, "utf8");
    assert(source.includes(needle), `${relative}: ${counter}`);
    fs.writeFileSync(
      file,
      source.replaceAll(needle, `${needle}\n${key}?.count?.(${JSON.stringify(counter)});`),
    );
  }
}

if (values["large-fixture"]) {
  assert(values.lineage, "--large-fixture requires --lineage");
  const fixture = path.resolve(values["large-fixture"]);
  const db = path.join(fixture, "state/agents/main/agent/openclaw-agent.sqlite");
  assert(fs.statSync(db).size >= 35 * 1024 ** 3, "Expected completed synthetic fixture");
  const support = path.join(capsule, "src/gateway/github-publication.test-support.ts");
  const original = readSource("src/gateway/github-publication.test-support.ts");
  const anchor = '    root = tempDirs.make("openclaw-publication-");';
  assert(original.includes(anchor));
  fs.writeFileSync(
    support,
    original.replace(
      anchor,
      anchor +
        `
    await fs.mkdir(path.join(root, "agents/main/agent"), {recursive: true});
    (await import("../infra/sqlite-wal-filesystem.js")).prepareSqliteDatabaseDirectory(path.join(root, "agents/main/agent/openclaw-agent.sqlite"));
    await fs.copyFile(${JSON.stringify(db)}, path.join(root, "agents/main/agent/openclaw-agent.sqlite"), fs.constants.COPYFILE_FICLONE_FORCE);`,
    ),
  );
}

const fixtureTest = `// oxfmt-ignore
import { createPublicationActionFixture, publicationCheckpoint } from "./github-publication-actions.test-support.js";
import { it, expect } from "vitest";
import fs from "node:fs/promises";
import { loadavg } from "node:os";
import { Session } from "node:inspector/promises";
import { startVisitorPublicationFixture, createRequesterPublicationFixture, capturePublicationGuest } from "./github-publication-requester.test-support.js";
import { currentGitHubPublicationConfig } from "./github-publication-availability.js";
import { prepareGatewayConnectOperatorAccess } from "./server/ws-connection/connect-operator-access.js";
import { installGitHubPublicationTestHarness } from "./github-publication.test-support.js";
import { syncCanonicalGitHubIdentity } from "../state/user-profile-writes.js";
import { upsertSessionEntryCore } from "../config/sessions/session-accessor.js";
import { setRuntimeConfigSnapshot } from "../config/config.js";
import { createSubagentRunRecord } from "../agents/subagent-test-fixtures.test-helpers.js";
import { listSubagentRunsForRequester } from "../agents/subagents/registry/subagent-registry-read.js";
import { subagentRuns } from "../agents/subagents/registry/subagent-registry-memory.js";
import { prepareSessionPrincipalRunAuthority } from "./session-sharing-authorization-async.js";
import { prepareSystemAgentRunAdmission, resolveAdmittedRunActiveAssertion, bindOperatorModelExecution } from "../agents/admitted-run-context.js";
import { SESSION_KEY } from "./github-publication.test-support.js";
import { pruneStaleControlPlaneBuckets } from "./control-plane-rate-limit.js";
installGitHubPublicationTestHarness({creatorEmail: "publication-guest@example.test", sandbox: "required", realWorktree: true});
it("measures actions at the registered boundary with a large authority inventory", async () => {
 const publication=process.env.LANE2450_PUBLICATION==="1";
 const lineage=process.env.LANE2458_LINEAGE==="1";
 const f = publication ? await createRequesterPublicationFixture(publicationCheckpoint,"local") : await createPublicationActionFixture();
 ${values["large-fixture"] ? `await fs.cp(${JSON.stringify(path.join(path.resolve(values["large-fixture"]), "workspace"))},f.local.cwd+"/large-fixture",{recursive:true,mode:fs.constants.COPYFILE_FICLONE_FORCE});` : ""}
 await syncCanonicalGitHubIdentity({identity:{accountId:101,login:"contributor"},authenticationAlias:{kind:"email",email:"publication-guest@example.test"}});
 const sessions=Number(process.env.LANE2450_SESSIONS ?? 2000);
 const runs=Number(process.env.LANE2450_RUNS ?? 20000);
 const roles=Number(process.env.LANE2450_ROLES ?? 2000);
 for(let i=0;i<(lineage?0:sessions);i++) await upsertSessionEntryCore({agentId:"main",sessionKey:\`agent:main:fixture:\${i}\`},{sessionId:\`fixture-\${i}\`,updatedAt:1,createdActor:{type:"human",source:"profile",id:f.guestProfile}});
 for(let i=0;i<runs;i++) subagentRuns.set(\`fixture-\${i}\`,createSubagentRunRecord({runId:\`fixture-\${i}\`,childSessionKey:\`agent:main:subagent:fixture-\${i}\`,requesterSessionKey:\`agent:main:fixture:\${i%sessions}\`,completionRequesterSessionId:\`fixture-\${i%sessions}\`,requesterDisplayKey:"fixture",task:"fixture",cleanup:"keep",createdAt:i+1,endedAt:i+2}));
 await using visitors = await startVisitorPublicationFixture(f);
 const current=currentGitHubPublicationConfig();
 const config={...current,agents:{...current.agents,defaults:{...current.agents?.defaults,model:"fixture/model"}},gateway:{...current.gateway,roles:{...current.gateway!.roles!,assignments:{byGithubLogin:Object.fromEntries([...Array.from({length:roles},(_,i)=>[\`fixture-\${i}\`,"guest"]),["contributor","guest"]])}}}};
 setRuntimeConfigSnapshot(config);
 prepareGatewayConnectOperatorAccess(f.guestSource.client);
 const rows=[];
 const cpuProfile=process.env.LANE2458_CPU_PROFILE==="1";
 const heap=process.env.LANE2450_ALLOC==="1" || cpuProfile ? new Session():undefined;heap?.connect();
 if(cpuProfile)await heap.post("Profiler.enable");
 const state = {arm:"baseline",count:undefined};
 globalThis[Symbol.for("openclaw.benchmark.githubActionScope")]=state;
 const pairs=[{kind:"warmup",arms:lineage?["baseline","baseline"]:["baseline","candidate"]},...Array.from({length:${pairs}},()=>({kind:"AA",arms:["baseline","baseline"]})),...(lineage ? [] : Array.from({length:${pairs}},(_,i)=>({kind:"AB",arms:i%2?["candidate","baseline"]:["baseline","candidate"]})))];
 let i=0;
 for(const depth of lineage ? [1,4,16,64] : [0]) {
 const releases=[];
 let parent;
 let principal;
 let active;
 for(let level=0;level<depth;level++) {
  const sessionKey=\`agent:main:lineage-\${depth}-\${level}\`;
  const sessionId=\`lineage-\${depth}-\${level}\`;
  await upsertSessionEntryCore({agentId:"main",sessionKey},{sessionId,updatedAt:1,sandbox:"required",createdActor:{type:"human",source:"profile",id:f.guestProfile}});
  principal=await prepareSessionPrincipalRunAuthority({context:f.guestSource.context,agentId:"main",sessionKey,sessionId,profileId:f.guestProfile,assertCurrent:parent});
  releases.push(principal.release);
  const admission=prepareSystemAgentRunAdmission(config,\`lineage-run-\${depth}-\${level}\`,"main","lineage",undefined,principal.authority);
  releases.push(admission.close);
  active=resolveAdmittedRunActiveAssertion(await admission.admit("embedded"));
  expect(active).toBeTypeOf("function");
  parent=active;
 }
 const model=lineage ? bindOperatorModelExecution(principal.authority,{provider:"fixture",model:"model"}):undefined;
 if(model)releases.push(model.release);
 const invocation=lineage ? {client:{...f.guestSource.client,internal:{...f.guestSource.client.internal,operatorRunAuthority:principal.authority}}}:undefined;
 try {
 if(cpuProfile)await heap.post("Profiler.start");
 for(const [pair,control] of pairs.entries()) for(const [slot,arm] of control.arms.entries()) for(const action of publication ? ["publish"] : lineage ? ["assert", "model", "edit_read", "edit"] : ["edit_read","edit","requester_runs"]) {
  // Expire the synthetic request window outside measurement; normal RPC admission still runs.
  pruneStaleControlPlaneBuckets(Date.now()+360000);
  i++;state.arm=arm;
  if(publication)await fs.writeFile(f.local!.cwd+"/artifact.txt",\`Publication fixture \${i}\\n\`);
  const counts={};
  if(process.env.LANE2450_COUNTS==="1")state.count=(key)=>counts[key]=(counts[key]??0)+1;
  let maxSegment=0,last=performance.now();
  const synchronous=action==="assert" || action==="model";
  const timer=synchronous ? undefined : setInterval(()=>{const now=performance.now();maxSegment=Math.max(maxSegment,now-last);last=now;},1);
  const allocating=process.env.LANE2450_ALLOC==="1";
  if(allocating)await heap!.post("HeapProfiler.startSampling",{samplingInterval:32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
  const cpu=process.threadCpuUsage(); const started=performance.now();
  const iterations=synchronous ? Math.ceil(1024/depth) : 1;
  let result;
  for(let iteration=0;iteration<iterations;iteration++){
  const callStarted=performance.now();
  result=action==="assert" ? active() : action==="model" ? model.assertCurrent() : publication ? await (async()=>{const admitted=await capturePublicationGuest(f);try{return await f.coordinator.requestForSessionV2(f.request(\`benchmark-\${i}\`,admitted.requester));}finally{admitted.release();}})() : action==="requester_runs" ? listSubagentRunsForRequester("agent:main:fixture:0",{requesterSessionId:"fixture-0"}) : await f.invoke("guest",{action:"edit",...f.expected,...(action==="edit"?{title:\`Fixture \${i}\`,expectedTitle:f.state.title}:{})},SESSION_KEY,invocation);
  if(synchronous)maxSegment=Math.max(maxSegment,performance.now()-callStarted);
  }
  const wallMs=performance.now()-started;const usage=process.threadCpuUsage(cpu);
  if(timer){maxSegment=Math.max(maxSegment,performance.now()-last);clearInterval(timer);}
  let allocatedBytes;
  if(allocating){const {profile}=await heap!.post("HeapProfiler.stopSampling");const sum=n=>n.selfSize+n.children.reduce((s,c)=>s+sum(c),0);allocatedBytes=sum(profile.head);}
  state.count=undefined;
  if(synchronous)expect(result).toBeUndefined();
  else if(publication)expect(result.status).toBe("published");
  else if(action==="requester_runs")expect(result).toHaveLength(Math.ceil(runs/sessions));
  else expect(result.details).toHaveProperty("headCommit",f.publication.headCommit);
  for(const name of Object.keys(counts))counts[name]/=iterations;
  const row={i,pair,slot,depth,iterations,control:control.kind,arm,action,wallMs:wallMs/iterations,cpuMs:(usage.user+usage.system)/1000/iterations,maxSegment,allocatedBytes:allocatedBytes===undefined?undefined:allocatedBytes/iterations,counts,load:loadavg()};rows.push(row);console.log(JSON.stringify(row));
 }
 if(cpuProfile){const {profile}=await heap.post("Profiler.stop");await fs.writeFile(process.env.LANE2450_OUTPUT!+".depth"+depth+".cpuprofile",JSON.stringify(profile));}
 } finally {for(const release of releases.toReversed())release();}
 }
 heap?.disconnect();subagentRuns.clear();
 delete globalThis[Symbol.for("openclaw.benchmark.githubActionScope")];
 await fs.writeFile(process.env.LANE2450_OUTPUT!,JSON.stringify({sessions,runs,roles,rows},null,2));
},600000);
`;
const testPath = "src/gateway/github-publication-actions.test.ts";
fs.writeFileSync(path.join(capsule, testPath), fixtureTest);
fs.writeFileSync(
  path.join(output, "source.json"),
  JSON.stringify(
    {
      revision: manifest.revision,
      pairs,
      hashes,
      testSha256: hash(fixtureTest),
      counts: Boolean(values.counts),
      allocation: Boolean(values.allocation),
      cpuProfile: Boolean(values["cpu-profile"]),
      publication: Boolean(values.publication),
      lineage: Boolean(values.lineage),
      largeFixture: values["large-fixture"],
      acceptance: values.lineage
        ? "Real principal/session/admitted owners at depth 1/4/16/64; A/A pairs after warmup, CPU and allocation sampled separately. Run pinned baseline/candidate capsules interleaved for at least five A/B pairs. A candidate must reduce plugin entries to a constant per principal/source, improve depth-16/64 owner CPU and allocation at least 20%, and not regress depth-1/action latency or max segment by 20%."
        : "Warm edit CPU and allocation must improve at least 20%; no user-facing metric may regress 20%. Census confirms fewer redundant scopes/assertions; A/A controls bound noise. Requester lookup must stop full-index builds.",
    },
    null,
    2,
  ),
);
const log = fs.openSync(path.join(output, "run.log"), "w");
try {
  const result = spawnSync(
    process.execPath,
    ["scripts/run-vitest.mjs", testPath, "--maxWorkers=1"],
    {
      cwd: capsule,
      stdio: ["ignore", log, log],
      env: {
        ...process.env,
        OPENCLAW_VITEST_RUNTIME: "node",
        LANE2458_CPU_PROFILE: values["cpu-profile"] ? "1" : "0",
        LANE2458_LINEAGE: values.lineage ? "1" : "0",
        LANE2450_SESSIONS: values.sessions,
        LANE2450_RUNS: values.runs,
        LANE2450_ROLES: values.roles,
        LANE2450_COUNTS: values.counts ? "1" : "0",
        LANE2450_ALLOC: values.allocation ? "1" : "0",
        LANE2450_PUBLICATION: values.publication ? "1" : "0",
        LANE2450_OUTPUT: path.join(output, "measurements.json"),
        OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(capsule, ".github-action-measure-cache"),
      },
    },
  );
  console.log(JSON.stringify({ output, exitCode: result.status, error: result.error?.message }));
  process.exitCode = result.status ?? 1;
} finally {
  fs.closeSync(log);
}
