// Run only against an already running isolated Gateway with synthetic state and authentication.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium, type WebSocket } from "playwright";
import { asOptionalRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import type { ControlUiReadiness } from "../../ui/src/app/control-ui-readiness.ts";
import { resolvePlaywrightChromiumExecutablePath } from "../../ui/src/test-helpers/playwright-chromium.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string" },
    duration: { type: "string", default: "60" },
    output: { type: "string" },
  },
});
if (!values.url || !values.output) {
  throw new Error(
    "Usage: catalog-polling-measure.ts --url <isolated-url> --duration <seconds> --output <report.json>",
  );
}
const url = new URL(values.url);
const durationMs = Number(values.duration) * 1_000;
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
  methods: Record<Method, Counts>;
};
const methods: Method[] = ["models.list", "cron.list"];
const phases: Phase[] = [];
const sockets = new Set<WebSocket>();
const connected = new Set<WebSocket>();
const startedAt = performance.now();
let accountedAt = startedAt;
let phase: Phase;
let measuring = true;
let reconnect: "observed" | "offline-did-not-close-socket" | "not-attempted" = "not-attempted";
let failure: string | undefined;
let unreadableFrames = 0;

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
  if (phase) {
    phase.socketMs += (now - accountedAt) * connected.size;
    phase.elapsedMs = now - startedAt - phase.startedAtMs;
  }
  accountedAt = now;
}

function beginPhase(name: string) {
  accountSockets();
  phase = {
    name,
    startedAtMs: performance.now() - startedAt,
    elapsedMs: 0,
    socketMs: 0,
    helloCount: 0,
    snapshots: 0,
    snapshotBytes: 0,
    methods: {
      "models.list": { calls: 0, responses: 0, errors: 0, responseBytes: 0 },
      "cron.list": { calls: 0, responses: 0, errors: 0, responseBytes: 0 },
    },
  };
  phases.push(phase);
}

beginPhase("cold-start");
const browser = await chromium.launch({
  executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  headless: true,
});
try {
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
    beginPhase(name);
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

  beginPhase("reconnect");
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

  beginPhase("cron-navigation");
  await page.evaluate(() => window.openclawControlUi!.navigate("cron"));
  await ready("cron");
  await idle("cron-visible-idle");
  beginPhase("retained-navigation");
  await page.evaluate(
    (route) => window.openclawControlUi!.navigate(route === "cron" ? "chat" : route),
    initialRoute,
  );
  await ready(initialRoute === "cron" ? "chat" : initialRoute);
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
  for (const entry of phases) {
    for (const method of methods) {
      entry.methods[method].callsPerMinutePerSocket = entry.socketMs
        ? (entry.methods[method].calls * 60_000) / entry.socketMs
        : null;
    }
  }
  const report = {
    durationSecondsPerIdlePhase: durationMs / 1_000,
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
