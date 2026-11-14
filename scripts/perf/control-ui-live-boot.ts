import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import path from "node:path";
import { chromium, firefox, webkit } from "playwright";
import type { OpenClawConfig } from "../../src/config/types.openclaw.ts";
import { resolvePlaywrightChromiumExecutablePath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { startEngineMeasurement, type ControlUiEngine } from "../lib/control-ui-engine-metrics.ts";
import { stopChild } from "../lib/gateway-bench-child.ts";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "../perf/team-shape-fixture.ts";
import { freeProofPort, startWarmReloadAdmission } from "../perf/warm-reload-admission.ts";
import { startFlakyNetworkProxy } from "./flaky-network-proxy.ts";

// Opt-in real-Gateway boot comparison: BOOT_BASE and BOOT_HEAD name built UI roots.
// BOOT_OUT stays in .artifacts; BOOT_PAIRS defaults to 20. BOOT_ENGINES selects
// chromium,webkit,firefox. BOOT_RTT_MS adds TCP round-trip latency (default 0).
// BOOT_TRACE=1 is diagnostic, never timing proof.
// BOOT_VERIFY_NATIVE=50 instead proves native signatures reach real Gateway admission;
// it adds instrumentation and must not be used for timing claims.
// Service workers are blocked to match the engine census. No model is invoked.
// Requires the built Gateway and plugin metadata in dist, as well as both UI builds.
// BOOT_BASE=.artifacts/base BOOT_HEAD=dist/control-ui node --import ./scripts/tsx.mjs scripts/perf/control-ui-live-boot.ts
type Rpc = {
  method: string;
  requestMs: number;
  responseMs: number;
  responseBytes: number;
  ok?: boolean;
  historyMessages?: number | null;
  nativeSignature?: boolean;
};
type BootProbe = {
  rpcs: Rpc[];
  events: Array<{ event: string; atMs: number }>;
  sockets: Array<{ createdMs: number; openMs: number }>;
  readyMs: number;
  transcriptMs: number;
  composerMs: number;
  navigationOffsetMs: number;
};
type WireFrame = {
  id: string;
  type: string;
  method: string;
  event: string;
  ok: boolean;
  params?: { device?: { signature: string } };
  error?: { details?: { reason?: string } };
  payload?: {
    type?: string;
    initialHistory?: { payload?: { messages?: unknown[] } };
    messages?: unknown[];
  };
};
const out = path.resolve(process.env.BOOT_OUT ?? ".artifacts/control-ui-live-boot");
const observations: unknown[] = [];
const cleanups = new Set<() => Promise<void>>();
let interrupted = false;
async function interrupt(exitCode: number) {
  interrupted = true;
  process.exitCode = exitCode;
  // Preserve partial evidence before teardown can drain the process event loop.
  await writeFile(path.join(out, "observations.json"), JSON.stringify(observations, null, 2));
  await Promise.allSettled([...cleanups].map((close) => close()));
}
process.once("SIGINT", () => void interrupt(130));
process.once("SIGTERM", () => void interrupt(143));
const pairs = Number(process.env.BOOT_PAIRS ?? "20");
if (!Number.isSafeInteger(pairs) || pairs < 1 || pairs > 60) {
  throw new Error("BOOT_PAIRS must be an integer from 1 to 60");
}
const rttMs = Number(process.env.BOOT_RTT_MS ?? "0");
if (!Number.isSafeInteger(rttMs) || rttMs < 0 || rttMs > 1000) {
  throw new Error("BOOT_RTT_MS must be an integer from 0 to 1000");
}
const nativeProofCount = Number(process.env.BOOT_VERIFY_NATIVE ?? "0");
if (!Number.isSafeInteger(nativeProofCount) || nativeProofCount < 0 || nativeProofCount > 1000) {
  throw new Error("BOOT_VERIFY_NATIVE must be an integer from 0 to 1000");
}
await mkdir(out, { recursive: true });
async function createRig(bundle: string, directory: string) {
  const uiIndexSha256 = createHash("sha256")
    .update(await readFile(path.join(bundle, "index.html")))
    .digest("hex");
  await mkdir(directory, { recursive: true });
  const port = await freeProofPort([], true);
  const admissionPort = await freeProofPort([port, port + 1]);
  const publicPort = rttMs ? await freeProofPort([port, port + 1, admissionPort]) : undefined;
  const admission = await startWarmReloadAdmission({
    gatewayPort: port,
    port: admissionPort,
    publicPort,
  });
  let network: Awaited<ReturnType<typeof startFlakyNetworkProxy>> | undefined;
  let closeGateway: (() => Promise<void>) | undefined = undefined;
  let log: ReturnType<typeof createWriteStream> | undefined = undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await closeGateway?.();
      log?.end();
      await network?.close();
      await admission.close();
      cleanups.delete(close);
    })());
  cleanups.add(close);
  if (publicPort !== undefined) {
    network = await startFlakyNetworkProxy({ port: publicPort, upstreamPort: admissionPort });
    network.setFaults({ rttMs });
  }
  const key = "agent:main:interaction-a";
  const fixture = await generateTeamShapeFixture({
    ...parseTeamShapeOptions([
      "--state-dir",
      path.join(directory, "state"),
      "--port",
      "40967",
      "--sessions",
      "1",
      "--agents",
      "1",
      "--runs",
      "0",
      "--approvals",
      "0",
      "--cron",
      "0",
      "--projects",
      "0",
      "--transcript-mib",
      "0",
      "--chat-startup-sessions",
      "1",
    ]),
    sessionKeys: [key],
  });
  const fixtureEnv: NodeJS.ProcessEnv = { ...fixture.env, TMPDIR: process.env.TMPDIR };
  delete fixtureEnv.TMP;
  delete fixtureEnv.TEMP;
  const configFile = path.join(directory, "state", "openclaw.json");
  const config: OpenClawConfig = JSON.parse(await readFile(configFile, "utf8"));
  config.gateway = {
    ...config.gateway,
    port,
    auth: admission.gatewayAuth,
    trustedProxies: ["127.0.0.1", "::1"],
    controlUi: {
      enabled: true,
      root: path.resolve(bundle),
      allowedOrigins: [admission.origin],
    },
  };
  config.plugins = {
    enabled: true,
    allow: ["openai"],
    entries: { openai: { enabled: true } },
    slots: { memory: "none" },
  };
  config.models = {
    catalogRefresh: { enabled: false },
    providers: {
      openai: {
        api: "openai-responses",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "synthetic-boot-fixture",
        models: [
          {
            id: "gpt-4.1",
            name: "Synthetic model",
            contextWindow: 128000,
            maxTokens: 4096,
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  };
  config.agents = {
    ...config.agents,
    defaults: { ...config.agents?.defaults, model: "openai/gpt-4.1" },
  };
  await writeFile(configFile, JSON.stringify(config));
  const priorEnv = process.env;
  process.env = fixtureEnv;
  try {
    const db = await import("../../src/state/openclaw-agent-db.ts");
    const transcripts =
      await import("../../src/config/sessions/session-accessor.sqlite-transcript-store.ts");
    db.runOpenClawAgentWriteTransaction(
      (owner) =>
        transcripts.appendTranscriptEventsInTransaction(
          owner,
          { agentId: "main", env: fixtureEnv, sessionKey: key, sessionId: "team-shape-session-0" },
          Array.from({ length: 400 }, (_, i) => ({
            type: "message",
            id: "boot-" + i,
            parentId: i ? "boot-" + (i - 1) : null,
            timestamp: new Date(1800000000000 + i * 1000).toISOString(),
            message: {
              role: i % 2 ? "assistant" : "user",
              content:
                "Transcript 0 message " + i + ".\n" + "Synthetic transcript detail.\n".repeat(4),
              timestamp: 1800000000000 + i * 1000,
            },
          })),
        ),
      { agentId: "main", env: fixtureEnv },
    );
    await db.closeOpenClawAgentDatabasesAsync();
  } finally {
    process.env = priorEnv;
  }
  if (interrupted) {
    throw new Error("Benchmark interrupted before Gateway startup");
  }
  log = createWriteStream(path.join(directory, "gateway.log"));
  const gateway = spawn(
    process.execPath,
    [
      path.resolve("dist/index.js"),
      "gateway",
      "run",
      "--port",
      String(port),
      "--bind",
      "loopback",
      "--allow-unconfigured",
    ],
    { env: fixtureEnv, stdio: ["ignore", "pipe", "pipe"], detached: true },
  );
  closeGateway = async () => {
    await stopChild(gateway, { teardownGraceMs: 30000 });
  };
  gateway.stdout.pipe(log);
  gateway.stderr.pipe(log);
  try {
    const deadline = Date.now() + 180000;
    for (;;) {
      if (interrupted || gateway.exitCode !== null || gateway.signalCode !== null) {
        throw new Error("Gateway exited; see log");
      }
      try {
        const response = await fetch("http://127.0.0.1:" + port + "/readyz", {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          break;
        }
      } catch {}
      if (Date.now() > deadline) {
        throw new Error("Gateway readiness timeout");
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
    }
  } catch (error) {
    await close();
    throw error;
  }
  return {
    bundle: path.resolve(bundle),
    uiIndexSha256,
    admission,
    gateway,
    log,
    close,
  };
}
function probe(profileStyles: boolean, nativeProof: boolean) {
  if (window !== window.top) {
    return;
  }

  const timingKey = "openclaw-live-boot-navigation-start";
  let origin = Number(sessionStorage.getItem(timingKey));
  if (!origin) {
    origin = performance.timeOrigin;
    sessionStorage.setItem(timingKey, String(origin));
  }
  const now = () => performance.timeOrigin + performance.now() - origin;
  const data: BootProbe = {
    rpcs: [],
    events: [],
    sockets: [],
    readyMs: 0,
    transcriptMs: 0,
    composerMs: 0,
    navigationOffsetMs: performance.timeOrigin - origin,
  };
  Reflect.set(window, "__liveBoot", data);
  const nativeSignatures = new Set<string>();
  if (nativeProof) {
    const subtle = crypto.subtle;
    const sign = subtle.sign.bind(subtle);
    subtle.sign = async (algorithm, key, message) => {
      const signature = await sign(algorithm, key, message);
      if (
        (typeof algorithm === "string" ? algorithm : algorithm.name) === "Ed25519" &&
        key.type === "private" &&
        !key.extractable &&
        key.usages.length === 1 &&
        key.usages[0] === "sign"
      ) {
        nativeSignatures.add(
          new Uint8Array(signature).toBase64({ alphabet: "base64url", omitPadding: true }),
        );
      }
      return signature;
    };
  }
  if (profileStyles) {
    console.timeStamp("control-ui-live-boot:document");
  }
  const Original = window.WebSocket;
  window.WebSocket = new Proxy(Original, {
    construct(target, args) {
      const socket: WebSocket = Reflect.construct(target, args);
      const item = { createdMs: now(), openMs: 0 };
      data.sockets.push(item);
      socket.addEventListener("open", () => (item.openMs = now()));
      const pending = new Map<string, Rpc>();
      const send = socket.send.bind(socket);
      socket.send = (body) => {
        if (typeof body === "string") {
          const f: WireFrame = JSON.parse(body);
          if (f.type === "req") {
            const r: Rpc = { method: f.method, requestMs: now(), responseMs: 0, responseBytes: 0 };
            if (nativeProof && f.method === "connect") {
              r.nativeSignature = nativeSignatures.delete(f.params?.device?.signature ?? "");
            }
            if (profileStyles && f.method === "connect") {
              console.timeStamp("control-ui-live-boot:connect");
            }
            pending.set(f.id, r);
            data.rpcs.push(r);
          }
        }
        send(body);
      };
      socket.addEventListener("message", (event) => {
        if (typeof event.data !== "string") {
          return;
        }
        const f: WireFrame = JSON.parse(event.data);
        const at = now();
        if (f.type === "res") {
          const r = pending.get(f.id);
          if (r) {
            r.responseMs = at;
            r.responseBytes = event.data.length;
            r.ok = f.ok;
            r.historyMessages =
              f.payload?.initialHistory?.payload?.messages?.length ??
              f.payload?.messages?.length ??
              null;
          }
        } else if (f.type === "event") {
          data.events.push({ event: f.event, atMs: at });
        }
      });
      return socket;
    },
  });
  function sample() {
    const pane = document.querySelector(".chat-thread");
    const input = document.querySelector(".agent-chat__composer-combobox textarea");
    if (!data.transcriptMs && pane && pane.textContent?.includes("Transcript 0 message 399.")) {
      data.transcriptMs = now();
    }
    if (
      !data.composerMs &&
      input &&
      input instanceof HTMLTextAreaElement &&
      !input.disabled &&
      input.checkVisibility()
    ) {
      data.composerMs = now();
    }
    if (data.transcriptMs && data.composerMs) {
      data.readyMs = Math.max(data.transcriptMs, data.composerMs);
      console.debug("control-ui-live-boot:ready-notify");
      if (profileStyles) {
        console.timeStamp("control-ui-live-boot:ready");
      }
    } else {
      requestAnimationFrame(sample);
    }
  }
  requestAnimationFrame(sample);
}
const rigs: Awaited<ReturnType<typeof createRig>>[] = [];
try {
  for (const [i, bundle] of [
    process.env.BOOT_BASE ?? "dist/control-ui",
    process.env.BOOT_HEAD ?? "dist/control-ui",
  ].entries()) {
    rigs.push(await createRig(bundle, path.join(out, "rig-" + i)));
  }
  await writeFile(
    path.join(out, "builds.json"),
    JSON.stringify(
      rigs.map(({ bundle, uiIndexSha256 }) => ({ bundle, uiIndexSha256 })),
      null,
      2,
    ),
  );
  console.log("READY", out);
  const engines: ControlUiEngine[] = (process.env.BOOT_ENGINES ?? "chromium,webkit,firefox")
    .split(",")
    .map((engine) => {
      if (engine !== "chromium" && engine !== "webkit" && engine !== "firefox") {
        throw new Error(`Unknown browser: ${engine}`);
      }
      return engine;
    });
  const browsers = new Map<string, Awaited<ReturnType<typeof chromium.launch>>>();
  try {
    for (const engine of engines) {
      if (interrupted) {
        throw new Error("Benchmark interrupted before browser startup");
      }
      const browser = await (
        engine === "webkit" ? webkit : engine === "firefox" ? firefox : chromium
      ).launch({
        headless: true,
        ...(engine === "chromium"
          ? { executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()) }
          : {}),
      });
      if (interrupted) {
        await browser.close();
        throw new Error("Benchmark interrupted during browser startup");
      }
      browsers.set(engine, browser);
      cleanups.add(() => browser.close());
    }
    await writeFile(
      path.join(out, "browsers.json"),
      JSON.stringify(
        Object.fromEntries([...browsers].map(([engine, browser]) => [engine, browser.version()])),
      ),
    );
    const variants = ["base", "head", "control"];
    const cells = engines.flatMap((engine) => variants.map((variant) => ({ engine, variant })));
    if (nativeProofCount) {
      const { admission } = rigs[1]!;
      for (const engine of engines) {
        const context = await browsers.get(engine)!.newContext({ serviceWorkers: "block" });
        try {
          await context.addCookies([admission.browserCookie]);
          await context.addInitScript({
            content: ";(()=>{const __name=(fn)=>fn;(" + probe.toString() + ")(false,true);})();",
          });
          const page = await context.newPage();
          for (let trial = 0; trial < nativeProofCount; trial++) {
            const accepted = page.waitForEvent("websocket").then((socket) =>
              socket.waitForEvent("framereceived", {
                predicate: ({ payload }) => {
                  const frame: WireFrame = JSON.parse(String(payload));
                  return frame.type === "res" && frame.ok && frame.payload?.type === "hello-ok";
                },
                timeout: 30000,
              }),
            );
            await page.goto(
              admission.origin +
                "/__openclaw__/session-entry?path=" +
                encodeURIComponent("/chat/main/interaction-a"),
              { waitUntil: "domcontentloaded" },
            );
            await accepted;
            const connect = await page.evaluate(() => {
              const data: BootProbe = Reflect.get(window, "__liveBoot");
              return data.rpcs.find((rpc) => rpc.method === "connect" && rpc.ok);
            });
            if (!connect?.nativeSignature) {
              throw new Error(
                `${engine} trial ${trial}: accepted connect did not use native signing`,
              );
            }
            observations.push({ engine, trial, connect });
            console.log("NATIVE_ACCEPTED", engine, trial);
          }
          // A failed signature must reach the actual verifier even with proxy admission.
          await page.addInitScript(() => {
            const sign = crypto.subtle.sign.bind(crypto.subtle);
            crypto.subtle.sign = async (...args) => {
              const result = await sign(...args);
              const bytes = new Uint8Array(result);
              bytes[0] = bytes[0]! ^ 1;
              return result;
            };
          });
          const rejected = page.waitForEvent("websocket").then((socket) =>
            socket.waitForEvent("framereceived", {
              predicate: ({ payload }) => {
                const frame: WireFrame = JSON.parse(String(payload));
                return (
                  frame.type === "res" &&
                  !frame.ok &&
                  frame.error?.details?.reason === "device-signature"
                );
              },
              timeout: 30000,
            }),
          );
          await page.reload({ waitUntil: "domcontentloaded" });
          await rejected;
          observations.push({ engine, rejectedTamperedSignature: true });
          console.log("NATIVE_TAMPER_REJECTED", engine);
        } finally {
          await context.close();
        }
      }
    }
    for (let pair = 0; pair < (nativeProofCount ? 0 : pairs); pair++) {
      const order = cells.slice(pair % cells.length).concat(cells.slice(0, pair % cells.length));
      if (pair % 2) {
        order.reverse();
      }
      for (const { engine, variant } of order) {
        console.log("CELL", pair, engine, variant);
        const { admission } = rigs[variant === "head" ? 1 : 0]!;
        const url =
          admission.origin +
          "/__openclaw__/session-entry?path=" +
          encodeURIComponent("/chat/main/interaction-a");
        const context = await browsers
          .get(engine)!
          .newContext({ viewport: { width: 1440, height: 1100 }, serviceWorkers: "block" });
        await context.addCookies([admission.browserCookie]);
        await context.addInitScript({
          content:
            ";(()=>{const __name=(fn)=>fn;(" +
            probe.toString() +
            ")(" +
            Boolean(process.env.BOOT_TRACE) +
            ",false);})();",
        });
        const page = await context.newPage();
        const errors: string[] = [];
        page.on("requestfailed", (request) => {
          console.log("REQUEST_FAILED", request.url(), request.failure()?.errorText);
        });
        page.on("pageerror", (e) => {
          errors.push(e.stack ?? e.message);
          console.log("PAGE_ERROR", e.stack ?? e.message);
        });
        await page.goto(admission.origin + "/healthz");
        await page.evaluate(() => sessionStorage.removeItem("openclaw-live-boot-navigation-start"));
        try {
          for (const state of ["cold", "warm"]) {
            if (state === "warm") {
              await page.evaluate(() =>
                sessionStorage.removeItem("openclaw-live-boot-navigation-start"),
              );
            }
            const measurement = process.env.BOOT_TRACE
              ? await startEngineMeasurement(page, engine, { trace: true })
              : null;
            const readyNotification = page.waitForEvent("console", {
              predicate: (message) => message.text() === "control-ui-live-boot:ready-notify",
              timeout: 30000,
            });
            const hostLoad = loadavg();
            const start = performance.now();
            console.log("NAVIGATE", engine, variant, state);
            const navigation =
              state === "cold"
                ? page.goto(url, { waitUntil: "domcontentloaded" })
                : page.reload({ waitUntil: "domcontentloaded" });
            await Promise.all([
              navigation.then(() => console.log("NAVIGATED", engine, state)),
              readyNotification,
            ]);
            console.log("GOT_READY", engine, state);
            const data = await page.evaluate(() => {
              const d: BootProbe = Reflect.get(window, "__liveBoot");
              return {
                ...d,
                cachedAdmission:
                  document
                    .querySelector("[data-cached-session]")
                    ?.getAttribute("data-cached-session") ?? null,
              };
            });
            const trace = await measurement?.stop();
            if (trace) {
              await writeFile(
                path.join(out, `${pair}-${engine}-${variant}-${state}.trace.json`),
                JSON.stringify(trace),
              );
            }
            const row = {
              pair,
              engine,
              variant,
              state,
              hostLoad,
              rttMs,
              wallMs: performance.now() - start,
              ...data,
              metrics: trace?.metrics,
              errors: [...errors],
            };
            observations.push(row);
            console.log(
              JSON.stringify({
                pair,
                engine,
                variant,
                state,
                readyMs: data.readyMs,
                connect: data.rpcs.find((r) => r.method === "connect"),
                errors,
              }),
            );
            if (state === "cold") {
              await page.waitForTimeout(1000);
            }
          }
        } finally {
          console.log("CLOSE", engine, variant);
          await context.close();
          console.log("CLOSED", engine, variant);
        }
      }
    }
  } finally {
    for (const browser of browsers.values()) {
      await browser.close();
    }
  }
} catch (error) {
  if (!interrupted) {
    throw error;
  }
} finally {
  await Promise.allSettled([...cleanups].map((close) => close()));
  await writeFile(path.join(out, "observations.json"), JSON.stringify(observations, null, 2));
}
