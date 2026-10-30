// node --import ./scripts/tsx.mjs scripts/perf/pg-footprint.ts --mode seed|run --root <new-internal-root>
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir, loadavg } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import type { TranscriptEvent } from "../../src/config/sessions/session-accessor.sqlite-contract.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { getFreePort, requestProbeStatus } from "../lib/gateway-bench-probes.ts";
import {
  BASE_GATEWAY_BENCH_CONFIG,
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  gatewayBenchCpuProfileArgs,
} from "../lib/gateway-bench-runtime.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";

const { values } = parseArgs({
  options: {
    mode: { type: "string" },
    root: { type: "string" },
    output: { type: "string" },
    engine: { type: "string", default: "postgres" },
    entry: { type: "string", default: "dist/entry.js" },
    profile: { type: "boolean", default: false },
    "observer-free": { type: "boolean", default: false },
    "pool-topology": { type: "string", default: "fixed-four" },
  },
});
if (
  !["seed", "run"].includes(values.mode ?? "") ||
  !["sqlite", "postgres"].includes(values.engine) ||
  !["legacy", "fixed-four"].includes(values["pool-topology"])
) {
  throw new Error(
    "Use --mode seed|run, --engine postgres|sqlite and --pool-topology fixed-four|legacy",
  );
}
function internalPath(raw: string | undefined, existing: boolean): string {
  if (!raw || !path.isAbsolute(raw)) {
    throw new Error("An absolute, task-owned internal path is required");
  }
  const allowed = realpathSync(
    path.join(homedir(), ".cache", "dbasync-campaign", "tmp", "pgfootprint"),
  );
  const actual = existing
    ? realpathSync(raw)
    : path.join(realpathSync(path.dirname(raw)), path.basename(raw));
  if (!actual.startsWith(`${allowed}${path.sep}`)) {
    throw new Error("Fixture/output must remain inside the pgfootprint internal scratch directory");
  }
  return actual;
}
const root = internalPath(values.root, values.mode === "run");
const configPath = path.join(root, "openclaw.json");
const marker = path.join(root, "pg-footprint-fixture.json");
const format = "openclaw-pg-footprint-v1";
const agents = Array.from({ length: 20 }, (_, i) => (i === 0 ? "main" : `synthetic-${i}`));
const env = createGatewayBenchEnv(path.join(root, "home"), configPath, {
  caseEnv: {
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_PROFILE: "synthetic-pg-footprint",
    OPENCLAW_LAUNCHD_LABEL: "dev.openclaw.synthetic-pg-footprint",
    OPENCLAW_SYSTEMD_UNIT: "openclaw-synthetic-pg-footprint",
    OPENCLAW_SKIP_CHANNELS: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    LC_ALL: "en_US.UTF-8",
    TMPDIR: path.join(root, "tmp"),
    ...(process.env.PGFOOTPRINT_DSN ? { PGFOOTPRINT_DSN: process.env.PGFOOTPRINT_DSN } : {}),
  },
});
const origin = "https://pg-footprint.example";
if (values.mode === "seed") {
  mkdirSync(root, { mode: 0o700 });
  for (const dir of ["home", "state", "tmp"]) {
    mkdirSync(path.join(root, dir));
  }
  const entries: NonNullable<OpenClawConfig["agents"]>["entries"] = {};
  for (const agent of agents) {
    const workspace = path.join(root, `workspace-${agent}`);
    mkdirSync(workspace);
    entries[agent] = { workspace };
  }
  const config = {
    ...BASE_GATEWAY_BENCH_CONFIG,
    agents: { ownership: "explicit", defaults: { skipBootstrap: true }, entries },
    plugins: { enabled: true, entries: { browser: { enabled: false } } },
    tools: { codeMode: false },
    memory: { search: { enabled: false } },
    ...(values.engine === "postgres"
      ? {
          database: {
            engine: "postgres",
            postgres: {
              connection: { source: "env", provider: "default", id: "PGFOOTPRINT_DSN" },
              schemaPrefix: "pgfootprint",
            },
          },
        }
      : {}),
    gateway: {
      ...BASE_GATEWAY_BENCH_CONFIG.gateway,
      trustedProxies: ["127.0.0.1"],
      controlUi: { enabled: false, allowedOrigins: [origin] },
      auth: {
        mode: "trusted-proxy",
        trustedProxy: {
          allowLoopback: true,
          userHeader: "x-forwarded-user",
          requiredHeaders: ["x-forwarded-proto"],
          allowUsers: ["synthetic-pg-footprint"],
        },
        identityScopes: { "synthetic-pg-footprint": ["operator.read"] },
      },
      roles: {
        default: "reader",
        definitions: {
          reader: { agents: "*", sessions: { others: "view" }, scopes: ["operator.read"] },
        },
      },
    },
    logging: { file: path.join(root, "gateway-file.log") },
  } satisfies OpenClawConfig;
  writeFileSync(configPath, JSON.stringify(config));
  process.env = env;
  const [
    { setRuntimeConfigSnapshot },
    selection,
    context,
    admission,
    agentDb,
    stateDb,
    entryStore,
    transcriptStore,
  ] = await Promise.all([
    import("../../src/config/runtime-snapshot.ts"),
    import("../../src/infra/database-engine/config.ts"),
    import("../../src/infra/database-engine/context.ts"),
    import("../../src/infra/database-engine/admission-scope.ts"),
    import("../../src/state/openclaw-agent-db.ts"),
    import("../../src/state/openclaw-state-db.ts"),
    import("../../src/config/sessions/session-accessor.sqlite-entry-store.ts"),
    import("../../src/config/sessions/session-accessor.sqlite-transcript-store.ts"),
  ]);
  admission.installDatabaseProcessRole("cli-oneshot");
  setRuntimeConfigSnapshot(config);
  context.installDatabaseEngineSelection(
    await selection.resolveDatabaseEngineSelection(config, env),
  );
  const now = Date.parse("2026-10-24T12:00:00Z");
  try {
    for (const agentId of agents) {
      admission.withEngineStoreAdmission(() =>
        agentDb.runOpenClawAgentWriteTransaction(
          (db) => {
            for (let i = 0; i < 40; i++) {
              const sessionId = `synthetic-${i}`;
              const sessionKey = `agent:${agentId}:${sessionId}`;
              entryStore.writeSessionEntry(db, sessionKey, { sessionId, updatedAt: now });
              const events: TranscriptEvent[] = [
                {
                  type: "session",
                  version: 3,
                  id: sessionId,
                  timestamp: new Date(now).toISOString(),
                },
              ];
              for (let j = 0; j < (i < 4 ? 200 : 2); j++) {
                events.push({
                  type: "message",
                  id: `${sessionId}-${j}`,
                  parentId: j ? `${sessionId}-${j - 1}` : null,
                  timestamp: new Date(now + j).toISOString(),
                  message: {
                    role: "user",
                    timestamp: now + j,
                    content: [{ type: "text", text: "Synthetic footprint fixture." }],
                  },
                });
              }
              if (
                transcriptStore.appendTranscriptEventsInTransaction(
                  db,
                  { agentId, sessionId, sessionKey },
                  events,
                ) !== events.length
              ) {
                throw new Error("Incomplete synthetic transcript seed");
              }
            }
          },
          { agentId, env },
        ),
      );
    }
  } finally {
    await agentDb.closeOpenClawAgentDatabasesAsync();
    await stateDb.closeOpenClawStateDatabaseAsync();
  }
  writeFileSync(
    marker,
    JSON.stringify({
      format,
      engine: values.engine,
      agents: agents.length,
      sessions: 800,
      events: 18240,
    }),
  );
} else {
  const fixture = JSON.parse(readFileSync(marker, "utf8"));
  if (fixture.format !== format || fixture.engine !== values.engine) {
    throw new Error("Expected a matching synthetic footprint fixture");
  }
  const output = internalPath(values.output, false);
  mkdirSync(output, { mode: 0o700 });
  const sampleRequest = path.join(output, "sample-request");
  writeFileSync(sampleRequest, Buffer.alloc(256, " "));
  const observer = process.env.SQLMEASURE_OBSERVER;
  if (!values["observer-free"] && (!observer || !path.isAbsolute(observer))) {
    throw new Error("SQLMEASURE_OBSERVER must name the frozen observer.cjs");
  }
  const channel = `pg-footprint-${randomUUID()}`;
  const samples: Array<{
    sample: string;
    at: number;
    processes?: Array<{ pid: number; rssKiB: number; threads: number }>;
  }> = [];
  const phase = (name: string) => writeFileSync(path.join(output, "phase"), name);
  phase("boot");
  const port = await getFreePort();
  const log = openSync(path.join(output, "gateway.log"), "wx");
  const extraArgs = gatewayBenchCpuProfileArgs(
    values.profile ? path.join(output, "profiles") : undefined,
  );
  const started = performance.now();
  const child = spawn(
    process.execPath,
    buildGatewayBenchChildArgs(path.resolve(values.entry), port, extraArgs, "trusted-proxy"),
    {
      env: {
        ...env,
        PGFOOTPRINT_OUTPUT: output,
        PGFOOTPRINT_CHANNEL: channel,
        SQLMEASURE_OUT: output,
        NODE_OPTIONS: values["observer-free"]
          ? ""
          : `--require=${JSON.stringify(observer)} --import=${JSON.stringify(path.resolve("scripts/perf/pg-footprint-preload.mjs"))}`,
      },
      detached: true,
      stdio: ["ignore", log, log],
    },
  );
  closeSync(log);
  const abort = new AbortController();
  const interrupt = () => abort.abort(new Error("Footprint measurement interrupted"));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const wait = (ms: number) => delay(ms, undefined, { signal: abort.signal });
  const workerEvents = () =>
    readdirSync(output)
      .filter((name) => /^workers-\d+-\d+\.jsonl$/.test(name))
      .flatMap((name) =>
        readFileSync(path.join(output, name), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map(
            (line) =>
              JSON.parse(line) as {
                type: string;
                pid: number;
                threadId: number;
                workerId?: number;
                sample?: string;
                phase?: string;
                script?: string;
                poolService?: boolean;
                owner?: string;
              },
          ),
      );
  let poolTopology: {
    mode: string;
    checked: boolean;
    roots?: Array<{ pid: number; kind: string; physicalServices: number }>;
    selfRoots?: Array<{ pid: number; threadId: number; owner?: string }>;
  } = { mode: values["pool-topology"], checked: false };
  const assertPoolTopology = () => {
    if (
      values.engine !== "postgres" ||
      values["observer-free"] ||
      values["pool-topology"] === "legacy"
    ) {
      return;
    }
    const events = workerEvents();
    const roots = new Map<number, { pid: number; kind: string; physicalServices: number }>();
    for (const event of events) {
      if (event.type !== "start" || event.threadId !== 0) {
        continue;
      }
      const script = event.script?.replaceAll("\\", "/") ?? "";
      // These are the fixture's native process owners, not an observed count ceiling.
      const kind =
        event.pid === child.pid
          ? "gateway"
          : /\/state\/openclaw-agent-schema-inspection\.worker\.[cm]?[jt]s$/.test(script)
            ? "schema-inspection"
            : /\/process\/spawn-broker\/worker\.[cm]?[jt]s$/.test(script)
              ? "native-resource-broker"
              : undefined;
      if (!kind) {
        throw new Error(`Undeclared PostgreSQL fixture process: ${event.pid} ${script}`);
      }
      roots.set(event.pid, { pid: event.pid, kind, physicalServices: 0 });
    }
    const selfRoots = events
      .filter((event) => event.type === "pool-self-root")
      .map(({ pid, threadId, owner }) => ({ pid, threadId, owner }));
    poolTopology = {
      mode: values["pool-topology"],
      checked: false,
      roots: [...roots.values()],
      selfRoots,
    };
    if (selfRoots.length) {
      throw new Error(`Undeclared PostgreSQL thread self-root: ${JSON.stringify(selfRoots)}`);
    }
    for (const event of events) {
      if (
        event.type !== "spawn" ||
        !/\/postgres-sync\/bridge\.worker\.[cm]?[jt]s$/.test(
          event.script?.replaceAll("\\", "/") ?? "",
        )
      ) {
        continue;
      }
      const processRoot = roots.get(event.pid);
      if (!processRoot || event.threadId !== 0 || !event.poolService) {
        throw new Error(`PostgreSQL service has an undeclared owner: ${JSON.stringify(event)}`);
      }
      processRoot.physicalServices++;
    }
    for (const processRoot of roots.values()) {
      // A prestarted schema/broker child may never open PG; any PG-using process owns four.
      if (
        (processRoot.kind === "gateway" || processRoot.physicalServices !== 0) &&
        processRoot.physicalServices !== 4
      ) {
        throw new Error(
          `Expected four PostgreSQL services for ${processRoot.kind} ${processRoot.pid}; got ${processRoot.physicalServices}`,
        );
      }
    }
    if (!roots.has(child.pid!)) {
      throw new Error("PostgreSQL topology census missed the Gateway process");
    }
    poolTopology.checked = true;
  };
  const sample = async (label: string) => {
    // RSS is measured in the unprofiled run; profiling uses thread exit artifacts.
    if (values.profile) {
      return;
    }
    if (values["observer-free"]) {
      const rows = execFileSync("ps", ["-axo", "pid=,ppid=,rss="], { encoding: "utf8" })
        .trim()
        .split("\n")
        .map((line) => line.trim().split(/\s+/).map(Number));
      const owned = new Set([child.pid!]);
      for (;;) {
        const before = owned.size;
        for (const [pid, parent] of rows) {
          if (owned.has(parent!)) {
            owned.add(pid!);
          }
        }
        if (before === owned.size) {
          break;
        }
      }
      samples.push({
        sample: label,
        at: Date.now(),
        processes: rows
          .filter(([pid]) => owned.has(pid!))
          .map(([pid, , rssKiB]) => ({
            pid: pid!,
            rssKiB: rssKiB!,
            threads: execFileSync("ps", ["-M", "-p", String(pid), "-o", "pid="], {
              encoding: "utf8",
            })
              .trim()
              .split("\n").length,
          })),
      });
      await wait(200);
      return;
    }
    const before = workerEvents();
    const identity = (pid: number, id: number) => `${pid}:${id}`;
    const parents = new Map(
      before
        .filter((event) => event.type === "spawn")
        .map((event) => [
          identity(event.pid, event.workerId!),
          identity(event.pid, event.threadId),
        ]),
    );
    const retirementCheck = (events: ReturnType<typeof workerEvents>) => {
      const exited = new Set(
        events
          .filter((event) => event.type === "exit")
          .map((event) => identity(event.pid, event.workerId!)),
      );
      return (id: string) => {
        const pid = Number(id.split(":", 1)[0]);
        try {
          process.kill(pid, 0);
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "ESRCH") {
            return true;
          }
          throw error;
        }
        for (
          let current: string | undefined = id;
          current !== undefined;
          current = parents.get(current)
        ) {
          if (exited.has(current)) {
            return true;
          }
        }
        return false;
      };
    };
    const wasRetired = retirementCheck(before);
    const expected = new Set(
      before
        .filter(
          (event) => event.type === "start" && !wasRetired(identity(event.pid, event.threadId)),
        )
        .map((event) => identity(event.pid, event.threadId)),
    );
    expected.add(identity(child.pid!, 0));
    const request = openSync(sampleRequest, "r+");
    try {
      const bytes = Buffer.alloc(256, " ");
      bytes.write(label);
      writeSync(request, bytes, 0, bytes.length, 0);
    } finally {
      closeSync(request);
    }
    const deadline = performance.now() + 10_000;
    for (;;) {
      const events = workerEvents();
      const settled = new Set(
        events
          .filter((event) => event.type === "sample" && event.sample === label)
          .map((event) => identity(event.pid, event.threadId)),
      );
      const isRetired = retirementCheck(events);
      for (const id of expected) {
        if (isRetired(id)) {
          settled.add(id);
        }
      }
      if ([...expected].every((id) => settled.has(id))) {
        break;
      }
      if (performance.now() > deadline) {
        throw new Error(
          `Missing worker samples: ${[...expected].filter((id) => !settled.has(id)).join(",")}`,
        );
      }
      await wait(100);
    }
    samples.push({ sample: label, at: Date.now() });
  };
  const latencies: Array<{ phase: string; agent: number; ms: number; messages: number }> = [];
  let client: ReturnType<typeof createGatewayWsClient> | undefined;
  let readyMs: number | undefined;
  let teardown: Awaited<ReturnType<typeof stopChild>> | undefined;
  let completed = false;
  try {
    while ((await requestProbeStatus(port, "/readyz")).status !== 200) {
      if (
        child.exitCode !== null ||
        child.signalCode !== null ||
        performance.now() - started > 180_000
      ) {
        throw new Error("Gateway readiness failed");
      }
      await wait(250);
    }
    readyMs = performance.now() - started;
    phase("settle");
    await wait(30_000);
    await sample("after-startup");
    client = createGatewayWsClient({
      url: `ws://127.0.0.1:${port}`,
      origin,
      headers: {
        "x-forwarded-for": "192.0.2.1",
        "x-forwarded-proto": "https",
        "x-forwarded-user": "synthetic-pg-footprint",
      },
    });
    await client.waitOpen();
    const connect = await client.request("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "openclaw-control-ui",
        version: "1.0.0",
        platform: process.platform,
        mode: "ui",
      },
      role: "operator",
      scopes: ["operator.read"],
      caps: [],
    });
    if (!connect.ok) {
      throw new Error(`Connect refused: ${JSON.stringify(connect.error)}`);
    }
    const hello = connect.payload as { auth?: { scopes?: string[] } };
    if (!hello.auth?.scopes?.includes("operator.read")) {
      throw new Error("Synthetic reader was not granted operator.read");
    }
    const history = async (label: string) => {
      phase(label);
      for (const [index, agentId] of agents.entries()) {
        const at = performance.now();
        const reply = await client!.request(
          "chat.history",
          { sessionKey: `agent:${agentId}:synthetic-0`, limit: 10 },
          60_000,
        );
        if (!reply.ok) {
          throw new Error(
            `History refused for synthetic agent ${index}: ${JSON.stringify(reply.error)}`,
          );
        }
        const payload = reply.payload as { messages?: unknown[] };
        if (!payload.messages?.length) {
          throw new Error(`History empty for synthetic agent ${index}`);
        }
        latencies.push({
          phase: label,
          agent: index,
          ms: performance.now() - at,
          messages: payload.messages.length,
        });
      }
    };
    await history("first-request");
    await history("warm-request");
    if (values.engine === "postgres" && !values["observer-free"]) {
      const events = workerEvents();
      if (
        !events.some((event) => event.type === "pg-connect") ||
        !events.some(
          (event) =>
            event.type === "pg-query" &&
            ["first-request", "warm-request"].includes(event.phase ?? ""),
        )
      ) {
        throw new Error(
          "PostgreSQL driver instrumentation did not observe connection and history queries",
        );
      }
    }
    phase("idle");
    await wait(190_000);
    for (let i = 0; i < 5; i++) {
      await sample(`idle-${i}`);
    }
    await history("post-idle-first-request");
    await sample("after-reopen");
    completed = true;
  } finally {
    phase("shutdown");
    client?.ws.close();
    teardown = await stopChild(child, { teardownGraceMs: 30_000 });
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    try {
      if (completed) {
        assertPoolTopology();
      }
    } finally {
      writeFileSync(
        path.join(output, "result.json"),
        JSON.stringify(
          { fixture, readyMs, latencies, samples, poolTopology, teardown, load: loadavg() },
          null,
          2,
        ),
      );
      writeFileSync(
        path.join(output, "evidence.json"),
        JSON.stringify({ children: [{ name: "gateway", pid: child.pid }], turns: [] }),
      );
    }
  }
  if (teardown.exitCode !== 0 || teardown.signal !== null) {
    throw new Error("Gateway shutdown was not clean");
  }
}
