// node --import ./scripts/tsx.mjs scripts/bench-control-ui-dev-loop.mts --out-dir <proof-dir> --samples 5 --mode warm
// Bounded development-only workload: real chat skeleton, actual ui:dev, visible HMR.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { watch, type FSWatcher } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium, type Browser, type Page } from "playwright";
import { resolvePlaywrightChromiumExecutablePath } from "../ui/src/test-helpers/playwright-chromium.ts";
import { createPnpmRunnerSpawnSpec } from "./pnpm-runner.mts";

const { values } = parseArgs({
  options: {
    label: { type: "string", default: "sample" },
    "out-dir": { type: "string" },
    mode: { type: "string", default: "both" },
    root: { type: "string" },
    samples: { type: "string", default: "1" },
    "startup-only": { type: "boolean", default: false },
  },
});
if (!values["out-dir"]) {
  throw new Error("Pass --out-dir; each invocation retains its own report and screenshots.");
}
if (!["both", "cold", "warm"].includes(values.mode)) {
  throw new Error("--mode must be both, cold, or warm");
}
const count = Number(values.samples);
if (!Number.isSafeInteger(count) || count < 1) {
  throw new Error("--samples must be a positive integer");
}
const root = values.root
  ? path.resolve(values.root)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(values["out-dir"], `${values.label}-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
const name = `dev-loop-bench-${randomUUID()}`;
const html = path.join(root, "ui", `${name}.html`);
const entry = path.join(root, "ui", `${name}.tsx`);
const component = path.join(root, "ui/src/pages/chat/components/chat-conversation-loading.tsx");
const samples: Array<{
  index: number;
  mode: string;
  readyMs?: number;
  renderedMs?: number;
  visibleHmrMs?: number;
  beforeWidth?: number;
  afterWidth?: number;
  error?: string;
  socketConnectedMs?: number;
  fileEvents: number;
  socketMessages: string[];
  loadAverage: number[];
}> = [];
const errors: string[] = [];
let revision: string | undefined;
let original = "";
let edited = "";
let browser: Browser | undefined;
let browserClosing: Promise<void> | undefined;
let htmlCreated = false;
let entryCreated = false;
let interruption: Error | undefined;
let stopCurrentChild: (() => void) | undefined;
const failed = (error: unknown) => {
  errors.push(String(error));
  process.exitCode = 1;
};
const closeBrowser = () => {
  if (browser) {
    browserClosing ??= browser.close().catch(failed);
  }
  return browserClosing;
};
const ensureRunning = () => {
  if (interruption) {
    throw interruption;
  }
};
const interrupt = (signal: string) => {
  if (interruption) {
    return;
  }
  interruption = new Error(`Interrupted by ${signal}`);
  failed(interruption);
  stopCurrentChild?.();
  void closeBrowser();
};
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
try {
  revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  if (!values["startup-only"]) {
    original = await fs.readFile(component, "utf8");
    edited = original.replace("widths={[82, 53]}", "widths={[42, 53]}");
    if (edited === original) {
      throw new Error("Chat skeleton workload changed: update the explicit 82% → 42% edit.");
    }
    // Reuse these fixture paths for every sample so optimizer inputs stay unchanged.
    await fs.writeFile(
      html,
      `<!doctype html><html><body style="width:800px;--text:#222;--accent-subtle:#ddd"><main id="root"></main><script type="module" src="/${name}.tsx"></script></body></html>`,
      { flag: "wx" },
    );
    htmlCreated = true;
    await fs.writeFile(
      entry,
      'import { render } from "@solidjs/web";\n' +
        'import { ChatConversationLoading } from "./src/pages/chat/components/chat-conversation-loading.tsx";\n' +
        'render(() => <ChatConversationLoading route={true} />, document.getElementById("root")!);\n',
      { flag: "wx" },
    );
    entryCreated = true;
    browser = await chromium.launch({
      executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
    });
  }
  for (let index = 1; index <= count; index++) {
    for (const mode of values.mode === "both" ? ["cold", "warm"] : [values.mode]) {
      ensureRunning();
      const sample: (typeof samples)[number] = {
        index,
        mode,
        fileEvents: 0,
        socketMessages: [],
        loadAverage: os.loadavg(),
      };
      samples.push(sample);
      console.log(`[dev-loop] ${values.label} ${mode} ${index}/${count}: starting ${root}`);
      const port = await reservePort();
      ensureRunning();
      const started = performance.now();
      const call = createPnpmRunnerSpawnSpec({
        pnpmArgs: [
          "ui:dev",
          "--host",
          "127.0.0.1",
          "--port",
          String(port),
          ...(mode === "cold" ? ["--force"] : []),
        ],
        cwd: root,
        detached: process.platform !== "win32",
        env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1", NO_COLOR: "1", DEBUG: "vite:hmr" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const child = spawn(call.command, call.args, call.options);
      const closed = new Promise<void>((resolve) => {
        child.once("close", () => resolve());
      });
      let spawnError: Error | undefined;
      child.on("error", (error) => {
        spawnError = error;
      });
      let log = "";
      let readyMs: number | undefined;
      const capture = (data: Buffer) => {
        log += data.toString();
        if (readyMs === undefined && /Local:\s+http/u.test(log)) {
          readyMs = performance.now() - started;
          sample.readyMs = readyMs;
          console.log(
            `[dev-loop] ${values.label} ${mode} ${index}/${count}: ready in ${readyMs.toFixed(1)} ms`,
          );
        }
      };
      child.stdout?.on("data", capture);
      child.stderr?.on("data", capture);
      let page: Page | undefined;
      let watcher: FSWatcher | undefined;
      let componentWasEdited = false;
      const stopChild = () => {
        if (child.exitCode === null && child.signalCode === null && child.pid) {
          // Signal only this workload's private process group, including pnpm and Vite.
          try {
            if (process.platform === "win32") {
              child.kill("SIGTERM");
            } else {
              process.kill(-child.pid, "SIGTERM");
            }
          } catch (error) {
            if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
              failed(error);
            }
          }
        }
      };
      stopCurrentChild = stopChild;
      try {
        const deadline = performance.now() + 600_000;
        while (true) {
          ensureRunning();
          if (readyMs !== undefined) {
            break;
          }
          if (
            spawnError ||
            child.exitCode !== null ||
            child.signalCode !== null ||
            performance.now() > deadline
          ) {
            throw spawnError ?? new Error(`Dev server did not become ready: ${log}`);
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 25);
          });
        }
        if (!browser) {
          continue;
        }
        page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
        page.setDefaultTimeout(120_000);
        const browserErrors: string[] = [];
        let socketConnected = false;
        page.on("pageerror", (error) => browserErrors.push(error.message));
        page.on("websocket", (socket) =>
          socket.on("framereceived", ({ payload }) => {
            const message = String(payload);
            sample.socketMessages.push(message);
            if (message === '{"type":"connected"}') {
              socketConnected = true;
              sample.socketConnectedMs = performance.now() - started;
            }
          }),
        );
        watcher = watch(component, () => sample.fileEvents++);
        await page.goto(`http://127.0.0.1:${port}/${name}.html`, { timeout: 120_000 });
        const selector = ".chat-conversation-loading__lines > span:first-child";
        await page.locator(selector).first().waitFor({ state: "visible" });
        sample.renderedMs = performance.now() - started;
        const width = await page
          .locator(selector)
          .first()
          .evaluate((node) => node.getBoundingClientRect().width);
        sample.beforeWidth = width;
        await page.screenshot({ path: path.join(output, `${mode}-${index}-before.png`) });
        await page.evaluate(() => Reflect.set(window, "__devLoopDocument", "retained"));
        const socketDeadline = performance.now() + 30_000;
        while (true) {
          ensureRunning();
          if (socketConnected) {
            break;
          }
          if (performance.now() > socketDeadline) {
            throw new Error("Vite WebSocket did not connect before the component edit.");
          }
          await new Promise((resolve) => {
            setTimeout(resolve, 25);
          });
        }
        const beforeEdit = await fs.readFile(component, "utf8");
        if (beforeEdit !== original) {
          throw new Error("Component changed concurrently; refusing benchmark edit.");
        }
        ensureRunning();
        const editStarted = performance.now();
        componentWasEdited = true;
        await fs.writeFile(component, edited);
        await page.waitForFunction(
          ({ selector: targetSelector, width: originalWidth }) => {
            const node = document.querySelector(targetSelector);
            return node !== null && node.getBoundingClientRect().width < originalWidth * 0.75;
          },
          { selector, width },
          { polling: "raf", timeout: 30_000 },
        );
        sample.visibleHmrMs = performance.now() - editStarted;
        if ((await page.evaluate(() => Reflect.get(window, "__devLoopDocument"))) !== "retained") {
          throw new Error("Component edit reloaded the document instead of applying HMR.");
        }
        sample.afterWidth = await page
          .locator(selector)
          .first()
          .evaluate((node) => node.getBoundingClientRect().width);
        await page.screenshot({ path: path.join(output, `${mode}-${index}-after.png`) });
        if (browserErrors.length > 0) {
          throw new Error(`Browser errors: ${browserErrors.join("; ")}`);
        }
      } catch (error) {
        sample.error = String(interruption ?? error);
        process.exitCode = 1;
      } finally {
        watcher?.close();
        if (componentWasEdited) {
          try {
            const current = await fs.readFile(component, "utf8");
            if (current === edited) {
              await fs.writeFile(component, original);
            } else if (current !== original) {
              failed(
                new Error(
                  "Component changed concurrently; retained external edit instead of restoring.",
                ),
              );
            }
          } catch (error) {
            failed(error);
          }
        }
        await page?.close().catch(failed);
        stopChild();
        await closed;
        stopCurrentChild = undefined;
        await fs.writeFile(path.join(output, `${mode}-${index}-server.log`), log);
        console.log(
          `[dev-loop] ${values.label} ${mode} ${index}/${count}: ${sample.error ? "failed" : "complete"}`,
        );
      }
    }
  }
} catch (error) {
  if (error !== interruption) {
    failed(error);
  }
} finally {
  await closeBrowser();
  for (const fixture of [...(htmlCreated ? [html] : []), ...(entryCreated ? [entry] : [])]) {
    await fs.rm(fixture, { force: true }).catch(failed);
  }
  const report = {
    label: values.label,
    root,
    revision,
    requestedSamplesPerMode: count,
    mode: values.mode,
    startupOnly: values["startup-only"],
    interruption: interruption?.message,
    fixture: values["startup-only"] ? undefined : html,
    hardware: {
      platform: os.platform(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model,
      cpus: os.cpus().length,
    },
    workload:
      "pnpm ui:dev; cold --force optimizer, warm unchanged cache" +
      (values["startup-only"] ? "; readiness only" : "; real chat skeleton 82% → 42% width edit"),
    limitations:
      "Bounded samples on a shared host; readiness is not full app boot; fixture render is not full app boot; HMR includes write-to-browser assertion overhead.",
    errors,
    samples,
  };
  await fs.writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, ...report }, null, 2));
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
}

async function reservePort() {
  const reservation = createServer();
  try {
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") {
      throw new Error("No isolated dev-server port");
    }
    return address.port;
  } finally {
    await new Promise<void>((resolve) => {
      reservation.close(() => resolve());
    });
  }
}
