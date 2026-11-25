// Controlled transport diagnostics; real Gateway20/C64 remain the acceptance flows.
import { once } from "node:events";
import { writeFileSync } from "node:fs";
import { loadavg } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { isMainThread, MessageChannel, Worker, workerData } from "node:worker_threads";

if (!isMainThread) {
  const { default: pg } = await import("pg");
  const clients = await Promise.all(
    workerData.ports.map(async (port) => {
      const client = new pg.Client({
        connectionString: process.env.PGFOOTPRINT_DSN,
        connectionTimeoutMillis: 10_000,
        statement_timeout: 10_000,
      });
      await client.connect();
      client.on("error", () => port.postMessage({ fatal: true }));
      port.on("message", async ({ id, operation }) => {
        try {
          if (operation === "sample") {
            const { heapUsed, external } = process.memoryUsage();
            port.postMessage({ id, result: { heapUsed, external } });
            return;
          }
          if (operation === "close") {
            await client.end();
            port.postMessage({ id, result: null });
            port.close();
            return;
          }
          const sql =
            operation === "slow"
              ? "SELECT pg_sleep(0.2)"
              : operation === "large"
                ? "SELECT repeat('x', 8192) FROM generate_series(1, 1024)"
                : "SELECT 1";
          const result = await client.query(sql);
          // Include normal row cloning; a count-only reply would hide transport cost.
          port.postMessage({ id, result: result.rows });
        } catch {
          // No connection string, server detail, or row value leaves this diagnostic.
          port.postMessage({ id, failed: true });
        }
      });
      port.postMessage({ ready: true });
      return client;
    }),
  );
  process.once("beforeExit", () => {
    for (const client of clients) {
      void client.end();
    }
  });
} else {
  const { values } = parseArgs({
    options: {
      mode: { type: "string", default: "rss" },
      workers: { type: "string", default: "4" },
      clients: { type: "string", default: "20" },
      kind: { type: "string", default: "slow" },
      "background-clients": { type: "string", default: "1" },
      "idle-ms": { type: "string", default: "10000" },
      "duration-ms": { type: "string", default: "5000" },
      output: { type: "string" },
      "external-rss": { type: "boolean", default: false },
    },
  });
  const workers = Number(values.workers);
  const clients = Number(values.clients);
  const idleMs = Number(values["idle-ms"]);
  const durationMs = Number(values["duration-ms"]);
  const backgroundClients = Number(values["background-clients"]);
  if (
    !["rss", "interference"].includes(values.mode) ||
    !["slow", "large"].includes(values.kind) ||
    !Number.isInteger(workers) ||
    !Number.isInteger(clients) ||
    workers < 1 ||
    clients < Math.max(values.mode === "interference" ? 2 : 1, workers) ||
    clients > 64 ||
    !Number.isInteger(backgroundClients) ||
    backgroundClients < 1 ||
    (values.mode === "interference" && backgroundClients >= clients) ||
    !Number.isFinite(idleMs) ||
    idleMs < 0 ||
    !Number.isFinite(durationMs) ||
    durationMs < 1000 ||
    !values.output
  ) {
    throw new Error("Use rss|interference, 1..64 workers <= clients, and --output");
  }
  let databaseUrl;
  try {
    databaseUrl = new URL(process.env.PGFOOTPRINT_DSN ?? "");
  } catch {
    throw new Error("PGFOOTPRINT_DSN must name the owned local synthetic PostgreSQL server");
  }
  if (
    !["postgres:", "postgresql:"].includes(databaseUrl.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(databaseUrl.hostname)
  ) {
    throw new Error("PGFOOTPRINT_DSN must name the owned local synthetic PostgreSQL server");
  }
  if (process.env.NODE_OPTIONS) {
    throw new Error("Run observer-free: unset NODE_OPTIONS");
  }
  const services = [];
  const endpoints = [];
  const pending = new Set();
  const groups = Array.from({ length: workers }, () => []);
  let nextId = 0;
  let transportCalls = 0;
  let queryCalls = 0;
  /** @type {Error | undefined} */
  let failure;
  let closing = false;
  const cpuStart = process.cpuUsage();
  const mainCpuStart = process.threadCpuUsage();
  const started = performance.now();
  const fail = () => {
    failure ??= new Error("Synthetic topology service failed");
    for (const reject of pending) {
      reject(failure);
    }
    pending.clear();
  };
  try {
    const ready = [];
    for (let index = 0; index < clients; index++) {
      const { port1, port2 } = new MessageChannel();
      const requests = new Map();
      groups[index % workers].push(port2);
      let resolveReady;
      let rejectReady;
      ready.push(
        new Promise((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
          pending.add(reject);
        }),
      );
      port1.on("message", (message) => {
        if (message.ready) {
          pending.delete(rejectReady);
          resolveReady();
        } else if (message.fatal) {
          fail();
        } else {
          const request = requests.get(message.id);
          if (request) {
            requests.delete(message.id);
            pending.delete(request.reject);
            if (message.failed) {
              request.reject(new Error("Synthetic topology query failed"));
            } else {
              request.resolve(message.result);
            }
          }
        }
      });
      endpoints.push({
        port: port1,
        request(operation) {
          if (failure) {
            return Promise.reject(failure);
          }
          transportCalls++;
          if (["one", "slow", "large"].includes(operation)) {
            queryCalls++;
          }
          return new Promise((resolve, reject) => {
            const id = ++nextId;
            requests.set(id, { resolve, reject });
            pending.add(reject);
            port1.postMessage({ id, operation });
          });
        },
      });
    }
    for (const ports of groups) {
      const worker = new Worker(new URL(import.meta.url), {
        workerData: { ports },
        transferList: ports,
        execArgv: [],
      });
      worker.on("error", fail);
      worker.on("exit", () => {
        if (!closing) {
          fail();
        }
      });
      services.push(worker);
    }
    // This is a diagnostic deadline, not a replacement for production request deadlines.
    const watchdog = setTimeout(fail, 120_000);
    watchdog.unref();
    await Promise.all(ready);
    const readyMs = performance.now() - started;
    await Promise.all(endpoints.map((endpoint) => endpoint.request("one")));
    await delay(idleMs);
    // The controller samples RSS externally at this boundary, without a preload.
    process.stdout.write(JSON.stringify({ phase: "idle", pid: process.pid }) + "\n");
    const rss = [];
    for (let sample = 0; sample < 5; sample++) {
      rss.push(process.memoryUsage().rss);
      await delay(200);
    }
    if (values["external-rss"]) {
      // Hold workers until the external sampler finishes its idle observations.
      await once(process.stdin, "data", { signal: AbortSignal.timeout(120_000) });
      process.stdin.pause();
    }
    const heaps = await Promise.all(
      endpoints.slice(0, workers).map((endpoint) => endpoint.request("sample")),
    );
    const latencyMs = Array.from({ length: clients - backgroundClients }, () => []);
    let backgroundCalls = 0;
    if (values.mode === "interference") {
      const deadline = performance.now() + durationMs;
      await Promise.all([
        ...endpoints.slice(0, backgroundClients).map(async (endpoint) => {
          while (performance.now() < deadline) {
            await endpoint.request(values.kind);
            backgroundCalls++;
          }
        }),
        ...endpoints.slice(backgroundClients).map(async (endpoint, index) => {
          while (performance.now() < deadline) {
            const at = performance.now();
            await endpoint.request("one");
            latencyMs[index].push(performance.now() - at);
          }
        }),
      ]);
    }
    closing = true;
    await Promise.all(endpoints.map((endpoint) => endpoint.request("close")));
    clearTimeout(watchdog);
    const cpu = process.cpuUsage(cpuStart);
    const mainCpu = process.threadCpuUsage(mainCpuStart);
    writeFileSync(
      values.output,
      JSON.stringify({
        mode: values.mode,
        workers,
        clients,
        kind: values.kind,
        backgroundClients,
        foregroundClients: endpoints.slice(backgroundClients).map((_, index) => ({
          client: index + backgroundClients,
          worker: (index + backgroundClients) % workers,
        })),
        readyMs,
        idleRssBytes: rss,
        workerMemory: heaps,
        latencyMs,
        backgroundCalls,
        transportCalls,
        queryCalls,
        cpu,
        mainCpu,
        load: loadavg(),
        note: "Controlled diagnostic transport, not production Gateway acceptance",
      }),
    );
  } finally {
    await Promise.all(services.map((worker) => worker.terminate()));
    for (const endpoint of endpoints) {
      endpoint.port.close();
    }
  }
}
