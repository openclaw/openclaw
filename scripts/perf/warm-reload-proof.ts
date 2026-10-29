// Real built Gateway + synthetic durable state; never accepts an arbitrary live URL.
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import type { Browser, CDPSession, Page } from "playwright";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";
import { resolveSandboxHostPort } from "../../src/agents/sandbox-host.js";
import {
  CONTROL_UI_TOKEN_SESSION_KEY_PREFIX,
  DEVICE_AUTH_STORAGE_KEY_PREFIX,
} from "../../src/shared/control-ui-storage.ts";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { freeProofPort, startWarmReloadAdmission } from "./warm-reload-admission.ts";
import { installWarmReloadBrowserProbe, proofRegions } from "./warm-reload-browser-probe.ts";
import { launchWarmReloadBrowser, calibrateWarmReloadPaintHolding } from "./warm-reload-browser.ts";
import { prepareWarmReloadBuild, createWarmReloadComparison } from "./warm-reload-compare.ts";
import { seedWarmReloadFixture } from "./warm-reload-fixture.ts";
import { analyzeReloadFrames, type ReloadFrame } from "./warm-reload-frames.ts";
import { applyWarmReloadPaintAudit } from "./warm-reload-paint-audit.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string", default: ".local/warm-reload-proof" },
    dist: { type: "string", default: "dist" },
    "ui-root": { type: "string" },
    base: { type: "string" },
    candidate: { type: "string" },
    admission: { type: "string", default: "signed-in" },
    reloads: { type: "string", default: "11" },
    sessions: { type: "string", default: "3000" },
    "rtt-ms": { type: "string", default: "80" },
    "capture-ms": { type: "string", default: "8000" },
    route: { type: "string", default: "both" },
    "audit-report": { type: "string" },
    "paint-audit": { type: "string" },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.info(`Usage: node --import ./scripts/tsx.mjs scripts/perf/warm-reload-proof.ts
  --dist dist --ui-root dist/control-ui --output .local/warm-reload-proof
  --admission signed-in|token --base <dist|ref> --candidate <dist|ref>
  --reloads 11 --sessions 3000 --rtt-ms 80 --capture-ms 8000 --route both|chat|dashboard
Creates fresh isolated state and Chromium, records cold + warm reloads, then stops both.
Offline paint audit: --audit-report <report.json> --paint-audit <paint-audit.json>
See scripts/perf/warm-reload-proof.md for metric definitions and limitations.`);
  process.exit(0);
}
if (values["audit-report"] || values["paint-audit"]) {
  if (!values["audit-report"] || !values["paint-audit"]) {
    throw new Error("--audit-report and --paint-audit must be supplied together");
  }
  const audited = await applyWarmReloadPaintAudit(values["audit-report"], values["paint-audit"]);
  const report: { results: Parameters<typeof createWarmReloadComparison>[0] } = JSON.parse(
    await readFile(audited, "utf8"),
  );
  if (report.results.some((result) => result.arm === "base" || result.arm === "candidate")) {
    await createWarmReloadComparison(report.results, path.dirname(audited));
  }
  console.info("Wrote audited-report.json beside the immutable capture report");
  process.exit(0);
}
function integer(raw: string, name: string, min: number, max: number) {
  const number = Number(raw);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`${name} must be an integer in [${min}, ${max}]`);
  }
  return number;
}
const reloads = integer(values.reloads, "--reloads", 0, 100);
const sessions = integer(values.sessions, "--sessions", 2000, 20000);
const rttMs = integer(values["rtt-ms"], "--rtt-ms", 0, 1000);
const captureMs = integer(values["capture-ms"], "--capture-ms", 1000, 60000);
if (!["both", "chat", "dashboard"].includes(values.route)) {
  throw new Error("--route must be both, chat, or dashboard");
}
if (Boolean(values.base) !== Boolean(values.candidate)) {
  throw new Error("--base and --candidate must be supplied together");
}
if (!["signed-in", "token"].includes(values.admission)) {
  throw new Error("--admission must be signed-in or token");
}
const dist = path.resolve(values.dist);
const uiRoot = path.resolve(values["ui-root"] ?? path.join(dist, "control-ui"));
await Promise.all([access(path.join(dist, "entry.js")), access(path.join(uiRoot, "index.html"))]);
const gatewayBuild: unknown = JSON.parse(
  await readFile(path.join(dist, "build-info.json"), "utf8"),
);
const uiIndex = await readFile(path.join(uiRoot, "index.html"));
const buildIdentity = {
  gateway: gatewayBuild,
  uiIndexSha256: createHash("sha256").update(uiIndex).digest("hex"),
};
const directory = createControlUiE2eArtifactDir("warm-reload", values.output);
const stateDir = path.join(directory, "state");
const viewport = { width: 1720, height: 1180 };
const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();

async function waitForGateway(url: string, child: ChildProcess) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("Owned Gateway exited during startup; inspect gateway.log");
    }
    try {
      const response = await fetch(`${url}/readyz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        return;
      }
    } catch {
      // Startup readiness is outside the measured navigation interval.
    }
    await delay(250);
  }
  throw new Error("Owned Gateway did not become healthy; inspect gateway.log");
}

async function readProbe(page: Page) {
  return await page.evaluate(() => {
    const data: NonNullable<ReturnType<typeof installWarmReloadBrowserProbe>> = Reflect.get(
      window,
      "__warmReloadProof",
    );
    data.stopped = true;
    return { ...data, timeOrigin: performance.timeOrigin, capturedUntilMs: performance.now() };
  });
}
async function regionBoxes(page: Page) {
  return await page.evaluate((selectors) => {
    return Object.entries(selectors).flatMap(([name, selector]) => {
      const elements = [...document.querySelectorAll(selector)];
      const boxes = elements
        .map((element) => element.getBoundingClientRect())
        .filter(
          (box) =>
            box.width > 0 &&
            box.height > 0 &&
            box.right > 0 &&
            box.bottom > 0 &&
            box.x < innerWidth &&
            box.y < innerHeight,
        );
      if (!boxes.length) {
        return [];
      }
      const x = Math.max(0, Math.min(...boxes.map((box) => box.x)));
      const y = Math.max(0, Math.min(...boxes.map((box) => box.y)));
      return [
        {
          name,
          x,
          y,
          width: Math.min(innerWidth, Math.max(...boxes.map((box) => box.right))) - x,
          height: Math.min(innerHeight, Math.max(...boxes.map((box) => box.bottom))) - y,
        },
      ];
    });
  }, proofRegions);
}

async function readWarmCache(page: Page, sessionKey: string) {
  return await page.evaluate(async (key) => {
    // Inspect the existing disposable cache; never create or populate a database for proof.
    const name = "openclaw-chat-snapshots";
    if (!(await indexedDB.databases()).some((database) => database.name === name)) {
      return { targetSnapshots: 0, snapshots: 0, sidebarSnapshots: 0 };
    }
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.addEventListener("success", () => resolve(request.result), { once: true });
      request.addEventListener(
        "error",
        () => reject(new Error("Unable to open snapshot cache", { cause: request.error })),
        { once: true },
      );
    });
    try {
      const readKeys = (store: string) =>
        new Promise<IDBValidKey[]>((resolve, reject) => {
          const request = database.transaction(store, "readonly").objectStore(store).getAllKeys();
          request.addEventListener("success", () => resolve(request.result), { once: true });
          request.addEventListener(
            "error",
            () => reject(new Error("Unable to read snapshot cache", { cause: request.error })),
            { once: true },
          );
        });
      const snapshots = await readKeys("snapshots");
      const sidebar = await readKeys("sidebarSnapshots");
      const targetKeys = snapshots.filter(
        (value) =>
          typeof value === "string" &&
          value.startsWith("scope:[") &&
          value.endsWith(`\u0000${key}`),
      );
      const targetRecords = await Promise.all(
        targetKeys.map(
          (value) =>
            new Promise<unknown>((resolve, reject) => {
              const request = database
                .transaction("snapshots", "readonly")
                .objectStore("snapshots")
                .get(value);
              request.addEventListener("success", () => resolve(request.result), { once: true });
              request.addEventListener(
                "error",
                () => reject(new Error("Unable to read warm snapshot", { cause: request.error })),
                { once: true },
              );
            }),
        ),
      );
      return {
        targetSnapshots: targetKeys.length,
        targetSnapshotBytes: targetRecords.reduce<number>(
          (bytes, value) => bytes + new TextEncoder().encode(JSON.stringify(value)).length,
          0,
        ),
        snapshots: snapshots.length,
        sidebarSnapshots: sidebar.length,
      };
    } finally {
      database.close();
    }
  }, sessionKey);
}

type WireFrame = { file: string; epochMs: number; clockSource: "surface" | "arrival" };
async function captureReload(
  page: Page,
  cdp: CDPSession,
  url: string,
  outputDir: string,
  warm: boolean,
  route: string,
) {
  await mkdir(outputDir, { recursive: true });
  const oldAnimationSample = warm
    ? await page.evaluate(() => {
        const data: ReturnType<typeof installWarmReloadBrowserProbe> = Reflect.get(
          window,
          "__warmReloadProof",
        );
        return data?.animationSamples.at(-1) ?? { atMs: 0, animations: [] };
      })
    : null;
  const frames: WireFrame[] = [];
  let initialFrameReady: (() => void) | undefined;
  const initialFrame = new Promise<void>((resolve) => {
    initialFrameReady = resolve;
  });
  const writes: Promise<void>[] = [];
  const errors: string[] = [];
  const tree: { frameTree: { frame: { id: string } } } = await cdp.send("Page.getFrameTree");
  const documents: Array<{ path: string; epochMs: number; monotonicMs: number; loaderId: string }> =
    [];
  type DocumentRequest = Parameters<Parameters<typeof cdp.on<"Network.requestWillBeSent">>[1]>[0];
  const onDocument = (event: DocumentRequest) => {
    if (event.type === "Document" && event.frameId === tree.frameTree.frame.id) {
      documents.push({
        path: new URL(event.request.url).pathname,
        epochMs: event.wallTime * 1000,
        monotonicMs: event.timestamp * 1000,
        loaderId: event.loaderId,
      });
    }
  };
  const paints: Array<{ name: string; monotonicMs: number; loaderId: string }> = [];
  const onLifecycle = (event: {
    frameId: string;
    name: string;
    timestamp: number;
    loaderId: string;
  }) => {
    if (event.frameId === tree.frameTree.frame.id && event.name === "firstContentfulPaint") {
      paints.push({
        name: event.name,
        monotonicMs: event.timestamp * 1000,
        loaderId: event.loaderId,
      });
    }
  };
  const http: Array<{ url: string; status: number; type: string; atMs: number }> = [];
  const requests = new Map<string, { method: string; atMs: number; bytes: number }>();
  const rpc: Array<{
    method: string;
    atMs: number;
    responseAtMs?: number;
    bytes: number;
    responseBytes?: number;
  }> = [];
  const onFrame = (event: {
    data: string;
    sessionId: number;
    metadata: { timestamp?: number };
  }) => {
    const file = path.join(outputDir, `frame-${String(frames.length).padStart(5, "0")}.png`);
    const timestamp = event.metadata.timestamp;
    frames.push({
      file,
      epochMs:
        timestamp !== undefined && Number.isFinite(timestamp) ? timestamp * 1000 : Date.now(),
      clockSource: timestamp !== undefined && Number.isFinite(timestamp) ? "surface" : "arrival",
    });
    writes.push(writeFile(file, Buffer.from(event.data, "base64")));
    initialFrameReady?.();
    initialFrameReady = undefined;
    writes.push(cdp.send("Page.screencastFrameAck", { sessionId: event.sessionId }).then(() => {}));
  };
  const onError = (error: Error) => errors.push(error.message);
  const onHttp = (event: { type: string; response: { url: string; status: number } }) => {
    if (event.response.url.startsWith("http")) {
      http.push({
        url: event.response.url,
        status: event.response.status,
        type: event.type,
        atMs: Date.now(),
      });
    }
  };
  const onSent = (event: { response: { payloadData: string } }) => {
    const frame: { type?: string; id?: string; method?: string } = JSON.parse(
      event.response.payloadData,
    );
    if (frame.type === "req" && frame.id && frame.method) {
      const row = {
        method: frame.method,
        atMs: Date.now(),
        bytes: Buffer.byteLength(event.response.payloadData),
      };
      requests.set(frame.id, row);
      rpc.push(row);
    }
  };
  const onReceived = (event: { response: { payloadData: string } }) => {
    const frame: { type?: string; id?: string } = JSON.parse(event.response.payloadData);
    const row = frame.id ? requests.get(frame.id) : undefined;
    if (frame.type === "res" && row) {
      Object.assign(row, {
        responseAtMs: Date.now(),
        responseBytes: Buffer.byteLength(event.response.payloadData),
      });
    }
  };
  cdp.on("Page.screencastFrame", onFrame);
  cdp.on("Network.requestWillBeSent", onDocument);
  cdp.on("Page.lifecycleEvent", onLifecycle);
  cdp.on("Network.responseReceived", onHttp);
  cdp.on("Network.webSocketFrameSent", onSent);
  cdp.on("Network.webSocketFrameReceived", onReceived);
  page.on("pageerror", onError);
  try {
    await cdp.send("Page.startScreencast", {
      format: "png",
      maxWidth: viewport.width,
      maxHeight: viewport.height,
      everyNthFrame: 1,
    });
    await Promise.race([
      initialFrame,
      delay(10000, undefined, { ref: false }).then(() => {
        throw new Error("No pre-navigation compositor frame received");
      }),
    ]);
    const priorSurface = frames.at(-1)!;
    if (warm) {
      await page.reload({ waitUntil: "domcontentloaded" });
    } else {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    }
    // Fixed observation windows are the measured workload, not test synchronization.
    await page.waitForFunction((duration) => performance.now() >= duration, captureMs, {
      timeout: captureMs + 60000,
    });
    const probe = await readProbe(page);
    const finalDocumentTimeOrigin = probe.timeOrigin;
    const navigationOrigin = documents[0]?.epochMs ?? finalDocumentTimeOrigin;
    const documentOffsetMs = finalDocumentTimeOrigin - navigationOrigin;
    for (const key of [
      "firstAppDomMs",
      "firstMainDomMs",
      "firstDashboardContentDomMs",
      "firstPaintedRowsMs",
      "finalRowsDomMs",
      "helloPublishedMs",
      "helloHandledMs",
      "fcpMs",
    ] as const) {
      const value = probe[key];
      if (value !== null) {
        probe[key] = value + documentOffsetMs;
      }
    }
    for (const entry of [
      ...probe.loaf,
      ...probe.shifts,
      ...probe.domStates,
      ...probe.animationSamples,
    ]) {
      entry.atMs += documentOffsetMs;
    }
    probe.capturedUntilMs += documentOffsetMs;
    probe.timeOrigin = navigationOrigin;
    const initialPaint = paints.find(
      (paint) =>
        documents.some((document) => document.loaderId === paint.loaderId) &&
        paint.monotonicMs >= (documents[0]?.monotonicMs ?? 0),
    );
    if (initialPaint && documents[0]) {
      probe.fcpMs = initialPaint.monotonicMs - documents[0].monotonicMs;
    }
    for (const response of http) {
      response.atMs -= probe.timeOrigin;
    }
    for (const request of rpc) {
      request.atMs -= probe.timeOrigin;
      if (request.responseAtMs !== undefined) {
        request.responseAtMs -= probe.timeOrigin;
      }
    }
    const regions = await regionBoxes(page);
    const requiredRegions = [
      "sidebar",
      "header",
      "transcript",
      "composer",
      ...(warm && route === "chat" ? ["details"] : []),
      ...(route === "dashboard" ? ["dashboard"] : []),
    ];
    const missingRegions = requiredRegions.filter(
      (name) => !regions.some((region) => region.name === name),
    );
    await page.screenshot({ path: path.join(outputDir, "final.png") });
    await cdp.send("Page.stopScreencast");
    await Promise.all(writes);
    const ordered: ReloadFrame[] = frames
      .map((frame) => ({ file: frame.file, atMs: frame.epochMs - probe.timeOrigin }))
      .filter((frame) => frame.atMs >= 0);
    await writeFile(
      path.join(outputDir, "frames.json"),
      JSON.stringify({ frames, navigationTimeOrigin: probe.timeOrigin }, null, 2),
    );
    if (frames.some((frame) => frame.clockSource !== "surface")) {
      throw new Error(
        `Capture lacks compositor timestamps; arrival clocks are retained only for diagnosis, not measurement. Inspect ${outputDir}/frames.json`,
      );
    }
    if (!ordered.length || !probe.helloHandledMs || !probe.firstMainDomMs) {
      throw new Error(
        `Incomplete capture: ${JSON.stringify({ frames: ordered.length, probe, errors })}`,
      );
    }
    const priorSurfaceAtMs = priorSurface.epochMs - probe.timeOrigin;
    const oldPage = warm
      ? {
          frame: path.basename(priorSurface.file),
          observedAtMs: priorSurfaceAtMs,
          carriedFromMs: 0,
          method:
            "Last compositor surface observed before navigation, carried until the next delivered surface. No inferred display-vsync samples.",
        }
      : null;
    const displayFrames =
      warm && priorSurfaceAtMs < 0 ? [{ file: priorSurface.file, atMs: 0 }, ...ordered] : ordered;
    const visual = await analyzeReloadFrames({
      frames: displayFrames,
      animationSamples: [
        ...(oldAnimationSample ? [{ ...oldAnimationSample, atMs: 0 }] : []),
        ...probe.animationSamples,
      ],
      regions,
      masks: probe.masks,
      outputDir,
    });
    const candidateFrameAfter = (atMs: number | null) =>
      atMs === null
        ? null
        : (ordered.find((frame) => frame.atMs >= Math.max(atMs, probe.fcpMs ?? 0))?.atMs ?? null);
    if (values.admission === "signed-in" && documents.length !== 1) {
      throw new Error(
        `Signed-in admission must yield one top-level document; saw ${documents.length}. Inspect ${outputDir}`,
      );
    }
    const report = {
      warm,
      oldPage: oldPage
        ? {
            ...oldPage,
            firstDifferentObservedFrameMs:
              visual.timeline.find((entry) => entry.stateId !== 0)?.atMs ?? null,
            scope:
              "Headless compositor surface continuity; not OS display capture or proof of every vsync",
          }
        : null,
      url: new URL(url).pathname,
      probe,
      firstAppCandidateFrameMs: candidateFrameAfter(probe.firstAppDomMs),
      firstMainCandidateFrameMs: candidateFrameAfter(probe.firstMainDomMs),
      firstDashboardCandidateFrameMs: candidateFrameAfter(probe.firstDashboardContentDomMs),
      paintMilestoneMethod: "DOM-correlated candidates; first visible paint requires a pixel audit",
      regions,
      visual,
      missingRegions,
      unmountedRegions: Object.keys(proofRegions).filter(
        (name) => !regions.some((region) => region.name === name),
      ),
      documents,
      paints,
      finalDocumentTimeOrigin,
      documentOffsetMs,
      performanceEntryScope:
        "LoAF and CLS cover the final app document; paint lifecycle and pixels include prior documents",
      observationCensored:
        visual.lastVisualChangeMs !== null &&
        probe.capturedUntilMs - visual.lastVisualChangeMs < 1000,
      rpc,
      http,
      errors,
      outputDir,
    };
    await writeFile(path.join(outputDir, "reload.json"), JSON.stringify(report, null, 2));
    if (missingRegions.length) {
      throw new Error(
        `Missing required final regions: ${missingRegions.join(", ")}; inspect ${outputDir}`,
      );
    }
    console.info(
      JSON.stringify({
        reload: outputDir,
        helloHandledMs: probe.helloHandledMs,
        firstMainCandidateFrameMs: report.firstMainCandidateFrameMs,
        cls: probe.cls,
      }),
    );
    return report;
  } finally {
    await cdp.send("Page.stopScreencast").catch(() => {});
    cdp.off("Page.screencastFrame", onFrame);
    cdp.off("Network.requestWillBeSent", onDocument);
    cdp.off("Page.lifecycleEvent", onLifecycle);
    cdp.off("Network.responseReceived", onHttp);
    cdp.off("Network.webSocketFrameSent", onSent);
    cdp.off("Network.webSocketFrameReceived", onReceived);
    page.off("pageerror", onError);
    await Promise.allSettled(writes);
  }
}

let gateway: ChildProcess | undefined;
let browser: Browser | undefined;
let browserConfiguration:
  | Awaited<ReturnType<typeof launchWarmReloadBrowser>>["configuration"]
  | undefined;
let paintHoldingCalibration:
  | Awaited<ReturnType<typeof calibrateWarmReloadPaintHolding>>
  | undefined;
let fixture: Awaited<ReturnType<typeof seedWarmReloadFixture>> | undefined;
let admission: Awaited<ReturnType<typeof startWarmReloadAdmission>> | undefined;
const builds = new Map<string, Awaited<ReturnType<typeof prepareWarmReloadBuild>>>();
let quietHost: { intervalMs: number; cpuIdlePercent: number; load: number[] } | undefined;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  process.exitCode = 130;
  void browser?.close().catch(() => {});
  gateway?.kill("SIGTERM");
};
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const port = await freeProofPort([], true);
// HTML boards bind this second native listener lazily after the Gateway starts.
const gatewayPorts = [port, resolveSandboxHostPort(port)];
let baseUrl = `http://127.0.0.1:${port}`;
const results: Array<{
  arm: string;
  route: "chat" | "dashboard";
  coldReset: unknown;
  warmCache: Awaited<ReturnType<typeof readWarmCache>> | null;
  runs: Array<Awaited<ReturnType<typeof captureReload>>>;
}> = [];
try {
  const arms: Array<{
    name: string;
    build: Awaited<ReturnType<typeof prepareWarmReloadBuild>>;
    directory: string;
  }> = [];
  for (const [name, input] of values.base && values.candidate
    ? [
        ["base", values.base],
        ["candidate", values.candidate],
      ]
    : [["single", uiRoot]]) {
    let build = builds.get(input!);
    if (!build) {
      build = await prepareWarmReloadBuild(input!, { directory, label: name! });
      builds.set(input!, build);
    }
    arms.push({
      name: name!,
      build,
      directory: values.base ? path.join(directory, name!) : directory,
    });
  }
  if (values.admission === "signed-in") {
    admission = await startWarmReloadAdmission({
      gatewayPort: port,
      port: await freeProofPort(gatewayPorts),
    });
    baseUrl = admission.origin;
  }
  const servedUiRoot = path.join(directory, "served-ui");
  fixture = await seedWarmReloadFixture({
    stateDir,
    port,
    uiRoot: servedUiRoot,
    sessions,
    ...(admission
      ? {
          admission: {
            origin: admission.origin,
            gatewayAuth: admission.gatewayAuth,
            viewerEmail: admission.viewerEmail,
            peerSessions: admission.peerSessions,
          },
        }
      : {}),
  });
  const runCli = async (args: string[]) => {
    const result = await promisify(execFile)(
      process.execPath,
      [path.join(dist, "entry.js"), ...args],
      {
        cwd: fixture!.workspaceDir,
        env: fixture!.env,
        timeout: 120000,
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    const value: unknown = JSON.parse(result.stdout);
    return value;
  };
  let activeUiRoot: string | undefined;
  const activate = async (arm: (typeof arms)[number]) => {
    if (interrupted) {
      throw new Error("Proof interrupted");
    }
    if (activeUiRoot === arm.build.uiRoot) {
      return;
    }
    // Configured custom roots deliberately do not retain asset bytes. Swap only
    // this tool's copied root while browser pages are frozen; keep Gateway caches warm.
    const stage = path.join(directory, "next-ui");
    await cp(arm.build.uiRoot, stage, { recursive: true });
    if (activeUiRoot) {
      await rename(servedUiRoot, path.join(directory, "previous-ui"));
    }
    await rename(stage, servedUiRoot);
    if (activeUiRoot) {
      await rm(path.join(directory, "previous-ui"), { recursive: true });
    }
    activeUiRoot = arm.build.uiRoot;
    if (gateway) {
      return;
    }
    const log = createWriteStream(path.join(directory, "gateway.log"), { flags: "a" });
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
        cwd: fixture!.workspaceDir,
        env: fixture!.env,
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    gateway.stdout?.pipe(log);
    gateway.stderr?.pipe(log);
    gateway.once("close", () => log.end());
    gateway.once("error", (error) => console.error("Gateway spawn failed:", error.message));
    await waitForGateway(`http://127.0.0.1:${port}`, gateway);
  };
  await activate(arms[0]!);
  await fixture.prepareGateway((method, params) =>
    runCli(["gateway", "call", method, "--json", "--params", JSON.stringify(params)]),
  );
  const launched = await launchWarmReloadBrowser();
  browser = launched.browser;
  browserConfiguration = launched.configuration;
  if (admission) {
    // Pause peer JavaScript without hiding the pages, which would clear their viewer declarations.
    for (const peer of admission.peerSessions) {
      for (const routePath of [fixture.chatPath, fixture.dashboardPath]) {
        const context = await browser.newContext({ viewport, colorScheme: "dark" });
        await context.addCookies([peer.cookie]);
        const page = await context.newPage();
        await page.goto(baseUrl);
        await waitForControlUiGatewayReady(page, 60000);
        await page.goto(`${baseUrl}${routePath}`);
        await waitForControlUiGatewayReady(page, 60000);
        await page.locator(".chat-pane__header").first().waitFor({ state: "visible" });
        const cdp = await context.newCDPSession(page);
        await cdp.send("Debugger.enable");
        await cdp.send("Debugger.pause");
      }
    }
  }
  paintHoldingCalibration = await calibrateWarmReloadPaintHolding(browser, {
    port: await freeProofPort(gatewayPorts),
    directory: path.join(directory, "paint-holding-calibration"),
  });
  const cpuBefore = os.cpus().map((cpu) => cpu.times);
  await delay(2000);
  const cpuAfter = os.cpus().map((cpu) => cpu.times);
  const total = (times: typeof cpuBefore) =>
    times.reduce((sum, cpu) => sum + Object.values(cpu).reduce((a, b) => a + b, 0), 0);
  const idle = (times: typeof cpuBefore) => times.reduce((sum, cpu) => sum + cpu.idle, 0);
  quietHost = {
    intervalMs: 2000,
    cpuIdlePercent:
      (100 * (idle(cpuAfter) - idle(cpuBefore))) / (total(cpuAfter) - total(cpuBefore)),
    load: os.loadavg(),
  };
  console.info(JSON.stringify({ quietHost }));
  for (const [route, routePath] of [
    ["chat", fixture.chatPath],
    ["dashboard", fixture.dashboardPath],
  ] as const) {
    if (values.route !== "both" && values.route !== route) {
      continue;
    }
    const prepared = [];
    try {
      for (const arm of arms) {
        await activate(arm);
        const context = await browser.newContext({
          viewport,
          deviceScaleFactor: 1,
          colorScheme: "dark",
        });
        let diagnosticPage: Page | undefined;
        try {
          const page = await context.newPage();
          diagnosticPage = page;
          page.setDefaultTimeout(60000);
          await page.addInitScript({
            content: `globalThis.__name = (fn) => fn; (${installWarmReloadBrowserProbe.toString()})(${JSON.stringify(route)});`,
          });
          const cdp = await context.newCDPSession(page);
          await cdp.send("Page.enable");
          await cdp.send("Page.setLifecycleEventsEnabled", { enabled: true });
          await cdp.send("Network.enable");
          await cdp.send("Network.emulateNetworkConditions", {
            offline: false,
            latency: rttMs,
            downloadThroughput: 10 * 1024 * 1024,
            uploadThroughput: 10 * 1024 * 1024,
            connectionType: "wifi",
          });
          if (admission) {
            await context.addCookies([admission.browserCookie]);
            await page.goto(baseUrl);
          } else {
            const handoff = await runCli(["dashboard", "--json"]);
            if (
              !isRecord(handoff) ||
              typeof handoff.browserUrl !== "string" ||
              new URL(handoff.browserUrl).origin !== baseUrl
            ) {
              throw new Error("CLI did not issue a browser handoff for the owned loopback Gateway");
            }
            const handoffUrl = new URL(handoff.browserUrl);
            await page.goto(handoffUrl.href);
          }
          await waitForControlUiGatewayReady(page, 60000);
          await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, {
            timeout: 60000,
          });
          await page.goto(`${baseUrl}/healthz`);
          const coldReset = await page.evaluate(
            ({ devicePrefix, tokenPrefix }) => {
              const localKeys = Object.keys(localStorage).filter(
                (key) => key !== "openclaw-device-identity-v1" && !key.startsWith(devicePrefix),
              );
              const sessionKeys = Object.keys(sessionStorage).filter(
                (key) => !key.startsWith(tokenPrefix),
              );
              localKeys.forEach((key) => localStorage.removeItem(key));
              sessionKeys.forEach((key) => sessionStorage.removeItem(key));
              return {
                localKeys,
                sessionKeys,
                retained: "Signed-in device credentials and installed service worker registration",
              };
            },
            {
              devicePrefix: DEVICE_AUTH_STORAGE_KEY_PREFIX,
              tokenPrefix: CONTROL_UI_TOKEN_SESSION_KEY_PREFIX,
            },
          );
          await cdp.send("Storage.clearDataForOrigin", {
            origin: baseUrl,
            storageTypes: "indexeddb,cache_storage",
          });
          await cdp.send("Network.clearBrowserCache");
          const url = `${baseUrl}${routePath}`;
          results.push({
            arm: arm.name,
            route,
            coldReset,
            warmCache: null as Awaited<ReturnType<typeof readWarmCache>> | null,
            runs: [
              await captureReload(
                page,
                cdp,
                url,
                path.join(arm.directory, route, "cold"),
                false,
                route,
              ),
            ],
          });
          const details = page.locator(".chat-details-toggle:visible");
          if (
            route === "chat" &&
            (await details.count()) &&
            !(await page.locator(".chat-details:visible").count())
          ) {
            await details.first().click();
          }
          // Let existing cache owners persist the fully loaded route before warm samples.
          await page.waitForFunction(
            () =>
              document.fonts.status === "loaded" &&
              [...document.images].every((image) => {
                const box = image.getBoundingClientRect();
                const visible =
                  box.width > 0 &&
                  box.height > 0 &&
                  box.bottom > 0 &&
                  box.y < innerHeight &&
                  box.right > 0 &&
                  box.x < innerWidth;
                return !visible || image.complete;
              }),
          );
          await delay(2000);
          if (admission) {
            await page
              .locator('.chat-pane__presence .viewer-facepile[data-viewer-count="3"]')
              .first()
              .waitFor({ state: "visible" });
          }
          const target = fixture.fixtureSummary.targets[route === "chat" ? 0 : 1]!;
          const cache = await readWarmCache(page, target.key);
          results.at(-1)!.warmCache = cache;
          await writeFile(
            path.join(arm.directory, route, "warm-cache.json"),
            JSON.stringify(cache, null, 2),
          );
          if (reloads > 0 && cache.targetSnapshots === 0) {
            throw new Error(
              "No owned transcript snapshot persisted for this route; warm proof would be invalid",
            );
          }
          if (values.base) {
            await cdp.send("Page.setWebLifecycleState", { state: "frozen" });
          }
          prepared.push({ arm, context, page, cdp, result: results.at(-1)! });
        } catch (error) {
          await diagnosticPage
            ?.screenshot({ path: path.join(arm.directory, `${route}-failure.png`), timeout: 5000 })
            .catch(() => {});
          await context.close();
          throw error;
        }
      }
      for (let index = 1; index <= reloads; index++) {
        // Alternate pair order so one arm does not always inherit the hotter server.
        const order = index % 2 === 1 ? prepared : prepared.toReversed();
        for (const item of order) {
          await activate(item.arm);
          if (values.base) {
            await item.cdp.send("Page.setWebLifecycleState", { state: "active" });
          }
          item.result.runs.push(
            await captureReload(
              item.page,
              item.cdp,
              `${baseUrl}${routePath}`,
              path.join(item.arm.directory, route, `warm-${String(index).padStart(2, "0")}`),
              true,
              route,
            ),
          );
          if (values.base) {
            await item.cdp.send("Page.setWebLifecycleState", { state: "frozen" });
          }
        }
      }
    } finally {
      for (const item of prepared) {
        await item.context.close();
      }
    }
  }
  const report = {
    revision,
    buildIdentity,
    dist,
    viewport,
    rttMs,
    captureMs,
    reloads,
    admission: admission
      ? {
          mode: "signed-in",
          mechanism:
            "HttpOnly synthetic proxy session; native trusted-proxy identity and protected-entry service worker",
          origin: admission.origin,
        }
      : { mode: "token" },
    arms: arms.map((arm) => ({
      name: arm.name,
      uiRoot: arm.build.uiRoot,
      sourceRef: arm.build.sourceRef,
      revision: arm.build.revision,
      uiIndexSha256: arm.build.uiIndexSha256,
    })),
    browserConfiguration,
    paintHoldingCalibration,
    fixture: fixture.fixtureSummary,
    host: {
      hostname: os.hostname(),
      cpus: os.cpus().length,
      load: os.loadavg(),
      chromium: browser.version(),
      quietBeforeCapture: quietHost,
    },
    measurement:
      "PNG compositor surfaces delivered by Chromium, not display-vsync completeness. Warm display timelines start with the observed old surface carried across navigation. DOM candidates are not paint measurements. Visible census groups only recognized stable-layout/content animation pixels; inspect raw and visible sheets. Compare mode isolates browser caches by arm, alternates AB/BA pairs, and uses the same built Gateway and durable state; The owned custom UI-root copy is swapped between arms outside navigation measurement; the Gateway process and its caches stay warm. CDP shaping is not calibrated per-RPC wire RTT.",
    results,
  };
  await writeFile(path.join(directory, "report.json"), JSON.stringify(report, null, 2));
  if (values.base) {
    await createWarmReloadComparison(results, directory);
  }
  console.info(`Retained proof: ${directory}/report.json`);
} finally {
  for (const close of [
    () => browser?.close(),
    () => (gateway ? stopChild(gateway, { teardownGraceMs: 10000 }) : undefined),
    () => admission?.close(),
    () => fixture?.close(),
    ...[...builds.values()].map((build) => () => build.cleanup()),
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
}
