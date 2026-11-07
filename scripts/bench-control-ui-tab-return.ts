// Hidden-work and shared-origin tab companion to bench-control-ui-engines.ts.
import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { webkit, type Page } from "playwright";
import { normalizeControlUiBuildInfo } from "../ui/src/build-info-normalizers.ts";
import type { ChatMessageCache } from "../ui/src/pages/chat/session-message-cache.ts";
import { createControlUiE2eArtifactDir } from "../ui/src/test-helpers/control-ui-e2e-artifacts.ts";
import type { MockGatewayWindow } from "../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { waitForControlUiInitialRoster } from "../ui/src/test-helpers/control-ui-e2e-readiness.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  controlUiSessionPath,
  installMockGateway,
} from "../ui/src/test-helpers/control-ui-e2e.ts";
import { startControlUiBenchGatewayServer } from "./lib/control-ui-bench-gateway-server.ts";
import { controlUiBenchOrder } from "./lib/control-ui-bench-order.ts";
import { createEngineActionTiming } from "./lib/control-ui-engine-action-timing.ts";
import { startEngineMeasurement, type ControlUiEngine } from "./lib/control-ui-engine-metrics.ts";
import { frames, navigation } from "./lib/control-ui-interaction-navigation.ts";
import {
  createScenarioFixture,
  interactionScenarios,
} from "./lib/control-ui-interaction-scenarios.ts";
import {
  installControlUiResourceCounts,
  readControlUiResourceCounts,
} from "./lib/control-ui-resource-counts.ts";
import { createControlUiStreamingReply } from "./lib/control-ui-streaming-fixture.ts";
import {
  setControlUiWebKitTabVisibility,
  FIREFOX_HIDDEN_TAB_UNSUPPORTED_REASON,
} from "./lib/control-ui-tab-visibility.ts";
import { launchTalkObservationBrowser } from "./lib/control-ui-talk-fixture.ts";

const { values } = parseArgs({
  options: {
    "bundle-dir": { type: "string", default: "dist/control-ui" },
    "compare-bundle-dir": { type: "string" },
    "control-bundle-dir": { type: "string" },
    output: { type: "string", default: ".artifacts/tab-return" },
    pairs: { type: "string", default: "1" },
    engines: { type: "string", default: "chromium,webkit,firefox" },
    trace: { type: "boolean", default: false },
    minutes: { type: "string", default: "1,5,30" },
    tabs: { type: "string", default: "1,2,3,4,5" },
    modes: { type: "string", default: "stream,sessions,disconnect" },
    "idle-ms": { type: "string", default: "1000" },
    "collect-garbage": { type: "boolean", default: false },
  },
});
const pairs = Number(values.pairs);
const engines = values.engines.split(",").map((engine): ControlUiEngine => {
  if (engine !== "chromium" && engine !== "webkit" && engine !== "firefox") {
    throw new Error("Unknown engine");
  }
  return engine;
});
const minutes = values.minutes.split(",").map(Number);
const tabCounts = values.tabs.split(",").map(Number);
const modes = values.modes.split(",");
const idleMs = Number(values["idle-ms"]);
const collectGarbage = values["collect-garbage"];
if (collectGarbage && engines.some((engine) => engine !== "chromium")) {
  throw new Error("--collect-garbage requires --engines chromium; it is a retention diagnostic");
}
if (
  !Number.isInteger(pairs) ||
  pairs < 1 ||
  minutes.some((n) => !Number.isInteger(n) || n < 1) ||
  tabCounts.some((n) => !Number.isInteger(n) || n < 1 || n > 5) ||
  modes.some((mode) => !["stream", "sessions", "disconnect"].includes(mode)) ||
  !Number.isFinite(idleMs) ||
  idleMs < 0
) {
  throw new Error(
    "Expected positive pairs/minutes, 1–5 tabs, stream/sessions/disconnect modes and nonnegative idle-ms",
  );
}
const output = createControlUiE2eArtifactDir("tab-return", values.output);
const write = (name: string, data: unknown) =>
  writeFile(path.join(output, name), JSON.stringify(data, null, 2));
const bundles = [
  { name: "base", dir: values["bundle-dir"] },
  ...(values["compare-bundle-dir"] ? [{ name: "head", dir: values["compare-bundle-dir"] }] : []),
  ...(values["control-bundle-dir"] ? [{ name: "control", dir: values["control-bundle-dir"] }] : []),
];
const sessionKey = "agent:main:interaction-a";
const pane = ".chat-pane-cache__pane--active";
const composer = `${pane} .agent-chat__composer-combobox textarea`;
const runId = "tab-return-run";
const typing = interactionScenarios.find((scene) => scene.id === "chat-typing")!;
const switching = interactionScenarios.find((scene) => scene.id === "session-switch")!;
const reply = createControlUiStreamingReply().text;
// This fixture uses headings, fenced code, links, emphasis, and simple tables.
const normalizeExpectedReply = (text: string) =>
  text
    .replace(/^```.*$/gmu, "")
    .replace(/^\|[\s:|-]+\|$/gmu, "")
    .replace(/^#{1,6} /gmu, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replaceAll("**", "")
    .replaceAll("`", "")
    .replaceAll("|", "")
    .replace(/\s+/gu, "");
const delay = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

/** Bounded observations: no polling or stored mutation records grow with stream length. */
function installProbe() {
  const state = {
    mutations: 0,
    streamMutations: 0,
    hiddenMutations: 0,
    visibilityAt: 0,
    correctAt: 0,
    firstFrameAt: 0,
    frameTextCorrect: false,
    finalCommits: 0,
    longestReturnTaskMs: null as number | null,
    expected: "",
    expectedLiteral: "",
    storageEvents: 0,
    broadcastMessages: 0,
    serviceWorkerMessages: 0,
    socketCountBeforeDisconnect: null as number | null,
    returnFrames: [] as Array<{ correct: boolean; bottomDistance: number }>,
  };
  Reflect.set(window, "__tabReturn", state);
  const correct = () =>
    state.expected.length > 0 &&
    [...document.querySelectorAll(".chat-pane-cache__pane--active .chat-text")].some((message) => {
      const walker = document.createTreeWalker(message, NodeFilter.SHOW_TEXT);
      let content = "";
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.parentElement?.closest(".code-block-header, button")) {
          content += node.textContent;
        }
      }
      const normalized = content.replace(/\s+/gu, "");
      return (
        normalized.includes(state.expected) ||
        (state.expectedLiteral.length > 0 && normalized.includes(state.expectedLiteral))
      );
    });
  Reflect.set(window, "__tabReturnContentCorrect", correct);
  const sample = () => {
    const current = correct();
    if (state.visibilityAt && !state.correctAt && current) {
      state.correctAt = performance.now();
    }
    return current;
  };
  new MutationObserver((records) => {
    state.mutations += records.length;
    if (document.hidden) {
      state.hiddenMutations += records.length;
    }
    if (
      records.some((record) =>
        (record.target instanceof Element ? record.target : record.target.parentElement)?.closest(
          ".chat-thread",
        ),
      )
    ) {
      state.streamMutations++;
    }
    if (state.visibilityAt) {
      if (sample()) {
        state.finalCommits++;
      }
    }
  }).observe(document, { childList: true, subtree: true, characterData: true });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      return;
    }
    state.visibilityAt = performance.now();
    state.correctAt = 0;
    state.firstFrameAt = 0;
    sample();
    const frame = () => {
      state.firstFrameAt ||= performance.now();
      const current = correct();
      const thread = document.querySelector<HTMLElement>(
        ".chat-pane-cache__pane--active .chat-thread",
      );
      state.returnFrames.push({
        correct: current,
        bottomDistance: thread ? thread.scrollHeight - thread.scrollTop - thread.clientHeight : -1,
      });
      if (state.returnFrames.length === 1) {
        state.frameTextCorrect = current;
      }
      if (state.returnFrames.length < 3) {
        requestAnimationFrame(frame);
      }
    };
    state.returnFrames = [];
    requestAnimationFrame(frame);
  });
  window.addEventListener("storage", () => state.storageEvents++);
  navigator.serviceWorker?.addEventListener("message", () => state.serviceWorkerMessages++);
  if (typeof BroadcastChannel !== "undefined") {
    const Native = BroadcastChannel;
    window.BroadcastChannel = new Proxy(Native, {
      construct(target, args) {
        const channel = new target(String(args[0]));
        channel.addEventListener("message", () => state.broadcastMessages++);
        return channel;
      },
    });
  }
  if (PerformanceObserver.supportedEntryTypes.includes("longtask")) {
    state.longestReturnTaskMs = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        if (state.visibilityAt && entry.startTime >= state.visibilityAt) {
          state.longestReturnTaskMs = Math.max(state.longestReturnTaskMs ?? 0, entry.duration);
        }
      }
    }).observe({ type: "longtask" });
  }
}

async function read(page: Page, engine: ControlUiEngine) {
  let heap: unknown = null;
  if (engine === "chromium") {
    const session = await page.context().newCDPSession(page);
    if (collectGarbage) {
      await session.send("HeapProfiler.collectGarbage");
    }
    heap = await session.send("Runtime.getHeapUsage");
    await session.detach();
  }
  return {
    heap,
    resources: await readControlUiResourceCounts(page),
    page: await page.evaluate(
      (serviceWorkersSupported) => ({
        ...Reflect.get(window, "__tabReturn"),
        serviceWorkerMessages: serviceWorkersSupported
          ? Reflect.get(window, "__tabReturn").serviceWorkerMessages
          : null,
        visibility: document.visibilityState,
        nodes: document.querySelectorAll("*").length,
        gatewayPhase: window.openclawControlUi?.snapshot().gatewayPhase ?? null,
        socketCount:
          (window as MockGatewayWindow).openclawControlUiE2eGateway?.socketCount() ?? null,
        requestCount:
          (window as MockGatewayWindow).openclawControlUiE2eGateway?.requests.length ?? 0,
      }),
      engine !== "webkit",
    ),
  };
}

const rows: unknown[] = [];
await write("manifest.json", {
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  bundles,
  pairs,
  minutes,
  tabCounts,
  modes,
  idleMs,
  engines,
  trace: values.trace,
  collectGarbage,
  contract: `Production HTTP bundle with existing synthetic Gateway; same-origin tabs share browser storage. One delta per simulated second plus tool/session events each minute, delivered in distinct MessageChannel tasks without wall-clock waits. This scales event count/content, not real elapsed timers or server/network load. Chrome uses headless=new, a noDefaults context, and native tab activation or window minimization. WebKit uses native test-activity emulation through its page-proxy protocol; real document visibility and stopped animation frames are asserted, without JavaScript visibility overrides. WebKit service workers are blocked and their message count is unavailable. Chromium CPU is renderer threadTicks; ${collectGarbage ? "heap is collected before every endpoint for retention diagnostics only" : "heap is uncollected used heap, not a leak verdict"}. Longest task is the Long Tasks API (50ms threshold), not a full task trace. Full normalized fixture content and first return frame are sampled in the browser.`,
  acceptance: collectGarbage
    ? "Retention diagnostic only: Chromium collects garbage before every resource/heap endpoint. These runs must not be used for timing acceptance."
    : "Before/after performance changes require 20 rotated pairs plus identical-base control, >=5% hidden CPU or return application-latency win, no visible streaming regression beyond 5% median/no worse p95 (confirm noisy cells). Unsupported engine metrics remain missing.",
});
for (const engine of engines) {
  if (engine === "firefox") {
    rows.push({ engine, status: "skipped", reason: FIREFOX_HIDDEN_TAB_UNSUPPORTED_REASON });
    continue;
  }
  for (const mode of modes) {
    for (const count of tabCounts) {
      for (const duration of minutes) {
        // Session and disconnect cases exercise the longest stream only; duration matrix belongs to stream.
        if (mode !== "stream" && duration !== minutes.at(-1)) {
          continue;
        }
        for (let pair = 0; pair < pairs; pair++) {
          for (const bundle of controlUiBenchOrder(bundles, pair)) {
            const id = `${engine}-${mode}-${duration}m-${count}tabs-${pair + 1}-${bundle.name}`;
            const started = performance.now();
            const server = await startControlUiBenchGatewayServer(bundle.dir);
            const browser = await (
              engine === "chromium"
                ? launchTalkObservationBrowser(output, false)
                : (async () => {
                    const instance = await webkit.launch({ headless: true });
                    try {
                      const context = await instance.newContext({
                        viewport: { width: 1440, height: 1000 },
                        serviceWorkers: "block",
                      });
                      return { browser: instance, context, close: () => instance.close() };
                    } catch (error) {
                      await instance.close();
                      throw error;
                    }
                  })()
            ).catch(async (error: unknown) => {
              await server.close();
              throw error;
            });
            const tabs: Array<{
              page: Page;
              gateway: Awaited<ReturnType<typeof installMockGateway>>;
            }> = [];
            const measurements: Array<Awaited<ReturnType<typeof startEngineMeasurement>>> = [];
            let entry: Record<string, unknown> = {
              id,
              engine,
              mode,
              duration,
              count,
              pair,
              bundle: bundle.name,
              hostLoad: os.loadavg(),
              browserVersion: browser.browser.version(),
              serviceWorkerObservation: engine === "webkit" ? "unsupported-blocked" : "enabled",
            };
            try {
              const html = await readFile(path.join(bundle.dir, "index.html"), "utf8");
              const raw = html.match(
                /globalThis\.OPENCLAW_CONTROL_UI_BUILD_INFO=(\{.*?\});<\/script>/su,
              )?.[1];
              if (!raw) {
                throw new Error("Missing production build identity");
              }
              const build = normalizeControlUiBuildInfo(JSON.parse(raw));
              const baseFixture = createScenarioFixture(build.buildId, build.version!, typing);
              const fixture = { ...baseFixture, sessions: baseFixture.sessions.slice(0, 30) };
              if (mode === "sessions") {
                Object.assign(
                  fixture.sessions.find((row) => row.key === "agent:main:interaction-b")!,
                  {
                    status: "running",
                    hasActiveRun: true,
                    activeRunIds: ["tab-return-secondary-run"],
                    startedAt: 1_800_000_000_000,
                    updatedAt: 1_800_000_000_000,
                    lastReadAt: 1_800_000_000_000,
                    unread: false,
                  },
                );
              }
              const history = fixture.sessionTranscripts?.[sessionKey]?.messages;
              if (!history) {
                throw new Error("Missing tab return history fixture");
              }
              for (let index = 0; index < count; index++) {
                const page = await browser.context.newPage();
                await page.bringToFront();
                await page.setViewportSize({ width: 1440, height: 1000 });
                page.setDefaultTimeout(30_000);
                await page.addInitScript("globalThis.__name = (fn) => fn");
                await page.addInitScript(installControlUiResourceCounts);
                await page.addInitScript(installProbe);
                await page.addInitScript(
                  ({ key, gatewayUrl }) => {
                    if (!localStorage.getItem(key)) {
                      localStorage.setItem(
                        key,
                        JSON.stringify({ gatewayUrl, lobsterPetVisits: false }),
                      );
                    }
                  },
                  {
                    key: controlUiBundledSettingsStorageKey(server.baseUrl),
                    gatewayUrl: controlUiBundledGatewayUrl(server.baseUrl),
                  },
                );
                const gateway = await installMockGateway(page, {
                  ...fixture,
                  awaitInitialRoster: false,
                });
                tabs.push({ page, gateway });
                await page.goto(new URL(controlUiSessionPath(sessionKey), server.baseUrl).href);
                await waitForControlUiInitialRoster(page, 30_000);
                await page.locator(composer).waitFor();
                await switching.prepare(page, gateway);
                await frames(page);
                if (mode === "sessions") {
                  await page
                    .locator(
                      '.sidebar-recent-session[data-session-key="agent:main:interaction-b"] .session-glyph--running',
                    )
                    .waitFor();
                }
              }
              const active = tabs[0]!;
              await active.page.bringToFront();
              const visibility =
                engine === "chromium"
                  ? await browser.context.newCDPSession(active.page)
                  : undefined;
              const windowId = visibility
                ? (await visibility.send("Browser.getWindowForTarget")).windowId
                : undefined;
              if (engine === "webkit") {
                for (const [index, tab] of tabs.entries()) {
                  await setControlUiWebKitTabVisibility(
                    tab.page,
                    count > 1 && index === 0 ? "visible" : "hidden",
                  );
                }
              } else if (count === 1) {
                await visibility!.send("Browser.setWindowBounds", {
                  windowId: windowId!,
                  bounds: { windowState: "minimized" },
                });
              }
              await Promise.all(
                tabs.map(({ page }, index) =>
                  page.waitForFunction(
                    (expected) => document.visibilityState === expected,
                    count > 1 && index === 0 ? "visible" : "hidden",
                    { polling: 50 },
                  ),
                ),
              );
              await delay(idleMs);
              const before = await Promise.all(tabs.map(({ page }) => read(page, engine)));
              for (const tab of tabs) {
                measurements.push(
                  await startEngineMeasurement(tab.page, engine, { trace: values.trace }),
                );
              }
              const n = duration * 60;
              const suffix = `Tab return complete after ${n} updates.`;
              const finalText =
                reply +
                Array.from(
                  { length: n },
                  (_, i) => `Checkpoint ${i + 1}: accepted synthetic work.\n`,
                ).join("") +
                suffix;
              // Each page receives identical Gateway events. MessageChannel yields preserve event task
              // boundaries without hidden-page timeout clamping changing the simulated event count.
              await Promise.all(
                tabs.map(({ page }) =>
                  page.evaluate(
                    async ({
                      n: updates,
                      reply: initialReply,
                      suffix: finalSuffix,
                      runId: streamRunId,
                      sessionKey: streamSessionKey,
                      mode: streamMode,
                      history: historyMessages,
                      expectedContent,
                      expectedLiteral,
                      rosterKeys,
                    }) => {
                      const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
                      const probe = Reflect.get(window, "__tabReturn");
                      probe.expected = expectedContent;
                      probe.expectedLiteral = expectedLiteral;
                      probe.visibilityAt = 0;
                      let text = initialReply;
                      const toolMessages: unknown[] = [];
                      const channel = new MessageChannel();
                      let advance: (() => void) | undefined;
                      channel.port1.addEventListener("message", () => advance?.());
                      channel.port1.start();
                      const nextTask = () =>
                        new Promise<void>((resolve) => {
                          advance = resolve;
                          channel.port2.postMessage(null);
                        });
                      try {
                        for (let i = 1; i <= updates; i++) {
                          text += `Checkpoint ${i}: accepted synthetic work.\n`;
                          gateway.emit("chat", {
                            sessionKey: streamSessionKey,
                            runId: streamRunId,
                            seq: i,
                            state: "delta",
                            message: { role: "assistant", content: [{ type: "text", text }] },
                          });
                          if (i % 60 === 0) {
                            const toolCallId = `tab-tool-${i}`;
                            const outputText = `Tool checkpoint ${i}.`;
                            gateway.emit("agent", {
                              sessionKey: streamSessionKey,
                              runId: streamRunId,
                              stream: "tool",
                              seq: i,
                              data: {
                                phase: "result",
                                toolCallId,
                                name: "exec",
                                result: outputText,
                              },
                            });
                            const messageSeq = historyMessages.length + i / 60;
                            const toolMessage = {
                              role: "assistant",
                              runId: streamRunId,
                              toolCallId,
                              timestamp: 1_800_000_000_000 + i * 1000,
                              content: [
                                { type: "toolcall", name: "exec", arguments: {} },
                                { type: "toolresult", name: "exec", text: outputText },
                              ],
                              __openclaw: { id: toolCallId, seq: messageSeq, runId: streamRunId },
                            };
                            toolMessages.push(toolMessage);
                            gateway.emit("session.message", {
                              sessionKey: streamSessionKey,
                              runId: streamRunId,
                              hasActiveRun: true,
                              messageId: toolCallId,
                              messageSeq,
                              message: toolMessage,
                            });
                            if (streamMode === "sessions") {
                              const row = gateway.getSessionRow("agent:main:interaction-b");
                              const updatedRow = {
                                ...row,
                                label: `Hidden session checkpoint ${i}`,
                                updatedAt: 1_800_000_000_000 + i * 1000,
                                ...(i === updates
                                  ? {
                                      status: "done",
                                      hasActiveRun: false,
                                      activeRunIds: [],
                                      lastRunId: "tab-return-secondary-run",
                                      endedAt: 1_800_000_000_000 + i * 1000,
                                      lastActivityAt: 1_800_000_000_000 + i * 1000,
                                      unread: true,
                                    }
                                  : {}),
                              };
                              gateway.setSessionsListResponse({
                                sessions: rosterKeys.map((key) =>
                                  key === row.key ? updatedRow : gateway.getSessionRow(key),
                                ),
                              });
                              gateway.emit("sessions.changed", {
                                sessionKey: row.key,
                                sessionId: row.sessionId,
                                agentId: "main",
                                reason: "lifecycle",
                                ts: 1_800_000_000_000 + i * 1000,
                                session: updatedRow,
                                ancestorSessions: [],
                              });
                            }
                          }
                          await nextTask();
                        }
                        text += finalSuffix;
                        // Set the authoritative reconnect history before the final notification.
                        const finalMessage = {
                          role: "assistant",
                          content: [{ type: "text", text }],
                          timestamp: 1_800_001_800_000,
                          __openclaw: {
                            id: "tab-return-final",
                            seq: historyMessages.length + toolMessages.length + 1,
                            runId: streamRunId,
                          },
                        };
                        const row = gateway.getSessionRow(streamSessionKey);
                        const response = {
                          sessionId: row.sessionId,
                          sessionInfo: row,
                          inFlightRun: null,
                          messages: [...historyMessages, ...toolMessages, finalMessage],
                        };
                        for (const method of ["chat.startup", "chat.history"]) {
                          gateway.setMethodResponse(method, {
                            cases: [{ match: { sessionKey: streamSessionKey }, response }],
                          });
                        }
                        if (streamMode === "disconnect") {
                          probe.socketCountBeforeDisconnect = gateway.socketCount();
                          gateway.setOnline(false);
                        }
                        gateway.emit("chat", {
                          sessionKey: streamSessionKey,
                          runId: streamRunId,
                          seq: updates + 1,
                          state: "final",
                          message: finalMessage,
                        });
                      } finally {
                        channel.port1.close();
                        channel.port2.close();
                      }
                    },
                    {
                      n,
                      reply,
                      suffix,
                      runId,
                      sessionKey,
                      mode,
                      history,
                      expectedContent: normalizeExpectedReply(finalText),
                      expectedLiteral: finalText.replace(/\s+/gu, ""),
                      rosterKeys: fixture.sessions.map((row) => row.key),
                    },
                  ),
                ),
              );
              if (mode === "disconnect") {
                await Promise.all(
                  tabs.map(({ page }) =>
                    page.waitForFunction(
                      () => window.openclawControlUi?.snapshot().gatewayPhase === "reconnecting",
                      undefined,
                      { polling: 50 },
                    ),
                  ),
                );
              }
              await delay(100);
              const hiddenMetrics = [];
              for (const measurement of measurements.splice(0)) {
                hiddenMetrics.push((await measurement.stop()).metrics);
              }
              const hidden = await Promise.all(tabs.map(({ page }) => read(page, engine)));
              const returning = tabs.at(-1)!;
              if (mode === "disconnect") {
                await returning.gateway.setOnline(true);
              }
              if (engine === "webkit") {
                for (const tab of tabs) {
                  if (tab !== returning) {
                    await setControlUiWebKitTabVisibility(tab.page, "hidden");
                  }
                }
              }
              const returnMeasurement = await startEngineMeasurement(returning.page, engine, {
                trace: values.trace,
              });
              if (engine === "webkit") {
                await setControlUiWebKitTabVisibility(returning.page, "visible");
              } else {
                if (count === 1) {
                  await visibility!.send("Browser.setWindowBounds", {
                    windowId: windowId!,
                    bounds: { windowState: "normal" },
                  });
                }
                await returning.page.bringToFront();
              }
              await returning.page.waitForFunction(
                () => {
                  const state = Reflect.get(window, "__tabReturn");
                  return state.visibilityAt > 0 && state.correctAt > 0 && state.firstFrameAt > 0;
                },
                undefined,
                { polling: 10 },
              );
              await frames(returning.page);
              const returnMetrics = (await returnMeasurement.stop()).metrics;
              if (mode === "disconnect") {
                await returning.page.waitForFunction(
                  () => {
                    const state = Reflect.get(window, "__tabReturn");
                    const gateway = (window as MockGatewayWindow).openclawControlUiE2eGateway!;
                    return (
                      window.openclawControlUi?.snapshot().gatewayPhase === "connected" &&
                      gateway.socketCount() > state.socketCountBeforeDisconnect
                    );
                  },
                  undefined,
                  { polling: 50 },
                );
              }
              const returned = await read(returning.page, engine);
              if (
                !(await returning.page.evaluate(() =>
                  Reflect.get(window, "__tabReturnContentCorrect")(),
                ))
              ) {
                throw new Error("Final reply lost on return");
              }
              if (await returning.page.locator(`${pane} .chat-bubble.streaming`).count()) {
                throw new Error("Completed reply retained a streaming bubble after return");
              }
              if (mode === "sessions") {
                const completedSession = returning.page.locator(
                  '.sidebar-recent-session[data-session-key="agent:main:interaction-b"]',
                );
                await completedSession
                  .getByText(`Hidden session checkpoint ${n}`, { exact: false })
                  .waitFor();
                await completedSession
                  .locator(".session-glyph--running")
                  .waitFor({ state: "detached" });
                await completedSession.getByRole("img", { name: "Unread", exact: true }).waitFor();
              }
              const timing = await returning.page.evaluate(() => {
                const state = Reflect.get(window, "__tabReturn");
                const samples: Array<{ correct: boolean; bottomDistance: number }> =
                  state.returnFrames;
                const distances = samples
                  .map((sample) => sample.bottomDistance)
                  .filter((distance) => distance >= 0);
                const tailMovementPx = distances.length
                  ? Math.max(...distances) - Math.min(...distances)
                  : null;
                return {
                  applicationMs: state.correctAt - state.visibilityAt,
                  firstFrameMs: state.firstFrameAt - state.visibilityAt,
                  firstFrameCorrect: state.frameTextCorrect,
                  longestTaskMs: state.longestReturnTaskMs,
                  presentationVerdict: {
                    sampledFrames: samples.length,
                    content: samples.every((sample) => sample.correct)
                      ? "up-to-date-in-all-sampled-frames"
                      : samples.some(
                            (sample, index) =>
                              index > 0 && samples[index - 1]!.correct && !sample.correct,
                          )
                        ? "final-content-regressed"
                        : "catch-up-observed",
                    tail:
                      tailMovementPx === null
                        ? "unavailable"
                        : tailMovementPx > 2
                          ? "jump-observed"
                          : "stable",
                    tailMovementPx,
                  },
                };
              });
              if (pair === 0) {
                await returning.page.screenshot({ path: path.join(output, `${id}.png`) });
              }
              const actions: Record<string, unknown> = {};
              const peers = tabs.filter((tab) => tab !== returning);
              const peersBefore = await Promise.all(peers.map((tab) => read(tab.page, engine)));
              const peersMeasurement = [];
              for (const peer of peers) {
                peersMeasurement.push(
                  await startEngineMeasurement(peer.page, engine, { trace: values.trace }),
                );
              }
              const returnSwitch = {
                id: "session-switch",
                run: async (page: Page) => {
                  for (const [key, expected] of [
                    ["agent:main:interaction-b", "Transcript 1 message 399."],
                    [sessionKey, suffix],
                  ]) {
                    await navigation(page, "sessions");
                    await page
                      .locator(
                        `.sidebar-recent-session[data-session-key="${key}"] .sidebar-recent-session__link`,
                      )
                      .click();
                    await page.locator(pane).getByText(expected!, { exact: false }).waitFor();
                    await frames(page);
                  }
                },
              };
              for (const scene of [typing, returnSwitch]) {
                if (scene === typing) {
                  await returning.page.locator(composer).fill("");
                }
                const action = await returning.page.evaluateHandle(createEngineActionTiming, false);
                await action.evaluate((value) => value.start());
                const cpu = await startEngineMeasurement(returning.page, engine, {
                  trace: values.trace,
                });
                await scene.run(returning.page, returning.gateway);
                await action.evaluate((value) => value.endScenario());
                actions[scene.id] = {
                  timing: await action.evaluate((value) => value.finish()),
                  metrics: (await cpu.stop()).metrics,
                };
                await action.dispose();
              }
              const peersMetrics = [];
              for (const measurement of peersMeasurement) {
                peersMetrics.push((await measurement.stop()).metrics);
              }
              const peersAfter = await Promise.all(peers.map((tab) => read(tab.page, engine)));
              // Read the existing cache input after returning to the session; no diagnostic owner is added.
              const toolProof = await returning.page.evaluate(
                ({ key, updates }) => {
                  const host = document.querySelector(".chat-pane-cache__pane--active");
                  const cache: ChatMessageCache | undefined = host
                    ? Reflect.get(host, "chatMessagesBySession")
                    : undefined;
                  const messages =
                    [...(cache ?? [])].find(([cacheKey]) => cacheKey.endsWith(`\u0000${key}`))?.[1]
                      .snapshot.messages ?? [];
                  const outputs = new Map<string, string>();
                  for (const message of messages) {
                    if (
                      !message ||
                      typeof message !== "object" ||
                      !("toolCallId" in message) ||
                      typeof message.toolCallId !== "string" ||
                      !("content" in message) ||
                      !Array.isArray(message.content)
                    ) {
                      continue;
                    }
                    for (const block of message.content) {
                      if (
                        block &&
                        typeof block === "object" &&
                        block.type === "toolresult" &&
                        typeof block.text === "string"
                      ) {
                        outputs.set(message.toolCallId, block.text);
                      }
                    }
                  }
                  const missing = [];
                  for (let index = 60; index <= updates; index += 60) {
                    if (outputs.get(`tab-tool-${index}`) !== `Tool checkpoint ${index}.`) {
                      missing.push(index);
                    }
                  }
                  return {
                    expected: updates / 60,
                    retained: updates / 60 - missing.length,
                    missing,
                  };
                },
                { key: sessionKey, updates: n },
              );
              if (toolProof.missing.length) {
                throw new Error(`Completed tool output lost: ${toolProof.missing.join(", ")}`);
              }
              // Expand a real retained card after every measured interval, proving its output is usable.
              await returning.page
                .locator(`${pane} [data-message-id*="tab-return-final"]`)
                .evaluate((element) => element.scrollIntoView({ block: "start" }));
              await returning.page
                .locator(`${pane} .chat-thread`)
                .evaluate((element) =>
                  element.scrollBy({ top: -element.clientHeight / 2, behavior: "instant" }),
                );
              const group = returning.page.locator(`${pane} .chat-activity-group__summary`).last();
              if (
                (await group.count()) &&
                (await group.getAttribute("aria-expanded")) === "false"
              ) {
                await group.click();
              }
              const tool = returning.page.locator(`${pane} [data-message-id*="tab-tool-${n}"]`);
              const summary = tool
                .locator(
                  "button.chat-tool-msg-summary[aria-expanded], button.chat-tool-row[aria-expanded]",
                )
                .first();
              await summary.waitFor({ state: "visible" });
              if ((await summary.getAttribute("aria-expanded")) === "false") {
                await summary.click();
              }
              await tool
                .getByText(`Tool checkpoint ${n}.`, { exact: true })
                .waitFor({ state: "visible" });
              await visibility?.detach();
              entry = {
                ...entry,
                status: "passed",
                events: n,
                finalCharacters: finalText.length,
                before,
                hidden,
                hiddenMetrics,
                returned,
                returnMetrics,
                timing,
                actions,
                peersBefore,
                peersAfter,
                peersMetrics,
                toolProof: { ...toolProof, representativeOutputVisible: true },
                sessionProof:
                  mode === "sessions"
                    ? { runningBeforeHide: true, completedOnReturn: true, unreadOnReturn: true }
                    : undefined,
                wallMs: performance.now() - started,
              };
            } catch (error) {
              entry = {
                ...entry,
                status: "failed",
                error: String(error),
                wallMs: performance.now() - started,
                diagnostics: await Promise.all(
                  tabs.map(async (tab) => ({
                    url: tab.page.url(),
                    visible: await tab.page
                      .evaluate(() => document.visibilityState)
                      .catch(() => null),
                    text: await tab.page
                      .locator("body")
                      .textContent()
                      .catch(() => ""),
                  })),
                ),
              };
              if (tabs.length) {
                await tabs
                  .at(-1)!
                  .page.screenshot({ path: path.join(output, `${id}-failed.png`) })
                  .catch(() => {});
              }
              for (const measurement of measurements.splice(0)) {
                await measurement.stop().catch(() => {});
              }
            } finally {
              rows.push(entry);
              await write(`${id}.json`, entry);
              await write("observations.json", rows);
              console.log(
                JSON.stringify({
                  id,
                  status: entry.status,
                  error: entry.error,
                  timing: entry.timing,
                }),
              );
              await browser.close();
              await server.close();
            }
          }
        }
      }
    }
  }
}
console.log(`Tab-return evidence: ${output}`);
if (
  rows.some(
    (row) => typeof row === "object" && row !== null && Reflect.get(row, "status") === "failed",
  )
) {
  process.exitCode = 1;
}
