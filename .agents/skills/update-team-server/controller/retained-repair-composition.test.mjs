import assert from "node:assert/strict";
import {copyFileSync,chmodSync,mkdirSync,readFileSync,readlinkSync,writeFileSync} from "node:fs";
import {join,dirname} from "node:path";
import {randomUUID} from "node:crypto";
import * as suspensionContract from "./gateway-suspension-contract.mjs";
import {test,ready,build,descriptor,invoke,transaction,lifecycle,lease,status,toBound,shellSuspensionStep} from "./retained-repair-lifecycle-test-support.mjs";
const names=["openclaw-release-deploy","release-lib.mjs","gateway-suspension-contract.mjs","startup-profile.mjs"];
function adopt(f) {
 const installed=dirname(f.library), approved=join(f.root,"approved");mkdirSync(approved,{mode:0o755});chmodSync(approved,0o755);
 for(const n of names){copyFileSync(join(installed,n),join(approved,n));chmodSync(join(approved,n),n===names[0]?0o755:0o644);}
 const request={version:1,operation:randomUUID(),source:descriptor(f.journal),oldClosure:names.map(n=>descriptor(join(installed,n))),replacement:names.map(n=>descriptor(join(approved,n)))};
 const installedLibrary=f.library;f.library=join(approved,"release-lib.mjs");
 const prepared=invoke(f,"retained-controller-adoption","prepare",request);assert.equal(prepared.status,0,prepared.stderr);
 const binding=JSON.parse(prepared.stdout);const applied=invoke(f,"retained-controller-adoption","apply",binding);assert.equal(applied.status,0,applied.stderr);
 f.library=installedLibrary;return {binding,request,applied:JSON.parse(applied.stdout)};
}
test("P1 repaired: adopted four-file closure finishes public build, seals/checks, enters canonical lifecycle",t=>{
 const f=ready(t),original=Buffer.from(f.original),a=adopt(f);
 build(f,"begin",f.request);build(f,"origin");const finished=build(f,"finish");assert.equal(finished.phase,"BUILD_COMPLETED");
 const snapshot=JSON.parse(readFileSync(f.prefix+".intent.json"));assert.equal(snapshot.adoption.operation,a.binding.operation);
 for(const action of ["seal","check"]){const result=invoke(f,"retained-repair-preparation",action,snapshot);assert.equal(result.status,0,result.stderr);}
 const tampered={...snapshot,adoption:true};const bad=invoke(f,"retained-repair-preparation","check",tampered);assert.notEqual(bad.status,0);assert.match(bad.stderr,/binding changed/);
 assert.equal(build(f,"finish").completed.sha256,finished.completed.sha256);
 const begun=transaction(f,"begin",finished.completed);let current=transaction(f,"verify",begun.journal);
 assert.equal(current.record.phase,"REPAIR_EVIDENCE_VERIFIED");current=lifecycle(f,"bind",current,{instance:"fixture-original-instance"});
 const response=lease();current=lifecycle(f,"suspend",current,{response});current=lifecycle(f,"stop-intent",current,{response:status(response),suspensionId:response.suspensionId});
 f.stop();current=lifecycle(f,"stopped",current);current=lifecycle(f,"select-intent",current);current=lifecycle(f,"select",current);
 current=lifecycle(f,"start-intent",current,{verificationSeconds:600});assert.equal(current.record.phase,"REPAIR_START_INTENT");
 assert.equal(lifecycle(f,"start-dispatch",current).phase,"DISPATCH_ONCE");
 assert.equal(readlinkSync(join(f.serving,"current")),f.c);
 assert.deepEqual(readFileSync(JSON.parse(readFileSync(finished.completed.path)).original.path),original);
});

for(const draining of [false,true]) test("native status shell bridge keeps actual "+(draining?"DRAINING prepare then READY status":"READY prepare then READY status")+" contracts",t=>{
 const f=ready(t),bound=toBound(f),prepared=lease(),readyStatus=status(prepared);
 const acquisition=draining?{...prepared,status:"draining",activeCount:1,blockers:[{kind:"task",count:1,message:"synthetic active work"}],retryAfterMs:1}:prepared;
 assert(suspensionContract.validateGatewaySuspendPrepareResult(acquisition));
 assert(suspensionContract.validateGatewaySuspendStatusResult(readyStatus));
 assert(!suspensionContract.validateGatewaySuspendPrepareResult(readyStatus));
 const suspended=shellSuspensionStep(f,"suspend",bound,acquisition,draining?readyStatus:acquisition);
 assert.equal(suspended.status,0,suspended.stderr);
 const current={journal:JSON.parse(suspended.stdout)},before=readFileSync(f.journal);
 const stopped=shellSuspensionStep(f,"stop-intent",current,acquisition,readyStatus);
 assert.equal(stopped.status,0,stopped.stderr);
 const checked=invoke(f,"retained-repair-lifecycle","inspect",{journal:JSON.parse(stopped.stdout)});
 assert.equal(checked.status,0,checked.stderr);const record=JSON.parse(checked.stdout).record;
 assert.equal(record.phase,"REPAIR_STOP_INTENT");
 assert.deepEqual(record.lifecycle.stopIntent.lease,record.lifecycle.suspension);
 assert.equal(record.lifecycle.suspension.id,prepared.suspensionId);
 assert.equal(record.lifecycle.suspension.expiresAtMs,prepared.expiresAtMs);
 assert.equal(record.lifecycle.bound.drain.deadlineMs,bound.record.lifecycle.bound.drain.deadlineMs);
 assert.deepEqual(readFileSync(JSON.parse(readFileSync(f.completed.completed.path)).original.path),f.original);
 assert.notDeepEqual(readFileSync(f.journal),before);
});

test("native status shell bridge rejects malformed, stale, held and changed lease evidence without phase changes",t=>{
 const f=ready(t),bound=toBound(f),prepared=lease(),readyStatus=status(prepared);
 const draining={...prepared,status:"draining",activeCount:1,blockers:[{kind:"task",count:1,message:"synthetic work"}],retryAfterMs:1};
 const beforeBound=readFileSync(f.journal);
 for(const [label,response,latest] of [
  ["status cannot stand in for original prepare",readyStatus,readyStatus],
  ["draining needs observed readiness",draining,draining],
  ["draining cannot accept Boolean readiness",draining,true],
  ["status expiry cannot extend prepare",draining,{...readyStatus,expiresAtMs:prepared.expiresAtMs+1}],
  ["status cannot invent prepare fields",draining,{...readyStatus,activeCount:0,blockers:[]}],
  ["status cannot omit custody",draining,{status:"ready",expiresAtMs:prepared.expiresAtMs}],
  ["invalid ready acquisition keeps held custody",{...prepared,writeCustody:[{phase:"migration",count:1}]},readyStatus],
  ["invalid draining acquisition lacks active work",{...draining,activeCount:0},readyStatus],
 ]) {
  const result=shellSuspensionStep(f,"suspend",bound,response,latest);
  assert.notEqual(result.status,0,label);assert.deepEqual(readFileSync(f.journal),beforeBound,label);
 }
 const suspended=shellSuspensionStep(f,"suspend",bound,prepared);assert.equal(suspended.status,0,suspended.stderr);
 const current={journal:JSON.parse(suspended.stdout)},before=readFileSync(f.journal),pointers=[readlinkSync(join(f.serving,"current")),readlinkSync(join(f.serving,"previous"))];
 for(const [label,response,id] of [
  ["prepare cannot stand in for status",prepared],
  ["wrong queried lease",readyStatus,"other-lease"],
  ["status expiry changed",{...readyStatus,expiresAtMs:prepared.expiresAtMs+1}],
  ["status lease expired",{...readyStatus,expiresAtMs:Date.now()-1}],
  ["status headroom insufficient",{...readyStatus,expiresAtMs:Date.now()+4000}],
  ["missing custody",{status:"ready",expiresAtMs:prepared.expiresAtMs}],
  ["held custody",{...readyStatus,writeCustody:[{phase:"migration",count:1}]}],
  ["running status",{status:"running"}],
  ["draining status",{status:"draining",expiresAtMs:prepared.expiresAtMs,activeCount:1,blockers:[{kind:"task",count:1,message:"synthetic work"}],retryAfterMs:1,writeCustody:[]}],
  ["fabricated prepare evidence",{...readyStatus,activeCount:0,blockers:[]}],
  ["Boolean status",true],
 ]) {
  const result=shellSuspensionStep(f,"stop-intent",current,prepared,response,id);
  assert.notEqual(result.status,0,label);assert.deepEqual(readFileSync(f.journal),before,label);
  assert.deepEqual([readlinkSync(join(f.serving,"current")),readlinkSync(join(f.serving,"previous"))],pointers,label);
 }
 const absent=invoke(f,"retained-repair-lifecycle","stop-intent",{journal:current.journal,response:readyStatus});
 assert.notEqual(absent.status,0);assert.deepEqual(readFileSync(f.journal),before);
 // Equality with the original deadline is expired, despite a fresh lease.
 const clock=join(f.root,"expired-drain-clock.mjs");
 writeFileSync(clock,"Date.now=()=>"+bound.record.lifecycle.bound.drain.deadlineMs+";\n");
 const expired=invoke(f,"retained-repair-lifecycle","stop-intent",{journal:current.journal,response:readyStatus,suspensionId:prepared.suspensionId},clock);
 assert.notEqual(expired.status,0);assert.match(expired.stderr,/fresh ready suspension/);assert.deepEqual(readFileSync(f.journal),before);
 const success=shellSuspensionStep(f,"stop-intent",current,prepared,readyStatus);assert.equal(success.status,0,success.stderr);
 assert.deepEqual(readFileSync(JSON.parse(readFileSync(f.completed.completed.path)).original.path),f.original);
});
