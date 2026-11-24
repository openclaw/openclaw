// node --import ./scripts/tsx.mjs scripts/perf/hosted-doctor-measure.mts
// --repo <built-checkout> --fixture <stopped-teamBoot-fixture> --output <new-directory>
// --work-root <new-private-directory-on-the-fixture-filesystem>
// Run A/A controls and interleaved A/B samples with separate synthetic fixture copies.
import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import {
  writeRestartJsonText,
  writeRestartToolCall,
} from "../../test/gateway-restart.test-support.ts";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { createGatewayBenchEnv } from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { isRecord } from "../lib/record-shared.mjs";

const { values } = parseArgs({
  options: {
    repo: { type: "string" },
    fixture: { type: "string" },
    output: { type: "string" },
    "work-root": { type: "string" },
    "interrupt-doctor": { type: "boolean", default: false },
    "report-format": { type: "string", default: "hosted" },
    "timeout-ms": { type: "string", default: "180000" },
  },
});
const reportFormat = values["report-format"];
assert(reportFormat === "hosted" || reportFormat === "lint");
assert(values.repo && values.fixture && values.output);
const repo = fs.realpathSync(values.repo);
const fixture = fs.realpathSync(values.fixture);
const output = path.resolve(values.output);
const workRoot = values["work-root"] ? path.resolve(values["work-root"]) : output;
const manifest = JSON.parse(fs.readFileSync(path.join(fixture, "team-boot-fixture.json"), "utf8"));
assert(
  manifest.teamScale && manifest.sessionCount >= 10000,
  "Only synthetic teamBoot fixtures are accepted",
);
assert(fs.existsSync(path.join(repo, "dist/entry.js")), "Build the pinned checkout first");
fs.mkdirSync(output);
if (workRoot !== output) {
  fs.mkdirSync(workRoot);
}
const root = path.join(workRoot, "fixture");
const cloned = spawnSync(
  "cp",
  process.platform === "darwin" ? ["-cR", fixture, root] : ["-R", "--reflink=auto", fixture, root],
);
assert.equal(cloned.status, 0, cloned.stderr.toString());
function assertDiskHeadroom(requiredBytes = 8 * 1024 ** 3) {
  const space = fs.statfsSync(workRoot);
  const availableBytes = space.bavail * space.bsize;
  assert(availableBytes >= requiredBytes, "Synthetic proof stopped before exhausting its disk");
  return availableBytes;
}
const diskAvailableBefore = assertDiskHeadroom(
  Math.max(manifest.stateDatabaseBytes, ...manifest.agentDatabaseBytes) + 8 * 1024 ** 3,
);
const configPath = path.join(root, "openclaw.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8").replaceAll(fixture, root));
const providerRequests: Array<{ streaming: boolean; tools: string[]; toolOutput: boolean }> = [];
let issuedDoctor = false;
const server = createHttpServer((request, response) => {
  void (async () => {
    assert.equal(request.url, "/v1/responses");
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      tools?: Array<{ name?: string }>;
      input?: Array<{ type?: string; output?: unknown }>;
      stream?: boolean;
    };
    const tools = (body.tools ?? []).flatMap((tool) => (tool.name ? [tool.name] : []));
    const toolOutput = body.input?.findLast((item) => item.type === "function_call_output");
    providerRequests.push({
      streaming: body.stream !== false,
      tools,
      toolOutput: toolOutput !== undefined,
    });
    if (body.stream === false) {
      writeRestartJsonText(response, "Synthetic inference verified", randomUUID(), {
        object: true,
        completed: true,
      });
    } else if (tools.includes("openclaw") && !issuedDoctor) {
      issuedDoctor = true;
      writeRestartToolCall(
        response,
        randomUUID(),
        "openclaw",
        { action: "doctor" },
        providerRequests.length,
      );
    } else {
      const text = toolOutput
        ? typeof toolOutput.output === "string"
          ? toolOutput.output
          : JSON.stringify(toolOutput.output)
        : "Synthetic inference verified";
      writeOpenAiResponsesText(response, {
        text,
        messageId: "msg_" + randomUUID(),
        responseId: "resp_" + randomUUID(),
      });
    }
  })().catch((error: unknown) => {
    response.destroy(error instanceof Error ? error : new Error(String(error)));
  });
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const providerAddress = server.address();
assert(providerAddress && typeof providerAddress !== "string");
const provider = {
  baseUrl: "http://127.0.0.1:" + providerAddress.port + "/v1",
  async close() {
    server.closeAllConnections();
    await server[Symbol.asyncDispose]();
  },
};
const model = "openai/synthetic-doctor";
config.models = {
  mode: "replace",
  providers: {
    openai: {
      baseUrl: provider.baseUrl,
      api: "openai-responses",
      agentRuntime: { id: "openclaw" },
      apiKey: "synthetic-doctor-key",
      request: { allowPrivateNetwork: true },
      models: [
        {
          id: "synthetic-doctor",
          name: "Synthetic Doctor probe",
          api: "openai-responses",
          agentRuntime: { id: "openclaw" },
          reasoning: false,
          input: ["text"],
          contextWindow: 128000,
          maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    },
  },
};
config.agents.defaults = {
  ...config.agents.defaults,
  model,
  utilityModel: model,
  models: {
    [model]: {
      agentRuntime: { id: "openclaw" },
      params: { transport: "sse", openaiWsWarmup: false },
    },
  },
  skipBootstrap: true,
};
config.plugins.allow.push("openai");
config.plugins.entries.openai = { enabled: true };
config.cron = { enabled: false };
config.gateway.auth = { mode: "token", token: "synthetic-doctor-benchmark-token" };
fs.writeFileSync(configPath, JSON.stringify(config));
fs.copyFileSync(configPath, configPath + ".bak");
for (const name of ["tmp", "cache"]) {
  fs.mkdirSync(path.join(workRoot, name));
}
fs.mkdirSync(path.join(output, "profiles"));
const observations = path.join(output, "observations.jsonl");
const preload = path.join(output, "observe.mjs");
fs.writeFileSync(
  preload,
  [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    "import { Session } from 'node:inspector/promises';",
    "import { isMainThread, threadId } from 'node:worker_threads';",
    "const target = " + JSON.stringify(observations) + ";",
    "const append = fs.appendFileSync.bind(fs);",
    "const record = row => append(target, JSON.stringify({at:Date.now(),pid:process.pid,ppid:process.ppid,threadId,...row})+'\\n');",
    "record({kind:'process',argv:process.argv.slice(1)});",
    "const mkdtemp = fs.mkdtempSync;",
    "fs.mkdtempSync = function(...args) { const result=Reflect.apply(mkdtemp,this,args); if(result.includes('openclaw-sqlite-readonly-'))record({kind:'snapshot',path:result}); return result; };",
    "const mkdtempAsync=fs.promises.mkdtemp;",
    "fs.promises.mkdtemp=async function(...args){const result=await Reflect.apply(mkdtempAsync,this,args);if(result.includes('openclaw-sqlite-readonly-'))record({kind:'snapshot',path:result});return result;};",
    "const rename=fs.renameSync;",
    "fs.renameSync=function(from,to){const result=Reflect.apply(rename,this,[from,to]);if(String(to).includes('openclaw-sqlite-readonly-')&&/database\\.sqlite(?:-wal)?$/.test(String(to)))record({kind:'publication',path:to,bytes:fs.statSync(to).size});return result;};",
    "syncBuiltinESMExports();",
    "if(isMainThread&&process.argv.some(arg=>arg.endsWith('/doctor.worker.js'))){",
    "const inspector=new Session(); inspector.connect();",
    "await inspector.post('HeapProfiler.startSampling',{samplingInterval:32768,includeObjectsCollectedByMajorGC:true,includeObjectsCollectedByMinorGC:true});",
    "await inspector.post('Profiler.enable');await inspector.post('Profiler.start');",
    ...(values["interrupt-doctor"]
      ? [
          "setTimeout(()=>{record({kind:'doctor-interrupt',signal:'SIGTERM',cpu:process.cpuUsage()});process.kill(process.pid,'SIGTERM');},500).unref();",
        ]
      : []),
    "const samples=setInterval(()=>record({kind:'doctor-sample',cpu:process.cpuUsage(),memory:process.memoryUsage(),resource:process.resourceUsage()}),1000);samples.unref();",
    "let heapPending=false;",
    "const heapSamples=setInterval(async()=>{if(heapPending)return;heapPending=true;try{const heap=await inspector.post('HeapProfiler.getSamplingProfile');fs.writeFileSync(" +
      JSON.stringify(path.join(output, "profiles")) +
      "+'/'+process.pid+'.heapprofile',JSON.stringify(heap.profile));record({kind:'heap-profile-sample'});}catch(error){record({kind:'heap-profile-error',error:String(error)});}finally{heapPending=false;}},10000);heapSamples.unref();",
    "process.once('exit',()=>{clearInterval(samples);clearInterval(heapSamples);});",
    "process.once('beforeExit',async()=>{try{const heap=await inspector.post('HeapProfiler.stopSampling');const cpu=await inspector.post('Profiler.stop');",
    "fs.writeFileSync(" +
      JSON.stringify(path.join(output, "profiles")) +
      "+'/'+process.pid+'.heapprofile',JSON.stringify(heap.profile));",
    "fs.writeFileSync(" +
      JSON.stringify(path.join(output, "profiles")) +
      "+'/'+process.pid+'.cpuprofile',JSON.stringify(cpu.profile));",
    "record({kind:'doctor-drained',cpu:process.cpuUsage(),memory:process.memoryUsage(),resource:process.resourceUsage()});}finally{inspector.disconnect();}});",
    "process.once('exit',code=>record({kind:'doctor-exit',code,cpu:process.cpuUsage(),resource:process.resourceUsage()}));}",
  ].join("\n"),
);
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const address = listener.address();
assert(address && typeof address !== "string");
const port = address.port;
await listener[Symbol.asyncDispose]();
const env = {
  ...createGatewayBenchEnv(root, configPath, {}),
  XDG_CACHE_HOME: path.join(workRoot, "cache"),
  TMPDIR: path.join(workRoot, "tmp"),
  TMP: path.join(workRoot, "tmp"),
  TEMP: path.join(workRoot, "tmp"),
  OPENCLAW_PROFILE: "doctor-measure-" + port,
  OPENCLAW_SKIP_CRON: "1",
  NODE_OPTIONS: "--import=" + preload,
};
const log = fs.openSync(path.join(output, "gateway.log"), "w");
const gateway = spawn(
  process.execPath,
  [
    "dist/entry.js",
    "gateway",
    "run",
    "--port",
    String(port),
    "--bind",
    "loopback",
    "--allow-unconfigured",
  ],
  { cwd: repo, env, detached: process.platform !== "win32", stdio: ["ignore", log, log] },
);
const started = performance.now();
const hostLoad = loadavg();
let client: ReturnType<typeof createGatewayWsClient> | undefined;
const mutations: Array<{ phase: string; ms: number; ok: boolean; error?: unknown }> = [];
let phase = "control";
const activity = { finished: false };
let mutationWork: Promise<void> | undefined;
let backgroundFailure: unknown;
let result: unknown;
let failure: string | undefined;
const forcedDoctorCleanup: number[] = [];
const readObservations = (): Array<{
  kind: string;
  pid: number;
  threadId: number;
  argv?: string[];
}> =>
  fs.existsSync(observations)
    ? fs
        .readFileSync(observations, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
function readProcessFiles(pid: number) {
  const startedAt = performance.now();
  return new Promise<{ stdout: string; exitCode: number; ms: number }>((resolve, reject) => {
    execFile("lsof", ["-nP", "-p", String(pid)], { encoding: "utf8" }, (error, stdout) => {
      if (error && error.code !== 1) {
        reject(new Error(error.message, { cause: error }));
        return;
      }
      resolve({ stdout, exitCode: error ? 1 : 0, ms: performance.now() - startedAt });
    });
  });
}
function hasExpectedDoctorReport(reply: string, format: "hosted" | "lint") {
  if (format === "hosted") {
    return /^Doctor \(live Gateway\): ran/m.test(reply);
  }
  const reportLine = reply.split("\n").find((line) => line.startsWith('{"schemaVersion":'));
  const report: unknown = JSON.parse(reportLine ?? "null");
  return (
    isRecord(report) &&
    report.schemaVersion === 1 &&
    typeof report.checksRun === "number" &&
    Array.isArray(report.findings)
  );
}
try {
  let ready = false;
  while (performance.now() - started < 300000) {
    assertDiskHeadroom();
    assert(gateway.exitCode === null, "Gateway exited before readiness");
    try {
      if (
        (await fetch("http://127.0.0.1:" + port + "/readyz", { signal: AbortSignal.timeout(1000) }))
          .ok
      ) {
        ready = true;
        break;
      }
    } catch {}
    await delay(100);
  }
  assert(ready, "Gateway readiness timed out");
  client = createGatewayWsClient({ url: "ws://127.0.0.1:" + port });
  await client.waitOpen();
  const connected = await client.request("connect", {
    minProtocol: PROTOCOL_VERSION,
    maxProtocol: PROTOCOL_VERSION,
    client: { id: "gateway-client", version: "1.0.0", platform: process.platform, mode: "backend" },
    role: "operator",
    scopes: ["operator.read", "operator.admin"],
    auth: { token: "synthetic-doctor-benchmark-token" },
    caps: [],
  });
  assert(connected.ok, JSON.stringify(connected.error));
  const listed = await client.request("sessions.list", { limit: 1 }, 60000);
  assert(listed.ok, JSON.stringify(listed.error));
  const payload = listed.payload as { sessions: Array<{ key: string }> };
  const sessionKey = payload.sessions[0]?.key;
  assert(sessionKey, "Fixture must expose a session");
  async function mutate() {
    assertDiskHeadroom();
    const begin = performance.now();
    const response = await client!.request(
      "sessions.patch",
      { key: sessionKey, label: "Synthetic Doctor mutation " + mutations.length },
      180000,
    );
    mutations.push({
      phase,
      ms: performance.now() - begin,
      ok: response.ok,
      error: response.error,
    });
    assert(response.ok, "Session mutation was rejected: " + JSON.stringify(response.error));
  }
  for (let index = 0; index < 5; index++) {
    await mutate();
  }
  phase = "doctor";
  const operationStarted = performance.now();
  let operationMs = 0;
  const at = Date.now();
  mutationWork = (async () => {
    while (!activity.finished) {
      await mutate();
      await delay(100);
    }
  })().catch((error: unknown) => {
    backgroundFailure = error;
    activity.finished = true;
    client?.close();
  });
  const fdWork = (async () => {
    while (!activity.finished) {
      for (const pid of new Set(
        readObservations()
          .filter(
            (row) =>
              row.kind === "process" && row.argv?.some((arg) => arg.endsWith("/doctor.worker.js")),
          )
          .map((row) => row.pid),
      )) {
        const fds = await readProcessFiles(pid);
        fs.appendFileSync(
          path.join(output, "doctor-fds.log"),
          JSON.stringify({ at: Date.now(), pid, observerMs: fds.ms }) + "\n" + fds.stdout,
        );
      }
      await delay(1000);
    }
  })().catch((error: unknown) => {
    backgroundFailure = error;
    activity.finished = true;
    client?.close();
  });
  try {
    const response = await client.request(
      "openclaw.chat",
      { sessionId: "synthetic-doctor-" + port, message: "doctor" },
      Number(values["timeout-ms"]),
    );
    operationMs = performance.now() - operationStarted;
    result = response;
    assert(response.ok, JSON.stringify(response.error));
    const reply = (response.payload as { reply: string }).reply;
    assert(
      values["interrupt-doctor"]
        ? reply.includes("Doctor diagnosis did not complete (signal)")
        : hasExpectedDoctorReport(reply, reportFormat),
      "The Gateway did not return a Doctor report: " + JSON.stringify(response.payload),
    );
    assert(
      readObservations().some(
        (row) =>
          row.kind === "process" && row.argv?.some((arg) => arg.endsWith("/doctor.worker.js")),
      ),
      "The Gateway request did not reach the hosted Doctor worker: " + JSON.stringify(result),
    );
  } finally {
    operationMs ||= performance.now() - operationStarted;
    activity.finished = true;
    await Promise.allSettled([mutationWork, fdWork]);
    fs.writeFileSync(
      path.join(output, "doctor-result.json"),
      JSON.stringify({ at, ms: operationMs, result }, null, 2),
    );
  }
  if (backgroundFailure) {
    throw new Error("Benchmark background work failed", { cause: backgroundFailure });
  }
  const workerExit = await Promise.all(
    readObservations()
      .filter(
        (row) =>
          row.kind === "process" && row.argv?.some((arg) => arg.endsWith("/doctor.worker.js")),
      )
      .map(async ({ pid }) => {
        const fds = await readProcessFiles(pid);
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
            throw error;
          }
          alive = false;
        }
        return { pid, alive, openFilesAfterReply: fds.stdout, lsofExit: fds.exitCode };
      }),
  );
  fs.writeFileSync(path.join(output, "worker-exit.json"), JSON.stringify(workerExit, null, 2));
  assert(
    workerExit.every((row) => !row.alive && row.openFilesAfterReply === "" && row.lsofExit === 1),
    "Doctor retained file descriptors after replying",
  );
  phase = "after";
  for (let index = 0; index < 5; index++) {
    await mutate();
  }
} catch (error) {
  failure = String(error);
} finally {
  activity.finished = true;
  await mutationWork?.catch(() => {});
  client?.close();
  if (failure) {
    for (const pid of new Set(
      readObservations()
        .filter(
          (row) =>
            row.kind === "process" && row.argv?.some((arg) => arg.endsWith("/doctor.worker.js")),
        )
        .map((row) => row.pid),
    )) {
      try {
        process.kill(-pid, "SIGTERM");
        forcedDoctorCleanup.push(pid);
        await delay(500);
        process.kill(-pid, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          failure += "; worker cleanup failed: " + String(error);
        }
      }
    }
  }
  const shutdown = await stopChild(gateway, { teardownGraceMs: 15000 });
  const processExtinction = [
    ...new Set(
      readObservations()
        .filter((row) => row.kind === "process" && row.threadId === 0)
        .map((row) => row.pid),
    ),
  ].map((pid) => {
    let alive = true;
    let observationError: string | undefined;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        alive = false;
      } else {
        observationError = String(error);
      }
    }
    return { pid, alive, observationError };
  });
  if (processExtinction.some((row) => row.alive || row.observationError)) {
    failure ??=
      "An observed child survived Gateway shutdown; retain the work root for reconciliation";
  }
  fs.closeSync(log);
  await provider.close();
  fs.writeFileSync(
    path.join(output, "result.json"),
    JSON.stringify(
      {
        repo,
        workRoot,
        fixture: manifest,
        hostLoad,
        diskAvailableBefore,
        interruptDoctor: values["interrupt-doctor"],
        hostLoadAfter: loadavg(),
        elapsedMs: performance.now() - started,
        mutations,
        result,
        failure,
        forcedDoctorCleanup,
        shutdown,
        processExtinction,
        provider: { requests: providerRequests },
        observations: readObservations(),
      },
      null,
      2,
    ),
  );
}
if (failure) {
  throw new Error(failure);
}
