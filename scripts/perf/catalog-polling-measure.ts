// Run only against an already running isolated Gateway with synthetic state and authentication.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium, type WebSocket } from "playwright";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { asOptionalRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { ControlUiReadiness } from "../../ui/src/app/control-ui-readiness.ts";
import { resolvePlaywrightChromiumExecutablePath } from "../../ui/src/test-helpers/playwright-chromium.ts";
import { createGatewayWsClient } from "../lib/gateway-ws-client.ts";
import { parseStrictIntegerOption } from "../lib/strict-integer-option.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    duration: { type: "string", default: "60" },
    output: { type: "string" },
    "cron-runs": { type: "string", default: "0" },
    "cron-jobs": { type: "string", default: "20" },
    "interval-ms": { type: "string", default: "2000" },
    "start-at": { type: "string" },
    screenshot: { type: "string" },
  },
});
if (!values.url || !values.output) {
  throw new Error(
    "Usage: catalog-polling-measure.ts --url <isolated-url> --duration <seconds> --output <report.json>",
  );
}
const url = new URL(values.url);
const durationMs = Number(values.duration) * 1_000;
const integer = (raw: string, label: string, min = 1) =>
  parseStrictIntegerOption({ raw, label, min, fallback: min });
const cronRuns = integer(values["cron-runs"], "--cron-runs", 0);
const cronJobs = integer(values["cron-jobs"], "--cron-jobs");
const intervalMs = integer(values["interval-ms"], "--interval-ms");
const startAt = values["start-at"] ? integer(values["start-at"], "--start-at") : undefined;
if (
  !["http:", "https:"].includes(url.protocol) ||
  !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
  Number(url.port) < 40_000 ||
  url.username ||
  url.password ||
  !Number.isFinite(durationMs) ||
  durationMs < 1_000
) {
  throw new Error(
    "Expected a loopback Gateway port >= 40000 and duration >= 1 second; use synthetic state/auth only.",
  );
}

type Method = "models.list" | "cron.list";
type Counts = {
  calls: number;
  responses: number;
  errors: number;
  responseBytes: number;
  callsPerMinutePerSocket?: number | null;
};
type Phase = {
  name: string;
  startedAtMs: number;
  elapsedMs: number;
  socketMs: number;
  helloCount: number;
  snapshots: number;
  snapshotBytes: number;
  cronEvents: Record<string, number>;
  methods: Record<Method, Counts>;
};
const methods: Method[] = ["models.list", "cron.list"];
const phases: Phase[] = [];
const sockets = new Set<WebSocket>();
const connected = new Set<WebSocket>();
const startedAt = performance.now();
let accountedAt = startedAt;
let measuring = true;
let reconnect: "observed" | "offline-did-not-close-socket" | "not-attempted" = "not-attempted";
let failure: string | undefined;
let unreadableFrames = 0;
let completedRuns = 0;
let controller: ReturnType<typeof createGatewayWsClient> | undefined;
const jobIds: string[] = [];

async function rpc(method: string, params: unknown) {
  const response = await controller!.request(method, params, 60_000);
  if (!response.ok) {
    throw new Error(`${method} failed`);
  }
  return asOptionalRecord(response.payload);
}

function parseFrame(payload: string | Buffer) {
  try {
    return asOptionalRecord(JSON.parse(String(payload)));
  } catch {
    unreadableFrames += 1;
    return undefined;
  }
}

function accountSockets() {
  if (!measuring) {
    return;
  }
  const now = performance.now();
  const current = phases.at(-1);
  if (current) {
    current.socketMs += (now - accountedAt) * connected.size;
    current.elapsedMs = now - startedAt - current.startedAtMs;
  }
  accountedAt = now;
}

function beginPhase(name: string) {
  accountSockets();
  const next: Phase = {
    name,
    startedAtMs: performance.now() - startedAt,
    elapsedMs: 0,
    socketMs: 0,
    helloCount: 0,
    snapshots: 0,
    snapshotBytes: 0,
    cronEvents: {},
    methods: {
      "models.list": { calls: 0, responses: 0, errors: 0, responseBytes: 0 },
      "cron.list": { calls: 0, responses: 0, errors: 0, responseBytes: 0 },
    },
  };
  phases.push(next);
  return next;
}

let phase = beginPhase("cold-start");
const browser = await chromium.launch({
  executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  headless: true,
});
try {
  if (cronRuns > 0) {
    const endpoint = new URL(url);
    endpoint.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    endpoint.hash = "";
    controller = createGatewayWsClient({ url: endpoint.href });
    await controller.waitOpen();
    const token = new URLSearchParams(url.hash.slice(1)).get("token");
    await rpc("connect", {
      minProtocol: PROTOCOL_VERSION,
      maxProtocol: PROTOCOL_VERSION,
      client: {
        id: "gateway-client",
        version: "1.0.0",
        platform: process.platform,
        mode: "backend",
      },
      role: "operator",
      scopes: ["operator.admin", "operator.read", "operator.write"],
      caps: [],
      ...(token ? { auth: { token } } : {}),
    });
    for (let index = 0; index < cronJobs; index += 1) {
      const job = await rpc("cron.add", {
        name: `Synthetic cron ${String(index).padStart(3, "0")}`,
        enabled: false,
        schedule: { kind: "every", everyMs: 3_600_000 },
        sessionTarget: "main",
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "Synthetic activity measurement" },
      });
      if (typeof job?.id !== "string") {
        throw new Error("cron.add did not return a job ID");
      }
      jobIds.push(job.id);
    }
  }
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on("websocket", (socket) => {
    const endpoint = new URL(socket.url());
    if (endpoint.host !== url.host) {
      return;
    }
    sockets.add(socket);
    const pending = new Map<string, { method: Method | "connect"; phase: Phase }>();
    socket.on("framesent", ({ payload }) => {
      if (!measuring) {
        return;
      }
      const frame = parseFrame(payload);
      if (frame?.type !== "req" || typeof frame.id !== "string") {
        return;
      }
      const method = methods.find((candidate) => candidate === frame.method);
      if (method || frame.method === "connect") {
        pending.set(frame.id, { method: method ?? "connect", phase });
        if (method) {
          phase.methods[method].calls += 1;
        }
      }
    });
    socket.on("framereceived", ({ payload }) => {
      if (!measuring) {
        return;
      }
      const frame = parseFrame(payload);
      if (frame?.type === "event" && frame.event === "models.snapshot") {
        phase.snapshots += 1;
        phase.snapshotBytes += Buffer.byteLength(payload);
      }
      if (frame?.type === "event" && frame.event === "cron") {
        const action = asOptionalRecord(frame.payload)?.action;
        if (typeof action === "string") {
          phase.cronEvents[action] = (phase.cronEvents[action] ?? 0) + 1;
        }
      }
      const id = frame?.type === "res" && typeof frame.id === "string" ? frame.id : undefined;
      const request = id ? pending.get(id) : undefined;
      if (!request || !id) {
        return;
      }
      pending.delete(id);
      if (request.method === "connect") {
        if (frame?.ok === true) {
          accountSockets();
          connected.add(socket);
          phase.helloCount += 1;
        }
        return;
      }
      const counts = request.phase.methods[request.method];
      counts.responses += 1;
      counts.errors += frame?.ok === true ? 0 : 1;
      counts.responseBytes += Buffer.byteLength(payload);
    });
    socket.on("close", () => {
      accountSockets();
      connected.delete(socket);
      sockets.delete(socket);
      pending.clear();
    });
  });
  const ready = async (route?: Parameters<ControlUiReadiness["hook"]["navigate"]>[0]) => {
    await page.waitForFunction(
      (expectedRoute) => {
        const snapshot: ReturnType<ControlUiReadiness["hook"]["snapshot"]> | undefined =
          window.openclawControlUi?.snapshot();
        return (
          snapshot?.ready &&
          snapshot.gatewayPhase === "connected" &&
          (!expectedRoute ||
            snapshot.route?.matches.some(({ routeId }) => routeId === expectedRoute))
        );
      },
      route,
      { timeout: 60_000 },
    );
    // Keep delayed bootstrap and initial view reads out of the warm window.
    await delay(5_000);
  };
  const idle = async (name: string) => {
    phase = beginPhase(name);
    if (await page.evaluate(() => document.visibilityState !== "visible")) {
      throw new Error("Measurement page is not visible");
    }
    await delay(durationMs);
    if (
      connected.size !== 1 ||
      (await page.evaluate(() => document.visibilityState !== "visible"))
    ) {
      throw new Error("Idle measurement requires one authenticated Gateway socket");
    }
  };
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await ready();
  const initialRoute = await page.evaluate(
    () => window.openclawControlUi!.snapshot().route?.matches.at(-1)?.routeId ?? "new-session",
  );
  await idle("warm-visible-idle");

  phase = beginPhase("reconnect");
  const before = phase.helloCount;
  await context.setOffline(true);
  try {
    const deadline = performance.now() + 5_000;
    while (sockets.size > 0 && performance.now() < deadline) {
      await delay(100);
    }
    reconnect = sockets.size === 0 ? "observed" : "offline-did-not-close-socket";
  } finally {
    await context.setOffline(false);
  }
  if (reconnect === "observed") {
    await ready();
    if (phase.helloCount <= before) {
      throw new Error("Offline transition did not produce a new authenticated connection");
    }
  }

  phase = beginPhase("cron-navigation");
  await page.evaluate(() => window.openclawControlUi!.navigate("cron"));
  await ready("cron");
  await idle("cron-visible-idle");
  if (cronRuns > 0) {
    await page.getByText("Synthetic cron 000", { exact: true }).first().waitFor();
    if (startAt !== undefined) {
      if (Date.now() > startAt) {
        throw new Error("--start-at elapsed before browser readiness");
      }
      await delay(startAt - Date.now());
    }
    phase = beginPhase("cron-runtime-events");
    const runtimeStartedAt = performance.now();
    for (let index = 0; index < cronRuns; index += 1) {
      await delay(Math.max(0, runtimeStartedAt + index * intervalMs - performance.now()));
      const result = await rpc("cron.run", {
        id: jobIds[index % jobIds.length],
        mode: "force",
        waitTimeoutMs: 30_000,
      });
      if (!result?.finished && !result?.run) {
        throw new Error("Cron run did not finish within the bounded wait");
      }
      completedRuns += 1;
    }
    await delay(Math.max(0, runtimeStartedAt + cronRuns * intervalMs - performance.now()) + 2_000);
    if (phase.cronEvents.finished !== cronRuns || connected.size !== 1) {
      throw new Error("Browser did not receive every completed cron run on its single socket");
    }
    await page.waitForFunction(
      (count) => document.querySelectorAll(".cron-table__last-run").length === count,
      Math.min(cronRuns, cronJobs),
    );
    if (values.screenshot) {
      await page.screenshot({ path: values.screenshot, fullPage: true });
    }
    phase = beginPhase("cron-configuration-edit");
    await rpc("cron.update", { id: jobIds[0], patch: { name: "Synthetic cron edited" } });
    await page.getByText("Synthetic cron edited", { exact: true }).first().waitFor();
    await delay(2_000);
  }
  phase = beginPhase("retained-navigation");
  const returnRoute = cronRuns > 0 ? "appearance" : initialRoute === "cron" ? "chat" : initialRoute;
  await page.evaluate((route) => window.openclawControlUi!.navigate(route), returnRoute);
  await ready(returnRoute);
  await page.evaluate(() => window.openclawControlUi!.navigate("cron"));
  await ready("cron");
} catch (error) {
  // Browser exception messages may repeat the initial URL's synthetic auth fragment.
  failure = `${phase.name}: ${error instanceof Error ? error.name : "MeasurementError"}`;
  process.exitCode = 1;
} finally {
  accountSockets();
  measuring = false;
  await browser.close();
  if (controller) {
    for (const id of jobIds) {
      await rpc("cron.remove", { id }).catch(() => {
        failure ??= "cleanup: cron.remove failed";
        process.exitCode = 1;
      });
    }
    controller.close();
  }
  for (const entry of phases) {
    for (const method of methods) {
      entry.methods[method].callsPerMinutePerSocket = entry.socketMs
        ? (entry.methods[method].calls * 60_000) / entry.socketMs
        : null;
    }
  }
  const report = {
    durationSecondsPerIdlePhase: durationMs / 1_000,
    cronWorkload:
      cronRuns > 0 ? { jobs: cronJobs, runs: cronRuns, completedRuns, intervalMs } : null,
    reconnect,
    failure,
    unreadableFrames,
    measurement:
      "Real browser WebSocket JSON bytes; requests and their responses belong to the request-start phase. Events belong to receipt phase. Rates use authenticated socket-minutes; no payloads or authentication retained.",
    phases,
  };
  await mkdir(path.dirname(path.resolve(values.output)), { recursive: true });
  await writeFile(values.output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report, null, 2));
}
