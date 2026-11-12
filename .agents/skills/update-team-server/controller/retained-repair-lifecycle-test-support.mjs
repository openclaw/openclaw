// Repo-relative fixture for production build/lifecycle commands. Native systemd IO is synthetic.
// Public root/PID1/proc admission is not bypassed and no private claim dispatcher is added.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
export const active = import.meta.dirname;
const support = await import(pathToFileURL(join(active, "retained-repair-test-support.mjs")));
export const { test, fixture, descriptor, addSession } = support;
export const digest = bytes => createHash("sha256").update(bytes).digest("hex");
export function git(directory, ...args) {
  const result = spawnSync("/usr/bin/git", ["-C", directory, ...args], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: directory,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "Synthetic", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Synthetic", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
  assert.equal(result.status, 0, result.stderr); return result.stdout.trim();
}
// Same real Git preparation and lock-bearing invocation as the active transaction suite.
export function ready(t) {
  const repo = mkdtempSync(join(tmpdir(), "retained-lifecycle-git-"));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  git(repo, "init"); git(repo, "commit", "--allow-empty", "-m", "synthetic B");
  const b = git(repo, "rev-parse", "HEAD");
  git(repo, "commit", "--allow-empty", "-m", "synthetic C");
  const c = git(repo, "rev-parse", "HEAD");
  const f = fixture(t, { b, c });
  assert.equal(f.lockMode, "real-flock", "requires real Linux flock");
  f.activeSource = readFileSync(f.library, "utf8"); f.activeHash = digest(f.activeSource);
  assert.equal(f.activeHash,digest(readFileSync(join(active,"release-lib.mjs"))),"fixture must copy the actual active library");
  // Narrow test IO mapping for the exact pinned installed contract path. The
  // production artifact hash and real contract validators run unchanged.
  f.preload = join(f.root, "test-protocol-read.mjs");
  writeFileSync(f.preload,
    'import fs from "node:fs"; import {syncBuiltinESMExports} from "node:module";\n' +
    'const original=fs.readFileSync;fs.readFileSync=function(path,...args){return original.call(this,path==="/usr/local/lib/openclaw-team/gateway-suspension-contract.mjs"?'+
    JSON.stringify(join(dirname(f.library), "gateway-suspension-contract.mjs"))+':path,...args)};syncBuiltinESMExports();\n');
  f.buildHome = f.env.OPENCLAW_TEAM_BUILD_HOME; f.mirror = join(f.buildHome,"mirror/mirror.git");
  git(f.mirror,"init","--bare"); git(f.mirror,"fetch",repo,"HEAD:refs/remotes/origin/main");
  git(f.mirror,"remote","add","origin","https://github.com/openclaw/openclaw.git");
  f.request={...f.request,target:{sha:c}}; f.operation={operation:f.request.operation};
  f.prefix=join(f.serving,"journal","repair-"+f.request.operation);
  nativeFixture(f);
  t.diagnostic("exact library sha256="+f.activeHash+"; synthetic native IO, no root admission bypass");
  return f;
}
export function invoke(f, command, action, input, preload, {lock=true}={}) {
  const args = [process.execPath, "--no-warnings", "--import", f.preload,
    ...(preload ? ["--import",preload] : []), f.library,command,...(action===null?[]:[action]),f.serving,
    ...(input===undefined?[]:["@stdin"])];
  return spawnSync("bash",["-c",lock?'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec "$@"':'exec "$@"',"retained-lifecycle",...args],
    {env:f.env,encoding:"utf8",input:input===undefined?undefined:JSON.stringify(input),timeout:30000});
}
export function ok(f, command, action, input, preload) {
  const result=invoke(f,command,action,input,preload);assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
export const build=(f,action,input=f.operation)=>ok(f,"retained-repair-build",action,input);
export const transaction=(f,action,input)=>ok(f,"retained-repair-transaction",action,input);
export const lifecycle=(f,action,record,extra={})=>ok(f,"retained-repair-lifecycle",action,{journal:record.journal,...extra});
export function prepared(f) {
  build(f,"begin",f.request);build(f,"origin");f.completed=build(f,"finish");
  const begun=transaction(f,"begin",f.completed.completed);
  return transaction(f,"verify",begun.journal);
}
export function refuse(f, action, record, extra={}, pattern) {
  const before=readFileSync(f.journal), pointers=[readlinkSync(join(f.serving,"current")),readlinkSync(join(f.serving,"previous"))];
  const result=invoke(f,"retained-repair-lifecycle",action,{journal:record.journal,...extra});
  assert.notEqual(result.status,0,result.stdout);if(pattern)assert.match(result.stderr,pattern);
  assert.deepEqual(readFileSync(f.journal),before);assert.deepEqual([readlinkSync(join(f.serving,"current")),readlinkSync(join(f.serving,"previous"))],pointers);
  return result;
}
export function lease() {return {status:"ready",suspensionId:randomUUID(),expiresAtMs:Date.now()+120000,activeCount:0,blockers:[],writeCustody:[]};}
export function toBound(f) {return lifecycle(f,"bind",prepared(f),{instance:"fixture-original-instance"});}
export function status(response) {return {status:"ready",expiresAtMs:response.expiresAtMs,writeCustody:[]};}
export function toStopIntent(f) {let record=toBound(f);f.response=lease();record=lifecycle(f,"suspend",record,{response:f.response});return lifecycle(f,"stop-intent",record,{response:status(f.response),suspensionId:f.response.suspensionId});}
// Execute the unchanged production bridge and repair_step bodies, not a JSON facsimile.
// Only transport/native process observations come from this explicitly synthetic fixture.
export function shellSuspensionStep(f, action, record, prepare, response=prepare, suspensionId=prepare.suspensionId) {
  const source=readFileSync(join(active,"openclaw-release-deploy"),"utf8");
  const exact=name=>{const start=source.indexOf(name+"() {"),end=source.indexOf("\n}\n\n",start);assert(start>=0&&end>start,name);return source.slice(start,end+2);};
  const quote=value=>"'"+String(value).replaceAll("'","'\"'\"'")+"'";
  const script=["set -Eeuo pipefail", "node_bin="+quote(process.execPath),"serving_root="+quote(f.serving),
    "repair_journal="+quote(JSON.stringify(record.journal)),"last_suspension_prepare_response="+quote(JSON.stringify(prepare)),
    "last_suspension_response="+quote(JSON.stringify(response)),"held_suspension="+quote(suspensionId),
    "last_suspension_response_kind="+(response===prepare?"prepare":"status"),
    "proof(){ "+quote(process.execPath)+" --no-warnings --import "+quote(f.preload)+" "+quote(f.library)+" \"$@\"; }",
    exact("repair_step"),exact("repair_suspension_response"),
    "extra=$(repair_suspension_response "+(action==="suspend"?"prepare":"status")+")",
    "repair_step "+quote(action)+" \"$extra\"", "printf %s \"$repair_journal\""].join("\n");
  return spawnSync("bash",["-c",'exec 9<>"$OPENCLAW_TEAM_LOCK_FILE"; flock -n 9 || exit 75; exec bash -c "$1"',"repair-shell-bridge",script],
    {env:f.env,encoding:"utf8",timeout:30000});
}
export function toStopped(f) {const record=toStopIntent(f);f.stop();return lifecycle(f,"stopped",record);}
export function toStartIntent(f) {let record=toStopped(f);record=lifecycle(f,"select-intent",record);record=lifecycle(f,"select",record);return lifecycle(f,"start-intent",record,{verificationSeconds:600});}
function nativeStub() {
  const fs=require("node:fs"),path=require("node:path"),file=process.env.REPAIR_TEST_NATIVE,s=JSON.parse(fs.readFileSync(file,"utf8")),a=process.argv.slice(2);
  fs.appendFileSync(file+".calls",JSON.stringify(a)+"\n");
  if(s.fail)process.exit(9);
  if(a[0]==="show") {const props=a.slice(2).map(x=>x.slice("--property=".length)),v=a[1].startsWith("user@")?s.manager:s.unit;process.stdout.write(props.map(p=>p+"="+(v[p]??"")).join("\n")+"\n"+(s.duplicate?"MainPID=999\n":""));}
  else if(a[0]==="list-jobs")process.stdout.write(s.jobs);
  else if(a.includes("call"))process.stdout.write(JSON.stringify({type:"o",data:["/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice"]}));
  else if(a.includes("get-property"))process.stdout.write(JSON.stringify(a.at(-1)==="ExecConditionEx"?s.exec:a.at(-1)==="ExecStart"?s.start:s.unset));
  else if(a[0]==="-H")process.stdout.write(s.ss);
  else if(a[0]==="daemon-reload") {
    const dir=s.unit.FragmentPath+".d",files=fs.readdirSync(dir).filter(x=>x.endsWith(".conf")).sort(),guard=files.find(x=>x.startsWith("zzzz-openclaw-retained-repair-"));
    s.unit.DropInPaths=files.map(x=>path.join(dir,x)).join(" ");s.unit.Restart=guard?"no":"always";
    s.exec.data=guard?[["/usr/bin/node",["/usr/bin/node","/usr/local/lib/openclaw-team/release-lib.mjs","retained-repair-start-claim",process.env.REPAIR_TEST_SERVING,process.env.REPAIR_TEST_OPERATION],["privileged"],0,0,0,0,0,0,0]]:[];
    s.unset.data=guard?["NODE_OPTIONS","NODE_PATH","LD_PRELOAD","LD_LIBRARY_PATH","LD_AUDIT"]:[];fs.writeFileSync(file,JSON.stringify(s));
  } else {process.stderr.write("fixture refuses non-observation command "+a.join(" "));process.exit(8);}
}
function nativeFixture(f) {
  const unit="openclaw-gateway.service", proc=join(f.root,"proc"), pid=f.pid, uid=process.getuid();
  f.nativePath=join(f.root,"native.json");f.nativeCalls=f.nativePath+".calls";
  f.nativeGuard=join(f.fragment+".d","zzzz-openclaw-retained-repair-"+f.request.operation+".conf");
  f.native={unit:{Id:unit,LoadState:"loaded",ActiveState:"active",SubState:"running",MainPID:String(pid),ControlPID:"0",Job:"",UnitFileState:"enabled",ExecMainPID:String(pid),InvocationID:"a".repeat(32),ExecMainStartTimestampMonotonic:"12345000",ControlGroup:"/system.slice/"+unit,FragmentPath:f.fragment,DropInPaths:f.guard,Restart:"always"},
    manager:{Id:"user@"+uid+".service",LoadState:"loaded",ActiveState:"inactive",SubState:"dead",MainPID:"0",ControlPID:"0",Job:"",UnitFileState:"disabled",ExecMainPID:"0",InvocationID:"",ExecMainStartTimestampMonotonic:"0",ControlGroup:""},
    jobs:"",ss:'LISTEN 0 128 127.0.0.1:18789 0.0.0.0:* users:(("node",pid='+pid+',fd=10))\n',exec:{type:"a(sasasttttuii)",data:[]},unset:{type:"as",data:[]},
    start:{type:"a(sasbttttuii)",data:[[process.execPath,[process.execPath,join(f.serving,"current/dist/index.js"),"gateway","--port","18789"],false,0,0,0,0,pid,0,0]]}};
  const cg=join(f.root,"sys/fs/cgroup/system.slice",unit);mkdirSync(cg,{recursive:true,mode:0o755});
  writeFileSync(join(cg,"cgroup.events"),"populated 0\nfrozen 0\n");f.cgroup=cg;
  f.saveNative=()=>writeFileSync(f.nativePath,JSON.stringify(f.native),{mode:0o600});
  const processEntry=(newPid,start,release)=>{
    const pp=join(proc,String(newPid));mkdirSync(pp,{recursive:true});
    const fields=Array(24).fill("0");fields[0]="S";fields[19]=String(start);
    writeFileSync(join(pp,"stat"),newPid+" (node) "+fields.join(" ")+"\n");
    for(const name of ["cwd","exe"])if(existsSync(join(pp,name)))unlinkSync(join(pp,name));
    symlinkSync(release,join(pp,"cwd"));symlinkSync(process.execPath,join(pp,"exe"));
    writeFileSync(join(pp,"cgroup"),"0::/system.slice/"+unit+"\n");
    writeFileSync(join(pp,"cmdline"),[process.execPath,join(f.serving,"current/dist/index.js"),"gateway","--port","18789", ""].join("\0"));
  };
  processEntry(pid,f.start,f.b);
  f.stop=()=>{rmSync(join(proc,String(pid)),{recursive:true,force:true});f.native.unit.ActiveState="inactive";f.native.unit.SubState="dead";f.native.unit.MainPID="0";f.native.ss="";f.saveNative();};
  f.startSuccessor=()=>{f.newPid=pid+1000;processEntry(f.newPid,"5550",f.c);Object.assign(f.native.unit,{ActiveState:"active",SubState:"running",MainPID:String(f.newPid),ExecMainPID:String(f.newPid),InvocationID:"c".repeat(32),ExecMainStartTimestampMonotonic:"55500000"});f.native.ss='LISTEN 0 128 127.0.0.1:18789 0.0.0.0:* users:(("node",pid='+f.newPid+',fd=10))\n';f.saveNative();};
  const stub=join(f.root,"native-stub.cjs");
  writeFileSync(stub,'#!'+process.execPath+'\n('+nativeStub.toString()+')();\n',{mode:0o755});chmodSync(stub,0o755);
  Object.assign(f.env,{OPENCLAW_TEAM_SYSTEMCTL:stub,OPENCLAW_TEAM_BUSCTL:stub,OPENCLAW_TEAM_SS:stub,REPAIR_TEST_NATIVE:f.nativePath,REPAIR_TEST_SERVING:f.serving,REPAIR_TEST_OPERATION:f.request.operation});
  const oldStop=f.stop;f.stop=()=>{f.native=JSON.parse(readFileSync(f.nativePath));oldStop();};
  const oldStart=f.startSuccessor;f.startSuccessor=()=>{f.native=JSON.parse(readFileSync(f.nativePath));oldStart();};
  f.refreshNative=()=>{f.native=JSON.parse(readFileSync(f.nativePath));return f.native;};
  f.saveNative();
}
