// Manual Linux integration proof; this intentionally boots processes outside per-PR unit CI.
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { stopChild } from "./lib/gateway-bench-child.ts";
import { runControlUiLoad } from "./lib/gateway-bench-control-ui.ts";
import { createGatewayLoadResources } from "./lib/gateway-bench-load-resources.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import { waitForReliabilityWorkerMessage } from "./lib/sqlite-reliability-process.ts";

const fixture = `
const {spawn}=require('node:child_process');
const {Worker}=require('node:worker_threads');
const mode=process.argv[2];
if(mode==='accounting') {
  process.on('message',()=>{});
  const worker=new Worker('const until=Date.now()+250; while(Date.now()<until){}',{eval:true});
  const child=spawn(process.execPath,['-e',"const begin=process.cpuUsage(); while(process.cpuUsage(begin).user<150000){}; process.send({cpu:process.cpuUsage()})"],{stdio:['ignore','ignore','inherit','ipc']});
  let childCpu;
  child.on('message', m=>childCpu=m.cpu);
  Promise.all([new Promise(r=>child.once('exit',r)),new Promise(r=>worker.once('exit',r))]).then(()=>{
    const memory=Buffer.alloc(16*1024*1024,1);
    process.send({type:'accounted',childCpu,processCpu:process.cpuUsage(),memory:memory.length});
  });
} else if(mode==='forced') {
  process.on('SIGTERM',()=>{});
  setInterval(()=>{},1000);
  process.send({type:'ready'});
} else {
  const {WebSocketServer}=require(process.env.BENCH_WS_MODULE);
  const server=new WebSocketServer({host:'127.0.0.1',port:Number(process.argv[3])});
  server.once('listening',()=>process.send({type:'ready'}));
  server.on('connection',socket=>{
    const send=value=>{if(socket.readyState===socket.OPEN)socket.send(JSON.stringify(value));};
    send({type:'event',event:'connect.challenge',payload:{nonce:'synthetic-proof',ts:Date.now()}});
    socket.on('message',data=>{
      const req=JSON.parse(String(data));
      const reply=payload=>send({type:'res',id:req.id,ok:true,payload});
      if(req.method==='chat.send') {
        const p=req.params, id=p.idempotencyKey, warm=id.endsWith('-0');
        const token=p.message.match(/OPENCLAW_E2E_[A-Z0-9_]+/)[0];
        const event=(state,runId,extra={})=>send({type:'event',event:'chat',payload:{state,runId,sessionKey:p.sessionKey,...extra}});
        if(!warm && mode==='disconnect'){socket.close();return;}
        if(!warm && (mode==='timeout'||mode==='cancel')){reply({runId:id,status:'started'});process.send({type:'active'});return;}
        const run='followup-'+id;
        event('delta',run,{deltaText:token.slice(0,9)});
        event('final',run,{message:{role:'assistant',content:[{type:'text',text:token}]}});
        reply({runId:id,status:'started'});
        event('final',id);
        event('final',run,{message:{role:'assistant',text:token}});
        if(!warm && mode==='late-error')event('error',run,{errorMessage:'synthetic late failure'});
      } else reply(req.method.includes('subscribe')?{subscribed:true}:{});
    });
  });
}
`;

function message<T = { type: string }>(child: ChildProcess, type: string): Promise<T> {
  return waitForReliabilityWorkerMessage<T>({
    child,
    matches: (value) =>
      value !== null && typeof value === "object" && "type" in value && value.type === type,
    timeoutMs: 10_000,
    timeoutMessage: () => `Fixture timed out before ${type}`,
    exitMessage: () => `Fixture exited before ${type}`,
  });
}

async function main() {
  const [runtime, parent] = process.argv.slice(2);
  assert.ok(
    runtime && parent,
    "Usage: node --import ./scripts/tsx.mjs scripts/bench-gateway-control-ui-proof.ts <gateway-runtime> <delegated-cgroup-parent>",
  );
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-control-ui-proof-"));
  const fixtureFile = path.join(root, "fixture.cjs");
  writeFileSync(fixtureFile, fixture);
  const receipts: unknown[] = [];
  try {
    for (const scenario of [
      "accounting",
      "forced",
      "normal",
      "disconnect",
      "timeout",
      "late-error",
      "cancel",
    ]) {
      const resources = createGatewayLoadResources(parent);
      const workers = path.join(root, `${scenario}-workers.jsonl`);
      const port = await getFreePort();
      const spawnedEpochMs = performance.timeOrigin + performance.now();
      const child: ChildProcess = spawn(
        runtime,
        [
          "--import",
          fileURLToPath(new URL("./lib/gateway-bench-load-preload.mjs", import.meta.url)),
          fixtureFile,
          scenario,
          String(port),
        ],
        {
          detached: true,
          stdio: ["ignore", "ignore", "inherit", "ipc"],
          env: {
            PATH: process.env.PATH,
            HOME: root,
            OPENCLAW_BENCH_PARENT_PID: String(process.pid),
            OPENCLAW_BENCH_CGROUP: resources.directory,
            OPENCLAW_BENCH_WORKERS: workers,
            BENCH_WS_MODULE: fileURLToPath(import.meta.resolve("ws")),
          },
        },
      );
      resources.start();
      try {
        if (scenario === "accounting") {
          const accounted = await message<{
            processCpu: NodeJS.CpuUsage;
            childCpu: NodeJS.CpuUsage;
          }>(child, "accounted");
          const sample = resources.read();
          const processUs = accounted.processCpu.user + accounted.processCpu.system;
          const childUs = accounted.childCpu.user + accounted.childCpu.system;
          assert.ok(
            childUs >= 150_000 && sample.cpuUs - processUs >= childUs * 0.8,
            "Exited child CPU missing from cgroup",
          );
          const events = readFileSync(workers, "utf8");
          assert.ok(
            events.includes('"worker-created"') && events.includes('"worker-exit"'),
            "Worker lifecycle missing",
          );
          receipts.push({ scenario, sample, accounted });
        } else {
          await message(child, "ready");
          if (scenario === "forced") {
            let forced = false;
            const receipt = await stopChild(child, {
              teardownGraceMs: 50,
              onForceKill: () => {
                forced = true;
              },
            });
            assert.equal(forced, true);
            assert.equal(receipt.signal, "SIGKILL");
            receipts.push({ scenario, receipt, forced });
          } else {
            const controller = new AbortController();
            if (scenario === "cancel") {
              child.on("message", (value: unknown) => {
                if (
                  value &&
                  typeof value === "object" &&
                  "type" in value &&
                  value.type === "active"
                ) {
                  controller.abort(new Error("synthetic cancellation"));
                }
              });
            }
            const result = await runControlUiLoad({
              port,
              protocolVersion: 3,
              token: "synthetic",
              journalDir: root,
              gatewayPid: child.pid!,
              resources,
              totalClients: 2,
              activeClients: 1,
              drivers: 1,
              durationMs: 1_500,
              timeoutMs: 500,
              signal: controller.signal,
            });
            const { requests: _requests, streamObservations: _streams, ...diagnostic } = result;
            assert.equal(
              result.valid,
              scenario === "normal",
              JSON.stringify({ scenario, diagnostic }),
            );
            if (scenario === "normal") {
              assert.ok(result.summary.replies > 0 && result.placement.length === 1);
              const firstEvent = JSON.parse(readFileSync(workers, "utf8").split("\n")[0]!);
              assert.ok(
                result.startEpochMs !== null &&
                  firstEvent.epochMs >= spawnedEpochMs &&
                  firstEvent.epochMs <= result.startEpochMs &&
                  result.startEpochMs <= performance.timeOrigin + performance.now(),
                "Gateway and driver epoch clocks differ",
              );
            } else {
              assert.ok(
                result.requests.length > 0 || result.errors.length > 0,
                "Failure evidence missing",
              );
            }
            receipts.push({
              scenario,
              summary: result.summary,
              errors: result.errors,
              valid: result.valid,
            });
            // Each cohort creates journals exclusively, including after failed setup.
            rmSync(path.join(root, "driver-0.jsonl"), { force: true });
          }
        }
      } finally {
        await stopChild(child);
        resources.finish();
        await resources.close();
      }
    }
    console.log(JSON.stringify({ runtime, receipts }, null, 2));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
