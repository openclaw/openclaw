import type { CDPSession, Locator, Page } from "playwright";

export const criticalPathRoutes = ["sessions", "settings", "cron", "agents"] as const;
export type CriticalPathRoute = (typeof criticalPathRoutes)[number];

export type CriticalPathPresentation = {
  startedMs: number;
  capturedMs: number;
  settleMs: number;
  cls: number;
  nonRecentInputShiftSum: number;
  allShiftSum: number;
  layoutShifts: Array<{
    atMs: number;
    value: number;
    hadRecentInput: boolean;
    sources: Array<{
      element: string | null;
      previousRect: unknown;
      currentRect: unknown;
    }>;
  }>;
};

export type CriticalPathCapture = {
  name: string;
  documentUrl: string;
  timeOrigin: number;
  startedMs: number;
  intentStartedMs?: number;
  intentDwellMs?: number;
  intentElapsedMs?: number;
  readyMs: number;
  elapsedMs: number;
  capturedMs: number;
  presentation?: CriticalPathPresentation;
  rpcs: Array<{
    method: string;
    params: unknown;
    requestMs: number;
    responseMs: number;
    requestBytes: number;
    responseBytes: number;
    stack?: string;
    abandoned?: true;
  }>;
  resources: Array<
    Pick<
      PerformanceResourceTiming,
      | "name"
      | "initiatorType"
      | "startTime"
      | "duration"
      | "encodedBodySize"
      | "decodedBodySize"
      | "transferSize"
    >
  >;
};

function canonicalParams(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalParams);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalParams(child)]),
    );
  }
  return value;
}

export async function readCriticalPathCpu(cdp: CDPSession) {
  const { metrics } = await cdp.send("Performance.getMetrics");
  return Object.fromEntries(
    metrics
      .filter(({ name }) =>
        [
          "TaskDuration",
          "ScriptDuration",
          "LayoutDuration",
          "RecalcStyleDuration",
          "V8CompileDuration",
          "DevToolsCommandDuration",
          "TaskOtherDuration",
          "ThreadTime",
        ].includes(name),
      )
      .map(({ name, value }) => [name, value * 1000]),
  );
}

export function criticalPathCpuDelta(
  before: Record<string, number>,
  after: Record<string, number>,
) {
  return Object.fromEntries(
    Object.entries(after).map(([name, value]) => [name, value - before[name]!]),
  );
}

/** Browser-local frame sampling excludes the driver's polling/round-trip delay. */
export function installCriticalPathProbe(bootRoute: "chat" | "new" | "sessions" | "settings") {
  performance.setResourceTimingBufferSize(5000);
  type Step = {
    name: string;
    startedMs: number;
    intentStartedMs?: number;
    readyMs: number | null;
    sessionKey?: string;
  };
  let step: Step = { name: `cold-${bootRoute}`, startedMs: 0, readyMs: null };
  let intent: { name: string; startedMs: number } | undefined;
  let frame = 0;
  const visible = (selector: string) => {
    const element = document.querySelector<HTMLElement>(selector);
    return element?.checkVisibility() ? element : null;
  };
  const enabled = (selector: string) => {
    const element = visible(selector);
    return element && !element.matches(":disabled, [aria-disabled='true']");
  };
  const sample = () => {
    let ready = false;
    switch (step.name) {
      case "cold-chat":
      case "session-switch": {
        const pane = visible(".chat-pane-cache__pane--active");
        ready = Boolean(
          pane &&
          (!step.sessionKey || Reflect.get(pane, "sessionKey") === step.sessionKey) &&
          Reflect.get(pane, "transcriptReady") === true &&
          visible(".chat-pane-cache__pane--active .chat-virtual-row") &&
          enabled(".chat-pane-cache__pane--active .agent-chat__composer-combobox textarea"),
        );
        break;
      }
      case "cold-new":
        ready = Boolean(enabled(".new-session-page__message"));
        break;
      case "cold-sessions":
      case "sessions":
        ready = Boolean(
          visible("openclaw-sessions-page .session-link") && enabled(".sessions-toolbar__refresh"),
        );
        break;
      case "cold-settings":
      case "settings":
        ready = Boolean(
          (document.querySelector(".shell--mobile-nav:not(.shell--nav-drawer-open)") ||
            enabled(".settings-sidebar__search-input")) &&
          enabled("#settings-font-chat"),
        );
        break;
      case "cron":
        ready = Boolean(visible(".cron-table__row") && enabled(".cron-toolbar .cron-refresh"));
        break;
      case "agents":
        ready = Boolean(visible(".agents-main") && enabled(".agents-refresh-btn"));
        break;
    }
    if (ready) {
      step.readyMs = performance.now();
      performance.mark(`critical-path:${step.name}:ready`);
    } else {
      frame = requestAnimationFrame(sample);
    }
  };
  const start = (name: string, sessionKey?: string) => {
    cancelAnimationFrame(frame);
    step = {
      name,
      sessionKey,
      startedMs: performance.now(),
      readyMs: null,
      ...(intent?.name === name ? { intentStartedMs: intent.startedMs } : {}),
    };
    intent = undefined;
    performance.mark(`critical-path:${name}:start`);
    frame = requestAnimationFrame(sample);
  };
  Reflect.set(window, "__criticalPath", {
    start,
    intent(name: string) {
      intent = { name, startedMs: performance.now() };
      performance.mark(`critical-path:${name}:intent`);
    },
    ready: () => step.readyMs !== null,
    read() {
      const capturedMs = performance.now();
      const intervalStartedMs = step.intentStartedMs ?? step.startedMs;
      const rpcs = Reflect.get(window, "__coldLoad")
        .read()
        .rpcs.filter(
          (rpc: { requestMs: number; responseMs: number }) =>
            rpc.responseMs >= intervalStartedMs && rpc.requestMs <= capturedMs,
        );
      const resources = performance
        .getEntriesByType("resource")
        .filter((entry) => entry.startTime + entry.duration >= intervalStartedMs)
        .map((entry) => entry.toJSON());
      return {
        ...step,
        documentUrl: location.href,
        timeOrigin: performance.timeOrigin,
        capturedMs,
        elapsedMs: step.readyMs === null ? null : step.readyMs - step.startedMs,
        ...(step.intentStartedMs !== undefined
          ? {
              intentDwellMs: step.startedMs - step.intentStartedMs,
              intentElapsedMs: step.readyMs === null ? null : step.readyMs - step.intentStartedMs,
            }
          : {}),
        measurement:
          "First renderer animation frame with visible, enabled readiness selectors; not INP. elapsedMs starts at activation; intentElapsedMs, when present, starts before hover/focus. RPC/resources include that intent interval. Timestamps use the document performance clock. Collection continues through idle to retain secondary requests.",
        rpcs,
        resources,
      };
    },
  });
  frame = requestAnimationFrame(sample);
}

export async function readCriticalPath(page: Page) {
  await page.waitForFunction(() => Reflect.get(window, "__criticalPath").ready());
  const capture: CriticalPathCapture = await page.evaluate(() =>
    Reflect.get(window, "__criticalPath").read(),
  );
  const groups = new Map<string, CriticalPathCapture["rpcs"]>();
  for (const rpc of capture.rpcs) {
    const key = `${rpc.method}:${JSON.stringify(canonicalParams(rpc.params))}`;
    const group = groups.get(key) ?? [];
    group.push(rpc);
    groups.set(key, group);
  }
  const duplicateRequests = [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      method: group[0]!.method,
      params: group[0]!.params,
      count: group.length,
      concurrentPairs: group.reduce(
        (count, request, index) =>
          count +
          group
            .slice(index + 1)
            .filter(
              (other) =>
                request.requestMs < other.responseMs && other.requestMs < request.responseMs,
            ).length,
        0,
      ),
    }));
  return {
    ...capture,
    rpcCount: capture.rpcs.length,
    carryInRpcCount: capture.rpcs.filter((rpc) => rpc.requestMs < capture.startedMs).length,
    duplicateRequests,
  };
}

export async function navigateCriticalPath(
  page: Page,
  cdp: CDPSession,
  route: CriticalPathRoute,
  beforeMeasurement?: () => Promise<void>,
  intentMs = 0,
) {
  let target: Locator | undefined;
  if (route === "settings") {
    if (intentMs > 0) {
      await page.locator(".sidebar-identity-card").click();
      target = page.locator('.sidebar-identity-menu [data-value="command:settings"]');
      await target.waitFor({ state: "visible" });
    }
  } else if (route === "agents") {
    if (!(await page.locator(".settings-sidebar").isVisible())) {
      await page.keyboard.press("Control+Shift+,");
      await page.locator(".settings-sidebar__search-input").waitFor({ state: "visible" });
    }
    target = page.locator('.settings-sidebar a[href="/settings/agents"]').first();
    await target.waitFor({ state: "visible" });
  } else {
    if (await page.locator(".settings-sidebar").isVisible()) {
      await page.keyboard.press("Escape");
      await page.locator("openclaw-app-sidebar").waitFor({ state: "visible" });
    }
    const pathname = { sessions: "/sessions", cron: "/automations" }[route];
    target = page.locator(`openclaw-app-sidebar a[href="${pathname}"]`).first();
    if (!(await target.isVisible())) {
      await page.locator('[data-navigation-view="pages"]').click();
      target = page.locator(`openclaw-app-sidebar a[href="${pathname}"]`).first();
    }
    await target.waitFor({ state: "visible" });
  }
  if (beforeMeasurement) {
    await beforeMeasurement();
  }
  const cpuBefore = await readCriticalPathCpu(cdp);
  if (target && intentMs > 0) {
    await page.evaluate((name) => Reflect.get(window, "__criticalPath").intent(name), route);
    await target.hover();
    await target.focus();
    await page.waitForTimeout(intentMs);
  }
  if (target) {
    await target.evaluate((element: HTMLElement, name) => {
      Reflect.get(window, "__criticalPath").start(name);
      element.click();
    }, route);
  } else {
    await page.evaluate(() => Reflect.get(window, "__criticalPath").start("settings"));
    await page.keyboard.press("Control+Shift+,");
  }
  await page.waitForFunction(() => Reflect.get(window, "__criticalPath").ready());
  await page.waitForFunction(() => {
    const state = Reflect.get(window, "__coldLoad").read();
    return !state.pending && !state.queued && state.idleMs > 750;
  });
  return {
    ...(await readCriticalPath(page)),
    cpuMilliseconds: criticalPathCpuDelta(cpuBefore, await readCriticalPathCpu(cdp)),
  };
}
