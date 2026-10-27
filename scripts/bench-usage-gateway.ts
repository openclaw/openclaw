/** Compare real Usage model filters from the repository root; see scripts/README.md. */
import assert from "node:assert/strict";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { gatewayOriginScope } from "@openclaw/gateway-client/browser";
import { chromium, type CDPSession, type Page } from "playwright";
import { createRedactingStreamWriter } from "../src/logging/redacting-stream.ts";
import { CONTROL_UI_TOKEN_SESSION_KEY_PREFIX } from "../src/shared/control-ui-storage.js";
import {
  measureGatewayCpuUsage,
  readGatewayCpuUsage,
  readGatewayResources,
} from "./lib/gateway-bench-profile.ts";
import { createGatewayBenchEnv } from "./lib/gateway-bench-runtime.ts";
import { runManagedCommand } from "./lib/managed-child-process.mts";
import { startUsageRttProxy } from "./lib/usage-bench-rtt.ts";

const { values } = parseArgs({
  options: {
    base: { type: "string" },
    head: { type: "string" },
    ui: { type: "string" },
    out: { type: "string" },
    pairs: { type: "string", default: "20" },
    sessions: { type: "string", default: "12000" },
    smoke: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help) {
  console.log(
    "Usage: node --import ./scripts/tsx.mjs scripts/bench-usage-gateway.ts --base <checkout> --head <checkout> --ui <frozen-build> --out <new-directory> [--sessions 12000] [--pairs 20] [--smoke]",
  );
  process.exit(0);
}
for (const key of ["base", "head", "ui", "out"] as const) assert(values[key], `Missing --${key}`);
const base = path.resolve(values.base!);
const head = path.resolve(values.head!);
const ui = path.resolve(values.ui!);
const out = path.resolve(values.out!);
const pairs = Number(values.pairs);
const population = Number(values.sessions);
assert(Number.isInteger(pairs) && pairs > 0);
assert(Number.isInteger(population) && population > 0);
await mkdir(out, { recursive: false });

type Ready = {
  channel: "usage-volume-fixture";
  action: "ready";
  port: number;
  token: string;
  startDate: string;
  endDate: string;
  sessions: number;
  allTokens: number;
  models: Record<string, { sessions: number; tokens: number }>;
};
type Dispatch = { kind: string; rows: number; contextRows: number; packedBytes: number };
type Snapshot = { channel: "usage-volume-fixture"; action: "snapshot"; dispatches: Dispatch[] };
type Owner = {
  role: string;
  child: ChildProcess;
  ready: Ready;
  snapshot: () => Promise<Dispatch[]>;
  close: () => Promise<void>;
};
const owners: Owner[] = [];
const fixtureTokens: string[] = [];
const samples: object[] = [];
const failures: string[] = [];
const errorText = (error: unknown) =>
  fixtureTokens.reduce(
    (message, token) => message.replaceAll(token, "[fixture token]"),
    String(error),
  );
const browser = await chromium.launch({
  headless: true,
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
    ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH }
    : {}),
});

async function start(root: string, role: string): Promise<Owner> {
  const directory = path.join(out, role);
  await mkdir(directory);
  const setup = path.join(directory, "setup.json");
  await writeFile(setup, JSON.stringify({ uiRoot: ui, sessions: population }));
  const token = randomUUID();
  fixtureTokens.push(token);
  const log = openSync(path.join(directory, "gateway.log"), "wx");
  const output = [0, 1].map(() =>
    createRedactingStreamWriter(
      {
        write(text) {
          writeSync(log, text);
          return true;
        },
      },
      [token],
    ),
  );
  const closeLog = () => {
    try {
      for (const writer of output) writer.flush();
    } finally {
      closeSync(log);
    }
  };
  const ready = Promise.withResolvers<{ child: ChildProcess; fixture: Ready }>();
  const abort = new AbortController();
  const run = runManagedCommand({
    bin: process.execPath,
    cwd: root,
    args: [
      "--expose-gc",
      "--import",
      path.join(root, "scripts/tsx.mjs"),
      "--import",
      path.join(root, "scripts/lib/gateway-bench-profile-preload.ts"),
      path.join(root, "scripts/lib/usage-bench-child.ts"),
      setup,
    ],
    env: {
      ...createGatewayBenchEnv(directory, "", { startupTrace: false }),
      TMPDIR: directory,
      NODE_DISABLE_COMPILE_CACHE: "1",
      OPENCLAW_USAGE_BENCH_TOKEN: token,
    },
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    timeoutMs: 30 * 60_000,
    signal: abort.signal,
    requireProcessTreeExit: true,
    onReady(child) {
      child.stdout!.on("data", output[0]!.write);
      child.stderr!.on("data", output[1]!.write);
      child.on("message", (message) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "channel" in message &&
          message.channel === "usage-volume-fixture" &&
          "action" in message &&
          message.action === "ready"
        ) {
          ready.resolve({ child, fixture: message as Ready });
        }
      });
    },
  });
  void run.then(
    (code) => ready.reject(new Error(`${role} exited before ready: ${code}`)),
    ready.reject,
  );
  try {
    const { child, fixture } = await ready.promise;
    const snapshot = () =>
      new Promise<Dispatch[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.off("message", onMessage);
          reject(new Error("Fixture snapshot timed out"));
        }, 30_000);
        const onMessage = (message: unknown) => {
          if (
            typeof message !== "object" ||
            message === null ||
            !("channel" in message) ||
            message.channel !== "usage-volume-fixture" ||
            !("action" in message) ||
            message.action !== "snapshot"
          )
            return;
          clearTimeout(timer);
          child.off("message", onMessage);
          resolve((message as Snapshot).dispatches);
        };
        child.on("message", onMessage);
        child.send({ channel: "usage-volume-fixture", action: "snapshot" });
      });
    return {
      role,
      child,
      ready: fixture,
      snapshot,
      async close() {
        try {
          child.send({ channel: "usage-volume-fixture", action: "stop" });
          assert.equal(await run, 0, `${role} clean shutdown`);
        } finally {
          abort.abort();
          closeLog();
        }
      },
    };
  } catch (error) {
    abort.abort();
    await run.catch(() => {});
    closeLog();
    throw error;
  }
}

function observeUsage(page: Page) {
  const pending = new Map<string, { query: string; started: number }>();
  const responses: Array<{
    query: string;
    tokens: number;
    sessions: number;
    bytes: number;
    ms: number;
    ok: boolean;
    partial: boolean;
  }> = [];
  page.on("websocket", (socket) => {
    socket.on("framesent", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      if (frame.type === "req" && frame.method === "sessions.usage")
        pending.set(frame.id, { query: frame.params.query ?? "", started: performance.now() });
    });
    socket.on("framereceived", ({ payload }) => {
      const frame = JSON.parse(String(payload));
      const request = pending.get(frame.id);
      if (!request) return;
      pending.delete(frame.id);
      responses.push({
        query: request.query,
        tokens: frame.payload?.totals?.totalTokens,
        sessions: frame.payload?.overview?.total,
        bytes: Buffer.byteLength(String(payload)),
        ms: performance.now() - request.started,
        ok: frame.ok === true,
        partial: frame.payload?.partial !== undefined,
      });
    });
  });
  return responses;
}
async function waitForResponse(
  responses: ReturnType<typeof observeUsage>,
  after: number,
  query: string,
  expectedSessions?: number,
) {
  const deadline = performance.now() + 60_000;
  while (performance.now() < deadline) {
    const response = responses
      .slice(after)
      .find(
        (row) =>
          row.query === query &&
          (expectedSessions === undefined || row.sessions === expectedSessions),
      );
    if (response) {
      assert.equal(response.ok, true, "actual sessions.usage response");
      assert.equal(response.partial, false, "complete actual usage response");
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`No actual Usage response for ${query}`);
}
async function settled(page: Page, count: number) {
  await page.waitForFunction((expected) => {
    const button = document.querySelector<HTMLButtonElement>(
      '.usage-page button[aria-label="Refresh"]',
    );
    const text = document
      .querySelector(".usage-query-count")
      ?.textContent?.replaceAll(",", "")
      .replaceAll(".", "");
    return button?.disabled === false && text?.startsWith(`${expected} `);
  }, count);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function metrics(cdp: CDPSession) {
  return Object.fromEntries(
    (await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]),
  );
}

try {
  for (const [role, root] of [
    ["base-a", base],
    ["head", head],
    ["base-b", base],
  ] as const)
    owners.push(await start(root, role));
  for (const cpu of values.smoke ? [4] : [1, 4])
    for (const rtt of [0, 100]) {
      const pages = [];
      try {
        for (const owner of owners) {
          const context = await browser.newContext({
            viewport: { width: 1440, height: 900 },
            locale: "en-US",
            timezoneId: "UTC",
            serviceWorkers: "block",
          });
          const page = await context.newPage();
          const entry = {
            owner,
            context,
            page,
            cdp: await context.newCDPSession(page),
            proxy: undefined as Awaited<ReturnType<typeof startUsageRttProxy>> | undefined,
            responses: observeUsage(page),
          };
          pages.push(entry);
          entry.proxy = rtt ? await startUsageRttProxy(owner.ready.port, 50) : undefined;
          const { cdp, proxy, responses } = entry;
          page.setDefaultTimeout(60_000);
          await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpu });
          await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
          await page.addInitScript(() =>
            localStorage.setItem(
              "openclaw:control-ui:community-invite:v2",
              JSON.stringify({ dismissedAtMs: 1770000000000 }),
            ),
          );
          const url = new URL(`http://127.0.0.1:${proxy?.port ?? owner.ready.port}/usage`);
          const gatewayUrl = `ws://${url.host}`;
          await page.addInitScript(({ key, token }) => sessionStorage.setItem(key, token), {
            key: `${CONTROL_UI_TOKEN_SESSION_KEY_PREFIX}${gatewayOriginScope(gatewayUrl)}`,
            token: owner.ready.token,
          });
          await page.goto(url.href);
          await page.locator(".usage-query-input").waitFor();
          await page.waitForFunction(
            () =>
              document.querySelector<HTMLButtonElement>('.usage-page button[aria-label="Refresh"]')
                ?.disabled === false,
          );
          const coldDispatchBefore = (await owner.snapshot()).length;
          const coldCpuBefore = await readGatewayCpuUsage(owner.child);
          const coldBrowserBefore = await metrics(cdp);
          const coldStarted = performance.now();
          const coldRequestsBefore = responses.length;
          const dates = page.locator(".usage-date-range input");
          await dates.last().fill(owner.ready.endDate);
          await dates.last().press("Tab");
          await dates.first().fill(owner.ready.startDate);
          await dates.first().press("Tab");
          const coldResponse = await waitForResponse(responses, coldRequestsBefore, "", population);
          assert.equal(coldResponse.tokens, owner.ready.allTokens);
          await settled(page, population);
          const coldWallMs = performance.now() - coldStarted;
          const coldBrowserAfter = await metrics(cdp);
          const coldCpuAfter = await readGatewayCpuUsage(owner.child);
          samples.push({
            role: owner.role,
            phase: "population-range",
            cpu,
            rtt,
            wallMs: coldWallMs,
            gatewayCpu: measureGatewayCpuUsage(coldCpuBefore, coldCpuAfter),
            browserCpuMs: Object.fromEntries(
              [
                "ThreadTime",
                "TaskDuration",
                "ScriptDuration",
                "LayoutDuration",
                "RecalcStyleDuration",
              ].map((key) => [
                key,
                ((coldBrowserAfter[key] ?? 0) - (coldBrowserBefore[key] ?? 0)) * 1000,
              ]),
            ),
            dispatches: (await owner.snapshot()).slice(coldDispatchBefore),
            response: coldResponse,
            load: os.loadavg(),
          });
        }
        for (let iteration = 0; iteration < (values.smoke ? 2 : pairs * 2); iteration++) {
          const pair = Math.floor(iteration / 2);
          const order = pair % 2 ? [...pages].reverse() : pages;
          for (const entry of order) {
            const { owner, page, cdp, responses } = entry;
            const model = `fixture-model-${iteration % 2 ? "01" : "00"}-end`;
            const query = `model:${model}`;
            const truth = owner.ready.models[model]!;
            const requestsBefore = responses.length;
            const dispatchBefore = (await owner.snapshot()).length;
            const cpuBefore = await readGatewayCpuUsage(owner.child);
            const browserBefore = await metrics(cdp);
            const started = performance.now();
            await page.locator(".usage-query-input").fill(query);
            await page.locator(".usage-query-input").press("Enter");
            const response = await waitForResponse(responses, requestsBefore, query);
            assert.equal(response.tokens, truth.tokens);
            assert.equal(response.sessions, truth.sessions);
            await settled(page, truth.sessions);
            const wallMs = performance.now() - started;
            const browserAfter = await metrics(cdp);
            const cpuAfter = await readGatewayCpuUsage(owner.child);
            const dispatches = (await owner.snapshot()).slice(dispatchBefore);
            if (owner.role === "head") {
              assert.deepEqual(
                dispatches.map(({ kind }) => kind),
                ["cohorts"],
                "Candidate model filter must use one prepared cohort task",
              );
              assert.equal(dispatches[0]!.packedBytes, 0, "No packed rows resent on warm filters");
            }
            assert((await page.locator(".session-bar-row").count()) <= 50);
            const delta = Object.fromEntries(
              [
                "ThreadTime",
                "TaskDuration",
                "ScriptDuration",
                "LayoutDuration",
                "RecalcStyleDuration",
              ].map((key) => [key, ((browserAfter[key] ?? 0) - (browserBefore[key] ?? 0)) * 1000]),
            );
            samples.push({
              role: owner.role,
              phase: "filter",
              pair,
              cpu,
              rtt,
              model,
              wallMs,
              browserCpuMs: delta,
              gatewayCpu: measureGatewayCpuUsage(cpuBefore, cpuAfter),
              dispatches,
              response,
              load: os.loadavg(),
            });
            await writeFile(path.join(out, "samples.json"), JSON.stringify(samples, null, 2));
          }
        }
        for (const { owner } of pages) {
          await writeFile(
            path.join(out, `${owner.role}-${cpu}x-${rtt}ms-resources.json`),
            JSON.stringify(
              await readGatewayResources(owner.child, {
                includeWorkers: true,
                collectGarbage: true,
              }),
              null,
              2,
            ),
          );
        }
      } finally {
        for (const entry of pages.reverse()) {
          try {
            await entry.context.close();
          } catch (error) {
            failures.push(`${entry.owner.role} browser context cleanup: ${errorText(error)}`);
          }
          try {
            await entry.proxy?.close();
          } catch (error) {
            failures.push(`${entry.owner.role} relay cleanup: ${errorText(error)}`);
          }
        }
      }
    }
} catch (error) {
  failures.push(errorText(error));
  throw new Error(errorText(error));
} finally {
  try {
    await browser.close();
  } catch (error) {
    failures.push(`Browser cleanup: ${errorText(error)}`);
  }
  for (const owner of owners.reverse()) {
    try {
      await owner.close();
    } catch (error) {
      failures.push(`${owner.role} cleanup: ${errorText(error)}`);
    }
  }
  await writeFile(
    path.join(out, "completion.json"),
    JSON.stringify(
      {
        failures,
        samples: samples.length,
        pairsPerQuery: values.smoke ? 1 : pairs,
        queries: ["model:fixture-model-00-end", "model:fixture-model-01-end"],
        limitations:
          "Backend runs at native CPU; 1x/4x applies only to Chromium. Browser metrics use threadTicks. Same frozen UI for all roles. Population has one/two actual turns per session spread over180days. Cold seeding excluded from warm samples; setup logs retained. No provider calls.",
      },
      null,
      2,
    ),
  );
}
assert.equal(failures.length, 0, failures.join("\n"));
