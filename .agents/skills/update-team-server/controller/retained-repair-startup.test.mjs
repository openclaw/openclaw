// Source-bound startup transport/identity/deadline unit tests; no native authorization shim.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdirSync,mkdtempSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import nodeTest from 'node:test';
const active = import.meta.dirname;
const shell=join(active,'openclaw-release-deploy');
const source=readFileSync(shell,'utf8');
const sourceHash=createHash('sha256').update(source).digest('hex');
function exact(name){const start=source.indexOf(name+'() {');assert(start>=0,name);const offset=start+name.length;const next=source.slice(offset).search(/\n[a-z_][a-z_0-9]*\(\) \{/);const boundary=next<0?source.length:offset+next;const end=source.lastIndexOf('\n}',boundary);assert(end>start,name);return source.slice(start,end+2);}
const quote=s=>"'"+String(s).replaceAll("'","'\"'\"'")+"'";
const lines=p=>existsSync(p)?readFileSync(p,'utf8').trim().split('\n').filter(Boolean):[];
const cases=[
 {name:'classified transient transport retries once',mode:'transient',attempts:2,ok:true},
 {name:'unclassified RPC failure is fatal',mode:'fatal',attempts:1},
 {name:'exit 78 without exact marker is fatal',mode:'false-marker',attempts:1},
 {name:'malformed successful RPC is fatal',mode:'malformed',attempts:1},
 {name:'generation drift after transport is fatal',mode:'drift',attempts:1},
 {name:'generation drift after listener is fatal',mode:'late-drift',attempts:1},
 {name:'unclassified capture failure is fatal',mode:'capture-failure',attempts:0},
 {name:'integrity drift on retry is fatal',mode:'integrity',attempts:1},
 {name:'absent native listener retries same instance',mode:'listener-wait',attempts:2,ok:true},
 {name:'foreign native listener is fatal',mode:'foreign-listener',attempts:1},
 {name:'RPC instance drift while listener pending is fatal',mode:'instance-drift',attempts:2},
 {name:'original deadline expires without second RPC',mode:'expiry',attempts:1},
 {name:'successful response after deadline cannot commit',mode:'late',attempts:1},
 {name:'native transition refusal is fatal and not retried',mode:'native-refusal',attempts:1},
 {name:'late native proof retains evidence but does not succeed',mode:'native-late',attempts:1,committed:true},
];
for(const c of cases) nodeTest(c.name,t=>{
 const root=mkdtempSync(join(tmpdir(),'startup-budget-unit-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const script=join(root,'test.sh');writeFileSync(join(root,'clock'),'1000');
 const deadline=c.mode==='expiry'?2500:20000;
 writeFileSync(script,[
  'set -Eeuo pipefail','node_bin='+quote(process.execPath),'root='+quote(root),'mode='+quote(c.mode),
  'candidate_release=/fixture','repair_verification_deadline_ms='+deadline,'capture_count=0','load_count=0','SECONDS=0',
  'fail(){ printf "%s\\n" "$*" >&2; return 1; }',
  'proof(){ test "$1" = suspension-now || return 91; cat "$root/clock"; }',
  'repair_load_context(){ load_count=$((load_count+1)); [[ "$mode" != integrity || "$load_count" -lt 2 ]]; }',
  'capture_service_generation(){ capture_count=$((capture_count+1)); [[ "$mode" != capture-failure ]] || return 1; service_pid=123; service_generation=555; if [[ ( "$mode" = drift && "$capture_count" -gt 1 ) || ( "$mode" = late-drift && "$capture_count" -gt 2 ) ]]; then service_generation=556; fi; }',
  'run_marker_rpc(){ printf "rpc %s\\n" "$4" >>"$root/rpc"; local n; n=$(wc -l <"$root/rpc"); case "$mode" in fatal) return 1;; false-marker) echo WRONG; return 78;; malformed) echo BAD; return 0;; transient|integrity|expiry|drift) if [[ "$n" = 1 ]]; then echo RETRYABLE_READINESS_TRANSPORT; return 78; fi;; late) echo 20001 >"$root/clock";; esac; if [[ "$mode" = instance-drift && "$n" -gt 1 ]]; then echo second-instance; else echo first-instance; fi; }',
  'run_gateway(){ return 92; }',
  'proof_json(){ [[ "$2" != BAD ]] || return 2; printf "%s" "$2"; }',
  'assert_single_listener(){ local n; n=$(wc -l <"$root/rpc"); [[ "$mode" != foreign-listener ]] || return 2; if [[ ( "$mode" = listener-wait || "$mode" = instance-drift ) && "$n" = 1 ]]; then return 75; fi; }',
  'sleep(){ local now; now=$(cat "$root/clock"); echo $((now+1000)) >"$root/clock"; }',
  'repair_step(){ printf "%s %s\\n" "$1" "$2" >>"$root/native-attempt"; [[ "$mode" != native-refusal ]] || return 2; if [[ "$mode" = native-late ]]; then echo 20001 >"$root/clock"; fi; printf "%s\\n" "$2" >>"$root/commit"; }',
  exact('read_process_instance'),exact('repair_reconcile_start'),
  'status=0; repair_reconcile_start || status=$?; printf "deadline=%s\\n" "$repair_verification_deadline_ms"; exit "$status"'
 ].join('\n'));
 const r=spawnSync('bash',[script],{encoding:'utf8',timeout:10000});
 assert.equal(lines(join(root,'rpc')).length,c.attempts,r.stderr);
 assert.equal(r.status===0,!!c.ok,r.stderr);
 assert.equal(lines(join(root,'commit')).length,(c.ok||c.committed)?1:0,r.stderr);
 assert.match(r.stdout,new RegExp('deadline='+deadline));
 for(const line of lines(join(root,'rpc'))) assert(Number(line.split(' ')[1])<=10000);
 if(c.mode==='drift')assert.match(r.stderr,/generation changed/);
 if(c.mode==='instance-drift')assert.match(r.stderr,/RPC instance changed/);
 if(c.mode==='expiry'||c.mode==='late')assert.match(r.stderr,/original deadline/);
 t.diagnostic('actual extracted functions sha256='+sourceHash+'; native/RPC/clock boundaries simulated');
});
nodeTest('read_process_instance propagates ordinary CLI failure explicitly',()=>{
 const script=['set -Eeuo pipefail','run_gateway(){ return 9; }','proof_json(){ echo UNREACHABLE; }',exact('read_process_instance'),'read_process_instance /fixture 123'].join('\n');
 const r=spawnSync('bash',['-c',script],{encoding:'utf8'});assert.equal(r.status,1);assert.equal(r.stdout,'');assert.match(r.stderr,/GATEWAY_RPC_FAILED method=system.info exit=9/);
});

for(const scenario of [
 {name:'connection-close',error:{transport:true,kind:'close',code:1006},status:78},
 {name:'timeout',error:{transport:true,kind:'timeout',code:1008},status:78},
 {name:'authentication',error:{transport:false,code:'UNAUTHORIZED'},status:1},
 {name:'protocol-close',error:{transport:true,kind:'close',code:1008},status:1},
]) nodeTest('actual SDK classifier '+scenario.name,t=>{
 const root=mkdtempSync(join(tmpdir(),'startup-sdk-classifier-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const sdk=join(root,'dist/plugin-sdk');mkdirSync(sdk,{recursive:true});
 writeFileSync(join(sdk,'gateway-runtime.js'),'export const isGatewayTransportError=e=>e.transport===true; export async function callGatewayFromCli(){throw '+JSON.stringify(scenario.error)+';}');
 const script=['set -Eeuo pipefail','node_bin='+quote(process.execPath),'run_gateway_node(){ "$node_bin" "$@"; }',exact('run_marker_rpc'),'run_marker_rpc '+quote(root)+" system.info '{}' 1000"].join('\n');
 const r=spawnSync('bash',['-c',script],{encoding:'utf8',timeout:10000});assert.equal(r.status,scenario.status,r.stderr);
 if(scenario.status===78)assert.equal(r.stdout,'RETRYABLE_READINESS_TRANSPORT');else assert.notEqual(r.stdout,'RETRYABLE_READINESS_TRANSPORT');
});
