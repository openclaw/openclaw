import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import test from "node:test";

// These are exact production functions, evaluated with real fs/SQLite imports.
// No lifecycle state, start claim, procfs admission, or acceptance permission is fabricated.
const library = readFileSync(join(import.meta.dirname, "release-lib.mjs"), "utf8");
function functionSource(name) {
  const start = library.indexOf("function " + name + "(");
  assert(start >= 0, name);
  const end = library.indexOf("\nfunction ", start + 1);
  assert(end > start, name);
  return library.slice(start, end);
}
const names = ["reject", "identity", "suspensionObject", "databaseRead", "retainedRepairAcceptanceProject", "retainedRepairAcceptanceCheckout"];
const exact = new Function("lstatSync", "isAbsolute", "realpathSync", "DatabaseSync", "isDeepStrictEqual",
  names.map(functionSource).join("\n") + "\nreturn {retainedRepairAcceptanceProject,retainedRepairAcceptanceCheckout};"
)(lstatSync, isAbsolute, realpathSync, DatabaseSync, isDeepStrictEqual);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const checkoutPayload = JSON.stringify({ projectId: "openclaw", agentId: "roboclaw" });
const goodProof = () => ({ method: "projects.checkoutOptions", params: JSON.parse(checkoutPayload), response: { current: true, worktree: false } });

test("native registry resolves original openclaw without profile changes or target-C/pristine requirements", t => {
  const root = mkdtempSync(join(tmpdir(), "retained-project-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const repoRoot = join(root, "project"); mkdirSync(repoRoot);
  const git = (...args) => { const r=spawnSync("git", ["-C",repoRoot,...args], {encoding:"utf8",env:{PATH:process.env.PATH,HOME:root,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"/dev/null"}}); assert.equal(r.status,0,r.stderr);return r.stdout.trim(); };
  git("init");git("-c","user.name=Fixture","-c","user.email=fixture@example.invalid","commit","--allow-empty","-m","existing project, not deployment C");
  writeFileSync(join(repoRoot,"uncommitted"),"preserve\n");writeFileSync(join(repoRoot,".gitignore"),"ignored-output\n");writeFileSync(join(repoRoot,"ignored-output"),"preserve ignored\n");
  const beforeHead=git("rev-parse","HEAD"), beforeStatus=git("status","--porcelain=v1","--ignored=matching");
  const stateDatabase=join(root,"state.sqlite"), db=new DatabaseSync(stateDatabase);
  db.exec("CREATE TABLE projects(id TEXT PRIMARY KEY,repo_root TEXT,source TEXT,origin_url TEXT)");
  db.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("openclaw",repoRoot,"registered","https://example.invalid/original.git");
  db.prepare("INSERT INTO projects VALUES(?,?,?,?)").run("other",root,"cloned",null);db.close();
  const beforeDatabase=hash(readFileSync(stateDatabase)), beforeProfile=process.env.OPENCLAW_TEAM_OPERATOR_PROFILE;
  const project=exact.retainedRepairAcceptanceProject({stateDatabase,target:{sha:"c".repeat(40)}});
  assert.equal(project.id,"openclaw");assert.equal(project.repoRoot,repoRoot);assert.equal(project.source,"registered");assert.equal(project.originUrl,"https://example.invalid/original.git");
  assert.notEqual(beforeHead,"c".repeat(40));assert(beforeStatus);
  assert.equal(git("rev-parse","HEAD"),beforeHead);assert.equal(git("status","--porcelain=v1","--ignored=matching"),beforeStatus);
  assert.equal(hash(readFileSync(stateDatabase)),beforeDatabase);assert.equal(process.env.OPENCLAW_TEAM_OPERATOR_PROFILE,beforeProfile);
  const update=new DatabaseSync(stateDatabase);
  update.prepare("UPDATE projects SET source='workspace' WHERE id='openclaw'").run();
  assert.throws(()=>exact.retainedRepairAcceptanceProject({stateDatabase}),/absent or changed/);
  update.prepare("DELETE FROM projects WHERE id='openclaw'").run();
  assert.throws(()=>exact.retainedRepairAcceptanceProject({stateDatabase}),/absent or changed/);
  update.close();
  t.diagnostic("exact project reader sha256="+hash(functionSource("retainedRepairAcceptanceProject"))+"; real SQLite registry");
});

for (const [name, mutate] of [
  ["missing proof", () => null],
  ["different RPC", p => ({...p,method:"projects.list"})],
  ["different project", p => ({...p,params:{...p.params,projectId:"other"}})],
  ["different probe agent", p => ({...p,params:{...p.params,agentId:"configured-marker-agent"}})],
  ["unavailable current checkout", p => ({...p,response:{current:false,worktree:true}})],
  ["non-boolean response", p => ({...p,response:{current:"true",worktree:false}})],
  ["unknown response fields", p => ({...p,response:{...p.response,error:"unavailable"}})],
]) test("original checkout proof rejects "+name, () => {
  assert.throws(()=>exact.retainedRepairAcceptanceCheckout(mutate(goodProof()),{checkoutPayload}));
});
test("original checkout proof permits native current checkout, independently of worktree option",()=>{
  exact.retainedRepairAcceptanceCheckout(goodProof(),{checkoutPayload});
  const p=goodProof();p.response.worktree=true;exact.retainedRepairAcceptanceCheckout(p,{checkoutPayload});
});

function shellFunction(source,name){const all=[...source.matchAll(/^([A-Za-z_][A-Za-z_0-9]*)\(\) \{/gm)],i=all.findIndex(x=>x[1]===name);assert(i>=0);return source.slice(all[i].index,all[i+1]?.index??source.length);}
test("actual terminal receipt shell requires original checkout RPC before accepting proof",()=>{
  const shell=readFileSync(join(import.meta.dirname,"openclaw-release-deploy"),"utf8");
  const prelude = [
    "set -Eeuo pipefail", "node_bin=\"$NODE\"; verification_deadline=600; SECONDS=0",
    "retained_acceptance() { if [[ \"$1\" == check ]]; then printf '%s' '{\"checkoutPayload\":\"{\\\"projectId\\\":\\\"openclaw\\\",\\\"agentId\\\":\\\"roboclaw\\\"}\"}'; else printf '%s' \"$OPENCLAW_TEAM_REPAIR_ACCEPTANCE_PROOF\"; fi; }",
    "run_gateway() { if [[ \"$4\" == projects.checkoutOptions ]]; then [[ \"$6\" == '{\"projectId\":\"openclaw\",\"agentId\":\"roboclaw\"}' ]]; [[ \"$FAIL_CHECKOUT\" == 0 ]] || return 79; printf '%s' '{\"current\":true,\"worktree\":false}'; elif [[ \"$4\" == channels.status ]]; then printf '%s' '{}'; else return 80; fi; }",
  ].join("\n");
  const script=[prelude,shellFunction(shell,"retained_acceptance_field"),shellFunction(shell,"retained_acceptance_receipt"),"retained_acceptance_receipt context release '{}' '{}' '{}'"].join("\n");
  const run=fail=>spawnSync("bash",["-c",script],{encoding:"utf8",env:{...process.env,NODE:process.execPath,FAIL_CHECKOUT:String(fail)}});
  const good=run(0);assert.equal(good.status,0,good.stderr);assert.deepEqual(JSON.parse(good.stdout).checkout,goodProof());
  const bad=run(1);assert.notEqual(bad.status,0);assert.equal(bad.stdout,"");
});
