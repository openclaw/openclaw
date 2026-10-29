// Real built Gateway + synthetic Team-shaped state behind a TCP fault proxy; never accepts a live URL.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { resolveSandboxHostPort } from "../../src/agents/sandbox-host.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import { findGatewayPidsOnPortSync } from "../../src/infra/restart-stale-pids.js";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { startFlakyNetworkProxy } from "./flaky-network-proxy.ts";
import { freeProofPort, startWarmReloadAdmission } from "./warm-reload-admission.ts";
import { seedWarmReloadFixture } from "./warm-reload-fixture.ts";

const allScenarios = ["blackout", "offline-reload", "queue-reload"] as const;
const { values } = parseArgs({
  options: {
    output: { type: "string", default: ".local/flaky-network-proof" },
    dist: { type: "string", default: "dist" },
    "ui-root": { type: "string" },
    scenarios: { type: "string", default: allScenarios.join(",") },
    sessions: { type: "string", default: "2000" },
    "blackout-seconds": { type: "string", default: "45" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.info(`Usage: node --import ./scripts/tsx.mjs scripts/perf/flaky-network-proof.ts
  --dist dist [--ui-root dist/control-ui] --output .local/flaky-network-proof
  --scenarios ${allScenarios.join(",")} --sessions 2000 --blackout-seconds 45
Starts an isolated Gateway behind an airplane-profile fault proxy, runs the scenarios,
writes events.json, timeline.txt, and summary.json, then stops everything it started.
See scripts/perf/flaky-network-proof.md for scenarios and thresholds.`);
  process.exit(0);
}
const scenarioNames = values.scenarios.split(",").map((name) => {
  const scenario = allScenarios.find((candidate) => candidate === name.trim());
  if (!scenario) {
    throw new Error(`Unknown scenario ${name}; expected ${allScenarios.join(", ")}`);
  }
  return scenario;
});
const sessions = Number(values.sessions);
const blackoutSeconds = Number(values["blackout-seconds"]);
if (!Number.isInteger(blackoutSeconds) || blackoutSeconds < 10 || blackoutSeconds > 300) {
  throw new Error("--blackout-seconds must be an integer in [10, 300]");
}
const blackoutMs = blackoutSeconds * 1000;
const dist = path.resolve(values.dist);
const uiRoot = values["ui-root"] ? path.resolve(values["ui-root"]) : undefined;
await Promise.all([
  access(path.join(dist, "entry.js")),
  access(path.join(uiRoot ?? path.join(dist, "control-ui"), "index.html")),
]);
const directory = createControlUiE2eArtifactDir("flaky-network", values.output);

// GEO-satellite cabin Wi-Fi as measured for #186325; thresholds below assume this profile.
const airplane = {
  rttMs: 700,
  jitterMs: 150,
  downBps: 190_000,
  upBps: 50_000,
  blackhole: false,
  refuse: false,
};
// Base and fixed values from #186325 and #186316; limits sit between them with jitter headroom.
const thresholds = {
  sendToReconnectingMs: 22_000, // base ~27 s, fixed 15.3 s
  restoreToConnectedMs: 10_000, // base 31.5–33.8 s, fixed 3.5–3.9 s
  offlineTranscriptMs: 3_000, // cached rows render from the warm snapshot
  offlineStatusMs: 10_000, // visible connection status while every connection is refused
};

type UiSample = {
  phase: string | null;
  /** Shell status pill kind and label. */
  pill: string | null;
  label: string | null;
  /** Chat pane header status, which also covers saved conversations during warm boot. */
  paneStatus: string | null;
  rows: number;
  queued: number;
  placeholder: string | null;
};
type BrowserEntry = { at: number; doc: number; kind: string; socket?: number; code?: number } & {
  state?: UiSample;
};
type ProofEvent = Omit<BrowserEntry, "at" | "doc"> & {
  t: number;
  scenario: string;
  doc?: number;
  detail?: Record<string, unknown>;
};
type Check = {
  name: string;
  value: number | boolean | null;
  limit: string;
  pass: boolean;
  precondition?: true;
};

/** Records connection-facing state changes and every WebSocket lifecycle on the page clock. */
function installFlakyNetworkProbe() {
  const entries: BrowserEntry[] = [];
  Reflect.set(window, "__flakyNetworkProof", entries);
  const doc = Math.round(performance.timeOrigin);
  const log = (kind: string, fields: Partial<BrowserEntry> = {}) =>
    entries.push({ at: Date.now(), doc, kind, ...fields });
  const NativeWebSocket = window.WebSocket;
  let sockets = 0;
  window.WebSocket = class extends NativeWebSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      const socket = ++sockets;
      log("ws-new", { socket });
      this.addEventListener("open", () => log("ws-open", { socket }));
      this.addEventListener("close", (event) => log("ws-close", { socket, code: event.code }));
      const onMessage = (event: MessageEvent) => {
        try {
          const frame = JSON.parse(String(event.data));
          if (frame.type === "res" && frame.payload?.type === "hello-ok") {
            log("ws-hello", { socket });
            this.removeEventListener("message", onMessage);
          }
        } catch {
          // Only JSON frames can carry the handshake.
        }
      };
      this.addEventListener("message", onMessage);
    }
  };
  let last = "";
  const visible = (selector: string) =>
    [...document.querySelectorAll(selector)].find((element) => element.checkVisibility());
  setInterval(() => {
    const pill = visible(".gateway-status");
    const pane = document.querySelector(".chat-pane-cache__pane--active") ?? document;
    const state: UiSample = {
      phase: window.openclawControlUi?.snapshot().gatewayPhase ?? null,
      pill:
        [...(pill?.classList ?? [])]
          .find((name) => name.startsWith("gateway-status--") && name !== "gateway-status--row")
          ?.slice("gateway-status--".length) ?? null,
      label: pill?.querySelector(".gateway-status__label")?.textContent?.trim() ?? null,
      paneStatus: visible(".chat-pane__connection-state")?.textContent?.trim() ?? null,
      rows: pane.querySelectorAll(".chat-group").length,
      queued: document.querySelectorAll(".chat-queue__item").length,
      placeholder:
        document.querySelector<HTMLTextAreaElement>(".agent-chat__composer-combobox textarea")
          ?.placeholder ?? null,
    };
    const serialized = JSON.stringify(state);
    if (serialized !== last) {
      last = serialized;
      log("ui", { state });
    }
  }, 100);
}

const events: ProofEvent[] = [];
const t0 = Date.now();
const now = () => Date.now() - t0;
let scenario = "setup";
const note = (kind: string, detail?: Record<string, unknown>) => {
  const t = now();
  events.push({ t, scenario, kind, ...(detail ? { detail } : {}) });
  return t;
};
async function drain(page: Page) {
  assertRunning();
  // Entries stay in the page until drained; drain before every navigation.
  const entries: BrowserEntry[] = await page
    .evaluate(() => (Reflect.get(window, "__flakyNetworkProof") ?? []).splice(0))
    .catch(() => []);
  for (const { at, ...entry } of entries) {
    events.push({ ...entry, t: at - t0, scenario });
  }
}
const uiSamples = (from: number, to = Number.POSITIVE_INFINITY) =>
  events
    .filter(
      (event): event is ProofEvent & { state: UiSample } =>
        event.state !== undefined && event.t >= from && event.t <= to,
    )
    .toSorted((left, right) => left.t - right.t);
const statusVisible = (state: UiSample) =>
  state.paneStatus !== null || (state.pill !== null && state.pill !== "connected");
/** Drains the page until `find` returns a time or `ms` passes. */
async function drainUntil(page: Page, find: () => number | undefined, ms: number) {
  const deadline = Date.now() + ms;
  for (;;) {
    await drain(page);
    const found = find();
    if (found !== undefined || Date.now() > deadline) {
      return found;
    }
    await delay(200);
  }
}
const atMost = (name: string, value: number | null, limit: number): Check => ({
  name,
  value,
  limit: `<= ${limit}`,
  pass: value !== null && value <= limit,
});
const equals = (name: string, value: number | boolean, expected: number | boolean): Check => ({
  name,
  value,
  limit: `= ${expected}`,
  pass: value === expected,
});

let gateway: ChildProcess | undefined;
let browser: Browser | undefined;
let proxy: Awaited<ReturnType<typeof startFlakyNetworkProxy>> | undefined;
let admission: Awaited<ReturnType<typeof startWarmReloadAdmission>> | undefined;
let fixture: Awaited<ReturnType<typeof seedWarmReloadFixture>> | undefined;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  process.exitCode = 130;
  void browser?.close().catch(() => {});
};
function assertRunning() {
  if (interrupted) {
    throw new Error("Proof interrupted");
  }
}
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const port = await freeProofPort([], true);
const reserved = [port, resolveSandboxHostPort(port)];
const admissionPort = await freeProofPort(reserved);
const publicPort = await freeProofPort([...reserved, admissionPort]);
const results: Array<{
  scenario: string;
  verdict: "pass" | "fail" | "invalid";
  bytesDown: number;
  bytesUp: number;
  checks: Check[];
}> = [];

async function stopGateway() {
  if (!gateway) {
    return;
  }
  await stopChild(gateway, { teardownGraceMs: 10_000 });
  // Without a TTY the launcher re-execs the Gateway in its own process group; stop it by port.
  for (const signal of ["SIGTERM", "SIGKILL"] as const) {
    const pids = findGatewayPidsOnPortSync(port);
    if (!pids.length) {
      return;
    }
    note("gateway-port-cleanup", { signal, pids });
    for (const pid of pids) {
      try {
        process.kill(pid, signal);
      } catch {
        // Exited between lookup and signal.
      }
    }
    for (let attempt = 0; attempt < 20 && findGatewayPidsOnPortSync(port).length; attempt++) {
      await delay(500);
    }
  }
  if (findGatewayPidsOnPortSync(port).length) {
    throw new Error(`Owned Gateway still listens on ${port}`);
  }
}

try {
  admission = await startWarmReloadAdmission({
    gatewayPort: port,
    port: admissionPort,
    publicPort,
  });
  const link = await startFlakyNetworkProxy({ port: publicPort, upstreamPort: admissionPort });
  proxy = link;
  fixture = await seedWarmReloadFixture({
    stateDir: path.join(directory, "state"),
    port,
    sessions,
    ...(uiRoot ? { uiRoot } : {}),
    admission,
  });
  const config: OpenClawConfig = JSON.parse(await readFile(fixture.configPath, "utf8"));
  const agentName = config.agents?.entries?.main?.identity?.name;
  if (!agentName) {
    throw new Error("Fixture lost its synthetic agent identity");
  }
  const sessionKey = fixture.fixtureSummary.targets[0]!.key;
  const { workspaceDir, env } = fixture;
  const log = createWriteStream(path.join(directory, "gateway.log"));
  gateway = spawn(
    process.execPath,
    [
      path.join(dist, "entry.js"),
      "gateway",
      "run",
      "--port",
      String(port),
      "--bind",
      "loopback",
      "--allow-unconfigured",
    ],
    {
      cwd: workspaceDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  gateway.stdout?.pipe(log);
  gateway.stderr?.pipe(log);
  gateway.once("close", () => log.end());
  const readyBy = Date.now() + 180_000;
  for (;;) {
    assertRunning();
    if (gateway.exitCode !== null || gateway.signalCode !== null) {
      throw new Error("Owned Gateway exited during startup; inspect gateway.log");
    }
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`, {
      signal: AbortSignal.timeout(1000),
    }).then(
      (response) => response.ok,
      () => false,
    );
    if (ready) {
      break;
    }
    if (Date.now() > readyBy) {
      throw new Error("Owned Gateway did not become ready; inspect gateway.log");
    }
    await delay(250);
  }
  note("gateway-ready", { port, origin: admission.origin, chatPath: fixture.chatPath });

  const network = (patch: Partial<typeof airplane>) => {
    link.setFaults(patch);
    return note("network", { ...link.faults(), flows: link.flows() });
  };
  const transcriptCount = async (marker: string) => {
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        path.join(dist, "entry.js"),
        "gateway",
        "call",
        "chat.history",
        "--json",
        "--params",
        JSON.stringify({ sessionKey, limit: 50 }),
      ],
      {
        cwd: workspaceDir,
        env,
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const history: unknown = JSON.parse(stdout);
    const messages = isRecord(history) && Array.isArray(history.messages) ? history.messages : [];
    return messages.filter(
      (message) =>
        isRecord(message) &&
        message.role === "user" &&
        JSON.stringify(message.content).includes(marker),
    ).length;
  };
  const visibleCount = async (page: Page, marker: string) =>
    await page.evaluate(
      (needle) =>
        [
          ...(
            document.querySelector(".chat-pane-cache__pane--active") ?? document
          ).querySelectorAll(".chat-text"),
        ].filter((element) => element.textContent?.includes(needle)).length,
      marker,
    );
  const send = async (page: Page, text: string) => {
    const composer = page.locator(".agent-chat__composer-combobox textarea").first();
    await composer.fill(text);
    await composer.press("Enter");
    return note("sent", { text });
  };
  const deliveredOnce = async (page: Page, marker: string) => {
    // The Gateway transcript is the authority: an optimistic bubble shows before delivery,
    // and a send into a dead socket never renders as a queue item.
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && (await transcriptCount(marker)) === 0) {
      assertRunning();
      await delay(2000);
    }
    note("delivery-window");
    // Fixed observation window: a duplicate delivery would land here.
    await delay(10_000);
    return [
      equals("transcriptCopies", await transcriptCount(marker), 1),
      equals("visibleCopies", await visibleCount(page, marker), 1),
    ];
  };
  const restoreToConnected = async (page: Page) => {
    const restoredAt = network({ blackhole: false, refuse: false });
    // A live handshake, not a phase that never left "connected" over a dead socket.
    const helloAt = await drainUntil(
      page,
      () => events.find((event) => event.kind === "ws-hello" && event.t >= restoredAt)?.t,
      120_000,
    );
    return atMost(
      "restoreToConnectedMs",
      helloAt === undefined ? null : helloAt - restoredAt,
      thresholds.restoreToConnectedMs,
    );
  };

  assertRunning();
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: "dark",
  });
  await context.addCookies([admission.browserCookie]);
  await context.addInitScript({
    content: `globalThis.__name = (fn) => fn; (${installFlakyNetworkProbe.toString()})();`,
  });
  const page = await context.newPage();
  page.on("dialog", (dialog) => {
    note("dialog", { type: dialog.type() });
    void dialog.accept();
  });
  // Warm the browser on a clean link: service worker, shell, and transcript snapshot.
  network({ rttMs: 0, jitterMs: 0, downBps: 0, upBps: 0 });
  await page.goto(`${admission.origin}${fixture.chatPath}`);
  await waitForControlUiGatewayReady(page, 120_000);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
    timeout: 60_000,
  });
  await page.locator(".chat-pane-cache__pane--active .chat-group").first().waitFor();
  // Let the existing cache owners persist the loaded route before any outage.
  await delay(4000);
  await drain(page);

  const scenarios: Record<(typeof allScenarios)[number], () => Promise<Check[]>> = {
    // Silent airplane blackout with a send into the dead socket; recovery must replace
    // the hung opening attempt instead of waiting for its timeout.
    async blackout() {
      const start = network({ blackhole: true });
      await delay(3000);
      const marker = `flaky-network blackout ${randomUUID()}`;
      const sentAt = await send(page, marker);
      await delay(blackoutMs - 3000);
      await page.screenshot({ path: path.join(directory, "blackout-during.png") });
      await drain(page);
      const restoredAt = now();
      const settled = new Set(
        events
          .filter(
            (event) => event.t >= start && (event.kind === "ws-open" || event.kind === "ws-close"),
          )
          .map((event) => `${event.doc}:${event.socket}`),
      );
      const hung = events.find(
        (event) =>
          event.scenario === scenario &&
          event.kind === "ws-new" &&
          !settled.has(`${event.doc}:${event.socket}`),
      );
      const recovered = await restoreToConnected(page);
      const reconnectingAt = uiSamples(sentAt).find((event) => statusVisible(event.state))?.t;
      const delivered = await deliveredOnce(page, marker);
      return [
        {
          name: "hungOpeningAgeMs",
          value: hung ? restoredAt - hung.t : null,
          limit: "unopened WebSocket at restore",
          pass: hung !== undefined,
          precondition: true,
        },
        atMost(
          "sendToReconnectingMs",
          reconnectingAt === undefined ? null : reconnectingAt - sentAt,
          thresholds.sendToReconnectingMs,
        ),
        recovered,
        ...delivered,
      ];
    },
    // Reload while every connection is refused: the cached transcript, agent identity, and a
    // visible connection status must render without the Gateway.
    async "offline-reload"() {
      network({ refuse: true });
      link.resetAll();
      await drain(page);
      const previousDoc = Math.max(...events.map((event) => event.doc ?? 0));
      const reloadAt = note("reload");
      await page.reload({ waitUntil: "commit" }).catch((error: unknown) => {
        note("navigation-error", { error: String(error) });
      });
      await delay(15_000);
      await page.screenshot({ path: path.join(directory, "offline-reload-during.png") });
      await drain(page);
      const offline = uiSamples(reloadAt).filter((event) => (event.doc ?? 0) > previousDoc);
      const rowsAt = offline.find((event) => event.state.rows > 0)?.t;
      const statusAt = offline.find((event) => statusVisible(event.state))?.t;
      const placeholders = offline.flatMap((event) => event.state.placeholder ?? []);
      return [
        atMost(
          "offlineTranscriptMs",
          rowsAt === undefined ? null : rowsAt - reloadAt,
          thresholds.offlineTranscriptMs,
        ),
        atMost(
          "offlineStatusMs",
          statusAt === undefined ? null : statusAt - reloadAt,
          thresholds.offlineStatusMs,
        ),
        equals(
          "offlineComposerNamesAgent",
          placeholders.length > 0 && placeholders.every((text) => text.includes(agentName)),
          true,
        ),
        await restoreToConnected(page),
      ];
    },
    // Queue a send offline, reload while still offline, then reconnect: exactly one delivery.
    async "queue-reload"() {
      network({ refuse: true });
      link.resetAll();
      await page.waitForFunction(
        () => window.openclawControlUi?.snapshot().gatewayPhase !== "connected",
        undefined,
        { timeout: 30_000 },
      );
      const marker = `flaky-network queued ${randomUUID()}`;
      await send(page, marker);
      const queued = await page
        .locator(".chat-queue__item")
        .first()
        .waitFor({ timeout: 10_000 })
        .then(
          () => true,
          () => false,
        );
      await drain(page);
      note("reload");
      await page.reload({ waitUntil: "commit" }).catch((error: unknown) => {
        note("navigation-error", { error: String(error) });
      });
      await delay(8000);
      await page.screenshot({ path: path.join(directory, "queue-reload-during.png") });
      return [
        { ...equals("queuedWhileOffline", queued, true), precondition: true },
        await restoreToConnected(page),
        ...(await deliveredOnce(page, marker)),
      ];
    },
  };

  for (const name of scenarioNames) {
    assertRunning();
    scenario = "between";
    network(airplane);
    await waitForControlUiGatewayReady(page, 120_000);
    await delay(2000);
    await drain(page);
    scenario = name;
    const before = { ...link.stats };
    note("scenario");
    const checks = await scenarios[name]();
    await drain(page);
    await page.screenshot({ path: path.join(directory, `${name}-after.png`) });
    // A failed threshold is a failure; a precondition only guards against a vacuous pass.
    const verdict = checks.some((check) => !check.precondition && !check.pass)
      ? "fail"
      : checks.every((check) => check.pass)
        ? "pass"
        : "invalid";
    results.push({
      scenario: name,
      verdict,
      bytesDown: link.stats.bytesDown - before.bytesDown,
      bytesUp: link.stats.bytesUp - before.bytesUp,
      checks,
    });
    note("result", { verdict });
    for (const check of checks) {
      console.info(
        `${check.pass ? "PASS" : check.precondition ? "INVALID" : "FAIL"} ${name} ${check.name}=${check.value} (${check.limit})`,
      );
    }
  }
} catch (error) {
  note("error", { error: String(error instanceof Error ? (error.stack ?? error) : error) });
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const close of [
    () => browser?.close(),
    () => proxy?.close(),
    () => admission?.close(),
    stopGateway,
    () => fixture?.close(),
  ]) {
    try {
      await close();
    } catch (error) {
      console.error("Owned proof resource cleanup failed:", error);
      process.exitCode = 1;
    }
  }
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  if (results.some((result) => result.verdict !== "pass")) {
    process.exitCode ||= 1;
  }
  // Page entries arrive in batches; one clock orders them with runner notes.
  events.sort((left, right) => left.t - right.t);
  await writeFile(path.join(directory, "events.json"), JSON.stringify(events, null, 2));
  await writeFile(path.join(directory, "timeline.txt"), formatTimeline(events));
  await writeFile(
    path.join(directory, "summary.json"),
    JSON.stringify(
      {
        revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
        dist,
        uiRoot: uiRoot ?? path.join(dist, "control-ui"),
        profile: airplane,
        blackoutMs,
        thresholds,
        results,
      },
      null,
      2,
    ),
  );
  console.info(`Retained proof: ${directory}/summary.json`);
}

/** Compact per-scenario timeline: UI field changes, socket lifecycle, and runner notes. */
function formatTimeline(entries: ProofEvent[]) {
  const lines: string[] = [];
  let current = "";
  let start = 0;
  let previous: Record<string, unknown> = {};
  for (const event of entries) {
    if (event.scenario !== current) {
      current = event.scenario;
      start = event.t;
      previous = {};
      lines.push("", `=== ${current}`);
    }
    const at = `${((event.t - start) / 1000).toFixed(1).padStart(7)}s`;
    if (event.state) {
      const changed = Object.entries(event.state).filter(([key, value]) => previous[key] !== value);
      previous = event.state;
      if (changed.length) {
        lines.push(`${at} ui    ${changed.map(([key, value]) => `${key}=${value}`).join(" ")}`);
      }
    } else if (event.socket !== undefined) {
      lines.push(
        `${at} ${event.kind.padEnd(8)} #${event.socket}${event.code ? ` code=${event.code}` : ""}`,
      );
    } else {
      lines.push(
        `${at} ${event.kind.padEnd(8)} ${event.detail ? JSON.stringify(event.detail) : ""}`,
      );
    }
  }
  return `${lines.join("\n").trim()}\n`;
}
