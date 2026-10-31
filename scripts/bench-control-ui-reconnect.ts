// Production renderer + synthetic WebSocket transport. No live Gateway/provider timing claims.
// Example: pnpm exec tsx scripts/bench-control-ui-reconnect.ts --bundle-dir BASE --compare-bundle-dir HEAD --pairs 10 --thread-cpu-time
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type CDPSession, type ElementHandle } from "playwright";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../src/gateway/control-ui-contract.js";
import { captureSessionRowGeneration } from "../src/gateway/session-row-identity.js";
import { shareSidebarSessionRows } from "../src/gateway/session-row-presentation.js";
import { waitForControlUiInitialRoster } from "../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  createControlUiMockBootstrapConfig,
  installMockGateway,
  refreshProductionControlUiE2e,
  resolvePlaywrightChromiumExecutablePath,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createTeamScaleSidebarListOwner } from "../ui/src/test-helpers/control-ui-sidebar-list-fixture.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";
import {
  createInteractionFixture,
  installInteractionNavigationPreloadObserver,
  settleSidebarBackgroundWork,
} from "./lib/control-ui-interaction-scenarios.ts";
import { summarizeInteractionTrace } from "./lib/control-ui-interaction-trace.ts";

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    "compare-bundle-dir": { type: "string" },
    output: { type: "string", default: ".artifacts/control-ui-reconnect" },
    pairs: { type: "string", default: "1" },
    scenarios: { type: "string", default: "brief-drop,long-sleep,restart,update" },
    rtt: { type: "string", default: "0,100" },
    panes: { type: "string", default: "1,10" },
    smoke: { type: "boolean", default: false },
    trace: { type: "boolean", default: false },
    "thread-cpu-time": { type: "boolean", default: false },
    "first-pair-screenshots": { type: "boolean", default: false },
    "aa-control": { type: "boolean", default: false },
    "update-reload": { type: "boolean", default: false },
    "asset-latency-ms": { type: "string", default: "0" },
    "warm-picker": { type: "boolean", default: false },
    "graph-counts": { type: "boolean", default: false },
  },
});
if (values["graph-counts"] && values.trace) {
  throw new Error("Run reactive graph counts separately from CPU traces");
}
type Scenario = "brief-drop" | "long-sleep" | "restart" | "update";
const scenarios = (values.smoke ? ["brief-drop"] : values.scenarios.split(",")) as Scenario[];
const rtts = values.smoke ? [100] : values.rtt.split(",").map(Number);
const paneCounts = values.smoke ? [1] : values.panes.split(",").map(Number);
const pairs = values.smoke ? 1 : Number(values.pairs);
const assetLatencyMs = Number(values["asset-latency-ms"]);
if (
  !Number.isInteger(pairs) ||
  pairs < 1 ||
  !Number.isFinite(assetLatencyMs) ||
  assetLatencyMs < 0 ||
  scenarios.some((s) => !["brief-drop", "long-sleep", "restart", "update"].includes(s)) ||
  rtts.some((n) => !Number.isFinite(n) || n < 0) ||
  paneCounts.some((n) => n !== 1 && n !== 10)
) {
  throw new Error(
    "Expected positive pairs; scenarios brief-drop,long-sleep,restart,update; nonnegative RTT/asset latency; panes 1,10",
  );
}
const output = path.resolve(values.output);
await mkdir(output, { recursive: true });

// Installed after the existing mock, before the production client is created. Offline
// attempts fail instead of hanging CONNECTING until setOnline(true) silently opens them.
function installTransport({ rtt, updateReload }: { rtt: number; updateReload: boolean }) {
  const Base = window.WebSocket;
  const sockets: WebSocket[] = [];
  const nativeNow = Date.now.bind(Date);
  const restoredDocument = updateReload && sessionStorage.getItem("reconnectBench.updateReload");
  const longTasks: Array<{ start: number; duration: number }> = [];
  const recordLongTasks = (entries: PerformanceEntryList) => {
    for (const entry of entries) {
      longTasks.push({ start: entry.startTime, duration: entry.duration });
    }
  };
  const observer = new PerformanceObserver((list) => recordLongTasks(list.getEntries()));
  const state = {
    online: true,
    browserOnline: true,
    hidden: false,
    offsetMs: 0,
    restoredAt: 0,
    completedAt: 0,
    longTasks,
    drainLongTasks() {
      recordLongTasks(observer.takeRecords());
    },
    rpc: [] as Array<{
      method: string;
      id: string;
      params?: unknown;
      start: number;
      end?: number;
      bytes?: number;
      sessionRows?: number;
      historyMessages?: number;
    }>,
    change(online: boolean, signal: "network" | "visibility" | "none") {
      this.online = online;
      if (signal === "network") {
        this.browserOnline = online;
      }
      if (signal === "visibility") {
        this.hidden = !online;
      }
      if (!online) {
        for (const socket of sockets) {
          socket.close(1006, "benchmark transport unavailable");
        }
        if (signal === "network") {
          window.dispatchEvent(new Event("offline"));
        }
        if (signal === "visibility") {
          document.dispatchEvent(new Event("visibilitychange"));
        }
      } else {
        this.restoredAt = performance.now();
        performance.mark("reconnect:start");
        if (signal === "network") {
          window.dispatchEvent(new Event("online"));
        }
        if (signal === "visibility") {
          document.dispatchEvent(new Event("visibilitychange"));
        }
      }
    },
  };
  Date.now = () => nativeNow() + state.offsetMs;
  observer.observe({ type: "longtask", buffered: true });
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    get: () => state.browserOnline,
  });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => state.hidden });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => (state.hidden ? "hidden" : "visible"),
  });
  type MockSocket = WebSocket & { openConnection(): void; deliver(frame: unknown): void };
  class Transport extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      sockets.push(this);
      const socket = this as unknown as MockSocket;
      const open = socket.openConnection.bind(socket);
      socket.openConnection = () =>
        state.online ? open() : socket.close(1006, "benchmark transport unavailable");
      const deliver = socket.deliver.bind(socket);
      socket.deliver = (frame) => {
        const complete = () => {
          if (socket.readyState !== Base.OPEN) {
            return;
          }
          if (typeof frame === "object" && frame && "id" in frame) {
            const row = state.rpc.find(
              (pending) => pending.id === frame.id && pending.end === undefined,
            );
            if (row) {
              row.end = performance.now();
              row.bytes = new TextEncoder().encode(JSON.stringify(frame)).length;
              if ("payload" in frame && typeof frame.payload === "object" && frame.payload) {
                const payload = frame.payload;
                if ("sessions" in payload && Array.isArray(payload.sessions)) {
                  row.sessionRows = payload.sessions.length;
                }
                let history: unknown = payload;
                if (
                  "initialHistory" in payload &&
                  typeof payload.initialHistory === "object" &&
                  payload.initialHistory &&
                  "payload" in payload.initialHistory
                ) {
                  history = payload.initialHistory.payload;
                }
                if (
                  typeof history === "object" &&
                  history &&
                  "messages" in history &&
                  Array.isArray(history.messages)
                ) {
                  row.historyMessages = history.messages.length;
                }
              }
            }
          }
          if (
            (state.restoredAt || restoredDocument) &&
            typeof frame === "object" &&
            frame &&
            "payload" in frame
          ) {
            const payload = frame.payload;
            if (typeof payload === "object" && payload && "snapshot" in payload) {
              const snapshot = payload.snapshot;
              if (
                typeof snapshot === "object" &&
                snapshot &&
                "presence" in snapshot &&
                Array.isArray(snapshot.presence)
              ) {
                for (const entry of snapshot.presence) {
                  if (entry?.user?.id === "reconnect-person") {
                    entry.user.name = "Reconnected presence witness";
                  }
                }
              }
            }
          }
          deliver(frame);
        };
        if (rtt) {
          setTimeout(complete, rtt / 2);
        } else {
          complete();
        }
      };
      // The fixture's routing constructor returns its own socket object, so
      // instance wrapping is required; a subclass prototype override is lost.
      const originalSend = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") {
          const frame = JSON.parse(data);
          if (frame.type === "req") {
            state.rpc.push({
              method: frame.method,
              id: frame.id,
              params: frame.params,
              start: performance.now(),
            });
          }
        }
        const send = () => {
          if (socket.readyState === Base.OPEN) {
            originalSend(data);
          }
        };
        if (rtt) {
          setTimeout(send, rtt / 2);
        } else {
          send();
        }
      };
    }
  }
  window.WebSocket = Transport;
  Reflect.set(window, "reconnectBench", state);
}

function isFullyLive(count: number) {
  if (window.openclawControlUi?.snapshot().gatewayPhase !== "connected") {
    return false;
  }
  type PaneProbe = HTMLElement & {
    context?: {
      gateway?: {
        snapshot?: {
          hello?: {
            snapshot?: { presence?: Array<{ user?: { name?: string } }> };
          };
        };
      };
    };
  };
  const visiblePanes = [
    ...document.querySelectorAll<PaneProbe>("openclaw-chat-pane.chat-pane-cache__pane--visible"),
  ];
  if (
    visiblePanes.length !== count ||
    visiblePanes.some((pane) => !pane.textContent?.includes("Reconciled reconnect history witness"))
  ) {
    return false;
  }
  const inputs = [
    ...document.querySelectorAll<HTMLTextAreaElement>(
      ".chat-pane-cache__pane--visible .agent-chat__composer-combobox textarea",
    ),
  ];
  const presence = visiblePanes[0]?.context?.gateway?.snapshot?.hello?.snapshot?.presence;
  const send = visiblePanes[0]?.querySelector<HTMLButtonElement>(".chat-send-btn--send");
  const transport = Reflect.get(window, "reconnectBench");
  const sidebarReconciled = transport.rpc.some(
    (row: { method: string; params?: { rowMode?: string }; start: number; end?: number }) =>
      row.method === "sessions.list" &&
      row.params?.rowMode === "sidebar" &&
      row.start >= transport.restoredAt &&
      row.end !== undefined,
  );
  return (
    sidebarReconciled &&
    send &&
    !send.disabled &&
    send.getAttribute("aria-busy") !== "true" &&
    send.getAttribute("aria-label") === "Send message" &&
    presence?.some((entry) => entry.user?.name === "Reconnected presence witness") &&
    inputs.length === count &&
    inputs.every((input) => !input.disabled) &&
    inputs[0]?.value === "Synthetic unsent reconnect draft" &&
    [...document.querySelectorAll(".sidebar-recent-session__name")].some(
      (row) => row.textContent === "Reconnected sidebar witness",
    )
  );
}

type Sample = {
  id: string;
  bundle: string;
  pair: number;
  scenario: Scenario;
  rtt: number;
  panes: number;
  status: "passed" | "failed";
  stage: string;
  error?: string;
  load: number[];
  wallMs?: number;
  scriptMs?: number;
  taskMs?: number;
  layoutMs?: number;
  styleMs?: number;
  longestTaskMs?: number;
  longTasks?: Array<{ start: number; duration: number }>;
  rpc?: Array<{
    method: string;
    params?: unknown;
    start: number;
    end?: number;
    bytes?: number;
    sessionRows?: number;
    historyMessages?: number;
  }>;
  work?: {
    rpcStarted: number;
    rpcDelivered: number;
    sessionRows: number;
    historyMessages: number;
    byMethod: Record<string, number>;
  };
  trace?: ReturnType<typeof summarizeInteractionTrace>;
  reactiveGraphArtifact?: string;
  retainedPicker?: { sameNode: true; mutationRequests: 0 };
  updateReload?: {
    wallMs: number;
    restoredBuildId: string;
    rpc: NonNullable<Sample["rpc"]>;
    longTasks: NonNullable<Sample["longTasks"]>;
    longestTaskMs: number;
  };
};
const samples: Sample[] = [];
const bundles = [
  { name: "base", dir: values["bundle-dir"] },
  ...(values["aa-control"] ? [{ name: "control", dir: values["bundle-dir"] }] : []),
  ...(values["compare-bundle-dir"] ? [{ name: "head", dir: values["compare-bundle-dir"] }] : []),
];
const servers: Array<{
  name: string;
  dir: string;
  build: { buildId: string; version: string };
  indexSha256: string;
  upgradedDir?: string;
  server: Awaited<ReturnType<typeof startControlUiBenchGatewayServer>>;
}> = [];
const browser = await chromium.launch({
  executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  headless: true,
});

async function metrics(cdp: CDPSession) {
  const result: { metrics: Array<{ name: string; value: number }> } =
    await cdp.send("Performance.getMetrics");
  return Object.fromEntries(result.metrics.map((row) => [row.name, row.value]));
}
async function writeSummary() {
  const distribution = (numbers: number[]) => {
    const sorted = numbers.toSorted((a, b) => a - b);
    return sorted.length
      ? {
          median:
            sorted.length % 2
              ? sorted[(sorted.length - 1) / 2]
              : (sorted[sorted.length / 2 - 1]! + sorted[sorted.length / 2]!) / 2,
          p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
          min: sorted[0],
          max: sorted.at(-1),
        }
      : null;
  };
  const groups = Map.groupBy(
    samples,
    (row) => `${row.bundle}/${row.scenario}/${row.rtt}/${row.panes}`,
  );
  const summary = [...groups].map(([cell, rows]) =>
    Object.assign(
      {
        cell,
        passed: rows.filter((row) => row.status === "passed").length,
        failed: rows.filter((row) => row.status === "failed").length,
      },
      Object.fromEntries(
        ["wallMs", "scriptMs", "taskMs", "layoutMs", "styleMs", "longestTaskMs"].map((metric) => [
          metric,
          distribution(
            rows
              .filter((row) => row.status === "passed")
              .map((row) => Reflect.get(row, metric))
              .filter((v): v is number => typeof v === "number"),
          ),
        ]),
      ),
      {
        updateReloadMs: distribution(
          rows
            .filter((row) => row.status === "passed" && row.updateReload)
            .map((row) => row.updateReload!.wallMs),
        ),
      },
    ),
  );
  await writeFile(
    path.join(output, "results.json"),
    JSON.stringify(
      {
        measurement: "production-renderer/mock-transport",
        timeDomain: values["thread-cpu-time"] ? "threadTicks" : "timeTicks",
        trace: values.trace,
        updateReload: values["update-reload"],
        assetLatencyMs,
        warmPicker: values["warm-picker"],
        host: { platform: os.platform(), arch: os.arch(), cpus: os.cpus().length },
        notes: [
          "RPC RTT is split across synthetic request/response delivery; assetLatencyMs adds a fixed delay to HTTP requests and synthetic bootstrap responses, without bandwidth or loss emulation.",
          "Long sleep advances Date.now by 30 minutes with transport unavailable; native rendering and timer clocks remain real.",
          "Update stops at the safe server-updated prompt; it is not claimed as fully live recovery.",
          ...(values["update-reload"]
            ? [
                "Optional updateReload measures synthetic Refresh click to fully live in a new document; it excludes human decision time and does not report cross-document CPU counters.",
              ]
            : []),
          "Every live result requires new history in every visible pane, changed sidebar text and presence, connected state and enabled draft composers.",
          "Wall time is transport-restoration to the readiness assertion, not INP. LongestTaskMs uses the Long Tasks observer (zero means no observed task >=50ms).",
        ],
        samples,
        summary,
      },
      null,
      2,
    ),
  );
  return summary;
}

try {
  for (const bundle of bundles) {
    const dir = path.resolve(bundle.dir);
    const index = await readFile(path.join(dir, "index.html"));
    const html = index.toString("utf8");
    const raw = html.match(
      /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su,
    )?.[1];
    if (!raw) {
      throw new Error(`Missing build identity: ${dir}`);
    }
    let upgradedDir: string | undefined;
    if (values["update-reload"]) {
      upgradedDir = path.join(output, `upgraded-${bundle.name}`);
      // A fresh output directory protects earlier proof and immutable input bundles.
      await mkdir(upgradedDir);
      await cp(dir, upgradedDir, {
        recursive: true,
        dereference: true,
        mode: fsConstants.COPYFILE_FICLONE,
      });
      await refreshProductionControlUiE2e(upgradedDir, "reconnect-next-build");
    }
    servers.push({
      ...bundle,
      dir,
      upgradedDir,
      build: JSON.parse(raw),
      indexSha256: createHash("sha256").update(index).digest("hex"),
      server: await startControlUiBenchGatewayServer(dir, 0, assetLatencyMs),
    });
  }
  await writeFile(
    path.join(output, "manifest.json"),
    JSON.stringify(
      {
        bundles: servers.map(({ name, dir, build, indexSha256 }) => ({
          name,
          dir,
          build,
          indexSha256,
        })),
        pairs,
        scenarios,
        rtts,
        paneCounts,
        updateReload: values["update-reload"],
        assetLatencyMs,
        warmPicker: values["warm-picker"],
        planned: pairs * scenarios.length * rtts.length * paneCounts.length * servers.length,
        acceptance:
          "Ten interleaved pairs, median <=5% regression and p95 no worse; target -40% brief-drop/sleep and no reconnect task >100ms. A/A control on loaded hosts.",
      },
      null,
      2,
    ),
  );
  for (let pair = 0; pair < pairs; pair++) {
    for (const scenario of scenarios) {
      for (const rtt of rtts) {
        for (const panes of paneCounts) {
          for (const slot of pair % 2 ? servers.toReversed() : servers) {
            const id = `${slot.name}-${scenario}-rtt${rtt}-panes${panes}-${pair}`;
            const result: Sample = {
              id,
              bundle: slot.name,
              pair,
              scenario,
              rtt,
              panes,
              status: "failed",
              stage: "prepare",
              load: os.loadavg(),
            };
            samples.push(result);
            const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
            const page = await context.newPage();
            page.setDefaultTimeout(30_000);
            await page.addInitScript(installInteractionNavigationPreloadObserver);
            const errors: string[] = [];
            page.on("pageerror", (error) => errors.push(String(error)));
            let cdp: CDPSession | undefined;
            let tracing = false;
            let reconnectProfile: unknown;
            const events: unknown[] = [];
            const listCalls: unknown[] = [];
            let retainedMenu: ElementHandle<HTMLElement | SVGElement> | null = null;
            try {
              if (slot.upgradedDir) {
                await slot.server.selectBuild(slot.dir);
              }
              const fixture = createInteractionFixture(slot.build.buildId, slot.build.version);
              const keys = fixture.sessions.slice(0, panes).map((row) => row.key);
              const createListOwner = () =>
                createTeamScaleSidebarListOwner({
                  rows: fixture.sessions,
                  viewerProfileId: "reconnect-viewer",
                  now: 1_800_000_000_000,
                  defaults: { model: "model-0", modelProvider: "example", contextTokens: 128_000 },
                  owners: [],
                });
              let owner = createListOwner();
              const messages = [
                {
                  role: "assistant",
                  content: "Synthetic reconnect history before transport loss",
                  __openclaw: { id: "reconnect-history-1", seq: 1 },
                },
              ];

              const gateway = await installMockGateway(
                page,
                {
                  ...fixture,
                  sessionTranscripts: {},
                  historyMessages: messages,
                  presenceUsers: [
                    {
                      id: "reconnect-person",
                      name: "Reconnect witness",
                      identity: { type: "profile", id: "reconnect-person" },
                      watchedSessions: keys,
                    },
                  ],
                  awaitInitialRoster: false,
                },
                {
                  requestHandlers: {
                    "sessions.list": (params) => {
                      if (!isRecord(params)) {
                        throw new Error("sessions.list params required");
                      }
                      const { result: listResult, previousRows } = owner.list(params);
                      const response =
                        params.rowMode === "sidebar" || params.ifRowsRevision !== undefined
                          ? {
                              ...listResult,
                              ...shareSidebarSessionRows(
                                listResult.sessions,
                                typeof params.ifRowsRevision === "string"
                                  ? params.ifRowsRevision
                                  : undefined,
                                previousRows
                                  ? [captureSessionRowGeneration(previousRows)]
                                  : undefined,
                              ),
                            }
                          : listResult;
                      owner.recordWire(response);
                      listCalls.push({
                        params,
                        keys: response.sessions.slice(0, 12).map((row) => row.key),
                        witness: response.sessions.some(
                          (row) => row.key === "agent:main:reconnect-witness",
                        ),
                      });
                      return response;
                    },
                  },
                },
              );
              let servedBuildId = slot.build.buildId;
              if (values["update-reload"] || assetLatencyMs > 0) {
                await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, async (route) => {
                  if (assetLatencyMs > 0) {
                    await delay(assetLatencyMs);
                  }
                  await route.fulfill({
                    body: JSON.stringify(
                      createControlUiMockBootstrapConfig({
                        ...fixture,
                        serverBuildId: servedBuildId,
                      }),
                    ),
                    contentType: "application/json",
                    status: 200,
                  });
                });
              }
              await page.addInitScript({
                content: `;(() => { const __name = (v) => v; (${installTransport.toString()})(${JSON.stringify({ rtt, updateReload: values["update-reload"] })}); })();`,
              });
              await page.addInitScript(
                ({ settingsKey, keys: paneKeys }) => {
                  const seededKey = "reconnectBench.layoutSeeded";
                  if (sessionStorage.getItem(seededKey)) {
                    return;
                  }
                  localStorage.setItem(
                    settingsKey,
                    JSON.stringify({
                      chatSplitLayout: {
                        activePaneId: "p1",
                        columns: [
                          {
                            id: "c1",
                            panes: paneKeys.map((sessionKey, index) => ({
                              id: `p${index + 1}`,
                              sessionKey,
                            })),
                            paneWeights: paneKeys.map(() => 1 / paneKeys.length),
                          },
                        ],
                        columnWeights: [1],
                      },
                    }),
                  );
                  sessionStorage.setItem(seededKey, "1");
                },
                { settingsKey: controlUiBundledSettingsStorageKey(slot.server.baseUrl), keys },
              );
              await page.goto(controlUiSessionUrl(slot.server.baseUrl, keys[0]!));
              result.stage = "initial-roster";
              await waitForControlUiInitialRoster(page, 30_000);
              result.stage = "visible-panes";
              await page.waitForFunction(
                (count) =>
                  document.querySelectorAll("openclaw-chat-pane.chat-pane-cache__pane--visible")
                    .length === count,
                panes,
              );
              await page
                .locator(".chat-pane-cache__pane--visible .agent-chat__composer-combobox textarea")
                .first()
                .fill("Synthetic unsent reconnect draft");
              if (values["warm-picker"]) {
                const trigger = page.locator(
                  ".chat-pane-cache__pane--active [data-chat-model-select]",
                );
                await trigger.click();
                const search = page.locator("[data-chat-model-search]");
                await search.waitFor();
                retainedMenu = await page.locator(".chat-controls__model-menu").elementHandle();
                if (!retainedMenu) {
                  throw new Error("Opened picker did not retain a menu node");
                }
                await search.fill("Warm model 0999");
                await page.locator('[data-chat-model-option="example/model-999"]').waitFor();
                await search.fill("");
                await trigger.click();
                await page.locator(".chat-controls__model-menu").waitFor({ state: "hidden" });
                await page
                  .locator(".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea")
                  .click();
              }
              await settleSidebarBackgroundWork(page);
              result.stage = "transport-drop";
              cdp = await context.newCDPSession(page);
              await cdp.send("Performance.enable", {
                timeDomain: values["thread-cpu-time"] ? "threadTicks" : "timeTicks",
              });
              // Changes happen while offline; readiness must prove reconciliation, not retained content.
              const signal =
                scenario === "brief-drop"
                  ? "network"
                  : scenario === "long-sleep"
                    ? "visibility"
                    : "none";
              await page.evaluate(
                (restorationSignal) =>
                  Reflect.get(window, "reconnectBench").change(false, restorationSignal),
                signal,
              );
              await page.waitForFunction(
                () => window.openclawControlUi?.snapshot().gatewayPhase === "reconnecting",
              );
              if (scenario === "restart" || scenario === "update") {
                // A new Gateway process has no previous row identities or wire revisions.
                owner = createListOwner();
              }
              owner.apply({
                removeKeys: [fixture.sessions.at(-1)!.key],
                upsert: [
                  {
                    ...fixture.sessions[0]!,
                    key: "agent:main:reconnect-witness",
                    sessionId: "reconnect-witness",
                    label: "Reconnected sidebar witness",
                    createdAt: 1_800_000_100_000,
                    updatedAt: 1_800_000_100_000,
                  },
                ],
              });
              const reconciledHistory = [
                {
                  role: "assistant",
                  content: "Reconciled reconnect history witness",
                  __openclaw: { id: "reconnect-history-2", seq: 2 },
                },
              ];
              await gateway.setHistoryMessages(reconciledHistory);
              if (scenario === "restart" || scenario === "update") {
                await gateway.setGatewayBootId(`reconnect-${id}`);
              }
              if (scenario === "update") {
                // Keep the normal guard window while capturing the old bundle's refresh prompt.
                await page.evaluate(() =>
                  sessionStorage.setItem(
                    "openclaw.controlUi.staleChunkReloadBuildId",
                    JSON.stringify({ buildId: "reconnect-next-build", at: Date.now() }),
                  ),
                );
                await gateway.setServerBuildId("reconnect-next-build");
                if (slot.upgradedDir) {
                  // The existing mock persists method overrides across document replacement.
                  for (const method of ["chat.startup", "chat.history"]) {
                    await gateway.setMethodResponse(method, {
                      cases: keys.map((sessionKey) => {
                        const row = fixture.sessions.find((session) => session.key === sessionKey)!;
                        return {
                          match: { sessionKey },
                          response: {
                            sessionId: row.sessionId,
                            sessionInfo: row,
                            messages: reconciledHistory,
                            ...(method === "chat.startup"
                              ? { metadata: { models: fixture.models } }
                              : {}),
                          },
                        };
                      }),
                    });
                  }
                  servedBuildId = "reconnect-next-build";
                  await slot.server.selectBuild(slot.upgradedDir);
                }
              }
              if (scenario === "brief-drop") {
                await delay(5_000);
              }
              if (scenario === "long-sleep") {
                await page.evaluate(() => {
                  Reflect.get(window, "reconnectBench").offsetMs += 30 * 60_000;
                });
              }
              if (values.trace) {
                cdp.on("Tracing.dataCollected", ({ value }: { value: unknown[] }) =>
                  events.push(...value),
                );
                await cdp.send("Tracing.start", {
                  categories: "toplevel,blink.user_timing,devtools.timeline",
                  transferMode: "ReportEvents",
                });
                await cdp.send("Profiler.enable");
                await cdp.send("Profiler.start");
                tracing = true;
              }
              const before = await metrics(cdp);
              result.stage = "restore";
              if (values["graph-counts"]) {
                await page.evaluate((label) => {
                  const graph = Reflect.get(window, "__openclawReactiveGraph");
                  if (!graph) {
                    throw new Error("--graph-counts requires the explicit reactive graph build");
                  }
                  graph.start(label);
                }, id);
              }
              await page.evaluate(
                (restorationSignal) =>
                  Reflect.get(window, "reconnectBench").change(true, restorationSignal),
                signal,
              );
              if (scenario === "update") {
                await page
                  .getByRole("button", { name: /Server updated/u })
                  .waitFor({ timeout: 30_000 });
                await page.waitForFunction(() => {
                  const phase = window.openclawControlUi?.snapshot().gatewayPhase;
                  const pane = document.querySelector(
                    "openclaw-chat-pane.chat-pane-cache__pane--active",
                  );
                  const draft = pane?.querySelector<HTMLTextAreaElement>(
                    ".agent-chat__composer-combobox textarea",
                  );
                  const transport = Reflect.get(window, "reconnectBench");
                  return (
                    phase === "reconnecting" &&
                    draft?.value === "Synthetic unsent reconnect draft" &&
                    !transport.rpc.some(
                      (row: { method: string; start: number }) =>
                        row.method === "chat.send" && row.start >= transport.restoredAt,
                    )
                  );
                });
              } else {
                await page.waitForFunction(isFullyLive, panes, { timeout: 30_000 });
              }
              await page.evaluate(() => {
                const state = Reflect.get(window, "reconnectBench");
                state.completedAt = performance.now();
                performance.mark("reconnect:end");
              });
              const after = await metrics(cdp);
              if (values["graph-counts"]) {
                const graph = await page.evaluate(() =>
                  Reflect.get(window, "__openclawReactiveGraph").stop(),
                );
                const artifact = `${id}.reactive-graph.json`;
                await writeFile(path.join(output, artifact), JSON.stringify(graph, null, 2));
                result.reactiveGraphArtifact = artifact;
              }
              result.wallMs = await page.evaluate(() => {
                const state = Reflect.get(window, "reconnectBench");
                return state.completedAt - state.restoredAt;
              });
              result.rpc = await page.evaluate(() => {
                const state = Reflect.get(window, "reconnectBench");
                return state.rpc
                  .filter(
                    (row: { start: number }) =>
                      row.start >= state.restoredAt && row.start <= state.completedAt,
                  )
                  .map((row: { end?: number }) =>
                    row.end !== undefined && row.end > state.completedAt
                      ? Object.assign({}, row, {
                          end: undefined,
                          bytes: undefined,
                          sessionRows: undefined,
                          historyMessages: undefined,
                        })
                      : row,
                  );
              });
              result.longTasks = await page.evaluate(() => {
                const state = Reflect.get(window, "reconnectBench");
                state.drainLongTasks();
                return state.longTasks.filter(
                  (row: { start: number; duration: number }) =>
                    row.start + row.duration > state.restoredAt && row.start <= state.completedAt,
                );
              });
              result.work = {
                rpcStarted: result.rpc!.length,
                rpcDelivered: result.rpc!.filter((row) => row.end !== undefined).length,
                sessionRows: result.rpc!.reduce((sum, row) => sum + (row.sessionRows ?? 0), 0),
                historyMessages: result.rpc!.reduce(
                  (sum, row) => sum + (row.historyMessages ?? 0),
                  0,
                ),
                byMethod: Object.fromEntries(
                  [...Map.groupBy(result.rpc!, (row) => row.method)].map(([method, rows]) => [
                    method,
                    rows.length,
                  ]),
                ),
              };
              result.longestTaskMs = Math.max(0, ...result.longTasks!.map((row) => row.duration));
              for (const [field, metric] of [
                ["scriptMs", "ScriptDuration"],
                ["taskMs", "TaskDuration"],
                ["layoutMs", "LayoutDuration"],
                ["styleMs", "RecalcStyleDuration"],
              ]) {
                Reflect.set(
                  result,
                  field!,
                  ((after[metric!] ?? 0) - (before[metric!] ?? 0)) * 1000,
                );
              }
              if (retainedMenu && scenario !== "update") {
                if (!(await retainedMenu.evaluate((node) => node.isConnected))) {
                  throw new Error("Reconnect replaced the retained picker menu");
                }
                await page
                  .locator(".chat-pane-cache__pane--active [data-chat-model-select]")
                  .click();
                await retainedMenu.waitForElementState("visible");
                await page.locator("[data-chat-model-search]").fill("Warm model 0999");
                await page.locator('[data-chat-model-option="example/model-999"]').waitFor();
                const mutations = [
                  ...(await gateway.getRequests("sessions.patch")),
                  ...(await gateway.getRequests("chat.send")),
                ];
                if (mutations.length) {
                  throw new Error("Retained-picker recovery dispatched a mutation");
                }
                result.retainedPicker = { sameNode: true, mutationRequests: 0 };
              }
              if (scenario === "update" && values["update-reload"]) {
                if (tracing && cdp) {
                  // Navigation resets Chrome's profiler; retain the old-document interval first.
                  const { profile } = await cdp.send("Profiler.stop");
                  reconnectProfile = profile;
                }
                result.stage = "update-reload-click";
                const click = await page.evaluate(() => {
                  sessionStorage.setItem("reconnectBench.updateReload", "1");
                  return {
                    timeOrigin: performance.timeOrigin,
                    epoch: performance.timeOrigin + performance.now(),
                  };
                });
                await page.getByRole("button", { name: /Server updated/u }).click();
                result.stage = "update-reload-document";
                await page.waitForFunction(
                  (previousOrigin) =>
                    performance.timeOrigin !== previousOrigin &&
                    globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO?.buildId === "reconnect-next-build",
                  click.timeOrigin,
                );
                result.stage = "update-reload-live";
                await page.waitForFunction(isFullyLive, panes, { timeout: 30_000 });
                result.updateReload = await page.evaluate((clickedAt) => {
                  const state = Reflect.get(window, "reconnectBench");
                  const completedAt = performance.now();
                  state.drainLongTasks();
                  const longTasks = state.longTasks.filter(
                    (row: { start: number }) => row.start <= completedAt,
                  );
                  return {
                    wallMs: performance.timeOrigin + completedAt - clickedAt,
                    restoredBuildId: globalThis.OPENCLAW_CONTROL_UI_BUILD_INFO!.buildId,
                    rpc: state.rpc
                      .filter((row: { start: number }) => row.start <= completedAt)
                      .map((row: { end?: number }) =>
                        row.end !== undefined && row.end > completedAt
                          ? Object.assign({}, row, {
                              end: undefined,
                              bytes: undefined,
                              sessionRows: undefined,
                              historyMessages: undefined,
                            })
                          : row,
                      ),
                    longTasks,
                    longestTaskMs: Math.max(
                      0,
                      ...longTasks.map((row: { duration: number }) => row.duration),
                    ),
                  };
                }, click.epoch);
              }
              if (
                [...result.rpc!, ...(result.updateReload?.rpc ?? [])].some(
                  (row) => row.method === "chat.send",
                )
              ) {
                throw new Error("Reconnect dispatched the unsent draft");
              }
              if (errors.length) {
                throw new Error(errors.join("\n"));
              }
              result.status = "passed";
              result.stage = "complete";
            } catch (error) {
              result.error = String(error);
            } finally {
              try {
                if (tracing && cdp) {
                  const profile = reconnectProfile ?? (await cdp.send("Profiler.stop")).profile;
                  await writeFile(path.join(output, `${id}.cpuprofile`), JSON.stringify(profile));
                  const complete = new Promise<void>((resolve) => {
                    cdp!.once("Tracing.tracingComplete", () => resolve());
                  });
                  await cdp.send("Tracing.end");
                  await complete;
                  await writeFile(
                    path.join(output, `${id}.trace.json`),
                    JSON.stringify({ traceEvents: events }),
                  );
                  if (result.status === "passed") {
                    result.trace = summarizeInteractionTrace(events, {
                      start: "reconnect:start",
                      end: "reconnect:end",
                    });
                  }
                }
                if (
                  result.status === "failed" ||
                  (values["first-pair-screenshots"] && pair === 0)
                ) {
                  await writeFile(
                    path.join(output, `${id}.diagnostics.json`),
                    JSON.stringify(
                      {
                        listCalls,
                        browser: await page.evaluate(() => ({
                          snapshot: window.openclawControlUi?.snapshot(),
                          transport: Reflect.get(window, "reconnectBench"),
                          names: [
                            ...document.querySelectorAll(".sidebar-recent-session__name"),
                          ].map((row) => row.textContent),
                          drafts: [
                            ...document.querySelectorAll<HTMLTextAreaElement>(
                              ".agent-chat__composer-combobox textarea",
                            ),
                          ].map((input) => ({ value: input.value, disabled: input.disabled })),
                        })),
                      },
                      null,
                      2,
                    ),
                  );
                  await page.screenshot({ path: path.join(output, `${id}.png`), fullPage: false });
                  await writeFile(path.join(output, `${id}.html`), await page.content());
                }
              } catch (error) {
                result.status = "failed";
                result.error = [result.error, String(error)].filter(Boolean).join("\n");
              }
              await context.close();
              await writeSummary();
              console.log(
                JSON.stringify({
                  ...result,
                  rpc: undefined,
                  updateReload: result.updateReload
                    ? { ...result.updateReload, rpc: undefined }
                    : undefined,
                }),
              );
            }
            if (values["update-reload"] && result.status === "failed") {
              throw new Error(`Update reload proof failed at ${id}: ${result.error}`);
            }
          }
        }
      }
    }
  }
} finally {
  await browser.close();
  for (const slot of servers) {
    await slot.server.close();
  }
}
console.log(JSON.stringify(await writeSummary(), null, 2));
if (samples.some((row) => row.status === "failed")) {
  process.exitCode = 1;
}
