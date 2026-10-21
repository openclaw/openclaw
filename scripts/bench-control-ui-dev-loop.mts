// node --import ./scripts/tsx.mjs scripts/bench-control-ui-dev-loop.mts --label baseline --out-dir <proof-dir>
// Bounded development-only workload: real chat skeleton, actual ui:dev, visible HMR.
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { resolvePlaywrightChromiumExecutablePath } from "../ui/src/test-helpers/playwright-chromium.ts";
import { createPnpmRunnerSpawnSpec } from "./pnpm-runner.mts";

const { values } = parseArgs({
  options: {
    label: { type: "string", default: "sample" },
    "out-dir": { type: "string" },
    mode: { type: "string", default: "both" },
  },
});
if (!values["out-dir"]) {
  throw new Error("Pass --out-dir; each invocation retains its own report and screenshots.");
}
if (!["both", "cold", "warm"].includes(values.mode)) {
  throw new Error("--mode must be both, cold, or warm");
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const output = path.resolve(values["out-dir"], `${values.label}-${Date.now()}`);
await fs.mkdir(output, { recursive: true });
const name = `dev-loop-bench-${randomUUID()}`;
const html = path.join(root, "ui", `${name}.html`);
const entry = path.join(root, "ui", `${name}.tsx`);
const component = path.join(root, "ui/src/pages/chat/components/chat-conversation-loading.tsx");
const original = await fs.readFile(component, "utf8");
const edited = original.replace("widths={[82, 53]}", "widths={[42, 53]}");
if (edited === original) {
  throw new Error("Chat skeleton workload changed: update the explicit 82% → 42% edit.");
}
const browser = await chromium.launch({
  executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
});
const samples: Array<{
  mode: string;
  readyMs?: number;
  renderedMs?: number;
  visibleHmrMs?: number;
  beforeWidth?: number;
  afterWidth?: number;
  error?: string;
  fileEvents: number;
  socketMessages: string[];
  loadAverage: number[];
}> = [];
try {
  await fs.writeFile(
    html,
    `<!doctype html><html><body style="width:800px;--text:#222;--accent-subtle:#ddd"><main id="root"></main><script type="module" src="/${name}.tsx"></script></body></html>`,
    { flag: "wx" },
  );
  await fs.writeFile(
    entry,
    'import { render } from "@solidjs/web";\n' +
      'import { ChatConversationLoading } from "./src/pages/chat/components/chat-conversation-loading.tsx";\n' +
      'render(() => <ChatConversationLoading route={true} />, document.getElementById("root")!);\n',
    { flag: "wx" },
  );
  for (const mode of values.mode === "both" ? ["cold", "warm"] : [values.mode]) {
    const sample: (typeof samples)[number] = {
      mode,
      fileEvents: 0,
      socketMessages: [],
      loadAverage: os.loadavg(),
    };
    samples.push(sample);
    const reservation = createServer();
    reservation.listen(0, "127.0.0.1");
    await once(reservation, "listening");
    const address = reservation.address();
    if (!address || typeof address === "string") {
      throw new Error("No isolated dev-server port");
    }
    const port = address.port;
    await new Promise<void>((resolve) => {
      reservation.close(() => resolve());
    });
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
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    page.setDefaultTimeout(120_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("websocket", (socket) =>
      socket.on("framereceived", ({ payload }) => {
        sample.socketMessages.push(String(payload));
      }),
    );
    const watcher = watch(component, () => sample.fileEvents++);
    try {
      const deadline = performance.now() + 600_000;
      while (true) {
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
      await page.goto(`http://127.0.0.1:${port}/${name}.html`, { timeout: 120_000 });
      const selector = ".chat-conversation-loading__lines > span:first-child";
      await page.locator(selector).first().waitFor({ state: "visible" });
      sample.renderedMs = performance.now() - started;
      const width = await page
        .locator(selector)
        .first()
        .evaluate((node) => node.getBoundingClientRect().width);
      sample.beforeWidth = width;
      await page.screenshot({ path: path.join(output, `${mode}-before.png`) });
      await page.evaluate(() => Reflect.set(window, "__devLoopDocument", "retained"));
      const beforeEdit = await fs.readFile(component, "utf8");
      if (beforeEdit !== original) {
        throw new Error("Component changed concurrently; refusing benchmark edit.");
      }
      const editStarted = performance.now();
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
      await page.screenshot({ path: path.join(output, `${mode}-after.png`) });
      if (errors.length > 0) {
        throw new Error(`Browser errors: ${errors.join("; ")}`);
      }
    } catch (error) {
      sample.error = String(error);
      process.exitCode = 1;
    } finally {
      watcher.close();
      const current = await fs.readFile(component, "utf8");
      if (current === edited) {
        await fs.writeFile(component, original);
      } else if (current !== original) {
        console.error(
          "Component changed concurrently; retained external edit instead of restoring.",
        );
      }
      await page.close();
      if (child.exitCode === null && child.signalCode === null && child.pid) {
        // Signal only this workload's private process group, including pnpm and Vite.
        if (process.platform === "win32") {
          child.kill("SIGTERM");
        } else {
          process.kill(-child.pid, "SIGTERM");
        }
      }
      await closed;
      await fs.writeFile(path.join(output, `${mode}-server.log`), log);
    }
  }
} finally {
  await browser.close();
  await Promise.all([fs.rm(html, { force: true }), fs.rm(entry, { force: true })]);
  const report = {
    label: values.label,
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    hardware: {
      platform: os.platform(),
      arch: os.arch(),
      cpu: os.cpus()[0]?.model,
      cpus: os.cpus().length,
    },
    workload:
      "pnpm ui:dev; cold --force optimizer, warm unchanged cache; real chat skeleton 82% → 42% width edit",
    limitations:
      "One bounded sample per mode on shared host; fixture render is not full app boot; HMR includes write-to-browser assertion overhead.",
    samples,
  };
  await fs.writeFile(path.join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ output, ...report }, null, 2));
}
