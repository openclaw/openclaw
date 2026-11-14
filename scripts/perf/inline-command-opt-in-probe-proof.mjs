// Native browser lifecycle proof for qualification observations, not Gateway qualification.
// Run: node --import ./scripts/tsx.mjs scripts/perf/inline-command-opt-in-probe-proof.mjs
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { chromium } from "playwright";
import { build } from "vite";
import { WebSocketServer } from "ws";
import { reserveTestPortListener } from "../../src/test-utils/port-claims.ts";
import { controlUiLocaleModulesPlugin } from "../../ui/config/control-ui-locales.ts";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import { resolvePlaywrightChromiumExecutablePath } from "../../ui/src/test-helpers/playwright-chromium.ts";
import { resolveTsconfigPathAliasesForVite } from "../../ui/vite.config.ts";
import { installInlineCommandOptInProbe } from "./inline-command-opt-in-probe.mjs";

const artifacts = createControlUiE2eArtifactDir("inline-consumer-observation");
const fixtureId = "virtual:inline-command-production-socket-fixture";
// The production socket reaches lazy locale adapters. Use their canonical build
// owner rather than replacing or externalizing those transitive dependencies.
const fixture = await build({
  configFile: false,
  publicDir: false,
  resolve: { alias: resolveTsconfigPathAliasesForVite() },
  plugins: [
    controlUiLocaleModulesPlugin(),
    {
      name: "inline-command-production-socket-fixture",
      resolveId(id) {
        return id === fixtureId ? `\0${fixtureId}` : undefined;
      },
      load(id) {
        if (id === `\0${fixtureId}`) {
          return `import { createBrowserGatewaySocket } from ${JSON.stringify(path.resolve("ui/src/api/gateway-browser-socket.ts"))}; window.createFixtureGatewaySocket = createBrowserGatewaySocket;`;
        }
        return undefined;
      },
    },
  ],
  build: {
    write: false,
    minify: false,
    lib: { entry: fixtureId, name: "InlineSocketFixture", formats: ["iife"] },
    rolldownOptions: { input: fixtureId, output: { codeSplitting: false } },
  },
});
assert(Array.isArray(fixture) && fixture.length === 1);
const fixtureScript = fixture[0].output.find((output) => output.type === "chunk" && output.isEntry);
assert(fixtureScript, "production socket fixture emits an entry script");
const reservation = await reserveTestPortListener({
  offsets: [0],
  createListener: () =>
    createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<!doctype html><title>Native consumer lifecycle proof</title>");
    }),
});
const sockets = new WebSocketServer({ server: reservation.listener });
sockets.on("connection", (socket) =>
  socket.on("message", (data) => socket.send(data, { binary: false })),
);
let browser;
const results = {};
try {
  const executablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
  browser = await chromium.launch({ executablePath, headless: true });
  for (const observed of [false, true]) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${reservation.claim.port}`);
    await page.addScriptTag({ content: fixtureScript.code });
    const before = await page.evaluate(() => {
      window.fixtureOnmessageDescriptor = Object.getOwnPropertyDescriptor(
        WebSocket.prototype,
        "onmessage",
      );
      return true;
    });
    assert(before);
    if (observed) {
      await page.evaluate(installInlineCommandOptInProbe);
    }
    results[observed ? "observed" : "nativeControl"] = await page.evaluate(async () => {
      const check = (condition, label) => {
        if (!condition) {
          throw new Error(label);
        }
      };
      const probe = window.inlineCommandOptInProbe;
      window.inlineNativeProbe = {
        active: false,
        startAt: performance.now(),
        startupFrames: [],
        rafGaps: [],
        requestJoinOverflow: false,
      };
      const descriptor = Object.getOwnPropertyDescriptor(WebSocket.prototype, "onmessage");
      const originalDescriptor = window.fixtureOnmessageDescriptor;
      check(
        descriptor.get === originalDescriptor.get && descriptor.set === originalDescriptor.set,
        "onmessage descriptor remains native",
      );
      const beforeStart = new MessageChannel();
      function fixtureBeforeStart() {}
      beforeStart.port1.addEventListener("message", fixtureBeforeStart);
      beforeStart.port1.removeEventListener("message", fixtureBeforeStart);
      beforeStart.port1.close();
      beforeStart.port2.close();
      probe?.start();
      const NativeWebSocket = WebSocket;
      const createdSockets = [];
      let parses = 0;
      let nextFrameId = 0;
      const eventIds = new WeakMap();
      window.WebSocket = class extends NativeWebSocket {
        constructor(...args) {
          super(...args);
          createdSockets.push(this);
          const observe = (event) => {
            const envelope = JSON.parse(event.data);
            parses++;
            const receipt = {
              frameId: ++nextFrameId,
              requestId: envelope.id,
              requestMethod: "fixture.echo",
            };
            eventIds.set(event, receipt.frameId);
            probe?.recordMessageFrame(event, receipt);
          };
          if (probe) {
            probe.listenObserver(this, observe);
          } else {
            this.addEventListener("message", observe);
          }
        }
      };
      let open;
      const opened = new Promise((resolve) => {
        open = resolve;
      });
      let received;
      const transport = window.createFixtureGatewaySocket(`ws://${location.host}`, {
        open,
        message: (data) => received(data),
        close() {},
        error(error) {
          throw error;
        },
      });
      await opened;
      const [socket] = createdSockets;
      let sent = 0;
      const echo = async () => {
        const text = JSON.stringify({ type: "res", id: `fixture-${++sent}` });
        let response;
        received = (data) => (response = data);
        const dispatched = new Promise((resolve) => {
          socket.addEventListener(
            "message",
            function fixtureEchoDone() {
              resolve();
            },
            { once: true },
          );
        });
        transport.send(text);
        await dispatched;
        check(response === text, "actual production socket delivers unchanged string");
      };
      const counts = { duplicate: 0, capture: 0, once: 0, aborted: 0, object: 0, property: 0 };
      const pairedIds = [];
      function fixtureDuplicate(event) {
        check(this === socket, "native WebSocket callback receiver");
        check(event instanceof MessageEvent, "native MessageEvent argument");
        pairedIds.push(eventIds.get(event));
        counts.duplicate++;
        return "ignored native callback return";
      }
      function fixtureCapture() {
        counts.capture++;
      }
      function fixtureOnce() {
        counts.once++;
      }
      function fixtureAborted() {
        counts.aborted++;
      }
      const objectListener = {
        handleEvent() {
          check(this === objectListener, "object callback receiver");
          counts.object++;
        },
      };
      function fixtureProperty() {
        check(this === socket, "onmessage callback receiver");
        counts.property++;
      }
      socket.addEventListener("message", fixtureDuplicate);
      socket.addEventListener("message", fixtureDuplicate);
      socket.addEventListener("message", fixtureCapture, true);
      socket.addEventListener("message", fixtureCapture, false);
      socket.removeEventListener("message", fixtureCapture, true);
      socket.addEventListener("message", fixtureOnce, { once: true });
      const abort = new AbortController();
      socket.addEventListener("message", fixtureAborted, { signal: abort.signal });
      abort.abort();
      socket.addEventListener("message", objectListener);
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- This fixture specifically proves that native onmessage assignment and getter identity remain unchanged.
      socket.onmessage = fixtureProperty;
      check(socket.onmessage === fixtureProperty, "onmessage getter identity");
      await echo();
      await echo();
      socket.addEventListener("message", fixtureOnce, { once: true });
      const freshAbort = new AbortController();
      socket.addEventListener("message", fixtureAborted, { signal: freshAbort.signal });
      await echo();
      freshAbort.abort();
      socket.removeEventListener("message", fixtureDuplicate);
      socket.removeEventListener("message", fixtureCapture, false);
      socket.removeEventListener("message", objectListener);
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Retire the native property listener through the same onmessage contract under test.
      socket.onmessage = null;
      // Null removal is accepted by native EventTarget and must remain harmless.
      socket.removeEventListener("message", null);
      await echo();
      const expectedError = new Error("fixture native listener error");
      let sameError = false;
      window.addEventListener(
        "error",
        (event) => {
          sameError = event.error === expectedError;
          event.preventDefault();
        },
        { once: true },
      );
      function fixtureThrow() {
        throw expectedError;
      }
      socket.addEventListener("message", fixtureThrow, { once: true });
      await echo();
      check(sameError, "same thrown error reaches native error reporting");
      const channel = new MessageChannel();
      await new Promise((resolve) => {
        channel.port1.addEventListener(
          "message",
          function fixturePort(event) {
            check(this === channel.port1, "native MessagePort receiver");
            check(event.data === "native-port", "native MessagePort argument");
            resolve();
          },
          { once: true },
        );
        channel.port1.start();
        channel.port2.postMessage("native-port");
      });
      channel.port1.close();
      channel.port2.close();
      let cancelled = false;
      const handle = requestAnimationFrame(function fixtureCancelledFrame() {
        cancelled = true;
      });
      cancelAnimationFrame(handle);
      await new Promise((resolve) => {
        requestAnimationFrame(function fixtureFrame(timestamp) {
          check(this === window, "native rAF receiver");
          check(typeof timestamp === "number", "native rAF timestamp");
          resolve();
        });
      });
      check(!cancelled, "native returned handle cancels application callback");
      const microtaskOrder = ["sync"];
      let microtaskCalls = 0;
      await new Promise((resolve) => {
        function fixtureMicrotask() {
          check(this === window, "native microtask callback receiver");
          check(arguments.length === 0, "native microtask callback has no arguments");
          microtaskOrder.push("microtask");
          if (++microtaskCalls === 1) {
            queueMicrotask(function fixtureNestedMicrotask() {
              microtaskOrder.push("nested");
            });
          }
        }
        check(queueMicrotask(fixtureMicrotask) === undefined, "native microtask return");
        void Promise.resolve().then(function fixturePromiseSibling() {
          microtaskOrder.push("promise");
        });
        queueMicrotask(fixtureMicrotask);
        queueMicrotask(function fixtureMicrotaskLast() {
          microtaskOrder.push("last");
          resolve();
        });
      });
      let invalidMicrotaskRejected = false;
      try {
        queueMicrotask(null);
      } catch (error) {
        invalidMicrotaskRejected = error instanceof TypeError;
      }
      check(invalidMicrotaskRejected, "invalid callback retains native synchronous rejection");
      const microtaskError = new Error("fixture native microtask error");
      let sameMicrotaskError = false;
      window.addEventListener(
        "error",
        (event) => {
          sameMicrotaskError = event.error === microtaskError;
          event.preventDefault();
        },
        { once: true },
      );
      await new Promise((resolve) => {
        queueMicrotask(function fixtureMicrotaskThrow() {
          throw microtaskError;
        });
        queueMicrotask(resolve);
      });
      check(sameMicrotaskError, "same thrown microtask error reaches native reporting");
      const strictMicrotaskReceiver = await new Promise((resolve) => {
        queueMicrotask(function fixtureStrictMicrotask() {
          "use strict";
          resolve({ undefinedReceiver: this === undefined, argumentCount: arguments.length });
        });
      });
      const strictFrameReceiver = await new Promise((resolve) => {
        requestAnimationFrame(function fixtureStrictFrame() {
          "use strict";
          resolve({ undefinedReceiver: this === undefined, argumentCount: arguments.length });
        });
      });
      window.inlineNativeProbe.active = true;
      window.inlineNativeProbe.startAt = performance.now();
      socket.addEventListener("message", fixtureDuplicate);
      await echo();
      await new Promise((resolve) => {
        requestAnimationFrame(function fixtureWarmFrame() {
          resolve();
        });
      });
      await new Promise((resolve) => {
        queueMicrotask(function fixtureWarmMicrotask() {
          microtaskOrder.push("warm");
          resolve();
        });
      });
      const observation = probe?.finish();
      transport.close();
      return {
        counts,
        pairedIds,
        sent,
        parses,
        sameError,
        cancelled,
        microtaskOrder,
        invalidMicrotaskRejected,
        sameMicrotaskError,
        strictMicrotaskReceiver,
        strictFrameReceiver,
        observation,
      };
    });
    await context.close();
  }
  const { observation, ...observedBehavior } = results.observed;
  const { observation: _none, ...controlBehavior } = results.nativeControl;
  assert.deepEqual(observedBehavior, controlBehavior, "observed behavior matches native control");
  assert.deepEqual(observedBehavior.strictMicrotaskReceiver, {
    undefinedReceiver: true,
    argumentCount: 0,
  });
  assert.deepEqual(observedBehavior.strictFrameReceiver, {
    undefinedReceiver: true,
    argumentCount: 1,
  });
  assert.deepEqual(observedBehavior.counts, {
    duplicate: 4,
    capture: 3,
    once: 2,
    aborted: 1,
    object: 3,
    property: 3,
  });
  assert.equal(observedBehavior.parses, observedBehavior.sent, "one capture parse per frame");
  assert.equal(observation.consumerObservations.complete, true);
  const { sources, sourceCaptureSpans, spans } = observation.consumerObservations;
  const source = (name) => sources.filter((entry) => entry.name === name);
  const sourceSpans = (name) => spans.filter((span) => span.consumerId === source(name)[0]?.id);
  assert.equal(source("fixtureDuplicate").length, 1, "callback source recorded once");
  const captures = (name) =>
    sourceCaptureSpans.filter((span) => span.consumerId === source(name)[0]?.id);
  assert.equal(captures("fixtureDuplicate").length, 1, "ID reuse does not recapture source");
  assert.equal(source("fixtureBeforeStart").length, 1);
  assert.equal(captures("fixtureBeforeStart").length, 0, "pre-start capture remains untimed");
  assert.equal(captures("fixtureCancelledFrame").length, 1, "canceled rAF capture is timed");
  assert.equal(sourceCaptureSpans.length, sources.length - 1);
  assert.equal(
    new Set(sourceCaptureSpans.map((span) => span.consumerId)).size,
    sourceCaptureSpans.length,
  );
  assert(
    sourceCaptureSpans.every(
      (span) =>
        sources.some((entry) => entry.id === span.consumerId) &&
        span.outcome === "recorded" &&
        span.startAt >= observation.sendAt &&
        span.endAt >= span.startAt &&
        span.endAt <= observation.warmStartAt,
    ),
    "each prewarm capture has an ordered receipt joined to its original source",
  );
  assert.deepEqual(
    sourceSpans("fixtureDuplicate").map((span) => span.frameId),
    [1, 2, 3],
  );
  assert.equal(sourceSpans("fixtureThrow")[0]?.outcome, "threw");
  assert.equal(sourceSpans("fixturePort")[0]?.kind, "MessagePort.message");
  assert.equal(sourceSpans("fixtureFrame")[0]?.kind, "animation-frame");
  assert.equal(sourceSpans("fixtureCancelledFrame").length, 0);
  assert.deepEqual(observedBehavior.microtaskOrder, [
    "sync",
    "microtask",
    "promise",
    "microtask",
    "last",
    "nested",
    "warm",
  ]);
  assert.equal(source("fixtureMicrotask").length, 1, "reused microtask source captured once");
  assert.equal(captures("fixtureMicrotask").length, 1);
  assert.deepEqual(
    sourceSpans("fixtureMicrotask").map((span) => span.kind),
    ["microtask", "microtask"],
  );
  assert.equal(sourceSpans("fixtureNestedMicrotask")[0]?.kind, "microtask");
  assert.equal(sourceSpans("fixtureMicrotaskThrow")[0]?.outcome, "threw");
  assert.equal(
    source("fixturePromiseSibling").length,
    0,
    "Promise reactions remain native and unobserved",
  );
  assert.equal(source("fixtureWarmMicrotask").length, 0, "warm microtasks are not observed");
  assert.equal(source("fixtureWarmFrame").length, 0, "warm callbacks are not observed");
  assert.equal(source("fixtureProperty").length, 0, "onmessage remains unobserved");
  assert.equal(source("observe").length, 0, "collector message observer is exempt");
  assert.equal(source("frame").length, 0, "collector animation callback is exempt");
  const production = sources.filter((entry) => entry.source.includes("handlers.message(String("));
  assert.equal(production.length, 1, "actual production Gateway function listener is observed");
  assert.deepEqual(
    spans.filter((span) => span.consumerId === production[0].id).map((span) => span.frameId),
    [1, 2, 3, 4, 5],
    "production listener joins exact native event receipt; warm frame excluded",
  );
  assert(spans.every((span) => span.endAt >= span.startAt));
  const overflowContext = await browser.newContext();
  try {
    const page = await overflowContext.newPage();
    await page.goto(`http://127.0.0.1:${reservation.claim.port}`);
    await page.evaluate(installInlineCommandOptInProbe);
    results.overflow = await page.evaluate(() => {
      window.inlineNativeProbe = {
        active: false,
        startAt: performance.now(),
        startupFrames: [],
        rafGaps: [],
        requestJoinOverflow: false,
      };
      const probe = window.inlineCommandOptInProbe;
      probe.start();
      const channel = new MessageChannel();
      for (let index = 0; index < 513; index++) {
        const callback = function fixtureOverflowListener() {};
        channel.port1.addEventListener("message", callback);
        channel.port1.removeEventListener("message", callback);
      }
      channel.port1.close();
      channel.port2.close();
      return probe.finish().consumerObservations;
    });
  } finally {
    await overflowContext.close();
  }
  assert.equal(
    results.overflow.complete,
    false,
    "bounded receipt overflow invalidates completeness",
  );
  assert.equal(results.overflow.sources.length, 512);
  assert.equal(results.overflow.sourceCaptureSpans.length, 512);
  assert.deepEqual(results.overflow.issues, [
    "consumer-source-buffer-full",
    "consumer-source-capture-span-buffer-full",
  ]);
  await writeFile(
    path.join(artifacts, "proof.json"),
    JSON.stringify({ browser: browser.version(), passed: true, ...results }, null, 2),
  );
  console.info(`PASS native lifecycle and current production socket pairing: ${artifacts}`);
} catch (error) {
  await writeFile(
    path.join(artifacts, "failure.json"),
    JSON.stringify({ error: String(error?.stack ?? error), results }, null, 2),
  );
  throw error;
} finally {
  await browser?.close();
  for (const socket of sockets.clients) {
    socket.terminate();
  }
  await new Promise((resolve) => {
    sockets.close(resolve);
  });
  await reservation.releaseListener();
  await reservation.claim.release();
}
