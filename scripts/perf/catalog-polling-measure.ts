// Run only against an already running isolated Gateway with synthetic state and authentication.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { chromium, type WebSocket as PlaywrightWebSocket } from "playwright";
import { PROTOCOL_VERSION } from "../../packages/gateway-protocol/src/version.ts";
import { asOptionalRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { buildControlUiSessionPath } from "../../packages/session-url-contract/src/index.ts";
import { parseAgentSessionKey } from "../../packages/session-url-contract/src/session-key-normalization.ts";
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
    "load-runs": { type: "string" },
    "load-path": { type: "string", default: "/dashboard" },
    "phase-seed": { type: "string", default: "1458" },
    "request-stacks": { type: "boolean", default: false },
    "expect-session": { type: "string" },
    "open-details": { type: "boolean", default: false },
    "activity-session": { type: "string" },
    "activity-patch-sessions": { type: "string" },
    "activity-cron": { type: "boolean", default: false },
    "activity-models": { type: "string", default: "openai/gpt-5.6-sol,openai/gpt-5.6-luna" },
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

if (values["load-runs"]) {
  await measureLoads(integer(values["load-runs"], "--load-runs"));
  process.exit(0);
}

async function measureLoads(runs: number) {
  const activityModels = values["activity-models"].split(",").filter(Boolean);
  const patchSessions = values["activity-patch-sessions"]?.split(",").filter(Boolean) ?? [];
  const activitySession = values["activity-session"] ?? patchSessions[0];
  if (patchSessions.length && (values["activity-session"] || values["activity-cron"])) {
    throw new Error(
      "--activity-patch-sessions uses existing sessions and excludes turn/cron activity",
    );
  }
  if (activitySession && (runs !== 1 || activityModels.length === 0)) {
    throw new Error("Active session measurement requires --load-runs 1 and at least one model");
  }
  const cronSession = parseAgentSessionKey(values["activity-session"]);
  if (values["activity-cron"] && cronSession?.rest !== "main") {
    throw new Error("--activity-cron requires --activity-session agent:<agent-id>:main");
  }
  const destination = new URL(values["load-path"], url);
  if (destination.origin !== url.origin) {
    throw new Error("--load-path must remain on the isolated Gateway origin");
  }
  destination.hash = url.hash;
  const browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    headless: true,
    args: ["--no-sandbox"],
  });
  const results: unknown[] = [];
  const cleanupErrors: string[] = [];
  let activityClient: ReturnType<typeof createGatewayWsClient> | undefined;
  let activityCronJobId: string | undefined;
  const activityRpc = async (method: string, params: unknown) => {
    const response = await activityClient!.request(method, params, 60_000);
    if (!response.ok) {
      throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    }
    return asOptionalRecord(response.payload);
  };
  let random = integer(values["phase-seed"], "--phase-seed");
  try {
    if (activitySession) {
      const endpoint = new URL(url);
      endpoint.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      endpoint.hash = "";
      activityClient = createGatewayWsClient({ url: endpoint.href });
      await activityClient.waitOpen();
      const token = new URLSearchParams(url.hash.slice(1)).get("token");
      await activityRpc("connect", {
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
      if (!patchSessions.length) {
        await activityRpc("sessions.create", {
          key: activitySession,
          visibility: "shared",
          model: activityModels[0],
        });
      }
    }
    if (activityClient && values["activity-cron"]) {
      const job = await activityRpc("cron.add", {
        name: "Synthetic activity cron",
        enabled: false,
        schedule: { kind: "every", everyMs: 3_600_000 },
        sessionTarget: "main",
        agentId: cronSession!.agentId,
        sessionKey: values["activity-session"],
        wakeMode: "next-heartbeat",
        payload: { kind: "systemEvent", text: "Synthetic activity measurement" },
      });
      if (typeof job?.id !== "string") {
        throw new Error("cron.add did not return a job ID");
      }
      activityCronJobId = job.id;
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const installProbe = (captureStacks: boolean) => {
      const requests: Array<{
        method: string;
        params: unknown;
        requestedAtMs: number;
        stack: string | undefined;
        responseAtMs?: number;
        responseBytes?: number;
        ok?: boolean;
        catalog?: unknown;
      }> = [];
      const tasks: Array<{ startTime: number; duration: number }> = [];
      const snapshots: Array<{ atMs: number; bytes: number; catalog: unknown }> = [];
      const events: Array<{ atMs: number; event: string; payload: unknown }> = [];
      // Preserve the native receiver explicitly when forwarding from the diagnostic wrapper.
      // oxlint-disable-next-line typescript/unbound-method
      const send = WebSocket.prototype.send;
      const NativeWebSocket = WebSocket;
      const pending = new Map<string, (typeof requests)[number]>();
      const catalogStatus = (
        payload:
          | {
              scope?: unknown;
              pendingProviders?: unknown;
              refreshFailed?: unknown;
              sessionModelRevision?: unknown;
              models?: unknown;
            }
          | undefined,
      ) => ({
        scope: payload?.scope,
        pendingProviders: payload?.pendingProviders,
        refreshFailed: payload?.refreshFailed,
        sessionModelRevision: payload?.sessionModelRevision,
        models: payload?.models,
      });
      Reflect.set(Error, "stackTraceLimit", 30);
      new PerformanceObserver((list) => {
        tasks.push(
          ...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })),
        );
      }).observe({ type: "longtask", buffered: true });
      class ObservedWebSocket extends NativeWebSocket {
        constructor(socketUrl: string | URL, protocols?: string | string[]) {
          super(socketUrl, protocols);
          this.addEventListener(
            "message",
            ({ data: message }) => {
              if (typeof message !== "string") {
                return;
              }
              const frame = JSON.parse(message);
              if (frame.type === "event" && frame.event === "models.snapshot") {
                snapshots.push({
                  atMs: performance.now(),
                  bytes: new TextEncoder().encode(message).length,
                  catalog: {
                    ...catalogStatus(frame.payload?.catalog),
                    scope: frame.payload?.scope,
                  },
                });
              }
              if (
                frame.type === "event" &&
                [
                  "chat.metadata.changed",
                  "config.changed",
                  "sessions.changed",
                  "cron",
                  "chat",
                  "agent",
                ].includes(frame.event)
              ) {
                events.push({
                  atMs: performance.now(),
                  event: frame.event,
                  payload: {
                    changed: frame.payload?.changed,
                    revision: frame.payload?.revision,
                    sessionKey: frame.payload?.sessionKey,
                    reason: frame.payload?.reason,
                    phase: frame.payload?.phase,
                    dataPhase: frame.payload?.data?.phase,
                    agentId: frame.payload?.agentId,
                    modelCatalogChanged: frame.payload?.modelCatalogChanged,
                    commandsChanged: frame.payload?.commandsChanged,
                    authChanged: frame.payload?.authChanged,
                    catalogChanged: frame.payload?.catalogChanged,
                    sessionModelRevision:
                      frame.payload?.session?.sessionModelRevision ??
                      frame.payload?.session?.full?.sessionModelRevision ??
                      frame.payload?.session?.set?.sessionModelRevision,
                    action: frame.payload?.action,
                    state: frame.payload?.state,
                    stream: frame.payload?.stream,
                    runId: frame.payload?.runId,
                  },
                });
              }
              const request = frame.type === "res" ? pending.get(frame.id) : undefined;
              if (request) {
                pending.delete(frame.id);
                request.responseAtMs = performance.now();
                request.responseBytes = new TextEncoder().encode(message).length;
                request.ok = frame.ok === true;
                if (request.method === "models.list") {
                  request.catalog = catalogStatus(frame.payload);
                }
              }
            },
            { capture: true },
          );
        }
      }
      window.WebSocket = ObservedWebSocket;
      NativeWebSocket.prototype.send = function (data) {
        if (typeof data === "string") {
          const frame = JSON.parse(data);
          if (
            frame.type === "req" &&
            ["cron.list", "models.list", "users.self"].includes(frame.method)
          ) {
            const request = {
              method: frame.method,
              params: frame.params,
              requestedAtMs: performance.now(),
              stack: captureStacks ? new Error().stack : undefined,
              precedingEvent: events.at(-1),
            };
            requests.push(request);
            pending.set(frame.id, request);
          }
        }
        return send.call(this, data);
      };
      Reflect.set(window, "__catalogLoad", { requests, tasks, snapshots, events });
    };
    await context.addInitScript({
      content: `;(() => { const __name = (target) => target; (${installProbe.toString()})(${values["request-stacks"]}); })();`,
    });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const scheduleStartAt = startAt ?? Date.now();
    if (startAt !== undefined) {
      if (Date.now() > scheduleStartAt) {
        throw new Error("--start-at elapsed before browser readiness");
      }
    }
    for (let run = 0; run < runs; run += 1) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const phaseDelayMs = random % 3000;
      const scheduledAt = scheduleStartAt + run * (durationMs + 5_000) + phaseDelayMs;
      if (run > 0 && Date.now() > scheduledAt) {
        throw new Error("Prior load exceeded the paired reload schedule");
      }
      await delay(Math.max(0, scheduledAt - Date.now()));
      const actualWallStartAtMs = Date.now();
      await page.goto(destination.href, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        ({ sessionKey, pathname }) => {
          const snapshot = window.openclawControlUi?.snapshot();
          return (
            snapshot?.ready &&
            snapshot.gatewayPhase === "connected" &&
            (!sessionKey || snapshot.sessionKey === sessionKey) &&
            snapshot.route?.resolvedLocation?.pathname === pathname
          );
        },
        { sessionKey: values["expect-session"], pathname: destination.pathname },
        { timeout: 60_000 },
      );
      if (values["open-details"]) {
        const details = page
          .getByRole("complementary", { name: "Details", exact: true })
          .or(page.getByRole("dialog", { name: "Details", exact: true }));
        if (!(await details.isVisible())) {
          await page
            .getByRole("button", { name: "Details", exact: true })
            .or(page.getByRole("button").and(page.locator(".chat-header-session-menu__trigger")))
            .filter({ visible: true })
            .first()
            .click();
          const menu = page.getByRole("menuitem", { name: "Session details", exact: true });
          await details.or(menu).filter({ visible: true }).first().waitFor();
          if (await menu.isVisible()) {
            await menu.click();
          }
        }
        await details.waitFor();
      }
      const readyAtMs = await page.evaluate(() => performance.now());
      const activity: Array<{ method: string; atMs: number; elapsedMs: number; result?: unknown }> =
        [];
      let activityStartedAtMs: number | undefined;
      let activityEndedAtMs: number | undefined;
      if (activityClient) {
        await page.waitForTimeout(5_000);
        if (startAt !== undefined) {
          const activityStartAt = scheduledAt + 30_000;
          if (Date.now() > activityStartAt) {
            throw new Error("Browser readiness missed the paired activity schedule");
          }
          await page.waitForTimeout(activityStartAt - Date.now());
        }
        activityStartedAtMs = await page.evaluate(() => performance.now());
        const startedAt = Date.now();
        for (let step = 0; step < Math.floor(durationMs / intervalMs); step += 1) {
          await page.waitForTimeout(Math.max(0, startedAt + step * intervalMs - Date.now()));
          const atMs = await page.evaluate(() => performance.now());
          const started = Date.now();
          if (patchSessions.length) {
            const key = patchSessions[step % patchSessions.length]!;
            const pathname = buildControlUiSessionPath({
              namespace: "chat",
              sessionKey: key,
              exactKey: true,
            });
            if (!pathname) {
              throw new Error(`Invalid synthetic session key: ${key}`);
            }
            await page.evaluate(
              (nextPath) => window.openclawControlUi!.navigate("chat", { pathname: nextPath }),
              pathname,
            );
            await page.waitForFunction(
              (nextKey) => window.openclawControlUi?.snapshot().sessionKey === nextKey,
              key,
            );
            await activityRpc("sessions.patch", { key, label: `Synthetic activity ${step}` });
            activity.push({ method: "sessions.patch", atMs, elapsedMs: Date.now() - started });
            continue;
          }
          const key = values["activity-session"]!;
          const kind = step % (activityCronJobId ? 5 : 4);
          const method = kind === 4 ? "cron.run" : kind === 3 ? "chat.send" : "sessions.patch";
          const params =
            kind < 2
              ? {
                  key,
                  model:
                    activityModels[
                      Math.floor(step / (activityCronJobId ? 5 : 4)) % activityModels.length
                    ],
                  ...(kind === 1 ? { label: `Synthetic active session ${step}` } : {}),
                }
              : kind === 2
                ? {
                    key,
                    pinned: Math.floor(step / 4) % 2 === 0,
                    statusNote: `Synthetic activity ${step}`,
                    thinkingLevel: "off",
                  }
                : kind === 4
                  ? { id: activityCronJobId, mode: "force", waitTimeoutMs: 30_000 }
                  : {
                      sessionKey: key,
                      message: "Reply with a short synthetic measurement response.",
                      deliver: false,
                      idempotencyKey: randomUUID(),
                    };
          const result = await activityRpc(method, params);
          let completionStatus: string | undefined;
          if (method === "chat.send") {
            if (typeof result?.runId !== "string") {
              throw new Error("chat.send did not return a run ID");
            }
            const terminal = await activityRpc("agent.wait", {
              runId: result.runId,
              timeoutMs: 30_000,
            });
            if (terminal?.status !== "ok") {
              throw new Error(`Synthetic turn did not complete: ${JSON.stringify(terminal)}`);
            }
            completionStatus = terminal.status;
          } else if (method === "cron.run") {
            if (typeof result?.runId !== "string" || (!result.finished && !result.run)) {
              throw new Error("Cron run did not finish within the bounded wait");
            }
            await page.waitForFunction(
              (runId) =>
                Reflect.get(window, "__catalogLoad").events.some(
                  (event: { event: string; payload: { action?: string; runId?: string } }) =>
                    event.event === "cron" &&
                    event.payload.action === "finished" &&
                    event.payload.runId === runId,
                ),
              result.runId,
              { timeout: 30_000 },
            );
            completionStatus = "finished";
          }
          activity.push({
            method,
            atMs,
            elapsedMs: Date.now() - started,
            result: completionStatus
              ? { runId: result?.runId, status: completionStatus }
              : undefined,
          });
        }
        await page.waitForTimeout(Math.max(0, startedAt + durationMs - Date.now()));
        activityEndedAtMs = await page.evaluate(() => performance.now());
      } else {
        await page.waitForTimeout(Math.max(0, durationMs - readyAtMs));
      }
      const result = await page.evaluate(() => {
        const probe = Reflect.get(window, "__catalogLoad");
        return {
          ...probe,
          paints: performance
            .getEntriesByType("paint")
            .map(({ name, startTime }) => ({ name, startTime })),
          blockingMs: probe.tasks.reduce(
            (sum: number, task: { duration: number }) => sum + Math.max(0, task.duration - 50),
            0,
          ),
          route: window.openclawControlUi?.snapshot().route,
          sessionKey: window.openclawControlUi?.snapshot().sessionKey,
          atMs: performance.now(),
        };
      });
      results.push({
        run,
        phaseDelayMs,
        scheduledAt,
        actualWallStartAtMs,
        readyAtMs,
        errors: errors.splice(0),
        activity,
        activityStartedAtMs,
        activityEndedAtMs,
        activityBlockingMs: result.tasks
          .filter(
            (task: { startTime: number }) =>
              activityStartedAtMs !== undefined && task.startTime >= activityStartedAtMs,
          )
          .reduce(
            (sum: number, task: { duration: number }) => sum + Math.max(0, task.duration - 50),
            0,
          ),
        ...result,
      });
      if (values.screenshot && run === runs - 1) {
        await page.screenshot({ path: values.screenshot, fullPage: true });
      }
    }
  } finally {
    if (activityClient && activityCronJobId) {
      try {
        await activityRpc("cron.remove", { id: activityCronJobId });
      } catch (error) {
        cleanupErrors.push(`cron.remove: ${String(error)}`);
      }
    }
    activityClient?.close();
    try {
      await browser.close();
    } catch (error) {
      cleanupErrors.push(`browser.close: ${String(error)}`);
    }
    const report = {
      measurement:
        "Real isolated Gateway browser loads. Native long-task blocking is sum(max(duration - 50 ms, 0)); request stack capture adds diagnostic overhead. First context is cold, subsequent documents retain browser cache and storage. Matching seeds randomize reload phase equally across paired sides. Synthetic request parameters and stacks are retained; auth and response payloads are not.",
      durationMs,
      requestStacks: values["request-stacks"],
      path: values["load-path"],
      cleanupErrors,
      results,
    };
    await mkdir(path.dirname(path.resolve(values.output!)), { recursive: true });
    await writeFile(values.output!, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report, null, 2));
  }
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
const sockets = new Set<PlaywrightWebSocket>();
const connected = new Set<PlaywrightWebSocket>();
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
