import { randomUUID } from "node:crypto";
import { readTicket, readTimeline } from "./activities.mjs";

const DEFAULT_HEARTBEAT_MS = 5_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;

const heartbeatMs = parsePositiveInt(
  process.env.DISPATCH_TEMPORAL_HEARTBEAT_MS,
  DEFAULT_HEARTBEAT_MS,
);
const shutdownMs = parsePositiveInt(
  process.env.DISPATCH_TEMPORAL_SHUTDOWN_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
);
const dispatchApiUrl = normalizeBaseUrl(process.env.DISPATCH_API_URL || "http://dispatch-api:8080");
const temporalAddress = process.env.TEMPORAL_ADDRESS || "temporal:7233";
const temporalNamespace = process.env.TEMPORAL_NAMESPACE || "default";
const temporalTaskQueue = process.env.TEMPORAL_TASK_QUEUE || "dispatch-ticket-workflows";
const workerIdentity =
  process.env.DISPATCH_TEMPORAL_WORKER_IDENTITY || `dispatch-control-plane-${randomUUID()}`;
const startMode = (process.env.DISPATCH_TEMPORAL_MODE || "bootstrap").toLowerCase();

let shutdownRequested = false;
let heartbeatTimer = null;

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function normalizeBaseUrl(rawUrl) {
  const trimmed = typeof rawUrl === "string" ? rawUrl.trim() : "";
  if (trimmed === "") {
    return "http://dispatch-api:8080";
  }
  return trimmed.replace(/\/+$/u, "");
}

function writeLog(level, event, payload = {}) {
  const line = {
    level,
    service: "control-plane-temporal",
    worker_identity: workerIdentity,
    event,
    ts: new Date().toISOString(),
    ...payload,
  };
  if (level === "error") {
    console.error(JSON.stringify(line));
    return;
  }
  if (level === "warn") {
    console.warn(JSON.stringify(line));
    return;
  }
  console.log(JSON.stringify(line));
}

function stopHeartbeat() {
  if (heartbeatTimer != null) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

async function startSkeletonMode() {
  writeLog("info", "worker.skeleton.start", {
    dispatchApiUrl,
    temporalAddress,
    temporalNamespace,
    temporalTaskQueue,
    mode: "skeleton",
  });

  heartbeatTimer = setInterval(() => {
    if (!shutdownRequested) {
      writeLog("info", "worker.skeleton.heartbeat", {
        temporal_address: temporalAddress,
        dispatch_api_url: dispatchApiUrl,
      });
    }
  }, heartbeatMs);

  process.once("SIGINT", initiateShutdown);
  process.once("SIGTERM", initiateShutdown);
}

async function startWithTemporal() {
  let temporal;
  try {
    temporal = await import("@temporalio/worker");
  } catch {
    throw new Error(
      "Temporal dependency unavailable in runtime. Install @temporalio/worker for full worker mode.",
    );
  }

  const { NativeConnection, Worker } = temporal;
  writeLog("info", "worker.temporal.starting", {
    temporalAddress,
    namespace: temporalNamespace,
    taskQueue: temporalTaskQueue,
    mode: "temporal",
  });

  const connection = await NativeConnection.connect({
    address: temporalAddress,
  });

  const worker = await Worker.create({
    connection,
    namespace: temporalNamespace,
    taskQueue: temporalTaskQueue,
    workflowsPath: new URL("./workflows.mjs", import.meta.url).pathname,
    activities: {
      readTicket,
      readTimeline,
    },
  });

  writeLog("info", "worker.temporal.started", {
    temporalAddress,
    namespace: temporalNamespace,
    taskQueue: temporalTaskQueue,
  });

  process.once("SIGINT", async () => {
    await shutdownWorker(worker);
  });
  process.once("SIGTERM", async () => {
    await shutdownWorker(worker);
  });

  await worker.run();
  await connection.close();
}

async function shutdownWorker(worker) {
  if (shutdownRequested) {
    return;
  }
  shutdownRequested = true;
  writeLog("warn", "worker.shutdown.requested", { worker: workerIdentity });
  stopHeartbeat();
  try {
    await Promise.race([
      worker.shutdown(),
      new Promise((resolve) => setTimeout(resolve, shutdownMs)),
    ]);
  } catch (error) {
    writeLog("error", "worker.shutdown.failed", {
      message: error instanceof Error ? error.message : String(error),
      worker: workerIdentity,
    });
    process.exitCode = 1;
  }
}

function initiateShutdown() {
  if (shutdownRequested) {
    return;
  }
  shutdownRequested = true;
  writeLog("warn", "worker.shutdown.initiated", {
    worker: workerIdentity,
  });
  stopHeartbeat();
}

async function boot() {
  try {
    if (startMode === "temporal") {
      await startWithTemporal();
      return;
    }
    await startSkeletonMode();
  } catch (error) {
    writeLog("error", "worker.bootstrap_failed", {
      message: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
    stopHeartbeat();
  }
}

await boot();
