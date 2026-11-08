// node --import ./scripts/tsx.mjs scripts/bench-control-ui-hmr.mts --out-dir <dir> --samples 10
// Real Vite config and browser transport; only the page and source edits are synthetic.
import { randomUUID } from "node:crypto";
import { watch } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { createServer, type Plugin, type HMRPayload } from "vite";
import { resolvePlaywrightChromiumExecutablePath } from "../ui/src/test-helpers/playwright-chromium.ts";
import controlUiViteConfig from "../ui/vite.config.ts";

const { values } = parseArgs({
  options: {
    "out-dir": { type: "string" },
    samples: { type: "string", default: "10" },
    watcher: { type: "string", default: "default" },
    cold: { type: "boolean", default: false },
    "timeout-ms": { type: "string", default: "15000" },
  },
});
const count = Number(values.samples);
const timeout = Number(values["timeout-ms"]);
if (
  !values["out-dir"] ||
  !Number.isSafeInteger(count) ||
  count < 1 ||
  !Number.isSafeInteger(timeout) ||
  timeout < 1000 ||
  !["default", "fsevents", "fswatch", "polling"].includes(values.watcher)
) {
  throw new Error(
    "Pass --out-dir, positive --samples, and --watcher default|fsevents|fswatch|polling",
  );
}
const root = path.resolve(import.meta.dirname, "..");
const out = path.resolve(values["out-dir"]);
await fs.mkdir(out, { recursive: true });
const name = `dev-hmr-${randomUUID()}`;
const html = path.join(root, "ui", `${name}.html`);
const entry = path.join(root, "ui", `${name}.tsx`);
const targets = [
  { kind: "component", file: "ui/src/pages/chat/components/chat-conversation-loading.tsx" },
  { kind: "css", file: "ui/src/styles/chat/conversation-notices.css" },
  { kind: "store", file: "ui/src/lib/model-catalog-cache.ts" },
  { kind: "utility", file: "ui/src/lib/bytes-base64.ts" },
];
type Observation = {
  kind: string;
  iteration: number;
  save: "write" | "rename";
  load: number[];
  cpuMs?: number;
  fileEventMs?: number;
  watcherMs?: number;
  hotUpdateMs?: number;
  dispatchMs?: number;
  receivedMs?: number;
  appliedMs?: number;
  transforms: number;
  modules?: number;
  error?: string;
};
const observations: Observation[] = [];
let watcherInfo: { useFsEvents?: boolean; usePolling?: boolean; directories: number } | undefined;
let active: { file: string; start: number; sample: Observation } | undefined;
const mark = (key: "fileEventMs" | "watcherMs" | "hotUpdateMs" | "dispatchMs" | "receivedMs") => {
  if (active && active.sample[key] === undefined) {
    active.sample[key] = performance.now() - active.start;
  }
};
const matchesUpdate = (payload: HMRPayload) => {
  if (payload.type !== "update" || !active) {
    return false;
  }
  const url = "/" + path.relative(path.join(root, "ui"), active.file).split(path.sep).join("/");
  return payload.updates.some((update) => [update.path, update.acceptedPath].includes(url));
};
const probe: Plugin = {
  name: "dev-loop-measurement",
  enforce: "pre",
  configureServer(server) {
    server.watcher.on("change", (file) => {
      if (file === active?.file) {
        mark("watcherMs");
      }
    });
    const send = server.ws.send.bind(server.ws);
    server.ws.send = (payload: HMRPayload | string, data?: unknown) => {
      if (typeof payload === "string") {
        send(payload, data);
      } else {
        if (matchesUpdate(payload)) {
          mark("dispatchMs");
        }
        send(payload);
      }
    };
  },
  hotUpdate(options) {
    if (options.file === active?.file) {
      mark("hotUpdateMs");
      if (this.environment.name === "client") {
        active.sample.modules = options.modules.length;
      }
    }
  },
  transform(_code, id) {
    if (active && !id.includes("node_modules")) {
      active.sample.transforms++;
    }
  },
};
const config = controlUiViteConfig({ command: "serve" });
const server = await createServer({
  ...config,
  configFile: false,
  root: path.join(root, "ui"),
  optimizeDeps: { ...config.optimizeDeps, force: values.cold },
  server: {
    ...config.server,
    host: "127.0.0.1",
    port: 0,
    open: false,
    ...(values.watcher === "default"
      ? {}
      : {
          watch: {
            useFsEvents: values.watcher === "fsevents",
            usePolling: values.watcher === "polling",
          },
        }),
  },
  plugins: [probe, ...(config.plugins ?? [])],
});
const originals = new Map<string, string>();
const modified = new Map<string, string>();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  process.exitCode = 1;
  void browser?.close();
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
try {
  for (const target of targets) {
    originals.set(
      path.join(root, target.file),
      await fs.readFile(path.join(root, target.file), "utf8"),
    );
  }
  await fs.writeFile(
    html,
    `<!doctype html><body style="width:800px;--text:#222;--accent-subtle:#ddd"><main id="root"></main><script type="module" src="/${name}.tsx"></script>`,
    { flag: "wx" },
  );
  await fs.writeFile(
    entry,
    `
import { render } from "@solidjs/web";
import { ChatConversationLoading } from "./src/pages/chat/components/chat-conversation-loading.tsx";
import * as store from "./src/lib/model-catalog-cache.ts";
import * as utility from "./src/lib/bytes-base64.ts";
Reflect.set(window, "__hmrModules", [store, utility]);
render(() => <ChatConversationLoading route={true} />, document.getElementById("root")!);
import.meta.hot.accept(["./src/lib/model-catalog-cache.ts", "./src/lib/bytes-base64.ts"], () => {});
`,
    { flag: "wx" },
  );
  await server.listen();
  const address = server.httpServer!.address();
  if (!address || typeof address === "string") {
    throw new Error("Missing dev server address");
  }
  browser = await chromium.launch({
    executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
  });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    // SAFETY: this event is dispatched only by the synthetic source edit below.
    window.addEventListener("dev-hmr-applied", (event) =>
      Reflect.set(window, "__hmrApplied", (event as CustomEvent).detail),
    );
  });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("websocket", (socket) =>
    socket.on("framereceived", ({ payload }) => {
      // SAFETY: the socket belongs to this isolated Vite server.
      if (matchesUpdate(JSON.parse(String(payload)) as HMRPayload)) {
        mark("receivedMs");
      }
    }),
  );
  const connected = page.waitForEvent("websocket").then((socket) =>
    socket.waitForEvent("framereceived", {
      predicate: ({ payload }) => String(payload) === '{"type":"connected"}',
      timeout: 30_000,
    }),
  );
  await page.goto(`http://127.0.0.1:${address.port}/${name}.html`);
  await connected;
  await page.locator(".chat-conversation-loading__lines > span").first().waitFor();
  await server.waitForRequestsIdle();
  watcherInfo = {
    useFsEvents: server.watcher.options.useFsEvents,
    usePolling: server.watcher.options.usePolling,
    directories: Object.keys(server.watcher.getWatched()).length,
  };
  await page.evaluate(() => {
    Reflect.set(window, "__documentRetained", true);
  });
  for (let iteration = 0; iteration < count; iteration++) {
    for (const target of targets) {
      if (interrupted) {
        throw new Error("Benchmark interrupted");
      }
      const file = path.join(root, target.file);
      const original = originals.get(file)!;
      if ((await fs.readFile(file, "utf8")) !== original) {
        throw new Error(`Concurrent edit: ${target.file}`);
      }
      const sample: Observation = {
        kind: target.kind,
        iteration,
        save: iteration % 2 === 0 ? "write" : "rename",
        load: os.loadavg(),
        transforms: 0,
      };
      observations.push(sample);
      const token = `${name}-${iteration}-${target.kind}`;
      const edited =
        target.kind === "component"
          ? original.replace("widths={[82, 53]}", "widths={[42, 53]}")
          : target.kind === "css"
            ? `${original}\nbody { --dev-hmr-token: "${token}"; }\n`
            : `${original}\nglobalThis.dispatchEvent(new CustomEvent("dev-hmr-applied", { detail: "${token}" }));\n`;
      if (edited === original) {
        throw new Error("Component workload no longer matches source");
      }
      await page.evaluate(() => Reflect.set(window, "__hmrApplied", ""));
      const watcher = watch(file, () => mark("fileEventMs"));
      const cpu = process.cpuUsage();
      active = { file, start: performance.now(), sample };
      modified.set(file, edited);
      try {
        if (sample.save === "rename") {
          const temporary = `${file}.${name}`;
          try {
            await fs.writeFile(temporary, edited, { flag: "wx" });
            await fs.rename(temporary, file);
          } finally {
            await fs.rm(temporary, { force: true });
          }
        } else {
          await fs.writeFile(file, edited);
        }
        await page.waitForFunction(
          ({ kind, token: expectedToken }) => {
            if (kind === "css") {
              return getComputedStyle(document.body)
                .getPropertyValue("--dev-hmr-token")
                .includes(expectedToken);
            }
            if (kind !== "component") {
              return Reflect.get(window, "__hmrApplied") === expectedToken;
            }
            const span = document.querySelector<HTMLElement>(
              ".chat-conversation-loading__lines > span",
            );
            return span?.style.width === "42%";
          },
          { kind: target.kind, token },
          { timeout, polling: "raf" },
        );
        sample.appliedMs = performance.now() - active.start;
        if (!(await page.evaluate(() => Reflect.get(window, "__documentRetained")))) {
          throw new Error("Full document reload");
        }
        if (errors.length) {
          throw new Error(errors.join("; "));
        }
      } catch (error) {
        sample.error = String(error);
        process.exitCode = 1;
      } finally {
        const used = process.cpuUsage(cpu);
        sample.cpuMs = (used.user + used.system) / 1000;
        active = undefined;
        watcher.close();
        if ((await fs.readFile(file, "utf8")) !== edited) {
          sample.error = `Concurrent edit: ${target.file}; not restoring`;
          process.exitCode = 1;
          interrupted = true;
        } else {
          await fs.writeFile(file, original);
          modified.delete(file);
          // Wait for the restored module to be served before the next measured save.
          server.environments.client.moduleGraph.invalidateAll();
          await page.reload();
          await page.locator(".chat-conversation-loading__lines > span").first().waitFor();
          await page.waitForFunction(
            () =>
              document.querySelector<HTMLElement>(".chat-conversation-loading__lines > span")?.style
                .width === "82%",
          );
          await server.waitForRequestsIdle();
          await page.evaluate(() => Reflect.set(window, "__documentRetained", true));
        }
      }
      console.log(JSON.stringify(sample));
    }
  }
} finally {
  await browser?.close();
  await server.close();
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  for (const [file, edited] of modified) {
    if ((await fs.readFile(file, "utf8")) === edited) {
      await fs.writeFile(file, originals.get(file)!);
    }
  }
  await fs.rm(html, { force: true });
  await fs.rm(entry, { force: true });
  await fs.writeFile(
    path.join(out, "report.json"),
    JSON.stringify(
      { watcher: values.watcher, watcherInfo, cold: values.cold, observations },
      null,
      2,
    ) + "\n",
  );
}
