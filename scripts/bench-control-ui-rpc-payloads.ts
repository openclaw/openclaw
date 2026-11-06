// Synthetic, compiled-Gateway route census; never connects to an operator Gateway.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect } from "node:net";
import { loadavg, tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, webkit, type Browser, type Page } from "playwright";
import {
  gatewayOriginScope,
  gatewayCredentialScope,
} from "../packages/gateway-client/src/gateway-origin-scope.ts";
import { CONTROL_UI_TOKEN_SESSION_KEY_PREFIX } from "../src/shared/control-ui-storage.ts";
import { APP_ROUTE_IDS, pathForRoute, type RouteId } from "../ui/src/app-route-paths.ts";
import {
  evaluateControlUiContext,
  getControlUiContextHandle,
} from "../ui/src/test-helpers/control-ui-e2e-context.ts";
import { resolvePlaywrightChromiumExecutablePath } from "../ui/src/test-helpers/playwright-chromium.ts";
import { startEngineMeasurement } from "./lib/control-ui-engine-metrics.ts";
import { installControlUiRpcObserver } from "./lib/control-ui-rpc-observer.ts";
import { createControlUiWireLink } from "./lib/control-ui-wire-link.ts";
import { stopChild, stopGatewayGracefully } from "./lib/gateway-bench-child.ts";
import { getFreePort } from "./lib/gateway-bench-probes.ts";
import {
  buildGatewayBenchChildArgs,
  createGatewayBenchEnv,
  waitForInitialProbe,
  writePluginFixtures,
} from "./lib/gateway-bench-runtime.ts";
import { generateTeamShapeFixture, parseTeamShapeOptions } from "./perf/team-shape-fixture.ts";

const { values } = parseArgs({
  options: {
    output: { type: "string" },
    entry: { type: "string", default: "dist/entry.js" },
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    "compare-bundle-dir": { type: "string" },
    controlled: { type: "boolean", default: false },
    "routes-only": { type: "boolean", default: false },
    "boot-route": { type: "string", default: "new-session" },
    routes: {
      type: "string",
      default: "all",
    },
    engines: { type: "string", default: "chromium,webkit" },
    profile: { type: "string", default: "local" },
    "idle-ms": { type: "string", default: "5000" },
    trace: { type: "boolean", default: false },
    "no-rpc-observer": { type: "boolean", default: false },
    "observe-ms": { type: "string", default: "0" },
    "prepare-ms": { type: "string", default: "0" },
    samples: { type: "string", default: "1" },
    sessions: { type: "string", default: "12000" },
    agents: { type: "string", default: "40" },
    cron: { type: "string", default: "1000" },
    skills: { type: "string", default: "100" },
    plugins: { type: "string", default: "30" },
    stream: { type: "boolean", default: false },
    screenshots: { type: "boolean", default: false },
  },
});
assert(values.output, "--output is required (a fresh directory on the external disk)");
assert(["local", "remote"].includes(values.profile));
if (values["compare-bundle-dir"]) {
  await compare();
  process.exit(process.exitCode ?? 0);
}
const commands = values.controlled ? createInterface({ input: process.stdin }) : undefined;
const commandIterator = commands?.[Symbol.asyncIterator]();
const bootRoute = APP_ROUTE_IDS.find((route) => route === values["boot-route"]);
assert(bootRoute, "Unknown --boot-route");
const routes = (
  values.routes === "all"
    ? APP_ROUTE_IDS.filter((id) => id !== bootRoute)
    : values.routes.split(",")
).map((id) => {
  const selectedRoute = APP_ROUTE_IDS.find((route) => route === id);
  assert(selectedRoute, `Unknown route: ${id}`);
  return selectedRoute;
});
const output = path.resolve(values.output);
await mkdir(output, { recursive: false });
const entry = path.resolve(values.entry);
const port = await getFreePort();
const proxyPort = await getFreePort();
const providerPort = await getFreePort();
const root = path.join(output, "state");
const fixtureOptions = parseTeamShapeOptions([
  "--state-dir",
  root,
  "--sessions",
  values.sessions,
  "--agents",
  values.agents,
  "--cron",
  values.cron,
  "--runs",
  "0",
  "--approvals",
  "0",
  "--projects",
  "0",
  "--transcript-mib",
  "0",
  "--long-transcript-entries",
  "120",
  "--long-transcript-sessions",
  "1",
  "--port",
  String(port),
  "--now",
  String(Date.now()),
]);
await generateTeamShapeFixture(fixtureOptions);
const configPath = path.join(root, "openclaw.json");
const config = JSON.parse(await readFile(configPath, "utf8"));
const token = "synthetic-rpc-payloads-token";
const url = `http://127.0.0.1:${values.profile === "local" ? port : proxyPort}`;
config.gateway = {
  ...config.gateway,
  auth: { mode: "token", token },
  trustedProxies: ["127.0.0.1"],
  controlUi: { enabled: true, root: path.resolve(values["bundle-dir"]), allowedOrigins: [url] },
};
config.diagnostics = { enabled: true };
config.session = { maintenance: { maxEntries: Number(values.sessions) * 2 } };
const plugins = writePluginFixtures(root, { count: Number(values.plugins) });
config.plugins = { enabled: true, allow: plugins.pluginIds, load: { paths: [plugins.pluginsDir] } };
config.models = {
  mode: "replace",
  providers: Object.fromEntries(
    Array.from({ length: 10 }, (_unusedProvider, provider) => [
      `rpc-bench-${provider}`,
      {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        apiKey: "synthetic-unused-key",
        api: "openai-completions",
        models: Array.from({ length: 100 }, (_unusedModel, model) => ({
          id: `synthetic-${model}`,
          name: `Synthetic model ${provider}/${model}`,
          input: ["text"],
          reasoning: false,
          contextWindow: 128000,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      },
    ]),
  ),
};
config.agents.entries.main.model = { primary: "rpc-bench-0/synthetic-0" };
for (let index = 0; index < Number(values.skills); index++) {
  const name = `rpc-skill-${index}`;
  const directory = path.join(root, "workspace", "skills", name);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: Synthetic RPC inventory skill ${index}.\n---\n\n# ${name}\n\nSynthetic procedure.\n`,
  );
}
// Keep repository discovery inside the synthetic workspace, even when output is .artifacts/.
execFileSync("git", ["init", "--quiet", path.join(root, "workspace")]);
await writeFile(configPath, JSON.stringify(config));
const cacheRoot = await mkdtemp(path.join(tmpdir(), "openclaw-rpc-cache-"));
const env = createGatewayBenchEnv(path.join(root, "home"), configPath, {
  startupTrace: false,
  caseEnv: {
    XDG_CACHE_HOME: cacheRoot,
    OPENCLAW_STATE_DIR: root,
    OPENCLAW_SKIP_CHANNELS: "1",
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_PROFILE: `rpc-payloads-${port}`,
    OPENCLAW_BENCH_RPC_PORT: String(port),
    OPENCLAW_BENCH_RPC_PARENT: String(process.pid),
    OPENCLAW_BENCH_RPC_ENTRY: entry,
  },
});
const seed = createHash("sha256").update("synthetic-rpc-payloads-device").digest();
const key = createPrivateKey({
  key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
  format: "der",
  type: "pkcs8",
});
const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).subarray(-32);
const identity = {
  version: 1,
  deviceId: createHash("sha256").update(publicKey).digest("hex"),
  publicKey: publicKey.toString("base64url"),
  privateKey: seed.toString("base64url"),
  createdAtMs: Date.now(),
};
const previousEnv = process.env;
try {
  process.env = env;
  const { requestDevicePairing } = await import("../src/infra/device-pairing.js");
  const { approveDevicePairing } = await import("../src/infra/device-pairing-approval.js");
  const scopes = [
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.questions",
    "operator.pairing",
  ];
  const pairing = await requestDevicePairing({
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    role: "operator",
    scopes,
  });
  assert.equal(
    (await approveDevicePairing(pairing.request.requestId, { callerScopes: scopes }))?.status,
    "approved",
  );
  const { ensureCanonicalGatewayOwnerProfile, setCanonicalUserProfileAvatar } =
    await import("../src/state/user-profile-writes.js");
  const owner = await ensureCanonicalGatewayOwnerProfile("Synthetic RPC operator", { env });
  await setCanonicalUserProfileAvatar(
    owner.id,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/CfcAAAAASUVORK5CYII=",
      "base64",
    ),
    "image/png",
    { env },
  );
  const { closeOpenClawStateDatabaseAsync, runOpenClawStateWriteTransaction } =
    await import("../src/state/openclaw-state-db.js");
  const { recordCronRunInDatabase } = await import("../src/cron/store/run-history.kernel.js");
  const { cronRunLogEntryToDetail, cronRunStorageStatus } =
    await import("../src/cron/run-history-detail.js");
  const { cronStoreKey } = await import("../src/cron/store/key.js");
  const storeKey = cronStoreKey(path.join(root, "cron", "jobs.json"));
  // Exclusive offline fixture custody; the compiled Gateway has not started.
  runOpenClawStateWriteTransaction(({ db }) => {
    for (let i = 0; i < Number(values.cron) * 5; i++) {
      const jobId = `team-shape-cron-${i % Number(values.cron)}`;
      const endedAt = Date.now() - i * 1000;
      const summary =
        `Synthetic result ${i}. ` + "A reproducible completed automation result. ".repeat(30);
      recordCronRunInDatabase(db, {
        storeKey,
        jobId,
        runId: `rpc-run-${i}`,
        agentId: "main",
        startedAt: endedAt - 100,
        endedAt,
        status: cronRunStorageStatus({ status: "ok" }),
        summary,
        detail: cronRunLogEntryToDetail(
          { jobId, action: "finished", ts: endedAt, status: "ok", summary },
          { storeKey },
        ),
      });
    }
  });
  await closeOpenClawStateDatabaseAsync();
} finally {
  process.env = previousEnv;
}
const stopPreload = new URL("./lib/gateway-bench-stop-preload.mjs", import.meta.url);
stopPreload.searchParams.set("parentPid", String(process.pid));
stopPreload.searchParams.set("entry", entry);
const child = spawn(
  process.execPath,
  buildGatewayBenchChildArgs(
    entry,
    port,
    [
      "--import",
      fileURLToPath(new URL("./perf/gateway-ui-rpc-preload.mjs", import.meta.url)),
      "--import",
      stopPreload.href,
    ],
    "token",
  ),
  {
    env,
    cwd: path.dirname(path.dirname(entry)),
    detached: true,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  },
);
const log = createWriteStream(path.join(output, "gateway.log"));
child.stdout?.pipe(log);
child.stderr?.pipe(log);
child.once("close", () => log.end());
let interrupted = false;
let activeBrowser: Browser | undefined;
const interrupt = () => {
  interrupted = true;
  process.exitCode = 130;
  commands?.close();
  // Closing the browser releases pending Playwright waits into the teardown below.
  void activeBrowser?.close();
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const up = createControlUiWireLink({
  latencyMs: values.profile === "remote" ? 50 : 0,
  megabitsPerSecond: values.profile === "remote" ? 10 : 10000,
});
const down = createControlUiWireLink({
  latencyMs: values.profile === "remote" ? 50 : 0,
  megabitsPerSecond: values.profile === "remote" ? 10 : 10000,
});
const proxy = createServer((socket) => {
  const target = connect(port, "127.0.0.1");
  socket.setNoDelay(true);
  target.setNoDelay(true);
  up.connect(socket, target, () => {});
  down.connect(target, socket, () => {});
});
async function control(action: "begin" | "end") {
  const id = randomUUID();
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", receive);
      reject(new Error("Gateway observer timed out"));
    }, 10000);
    function receive(raw: unknown) {
      const message = raw as { id?: string; result?: unknown; error?: string };
      if (message.id !== id) {
        return;
      }
      clearTimeout(timer);
      child.off("message", receive);
      if (message.error) {
        reject(new Error(message.error));
      } else {
        resolve(message.result);
      }
    }
    child.on("message", receive);
    child.send({ channel: "gateway-ui-rpc-measure", action, id, countOps: false });
  });
}
const selectors: Partial<Record<RouteId, string>> = {
  "new-session": ".new-session-page__message:not(:disabled)",
  sessions: "openclaw-sessions-page .data-table tbody tr:not(.session-skeleton-row) a",
  cron: ".cron-table__row .cron-table__name",
  agents: ".agents-refresh-btn:not(:disabled)",
  usage: 'openclaw-usage-page button[aria-label="Refresh"]:not(:disabled)',
  "skill-settings": '.skill-library-search input[name="library-search"]',
  "plugin-settings": ".plugins-settings-search input",
  "model-providers": ".model-providers__provider-list",
  appearance: ".settings-theme-grid [data-theme-id]",
};
async function ready(page: Page, route?: RouteId) {
  await page.locator("openclaw-app-shell").waitFor({ state: "attached", timeout: 60000 });
  const application = await getControlUiContextHandle(page);
  try {
    await page.waitForFunction((app) => app.gateway.snapshot.phase === "connected", application, {
      timeout: 90000,
    });
    if (route) {
      await page.waitForFunction(
        (app) => {
          const current = app.router.getState();
          return current.status !== "loading" && current.pendingMatches.length === 0;
        },
        application,
        { timeout: 90000 },
      );
      const matched = await application.evaluate((app) =>
        app.router.getState().matches.map((match) => match.routeId),
      );
      assert(matched.includes(route), `${route} redirected to ${matched.join(",")}`);
    }
  } finally {
    await application.dispose();
  }
  if (route && selectors[route]) {
    await page.locator(selectors[route]!).first().waitFor({ state: "visible", timeout: 90000 });
  } else {
    await page.locator("openclaw-app-shell").waitFor({ state: "visible", timeout: 90000 });
  }
  const readyAt = performance.now();
  if (values["no-rpc-observer"]) {
    return readyAt;
  }
  // Readiness is route-specific above; settle records the remaining admitted RPC work separately.
  await page.waitForFunction(
    () => {
      const rows = window.openclawRpcPayloads!;
      const answered = new Set(
        rows
          .filter((row) => row.direction === "response")
          .map((row) => `${row.socketId}:${row.id}`),
      );
      return (
        (rows.length === 0 || performance.now() - rows.at(-1)!.atMs > 350) &&
        rows.every(
          (row) => row.direction !== "request" || answered.has(`${row.socketId}:${row.id}`),
        )
      );
    },
    undefined,
    { timeout: 90000 },
  );
  return readyAt;
}
const provider = createHttpServer((request, response) => {
  request.resume();
  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = {
    id: "chatcmpl_synthetic_rpc",
    object: "chat.completion.chunk",
    created: 0,
    model: "synthetic-0",
  };
  let index = 0;
  const timer = setInterval(() => {
    if (index++ < 80) {
      response.write(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { content: "Synthetic streamed response. " }, finish_reason: null }] })}\n\n`,
      );
    } else {
      clearInterval(timer);
      response.end(
        `data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 80, total_tokens: 90 } })}\n\ndata: [DONE]\n\n`,
      );
    }
  }, 25);
  response.on("close", () => clearInterval(timer));
});
const report: {
  fixture: unknown;
  profile: string;
  entry: string;
  rpcObserver: boolean;
  observations: unknown[];
  errors: unknown[];
} = {
  fixture: JSON.parse(await readFile(path.join(root, "team-shape-summary.json"), "utf8")),
  profile: values.profile,
  entry,
  rpcObserver: !values["no-rpc-observer"],
  observations: [],
  errors: [],
};
try {
  await new Promise<void>((resolve) => {
    provider.listen(providerPort, "127.0.0.1", resolve);
  });
  const result = await waitForInitialProbe({
    port,
    path: "/readyz",
    startAt: performance.now(),
    deadlineAt: performance.now() + 300000,
    isDone: () => interrupted || child.exitCode !== null,
  });
  assert.equal(
    result.status,
    200,
    `Compiled Gateway did not start: ${path.join(output, "gateway.log")}`,
  );
  await new Promise<void>((resolve) => {
    proxy.listen(proxyPort, "127.0.0.1", resolve);
  });
  for (const engine of values.engines.split(",")) {
    if (interrupted) {
      break;
    }
    assert(engine === "chromium" || engine === "webkit");
    const engineName = engine === "webkit" ? "webkit" : "chromium";
    const browser = await (engine === "webkit"
      ? webkit.launch({ headless: true })
      : chromium.launch({
          headless: true,
          executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
        }));
    activeBrowser = browser;
    try {
      for (let sample = 0; sample < Number(values.samples); sample++) {
        if (interrupted) {
          break;
        }
        if (commandIterator) {
          console.log(`RPC_WORKER ready ${engine} ${sample}`);
          const command = await commandIterator.next();
          if (command.done) {
            break;
          }
          assert.equal(command.value, "sample");
        }
        const context = await browser.newContext({
          viewport: { width: 1440, height: 1000 },
          serviceWorkers: "block",
          ...(values.profile === "remote"
            ? { extraHTTPHeaders: { "x-forwarded-for": "198.51.100.10" } }
            : {}),
        });
        await context.addInitScript({ content: "globalThis.__name = (fn) => fn;" });
        if (!values["no-rpc-observer"]) {
          await context.addInitScript({
            content: `(${installControlUiRpcObserver.toString()})();`,
          });
        }
        await context.addInitScript(
          ({ identity: deviceIdentity, key: storageKey, token: sessionToken }) => {
            localStorage.setItem("openclaw-device-identity-v1", JSON.stringify(deviceIdentity));
            sessionStorage.setItem(storageKey, sessionToken);
          },
          {
            identity,
            token,
            key: `${CONTROL_UI_TOKEN_SESSION_KEY_PREFIX}${gatewayOriginScope(url.replace("http", "ws"))}`,
          },
        );
        const page = await context.newPage();
        page.on("pageerror", (error) => {
          report.errors.push({ engine, sample, error: error.message });
          console.error(`${engine} page error: ${error.message}`);
        });
        async function measure(name: string, action: () => Promise<unknown>, route?: RouteId) {
          await control("begin");
          const measurement = await startEngineMeasurement(page, engineName, {
            trace: values.trace,
          });
          const start = performance.now();
          let error: string | undefined;
          let readyAt: number | undefined;
          try {
            await action();
            readyAt = await ready(page, route);
            // Minimum window from action start; first readiness remains a separate metric.
            const remaining = Number(values["observe-ms"]) - (performance.now() - start);
            if (remaining > 0) {
              await page.waitForTimeout(remaining);
            }
          } catch (cause) {
            error = String(cause);
          }
          const settledMs = performance.now() - start;
          const metrics = await measurement.stop();
          const server = await control("end");
          const records = await page.evaluate(
            () => Reflect.get(window, "openclawRpcPayloads") ?? [],
          );
          const rendered = await page.evaluate(() => ({
            title: document.title,
            text: document.querySelector(".content")?.textContent?.slice(0, 300),
            rows: document.querySelectorAll(".cron-table__row,.data-table tbody tr,.plugins-item")
              .length,
          }));
          report.observations.push({
            engine,
            sample,
            name,
            metrics,
            readyMs: readyAt === undefined ? undefined : readyAt - start,
            settledMs,
            server,
            records,
            rendered,
            load: loadavg(),
            error,
          });
          await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
          if (values.screenshots && sample === 0) {
            await page.screenshot({ path: path.join(output, `${engine}-${name}.png`) });
          }
          console.log(
            `${engine} ${name}: ${settledMs.toFixed(1)} ms${error ? ` ERROR ${error}` : ""}`,
          );
          await page.evaluate(() => {
            if (window.openclawRpcPayloads) {
              window.openclawRpcPayloads.length = 0;
            }
          });
        }
        try {
          if (values["routes-only"]) {
            await page.goto(`${url}${pathForRoute(bootRoute)}`);
            await ready(page, bootRoute);
            await page.waitForTimeout(Number(values["prepare-ms"]));
            await page.evaluate(() => {
              if (window.openclawRpcPayloads) {
                window.openclawRpcPayloads.length = 0;
              }
            });
          } else {
            await measure(
              "cold-boot",
              () => page.goto(`${url}${pathForRoute(bootRoute)}`),
              bootRoute,
            );
            await page.waitForFunction(
              (storageKey) => localStorage.getItem(storageKey) !== null,
              `openclaw.control.bootRecord.v1:${gatewayCredentialScope(url.replace("http", "ws"))}`,
              { timeout: 60000 },
            );
            await measure("warm-boot", () => page.reload(), bootRoute);
          }
          for (const route of routes) {
            await page.evaluate((phase) => {
              Reflect.set(window, "openclawRpcPhase", phase);
            }, route);
            await measure(
              route,
              () =>
                evaluateControlUiContext(
                  page,
                  (app, targetRoute) => app.navigate(targetRoute),
                  route,
                ),
              route,
            );
          }
          await page.evaluate(() => {
            Reflect.set(window, "openclawRpcPhase", "idle");
          });
          if (Number(values["idle-ms"]) > 0) {
            await measure("idle", () => page.waitForTimeout(Number(values["idle-ms"])));
          }
          if (values.stream) {
            await evaluateControlUiContext(page, (app) => app.navigate("new-session"));
            await ready(page, "new-session");
            await page.evaluate(() => {
              if (window.openclawRpcPayloads) {
                window.openclawRpcPayloads.length = 0;
              }
              window.openclawRpcPhase = "streaming";
            });
            await measure("streaming", async () => {
              await page
                .locator(".new-session-page__message")
                .fill("Return the synthetic streamed response.");
              await page.locator(".new-session-page__message").press("Enter");
              await page
                .getByText("Synthetic streamed response.", { exact: false })
                .first()
                .waitFor({ timeout: 120000 });
              await page.waitForFunction(
                () =>
                  [...document.querySelectorAll(".chat-bubble:not(.streaming)")].some(
                    (bubble) =>
                      bubble.getAttribute("data-message-text")?.trim() ===
                        "Synthetic streamed response. ".repeat(80).trim() &&
                      (bubble
                        .querySelector(".chat-text")
                        ?.textContent?.match(/Synthetic streamed response\./g)?.length ?? 0) === 80,
                  ) && !document.querySelector(".chat-bubble.streaming"),
                undefined,
                { timeout: 120000 },
              );
            });
          }
        } catch (cause) {
          report.errors.push({ engine, sample, stage: "sample", error: String(cause) });
          await writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2));
          if (values.screenshots) {
            try {
              await page.screenshot({
                path: path.join(output, `${engine}-sample-error.png`),
                timeout: 5000,
              });
            } catch (error) {
              console.error(`${engine} error screenshot unavailable: ${String(error)}`);
            }
          }
          throw cause;
        } finally {
          await context.close();
        }
        if (commandIterator) {
          console.log(`RPC_WORKER done ${engine} ${sample}`);
        }
      }
    } finally {
      await browser.close();
      activeBrowser = undefined;
    }
  }
} finally {
  commands?.close();
  up.close();
  down.close();
  proxy.close();
  provider.closeAllConnections();
  provider.close();
  try {
    await stopGatewayGracefully(child, 30000);
  } finally {
    await stopChild(child);
    await rm(cacheRoot, { recursive: true, force: true });
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
  }
}

/** Three persistent isolated Gateways, one active sample at a time, rotating all positions. */
async function compare() {
  assert(values.output && values["compare-bundle-dir"]);
  const destination = path.resolve(values.output);
  await mkdir(destination, { recursive: false });
  const workers: {
    side: string;
    worker: ReturnType<typeof spawn>;
    wait: (marker: string) => Promise<void>;
    log: ReturnType<typeof createWriteStream>;
    lines: ReturnType<typeof createInterface>;
  }[] = [];
  const sides = ["base", "control", "head"] as const;
  const interruptWorkers = () => {
    process.exitCode = 130;
    for (const { worker } of workers) {
      worker.kill("SIGTERM");
    }
  };
  process.on("SIGINT", interruptWorkers);
  process.on("SIGTERM", interruptWorkers);
  try {
    for (const side of sides) {
      const childArgs = [
        "--output",
        path.join(destination, side),
        "--bundle-dir",
        path.resolve(side === "head" ? values["bundle-dir"] : values["compare-bundle-dir"]),
        "--entry",
        path.resolve(values.entry),
        "--engines",
        values.engines,
        "--routes",
        values.routes,
        "--samples",
        values.samples,
        "--profile",
        values.profile,
        "--boot-route",
        values["boot-route"],
        "--sessions",
        values.sessions,
        "--agents",
        values.agents,
        "--cron",
        values.cron,
        "--skills",
        values.skills,
        "--plugins",
        values.plugins,
        "--idle-ms",
        values["idle-ms"],
        "--controlled",
        ...(values.screenshots ? ["--screenshots"] : []),
        ...(values.trace ? ["--trace"] : []),
        ...(values.stream ? ["--stream"] : []),
        ...(values["routes-only"] ? ["--routes-only"] : []),
        ...(values["no-rpc-observer"] ? ["--no-rpc-observer"] : []),
        "--observe-ms",
        values["observe-ms"],
        "--prepare-ms",
        values["prepare-ms"],
      ];
      const worker = spawn(
        process.execPath,
        [...process.execArgv, fileURLToPath(import.meta.url), ...childArgs],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const workerLog = createWriteStream(path.join(destination, `${side}.log`));
      worker.stdout.pipe(workerLog);
      worker.stderr.pipe(workerLog);
      const lines = createInterface({ input: worker.stdout });
      const markers: string[] = [];
      let notify: (() => void) | undefined;
      let failure: Error | undefined;
      lines.on("line", (line) => {
        if (line.startsWith("RPC_WORKER ")) {
          markers.push(line);
          notify?.();
        }
      });
      worker.on("exit", (code) => {
        if (code !== 0) {
          failure = new Error(`${side} worker exited ${code}; inspect ${side}.log`);
        }
        notify?.();
      });
      const wait = async (marker: string) => {
        while (!markers.includes(marker)) {
          if (failure) {
            throw failure;
          }
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              notify = undefined;
              reject(new Error(`${side} timed out waiting for ${marker}`));
            }, 600000);
            notify = () => {
              clearTimeout(timer);
              notify = undefined;
              resolve();
            };
          });
        }
        markers.splice(markers.indexOf(marker), 1);
      };
      workers.push({ side, worker, wait, log: workerLog, lines });
    }
    const orders = [
      [0, 1, 2],
      [2, 0, 1],
      [1, 2, 0],
      [2, 1, 0],
      [0, 2, 1],
      [1, 0, 2],
    ];
    for (const engine of values.engines.split(",")) {
      for (let sample = 0; sample < Number(values.samples); sample++) {
        await Promise.all(
          workers.map((worker) => worker.wait(`RPC_WORKER ready ${engine} ${sample}`)),
        );
        for (const index of orders[sample % orders.length]!) {
          const worker = workers[index]!;
          worker.worker.stdin!.write("sample\n");
          await worker.wait(`RPC_WORKER done ${engine} ${sample}`);
        }
        console.log(`${engine} rotated triplet ${sample + 1}/${values.samples}`);
      }
    }
    await Promise.all(
      workers.map(
        ({ worker }) =>
          new Promise<void>((resolve, reject) => {
            if (worker.exitCode !== null || worker.signalCode !== null) {
              if (worker.exitCode === 0) {
                resolve();
              } else {
                reject(new Error("worker failed"));
              }
            } else {
              worker.once("exit", (code) =>
                code === 0 ? resolve() : reject(new Error(`worker failed: ${code}`)),
              );
            }
          }),
      ),
    );
  } finally {
    for (const { worker } of workers) {
      worker.stdin?.end();
    }
    await Promise.all(
      workers.map(async ({ worker, lines, log: workerLog }) => {
        if (worker.exitCode === null && worker.signalCode === null) {
          await new Promise<void>((resolve) => {
            worker.once("exit", () => resolve());
          });
        }
        lines.close();
        workerLog.end();
      }),
    );
    process.off("SIGINT", interruptWorkers);
    process.off("SIGTERM", interruptWorkers);
  }
}
