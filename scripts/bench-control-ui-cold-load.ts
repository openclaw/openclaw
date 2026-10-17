// Opt-in production-bundle benchmark; real delays model wire delivery, not test synchronization.
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium, type Browser } from "playwright";
import { buildSandboxHostPath } from "../src/agents/sandbox-host.js";
import { createSandboxHostHttpServer } from "../src/gateway/mcp-app-sandbox-http.js";
import { shareSidebarSessionRows } from "../src/gateway/session-row-presentation.js";
import { createColdLoadProbeInitScript } from "../ui/src/test-helpers/control-ui-cold-load-probes.ts";
import {
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  controlUiSessionUrl,
  controlUiBundledSettingsStorageKey,
  prepareControlUiMockGatewayScenario,
  resolvePlaywrightChromiumExecutablePath,
  startProductionControlUiE2eServer,
  startBuiltControlUiE2eServer,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createTeamScaleSidebarListOwner } from "../ui/src/test-helpers/control-ui-sidebar-list-fixture.ts";
import {
  createControlUiStreamingReply,
  createStreamingReplyProbeInitScript,
} from "../ui/src/test-helpers/control-ui-streaming-reply.ts";
import { createControlUiTeamScaleFixture } from "../ui/src/test-helpers/control-ui-team-scale-fixture.ts";
import {
  mapColdLoadCpuProfile,
  prepareColdLoadTraceEvent,
  summarizeColdLoadTrace,
  summarizeCpuProfile,
} from "./lib/control-ui-cold-load-trace.ts";
import { probeColdLoadOverlays } from "./lib/control-ui-overlay-probe.ts";
import { warmReloadProbe } from "./lib/control-ui-warm-reload-probe.ts";

function readRigProbeSnapshot() {
  const perf = Reflect.get(window, "__perf");
  return {
    atMs: performance.now(),
    attribution: [...(Reflect.get(window, "__mutAttr") ?? new Map())],
    mutations: structuredClone([...(perf?.mut ?? new Map())]),
    loaf: [...(perf?.loaf ?? [])],
    paints: [...(perf?.paints ?? [])],
    rpc: [...(Reflect.get(window, "__wsLog") ?? [])],
  };
}

function installWidgetReadiness() {
  const ready = new Map<string, number>();
  window.addEventListener("message", (event) => {
    if (event.data?.method !== "ui/notifications/sandbox-resource-loaded") {
      return;
    }
    for (const [kind, selector] of [
      ["board", ".board-widget__frame"],
      ["inline", ".chat-tool-card__preview-frame"],
    ] as const) {
      const frames = [...document.querySelectorAll<HTMLIFrameElement>(selector)];
      const index = frames.findIndex((frame) => frame.contentWindow === event.source);
      const key = `${kind}:${index}`;
      if (index >= 0 && !ready.has(key)) {
        ready.set(key, performance.now());
      }
    }
  });
  Reflect.set(window, "__readWidgetReadiness", () => ({
    measurement:
      "sandbox resource-loaded notification after the widget document load; not a paint timestamp",
    firstInlineReadyMs: [...ready].find(([key]) => key.startsWith("inline:"))?.[1] ?? null,
    firstBoardReadyMs: [...ready].find(([key]) => key.startsWith("board:"))?.[1] ?? null,
    ready: Object.fromEntries(ready),
  }));
}

function summarizeResponseTasks(raw: unknown[]) {
  const events = raw.map(prepareColdLoadTraceEvent);
  const tasks: Array<{ pid: number; tid: number; start: number; end: number }> = [];
  const stacks = new Map<string, (typeof events)[number][]>();
  const add = (event: (typeof events)[number], end: number) => {
    if (event.name === "RunTask" || event.name === "ThreadControllerImpl::RunTask") {
      tasks.push({ pid: event.pid, tid: event.tid, start: event.ts, end });
    }
  };
  for (const event of events) {
    if (event.ph === "X" && event.dur !== undefined) {
      add(event, event.ts + event.dur);
    } else if (event.ph === "B") {
      const key = `${event.pid}:${event.tid}`;
      const stack = stacks.get(key) ?? [];
      stack.push(event);
      stacks.set(key, stack);
    } else if (event.ph === "E") {
      const begin = stacks.get(`${event.pid}:${event.tid}`)?.pop();
      if (begin) {
        add(begin, event.ts);
      }
    }
  }
  const responses = events.flatMap((event) => {
    const match = /^cold-load-rpc:(\d+):(.+):start$/u.exec(event.name ?? "");
    if (!match) {
      return [];
    }
    const task = tasks
      .filter(
        (candidate) =>
          candidate.pid === event.pid &&
          candidate.tid === event.tid &&
          candidate.start <= event.ts &&
          candidate.end >= event.ts,
      )
      .toSorted((left, right) => left.end - left.start - (right.end - right.start))[0];
    if (!task) {
      throw new Error(`Response mark lacks an enclosing renderer task: ${event.name}`);
    }
    return [
      { rpcIndex: Number(match[1]), method: match[2], taskMs: (task.end - task.start) / 1000 },
    ];
  });
  return {
    measurement:
      "response task including application JSON parse and reconciliation microtasks; excludes later animation-frame rendering",
    responses,
  };
}

type LiveRpc = {
  method: string;
  params: Record<string, unknown>;
  ms: number;
  responseAtMs: number;
  responseBytes: number;
};

function requestedAtMs(rpc: LiveRpc) {
  return rpc.responseAtMs - rpc.ms;
}

function sidebarWindow(params: Record<string, unknown>) {
  if (params.rowMode !== "sidebar" || params.limit !== 200) {
    return null;
  }
  return params.ownerFirst === true
    ? "ownerFirst"
    : params.involvingMe === true
      ? "involvingMe"
      : null;
}

function summarizeSidebarWindows(
  rpcs: LiveRpc[],
  rpcOffset: number,
  reads: ReturnType<ReturnType<typeof createTeamScaleSidebarListOwner>["stats"]>,
  tasks: ReturnType<typeof summarizeResponseTasks>,
  activeStreamMs: number,
  elapsedMs: number,
) {
  return Object.fromEntries(
    (["ownerFirst", "involvingMe"] as const).map((window) => {
      const windowReads = reads.filter((read) => sidebarWindow(read.params) === window);
      const windowRpcs = rpcs
        .map((rpc, index) => ({ ...rpc, rpcIndex: rpcOffset + index }))
        .filter((rpc) => rpc.method === "sessions.list" && sidebarWindow(rpc.params) === window);
      if (windowReads.length !== windowRpcs.length) {
        throw new Error(`Sidebar ${window} response/stat count mismatch`);
      }
      const samples = windowRpcs.map((rpc, index) => {
        const task = tasks.responses.find((response) => response.rpcIndex === rpc.rpcIndex);
        if (!task) {
          throw new Error(`Sidebar response ${rpc.rpcIndex} lacks a task measurement`);
        }
        return Object.assign({}, windowReads[index]!, {
          requestedAtMs: requestedAtMs(rpc),
          responseAtMs: rpc.responseAtMs,
          wireBytes: rpc.responseBytes,
          responseTaskMs: task.taskMs,
        });
      });
      const taskMs = samples.map((sample) => sample.responseTaskMs).toSorted((a, b) => a - b);
      const median = taskMs.length
        ? (taskMs[Math.floor((taskMs.length - 1) / 2)]! + taskMs[Math.floor(taskMs.length / 2)]!) /
          2
        : 0;
      return [
        window,
        {
          reads: samples.length,
          readsPerMinuteObserved: (samples.length * 60_000) / elapsedMs,
          readsPerMinuteNormalizedToActiveStream: (samples.length * 60_000) / activeStreamMs,
          changedRows: samples.reduce((sum, sample) => sum + sample.changedRows, 0),
          rowsSent: samples.reduce((sum, sample) => sum + sample.rowsSent, 0),
          wireBytes: samples.reduce((sum, sample) => sum + sample.wireBytes, 0),
          responseTaskMs: { sum: taskMs.reduce((sum, value) => sum + value, 0), median },
          samples,
        },
      ];
    }),
  );
}

const { values } = parseArgs({
  options: {
    "warm-reload": { type: "boolean", default: false },
    "overlay-probe": { type: "boolean", default: false },
    untraced: { type: "boolean", default: false },
    "probe-dir": { type: "string" },
    "live-events": { type: "boolean", default: false },
    "streaming-reply": { type: "boolean", default: false },
    "init-script": { type: "string", multiple: true, default: [] },
    "sidebar-list-churn": { type: "boolean", default: false },
    "sidebar-live-churn": { type: "boolean", default: false },
    "session-event-churn": { type: "boolean", default: false },
    "duplicate-boot-reads": { type: "boolean", default: false },
    "capture-ms": { type: "string", default: "0" },
    "sidebar-row-transfer": { type: "string", default: "full" },
    "bundle-dir": { type: "string" },
    runs: { type: "string", default: "3" },
    "latency-ms": { type: "string", default: "35" },
    "frame-gap-ms": { type: "string", default: "4" },
    "sidebar-view": { type: "string", default: "sessions" },
    output: { type: "string", default: ".artifacts/control-ui-cold-load" },
  },
});
if (values["streaming-reply"] && values["live-events"]) {
  throw new Error("streaming-reply measures an isolated answer; do not combine with live-events");
}
if (values["warm-reload"] && !values["probe-dir"]) {
  throw new Error("warm-reload requires probe-dir with LoAF/mutation and RPC census init scripts");
}
if (values["sidebar-list-churn"] && !values["live-events"]) {
  throw new Error("sidebar-list-churn requires live-events");
}
if (values["sidebar-list-churn"] && values.untraced) {
  throw new Error("sidebar-list-churn requires tracing for response task attribution");
}
if (values["sidebar-live-churn"] && (!values["live-events"] || values["sidebar-list-churn"])) {
  throw new Error("sidebar-live-churn requires live-events and excludes sidebar-list-churn");
}
const sidebarRowTransfer = values["sidebar-row-transfer"];
if (!["full", "delta", "interleaved"].includes(sidebarRowTransfer)) {
  throw new Error("Expected sidebar-row-transfer full, delta or interleaved");
}
if (!values["sidebar-list-churn"] && sidebarRowTransfer !== "full") {
  throw new Error("sidebar-row-transfer requires sidebar-list-churn");
}
const sidebarView = values["sidebar-view"];
if (sidebarView !== "sessions" && sidebarView !== "online") {
  throw new Error("Expected sidebar-view sessions or online");
}
const runs = Number(values.runs);
const latencyMs = Number(values["latency-ms"]);
const frameGapMs = Number(values["frame-gap-ms"]);
const captureMs = Number(values["capture-ms"]);
if (
  !Number.isInteger(runs) ||
  runs < 1 ||
  runs > 20 ||
  !Number.isFinite(latencyMs) ||
  latencyMs < 0 ||
  !Number.isFinite(frameGapMs) ||
  frameGapMs < 0 ||
  !Number.isFinite(captureMs) ||
  captureMs < 0
) {
  throw new Error("Expected 1–20 runs and nonnegative finite wire delays and capture duration");
}
if (sidebarRowTransfer === "interleaved" && (runs < 14 || runs % 2 !== 0)) {
  throw new Error("Interleaved sidebar transfer requires an even run count of at least 14");
}
const artifactDir = path.resolve(values.output, new Date().toISOString().replaceAll(":", "-"));
await mkdir(artifactDir, { recursive: true });
const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" });
const bundleDir = values["bundle-dir"]
  ? path.resolve(values["bundle-dir"])
  : path.join(artifactDir, "ui");
const server = values["bundle-dir"]
  ? await startBuiltControlUiE2eServer(bundleDir)
  : await startProductionControlUiE2eServer(bundleDir, head);
const sandbox = createSandboxHostHttpServer();
await new Promise<void>((resolve, reject) => {
  sandbox.once("error", reject);
  sandbox.listen(0, "127.0.0.1", resolve);
});
const address = sandbox.address();
if (!address || typeof address === "string") {
  throw new Error("Sandbox did not bind");
}
const fixture = createControlUiTeamScaleFixture({
  baseUrl: server.baseUrl,
  sandboxUrl: buildSandboxHostPath({ blockDescendantFrames: true }),
  sandboxPort: address.port,
  liveRun: values["live-events"] || values["streaming-reply"],
  sidebarListChurn: values["sidebar-list-churn"],
  sidebarLiveChurn: values["sidebar-live-churn"],
  sessionEventChurn: values["session-event-churn"],
  duplicateBootReads: values["duplicate-boot-reads"],
});
const streamingReply = values["streaming-reply"] ? createControlUiStreamingReply() : undefined;
const extraInitScripts = await Promise.all(
  values["init-script"].map((file) => readFile(file, "utf8")),
);
let sidebarLists = fixture.sidebarListChurn
  ? createTeamScaleSidebarListOwner(fixture.sidebarListChurn)
  : undefined;
let runTransfer: "full" | "delta" = sidebarRowTransfer === "delta" ? "delta" : "full";
let browser: Browser | undefined;
const results = [];
try {
  const prepared = await prepareControlUiMockGatewayScenario({
    ...fixture.scenario,
    serverBuildId: head,
    serverVersion: JSON.parse(await readFile("package.json", "utf8")).version,
  });
  browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    headless: true,
  });
  const context = await browser.newContext({
    viewport: { width: 1719, height: 1179 },
    serviceWorkers: "block",
    permissions: ["local-network-access"],
  });
  const page = await context.newPage();
  const rigProbeScript = values["probe-dir"]
    ? (
        await Promise.all(
          ["mutattr.init.js", "loaf-mutation.init.js", "ws-rpc-census.init.js"].map((filename) =>
            readFile(path.resolve(values["probe-dir"]!, filename), "utf8"),
          ),
        )
      ).join("\n") + `\nwindow.__readColdLoadRigProbes = ${readRigProbeSnapshot.toString()};`
    : "";
  if (fixture.sidebarListChurn) {
    await context.exposeBinding("__teamScaleList", (_source, params: Record<string, unknown>) => {
      const { result, previousRows } = sidebarLists!.list(params);
      const response =
        params.rowMode === "sidebar"
          ? {
              ...result,
              ...shareSidebarSessionRows(
                result.sessions,
                typeof params.ifRowsRevision === "string" ? params.ifRowsRevision : undefined,
                runTransfer === "delta" ? previousRows : undefined,
              ),
            }
          : result;
      sidebarLists!.recordWire(response);
      return response;
    });
    await context.exposeBinding(
      "__teamScaleMutate",
      (
        _source,
        mutation: Parameters<ReturnType<typeof createTeamScaleSidebarListOwner>["apply"]>[0],
      ) => sidebarLists!.apply(mutation),
    );
  }
  const errors: string[] = [];
  const harnessWarnings: string[] = [];
  page.on("pageerror", (error) => {
    // Playwright's serviceWorkers:block init script also runs in opaque sandbox frames.
    if (
      error.name === "SecurityError" &&
      error.message ===
        "Failed to read the 'serviceWorker' property from 'Navigator': Service worker is disabled because the context is sandboxed and lacks the 'allow-same-origin' flag." &&
      error.stack?.includes("at <anonymous>:3:15")
    ) {
      harnessWarnings.push(error.message);
    } else {
      errors.push(error.stack ?? error.message);
    }
  });
  await page.route("**/control-ui-config.json", (route) =>
    route.fulfill({ json: createControlUiMockBootstrapConfig(prepared.scenario) }),
  );
  const assets = new Map<string, { body: string | Buffer; contentType: string }>([
    ...fixture.assets,
    ...prepared.assets,
  ]);
  await page.route("**/__openclaw__/**", (route) => {
    const asset = assets.get(new URL(route.request().url()).pathname);
    return asset ? route.fulfill({ status: 200, ...asset }) : route.fallback();
  });
  if (values["duplicate-boot-reads"]) {
    await page.route("**/api/chat/media/outgoing/**", (route) => {
      const asset = assets.get(new URL(route.request().url()).pathname);
      return asset ? route.fulfill({ status: 200, ...asset }) : route.fallback();
    });
  }
  if (values["sidebar-live-churn"]) {
    await page.route("**/api/users/*/avatar?*", async (route) => {
      const asset = fixture.assets.get(new URL(route.request().url()).pathname);
      if (!asset) {
        return route.fallback();
      }
      const { delayMs, ...response } = asset;
      if (delayMs) {
        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      return route.fulfill(response);
    });
  }
  await page.addInitScript(
    ({ key, pins }) => {
      if (window !== window.top) {
        return;
      }
      if (!localStorage.getItem(key)) {
        localStorage.setItem(
          key,
          JSON.stringify({
            sidebarAgentsMode: "roster",
            railShortcuts: pins,
            navigationByProfile: { "team-person-001": { railShortcuts: pins } },
          }),
        );
      }
    },
    {
      key: controlUiBundledSettingsStorageKey(server.baseUrl),
      pins: fixture.sidebarEntries,
    },
  );
  const warmProbes = values["warm-reload"] ? `\n(${warmReloadProbe.toString()})();` : "";
  await page.addInitScript({
    content: `;(() => { if (window !== window.top) return; const __name = (fn) => fn; (${installWidgetReadiness.toString()})(); ${createControlUiMockGatewayInitScript(prepared.scenario)}\n${rigProbeScript}\n${fixture.sidebarListChurn ? `window.__teamScaleSidebarLists = { apply: (mutation) => window.__teamScaleMutate(mutation) }; window.openclawControlUiE2eGateway.setRequestHandler("sessions.list", async ({ params, respond }) => respond(await window.__teamScaleList(params)));` : ""}\n${createColdLoadProbeInitScript({ latencyMs, frameGapMs, events: fixture.events, liveEvents: fixture.liveEvents, liveHistory: fixture.liveHistory, ownerProbes: !values["session-event-churn"] })}\n${streamingReply ? createStreamingReplyProbeInitScript() : ""}\n${extraInitScripts.join("\n")}\n${warmProbes} })();`,
  });
  const url = controlUiSessionUrl(server.baseUrl, fixture.selectedSessionKey, "dashboard");
  async function settle() {
    try {
      await page
        .locator(".chat-pane__session-title-text", { hasText: "Project dashboard 1" })
        .waitFor();
      await page
        .locator('.sidebar-rail [data-sidebar-entry^="session:"]')
        .nth(29)
        .waitFor({ state: "attached" });
      await page.locator('[data-sidebar-entry="plugin:team-scale-6/overview"]').waitFor();
      if (sidebarView === "online") {
        await page.locator('[data-online-user-id="team-person-120"]').waitFor();
      }
      await page
        .frameLocator(".board-widget__frame")
        .frameLocator("iframe")
        .getByText("Team metric 1", { exact: true })
        .waitFor();
      await page
        .frameLocator(".chat-tool-card__preview-frame")
        .last()
        .frameLocator("iframe")
        .getByText("Team metric 12", { exact: true })
        .waitFor();
      await page.waitForFunction(() => {
        const ready = Reflect.get(window, "__readWidgetReadiness")();
        return ready.firstBoardReadyMs !== null;
      });
      await page.waitForFunction(
        (eventCount) => {
          const state = Reflect.get(window, "__coldLoad")?.read();
          return (
            state &&
            state.sentEvents === eventCount &&
            !state.pending &&
            !state.queued &&
            state.idleMs > 750
          );
        },
        fixture.events.length,
        { timeout: 30_000 },
      );
    } catch (error) {
      const diagnostics = await page.evaluate(() => Reflect.get(window, "__coldLoad")?.read());
      await writeFile(
        path.join(artifactDir, "failure.json"),
        JSON.stringify({ diagnostics, errors }, null, 2),
      );
      await page.screenshot({ path: path.join(artifactDir, "failure.png") });
      console.error(JSON.stringify({ diagnostics, errors }));
      throw error;
    }
  }
  await page.goto(url);
  try {
    await page.locator("#sidebar-session-owner-title").click();
    await page
      .locator(
        `.sidebar-session-owner-filter [role="option"][data-value="${values["sidebar-list-churn"] ? "involving-me" : "all"}"]`,
      )
      .click();
  } catch (error) {
    await writeFile(
      path.join(artifactDir, "setup-failure.json"),
      JSON.stringify({
        errors,
        sidebar: await page.locator("openclaw-app-sidebar").textContent(),
        diagnostics: await page.evaluate(() => Reflect.get(window, "__coldLoad")?.read()),
      }),
    );
    await page.screenshot({ path: path.join(artifactDir, "setup-failure.png") });
    throw error;
  }
  if (sidebarView === "online") {
    await page.locator('[data-navigation-view="online"]').click();
  }
  await settle();
  await page.locator('aside.sidebar[data-snapshot-saved="true"]').waitFor();
  for (let run = 0; run < runs; run++) {
    if (values["warm-reload"]) {
      await page.locator(".chat-pane-cache__pane--active").evaluate(async (element, sessionKey) => {
        const store = Reflect.get(element, "sessionSnapshotStore");
        if (!store) {
          throw new Error("Missing transcript snapshot owner");
        }
        await store.flush();
        const request = indexedDB.open("openclaw-chat-snapshots");
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          request.addEventListener("success", () => resolve(request.result), { once: true });
          request.addEventListener(
            "error",
            () => reject(new Error("Cannot open transcript cache", { cause: request.error })),
            { once: true },
          );
        });
        try {
          const read = database.transaction("snapshots").objectStore("snapshots").getAll();
          const snapshots = await new Promise<unknown[]>((resolve, reject) => {
            read.addEventListener("success", () => resolve(read.result), { once: true });
            read.addEventListener(
              "error",
              () => reject(new Error("Cannot read transcript cache", { cause: read.error })),
              { once: true },
            );
          });
          if (
            !snapshots.some((value) => {
              const key =
                typeof value === "object" && value !== null
                  ? Reflect.get(value, "sessionKey")
                  : undefined;
              return typeof key === "string" && key.endsWith(`\u0000${sessionKey}`);
            })
          ) {
            throw new Error("Warm reload requires the selected session's persisted transcript");
          }
        } finally {
          database.close();
        }
      }, fixture.selectedSessionKey);
    }
    runTransfer =
      sidebarRowTransfer === "delta" || (sidebarRowTransfer === "interleaved" && run % 2 === 1)
        ? "delta"
        : "full";
    const cdp = await context.newCDPSession(page);
    const rawTrace: unknown[] = [];
    let collectedTrace = rawTrace;
    cdp.on("Tracing.dataCollected", (data) => collectedTrace.push(...data.value));
    if (!values.untraced) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 1000 });
      await cdp.send("Profiler.start");
      await cdp.send("Tracing.start", {
        categories:
          "toplevel,loading,blink.user_timing,devtools.timeline,disabled-by-default-devtools.timeline,disabled-by-default-devtools.timeline.stack,disabled-by-default-devtools.screenshot,v8",
        transferMode: "ReportEvents",
      });
    }
    if (fixture.sidebarListChurn) {
      sidebarLists = createTeamScaleSidebarListOwner(fixture.sidebarListChurn);
    }
    await page.reload({ waitUntil: "domcontentloaded" });
    await settle();
    if (captureMs) {
      await page.waitForFunction((duration) => performance.now() >= duration, captureMs);
    }
    const metrics = await page.evaluate(() => ({
      ...Reflect.get(window, "__coldLoad").read(),
      widgetReadiness: Reflect.get(window, "__readWidgetReadiness")(),
    }));
    const warmReload = values["warm-reload"]
      ? await page.evaluate(() => Reflect.get(window, "__warmReload").read())
      : undefined;
    await writeFile(path.join(artifactDir, `run-${run + 1}.metrics.json`), JSON.stringify(metrics));
    const profile = values.untraced ? undefined : await cdp.send("Profiler.stop");
    if (!values.untraced) {
      const complete = new Promise<void>((resolve) => {
        cdp.once("Tracing.tracingComplete", () => resolve());
      });
      await cdp.send("Tracing.end");
      await complete;
    }
    await page.screenshot({ path: path.join(artifactDir, `run-${run + 1}.png`) });
    await writeFile(
      path.join(artifactDir, `run-${run + 1}.trace.json`),
      JSON.stringify({ traceEvents: rawTrace }),
    );
    if (profile) {
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.cpuprofile`),
        JSON.stringify(profile.profile),
      );
    }
    if (rigProbeScript) {
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.probes.json`),
        JSON.stringify(await page.evaluate(readRigProbeSnapshot)),
      );
    }
    const trace = rawTrace.map(prepareColdLoadTraceEvent);
    const screenshots = trace.flatMap((event) =>
      event.name === "Screenshot" && event.args?.snapshot
        ? [{ ts: event.ts, data: event.args.snapshot }]
        : [],
    );
    if (values["warm-reload"] && screenshots.length) {
      await mkdir(path.join(artifactDir, `run-${run + 1}.filmstrip`));
      for (const [index, frame] of screenshots.entries()) {
        await writeFile(
          path.join(artifactDir, `run-${run + 1}.filmstrip`, `${index}-${frame.ts}.jpg`),
          Buffer.from(frame.data, "base64"),
        );
      }
    }
    const visual = await page.evaluate(async (frames) => {
      const canvas = document.createElement("canvas");
      canvas.width = 344;
      canvas.height = 236;
      const ctx = canvas.getContext("2d")!;
      let previous: DataView | undefined;
      let lastChange: number | undefined;
      let significantFrames = 0;
      let transitionGroups = 0;
      for (const frame of frames) {
        const image = new Image();
        image.src = `data:image/jpeg;base64,${frame.data}`;
        await image.decode();
        ctx.drawImage(image, 0, 0, 344, 236);
        const bytes = ctx.getImageData(0, 0, 344, 236).data;
        const pixels = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (previous) {
          let changed = 0;
          for (let i = 0; i < pixels.byteLength; i += 4) {
            if (
              Math.max(
                Math.abs(pixels.getUint8(i) - previous.getUint8(i)),
                Math.abs(pixels.getUint8(i + 1) - previous.getUint8(i + 1)),
                Math.abs(pixels.getUint8(i + 2) - previous.getUint8(i + 2)),
              ) >= 32
            ) {
              changed++;
            }
          }
          if (changed / (344 * 236) >= 0.004) {
            significantFrames++;
            if (lastChange === undefined || frame.ts - lastChange > 100_000) {
              transitionGroups++;
            }
            lastChange = frame.ts;
          }
        }
        previous = pixels;
      }
      return {
        frames: frames.length,
        significantFrames,
        transitionGroups,
      };
    }, screenshots);
    const mapped = !profile
      ? undefined
      : values["sidebar-list-churn"]
        ? {
            profile: profile.profile,
            mappedFrames: 0,
            unmappedFrames: profile.profile.nodes.length,
          }
        : await mapColdLoadCpuProfile(profile.profile, {
            assetBaseUrl: new URL("assets/", server.baseUrl).href,
            assetDirectory: path.join(bundleDir, "assets"),
          });
    let streaming;
    if (streamingReply) {
      const composer = page.locator(".agent-chat__composer-combobox textarea").last();
      await composer.focus();
      await cdp.send("Performance.enable");
      let previousCpu = (await cdp.send("Performance.getMetrics")).metrics;
      let previousDelivered = 0;
      const cpu: Array<{
        delivered: number;
        deltas: number;
        milliseconds: Record<string, number>;
      }> = [];
      await page.evaluate((input) => Reflect.get(window, "__streamingReply").start(input), {
        ...streamingReply,
        sessionKey: fixture.selectedSessionKey,
        runId: fixture.scenario.inFlightRun!.runId,
      });
      const streamingInput = new AbortController();
      const nativeInput = (async () => {
        while (!streamingInput.signal.aborted) {
          await page.keyboard.press("x");
          await new Promise((resolve) => {
            setTimeout(resolve, 500);
          });
        }
      })();
      try {
        for (let quartile = 1; quartile <= 4; quartile++) {
          await page.waitForFunction(
            (count) => Reflect.get(window, "__streamingReply").read().delivered >= count,
            Math.floor((streamingReply.deltas.length * quartile) / 4),
            { timeout: 60_000 },
          );
          await page.evaluate(
            () =>
              new Promise<void>((resolve) => {
                requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
              }),
          );
          const nextCpu = (await cdp.send("Performance.getMetrics")).metrics;
          const delivered = await page.evaluate(
            () => Reflect.get(window, "__streamingReply").read().delivered,
          );
          cpu.push({
            delivered,
            deltas: delivered - previousDelivered,
            milliseconds: Object.fromEntries(
              ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"].map(
                (name) => [
                  name,
                  1000 *
                    (nextCpu.find((metric) => metric.name === name)!.value -
                      previousCpu.find((metric) => metric.name === name)!.value),
                ],
              ),
            ),
          });
          previousCpu = nextCpu;
          previousDelivered = delivered;
        }
      } finally {
        streamingInput.abort();
        await nativeInput;
      }
      streaming = {
        ...(await page.evaluate(() => Reflect.get(window, "__streamingReply").finish())),
        cpu,
      };
      if (!streaming.finalHtml) {
        throw new Error("Streaming reply produced no visible Markdown");
      }
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.streaming.json`),
        JSON.stringify(
          {
            head,
            chars: streamingReply.text.length,
            deltasPerSecond: streamingReply.deltasPerSecond,
            ...streaming,
          },
          null,
          2,
        ),
      );
      await page.screenshot({ path: path.join(artifactDir, `run-${run + 1}.streaming.png`) });
    }
    let live;
    const readLivePresentation = () =>
      page.evaluate(
        (keys) => {
          const rows = Object.fromEntries(
            keys.map((key) => {
              const row = document.querySelector<HTMLElement>(
                `openclaw-app-sidebar [data-session-key="${key}"]`,
              );
              const rect = row?.getBoundingClientRect();
              return [
                key,
                {
                  attached: Boolean(row),
                  inViewport: Boolean(rect && rect.bottom > 0 && rect.top < innerHeight),
                  text: row?.textContent?.trim() ?? null,
                  classes: row?.className ?? null,
                },
              ];
            }),
          );
          return {
            rows,
            viewers: [...document.querySelectorAll("openclaw-chat-pane [data-viewer-id]")].map(
              (element) => element.getAttribute("data-viewer-id"),
            ),
            streamingText:
              document.querySelector("openclaw-chat-pane .chat-bubble.streaming")?.textContent ??
              null,
          };
        },
        [
          fixture.scenario.sessions![0]!.key,
          fixture.scenario.sessions![119]!.key,
          fixture.scenario.sessions![160]!.key,
          fixture.scenario.sessions![240]!.key,
        ],
      );
    if (values["live-events"]) {
      const before = await readLivePresentation();
      const liveTrace: unknown[] = [];
      collectedTrace = liveTrace;
      if (!values.untraced) {
        await cdp.send("Profiler.start");
        await cdp.send("Tracing.start", {
          categories:
            "toplevel,blink.user_timing,devtools.timeline,disabled-by-default-v8.cpu_profiler",
          transferMode: "ReportEvents",
        });
      }
      const listOffset = sidebarLists?.stats().length ?? 0;
      await page.evaluate((captureProbes) => {
        if (captureProbes) {
          const read = Reflect.get(window, "__readColdLoadRigProbes");
          Reflect.set(window, "__coldLoadRigLiveStart", read());
          setTimeout(() => Reflect.set(window, "__coldLoadRigLateStart", read()), 5_000);
          setTimeout(() => Reflect.set(window, "__coldLoadRigQuietStart", read()), 15_000);
        }
        Reflect.get(window, "__coldLoad").startLive();
      }, Boolean(rigProbeScript));
      await page.waitForFunction(
        (count) => Reflect.get(window, "__coldLoad").readLive().sentEvents === count,
        fixture.liveEvents.length,
        { timeout: 35_000 },
      );
      const plannedWindowMs =
        fixture.liveEvents.at(-1)!.atMs + (values["sidebar-list-churn"] ? 16_000 : 750);
      await page.waitForFunction(
        (windowMs) => Reflect.get(window, "__coldLoad").readLive().elapsedMs >= windowMs,
        plannedWindowMs,
      );
      if (values["sidebar-list-churn"]) {
        try {
          await page.waitForFunction(() => {
            const state = Reflect.get(window, "__coldLoad").read();
            return !state.pending && !state.queued;
          });
        } catch (error) {
          await writeFile(
            path.join(artifactDir, `run-${run + 1}.live-failure.json`),
            JSON.stringify({
              error: String(error),
              metrics: await page.evaluate(() => Reflect.get(window, "__coldLoad").read()),
              live: await page.evaluate(() => Reflect.get(window, "__coldLoad").readLive()),
              sidebarLists: sidebarLists?.stats().slice(listOffset),
            }),
          );
          throw error;
        }
      }
      await page.evaluate(() => Reflect.get(window, "__coldLoad").finishLive());
      if (!values.untraced) {
        const liveProfile = await cdp.send("Profiler.stop");
        await writeFile(
          path.join(artifactDir, `run-${run + 1}.live.cpuprofile`),
          JSON.stringify(liveProfile.profile),
        );
        const liveComplete = new Promise<void>((resolve) => {
          cdp.once("Tracing.tracingComplete", () => resolve());
        });
        await cdp.send("Tracing.end");
        await liveComplete;
      }
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.live.trace.json`),
        JSON.stringify({ traceEvents: liveTrace }),
      );
      const after = await readLivePresentation();
      const liveMetrics = await page.evaluate(() => Reflect.get(window, "__coldLoad").readLive());
      // Independent coordinators drift; pair request starts within half their minimum cooldown.
      const pairedRefreshes = values["sidebar-list-churn"]
        ? liveMetrics.rpcs.filter(
            (rpc: LiveRpc) =>
              rpc.method === "sessions.list" &&
              sidebarWindow(rpc.params) === "ownerFirst" &&
              rpc.params.ifRowsRevision !== undefined &&
              requestedAtMs(rpc) >= 6000 &&
              liveMetrics.rpcs.some(
                (other: LiveRpc) =>
                  other.method === "sessions.list" &&
                  sidebarWindow(other.params) === "involvingMe" &&
                  other.params.ifRowsRevision !== undefined &&
                  Math.abs(requestedAtMs(other) - requestedAtMs(rpc)) < 2500,
              ),
          ).length
        : undefined;
      const activeStreamMs = fixture.liveEvents.at(-1)!.atMs;
      const sidebarReads = sidebarLists?.stats().slice(listOffset);
      const responseTasks = summarizeResponseTasks(liveTrace);
      live = {
        ...liveMetrics,
        head,
        sidebarRowTransfer: values["sidebar-list-churn"] ? runTransfer : undefined,
        sidebarLists: sidebarReads,
        sidebarWindows: sidebarReads
          ? summarizeSidebarWindows(
              liveMetrics.rpcs,
              liveMetrics.rpcOffset,
              sidebarReads,
              responseTasks,
              activeStreamMs,
              liveMetrics.elapsedMs,
            )
          : undefined,
        pairedRefreshes,
        pairingMeasurement:
          "Conditional request starts after six seconds, paired within half the five-second minimum cooldown; response arrival skew is separate.",
        responseTasks,
        activeStreamMs,
        rateMeasurement:
          "Observed rates use the complete capture including drain; active-stream-normalized rates charge trailing coalesced reads to the event stream.",
        plannedWindowMs,
        presentation: { before, after },
        probes: rigProbeScript
          ? await page.evaluate(() => ({
              start: Reflect.get(window, "__coldLoadRigLiveStart"),
              lateStart: Reflect.get(window, "__coldLoadRigLateStart"),
              quietStart: Reflect.get(window, "__coldLoadRigQuietStart"),
              end: Reflect.get(window, "__readColdLoadRigProbes")(),
            }))
          : undefined,
      };
      await page.screenshot({ path: path.join(artifactDir, `run-${run + 1}.live.png`) });
      await writeFile(
        path.join(artifactDir, `run-${run + 1}.live.json`),
        JSON.stringify(live, null, 2),
      );
      if (pairedRefreshes !== undefined && pairedRefreshes < 3) {
        throw new Error(
          `Sidebar churn reproduced ${pairedRefreshes} sustained conditional sidebar pairs; expected at least three`,
        );
      }
    }
    const overlays = values["overlay-probe"]
      ? await probeColdLoadOverlays(page, artifactDir, run)
      : undefined;
    await cdp.detach();
    const result = {
      run: run + 1,
      head,
      sidebarRowTransfer: values["sidebar-list-churn"] ? runTransfer : undefined,
      ...metrics,
      trace: values.untraced ? undefined : summarizeColdLoadTrace(trace, metrics.at),
      cpu: mapped ? summarizeCpuProfile(mapped.profile) : undefined,
      mappedFrames: mapped?.mappedFrames,
      unmappedFrames: mapped?.unmappedFrames,
      harnessWarnings,
      visual,
      live,
      streaming,
      warmReload,
      overlays,
    };
    results.push(result);
    console.log(JSON.stringify(result));
  }
  if (errors.length) {
    throw new Error(`Browser errors: ${errors.join("\n")}`);
  }
  await context.close();
} finally {
  await browser?.close();
  await server.close();
  sandbox.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    sandbox.close((error) => (error ? reject(error) : resolve()));
  });
  await writeFile(
    path.join(artifactDir, "summary.json"),
    JSON.stringify(
      {
        head,
        dirty,
        bundleDir,
        fixture: fixture.counts,
        sidebarView,
        streamingReply: values["streaming-reply"],
        sidebarListChurn: values["sidebar-list-churn"],
        sidebarLiveChurn: fixture.sidebarLiveChurn,
        duplicateBootReads: values["duplicate-boot-reads"],
        traced: !values.untraced,
        sidebarRowTransfer,
        sidebarComparison: values["sidebar-list-churn"]
          ? "Same final client bundle; full/delta wire response A/B using the production presenter and one synthetic query/history owner. This does not measure real Gateway selection, history reset/fallback lifecycle, or server projection CPU. Node IPC is outside the measured application response task."
          : undefined,
        latencyMs,
        frameGapMs,
        captureMs,
        results,
      },
      null,
      2,
    ),
  );
  console.log(`Cold-load artifacts: ${artifactDir}`);
}
