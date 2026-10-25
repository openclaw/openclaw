import type { CDPSession, Page } from "playwright";

export const criticalPathRoutes = ["sessions", "settings", "cron", "agents"] as const;
export type CriticalPathRoute = (typeof criticalPathRoutes)[number];

type CriticalPathCapture = {
  name: string;
  startedMs: number;
  readyMs: number;
  elapsedMs: number;
  capturedMs: number;
  rpcs: Array<{
    method: string;
    params: unknown;
    requestMs: number;
    responseMs: number;
    requestBytes: number;
    responseBytes: number;
  }>;
  resources: unknown[];
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
export function installCriticalPathProbe(bootRoute: "chat" | "new") {
  performance.setResourceTimingBufferSize(5000);
  type Step = {
    name: string;
    startedMs: number;
    readyMs: number | null;
    sessionKey?: string;
  };
  let step: Step = { name: `cold-${bootRoute}`, startedMs: 0, readyMs: null };
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
      case "sessions":
        ready = Boolean(
          visible("openclaw-sessions-page .session-link") && enabled(".sessions-toolbar__refresh"),
        );
        break;
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
    step = { name, sessionKey, startedMs: performance.now(), readyMs: null };
    performance.mark(`critical-path:${name}:start`);
    frame = requestAnimationFrame(sample);
  };
  Reflect.set(window, "__criticalPath", {
    start,
    ready: () => step.readyMs !== null,
    read() {
      const capturedMs = performance.now();
      const rpcs = Reflect.get(window, "__coldLoad")
        .read()
        .rpcs.filter(
          (rpc: { requestMs: number; responseMs: number }) =>
            rpc.responseMs >= step.startedMs && rpc.requestMs <= capturedMs,
        );
      const resources = performance
        .getEntriesByType("resource")
        .filter((entry) => entry.startTime + entry.duration >= step.startedMs)
        .map((entry) => entry.toJSON());
      return {
        ...step,
        documentUrl: location.href,
        timeOrigin: performance.timeOrigin,
        capturedMs,
        elapsedMs: step.readyMs === null ? null : step.readyMs - step.startedMs,
        measurement:
          "First renderer animation frame with visible, enabled readiness selectors; not INP. RPC/resource timestamps use the document performance clock. Collection continues through idle to retain secondary requests.",
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
) {
  let cpuBefore: Record<string, number>;
  if (route === "settings") {
    if (beforeMeasurement) {
      await beforeMeasurement();
    }
    cpuBefore = await readCriticalPathCpu(cdp);
    await page.evaluate(() => Reflect.get(window, "__criticalPath").start("settings"));
    await page.keyboard.press("Control+Shift+,");
  } else if (route === "agents") {
    if (!(await page.locator(".settings-sidebar").isVisible())) {
      await page.keyboard.press("Control+Shift+,");
      await page.locator(".settings-sidebar__search-input").waitFor({ state: "visible" });
    }
    const link = page.locator('.settings-sidebar a[href="/settings/agents"]').first();
    await link.waitFor({ state: "visible" });
    if (beforeMeasurement) {
      await beforeMeasurement();
    }
    cpuBefore = await readCriticalPathCpu(cdp);
    await link.evaluate((element: HTMLAnchorElement) => {
      Reflect.get(window, "__criticalPath").start("agents");
      element.click();
    });
  } else {
    if (await page.locator(".settings-sidebar").isVisible()) {
      await page.keyboard.press("Escape");
      await page.locator("openclaw-app-sidebar").waitFor({ state: "visible" });
    }
    const pathname = { sessions: "/sessions", cron: "/automations" }[route];
    let link = page.locator(`openclaw-app-sidebar a[href="${pathname}"]`).first();
    if (!(await link.isVisible())) {
      await page.locator('[data-navigation-view="pages"]').click();
      link = page.locator(`openclaw-app-sidebar a[href="${pathname}"]`).first();
    }
    await link.waitFor({ state: "visible" });
    if (beforeMeasurement) {
      await beforeMeasurement();
    }
    cpuBefore = await readCriticalPathCpu(cdp);
    await link.evaluate((element: HTMLAnchorElement, name) => {
      Reflect.get(window, "__criticalPath").start(name);
      element.click();
    }, route);
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
