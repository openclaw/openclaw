/**
 * Warm production-renderer streaming proof (synthetic Gateway WebSocket fixture).
 * node --import ./scripts/tsx.mjs scripts/perf/ui-streaming-render-measure.ts \
 *   --bundle-dir dist/control-ui --output .local/stream-proof --mode text
 * Use --trace for attribution, --allocations in a separate pass, and uninstrumented
 * AB/BA runs for timings. This measures browser work, not live Gateway throughput.
 * Thinking mode measures a separate renderer path, not run-retention work.
 */
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { createControlUiE2eArtifactDir } from "../../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  type MockGatewayWindow,
} from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow } from "../../ui/src/test-helpers/control-ui-session-fixtures.ts";
import { startControlUiBenchGatewayServer } from "../lib/control-ui-bench-gateway-server.ts";
import { mapColdLoadCpuProfile, summarizeCpuProfile } from "../lib/control-ui-cold-load-trace.ts";
import { launchControlUiObservationBrowser } from "../lib/control-ui-observation-browser.ts";

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    output: { type: "string", default: ".local/ui-streaming-render" },
    mode: { type: "string", default: "text" },
    deltas: { type: "string", default: "300" },
    sessions: { type: "string", default: "6" },
    "retained-runs": { type: "string", default: "199" },
    trace: { type: "boolean", default: false },
    allocations: { type: "boolean", default: false },
  },
});
const deltaCount = Number(values.deltas);
const sessionCount = Number(values.sessions);
const retainedRunCount = Number(values["retained-runs"]);
if (
  !["text", "thinking"].includes(values.mode) ||
  !Number.isSafeInteger(deltaCount) ||
  deltaCount < 1 ||
  !Number.isSafeInteger(sessionCount) ||
  sessionCount < 1 ||
  sessionCount > 8 ||
  !Number.isSafeInteger(retainedRunCount) ||
  retainedRunCount < 0 ||
  retainedRunCount > 199 ||
  (values.trace && values.allocations)
) {
  throw new Error(
    "Expected text|thinking, positive deltas, 1–8 sessions; separate trace/allocation passes",
  );
}
const artifactDir = createControlUiE2eArtifactDir("stream", values.output);
const html = await readFile(path.join(values["bundle-dir"], "index.html"), "utf8");
const rawBuild = html.match(
  /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su,
)?.[1];
if (!rawBuild) {
  throw new Error("Production bundle has no build identity");
}
const build: { buildId: string; version: string } = JSON.parse(rawBuild);
const server = await startControlUiBenchGatewayServer(values["bundle-dir"]);
const browser = await launchControlUiObservationBrowser({
  viewport: { width: 1440, height: 1000 },
  artifactDir,
  artifactPrefix: "stream",
  colorScheme: "light",
});
const page = await browser.context.newPage();
page.setDefaultTimeout(60_000);
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const loadBefore = os.loadavg();
try {
  const sessionKeys = Array.from(
    { length: sessionCount },
    (_, index) => `agent:main:dashboard:stream-probe-${index}`,
  );
  const sessionKey = sessionKeys[0]!;
  const now = Date.now();
  const sessions = sessionKeys.map((key, index) =>
    createControlUiSessionRow(key, `Streaming session ${index + 1}`, now - index, {
      reasoningLevel: "on",
      thinkingLevel: "low",
      hasActiveRun: index > 0,
      status: index > 0 ? "running" : "done",
    }),
  );
  const historyMessages = Array.from({ length: 400 }, (_, index) => ({
    role: index % 2 === 0 ? "user" : "assistant",
    content: [{ type: "text", text: `Settled history ${index}: ${"stable context ".repeat(12)}` }],
    timestamp: now - (400 - index) * 1000,
  }));
  await page.addInitScript({ content: "globalThis.__name = (fn) => fn;" });
  const gateway = await installMockGateway(page, {
    serverBuildId: build.buildId,
    serverVersion: build.version,
    sessionKey,
    sessions,
    historyMessages,
    sessionInfo: { reasoningLevel: "on", thinkingLevel: "low" },
  });
  // Observe the existing projection owner during setup; no production probe seam.
  await page.addInitScript(() => {
    const OriginalWeakMap = window.WeakMap;
    class ProjectionProbeWeakMap<K extends WeakKey, V> extends OriginalWeakMap<K, V> {
      override set(key: K, value: V): this {
        if (value && typeof value === "object") {
          const projection = Reflect.get(value, "projection");
          if (
            projection &&
            typeof projection === "object" &&
            "runs" in projection &&
            projection.runs
          ) {
            Reflect.set(window, "__streamProjection", projection);
          }
        }
        return super.set(key, value);
      }
    }
    window.WeakMap = ProjectionProbeWeakMap;
    Reflect.set(window, "__stopStreamProjectionProbe", () => {
      window.WeakMap = OriginalWeakMap;
      Reflect.deleteProperty(ProjectionProbeWeakMap.prototype, "set");
    });
  });
  console.log("Opening production chat");
  await page.goto(controlUiSessionUrl(server.baseUrl, sessionKey));
  console.log("Chat navigation complete");
  await gateway.waitForRequest("sessions.messages.subscribe");
  const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
  console.log("Warming retained runs");
  await page.evaluate(
    async ({ sessionKey: targetSessionKey, retainedRunCount: targetRunCount }) => {
      // SAFETY: installMockGateway installs this fixture before navigation.
      const fixture = (window as MockGatewayWindow).openclawControlUiE2eGateway;
      if (!fixture) {
        throw new Error("Synthetic Gateway missing");
      }
      for (let index = 0; index < targetRunCount; index++) {
        fixture.emit("chat", {
          sessionKey: targetSessionKey,
          runId: `retained-run-${index}`,
          state: "final",
          seq: index + 1,
          message: {
            role: "assistant",
            content: [{ type: "text", text: `Retained turn ${index}` }],
            timestamp: Date.now(),
          },
        });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      }
    },
    { sessionKey, retainedRunCount },
  );
  await page.waitForFunction((expected) => {
    const projection = Reflect.get(window, "__streamProjection");
    return projection && Object.keys(projection.runs).length >= expected;
  }, retainedRunCount);
  const warmRunCount = await page.evaluate(() => {
    const count = Object.keys(Reflect.get(window, "__streamProjection").runs).length;
    Reflect.get(window, "__stopStreamProjectionProbe")();
    Reflect.deleteProperty(window, "__streamProjection");
    Reflect.deleteProperty(window, "__stopStreamProjectionProbe");
    return count;
  });
  await pane
    .locator(".agent-chat__composer-combobox textarea")
    .fill("Compare the synthetic evidence.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const send = await gateway.waitForRequest("chat.send");
  if (!send.params || typeof send.params !== "object") {
    throw new Error("chat.send params missing");
  }
  const runId = Reflect.get(send.params, "idempotencyKey");
  if (typeof runId !== "string") {
    throw new Error("chat.send did not provide a run identity");
  }
  await gateway.emitGatewayEvent("chat", {
    sessionKey,
    runId,
    state: "delta",
    deltaText: "Warm stream.",
    message: { role: "assistant", content: [{ type: "text", text: "Warm stream." }] },
  });
  await pane.locator(".chat-bubble.streaming").getByText("Warm stream.", { exact: true }).waitFor();
  const cdp = await browser.context.newCDPSession(page);
  await cdp.send("Performance.enable", { timeDomain: "threadTicks" });
  const readMetrics = async () =>
    Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map(({ name, value }) => [name, value]),
    );
  const traceEvents: unknown[] = [];
  if (values.trace) {
    cdp.on("Tracing.dataCollected", ({ value }) => traceEvents.push(...value));
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
    await cdp.send("Tracing.start", {
      categories: "toplevel,devtools.timeline,v8,blink.user_timing",
      transferMode: "ReportEvents",
    });
  }
  if (values.allocations) {
    await cdp.send("HeapProfiler.startSampling", {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
  }
  console.log("Measuring streaming interval");
  const before = await readMetrics();
  const measurements = await page.evaluate(
    async ({
      sessionKeys: targetSessionKeys,
      runId: targetRunId,
      deltaCount: targetDeltaCount,
      mode,
    }) => {
      // SAFETY: installMockGateway installs this fixture before navigation.
      const fixture = (window as MockGatewayWindow).openclawControlUiE2eGateway;
      if (!fixture) {
        throw new Error("Synthetic Gateway missing");
      }
      const thread = document.querySelector('openclaw-chat-pane[aria-hidden="false"] .chat-thread');
      const sidebar = document.querySelector("openclaw-app-sidebar");
      if (!thread || !sidebar) {
        throw new Error("Measured surfaces are not mounted");
      }
      const retained = [...thread.querySelectorAll("[data-message-id]")].filter(
        (node) => !node.closest(".streaming"),
      );
      let streamMutations = 0;
      let settledMutations = 0;
      let sidebarMutations = 0;
      const mutation = new MutationObserver((records) => {
        for (const record of records) {
          if (sidebar.contains(record.target)) {
            sidebarMutations++;
          } else if (
            retained.some(
              (node) =>
                node.contains(record.target) ||
                [...record.removedNodes].some((removed) => removed.contains(node)),
            )
          ) {
            settledMutations++;
          } else {
            streamMutations++;
          }
        }
      });
      mutation.observe(thread, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      mutation.observe(sidebar, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      const longTasks: number[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longTasks.push(entry.duration);
        }
      });
      observer.observe({ type: "longtask" });
      let idbPuts = 0;
      let idbAdds = 0;
      // The wrappers pass each store receiver explicitly through apply below.
      // oxlint-disable-next-line typescript/unbound-method
      const originalPut = IDBObjectStore.prototype.put;
      // oxlint-disable-next-line typescript/unbound-method
      const originalAdd = IDBObjectStore.prototype.add;
      IDBObjectStore.prototype.put = function (...args) {
        idbPuts++;
        return originalPut.apply(this, args);
      };
      IDBObjectStore.prototype.add = function (...args) {
        idbAdds++;
        return originalAdd.apply(this, args);
      };
      const frames: number[] = [];
      let frameId: number;
      const frame = (at: number) => {
        frames.push(at);
        frameId = requestAnimationFrame(frame);
      };
      frameId = requestAnimationFrame(frame);
      const startedAt = performance.now();
      let text = "";
      try {
        for (let index = 0; index < targetDeltaCount; index++) {
          text += ` evidence ${index + 1}`;
          for (const [sessionIndex, key] of targetSessionKeys.entries()) {
            const currentRun = sessionIndex === 0 ? targetRunId : `background-${sessionIndex}`;
            if (mode === "thinking") {
              fixture.emit("agent", {
                sessionKey: key,
                runId: currentRun,
                seq: 1_000_000 + index,
                stream: "thinking",
                ts: Date.now(),
                data: { itemId: "reasoning-probe", text },
              });
            } else {
              fixture.emit("chat", {
                sessionKey: key,
                runId: currentRun,
                seq: 1_000_000 + index,
                state: "delta",
                message: { role: "assistant", content: [{ type: "text", text }] },
              });
            }
          }
          await new Promise<void>((resolve) => {
            setTimeout(
              resolve,
              Math.max(0, startedAt + (index + 1) * (1000 / 30) - performance.now()),
            );
          });
        }
        await new Promise<void>((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
        });
        const selector = mode === "thinking" ? ".chat-thinking" : ".chat-bubble.streaming";
        const visibleText = [...thread.querySelectorAll(selector)]
          .map((node) => node.textContent)
          .join("\n");
        if (!visibleText.includes(`evidence ${targetDeltaCount}`)) {
          throw new Error("Final streamed delta did not reach the DOM");
        }
        return {
          elapsedMs: performance.now() - startedAt,
          attemptedFrames: targetDeltaCount * targetSessionKeys.length,
          selectedDeltas: targetDeltaCount,
          retainedMessages: retained.length,
          retainedMessagesStillConnected: retained.filter((node) => node.isConnected).length,
          retainedMessagesReplaced: retained.filter((node) =>
            [...thread.querySelectorAll("[data-message-id]")].some(
              (current) =>
                current !== node &&
                current.getAttribute("data-message-id") === node.getAttribute("data-message-id"),
            ),
          ).length,
          streamMutations,
          settledMutations,
          sidebarMutations,
          idbPuts,
          idbAdds,
          frameGapsMs: frames.slice(1).map((at, index) => at - frames[index]!),
          longTasks,
          finalText: visibleText,
        };
      } finally {
        cancelAnimationFrame(frameId);
        mutation.disconnect();
        observer.disconnect();
        IDBObjectStore.prototype.put = originalPut;
        IDBObjectStore.prototype.add = originalAdd;
      }
    },
    { sessionKeys, runId, deltaCount, mode: values.mode },
  );
  const after = await readMetrics();
  if (values.trace) {
    const profile = (await cdp.send("Profiler.stop")).profile;
    await writeFile(path.join(artifactDir, "stream.cpuprofile"), JSON.stringify(profile));
    const mapped = await mapColdLoadCpuProfile(profile, {
      assetBaseUrl: `${server.baseUrl}/assets/`,
      assetDirectory: path.join(values["bundle-dir"], "assets"),
    });
    await writeFile(
      path.join(artifactDir, "stream.cpu-summary.json"),
      JSON.stringify(
        { ...mapped, summary: summarizeCpuProfile(mapped.profile, { includeTables: true }) },
        null,
        2,
      ),
    );
    const complete = new Promise<void>((resolve) => {
      cdp.once("Tracing.tracingComplete", () => resolve());
    });
    await cdp.send("Tracing.end");
    await complete;
    await writeFile(path.join(artifactDir, "stream.trace.json"), JSON.stringify({ traceEvents }));
  }
  let allocatedBytes: number | undefined;
  if (values.allocations) {
    const { profile } = await cdp.send("HeapProfiler.stopSampling");
    allocatedBytes = profile.samples.reduce((sum, sample) => sum + sample.size, 0);
    await writeFile(path.join(artifactDir, "stream.heapprofile"), JSON.stringify(profile));
  }
  await page.screenshot({ path: path.join(artifactDir, "streaming.png"), animations: "disabled" });
  const durationNames = ["TaskDuration", "ScriptDuration", "LayoutDuration", "RecalcStyleDuration"];
  const cpuMs = Object.fromEntries(
    durationNames.map((name) => [name, ((after[name] ?? 0) - (before[name] ?? 0)) * 1000]),
  );
  const report = {
    boundary:
      "Production UI and Gateway HTTP owner with synthetic browser WebSocket fixture; background session events obey real fixture subscriptions. Not live Gateway/provider throughput.",
    build,
    mode: values.mode,
    sessionCount,
    deltaCount,
    historyMessages: historyMessages.length,
    retainedRunCount,
    warmRunCount,
    instrumentation: {
      trace: values.trace,
      allocations: values.allocations,
      performanceTimeDomain: "threadTicks",
      note: "Mutation, rAF, IDB and long-task counters enabled in all arms; trace/allocation timings have profiler overhead.",
    },
    loadBefore,
    loadAfter: os.loadavg(),
    cpuMs,
    scriptingMsPerSelectedDelta: cpuMs.ScriptDuration! / deltaCount,
    allocatedBytes,
    heapBefore: before.JSHeapUsedSize,
    heapAfter: after.JSHeapUsedSize,
    ...measurements,
    errors,
  };
  await writeFile(path.join(artifactDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ artifactDir, cpuMs, allocatedBytes, errors }));
  await gateway.emitChatFinal({ sessionKey, runId, text: "Synthetic streaming proof complete." });
  await pane
    .locator(".chat-text")
    .getByText("Synthetic streaming proof complete.", { exact: true })
    .waitFor();
  await page.screenshot({ path: path.join(artifactDir, "completed.png"), animations: "disabled" });
  await cdp.detach();
} catch (error) {
  await writeFile(
    path.join(artifactDir, "failure.json"),
    JSON.stringify({ error: String(error), errors }, null, 2),
  );
  await page.screenshot({ path: path.join(artifactDir, "failure.png") }).catch(() => undefined);
  throw error;
} finally {
  await browser.close();
  await server.close();
}
