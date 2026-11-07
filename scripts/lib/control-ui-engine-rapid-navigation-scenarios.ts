import assert from "node:assert/strict";
import type { Page } from "playwright";
import { pathForRoute } from "../../ui/src/app-route-paths.ts";
import type { MockGatewayWindow } from "../../ui/src/test-helpers/control-ui-e2e-contract.ts";
import { controlUiSessionPath } from "../../ui/src/test-helpers/control-ui-e2e.ts";
import { navigationDrawerToggle } from "../../ui/src/test-helpers/control-ui-navigation.ts";
import { persistColdLoadWarmState } from "./control-ui-bench-warm-state.ts";
import type { EngineScenario } from "./control-ui-engine-boot-scenarios.ts";
import { createEnginePageScenarios } from "./control-ui-engine-page-scenarios.ts";
import { frames, navigation, prepareChat } from "./control-ui-interaction-navigation.ts";
import {
  interactionScenarios,
  type InteractionEvidence,
} from "./control-ui-interaction-scenarios.ts";

const pane = ".chat-pane-cache__pane--active";
const composer = `${pane} .agent-chat__composer-combobox textarea`;
const sessionKey = (index: number) =>
  ["agent:main:interaction-a", "agent:main:interaction-b"][index] ??
  `agent:main:interaction-${index}`;
const sessionLink = (index: number) =>
  `.sidebar-recent-session[data-session-key="${sessionKey(index)}"] .sidebar-recent-session__link`;

/** Locate a hittable point without Locator.click's animation-stability wait. */
async function clickAtCurrentPosition(page: Page, selector: string) {
  const point = await page.locator(selector).evaluate(async (element) => {
    element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      const rect = element.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const right = Math.min(innerWidth, rect.right);
      const top = Math.max(0, rect.top);
      const bottom = Math.min(innerHeight, rect.bottom);
      const x = (left + right) / 2;
      const y = (top + bottom) / 2;
      if (right > left && bottom > top && element.contains(document.elementFromPoint(x, y))) {
        return { x, y };
      }
      await new Promise<void>((resolve) => {
        requestAnimationFrame(() => resolve());
      });
    }
    throw new Error("Rapid input target did not become hittable within 5 seconds");
  });
  await page.mouse.click(point.x, point.y);
}

type Outcome = {
  selector: string;
  minimum?: number;
  sessionKey?: string;
  marker?: string;
  pathname?: string;
  value?: string;
  activeDescendant?: string;
  hidden?: boolean;
};

/** Browser timestamps measure delivery and application readiness, never abandoned-work CPU. */
function observeRapidNavigation(options: {
  count: number;
  intervalMs: number;
  inputSelector: string;
  event: "pointerdown" | "keydown" | "input";
  recordInput?: boolean;
  tailMs?: number;
  outcome: Outcome;
}) {
  const started = performance.now();
  // SAFETY: The harness installs the mock Gateway before navigating this document.
  const mock = (window as MockGatewayWindow).openclawControlUiE2eGateway;
  if (!mock) {
    throw new Error("Rapid navigation requires the installed Gateway fixture");
  }
  const requestsBefore = mock.requests.length;
  const delivered: number[] = [];
  const handlerDelay: number[] = [];
  const requestsAtInput: number[] = [];
  let bootInputSamples = 0;
  let armed = -1;
  let settledAt = 0;
  let correctFrames = 0;
  let correctSeen = false;
  let staleAfterCorrect = 0;
  let stopped = false;
  let longestTask = 0;
  let frame = 0;
  const outcome = options.outcome;
  const readCorrect = () => {
    const element = document.querySelector<HTMLElement>(outcome.selector);
    if (outcome.hidden) {
      return !element || !element.checkVisibility();
    }
    if (!element?.checkVisibility()) {
      return false;
    }
    const minimum = outcome.minimum;
    if (minimum) {
      const rows = document.querySelectorAll(outcome.selector);
      // Windowed lists declare the loaded page size on their mounted rows.
      if (
        rows.length < minimum &&
        ![...rows].some((row) => Number(row.getAttribute("aria-setsize")) >= minimum)
      ) {
        return false;
      }
    }
    if (outcome.sessionKey) {
      if (
        Reflect.get(element, "sessionKey") !== outcome.sessionKey ||
        Reflect.get(element, "transcriptReady") !== true ||
        ![...element.querySelectorAll<HTMLElement>(".chat-text")].some(
          (row) => row.checkVisibility() && row.textContent?.includes(outcome.marker ?? ""),
        )
      ) {
        return false;
      }
      const input = element.querySelector<HTMLTextAreaElement>(
        ".agent-chat__composer-combobox textarea",
      );
      if (!input || input.disabled || !input.checkVisibility()) {
        return false;
      }
      if (outcome.value !== undefined && input.value !== outcome.value) {
        return false;
      }
    }
    if (outcome.pathname) {
      const route = window.openclawControlUi?.snapshot().route;
      if (
        location.pathname !== outcome.pathname ||
        !route ||
        route.pendingMatches.length > 0 ||
        route.resolvedLocation?.pathname !== outcome.pathname
      ) {
        return false;
      }
    }
    if (
      outcome.activeDescendant !== undefined &&
      element.getAttribute("aria-activedescendant") !== outcome.activeDescendant
    ) {
      return false;
    }
    return true;
  };
  const sample = () => {
    if (stopped) {
      return;
    }
    if (delivered[options.count - 1] !== undefined) {
      const correct = readCorrect();
      if (correctSeen && !correct) {
        staleAfterCorrect++;
      }
      correctSeen ||= correct;
      correctFrames = correct ? correctFrames + 1 : 0;
      // Two consecutive frames with the final state; this is readiness, not paint timing.
      if (correctFrames === 2) {
        settledAt = performance.now();
      } else if (!correct) {
        settledAt = 0;
      }
    }
    frame = requestAnimationFrame(sample);
  };
  const record = (event: Event) => {
    if (
      event.isTrusted &&
      armed >= 0 &&
      event.target instanceof Element &&
      event.target.closest(options.inputSelector)
    ) {
      const now = performance.now();
      const delay = now - event.timeStamp;
      if (event.type === "input") {
        if (event.target.id === "openclaw-boot-composer") {
          bootInputSamples++;
        }
        // A typing action ends at its last native edit, not its first character.
        delivered[armed] = now;
        requestsAtInput[armed] = mock.requests.length;
      } else if (delivered[armed] === undefined) {
        delivered[armed] = now;
        requestsAtInput[armed] = mock.requests.length;
      }
      // Some engines use another clock epoch. This is event-to-handler delay, not INP.
      if (event.timeStamp > 0 && delay >= 0 && delay <= 60_000) {
        handlerDelay[armed] = delay;
      }
    }
  };
  document.addEventListener(options.event, record, true);
  if (options.recordInput && options.event !== "input") {
    document.addEventListener("input", record, true);
  }
  const longTasksSupported = PerformanceObserver.supportedEntryTypes.includes("longtask");
  const longTasks = longTasksSupported
    ? new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          longestTask = Math.max(longestTask, entry.duration);
        }
      })
    : undefined;
  longTasks?.observe({ type: "longtask" });
  frame = requestAnimationFrame(sample);
  return {
    arm(index: number) {
      armed = index;
      return Math.max(0, started + index * options.intervalMs - performance.now());
    },
    markProgrammaticInput() {
      delivered[armed] ??= performance.now();
      requestsAtInput[armed] = mock.requests.length;
    },
    ready() {
      return settledAt > 0;
    },
    finish(): InteractionEvidence {
      const last = delivered[options.count - 1];
      if (last === undefined || !settledAt || !readCorrect()) {
        throw new Error("Rapid navigation did not deliver and settle the final input");
      }
      const evidence: InteractionEvidence = {
        inputSamples: delivered.filter((value) => value !== undefined).length,
        bootInputSamples,
        requestedIntervalMs: options.intervalMs,
        finalInputToSettledMs: settledAt - last,
        inputSequenceMs: last - (delivered[0] ?? last),
        finalStateCorrect: true,
        staleFramesAfterFinalState: staleAfterCorrect,
        longTasksSupported,
        abandonedCpuAttributionAvailable: false,
        retainedPanes: document.querySelectorAll(".chat-pane-cache__pane").length,
        hiddenRetainedPanes: document.querySelectorAll('.chat-pane-cache__pane[aria-hidden="true"]')
          .length,
      };
      if (longTasksSupported) {
        for (const entry of longTasks?.takeRecords() ?? []) {
          longestTask = Math.max(longestTask, entry.duration);
        }
        evidence.longestTaskMs = longestTask;
      }
      delivered.forEach((at, index) => {
        evidence[`input${index}ScheduledMs`] = index * options.intervalMs;
        evidence[`input${index}DeliveredMs`] = at - started;
        evidence[`input${index}LatenessMs`] = at - started - index * options.intervalMs;
        if (handlerDelay[index] !== undefined) {
          evidence[`input${index}EventToHandlerMs`] = handlerDelay[index]!;
        }
        if (index > 0) {
          evidence[`input${index}GapMs`] = at - delivered[index - 1]!;
        }
      });
      const requests = mock.requests.slice(requestsBefore);
      const afterFinal = mock.requests.slice(requestsAtInput[options.count - 1]);
      evidence.rpcRequests = requests.length;
      evidence.rpcRequestsAfterFinalInput = afterFinal.length;
      const histories = requests.filter(
        (request) => request.method === "sessions.messages.subscribe",
      );
      evidence.historyRequests = histories.length;
      evidence.nonFinalSessionHistoryRequests = histories.filter((request) => {
        const params = request.params;
        return (
          typeof params === "object" &&
          params !== null &&
          Reflect.get(params, "key") !== outcome.sessionKey
        );
      }).length;
      for (const method of [
        "chat.startup",
        "chat.history",
        "models.authStatus",
        "agent.identity.get",
        "sessions.messages.subscribe",
        "node.list",
        "device.pair.list",
        "config.get",
        "exec.approvals.get",
      ]) {
        evidence[`rpc:${method}`] = requests.filter((request) => request.method === method).length;
        evidence[`rpc:${method}:afterFinal`] = afterFinal.filter(
          (request) => request.method === method,
        ).length;
      }
      const resources = performance.getEntriesByType("resource");
      for (const [label, extension] of [
        ["js", /\.m?js$/u],
        ["css", /\.css$/u],
      ] as const) {
        const completed = resources.filter(
          (entry) => entry.startTime >= started && extension.test(new URL(entry.name).pathname),
        );
        // ResourceTiming contains completed requests only; an in-flight request is not zero work.
        evidence[`${label}RequestsCompleted`] = completed.length;
        evidence[`${label}RequestsCompletedAfterFinalInput`] = completed.filter(
          (entry) => entry.startTime + entry.duration > last,
        ).length;
      }
      return evidence;
    },
    dispose() {
      stopped = true;
      cancelAnimationFrame(frame);
      document.removeEventListener(options.event, record, true);
      if (options.recordInput && options.event !== "input") {
        document.removeEventListener("input", record, true);
      }
      longTasks?.disconnect();
    },
  };
}

async function runSequence(
  page: Page,
  options: Parameters<typeof observeRapidNavigation>[0],
  action: (index: number) => Promise<void>,
  programmatic = false,
  beforeInput?: () => Promise<void>,
): Promise<InteractionEvidence> {
  const observation = await page.evaluateHandle(observeRapidNavigation, options);
  try {
    if (beforeInput) {
      await beforeInput();
    }
    for (let index = 0; index < options.count; index++) {
      const wait = await observation.evaluate((probe, i) => probe.arm(i), index);
      if (wait > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, wait);
        });
      }
      if (programmatic) {
        await observation.evaluate((probe) => probe.markProgrammaticInput());
      }
      // Await driver delivery only. Never wait for this destination's content or route readiness.
      await action(index);
    }
    await page.waitForFunction((probe) => probe.ready(), observation, { timeout: 30_000 });
    // Observe late superseded work separately from the first correct-frame timestamp.
    await page.waitForTimeout(options.tailMs ?? 250);
    const evidence = await observation.evaluate((probe) => probe.finish());
    assert.equal(evidence.inputSamples, options.count, "Every requested input must be delivered");
    assert.equal(evidence.staleFramesAfterFinalState, 0, "Final destination flashed stale content");
    return { ...evidence, nativeInput: !programmatic, observationTailMs: options.tailMs ?? 250 };
  } finally {
    await observation.evaluate((probe) => probe.dispose());
    await observation.dispose();
  }
}

type RapidSnapshotGate = {
  pending: boolean;
  sessionKey: string;
  heldAtMs: number;
  paneObservedAtMs: number;
  pendingPane?: HTMLElement;
  release(): void;
};

declare global {
  interface Window {
    openclawRapidSnapshotGate?: RapidSnapshotGate;
  }
}

/** Hold only the first prewarm open; other database consumers retain their normal lifecycle. */
function installHeldSnapshotOpen(input: { sessionKey: string }) {
  const factory = window.indexedDB;
  const descriptor = Object.getOwnPropertyDescriptor(factory, "open");
  const open = factory.open.bind(factory);
  let requestToRelease: IDBOpenDBRequest | undefined;
  let intercepted = false;
  let held = true;
  const restore = () => {
    if (descriptor) {
      Object.defineProperty(factory, "open", descriptor);
    } else {
      Reflect.deleteProperty(factory, "open");
    }
  };
  const gate: RapidSnapshotGate = {
    pending: false,
    sessionKey: input.sessionKey,
    heldAtMs: 0,
    paneObservedAtMs: 0,
    release() {
      if (!held) {
        return;
      }
      held = false;
      gate.pending = false;
      restore();
      const request = requestToRelease;
      requestToRelease = undefined;
      if (request) {
        queueMicrotask(() => request.dispatchEvent(new Event("success")));
      }
    },
  };
  factory.open = (name, version) => {
    const request = open(name, version);
    if (name === "openclaw-chat-snapshots" && !intercepted && held) {
      intercepted = true;
      request.addEventListener(
        "success",
        (event) => {
          if (!held) {
            return;
          }
          event.stopImmediatePropagation();
          requestToRelease = request;
          gate.pending = true;
          gate.heldAtMs = performance.now();
        },
        { once: true },
      );
    }
    return request;
  };
  window.openclawRapidSnapshotGate = gate;
  window.addEventListener("pagehide", () => gate.release(), { once: true });
}

function cachedAdmissionScenario(leave: boolean): EngineScenario {
  return {
    id: leave ? "rapid-cached-admission-leave" : "rapid-cached-admission-direct",
    route: controlUiSessionPath(sessionKey(0)),
    navigation: "reload",
    explicitOnly: true,
    ...sessionFixture(),
    expected: leave
      ? "Leaving a cached session before its snapshot opens preserves the new destination and counts hidden admission."
      : "Releasing the held snapshot admits the current session from its real persisted cache.",
    prepare: async (page) => {
      await page
        .locator(pane)
        .getByText("Rapid session 0 message 399.", { exact: false })
        .waitFor();
      await navigation(page, "sessions");
      await page
        .locator('aside.sidebar[data-snapshot-saved="true"]')
        .waitFor({ state: "attached" });
      const warmInput: Parameters<typeof persistColdLoadWarmState>[0] = {
        sessionKey: sessionKey(0),
        sidebarView: "sessions",
      };
      const saved = await page.evaluate(persistColdLoadWarmState, warmInput);
      // Disk projection keeps the final 80 messages; its tail marker remains message 399.
      assert.equal(saved.messages, 80);
      await page.addInitScript(installHeldSnapshotOpen, { sessionKey: sessionKey(0) });
    },
    run: async (page) => {
      await page.reload({ waitUntil: "commit" });
      let holdEvidence: InteractionEvidence = {};
      try {
        const evidence = await runSequence(
          page,
          {
            count: 1,
            intervalMs: 0,
            event: "pointerdown",
            inputSelector: "body",
            outcome: {
              selector: pane,
              sessionKey: sessionKey(leave ? 1 : 0),
              marker: `Rapid session ${leave ? 1 : 0} message 399.`,
            },
          },
          async () => {
            holdEvidence = await page.evaluate(
              async ({ navigateAway, destination }) => {
                const gate = window.openclawRapidSnapshotGate;
                const old = gate?.pendingPane;
                if (
                  !gate?.pending ||
                  !old?.isConnected ||
                  old.querySelector("[data-cached-session]")
                ) {
                  throw new Error(
                    "Cached admission probe setup: the pending pane passed its unchanged 100 ms admission deadline",
                  );
                }
                if (navigateAway) {
                  window.openclawControlUi!.navigate("chat", { pathname: destination });
                  await new Promise<void>((resolve) => {
                    requestAnimationFrame(() => resolve());
                  });
                  if (
                    !gate.pending ||
                    old.getAttribute("aria-hidden") !== "true" ||
                    old.querySelector("[data-cached-session]")
                  ) {
                    throw new Error(
                      "Cached admission probe setup: the original pane was not hidden while its read remained pending",
                    );
                  }
                }
                const facts = {
                  realOwnerCachedAdmissionProbe: true,
                  snapshotAdmissionDeadlineMs: 100,
                  snapshotReadPendingBeforeRelease: gate.pending,
                  snapshotOpenHeldMs: performance.now() - gate.heldAtMs,
                  pendingPaneBeforeReleaseMs: performance.now() - gate.paneObservedAtMs,
                  oldPaneHiddenBeforeRelease: old.getAttribute("aria-hidden") === "true",
                };
                gate.release();
                return facts;
              },
              { navigateAway: leave, destination: controlUiSessionPath(sessionKey(1)) },
            );
          },
          true,
          () =>
            page.evaluate(
              () =>
                new Promise<void>((resolve, reject) => {
                  let frame = 0;
                  const timeout = setTimeout(() => {
                    cancelAnimationFrame(frame);
                    reject(
                      new Error(
                        "Cached admission probe setup: no pending snapshot pane within 5 seconds",
                      ),
                    );
                  }, 5_000);
                  const sample = () => {
                    const gate = window.openclawRapidSnapshotGate;
                    const pendingPane = document.querySelector<HTMLElement>(
                      ".chat-pane-cache__pane--active",
                    );
                    if (gate?.pending && pendingPane && window.openclawControlUi) {
                      clearTimeout(timeout);
                      if (
                        Reflect.get(pendingPane, "sessionKey") !== gate.sessionKey ||
                        !pendingPane.querySelector(".lazy-view-state--loading") ||
                        pendingPane.querySelector("[data-cached-session]")
                      ) {
                        reject(
                          new Error(
                            "Cached admission probe setup: snapshot admission completed before interruption",
                          ),
                        );
                        return;
                      }
                      gate.pendingPane = pendingPane;
                      gate.paneObservedAtMs = performance.now();
                      resolve();
                    } else {
                      frame = requestAnimationFrame(sample);
                    }
                  };
                  sample();
                }),
            ),
        );
        const admission = await page.evaluate(() => {
          const old = window.openclawRapidSnapshotGate?.pendingPane;
          const mounted = old?.querySelector("[data-cached-session]");
          return {
            oldPaneRetained: old?.isConnected === true,
            oldPaneHidden: old?.getAttribute("aria-hidden") === "true",
            oldPaneAdmitted: mounted !== null && mounted !== undefined,
            oldPaneAdmittedFromCache: mounted?.getAttribute("data-cached-session") === "true",
          };
        });
        if (leave) {
          assert(
            !admission.oldPaneRetained || admission.oldPaneHidden,
            "Superseded pane became visible after release",
          );
        } else {
          assert(
            admission.oldPaneAdmittedFromCache,
            "Cached admission control did not admit a persisted snapshot",
          );
        }
        return { ...evidence, ...holdEvidence, ...admission };
      } finally {
        await page.evaluate(() => window.openclawRapidSnapshotGate?.release());
      }
    },
  };
}

function sessionFixture(): Pick<EngineScenario, "fixtureOverrides"> {
  return {
    fixtureOverrides: (_sandbox, base) => ({
      sessions: base.sessions.slice(0, 21),
      sessionTranscripts: Object.fromEntries(
        Array.from({ length: 21 }, (_, session) => [
          sessionKey(session),
          {
            messages: Array.from(
              { length: session % 5 === 0 && session > 0 ? 2_000 : 400 },
              (_message, index) => ({
                role: index % 2 ? "assistant" : "user",
                content: `Rapid session ${session} message ${index}.\n${"Synthetic transcript detail.\n".repeat(4)}`,
                timestamp: 1_800_000_000_000 + index * 1_000,
                __openclaw: { id: `rapid-${session}-${index}`, seq: index + 1 },
              }),
            ),
          },
        ]),
      ),
    }),
  };
}

async function prepareSessions(page: Page) {
  await page.locator(pane).getByText("Rapid session 0 message 399.", { exact: false }).waitFor();
  await page.locator(composer).fill("Synthetic origin draft — keep with session zero");
  await navigation(page, "sessions");
  const more = page.locator('.sidebar-session-pagination__button[aria-label="Show more"]');
  if (await more.isVisible()) {
    await more.click();
    await frames(page);
  }
}

function sessionScenario(count: 5 | 20, intervalMs: number, direct = false): EngineScenario {
  return {
    id: direct ? `rapid-sessions-direct-${count}` : `rapid-sessions-${count}-${intervalMs}ms`,
    route: controlUiSessionPath(sessionKey(0)),
    expected:
      "The last native session click wins, with its own long transcript, draft and scroll position.",
    explicitOnly: true,
    ...sessionFixture(),
    prepare: async (page) => {
      await prepareSessions(page);
      if (direct && count === 20) {
        // Initial row measurement may restore the old scroll anchor; prepare the final
        // virtual window before measuring a direct click, including the mobile scroll owner.
        await page.waitForFunction((selector) => {
          let node: Element | null = document.querySelector(".sidebar-shell__body");
          for (; node; node = node.parentElement) {
            node.scrollTop = node.scrollHeight;
          }
          const target = document.querySelector(selector);
          target?.scrollIntoView({ block: "nearest", behavior: "instant" });
          return target?.checkVisibility() === true;
        }, sessionLink(count));
        await frames(page);
        await page.locator(sessionLink(count)).waitFor({ state: "visible" });
      }
    },
    run: async (page) => {
      const mobile = page.viewportSize()!.width < 768;
      const evidence = await runSequence(
        page,
        {
          count: direct ? 1 : count,
          intervalMs,
          inputSelector: ".sidebar-recent-session__link",
          event: "pointerdown",
          outcome: {
            selector: pane,
            sessionKey: sessionKey(count),
            marker: `Rapid session ${count} message 1999.`,
            value: "",
          },
        },
        async (index) => {
          if (mobile && index > 0) {
            // A real mobile session click closes the drawer; reopening is part of the workload.
            await clickAtCurrentPosition(page, `${pane} .mobile-header__navigation`);
          }
          await clickAtCurrentPosition(page, sessionLink(direct ? count : index + 1));
        },
      );
      const scroll = await page.locator(`${pane} .chat-thread`).evaluate((element) => ({
        bottomGap: element.scrollHeight - element.scrollTop - element.clientHeight,
      }));
      assert(scroll.bottomGap < 100, "A new destination inherited another session's scroll offset");
      return {
        ...evidence,
        mobileDrawerReopens: mobile && !direct ? count - 1 : 0,
        finalBottomGapPx: scroll.bottomGap,
        finalDraftIsEmpty: true,
      };
    },
  };
}

function requiredScenario(id: string) {
  const scenario = interactionScenarios.find((entry) => entry.id === id);
  assert(scenario, `Missing shared scenario: ${id}`);
  return scenario;
}

function modelArrows(count: 5 | 20): EngineScenario {
  const source = requiredScenario("model-picker-navigate");
  return {
    ...source,
    id: `rapid-model-arrows-${count}-50ms`,
    explicitOnly: true,
    expected:
      "Rapid native arrows return to the initial model without changing the selected model.",
    run: async (page) => {
      const input = page.locator("[data-chat-model-search]");
      const initial = await input.getAttribute("aria-activedescendant");
      assert(initial);
      return runSequence(
        page,
        {
          count: count * 2,
          intervalMs: 50,
          event: "keydown",
          inputSelector: "[data-chat-model-search]",
          outcome: { selector: "[data-chat-model-search]", activeDescendant: initial },
        },
        (index) => input.press(index < count ? "ArrowDown" : "ArrowUp"),
      );
    },
  };
}

function routeScenario(
  warm: boolean,
  direct: boolean,
  fixtureOverrides: EngineScenario["fixtureOverrides"],
  native = false,
): EngineScenario {
  const destination = pathForRoute("cron");
  return {
    id: `rapid-${native ? "route-clicks" : "routes"}-${warm ? "warm" : "cold"}${direct ? "-direct" : "-50ms"}`,
    route: "/new",
    explicitOnly: true,
    fixtureOverrides,
    expected: `${native ? "System status" : "Devices"} followed immediately by Automations leaves only the Automations route presented.`,
    prepare: async (page) => {
      await page.waitForFunction(() => window.openclawControlUi !== undefined);
      if (warm) {
        for (const id of ["devices", "cron", "new-session"] as const) {
          await page.evaluate(
            ({ id: routeId, pathname }) =>
              window.openclawControlUi!.navigate(routeId, { pathname }),
            { id, pathname: pathForRoute(id) },
          );
          await page.waitForFunction((pathname) => {
            const route = window.openclawControlUi!.snapshot().route;
            return location.pathname === pathname && route?.pendingMatches.length === 0;
          }, pathForRoute(id));
        }
      }
      if (native) {
        await navigation(page, "pages");
      }
    },
    run: async (page) =>
      runSequence(
        page,
        {
          count: direct ? 1 : 2,
          intervalMs: 50,
          tailMs: 1_000,
          inputSelector: native ? ".sidebar-pages a" : "body",
          event: "pointerdown",
          outcome: {
            selector: "openclaw-cron-page .cron-table__row",
            minimum: 50,
            pathname: destination,
          },
        },
        async (index) => {
          const id: "cron" | "devices" | "systems" =
            direct || index === 1 ? "cron" : native ? "systems" : "devices";
          if (native) {
            if (index > 0 && page.viewportSize()!.width < 768) {
              await navigationDrawerToggle(page).click({ noWaitAfter: true });
            }
            await clickAtCurrentPosition(
              page,
              `.sidebar-pages [data-sidebar-entry="route:${id}"] a`,
            );
            return;
          }
          await page.evaluate(
            ({ id: routeId, pathname }) =>
              window.openclawControlUi!.navigate(routeId, { pathname }),
            { id, pathname: pathForRoute(id) },
          );
        },
        !native,
      ),
  };
}

export function createEngineRapidNavigationScenarios(): EngineScenario[] {
  const devices = createEnginePageScenarios().find(
    (scenario) => scenario.id === "page-devices-visit",
  );
  assert(devices?.fixtureOverrides, "Missing reusable Devices page fixture");
  const deviceFixture = devices.fixtureOverrides;
  const routeFixture: EngineScenario["fixtureOverrides"] = (sandbox, base) => {
    const fixture = deviceFixture(sandbox, base);
    return {
      ...fixture,
      methodResponses: {
        ...fixture.methodResponses,
        "cron.list": base.methodResponses?.["cron.list"],
        "cron.status": base.methodResponses?.["cron.status"],
      },
    };
  };
  return [
    cachedAdmissionScenario(false),
    cachedAdmissionScenario(true),
    ...([5, 20] as const).flatMap((count) => {
      const scenarios = [sessionScenario(count, 0, true)];
      for (const interval of [50, 150, 400]) {
        scenarios.push(sessionScenario(count, interval));
      }
      scenarios.push(modelArrows(count));
      return scenarios;
    }),
    ...[false, true].flatMap((warm) => [
      routeScenario(warm, false, routeFixture),
      routeScenario(warm, true, routeFixture),
    ]),
    routeScenario(false, false, routeFixture, true),
    routeScenario(false, true, routeFixture, true),
    {
      id: "rapid-session-route-typing-50ms",
      route: controlUiSessionPath(sessionKey(0)),
      explicitOnly: true,
      expected:
        "Native typing immediately after selecting a long session belongs only to that destination.",
      ...sessionFixture(),
      prepare: prepareSessions,
      run: (page) =>
        runSequence(
          page,
          {
            count: 2,
            intervalMs: 50,
            event: "pointerdown",
            recordInput: true,
            inputSelector: "body",
            outcome: {
              selector: pane,
              sessionKey: sessionKey(5),
              marker: "Rapid session 5 message 1999.",
              value: "Synthetic typing during session arrival",
            },
          },
          (index) =>
            index === 0
              ? clickAtCurrentPosition(page, sessionLink(5))
              : page.locator(composer).pressSequentially("Synthetic typing during session arrival"),
        ),
    },
    {
      id: "rapid-boot-typing",
      route: controlUiSessionPath(sessionKey(0)),
      navigation: "reload",
      explicitOnly: true,
      expected: "Typing in the static boot composer survives its handoff to the connected session.",
      prepare: prepareChat,
      run: async (page) => {
        await page.reload({ waitUntil: "commit" });
        const evidence = await runSequence(
          page,
          {
            count: 1,
            intervalMs: 0,
            event: "input",
            inputSelector: `#openclaw-boot-composer, ${composer}`,
            outcome: {
              selector: pane,
              sessionKey: sessionKey(0),
              marker: "Transcript 0 message 399.",
              value: "Synthetic typing at boot",
            },
          },
          () =>
            page.locator("#openclaw-boot-composer").pressSequentially("Synthetic typing at boot"),
        );
        assert(
          typeof evidence.bootInputSamples === "number" && evidence.bootInputSamples > 0,
          "Typing must begin in the static boot composer",
        );
        return evidence;
      },
    },
    {
      id: "rapid-sessions-draft-return-5-50ms",
      route: controlUiSessionPath(sessionKey(0)),
      explicitOnly: true,
      expected:
        "Returning after five rapid session choices restores the origin draft and top scroll anchor.",
      ...sessionFixture(),
      prepare: async (page) => {
        await prepareSessions(page);
        // Native reader intent retires queued end-follow before the preparatory jump.
        await page.locator(`${pane} .chat-thread`).press("Home");
        await page.locator(`${pane} .chat-thread`).evaluate((element) => {
          element.scrollTo({ top: 0, behavior: "instant" });
        });
        await page
          .locator(pane)
          .getByText("Rapid session 0 message 0.", { exact: false })
          .waitFor();
      },
      run: async (page) => {
        const evidence = await runSequence(
          page,
          {
            count: 6,
            intervalMs: 50,
            event: "pointerdown",
            inputSelector: ".sidebar-recent-session__link",
            outcome: {
              selector: pane,
              sessionKey: sessionKey(0),
              marker: "Rapid session 0 message 0.",
              value: "Synthetic origin draft — keep with session zero",
            },
          },
          async (index) => {
            if (index > 0 && page.viewportSize()!.width < 768) {
              await clickAtCurrentPosition(page, `${pane} .mobile-header__navigation`);
            }
            await clickAtCurrentPosition(page, sessionLink(index === 5 ? 0 : index + 1));
          },
        );
        const scrollTop = await page
          .locator(`${pane} .chat-thread`)
          .evaluate((element) => element.scrollTop);
        assert(scrollTop < 2, "Returning to the origin lost its top scroll anchor");
        return { ...evidence, originDraftIntact: true, originScrollTopPx: scrollTop };
      },
    },
    {
      id: "rapid-session-palette-arrows-20-50ms",
      route: controlUiSessionPath(sessionKey(0)),
      expected:
        "Rapid native arrows through session search results preserve the initial selected result and draft.",
      explicitOnly: true,
      prepare: async (page) => {
        await prepareChat(page);
        await page.keyboard.press("ControlOrMeta+k");
        await page.locator(".cmd-palette__input").fill("Interaction");
        await page.locator('.cmd-palette__item[aria-selected="true"]').waitFor();
        // The selected row can render before the input receives its keyboard target.
        await page.waitForFunction(() =>
          document.querySelector(".cmd-palette__input")?.getAttribute("aria-activedescendant"),
        );
      },
      run: async (page) => {
        const input = page.locator(".cmd-palette__input");
        const initial = await input.getAttribute("aria-activedescendant");
        assert(initial);
        const evidence = await runSequence(
          page,
          {
            count: 40,
            intervalMs: 50,
            event: "keydown",
            inputSelector: ".cmd-palette__input",
            outcome: { selector: ".cmd-palette__input", activeDescendant: initial },
          },
          (index) => input.press(index < 20 ? "ArrowDown" : "ArrowUp"),
        );
        assert.equal(await input.inputValue(), "Interaction");
        return { ...evidence, queryIntact: true };
      },
    },
    {
      id: "rapid-history-back-forward-50ms",
      route: controlUiSessionPath(sessionKey(0)),
      expected:
        "Back, back and forward settle on the second session with its own transcript and empty draft.",
      explicitOnly: true,
      ...sessionFixture(),
      prepare: async (page) => {
        await prepareSessions(page);
        for (const index of [1, 2, 3]) {
          await navigation(page, "sessions");
          await page.locator(sessionLink(index)).click();
          await page
            .locator(pane)
            .getByText(`Rapid session ${index} message 399.`, { exact: false })
            .waitFor();
        }
      },
      run: (page) =>
        runSequence(
          page,
          {
            count: 3,
            intervalMs: 50,
            event: "pointerdown",
            inputSelector: "body",
            outcome: {
              selector: pane,
              sessionKey: sessionKey(2),
              marker: "Rapid session 2 message 399.",
              value: "",
            },
          },
          (index) => page.evaluate((delta) => history.go(delta), index === 2 ? 1 : -1),
          true,
        ),
    },
    {
      id: "rapid-menu-close-50ms",
      route: controlUiSessionPath(sessionKey(0)),
      expected:
        "A model picker closed during its opening animation stays closed and leaves the draft intact.",
      explicitOnly: true,
      prepare: async (page) => {
        await prepareChat(page);
        await page.locator(composer).fill("Synthetic rapid menu draft");
      },
      run: async (page) => {
        const evidence = await runSequence(
          page,
          {
            count: 2,
            intervalMs: 50,
            inputSelector: "body",
            event: "keydown",
            outcome: { selector: "[data-chat-model-search]", hidden: true },
          },
          async (index) => {
            if (index === 0) {
              // Keyboard activation and Escape share one native delivery probe.
              await page.locator(`${pane} [data-chat-model-select]`).press("Enter");
            } else {
              await page.keyboard.press("Escape");
            }
          },
        );
        assert.equal(await page.locator(composer).inputValue(), "Synthetic rapid menu draft");
        return { ...evidence, draftIntact: true };
      },
    },
    {
      id: "rapid-drawer-close-50ms",
      route: controlUiSessionPath(sessionKey(0)),
      viewports: ["mobile"],
      explicitOnly: true,
      expected:
        "The mobile navigation drawer closes during its opening animation and remains closed.",
      prepare: prepareChat,
      run: (page) =>
        runSequence(
          page,
          {
            count: 2,
            intervalMs: 50,
            event: "keydown",
            inputSelector: "body",
            outcome: { selector: ".shell--nav-drawer-open", hidden: true },
          },
          (index) =>
            index === 0
              ? page.locator(`${pane} .mobile-header__navigation`).press("Enter")
              : page.keyboard.press("Escape"),
        ),
    },
  ];
}
