/**
 * Compare GitHub action owners with synthetic GitHub I/O and real authority/storage.
 * Freeze once with local-workspace-checkpoint-measure.ts --freeze-source <capsule>
 * --revision <base>, then run this script with --capsule <capsule> --output <new-dir>.
 * --counts records work; --allocation samples allocation separately from timing.
 * --publication measures the durable publication coordinator and real local Git.
 * Baseline and candidate function bodies come from Git and the working tree. Both
 * execute in the same process, interleaved A/A then A/B, through the registered
 * action handler or publication coordinator. Observers do not change authority.
 * This is boundary/owner evidence, not a running production Gateway or btrfs proof.
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
    publication: { type: "boolean" },
    sessions: { type: "string", default: "2000" },
    runs: { type: "string", default: "20000" },
    roles: { type: "string", default: "2000" },
  },
});
assert(values.capsule && values.output, "--capsule and --output are required");
assert(!(values.counts && values.allocation), "Separate census and allocation runs");
const root = fileURLToPath(new URL("../../", import.meta.url));
const capsule = path.resolve(values.capsule);
assert(capsule !== root);
const manifest = JSON.parse(fs.readFileSync(path.join(capsule, "checkpoint-source.json"), "utf8"));
const output = path.resolve(values.output);
fs.mkdirSync(output);
const key = 'globalThis[Symbol.for("openclaw.benchmark.githubActionScope")]';
const variants: [string, string, string][] = [
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
fs.copyFileSync(path.join(root, query), path.join(capsule, query));
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
    fs.copyFileSync(path.join(root, relative), path.join(capsule, relative));
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
import { pruneStaleControlPlaneBuckets } from "./control-plane-rate-limit.js";
installGitHubPublicationTestHarness({creatorEmail: "publication-guest@example.test", sandbox: "required", realWorktree: true});
it("measures actions at the registered boundary with a large authority inventory", async () => {
 const publication=process.env.LANE2450_PUBLICATION==="1";
 const f = publication ? await createRequesterPublicationFixture(publicationCheckpoint,"local") : await createPublicationActionFixture();
 await syncCanonicalGitHubIdentity({identity:{accountId:101,login:"contributor"},authenticationAlias:{kind:"email",email:"publication-guest@example.test"}});
 const sessions=Number(process.env.LANE2450_SESSIONS ?? 2000);
 const runs=Number(process.env.LANE2450_RUNS ?? 20000);
 const roles=Number(process.env.LANE2450_ROLES ?? 2000);
 for(let i=0;i<sessions;i++) await upsertSessionEntryCore({agentId:"main",sessionKey:\`agent:main:fixture:\${i}\`},{sessionId:\`fixture-\${i}\`,updatedAt:1,createdActor:{type:"human",source:"profile",id:f.guestProfile}});
 for(let i=0;i<runs;i++) subagentRuns.set(\`fixture-\${i}\`,createSubagentRunRecord({runId:\`fixture-\${i}\`,childSessionKey:\`agent:main:subagent:fixture-\${i}\`,requesterSessionKey:\`agent:main:fixture:\${i%sessions}\`,completionRequesterSessionId:\`fixture-\${i%sessions}\`,requesterDisplayKey:"fixture",task:"fixture",cleanup:"keep",createdAt:i+1,endedAt:i+2}));
 await using visitors = await startVisitorPublicationFixture(f);
 const current=currentGitHubPublicationConfig();
 const config={...current,gateway:{...current.gateway,roles:{...current.gateway!.roles!,assignments:{byGithubLogin:Object.fromEntries([...Array.from({length:roles},(_,i)=>[\`fixture-\${i}\`,"guest"]),["contributor","guest"]])}}}};
 setRuntimeConfigSnapshot(config);
 prepareGatewayConnectOperatorAccess(f.guestSource.client);
 const rows=[];
 const heap=process.env.LANE2450_ALLOC==="1" ? new Session():undefined;heap?.connect();
 const state = {arm:"baseline",count:undefined};
 globalThis[Symbol.for("openclaw.benchmark.githubActionScope")]=state;
 const pairs=[{kind:"warmup",arms:["baseline","candidate"]},...Array.from({length:5},()=>({kind:"AA",arms:["baseline","baseline"]})),...Array.from({length:5},(_,i)=>({kind:"AB",arms:i%2?["candidate","baseline"]:["baseline","candidate"]}))];
 let i=0;
 for(const [pair,control] of pairs.entries()) for(const [slot,arm] of control.arms.entries()) for(const action of publication ? ["publish"] : ["edit_read","edit","requester_runs"]) {
  // Expire the synthetic request window outside measurement; normal RPC admission still runs.
  pruneStaleControlPlaneBuckets(Date.now()+360000);
  i++;state.arm=arm;
  if(publication)await fs.writeFile(f.local!.cwd+"/artifact.txt",\`Publication fixture \${i}\\n\`);
  const counts={};
  if(process.env.LANE2450_COUNTS==="1")state.count=(key)=>counts[key]=(counts[key]??0)+1;
  let maxSegment=0,last=performance.now();
  const timer=setInterval(()=>{const now=performance.now();maxSegment=Math.max(maxSegment,now-last);last=now;},1);
  const allocating=process.env.LANE2450_ALLOC==="1";
  if(allocating)await heap!.post("HeapProfiler.startSampling",{samplingInterval:32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});
  const cpu=process.threadCpuUsage(); const started=performance.now();
  const result=publication ? await (async()=>{const admitted=await capturePublicationGuest(f);try{return await f.coordinator.requestForSessionV2(f.request(\`benchmark-\${i}\`,admitted.requester));}finally{admitted.release();}})() : action==="requester_runs" ? listSubagentRunsForRequester("agent:main:fixture:0",{requesterSessionId:"fixture-0"}) : await f.invoke("guest",{action:"edit",...f.expected,...(action==="edit"?{title:\`Fixture \${i}\`,expectedTitle:f.state.title}:{})});
  const wallMs=performance.now()-started;const usage=process.threadCpuUsage(cpu);
  maxSegment=Math.max(maxSegment,performance.now()-last);clearInterval(timer);
  let allocatedBytes;
  if(allocating){const {profile}=await heap!.post("HeapProfiler.stopSampling");const sum=n=>n.selfSize+n.children.reduce((s,c)=>s+sum(c),0);allocatedBytes=sum(profile.head);}
  state.count=undefined;
  if(publication)expect(result.status).toBe("published");
  else if(action==="requester_runs")expect(result).toHaveLength(Math.ceil(runs/sessions));
  else expect(result.details).toHaveProperty("headCommit",f.publication.headCommit);
  const row={i,pair,slot,control:control.kind,arm,action,wallMs,cpuMs:(usage.user+usage.system)/1000,maxSegment,allocatedBytes,counts,load:loadavg()};rows.push(row);console.log(JSON.stringify(row));
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
      hashes,
      testSha256: hash(fixtureTest),
      counts: Boolean(values.counts),
      allocation: Boolean(values.allocation),
      publication: Boolean(values.publication),
      acceptance:
        "Warm edit CPU and allocation must improve at least 20%; no user-facing metric may regress 20%. Census confirms fewer redundant scopes/assertions; A/A controls bound noise. Requester lookup must stop full-index builds.",
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
