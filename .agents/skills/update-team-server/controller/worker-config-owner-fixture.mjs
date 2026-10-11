import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  chownSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const owner = join(import.meta.dirname, "openclaw-release-deploy");
const library = join(import.meta.dirname, "release-lib.mjs");
const sha = "a".repeat(40);
const oldSetup = "# OPENCLAW_TEAM_ARTIFACT_SETUP_V1\ncommand -v node\nprintf legacy-runtime\n";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const utilityDirectories = [
  "/opt/homebrew/opt/coreutils/libexec/gnubin",
  "/usr/local/opt/coreutils/libexec/gnubin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
];

function command(names, required = true) {
  for (const name of names) {
    for (const directory of utilityDirectories) {
      const pathname = join(directory, name);
      if (existsSync(pathname) && lstatSync(realpathSync(pathname)).mode & 0o111) return pathname;
    }
  }
  if (required) throw new Error(`worker fixture requires ${names.join(" or ")}`);
  return undefined;
}

// Bounded extraction of release.test.mjs's release, process and CLI fixture helpers.
// This registers no tests and imports neither the historical suite nor production internals.
function executable(pathname, lines) {
  writeFileSync(pathname, "#!/usr/bin/env bash\nset -euo pipefail\n" + lines.join("\n") + "\n", {
    mode: 0o755,
  });
}

function writableTree(pathname) {
  const entry = lstatSync(pathname);
  if (entry.isSymbolicLink() || !entry.isDirectory()) return;
  chmodSync(pathname, 0o755);
  for (const child of readdirSync(pathname)) writableTree(join(pathname, child));
}

function processEntry(root, pid, ticks, release) {
  const directory = join(root, "proc", String(pid));
  mkdirSync(directory, { recursive: true });
  const values = Array.from({ length: 24 }, () => "0");
  values[0] = "S";
  values[19] = String(ticks);
  writeFileSync(join(directory, "stat"), `${pid} (fixture gateway) ${values.join(" ")}\n`);
  symlinkSync(release, join(directory, "cwd"));
  symlinkSync("/usr/bin/node", join(directory, "exe"));
}

function sourceHeader(fixture) {
  return (
    'const fs=require("node:fs"),path=require("node:path"),{DatabaseSync}=require("node:sqlite");\n' +
    `const fixture=${JSON.stringify({
      root: fixture.root,
      state: fixture.state,
      serving: fixture.serving,
      runtime: fixture.runtime,
      config: fixture.config,
      fragment: fixture.fragment,
      permit: fixture.permit,
      guard: fixture.guard,
      runtimeDrop: fixture.runtimeDrop,
      runtimeUid: fixture.runtimeUid,
      runtimeGid: fixture.runtimeGid,
      agentDatabasePath: fixture.agentDatabasePath,
      lockFile: fixture.lockFile,
      oldSetup: fixture.oldSetup,
    })};\n` +
    String.raw`
const {state}=fixture;
const read=(name)=>fs.readFileSync(path.join(state,name),"utf8").trim();
const put=(name,value)=>fs.writeFileSync(path.join(state,name),String(value));
const present=(name)=>fs.existsSync(path.join(state,name));
const remove=(name)=>fs.rmSync(path.join(state,name),{force:true});
const event=(name)=>fs.appendFileSync(path.join(state,"events"),name+"\n");
const emit=(value)=>process.stdout.write(JSON.stringify(value));
const scenario=read("scenario");
const bunSelected=()=>fs.existsSync(fixture.runtimeDrop)&&fs.readFileSync(fixture.runtimeDrop,"utf8").startsWith("# OpenClaw Team Gateway runtime: bun\n");
const persistentDrain=["always-draining","handoff-refused","handoff-uncertain"].includes(scenario);
const reject=(message)=>{process.stderr.write(message+"\n");process.exit(7);};
const parseJson=(bytes)=>{
  try { return JSON.parse(bytes); } catch { reject("synthetic JSON input invalid"); }
};
`
  );
}

function gatewaySource(fixture) {
  return (
    sourceHeader(fixture) +
    String.raw`
const args=process.argv.slice(2);
const activeLease=()=>{
  const lease=present("active-lease")?JSON.parse(read("active-lease")):null;
  if(lease&&lease.expiry<=Date.now()) {
    for(const name of ["active-lease","armed-handoff","request-id"])remove(name);
    event("suspension.expired");return null;
  }
  return lease;
};
if(process.env.OPENCLAW_CONFIG_PATH!==fixture.config||process.env.OPENCLAW_STATE_DIR!==fixture.root)
  reject("synthetic native CLI did not receive its admitted config and state paths");
const accounts=()=>{
  const account=(accountId)=>({accountId,configured:true,enabled:true,running:true,
    connected:true,lifecycle:"ready",restartPending:false,lastError:null});
  const result={eventLoop:present("event-loop")?parseJson(read("event-loop")):{degraded:false},
    channelAccounts:{clickclack:[account("default")],discord:[account("controller-test-agent")],reef:[account("default")]}};
  if(present("start-count")&&present("channel-failure")) result.channelAccounts.discord[0].connected=false;
  if(scenario==="runtime-unhealthy"&&bunSelected()) result.channelAccounts.discord[0].connected=false;
  return result;
};
const loadConfig=()=>parseJson(fs.readFileSync(fixture.config,"utf8"));
const setup=(config)=>config.cloudWorkers?.profiles?.aws?.settings?.setup;
const atomicConfig=(config)=>{
  const temporary=fixture.config+".fixture-next-"+process.pid;
  try {
    fs.writeFileSync(temporary,JSON.stringify(config,null,2)+"\n",{mode:0o600,flag:"wx"});
    fs.chownSync(temporary,fixture.runtimeUid,fixture.runtimeGid);
    fs.renameSync(temporary,fixture.config);
  } finally { fs.rmSync(temporary,{force:true}); }
};
const option=(name)=>{
  const index=args.indexOf(name);
  if(index<0||index===args.length-1) reject("fixture config option missing");
  return args[index+1];
};
try {
if(args[0]==="config"&&args[1]==="validate") {
  event("gateway config validate");
  const config=loadConfig();
  if(typeof setup(config)!=="string"||!config.meta?.migrations?.modelPolicyAllowlist)
    reject("fixture config invalid");
  if(scenario==="timer-change-during-validation") {
    put("timer-active","inactive");event("timer.changed-during-validation");
  }
  emit({ok:true,valid:true});
} else if(args[0]==="config"&&args[1]==="set") {
  const dry=args.includes("--dry-run");
  event(dry?"gateway config set --dry-run":"gateway config set");
  // Node reuses numeric slots. Check actual owner capabilities, including dup aliases,
  // against only this synthetic child's own descriptors, not other processes' fd tables.
  const journal=path.join(fixture.serving,"journal");
  const protectedFiles=[fixture.lockFile,...fs.readdirSync(journal)
    .filter(name=>/^operator-restart-\d{8}T\d{6}Z-\d+\.log$/.test(name))
    .map(name=>path.join(journal,name))];
  const identity=(entry)=>entry.dev+":"+entry.ino;
  const capabilities=new Set(protectedFiles.map(file=>fs.statSync(file,{throwIfNoEntry:false,bigint:true}))
    .filter(Boolean).map(identity));
  for(const name of fs.readdirSync("/proc/self/fd")) {
    if(!/^\d+$/.test(name)) continue;
    try {
      if(capabilities.has(identity(fs.fstatSync(Number(name),{bigint:true}))))
        reject("synthetic config writer inherited an owner capability");
    } catch(error) { if(error.code!=="EBADF") throw error; }
  }
  const expectedMode=args.includes("--expect-current-json");
  const batchMode=args.includes("--batch-file")||args.includes("--batch-json");
  if(expectedMode&&dry) reject("config set mode error: conditional expectations cannot be combined with --dry-run.");
  if(expectedMode&&batchMode) reject("config set mode error: conditional expectations require one path operation and cannot be combined with batch mode.");
  const allowed=new Set(["--batch-file","--expect-current-json","--dry-run","--strict-json"]);
  const seen=new Set();
  for(let i=batchMode?2:4;i<args.length;i++) {
    const flag=args[i];
    if(!allowed.has(flag)||seen.has(flag)) reject("fixture config invocation invalid");
    seen.add(flag);
    if(flag==="--batch-file"||flag==="--expect-current-json") {
      if(++i===args.length) reject("fixture config option missing");
    }
  }
  let value;
  if(batchMode) {
    const batch=parseJson(fs.readFileSync(option("--batch-file"),"utf8"));
    if(!Array.isArray(batch)||batch.length!==1||Object.keys(batch[0]).sort().join(",")!=="path,value"||
      batch[0].path!=="cloudWorkers.profiles.aws.settings.setup"||typeof batch[0].value!=="string")
      reject("fixture config batch invalid");
    value=batch[0].value;
  } else {
    if(args[2]!=="cloudWorkers.profiles.aws.settings.setup"||!seen.has("--strict-json"))
      reject("fixture requires a single strict-JSON setup path operation");
    value=parseJson(args[3]);
    if(typeof value!=="string") reject("fixture setup value must be a JSON string");
  }
  // These writes precede the native CLI's initial full-file snapshot, not the owner preflight.
  if(!dry&&!present("preread-applied")&&["preread-unrelated-write","preread-leaf-change"].includes(scenario)) {
    const concurrent=loadConfig();
    if(scenario==="preread-unrelated-write") concurrent.syntheticUnrelated.concurrent="preserved";
    else concurrent.cloudWorkers.profiles.aws.settings.setup="# synthetic concurrent setup\n";
    atomicConfig(concurrent);put("preread-applied",1);
    event(scenario==="preread-unrelated-write"?"config.preread-unrelated-write":"config.preread-leaf-change");
  }
  const initialBytes=fs.readFileSync(fixture.config),snapshot=parseJson(initialBytes);
  if(typeof setup(snapshot)!=="string") reject("fixture setup missing");
  if(dry) {
    if(seen.has("--expect-current-json")) reject("fixture preflight must not carry a write expectation");
    emit({ok:true,operations:1,checks:{schema:true,resolvability:true,resolvabilityComplete:true}});
  } else {
    const expected=parseJson(option("--expect-current-json"));
    if(typeof expected!=="string"||setup(snapshot)!==expected) reject("config current expectation failed");
    if(scenario==="hold-writer") {
      put("writer-blocked",1);event("config.write.blocked");
      const deadline=performance.now()+15000,waiter=new Int32Array(new SharedArrayBuffer(4));
      while(!present("release-writer")) {
        const remaining=deadline-performance.now();
        if(remaining<=0) reject("synthetic writer coordination timed out");
        Atomics.wait(waiter,0,0,Math.min(50,remaining));
      }
      event("config.write.released");
    }
    if(scenario==="writer-fail-before"&&!present("writer-failed")) {
      put("writer-failed",1);event("config.write.failed-before");reject("synthetic writer failure before publication");
    }
    // Native config-cli-runner retains snapshot.hash through replaceConfigFile; a late
    // unrelated write must fail CAS, while an unrelated pre-read write must be retained.
    if(scenario==="writer-cas-conflict"&&!present("cas-conflict-applied")) {
      const concurrent=loadConfig();concurrent.syntheticUnrelated.concurrent="cas-conflict";
      atomicConfig(concurrent);put("cas-conflict-applied",1);event("config.write.cas-conflict");
    }
    if(scenario==="inverse-cas-conflict"&&value===fixture.oldSetup&&
      present("writer-failed")&&!present("inverse-cas-conflict-applied")) {
      const concurrent=loadConfig();concurrent.syntheticUnrelated.concurrent="inverse-cas-winner";
      atomicConfig(concurrent);put("inverse-cas-conflict-applied",1);event("config.inverse.cas-conflict");
    }
    if(!fs.readFileSync(fixture.config).equals(initialBytes)) reject("config snapshot changed before write");
    snapshot.cloudWorkers.profiles.aws.settings.setup=value;
    snapshot.meta.lastTouchedVersion="2026.9.3";
    snapshot.meta.migrations.modelPolicyAllowlist=true;
    atomicConfig(snapshot);event("config.write.committed");
    if(["writer-fail-after","inverse-cas-conflict"].includes(scenario)&&!present("writer-failed")) {
      put("writer-failed",1);event("config.write.failed-after");reject("synthetic writer failure after publication");
    }
    emit({ok:true});
  }
} else if(args[0]==="gateway"&&args[1]==="status") {
  event("gateway gateway status");
  if(read("system")!=="active") reject("synthetic Gateway is stopped");
  if(present("start-count")&&present("rpc-failure")) reject("synthetic Gateway RPC failure");
  emit({rpc:{ok:true,server:{buildId:"fixture-"+read("running").slice(0,8)}},pluginVersionDrift:{drifts:[]}});
} else if(args[0]==="channels"&&args[1]==="status") {
  event("gateway channels status");
  if(scenario==="channel-client-auth-held") reject("synthetic device-auth persistence refused by held native state coordinator");
  emit(accounts());
} else if(args[0]==="gateway"&&args[1]==="call") {
  const method=args[2];
  const methods=new Set(["system.info","channels.status","update.status","terminal.list","sessions.list","agent","agent.wait",
    "gateway.suspend.prepare","gateway.suspend.status","gateway.suspend.resume","gateway.suspend.handoff"]);
  if(!methods.has(method)) reject("unsupported synthetic Gateway RPC");
  event("gateway gateway call "+method);
  if(read("system")!=="active") reject("synthetic Gateway is stopped");
  const params=parseJson(option("--params"));
  if(method==="agent") {
    const prefix="Output only this exact string, byte-for-byte, with no prefix or suffix: ";
    if(params.agentId!=="controller-test-agent"||params.deliver!==false||!params.message?.startsWith(prefix)||
      params.sessionKey!=="agent:controller-test-agent:explicit:"+params.sessionId?.toLowerCase()||!params.idempotencyKey||params.timeout<=0)
      reject("invalid synthetic agent ACK request");
    if(present("marker-accepted")&&JSON.parse(read("marker-accepted")).idempotencyKey===params.idempotencyKey) reject("marker was redispatched");
    put("marker-accepted",JSON.stringify(params));
    if(present("marker-rpc-failure")) {
      const failure=JSON.parse(read("marker-rpc-failure"));
      if(failure.method==="agent") {emit({fixtureError:failure.error});process.exit(7);}
    }
    if(scenario==="marker-generation-change") put("pid",222);
    emit({status:"accepted",runId:params.idempotencyKey,agentId:params.agentId,sessionKey:params.sessionKey});
  } else if(method==="agent.wait") {
    const accepted=JSON.parse(read("marker-accepted"));
    if(params.runId!==accepted.idempotencyKey||!Number.isInteger(params.timeoutMs)||params.timeoutMs<0) reject("wait did not retain accepted run");
    const observations=present("marker-observations")?JSON.parse(read("marker-observations")):[];
    observations.push({timeoutMs:params.timeoutMs,clientTimeoutMs:Number(option("--timeout")),atNs:process.hrtime.bigint().toString()});
    put("marker-observations",JSON.stringify(observations));
    if(present("marker-rpc-failure")) {
      const failure=JSON.parse(read("marker-rpc-failure"));
      if(failure.method==="agent.wait"&&(!failure.once||observations.length===1)) {
        if(failure.generationChange) put("pid",222);
        emit({fixtureError:failure.error});process.exit(7);
      }
    }
    if(scenario==="marker-wait-transport-error") reject("GatewayTransportError: gateway timeout after 15000ms");
    if(scenario==="marker-stream-close"&&!present("marker-waited")){put("marker-waited",1);emit({runId:params.runId,status:"timeout"});}
    else {
      const marker=accepted.message.split(": ").at(-1);
      const receipt={runId:params.runId,sessionId:accepted.sessionId,turnId:"fixture-turn",terminalDisposition:"visible",effective:{provider:"fixture",model:"exact-model",responseModel:"exact-model"}};
      if(scenario==="marker-wrong-session") receipt.sessionId="different-session";
      if(scenario==="marker-wrong-model") receipt.effective.model="different-model";
      if(scenario==="marker-response-model-alias") receipt.effective.responseModel="provider-response-alias";
      const result={runId:params.runId,status:"ok",stopReason:"stop",endedAt:Date.now(),terminalReply:{disposition:"visible",text:marker},terminalReceipt:receipt};
      if(scenario==="marker-no-stop-reason") delete result.stopReason;
      if(scenario==="marker-truncated") {
        result.stopReason="length";
        // The native terminal summary omits the delivery owner's truncation notice.
        put("marker-output",JSON.stringify({observation:result,payloads:[
          {text:marker},
          {text:"⚠️ Reply truncated at the model's output token limit. The text above is partial — ask to continue it."},
        ]}));
      }
      if(scenario==="marker-missing-receipt") delete result.terminalReceipt;
      if(scenario==="marker-error-with-reply") result.error="synthetic terminal failure";
      if(scenario==="marker-abort-with-reply") result.stopReason="aborted";
      if(scenario==="marker-pending-with-receipt") result.status="pending";
      if(scenario==="marker-generation-change-after-wait") put("pid",222);
      if(scenario==="timer-stopped-after-marker") put("timer-active","inactive");
      if(scenario==="timer-fired-after-marker") {
        put("timer-last",new Date().toUTCString());put("timer-next",new Date(Date.now()+7*3600000).toUTCString());
        event("timer.externally-fired");
      }
      if(scenario==="first-environment-file-drift") {
        const file=JSON.parse(read("environment-files"))[0];
        fs.writeFileSync(file,"SYNTHETIC_INPUT=changed\n");event("environment.first-file-changed");
      }
      emit(result);
    }
  } else if(method==="system.info") {
    const pid=Number(read("pid"));emit({pid,processInstanceId:"fixture-instance-"+pid});
  } else if(method==="channels.status") {
    if(params.probe!==true||!Number.isInteger(params.timeoutMs)||params.timeoutMs<=0||
      params.timeoutMs!==Number(option("--timeout"))||Object.keys(params).length!==2)
      reject("channel verification did not preserve its full probe and timeout contract");
    put("channel-probe-params",JSON.stringify(params));emit(accounts());
  }
  else if(method==="update.status") {
    if(scenario==="recovery-generation-before-marker"&&present("start-count")&&!present("recovery-generation-replaced")) {
      const oldPid=read("pid"),pid=444,directory=path.join(fixture.root,"proc",String(pid));
      fs.rmSync(path.join(fixture.root,"proc",oldPid),{recursive:true,force:true});
      fs.mkdirSync(directory,{recursive:true});
      const fields=Array.from({length:24},()=>"0");fields[0]="S";fields[19]="4440";
      fs.writeFileSync(path.join(directory,"stat"),pid+" (replacement fixture gateway) "+fields.join(" ")+"\n");
      fs.symlinkSync(fs.realpathSync(path.join(fixture.serving,"current")),path.join(directory,"cwd"));
      put("pid",pid);put("listener-pid",pid);put("system-exec-main-pid",pid);
      put("system-invocation-id","c".repeat(32));put("system-exec-start-monotonic",4440000);
      put("recovery-generation-replaced",1);event("process.replaced-before-marker");
    }
    emit({campaign:null,schedule:{autoEnabled:false}});
  }
  else if(method==="terminal.list") emit({sessions:[]});
  else if(method==="sessions.list") {
    const database=new DatabaseSync(fixture.agentDatabasePath,{readOnly:true});
    try { emit({sessions:database.prepare("SELECT session_key AS key, current_session_id AS sessionId FROM session_nodes ORDER BY session_key").all()}); }
    finally { database.close(); }
  }
  else if(method==="gateway.suspend.prepare") {
    if(Object.keys(params).sort().join(",")!=="drain,requestId,terminalPolicy"||
      params.terminalPolicy!=="preserve"||params.drain!==true||typeof params.requestId!=="string")
      reject("invalid synthetic suspension prepare");
    const existing=activeLease();
    if(existing&&present("request-id")&&read("request-id")!==params.requestId) reject("suspension request changed");
    put("request-id",params.requestId);
    const failure=present("prepare-failure")?JSON.parse(read("prepare-failure")):null;
    if(failure&&(!failure.renewal||present("active-lease"))) {
      process.stdout.write(failure.stdout);
      process.stderr.write(failure.stderr??"");
      process.exit(failure.exit);
    }
    const draining=persistentDrain||failure?.renewal;
    const sequence=existing?Number(read("lease-sequence")):Number(present("lease-sequence")?read("lease-sequence"):0)+1;
    put("lease-sequence",sequence);
    const expiry=existing&&present("armed-handoff")?existing.expiry:Date.now()+(failure?.renewal?20000:120000);
    const id=existing?existing.id:sequence===1?"fixture-preserve":"fixture-preserve-"+sequence;
    put("active-lease",JSON.stringify({id,expiry}));
    if(draining) event("suspension.draining");
    emit({status:draining?"draining":"ready",suspensionId:id,expiresAtMs:expiry,
      activeCount:draining?1:0,blockers:draining?[{kind:"terminal-session",count:1,message:"synthetic active terminal"}]:[],
      ...(draining?{retryAfterMs:1000}:{})});
  } else if(method==="gateway.suspend.handoff") {
    const lease=activeLease();
    if(Object.keys(params).sort().join(",")!=="suspensionId,target"||!lease||lease.expiry<=Date.now()||
      params.suspensionId!==lease.id||Object.keys(params.target??{}).sort().join(",")!=="pid,processInstanceId"||
      params.target.pid!==Number(read("pid"))||params.target.processInstanceId!=="fixture-instance-"+read("pid"))
      reject("synthetic handoff target or live lease mismatch");
    if(scenario==="handoff-refused") {event("handoff.refused");reject("synthetic handoff refused");}
    put("armed-handoff",JSON.stringify({id:lease.id,expiry:lease.expiry,pid:params.target.pid,instance:params.target.processInstanceId}));
    event("handoff.armed");
    emit({status:"armed",suspensionId:lease.id,expiresAtMs:lease.expiry+(scenario==="handoff-uncertain"?1:0)});
  } else {
    const lease=activeLease();
    if(method==="gateway.suspend.status") {
      if(Object.keys(params).join(",")!=="suspensionId"||typeof params.suspensionId!=="string"||
        params.suspensionId.length>128||!/\S/.test(params.suspensionId)) reject("invalid gateway.suspend.status params");
      event("suspension.status-query "+params.suspensionId);
      if(!lease||lease.expiry<=Date.now()) emit({status:"running"});
      else if(params.suspensionId!==lease.id) reject("suspension mismatch");
      else if(persistentDrain) {
        event("suspension.draining");
        emit({status:"draining",expiresAtMs:lease.expiry,activeCount:1,
          blockers:[{kind:"terminal-session",count:1,message:"synthetic active terminal"}],retryAfterMs:1000});
      } else emit({status:"ready",expiresAtMs:lease.expiry});
    } else if(!lease||lease.expiry<=Date.now()) emit({ok:true,status:"running",resumed:false});
    else if(params.suspensionId!==lease.id) emit({ok:false,reason:"suspension-mismatch"});
    else {remove("active-lease");remove("armed-handoff");remove("request-id");emit({ok:true,status:"running",resumed:true});}
  }
} else if(args[0]==="agent") {
  event("gateway agent");
  if(scenario==="marker-stream-close") reject("gateway closed (1006 abnormal closure): synthetic long response failure");
  if(read("system")!=="active") reject("synthetic Gateway is stopped");
  const prefix="Output only this exact string, byte-for-byte, with no prefix or suffix: ";
  const message=option("--message");
  if(option("--agent")!=="controller-test-agent"||!message.startsWith(prefix)||message.length===prefix.length)
    reject("unsupported synthetic agent marker request");
  const marker=message.slice(prefix.length);
  emit({result:{payloads:[{text:marker}],meta:{agentMeta:{provider:"fixture",model:"exact-model"}}}});
} else reject("unsupported synthetic Gateway command");
} catch {
  // Native writer failures must never print config, setup, expected JSON, or argv.
  event("gateway.command.failed");reject("synthetic Gateway command failed");
}
`
  );
}

function serviceSource(fixture) {
  return (
    sourceHeader(fixture) +
    String.raw`
const [command,...args]=process.argv.slice(2);
const guardLoaded=()=>present("guard-loaded")&&read("guard-loaded")==="1";
if(command==="busctl") {
  const unit="/org/freedesktop/systemd1/unit/openclaw_2dgateway_2eservice";
  const prefix=["--system","--json=short"];
  if(args[0]!==prefix[0]||args[1]!==prefix[1]) reject("invalid synthetic busctl format");
  if(JSON.stringify(args.slice(2))===JSON.stringify(["call","org.freedesktop.systemd1",
    "/org/freedesktop/systemd1","org.freedesktop.systemd1.Manager","GetUnit","s","openclaw-gateway.service"]))
    emit({type:"o",data:[unit]});
  else if(args[2]==="get-property"&&args[3]==="org.freedesktop.systemd1"&&args[4]===unit&&args.length===7) {
    if(args[5]==="org.freedesktop.systemd1.Unit"&&args[6]==="Conditions")
      emit({type:"a(sbbsi)",data:guardLoaded()?[["ConditionPathExists",false,false,fixture.permit,0]]:[]});
    else if(args[5]==="org.freedesktop.systemd1.Service"&&args[6]==="ExecConditionEx")
      emit({type:"a(sasasttttuii)",data:[]});
    else reject("unsupported synthetic busctl property");
  } else reject("unsupported synthetic busctl call");
} else if(command==="ss") {
  const pid=read("listener-pid");
  if(pid!=="0") process.stdout.write('LISTEN 0 511 127.0.0.1:18789 0.0.0.0:* users:((node,pid='+pid+',fd=18))\n');
} else if(command==="curl") {
  const endpoint=new URL(args.at(-1)).pathname;
  const probes={"/healthz":{ok:true,status:"live"},"/startupz":{ok:true,status:"started",uptimeMs:42},
    "/readyz":{ready:true,failing:[],uptimeMs:42,eventLoop:present("event-loop")?parseJson(read("event-loop")):{degraded:false}}};
  if(present("start-count")&&present("health-failure")) probes["/healthz"].ok=false;
  if(!Object.hasOwn(probes,endpoint)) reject("unsupported synthetic HTTP probe");
  event("probe."+endpoint.slice(1));
  if(read("system")!=="active"||read("listener-pid")==="0") process.exit(7);
  process.stdout.write(JSON.stringify(probes[endpoint])+"\n200");
} else if(command==="systemctl") {
  let scope="system";
  if(args[0]==="--user") {scope="user";args.shift();}
  const offline=args[0]==="--root=/";
  if(offline) args.shift();
  if(scenario==="user-manager-offline"&&scope==="user"&&!offline) {
    process.stderr.write("Failed to connect to user scope bus via local transport: No such file or directory\n");
    process.exit(1);
  }
  if(args[0]==="show"&&args[1]==="user@"+fixture.runtimeUid+".service") {
    const properties={LoadState:"loaded",ActiveState:"inactive",SubState:"dead",MainPID:"0",ControlPID:"0",Job:"",ControlGroup:""};
    for(const argument of args.filter(a=>a.startsWith("--property="))) {
      const key=argument.slice(11);if(!Object.hasOwn(properties,key))reject("unknown manager property");
      process.stdout.write(key+"="+properties[key]+"\n");
    }
    process.exit(0);
  }
  const operation=args[0],active=read(scope),pid=scope==="system"?read("pid"):read("user-pid");
  if(args[1]==="openclaw-hourly-update.service"||args[1]==="openclaw-hourly-update.timer") {
    const timer=args[1].endsWith(".timer"),name=args[1];
    if(operation==="start"&&timer) {
      event("timer.start");
      if(scenario==="timer-start-failed") reject("synthetic timer start failed");
      if(scenario==="generation-changed-during-timer") put("pid",444);
      if(scenario==="timer-stopped-after-observation") put("timer-started",1);
      if(scenario.startsWith("timer-catchup-")) put("timer-catchup-polls",0);
      put("timer-active","active");put("timer-invocation","8".repeat(32));
      put("timer-next",new Date(Date.now()+6*3600000).toUTCString());process.exit(0);
    }
    if(operation!=="show") reject("unsupported synthetic scheduler action");
    let catchup=false;
    if(!timer&&present("timer-catchup-polls")) {
      const poll=Number(read("timer-catchup-polls"))+1;put("timer-catchup-polls",poll);event("timer.catchup-poll."+poll);
      if(scenario==="timer-catchup-query-failed") reject("synthetic catch-up status failure");
      catchup=scenario==="timer-catchup-timeout"||poll<=2;
      if(!catchup) {
        remove("timer-catchup-polls");event("timer.catchup-settled");
        if(scenario==="timer-catchup-external-stop") {put("timer-active","inactive");event("timer.externally-stopped-during-catchup");}
      }
    }
    const timerActive=present("timer-active")?read("timer-active"):"active";
    const values={FragmentPath:path.join(fixture.root,"etc/systemd/system",name),DropInPaths:"",EnvironmentFiles:"",
      Environment:"OPENCLAW_TEAM_DRAIN_BUDGET=30",ExecStart:"{ argv[]=/usr/local/sbin/openclaw-release-deploy --interrupt-after-drain --allow-cpu-degraded ; }",
      MainPID:catchup?"777":"0",ControlPID:"0",Job:catchup?"123":present("updater-job")?read("updater-job"):"0",
      InvocationID:read("timer-invocation"),
      ActiveState:timer?timerActive:catchup?"activating":"inactive",SubState:timer?(timerActive==="active"?"waiting":"dead"):catchup?"start":"dead",
      UnitFileState:"enabled",TimersCalendar:"{ OnCalendar=*-*-* 05/6:17:00 UTC ; next_elapse=Sun 2026-09-13 17:17:00 UTC }",
      Persistent:"yes",RandomizedDelayUSec:"10min",AccuracyUSec:"30s",Triggers:"openclaw-hourly-update.service",
      NextElapseUSecRealtime:read("timer-next"),LastTriggerUSec:read("timer-last")};
    for(const argument of args.filter(a=>a.startsWith("--property="))) {
      const name=argument.slice(11);if(!Object.hasOwn(values,name))reject("unsupported synthetic scheduler property");
      if(name==="EnvironmentFiles")continue;
      process.stdout.write((args.includes("--value")?"":name+"=")+values[name]+"\n");
    }
    if(timer&&scenario==="timer-stopped-after-observation"&&present("timer-started")&&timerActive==="active") {
      put("timer-active","inactive");event("timer.externally-stopped-after-observation");
    }
    process.exit(0);
  }
  if(operation==="is-active"||operation==="is-enabled") {
    const value=operation==="is-active"?active:read(scope+"-enabled");
    process.stdout.write(value+"\n");process.exit(value===(operation==="is-active"?"active":"enabled")?0:3);
  } else if(operation==="show") {
    const entry=path.join(scope==="system"?fixture.serving:fixture.runtime,"current");
    const properties={ActiveState:active,SubState:active==="active"?"running":active==="failed"?"failed":"dead",
      MainPID:pid,ControlPID:read(scope+"-control-pid"),Job:read(scope+"-job"),
      UnitFileState:read(scope+"-enabled"),ExecMainPID:read(scope+"-exec-main-pid"),
      InvocationID:read(scope+"-invocation-id"),ExecMainStartTimestampMonotonic:read(scope+"-exec-start-monotonic"),
      ControlGroup:read(scope+"-control-group"),Slice:scope==="system"?read("system-slice"):"",
      FragmentPath:fixture.fragment,DropInPaths:fixture.guard,EnvironmentFiles:"",WorkingDirectory:path.join(fixture.serving,"current"),
      PassEnvironment:"",UnsetEnvironment:"",TimeoutStopUSec:"90s",KillMode:"control-group",SendSIGKILL:"yes",
      KillSignal:"15",RestartKillSignal:"15",FileDescriptorStoreMax:"0",NFileDescriptorStore:"0",RuntimeDirectory:"",
      RequiredBy:"",RequisiteOf:"",PartOf:"",ConsistsOf:"",BindsTo:"",BoundBy:"",
      PropagatesStopTo:"",StopPropagatedFrom:"",Upholds:"",UpheldBy:"",
      ExecStart:"{ path="+read("runtime-executable")+" ; argv[]="+read("runtime-executable")+" "+entry+"/dist/index.js gateway --port 18789 ; }",
      User:"openclaw",Group:"openclaw",Environment:"HOME="+fixture.runtime+" OPENCLAW_SUPERVISOR_MODE=external"};
    if(present("stop-start-properties")) Object.assign(properties,JSON.parse(read("stop-start-properties")));
    const names=args.filter(a=>a.startsWith("--property=")).flatMap(a=>a.slice(11).split(","));
    for(const name of names.length?names:Object.keys(properties)) {
      if(!Object.hasOwn(properties,name)) reject("unsupported synthetic systemctl property");
      if(name==="EnvironmentFiles"&&present("environment-files")) {
        for(const file of JSON.parse(read("environment-files")))process.stdout.write("EnvironmentFiles="+file+" (ignore_errors=no)\n");
        continue;
      }
      process.stdout.write((args.includes("--value")?"":name+"=")+properties[name]+"\n");
      if(name==="WorkingDirectory"&&scenario==="duplicate-scalar-property")process.stdout.write("WorkingDirectory="+properties[name]+"\n");
    }
  } else if(operation==="daemon-reload") {
    event("service."+scope+".daemon-reload");
    if(scope==="system") {
      if(scenario==="runtime-crash-after-publication"&&bunSelected()&&!present("runtime-crashed")) {
        put("runtime-crashed",1);process.kill(Number(process.env.FIXTURE_OWNER_PID),"SIGKILL");process.exit(137);
      }
      const body=fs.existsSync(fixture.runtimeDrop)?fs.readFileSync(fixture.runtimeDrop,"utf8"):"";
      const executable=body.split("\n").find(line=>line.startsWith("ExecStart=")&&line!=="ExecStart=")?.slice(10).split(" ")[0];
      put("runtime-executable",executable||"/usr/bin/node");
      if(scenario==="runtime-crash-after-selection"&&bunSelected()&&!present("runtime-crashed")) {
        put("runtime-crashed",1);process.kill(Number(process.env.FIXTURE_OWNER_PID),"SIGKILL");process.exit(137);
      }
      if(scenario==="runtime-drop-drift"&&bunSelected()) fs.appendFileSync(fixture.runtimeDrop,"Environment=UNRELATED=1\n");
      if(scenario==="runtime-binary-drift"&&bunSelected()) fs.appendFileSync(read("runtime-executable"),"# changed after admission\n");
      const expected="[Unit]\nConditionPathExists="+fixture.permit+"\n";
      put("guard-loaded",fs.existsSync(fixture.guard)&&fs.readFileSync(fixture.guard,"utf8")===expected?1:0);
    }
  } else if(operation==="enable"||operation==="disable") {
    event("service."+scope+"."+operation);put(scope+"-enabled",operation==="enable"?"enabled":"disabled");
  } else if(["stop","start","restart"].includes(operation)) {
    event("service."+scope+"."+operation);
    if(operation==="stop"&&scenario==="stop-refused") reject("synthetic stop refused before stopping the original process");
    if(operation==="start"&&scenario==="recovery-start-refused") reject("synthetic recovery start refused without a process");
    if(operation==="start"&&scenario==="raced-stop-job") {
      put("system-job",123);
      if(args.includes("--job-mode=fail")) reject("synthetic conflicting stop job preserved");
      put("system-job",0);event("competing-stop.replaced");
    }
    if(operation!=="start") {
      let intent="stop";
      if(scope==="system"&&present("armed-handoff")) {
        const arm=JSON.parse(read("armed-handoff")),lease=present("active-lease")?JSON.parse(read("active-lease")):null;
        if(!lease||arm.id!==lease.id||arm.expiry!==lease.expiry||arm.expiry<=Date.now()||
          arm.pid!==Number(pid)||arm.instance!=="fixture-instance-"+pid) reject("synthetic stop cannot consume a foreign handoff");
        event("handoff.consumed");intent="external-restart";remove("armed-handoff");
      }
      if(scope==="system") put("shutdown-kind",intent);
      fs.rmSync(path.join(fixture.root,"proc",pid),{recursive:true,force:true});
      put(scope,"inactive");put(scope==="system"?"pid":"user-pid",0);
      put(scope+"-control-pid",0);put(scope+"-job",0);
      if(scope==="system") {
        put("listener-pid",0);
        for(const name of ["request-id","active-lease","expiry"]) remove(name);
      }
    }
    if(operation==="stop") process.exit(0);
    if(scope!=="system") reject("synthetic legacy start is not supported");
    if(scenario==="runtime-start-fail"&&bunSelected()&&!present("runtime-start-failed")) {
      put("runtime-start-failed",1);reject("synthetic selected runtime failed to start");
    }
    // ConditionPathExists is checked on each start. A skipped start succeeds without a process.
    if((guardLoaded()&&!fs.existsSync(fixture.permit))||scenario==="skip0"||scenario==="start-skip0") {
      event("service.system.start-skipped");process.exit(0);
    }
    if(read("system")==="active") process.exit(0);
    const count=present("start-count")?Number(read("start-count"))+1:1;
    put("start-count",count);
    const nextPid=333+count-1,ticks=String(nextPid*10),release=fs.realpathSync(path.join(fixture.serving,"current"));
    const directory=path.join(fixture.root,"proc",String(nextPid));
    fs.mkdirSync(directory,{recursive:true});
    const fields=Array.from({length:24},()=>"0");fields[0]="S";fields[19]=ticks;
    fs.writeFileSync(path.join(directory,"stat"),nextPid+" (fixture gateway) "+fields.join(" ")+"\n");
    fs.symlinkSync(release,path.join(directory,"cwd"));
    fs.symlinkSync(scenario==="runtime-wrong-executable"?"/usr/bin/node":read("runtime-executable"),path.join(directory,"exe"));
    if(scenario==="lose-session-on-start") {
      const database=new DatabaseSync(fixture.agentDatabasePath);
      try { database.prepare("DELETE FROM session_nodes WHERE session_key = ?").run("agent:controller-test-agent:existing"); }
      finally { database.close(); }
      event("session.deleted-on-start");
    }
    if(scenario==="replace-empty-store-on-start") {
      const replacement=fixture.agentDatabasePath+".replacement";
      fs.copyFileSync(fixture.agentDatabasePath,replacement);fs.renameSync(replacement,fixture.agentDatabasePath);
      event("empty-store.replaced");
    }
    put("running",path.basename(release));put("pid",nextPid);put("listener-pid",nextPid);put("system","active");
    put("system-control-pid",0);put("system-job",0);
    put("system-exec-main-pid",nextPid);put("system-invocation-id",nextPid.toString(16).padStart(32,"0"));
    put("system-exec-start-monotonic",nextPid*10000);
    if(scenario==="runtime-crash-after-start"&&bunSelected()&&!present("runtime-crashed")) {
      put("runtime-crashed",1);process.kill(Number(process.env.FIXTURE_OWNER_PID),"SIGKILL");process.exit(137);
    }
    if(scenario==="start-pending-job") put("system-job",123);
    if(scenario==="start-uncertain") reject("synthetic start acknowledgment lost after process creation");
  } else reject("unsupported synthetic systemctl command");
} else reject("unsupported synthetic service command");
`
  );
}

function writeRelease(fixture, releaseSha = sha) {
  const sha = releaseSha;
  const release = join(fixture.serving, "releases", sha);
  for (const name of [".git/objects/info", "dist/control-ui/assets", "node_modules"])
    mkdirSync(join(release, name), { recursive: true });
  writeFileSync(join(release, ".git", "HEAD"), sha + "\n");
  writeFileSync(join(release, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  writeFileSync(join(release, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(
    join(release, "package.json"),
    JSON.stringify({ version: "2026.9.3", openclaw: { schemaVersions: { state: 1, agent: 1 } } }),
  );
  for (const stamp of [".buildstamp", ".runtime-postbuildstamp"])
    writeFileSync(join(release, "dist", stamp), JSON.stringify({ head: sha }));
  writeFileSync(
    join(release, "dist", "build-info.json"),
    JSON.stringify({ commit: sha, buildId: "fixture-" + sha.slice(0, 8) }),
  );
  writeFileSync(
    join(release, "dist", "control-ui", "index.html"),
    '<html><script src="./assets/app.js"></script></html>',
  );
  writeFileSync(join(release, "dist", "control-ui", "assets", "app.js"), "fixture();\n");
  writeFileSync(join(release, "dist", "index.js"), gatewaySource(fixture), { mode: 0o755 });
  mkdirSync(join(release,"dist/plugin-sdk"),{recursive:true});
  writeFileSync(join(release,"dist/plugin-sdk/gateway-runtime.js"), `
import {spawnSync} from 'node:child_process';
export function isGatewayTransportError(error) {
  return error instanceof Error&&error.name==='GatewayTransportError'&&
    ['timeout','closed'].includes(error.kind)&&typeof error.connectionDetails==='object'&&error.connectionDetails!==null;
}
export async function callGatewayFromCli(method,opts,params,extra) {
  if(extra.clientName!=='cli'||extra.mode!=='cli'||JSON.stringify(extra.scopes)!=='["operator.admin"]'||extra.expectFinal!==false||extra.sharedStateMode!=='read-only'||opts.json!==true) throw Error('native CLI identity changed');
  const r=spawnSync(process.execPath,[new URL('../index.js',import.meta.url).pathname,'gateway','call',method,'--params',JSON.stringify(params),'--json','--timeout',opts.timeout],{encoding:'utf8',env:process.env});
  if(r.status!==0) {
    if(r.stdout) throw Object.assign(Error('synthetic private transport detail'),JSON.parse(r.stdout).fixtureError);
    throw Error(r.stderr);
  }
  return JSON.parse(r.stdout);
}
`);

  for (const args of [
    ["manifest", release, sha, String(process.getuid()), sha],
    ["seal-tree", release],
  ]) {
    const result = spawnSync(process.execPath, ["--no-warnings", library, ...args], {
      encoding: "utf8",
      env: fixture.env,
      cwd: fixture.root,
      timeout: 30_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
}

export function makeWorkerConfigFixture(t, scenario = "success") {
  return makeOwnerFixture(t, scenario, true);
}

export function makeReleaseFixture(t, scenario = "success") {
  return makeOwnerFixture(t, scenario, false);
}

function makeOwnerFixture(t, scenario, workerConfig) {
  if (workerConfig && (process.platform !== "linux" || process.getuid() !== 0 || process.getgid() !== 0))
    throw new Error(
      "full owner fixture requires disposable Linux root (UID/GID 0) for real config ownership",
    );
  // Owner profiling still uses an absolute diagnostics path outside the synthetic release root.
  for (const pathname of ["/opt/openclaw-team/current", "/var/lib/openclaw-team-diagnostics"]) {
    if (lstatSync(pathname, { throwIfNoEntry: false }))
      throw new Error(
        "full owner fixture refuses a host with existing Team runtime or diagnostics state",
      );
  }
  const runtimeUid = process.getuid() === 1000 ? 1001 : 1000,
    runtimeGid = 1000,
    deployUid = process.getuid() === 2000 ? 2001 : 2000;
  const realCommands = {
    bash: command(["bash"]),
    timeout: command(["timeout", "gtimeout"]),
    flock: command(["flock"], false),
  };
  if (scenario === "hold-writer" && !realCommands.flock)
    throw new Error("hold-writer contention proof requires real flock");
  const root = realpathSync(mkdtempSync(join(tmpdir(), "team-worker-config-owner-")));
  t.after(() => {
    writableTree(root);
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
  const state = join(root, "state"),
    commands = join(root, "commands");
  const serving = join(root, "opt", "openclaw-team"),
    build = join(root, "build"),
    runtime = join(root, "runtime");
  for (const directory of [
    state,
    commands,
    serving,
    build,
    runtime,
    join(root, "tmp"),
    join(root, "proc"),
  ])
    mkdirSync(directory, { recursive: true });
  for (const name of ["sys", "sys/fs", "sys/fs/cgroup", "sys/fs/cgroup/system.slice"]) {
    const directory = join(root, name);
    mkdirSync(directory, { mode: 0o755 });
    chmodSync(directory, 0o755);
  }
  for (const name of ["sys/fs/cgroup", "sys/fs/cgroup/system.slice"]) {
    for (const control of ["cgroup.procs", "cgroup.threads", "cgroup.subtree_control"]) {
      const file = join(root, name, control);
      writeFileSync(file, "", { mode: 0o644 });
      chmodSync(file, 0o644);
    }
  }
  chmodSync(build, 0o750);
  chmodSync(join(root, "opt"), 0o755);
  chmodSync(serving, 0o755);
  for (const name of ["staging", "journal", "pins", "failed", "quarantine"]) {
    mkdirSync(join(serving, name), { mode: 0o700 });
    chmodSync(join(serving, name), 0o700);
  }
  mkdirSync(join(serving, "releases"), { mode: 0o755 });
  for (const name of ["work", "home", "config", "cache", "pnpm", "mirror"]) {
    mkdirSync(join(build, name), { mode: 0o700 });
    chmodSync(join(build, name), 0o700);
  }
  mkdirSync(join(build, "mirror", "mirror.git"));
  for (const name of [".openclaw", ".config", ".cache", "run"])
    mkdirSync(join(runtime, name), { mode: 0o700 });
  for (const [name, value] of Object.entries({
    scenario,
    events: "",
    "runtime-executable": "/usr/bin/node",
    system: "active",
    user: "inactive",
    "system-enabled": "enabled",
    "user-enabled": "disabled",
    pid: "111",
    "user-pid": "0",
    "system-control-pid": "0",
    "user-control-pid": "0",
    "system-job": "0",
    "user-job": "0",
    "system-exec-main-pid": "111",
    "user-exec-main-pid": "0",
    "system-invocation-id": "1".repeat(32),
    "user-invocation-id": "",
    "system-exec-start-monotonic": "1110000",
    "user-exec-start-monotonic": "0",
    "system-control-group": "/system.slice/openclaw-gateway.service",
    "user-control-group": "",
    "system-slice": "system.slice",
    "listener-pid": "111",
    "guard-loaded": "1",
    "timer-invocation": "7".repeat(32),
    "timer-next": new Date(Date.now()+6*3600000).toUTCString(),
    "timer-last": "Sun 2026-09-13 11:17:00 UTC",
    running: sha,
  }))
    writeFileSync(join(state, name), value);
  const config = join(state, "openclaw.json"),
    databasePath = join(state, "openclaw.sqlite");
  const original = {
    meta: { lastTouchedVersion: "2026.9.3", migrations: { modelPolicyAllowlist: true } },
    update: { auto: { enabled: false } },
    channels: { clickclack: { commandMenu: false } },
    tools: { exec: { mode: "full" }, fs: { workspaceOnly: true } },
    plugins: {
      entries: {
        codex: {
          config: {
            appServer: {
              mode: "yolo",
              approvalPolicy: "never",
              approvalsReviewer: "user",
              sandbox: "danger-full-access",
              defaultWorkspaceDir: "/home/openclaw/.openclaw/workspace",
            },
          },
        },
      },
    },
    agents: { entries: { "controller-test-agent": { model: { primary: "fixture/exact-model" } } } },
    cloudWorkers: {
      profiles: {
        aws: {
          provider: "crabbox",
          settings: {
            binary: "/home/openclaw/.openclaw/bin/crabbox-artifact",
            desktop: true,
            setup: oldSetup,
          },
        },
      },
    },
    syntheticUnrelated: { retained: "nonsecret-synthetic-sibling" },
  };
  writeFileSync(config, JSON.stringify(original) + "\n", { mode: 0o600 });
  if (workerConfig) chownSync(config, runtimeUid, runtimeGid);
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA user_version=1; CREATE TABLE operator_approvals (source_session_id TEXT)");
  database.close();
  chmodSync(databasePath, 0o600);
  // Canonical discovery scans root/agents; no shared registry entry is needed for this store.
  const agentDatabasePath = join(root, "agents", "controller-test-agent", "agent", "openclaw-agent.sqlite");
  mkdirSync(dirname(agentDatabasePath), { recursive: true });
  const agentDatabase = new DatabaseSync(agentDatabasePath);
  try {
    agentDatabase.exec(`PRAGMA user_version=1;
      CREATE TABLE schema_meta (meta_key TEXT, role TEXT, schema_version INTEGER, agent_id TEXT);
      INSERT INTO schema_meta VALUES ('primary', 'agent', 1, 'controller-test-agent');
      CREATE TABLE session_nodes (session_key TEXT PRIMARY KEY, current_session_id TEXT NOT NULL, entry_json TEXT NOT NULL, updated_at INTEGER NOT NULL, archived_at INTEGER);
      CREATE TABLE session_windows (session_id TEXT PRIMARY KEY, session_key TEXT NOT NULL);
      CREATE TABLE transcript_rewrite_watermarks (session_id TEXT PRIMARY KEY, generation TEXT NOT NULL);
      CREATE TABLE session_transcript_archives (session_id TEXT, generation TEXT, session_key TEXT, archive_blob BLOB, archive_sha256 TEXT, encoding TEXT);`);
    agentDatabase
      .prepare("INSERT INTO session_nodes VALUES (?, ?, ?, ?, NULL)")
      .run(
        "agent:controller-test-agent:existing",
        "synthetic-generation",
        JSON.stringify({ sessionId: "synthetic-generation", updatedAt: 1 }),
        1,
      );
  } finally {
    agentDatabase.close();
  }
  chmodSync(agentDatabasePath, 0o600);
  const fragment = join(root, "etc", "systemd", "system", "openclaw-gateway.service");
  const guard = fragment + ".d/zz-openclaw-agent-schema-migration.conf";
  const permit = join(serving, "journal", "gateway-start-permit");
  mkdirSync(dirname(guard), { recursive: true, mode: 0o755 });
  writeFileSync(
    fragment,
    "[Service]\nUser=openclaw\nGroup=openclaw\nKillMode=control-group\nTimeoutStopSec=90\nSendSIGKILL=yes\n" +
      `ExecStart=/usr/bin/node ${serving}/current/dist/index.js gateway --port 18789\n`,
    { mode: 0o644 },
  );
  chmodSync(fragment, 0o644);
  writeFileSync(guard, `[Unit]\nConditionPathExists=${permit}\n`, { mode: 0o644 });
  chmodSync(guard, 0o644);
  writeFileSync(permit, '{"version":1,"purpose":"gateway-start-permit"}\n', { mode: 0o600 });
  const originalConfigBytes = readFileSync(config);
  const fixture = {
    root,
    state,
    commands,
    serving,
    servingRoot: serving,
    build,
    runtime,
    config,
    configPath: config,
    databasePath,
    agentDatabasePath,
    original,
    originalConfigBytes,
    initial: join(serving, "releases", sha),
    sha,
    pid: 111,
    start: "1110",
    generation: "1110",
    oldSetup,
    configSha256: hash(originalConfigBytes),
    oldSetupSha256: hash(oldSetup),
    fragment,
    guard,
    runtimeDrop: join(root, "etc/systemd/system/openclaw-gateway.service.d/50-openclaw-gateway-runtime.conf"),
    permit,
    journal: join(serving, "journal", "activation.json"),
    eventlog: join(state, "events"),
    owner,
    library,
    realCommands,
    runtimeUid,
    runtimeGid,
    lockFile: join(root, "deployment.lock"),
    accountMode: "fake-role-routing-no-uid-drop",
    lockMode: realCommands.flock ? "real-flock" : "fake-no-mutual-exclusion-proof",
  };
  const driver = join(commands, "service-fixture.cjs");
  writeFileSync(driver, serviceSource(fixture));
  fixture.commandPaths = Object.fromEntries(
    ["systemctl", "busctl", "ss", "curl", "runuser", "flock", "id"].map((name) => [
      name,
      join(commands, name),
    ]),
  );
  for (const name of ["systemctl", "busctl", "ss", "curl"])
    executable(fixture.commandPaths[name], [
      `exec ${quote(process.execPath)} ${quote(driver)} ${quote(name)} "$@"`,
    ]);
  executable(fixture.commandPaths.id, [
    '[[ "$#" == 2 && "$1" == -g && "$2" == openclaw ]] || exit 64',
    `printf '%s\\n' '${runtimeGid}'`,
  ]);
  // Account routing is synthetic, not a UID drop. Config ownership uses real Linux filesystem metadata.
  executable(fixture.commandPaths.runuser, [
    '[[ "$1" == -u && "$3" == -- ]] || exit 64',
    'case "$2" in openclaw) operation=account.openclaw ;; openclaw-deploy) operation=account.openclaw-deploy ;; *) exit 64 ;; esac',
    `printf '%s\n' "$operation" >>${quote(fixture.eventlog)}`,
    "shift 3",
    'exec "$@"',
  ]);
  // Minimal Linux images may omit flock. This fallback proves neither contention nor mutual exclusion.
  executable(
    fixture.commandPaths.flock,
    realCommands.flock
      ? [`exec ${quote(realCommands.flock)} "$@"`]
      : ['[[ "$#" == 2 && "$1" == -n && "$2" == 9 ]]'],
  );
  // Refuse accidental build/network work rather than allowing ambient tools to execute it.
  for (const name of ["git", "pnpm", "ssh", "scp", "sudo", "chown"])
    executable(join(commands, name), ["exit 64"]);
  const uid = process.getuid(),
    gid = process.getgid();
  const fixturePath = [commands, dirname(process.execPath), ...utilityDirectories].join(":");
  fixture.env = {
    PATH: fixturePath,
    HOME: runtime,
    TMPDIR: join(root, "tmp"),
    TMP: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    LANG: "C",
    LC_ALL: "C",
    TZ: "UTC",
    XDG_CONFIG_HOME: join(runtime, ".config"),
    XDG_CACHE_HOME: join(runtime, ".cache"),
    XDG_RUNTIME_DIR: join(runtime, "run"),
    OPENCLAW_HOME: runtime,
    OPENCLAW_STATE_DIR: state,
    OPENCLAW_CONFIG_PATH: config,
    NODE_DISABLE_COMPILE_CACHE: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    npm_config_userconfig: join(build, "config", "npmrc"),
    OPENCLAW_TEAM_RELEASE_ROOT: serving,
    OPENCLAW_TEAM_BUILD_HOME: build,
    OPENCLAW_TEAM_RUNTIME_HOME: runtime,
    OPENCLAW_TEAM_CONFIG_FILE: config,
    OPENCLAW_TEAM_STATE_DATABASE: databasePath,
    OPENCLAW_TEAM_NODE_BIN: process.execPath,
    OPENCLAW_TEAM_RELEASE_LIB: library,
    OPENCLAW_TEAM_OPERATOR_PROFILE: process.env.OPENCLAW_TEAM_OPERATOR_PROFILE,
    OPENCLAW_TEAM_RUNUSER: fixture.commandPaths.runuser,
    OPENCLAW_TEAM_TIMEOUT: realCommands.timeout,
    OPENCLAW_TEAM_SYSTEMCTL: fixture.commandPaths.systemctl,
    OPENCLAW_TEAM_BUSCTL: fixture.commandPaths.busctl,
    OPENCLAW_TEAM_CURL: fixture.commandPaths.curl,
    OPENCLAW_TEAM_SS: fixture.commandPaths.ss,
    OPENCLAW_TEAM_PROC_ROOT: join(root, "proc"),
    OPENCLAW_TEAM_LOCK_FILE: fixture.lockFile,
    OPENCLAW_TEAM_ROOT_UID: String(uid),
    OPENCLAW_TEAM_ROOT_GID: String(gid),
    OPENCLAW_TEAM_RUNTIME_UID: String(runtimeUid),
    OPENCLAW_TEAM_DEPLOY_UID: String(deployUid),
    OPENCLAW_TEAM_DEPLOY_GID: String(gid),
    OPENCLAW_TEAM_DEPLOY_FILE_UID: String(uid),
    OPENCLAW_TEAM_ANCESTOR_BOUNDARY: root,
    OPENCLAW_TEAM_RUNTIME_DIR: join(runtime, "run"),
    OPENCLAW_TEAM_BUILD_PATH: fixturePath,
    OPENCLAW_TEAM_VERIFICATION_BUDGET: "600",
    OPENCLAW_TEAM_RETRY_SECONDS: "1",
    OPENCLAW_TEAM_DRAIN_BUDGET: "12",
    OPENCLAW_TEAM_DRAIN_POLL_INTERVAL: "1",
  };
  writeRelease(fixture);
  fixture.addRelease = (releaseSha) => {
    writeRelease(fixture, releaseSha);
    return join(serving, "releases", releaseSha);
  };
  symlinkSync(fixture.initial, join(serving, "current"));
  processEntry(root, fixture.pid, fixture.start, fixture.initial);
  return fixture;
}

export function runOwner(fixture, args = [], input) {
  // The synthetic proc tree models process identity, not native process or FD lifetime.
  return spawnSync(
    fixture.realCommands.bash,
    ["-c", `export FIXTURE_OWNER_PID=$$
mkdir -p "$OPENCLAW_TEAM_PROC_ROOT/$$"
mkdir -p "$OPENCLAW_TEAM_PROC_ROOT/$$/fd" "$OPENCLAW_TEAM_PROC_ROOT/$$/fdinfo"
: > "$OPENCLAW_TEAM_PROC_ROOT/$$/maps"
printf '%s (fixture owner) S ${Array(18).fill("0").join(" ")} 11100 0 0 0 0\\n' "$$" >"$OPENCLAW_TEAM_PROC_ROOT/$$/stat"
exec "$@"`, "fixture-owner", fixture.owner, ...args.map(String)],
    {
      encoding: "utf8",
      env: fixture.env,
      cwd: fixture.root,
      input,
      timeout: fixture.ownerTimeoutMs ?? 90_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
}

export function events(fixture) {
  return readFileSync(fixture.eventlog, "utf8");
}
