import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";

// Elapsed envelopes, not CPU attribution: three post-drain status children,
// handoff, and final poll.
const observed = {
  postDrainStatusUs: [21_160_700, 17_953_705, 17_567_446, 17_785_370],
  handoffUs: 5_039_531,
  drainingAgeUs: 16_753_613,
  interruptingAgeUs: 46_647_747,
  armedRemainingUs: 10_034_546,
  finalPollStartUs: 464_298,
  finalTailUs: 18_367_443,
  // Fixed residuals are shared by red and green, never recomputed to fit a run.
  beforeInterruptionUs: 1_894_134,
  beforeHandoffReceiptUs: 1_596_325,
  finalProofUs: 117_775,
};

export function installMigrationLeaseClock(f, { fault = "", costs = {}, calibrate = true } = {}) {
  const clock = join(f.state, "elapsed-us"), trace = join(f.state, "timing.jsonl"), model = join(f.state, "clock-model.json");
  writeFileSync(clock, "0\n"); writeFileSync(trace, ""); writeFileSync(model, "{}");
  const module = join(f.root, "lease-clock.mjs"), control = join(f.root, "lease-clock-control.mjs");
  const config = { clock, trace, model, fault, calibrate, observed, epoch: Date.now(), state: f.state,
    permit: f.permit, proc: join(f.root, "proc", String(f.pid), "stat"),
    proof: join(f.root, "lease-proof.cjs"), native: join(f.commands, "service-fixture.cjs"), control,
    releases: [f.initial, f.candidate],
    costs: { rpcUs: 17_000_000, prepareBeforeUs: 3_000_000, prepareAfterUs: 16_753_613,
      // Unknown individual work is represented by the fixed observed residuals.
      // Overrides can independently add cost at any native/proof/RPC boundary.
      nativeUs: 0, proofUs: 0, inlineUs: 0, rpc: {}, native: {}, proof: {}, ...costs } };
  writeFileSync(module, `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';\nconst config=${JSON.stringify(config)};\n` + String.raw`
const now=()=>Number(fs.readFileSync(config.clock,'utf8'));
const load=()=>JSON.parse(fs.readFileSync(config.model,'utf8'));
const save=value=>fs.writeFileSync(config.model,JSON.stringify(value));
const record=(operation,before,after,extra={})=>fs.appendFileSync(config.trace,JSON.stringify({operation,before,after,...extra})+'\n');
function advance(operation,amount) {
  const before=now(),limit=Number(process.env.FIXTURE_EXEC_DEADLINE_US??Infinity);
  if(before>=limit){record('execution-timeout',before,before,{timedOutOperation:operation});process.exit(124);}
  const after=Math.min(before+amount,limit);
  const temporary=config.clock+'.'+process.pid+'.next';
  fs.writeFileSync(temporary,String(after)+'\n');fs.renameSync(temporary,config.clock);record(operation,before,after);
  if(before+amount>=limit) {record('execution-timeout',after,after,{timedOutOperation:operation});process.exit(124);}
}
function receipt(name) {
  const value=load();
  if(name==='draining'&&!value.drainingReceipt) {
    value.drainingReceipt=true;value.phase='draining';
  }
  if(name==='interrupting') {
    if(config.calibrate)advance('unattributed-before-interruption',config.observed.beforeInterruptionUs);
    value.phase='post-drain';value.postDrainStatus=0;
    record('interruption-receipt',now(),now(),{ageUs:now()-(value.initialExpiryUs-120000000)});
  }
  if(name==='armed') {
    if(config.calibrate&&(!value.handoffSent||value.postDrainStatus!==3))throw Error('unexpected RPC order before handoff receipt');
    if(config.calibrate)advance('unattributed-before-handoff-receipt',config.observed.beforeHandoffReceiptUs);
    value.phase='armed';value.armedReceiptUs=now();
    record('handoff-receipt',now(),now(),{remainingUs:value.currentExpiryUs-now(),originalRemainingUs:value.initialExpiryUs-now()});
  }
  if(name==='status-failed'&&value.armedReceiptUs!==undefined)
    record('status-failed-receipt',now(),now(),{tailUs:now()-value.armedReceiptUs});
  save(value);
}
function changeGeneration() {
  const stat=fs.readFileSync(config.proc,'utf8'),at=stat.lastIndexOf(') ')+2,fields=stat.slice(at).trim().split(/\s+/);
  fields[19]=String(Number(fields[19])+1);fs.writeFileSync(config.proc,stat.slice(0,at)+fields.join(' ')+'\n');
}
function response(value,method) {
  const state=load();
  if(['gateway.suspend.prepare','gateway.suspend.status'].includes(method)&&value?.status==='draining')value.retryAfterMs=20000;
  if(method==='gateway.suspend.prepare'&&['ready','draining'].includes(value?.status)) {
    const renewal=state.prepareCount>1;
    if(!state.initialExpiryUs)state.initialExpiryUs=(value.expiresAtMs-config.epoch)*1000;
    if(renewal&&config.fault==='renew-no-advance') {
      value.expiresAtMs=config.epoch+state.initialExpiryUs/1000;
      fs.writeFileSync(config.state+'/active-lease',JSON.stringify({id:value.suspensionId,expiry:value.expiresAtMs}));
    }
    state.currentExpiryUs=(value.expiresAtMs-config.epoch)*1000;
    if(value.status==='ready'&&!state.phase){state.phase='post-drain';state.postDrainStatus=0;}
    record(renewal?'renewal-offer':'initial-offer',now(),now(),{id:value.suspensionId,expiresAtMs:value.expiresAtMs,expiryUs:(value.expiresAtMs-config.epoch)*1000});
    if(renewal&&config.fault==='renew-generation')changeGeneration();
    if(renewal&&config.fault==='renew-instance')fs.writeFileSync(config.state+'/instance-drift','1');
    if(renewal&&config.fault==='malformed-renewal')value.writeCustody=null;
    if(renewal&&config.fault==='malformed-no-offer')delete value.suspensionId;
    if(renewal&&['renew-custody','renew-persistence','ready-late'].includes(config.fault))state.forceDraining=true;
    save(state);
    const after=renewal&&config.fault.startsWith('uncertain')?50000000:config.costs.prepareAfterUs;
    advance('rpc:gateway.suspend.prepare:response',after);
  }
  const current=load();
  if(method==='gateway.suspend.resume')record('resume-result',now(),now(),{result:value});
  if(['gateway.suspend.prepare','gateway.suspend.status'].includes(method)&&current.forceDraining&&['ready','draining'].includes(value?.status)) {
    value.status='draining';value.activeCount=1;value.retryAfterMs=20000;
    value.blockers=[{kind:'terminal-session',count:1,message:'fixture existing work'}];
    if(config.fault==='renew-custody')value.writeCustody=[{phase:'backup',count:1}];
    if(config.fault==='renew-persistence')value.blockers=[{kind:'terminal-persistence',count:1,message:'fixture pending write'}];
  }
  if(method==='gateway.suspend.status'&&fs.existsSync(config.state+'/armed-handoff')) {
    if(config.fault==='custody')value.writeCustody=[{phase:'backup',count:1}];
    if(config.fault==='persistence')value.blockers=[{kind:'terminal-persistence',count:1,message:'fixture pending write'}];
  }
}
function observe() {
  const args=process.argv,file=args[1];
  if(file===config.control)return;
  if(file===config.proof) {
    const name=args[2],value=load();
    advance('proof:'+name,config.costs.proof[name]??config.costs.proofUs);
    if(name==='suspension-status'&&value.phase==='armed'&&config.calibrate)advance('unattributed-final-status-proof',config.observed.finalProofUs);
    if(name==='migration-live-check'&&['replacement','uncertain-new','expired-before-renewal'].includes(config.fault))
      advance('slow-mutable-preparation',config.fault==='expired-before-renewal'?65000000:40000000);
    if(name==='migration-check'&&value.phase==='armed'&&config.fault==='expiry')advance('late-armed-work',100000000);
    return;
  }
  if(file===config.native) {
    const operation=args.slice(2,4).join(':');advance('native:'+operation,config.costs.native[operation]??config.costs.nativeUs);return;
  }
  const method=args[2]==='gateway'&&args[3]==='call'?args[4]:undefined;
  if(method) {
    const state=load();let cost=config.costs.rpc[method]??config.costs.rpcUs;
    if(method==='gateway.suspend.prepare') {
      state.prepareCount=(state.prepareCount??0)+1;
      if(config.calibrate&&state.phase==='post-drain'&&(state.prepareCount!==2||state.postDrainStatus!==1))throw Error('unexpected pre-arm renewal order');
      record('prepare-request',now(),now(),{request:JSON.parse(args[args.indexOf('--params')+1]),armed:fs.existsSync(config.state+'/armed-handoff')});
      cost=state.prepareCount>1&&['replacement','uncertain-new'].includes(config.fault)?20000000:config.costs.prepareBeforeUs;
    }
    if(method==='gateway.suspend.status'&&['post-drain','armed'].includes(state.phase)) {
      state.postDrainStatus=(state.postDrainStatus??0)+1;
      if(config.calibrate&&((state.postDrainStatus<3&&state.handoffSent)||(state.postDrainStatus===3&&!state.handoffSent)||state.postDrainStatus>4))throw Error('unexpected post-drain status order');
      cost=config.costs.rpc[method]??config.observed.postDrainStatusUs[Math.min(state.postDrainStatus-1,3)];
      if(state.phase==='armed'&&config.calibrate)advance('unattributed-before-final-poll',config.observed.finalPollStartUs);
    }
    if(method==='gateway.suspend.status'&&state.phase==='draining'&&config.calibrate&&Number(process.env.FIXTURE_EXEC_DEADLINE_US)-now()<=30000000)
      throw Error('unexpected in-drain status call: native retry advice is 20000ms');
    if(method==='gateway.suspend.handoff') {
      if(config.calibrate&&(state.phase!=='post-drain'||state.postDrainStatus!==2||state.handoffSent))throw Error('unexpected handoff RPC order');
      state.handoffSent=true;
      cost=config.costs.rpc[method]??config.observed.handoffUs;
      if(config.fault==='generation')changeGeneration();
    }
    if(method==='gateway.suspend.resume')record('resume-request',now(),now(),{request:JSON.parse(args[args.indexOf('--params')+1])});
    save(state);advance('rpc:'+method+':dispatch',cost);return;
  }
  if(!file||!file.endsWith('release-lib.mjs'))advance('inline-node',config.costs.inlineUs);
}
Date.now=()=>config.epoch+Math.floor(now()/1000);
const readdir=fs.readdirSync;
fs.readdirSync=function(path,...args){
  if(config.releases.includes(String(path)))record('release-tree-audit',now(),now(),{held:fs.existsSync(config.state+'/active-lease')});
  return readdir.call(this,path,...args);
};
syncBuiltinESMExports();
globalThis.fixtureLeaseClock={advance,receipt,response,now};
observe();
`);
  writeFileSync(control, `const c=globalThis.fixtureLeaseClock;const [command,value]=process.argv.slice(2);
if(command==='sleep')c.advance('sleep',Number(value)*1000000);
else if(command==='receipt')c.receipt(value);
else if(command==='deadline')process.stdout.write(String(Math.min(Number(process.env.FIXTURE_EXEC_DEADLINE_US??Infinity),c.now()+Number(value.replace(/s$/,''))*1000000)));
else process.exit(64);
`);
  f.env.NODE_OPTIONS = `--import=${module}`;
  const bashEnv = join(f.root, "lease-clock.sh");
  writeFileSync(bashEnv, `unset SECONDS
SECONDS=0
set -T
trap 'IFS= read -r fixture_elapsed < ${quote(clock)}; SECONDS=$((fixture_elapsed / 1000000))' DEBUG
sleep(){ ${quote(process.execPath)} ${quote(control)} sleep "$1"; }
printf(){
  case "$1" in
    'DRAINING '*) ${quote(process.execPath)} ${quote(control)} receipt draining ;;
    'INTERRUPTING '*) ${quote(process.execPath)} ${quote(control)} receipt interrupting ;;
    'HANDOFF_ARMED '*) ${quote(process.execPath)} ${quote(control)} receipt armed ;;
    'SUSPENSION_CHECK_FAILED stage=status'*) ${quote(process.execPath)} ${quote(control)} receipt status-failed ;;
  esac
  builtin printf "$@"
}
`);
  f.env.BASH_ENV = bashEnv;
  f.env.OPENCLAW_TEAM_DRAIN_BUDGET = "30";
  f.env.OPENCLAW_TEAM_DRAIN_POLL_INTERVAL = "5";
  const timeout = join(f.commands, "lease-timeout");
  writeFileSync(timeout, `#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == --signal=TERM && "$2" == --kill-after=10s ]] || exit 64
export FIXTURE_EXEC_DEADLINE_US="$(${quote(process.execPath)} ${quote(control)} deadline "$3")"
exec ${quote(f.realCommands.timeout)} "$@"
`, { mode: 0o755 });
  f.env.OPENCLAW_TEAM_TIMEOUT = timeout;

  const cli = join(f.initial, "dist/index.js"), source = readFileSync(cli, "utf8");
  let altered = source.replace('const emit=(value)=>process.stdout.write(JSON.stringify(value));',
    `const emit=(value)=>{globalThis.fixtureLeaseClock.response(value,process.argv[4]);process.stdout.write(JSON.stringify(value));};`);
  altered = altered.replace('processInstanceId:"fixture-instance-"+pid',
    'processInstanceId:present("instance-drift")?"replacement-instance":"fixture-instance-"+pid');
  altered = altered.replace('params.target.processInstanceId!=="fixture-instance-"+read("pid")',
    'params.target.processInstanceId!==(present("instance-drift")?"replacement-instance":"fixture-instance-"+read("pid"))');
  chmodSync(cli, 0o644); writeFileSync(cli, altered); chmodSync(cli, 0o444);
  f.timing = () => readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  f.resetLeaseObservations = () => writeFileSync(model, "{}");
}
