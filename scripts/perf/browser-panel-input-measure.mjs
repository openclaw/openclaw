// Run: PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/path/to/supported/chrome \
// node --import ./scripts/tsx.mjs scripts/perf/browser-panel-input-measure.mjs
// Prepare the production runtime first: pnpm build:runtime (retain the configured heap limit).
// Workload: 80 characters at 6/10 cps, five cold and five warm sequences per rate,
// with native controls. Compare queue growth and input-to-DOM/frame latency while
// preserving text, order, focus and policy settlement. See README.md for scope,
// controls, limitations and the pending historical owner decision.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright";
import { bindInheritedNativeProcessOwner } from "../../src/process/supervisor/inherited-process-lineage.ts";
import { createOpenClawTestInstance } from "../../test/helpers/openclaw-test-instance.ts";
import { isControlUiBrowserSupported } from "../../ui/src/app/browser-capabilities.ts";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";

const text = "abcdefghijklmnopqrstuvwxyz".repeat(4).slice(0, 80);
const samples = [];
const smoke = process.argv.includes("--smoke");
// Attribution only: one cold sequence, kept separate from the unprofiled acceptance run.
const profile = process.argv.includes("--profile");
assert(!(smoke && profile), "Choose either smoke or profiling");
// Resume interrupted acceptance runs, or select one pair for serial ABAB comparisons.
const rateArg = process.argv.find((arg) => arg.startsWith("--rate="))?.split("=")[1];
const sampleArg = process.argv.find((arg) => arg.startsWith("--sample="))?.split("=")[1];
const fromArg = process.argv.find((arg) => arg.startsWith("--from-sample="))?.split("=")[1];
assert(rateArg === undefined || ["6", "10"].includes(rateArg), "--rate must be 6 or 10");
assert(sampleArg === undefined || /^[0-4]$/.test(sampleArg), "--sample must be 0 through 4");
assert(fromArg === undefined || /^[0-4]$/.test(fromArg), "--from-sample must be 0 through 4");
assert(!(sampleArg && fromArg), "Choose --sample or --from-sample");
assert(!(profile && (rateArg || sampleArg || fromArg)), "Profiling owns its sample selection");
const rates = profile ? [10] : rateArg ? [Number(rateArg)] : [6, 10];
const sampleIndexes = profile
  ? [0]
  : sampleArg
    ? [Number(sampleArg)]
    : [0, 1, 2, 3, 4].filter((index) => index >= Number(fromArg ?? 0));
const now = () => performance.timeOrigin + performance.now();
const quantile = (items, fraction) =>
  items.toSorted((a, b) => a - b)[Math.ceil(items.length * fraction) - 1] ?? null;

async function installProbe(page) {
  await page.addInitScript(() => {
    const probeNow = () => performance.timeOrigin + performance.now();
    const probe = (window.typingProbe = { keys: [], requests: [], frames: [], binaryFrames: 0 });
    const pending = new Map();
    const Original = window.WebSocket;
    window.WebSocket = class extends Original {
      constructor(...args) {
        super(...args);
        this.addEventListener("message", (event) => {
          if (typeof event.data !== "string") {
            probe.binaryFrames++;
            return;
          }
          const frame = JSON.parse(event.data);
          if (frame.type === "res" && pending.has(frame.id)) {
            const entry = pending.get(frame.id);
            entry.finish = probeNow();
            entry.ok = frame.ok;
            pending.delete(frame.id);
          }
        });
      }
      send(data) {
        if (typeof data === "string") {
          const frame = JSON.parse(data);
          if (frame.method === "browser.request") {
            const entry = { id: frame.id, params: frame.params, start: probeNow() };
            probe.requests.push(entry);
            pending.set(frame.id, entry);
          }
        }
        return super.send(data);
      }
    };
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.target.matches?.(".bp-input")) {
          probe.keys.push({ key: e.key, at: probeNow() });
        }
      },
      true,
    );
    document.addEventListener(
      "load",
      (e) => {
        if (!e.target.matches?.(".bp-shot")) {
          return;
        }
        const image = e.target;
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            if (!image.complete || !image.naturalWidth) {
              return;
            }
            const canvas = document.createElement("canvas");
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const ctx = canvas.getContext("2d");
            ctx.drawImage(image, 0, 0);
            let length = 0;
            for (let i = 0; i < 7; i++) {
              if (ctx.getImageData(10 + i * 20, 20, 1, 1).data[0] < 128) {
                length |= 1 << i;
              }
            }
            probe.frames.push({ length, at: probeNow() });
          }),
        );
      },
      true,
    );
  });
}

async function measureNative(page, rate, mode, sample, url) {
  await page.bringToFront();
  if (mode === "cold") {
    await page.goto(url);
  }
  await page.evaluate(() => {
    field.value = "";
    samples.length = 0;
    paint();
    window.nativeKeys = [];
    window.nativeFrames = [];
  });
  await page.locator("#field").focus();
  if (mode === "cold") {
    // Install once per document; warm sequences reset the arrays above.
    await page.evaluate(() => {
      const field = document.querySelector("#field");
      field.addEventListener("keydown", (e) => {
        window.nativeKeys.push({ key: e.key, at: performance.timeOrigin + performance.now() });
      });
      field.addEventListener("input", () => {
        const length = field.value.length;
        requestAnimationFrame(() =>
          requestAnimationFrame(() =>
            window.nativeFrames.push({ length, at: performance.timeOrigin + performance.now() }),
          ),
        );
      });
    });
  }
  await page.keyboard.type(text, { delay: 1000 / rate });
  await page.waitForFunction(() => window.nativeFrames.some((f) => f.length === 80));
  const probe = await page.evaluate(() => ({
    keys: window.nativeKeys,
    frames: window.nativeFrames,
    events: samples,
    value: field.value,
  }));
  assert.equal(probe.value, text);
  assert.deepEqual(
    probe.keys.map((e) => e.key),
    text.split(""),
  );
  assert.deepEqual(
    probe.events.map((e) => e.data),
    text.split(""),
  );
  const rows = probe.keys.map((key, i) => ({
    key: key.key,
    enqueue: key.at,
    dom: probe.events[i].at,
    visible: probe.frames.find((f) => f.length >= i + 1).at,
  }));
  const metrics = {};
  for (const [name, from, to] of [
    ["inputToDom", "enqueue", "dom"],
    ["domToVisible", "dom", "visible"],
    ["inputToVisible", "enqueue", "visible"],
  ]) {
    const values = rows.map((r) => r[to] - r[from]);
    metrics[name] = {
      p50: quantile(values, 0.5),
      p95: quantile(values, 0.95),
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
    };
  }
  samples.push({ native: true, rate, mode, sample, metrics, rows, probe });
  await fs.writeFile(path.join(output, "measurements.json"), JSON.stringify(samples, null, 2));
  console.log(JSON.stringify({ native: true, rate, mode, sample, metrics }));
}

async function measure(page, remote, rate, mode, sample) {
  await page.bringToFront();
  await remote.evaluate(() => {
    field.value = "";
    samples.length = 0;
    paint();
  });
  const shot = page.locator("section.bp .bp-shot");
  const box = await shot.boundingBox();
  assert(box);
  const size = await shot.evaluate((image) => ({
    width: image.naturalWidth,
    height: image.naturalHeight,
  }));
  await page.locator(".bp-input").click({
    position: { x: (100 * box.width) / size.width, y: (110 * box.height) / size.height },
  });
  await remote.waitForFunction(() => document.activeElement.id === "field");
  // Focus request must settle before starting the typing interval.
  await page.waitForFunction(() => window.typingProbe.requests.every((r) => r.finish));
  await page.evaluate(() => {
    const p = window.typingProbe;
    p.keys = [];
    p.requests = [];
    p.frames = [];
    p.binaryFrames = 0;
  });
  await page.keyboard.type(text, { delay: 1000 / rate });
  const typedAt = now();
  await remote.waitForFunction((expected) => field.value === expected, text, { timeout: 60_000 });
  await page.waitForFunction(() => window.typingProbe.requests.every((r) => r.finish), undefined, {
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => window.typingProbe.frames.some((f) => f.length === 80),
    undefined,
    { timeout: 20_000 },
  );
  const probe = await page.evaluate(() => window.typingProbe);
  const dom = await remote.evaluate(() => ({
    events: samples,
    value: field.value,
    focus: document.activeElement.id,
  }));
  assert.equal(dom.value, text);
  assert.equal(dom.focus, "field");
  assert.deepEqual(
    dom.events.map((e) => e.data),
    text.split(""),
  );
  assert.deepEqual(
    probe.keys.map((k) => k.key),
    text.split(""),
  );
  const actions = probe.requests.filter(
    (r) => r.params.path === "/act" && ["press", "insertText"].includes(r.params.body?.kind),
  );
  assert.equal(actions.length, text.length);
  assert.equal(probe.requests.length, text.length);
  assert(actions.every((r) => r.ok));
  assert(
    dom.events.every((e) => e.focus === "field"),
    "Focus retained for every input event",
  );
  const rows = probe.keys.map((key, i) => {
    const frame = probe.frames.find((f) => f.length >= i + 1);
    return {
      key: key.key,
      enqueue: key.at,
      start: actions[i]?.start,
      finish: actions[i]?.finish,
      dom: dom.events[i]?.at,
      visible: frame?.at,
    };
  });
  assert(
    rows.every((r) => [r.enqueue, r.start, r.finish, r.dom, r.visible].every(Number.isFinite)),
    "Every keystroke has all five measured timestamps",
  );
  let depth = 0,
    maxQueueDepth = 0;
  const changes = rows
    .flatMap((r) => [
      { at: r.enqueue, change: 1 },
      ...(r.start ? [{ at: r.start, change: -1 }] : []),
    ])
    .toSorted((a, b) => a.at - b.at || b.change - a.change);
  for (const c of changes) {
    depth += c.change;
    maxQueueDepth = Math.max(maxQueueDepth, depth);
  }
  const metrics = {};
  for (const [name, from, to] of [
    ["queue", "enqueue", "start"],
    ["request", "start", "finish"],
    ["requestToDom", "start", "dom"],
    ["inputToDom", "enqueue", "dom"],
    ["domToVisible", "dom", "visible"],
    ["inputToVisible", "enqueue", "visible"],
  ]) {
    const values = rows
      .filter((r) => r[from] !== undefined && r[to] !== undefined)
      .map((r) => r[to] - r[from]);
    metrics[name] = {
      p50: quantile(values, 0.5),
      p95: quantile(values, 0.95),
      min: Math.min(...values),
      max: Math.max(...values),
      count: values.length,
    };
  }
  const result = {
    rate,
    mode,
    sample,
    metrics,
    maxQueueDepth,
    drainMs: Math.max(0, rows.at(-1).finish - typedAt),
    requests: probe.requests.length,
    actions: actions.length,
    frames: probe.frames.length,
    binaryFrames: probe.binaryFrames,
    rows,
    dom,
    probe,
  };
  samples.push(result);
  await fs.writeFile(path.join(output, "measurements.json"), JSON.stringify(samples, null, 2));
  console.log(
    JSON.stringify({
      rate,
      mode,
      sample,
      metrics,
      maxQueueDepth,
      drainMs: result.drainMs,
      actions: actions.length,
    }),
  );
}

const output = createControlUiE2eArtifactDir("browser-input");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
assert(executablePath, "Select the installed Chromium explicitly");
// Fail at the actual UI admission boundary before creating a Gateway or remote profile.
const preflightBrowser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await preflightBrowser.newPage();
  const capabilities = {
    browser: preflightBrowser.version(),
    supported: await page.evaluate(isControlUiBrowserSupported),
    features: await page.evaluate(() => ({
      anchorName: CSS.supports("anchor-name: --a"),
      popover: typeof HTMLElement.prototype.showPopover === "function",
      commandForElement: "commandForElement" in HTMLButtonElement.prototype,
    })),
  };
  await fs.writeFile(path.join(output, "capabilities.json"), JSON.stringify(capabilities, null, 2));
  assert(
    capabilities.supported,
    `Control UI rejects this browser: ${JSON.stringify(capabilities)}`,
  );
} finally {
  await preflightBrowser.close();
}
// Linux custody requires a built, loader-free owner even when this probe uses tsx.
const nativeOwner = path.resolve("dist/process/supervisor/service-child-group-anchor.js");
await fs.access(nativeOwner);
const releaseNativeOwner = bindInheritedNativeProcessOwner(pathToFileURL(nativeOwner).href);
const instance = await createOpenClawTestInstance({
  name: "browser-input-pilot",
  ...(profile
    ? {
        gatewayCommandPrefix: [process.execPath, "--cpu-prof", `--cpu-prof-dir=${output}`],
      }
    : {}),
  config: {
    gateway: { controlUi: { enabled: true } },
    browser: {
      enabled: true,
      executablePath,
      headless: true,
      noSandbox: true,
      ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
    },
    plugins: { allow: ["browser"], entries: { browser: { enabled: true } } },
  },
  env: {
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: undefined,
    OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    OPENCLAW_DISABLE_BONJOUR: "1",
  },
});
let browser;
let remoteBrowser;
const fixture = createServer((_req, res) => {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>Typing measurement</title><style>
body{margin:0;background:white;color:black}input{position:absolute;left:20px;top:80px;width:500px;height:60px;font:24px monospace}
canvas{position:absolute;left:0;top:0}</style><canvas width="160" height="40"></canvas><input id="field" aria-label="Controlled text"><input id="other" style="top:180px" aria-label="Other field">
<script>
window.samples=[]; const field=document.querySelector('#field'); const ctx=document.querySelector('canvas').getContext('2d');
function paint(){const n=field.value.length;for(let i=0;i<7;i++){ctx.fillStyle=(n>>i)&1?'#000':'#fff';ctx.fillRect(i*20,0,20,40)}}paint();
field.addEventListener('input',e=>{samples.push({at:performance.timeOrigin+performance.now(),data:e.data,type:e.inputType,value:field.value,focus:document.activeElement.id});paint()});
</script>`);
});
try {
  fixture.listen(0, "127.0.0.1");
  await once(fixture, "listening");
  const fixtureUrl = `http://127.0.0.1:${fixture.address().port}/`;
  await instance.startGateway();
  console.log("Gateway ready");
  const opened = await instance.cli([
    "browser",
    "--browser-profile",
    "openclaw",
    "start",
    "--json",
  ]);
  assert.equal(opened.code, 0, opened.stderr);
  const status = await instance.cli([
    "browser",
    "--browser-profile",
    "openclaw",
    "status",
    "--json",
  ]);
  assert.equal(status.code, 0, status.stderr);
  await fs.writeFile(path.join(output, "browser-status.json"), status.stdout);
  const browserStatus = JSON.parse(status.stdout);
  remoteBrowser = await chromium.connectOverCDP(browserStatus.cdpUrl);
  browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(20_000);
  await installProbe(page);
  page.on("pageerror", (e) => console.log("UI error:", e.message));
  // An explicit session route keeps a model-free Gateway out of first-run setup on reload.
  await page.goto(`http://127.0.0.1:${instance.port}/chat?session=agent%3Amain%3Amain`);
  const secret = page.getByLabel("Gateway secret", { exact: true });
  if (
    await secret
      .waitFor({ timeout: 5000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await secret.fill(instance.gatewayToken);
    await page.locator(".login-gate__connect").click();
  }
  await page.waitForFunction(
    () => window.openclawControlUi?.snapshot().gatewayPhase === "connected",
  );
  console.log("UI connected");
  await page.screenshot({ path: path.join(output, "connected.png") });
  await fs.writeFile(path.join(output, "connected.html"), await page.content());
  await page
    .getByRole("button", { name: "Panels", exact: true })
    .filter({ visible: true })
    .first()
    .click();
  await page
    .locator(".side-panel-launcher")
    .getByRole("button")
    .filter({
      has: page.locator(".side-panel-type-option__label").getByText("Browser", { exact: true }),
    })
    .click();
  // A session panel deliberately hides tabs opened outside its session. Open the
  // fixture through its address control so the real route owns the measured tab.
  const address = page.locator(".bp-url").filter({ visible: true });
  await address.fill(fixtureUrl);
  await address.press("Enter");
  await page.locator("section.bp .bp-shot").waitFor();
  const remote = remoteBrowser
    .contexts()
    .flatMap((c) => c.pages())
    .find((p) => p.url() === fixtureUrl);
  assert(remote, "Controlled remote page opened by the panel");
  await page.screenshot({ path: path.join(output, "browser.png") });
  await fs.writeFile(path.join(output, "browser.html"), await page.content());
  console.log("Browser panel ready", output, os.loadavg());
  const environment = {
    revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    load: os.loadavg(),
    browser: browser.version(),
    build: JSON.parse(await fs.readFile("dist/build-info.json", "utf8")),
    text,
    rates,
    sampleIndexes,
    collection: profile ? "profiled attribution only" : smoke ? "setup only" : "unprofiled",
    cold: "Fresh client and remote document; Gateway and managed Chromium retained",
    warm: "Same client and document, controlled field reset outside interval",
    visible:
      "Decoded pixel marker in actual Browser panel image, after two animation frames; compositor presentation upper-bound proxy, not physical display timing",
    workloadSha256: createHash("sha256")
      .update(await fs.readFile(import.meta.filename))
      .digest("hex"),
  };
  assert.equal(
    environment.revision,
    environment.build.commit,
    "Build the checked-out revision first",
  );
  await fs.writeFile(path.join(output, "environment.json"), JSON.stringify(environment, null, 2));
  if (!smoke) {
    const native = await browser.newPage();
    await native.goto(fixtureUrl);
    for (const rate of rates) {
      for (const sample of sampleIndexes) {
        if (sample > 0 || rate === 10) {
          const navigation = await instance.cli([
            "browser",
            "--browser-profile",
            "openclaw",
            "navigate",
            fixtureUrl,
            "--json",
          ]);
          assert.equal(navigation.code, 0, navigation.stderr);
          // The router canonicalizes the session query to /chat/main. Re-enter
          // explicitly so a model-free cold client does not enter onboarding.
          await page.goto(`http://127.0.0.1:${instance.port}/chat?session=agent%3Amain%3Amain`);
          await page.waitForFunction(
            () => window.openclawControlUi?.snapshot().gatewayPhase === "connected",
          );
          await page.locator("section.bp .bp-shot").waitFor();
        }
        await measureNative(native, rate, "cold", sample, fixtureUrl);
        if (profile) {
          const profiler = await page.context().newCDPSession(page);
          await profiler.send("Profiler.enable");
          await profiler.send("Profiler.start");
          try {
            await measure(page, remote, rate, "cold", sample);
          } finally {
            const { profile: cpuProfile } = await profiler.send("Profiler.stop");
            await fs.writeFile(path.join(output, "client.cpuprofile"), JSON.stringify(cpuProfile));
            await profiler.detach();
          }
        } else {
          await measure(page, remote, rate, "cold", sample);
          await measureNative(native, rate, "warm", sample, fixtureUrl);
          await measure(page, remote, rate, "warm", sample);
        }
      }
    }
    // Export only synthetic values and timings. Raw requests, URLs, HTML and
    // Gateway logs remain private; successful assertions above own these facts.
    await fs.writeFile(
      path.join(output, "evidence.json"),
      JSON.stringify(
        {
          environment,
          samples: samples.map((s) => ({
            native: Boolean(s.native),
            rate: s.rate,
            mode: s.mode,
            sample: s.sample,
            metrics: s.metrics,
            rows: s.rows,
            value: s.native ? s.probe.value : s.dom.value,
            eventData: (s.native ? s.probe.events : s.dom.events).map((e) => e.data),
            focus: s.native ? undefined : s.dom.focus,
            allEventFocusRetained: s.native
              ? undefined
              : s.dom.events.every((e) => e.focus === "field"),
            allRequestsSucceeded: s.native ? undefined : true,
            requests: s.requests,
            actions: s.actions,
            frames: s.frames,
            maxQueueDepth: s.maxQueueDepth,
            drainMs: s.drainMs,
          })),
        },
        null,
        2,
      ),
    );
  }
} catch (e) {
  await fs.writeFile(path.join(output, "failure.txt"), String(e.stack ?? e));
  if (browser) {
    for (const [index, page] of browser
      .contexts()
      .flatMap((c) => c.pages())
      .entries()) {
      await page.screenshot({ path: path.join(output, `failure-${index}.png`) }).catch(() => {});
      await fs
        .writeFile(path.join(output, `failure-${index}.html`), await page.content())
        .catch(() => {});
      await fs
        .writeFile(
          path.join(output, `failure-${index}-probe.json`),
          JSON.stringify(await page.evaluate(() => window.typingProbe ?? null), null, 2),
        )
        .catch(() => {});
    }
  }
  throw e;
} finally {
  await fs.writeFile(path.join(output, "gateway.log"), instance.logs());
  // Closing a CDP attachment disconnects only; the instance owns managed Chromium.
  await remoteBrowser?.close();
  await browser?.close();
  await instance.cleanup();
  releaseNativeOwner();
  fixture.closeAllConnections();
  if (fixture.listening) {
    await new Promise((resolve) => {
      fixture.close(resolve);
    });
  }
}
