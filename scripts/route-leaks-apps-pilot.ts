import type { Page } from "playwright";
import { buildSandboxHostPath } from "../src/agents/sandbox-host.ts";
import type { MockGatewayWindow } from "../ui/src/test-helpers/control-ui-e2e-contract.ts";
import type { ControlUiMockGatewayScenario } from "../ui/src/test-helpers/control-ui-e2e.ts";
import { createControlUiSandboxFixtureServer } from "../ui/src/test-helpers/control-ui-sandbox-fixture-server.ts";
import { mcpResourceHtml } from "../ui/src/test-helpers/control-ui-team-scale-widget-html.ts";

export const appsPilotIds = ["apps-catalog", "apps-open-immediate", "apps-open-idle"] as const;
export type AppsPilotId = (typeof appsPilotIds)[number];
export const appsEntryTitle = "Synthetic route library";
export const appsServerLabel = "Synthetic route apps";
const serverName = "route-leaks-apps";
const toolName = "library";
const viewId = "route-leaks-first-app";
const frameSelector =
  "openclaw-apps-page openclaw-chat-pane.mcp-app-conversation mcp-app-view iframe";

export function isAppsPilotId(id: string): id is AppsPilotId {
  return appsPilotIds.some((candidate) => candidate === id);
}
export function isAppsOpenId(id: string) {
  return id === "apps-open-immediate" || id === "apps-open-idle";
}
export function appsPilotTarget() {
  return {
    route: "apps" as const,
    pathname: "/apps",
    search: "",
    selector: "openclaw-apps-page .mcp-app-catalog__entry button:not(:disabled)",
  };
}

export async function startAppsPilotSandbox() {
  // Reuse the native sandbox handler used by the committed interaction workload.
  const server = createControlUiSandboxFixtureServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Apps pilot sandbox did not bind a TCP port");
  }
  return {
    descriptor: {
      sandboxUrl: buildSandboxHostPath({ blockDescendantFrames: true }),
      sandboxPort: address.port,
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function appsPilotFixture(
  fixture: ControlUiMockGatewayScenario,
  sandbox: { sandboxUrl: string; sandboxPort: number },
): ControlUiMockGatewayScenario {
  return {
    ...fixture,
    featureMethods: [
      ...new Set([
        ...(fixture.featureMethods ?? []),
        "mcp.app.discover",
        "mcp.app.launch",
        "mcp.app.view",
      ]),
    ],
    methodResponses: {
      ...fixture.methodResponses,
      "mcp.app.discover": {
        servers: [
          {
            serverName,
            label: appsServerLabel,
            entrypoints: [
              {
                title: appsEntryTitle,
                toolName,
                resourceUri: "ui://route-leaks-apps/library",
                entrypoint: { type: "global" },
              },
            ],
          },
        ],
        onboarding: [],
      },
      "mcp.app.launch": { viewId },
      "mcp.app.view": {
        ...sandbox,
        html: mcpResourceHtml(),
        toolInput: {},
        toolResult: { content: [{ type: "text", text: "Synthetic route app ready" }] },
        messageSupported: true,
        updateModelContextSupported: false,
      },
    },
  };
}

type AppsRequestObservation = { method: string; at: number };
type AppsPreparationReceipt = {
  id: string;
  params: unknown;
  requestAt: number;
  response?: unknown;
  responseAt?: number;
};
type AppsProbeWindow = Window & {
  appsCatalogProbe?: {
    requests: AppsRequestObservation[];
    preparations: AppsPreparationReceipt[];
  };
};

export function appsGatewayInitScript(gatewayScript: string) {
  // One init script orders the observer after the mock replaces WebSocket.
  return `${gatewayScript}\n;(() => { const __name = (target) => target; (${installAppsRequestObserver.toString()})(); })();`;
}

function installAppsRequestObserver() {
  // Observe the actual synthetic WebSocket send path; do not replace any response or owner.
  const state = {
    requests: [] as AppsRequestObservation[],
    preparations: [] as AppsPreparationReceipt[],
  };
  (window as AppsProbeWindow).appsCatalogProbe = state;
  window.WebSocket = new Proxy(WebSocket, {
    construct(target, args: ConstructorParameters<typeof WebSocket>) {
      const socket = new target(...args);
      const send = socket.send.bind(socket);
      socket.send = (data) => {
        if (typeof data === "string") {
          try {
            const frame: unknown = JSON.parse(data);
            if (
              typeof frame === "object" &&
              frame !== null &&
              "method" in frame &&
              typeof frame.method === "string"
            ) {
              const at = performance.now();
              state.requests.push({ method: frame.method, at });
              if (
                frame.method === "sessions.create" &&
                "id" in frame &&
                typeof frame.id === "string"
              ) {
                const receipt: AppsPreparationReceipt = {
                  id: frame.id,
                  params: "params" in frame ? frame.params : undefined,
                  requestAt: at,
                };
                state.preparations.push(receipt);
                const observeResponse = (event: MessageEvent) => {
                  if (typeof event.data !== "string") {
                    return;
                  }
                  let response: unknown;
                  try {
                    response = JSON.parse(event.data);
                  } catch {
                    return;
                  }
                  if (
                    typeof response === "object" &&
                    response !== null &&
                    "type" in response &&
                    response.type === "res" &&
                    "id" in response &&
                    response.id === receipt.id
                  ) {
                    receipt.response = response;
                    receipt.responseAt = performance.now();
                    socket.removeEventListener("message", observeResponse);
                  }
                };
                socket.addEventListener("message", observeResponse);
              }
            }
          } catch {
            // Non-JSON transport frames are outside this method-only observation.
          }
        }
        return send(data);
      };
      return socket;
    },
  });
}

export async function waitForAppsCatalog(page: Page) {
  await page.waitForFunction(
    ({ title, label }) => {
      const root = document.querySelector("openclaw-apps-page");
      const button = [
        ...(root?.querySelectorAll<HTMLButtonElement>(".mcp-app-catalog__entry button") ?? []),
      ].find(
        (node) =>
          node.querySelector("strong")?.textContent?.trim() === title &&
          node.querySelector("small")?.textContent?.trim() === label,
      );
      const probe = (window as AppsProbeWindow).appsCatalogProbe;
      return Boolean(
        button &&
        !button.disabled &&
        button.getClientRects().length &&
        getComputedStyle(button).visibility !== "hidden" &&
        root?.querySelector(".apps-card .apps-card__cta") &&
        !root.querySelector("openclaw-chat-pane") &&
        probe?.requests.some((request) => request.method === "mcp.app.discover") &&
        !probe.requests.some(
          (request) => request.method === "mcp.app.launch" || request.method === "mcp.app.view",
        ),
      );
    },
    { title: appsEntryTitle, label: appsServerLabel },
    { timeout: 30_000, polling: "raf" },
  );
}

export async function appsProbeSnapshot(page: Page, cutoff?: number) {
  return page.evaluate((limit) => {
    const observedAt = performance.now();
    const requests = ((window as AppsProbeWindow).appsCatalogProbe?.requests ?? []).filter(
      (request) => limit === undefined || request.at <= limit,
    );
    return {
      observedAt,
      cutoff: limit ?? observedAt,
      requests,
      // These receipts are observed now, independently of the method-count cutoff.
      preparationReceiptsObservedAtSnapshot:
        (window as AppsProbeWindow).appsCatalogProbe?.preparations ?? [],
      counts: requests.reduce<Record<string, number>>((counts, request) => {
        counts[request.method] = (counts[request.method] ?? 0) + 1;
        return counts;
      }, {}),
      // Hint DOM is observed now; completed resource times alone are cutoff-filtered.
      observedModulePreloadHints: [
        ...document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]'),
      ].map((link) => link.href),
      completedResourcesAtCutoff: performance
        .getEntriesByType("resource")
        .filter(
          (entry) => (entry as PerformanceResourceTiming).responseEnd <= (limit ?? observedAt),
        )
        .map((entry) => {
          const resource = entry as PerformanceResourceTiming;
          return {
            url: resource.name,
            initiatorType: resource.initiatorType,
            startTime: resource.startTime,
            responseEnd: resource.responseEnd,
            encodedBytes: resource.encodedBodySize,
            decodedBytes: resource.decodedBodySize,
          };
        }),
      frames: [...document.querySelectorAll<HTMLIFrameElement>("iframe")].map((frame) => ({
        src: frame.src,
        title: frame.title,
      })),
    };
  }, cutoff);
}

export async function clickFirstAppAndWait(page: Page) {
  const button = page
    .locator("openclaw-apps-page .mcp-app-catalog__entry button")
    .filter({ hasText: appsEntryTitle });
  if ((await button.count()) !== 1) {
    throw new Error("Expected exactly one admitted App catalog entry");
  }
  await button.click();
  await page.waitForFunction(
    ({ server, tool }) => {
      const search = new URLSearchParams(location.search);
      const snapshot = window.openclawControlUi?.snapshot();
      return (
        search.get("server") === server &&
        search.get("tool") === tool &&
        snapshot?.route?.status === "success" &&
        snapshot.route.matches[0]?.routeId === "apps" &&
        snapshot.route.pendingMatches.length === 0
      );
    },
    { server: serverName, tool: toolName },
    { timeout: 30_000, polling: "raf" },
  );
  const outer = page.locator(frameSelector);
  await outer.waitFor({ state: "visible" });
  if ((await outer.count()) !== 1) {
    throw new Error("Expected one actual App sandbox frame");
  }
  const inner = outer.contentFrame().frameLocator("iframe");
  await inner.locator("html[data-host-width]").waitFor({ state: "attached" });
  await inner.getByRole("button", { name: "Count", exact: true }).waitFor({ state: "visible" });
  if (!(await inner.getByRole("button", { name: "Count", exact: true }).isEnabled())) {
    throw new Error("Actual App control is not enabled");
  }
  if ((await inner.locator("output").textContent()) !== "0") {
    throw new Error("App was not a fresh first presentation");
  }
}

export async function verifyFirstAppAndClose(page: Page, sessionKey: string) {
  const visibleAlerts = await page.locator('[role="alert"]').evaluateAll((nodes) =>
    nodes
      .filter(
        (node) => node.getClientRects().length && getComputedStyle(node).visibility !== "hidden",
      )
      .map((node) => node.textContent?.trim())
      .filter(Boolean),
  );
  if (visibleAlerts.length) {
    throw new Error(`App first presentation has visible alerts: ${visibleAlerts.join("; ")}`);
  }
  const { requests: before, preparations } = await page.evaluate(() => ({
    requests: (window as MockGatewayWindow).openclawControlUiE2eGateway?.findRequests() ?? [],
    preparations: (window as AppsProbeWindow).appsCatalogProbe?.preparations ?? [],
  }));
  const creates = before.filter((request) => request.method === "sessions.create");
  const preparation = preparations[0];
  const params = preparation?.params;
  const response = preparation?.response;
  const payload =
    typeof response === "object" && response !== null && "payload" in response
      ? response.payload
      : undefined;
  if (
    creates.length !== 1 ||
    preparations.length !== 1 ||
    creates[0]?.id !== preparation?.id ||
    !preparation ||
    typeof params !== "object" ||
    params === null ||
    Object.keys(params).toSorted().join(",") !== "agentId,key" ||
    !("key" in params) ||
    params.key !== sessionKey ||
    !("agentId" in params) ||
    params.agentId !== "main" ||
    typeof response !== "object" ||
    response === null ||
    !("ok" in response) ||
    response.ok !== true ||
    typeof payload !== "object" ||
    payload === null ||
    Object.keys(payload).join(",") !== "key" ||
    !("key" in payload) ||
    payload.key !== sessionKey ||
    before.indexOf(creates[0]!) >=
      before.findIndex((request) => request.method === "mcp.app.launch")
  ) {
    throw new Error("Catalog preparation must create only the missing selected synthetic session");
  }
  const launches = before.filter((request) => request.method === "mcp.app.launch");
  const views = before.filter((request) => request.method === "mcp.app.view");
  if (launches.length !== 1 || views.length !== 1) {
    throw new Error(`Expected one first launch/view; got ${launches.length}/${views.length}`);
  }
  const launch = launches[0]?.params;
  const view = views[0]?.params;
  if (
    !launch ||
    typeof launch !== "object" ||
    !("sessionKey" in launch) ||
    launch.sessionKey !== sessionKey ||
    !("agentId" in launch) ||
    launch.agentId !== "main" ||
    !("serverName" in launch) ||
    launch.serverName !== serverName ||
    !("toolName" in launch) ||
    launch.toolName !== toolName ||
    !("entrypointType" in launch) ||
    launch.entrypointType !== "global" ||
    !view ||
    typeof view !== "object" ||
    !("viewId" in view) ||
    view.viewId !== viewId ||
    !("sessionKey" in view) ||
    view.sessionKey !== sessionKey ||
    !("agentId" in view) ||
    view.agentId !== "main"
  ) {
    throw new Error("Native App launch/view receipt has the wrong synthetic target");
  }
  const inner = page.locator(frameSelector).contentFrame().frameLocator("iframe");
  await inner.getByRole("button", { name: "Count", exact: true }).click();
  await inner.getByText("1", { exact: true }).waitFor();
  await page
    .locator("openclaw-apps-page")
    .getByRole("button", { name: "Close app", exact: true })
    .click();
  await waitForAppsCatalogAfterClose(page);
  const after = await page.evaluate(
    () => (window as MockGatewayWindow).openclawControlUiE2eGateway?.findRequests() ?? [],
  );
  const unexpectedWrites = after
    .slice(before.length)
    .filter((request) =>
      /^(?:chat\.send|sessions\.(?:create|patch|patchMany|delete|reset|fork|dispatch)|config\.(?:set|patch|apply)|mcp\.app\.(?:onboard|settings|callTool|message))$/u.test(
        request.method,
      ),
    );
  if (unexpectedWrites.length) {
    throw new Error(
      `Unexpected synthetic write: ${unexpectedWrites.map((request) => request.method).join(", ")}`,
    );
  }
  if (
    after.filter((request) => request.method === "mcp.app.launch").length !== 1 ||
    after.filter((request) => request.method === "mcp.app.view").length !== 1
  ) {
    throw new Error("Local App control or close caused another launch/view");
  }
  return {
    firstLaunch: true,
    targetMatched: true,
    counterValue: 1,
    nativeCloseReturnedToCatalog: true,
    launches: 1,
    views: 1,
    unexpectedWrites: 0,
    catalogPreparation: preparation,
  };
}

async function waitForAppsCatalogAfterClose(page: Page) {
  await page
    .locator("openclaw-apps-page .mcp-app-catalog__entry button")
    .filter({ hasText: appsEntryTitle })
    .waitFor({ state: "visible" });
  await page.waitForFunction(
    () =>
      !new URLSearchParams(location.search).has("server") &&
      !document.querySelector("openclaw-apps-page openclaw-chat-pane"),
  );
}

export type AppsNetworkObservation = {
  requestId: string;
  url: string;
  timestampSeconds?: number;
  finishedTimestampSeconds?: number;
  wireBytes?: number;
  failed?: string;
};

export function qualifyAppsClock(
  requests: AppsNetworkObservation[],
  navigationStart: number,
  resources: { url: string; startTime: number; responseEnd: number }[],
) {
  const available = new Map<string, typeof resources>();
  for (const resource of resources.toSorted((a, b) => a.startTime - b.startTime)) {
    const sameUrl = available.get(resource.url) ?? [];
    sameUrl.push(resource);
    available.set(resource.url, sameUrl);
  }
  const matches = [];
  const unmatchedRequestIds = [];
  for (const request of requests.toSorted(
    (a, b) => (a.timestampSeconds ?? 0) - (b.timestampSeconds ?? 0),
  )) {
    if (
      !new URL(request.url).pathname.startsWith("/assets/") ||
      request.timestampSeconds === undefined ||
      request.finishedTimestampSeconds === undefined ||
      request.failed
    ) {
      continue;
    }
    const resource = available.get(request.url)?.shift();
    if (!resource) {
      unmatchedRequestIds.push(request.requestId);
      continue;
    }
    const requestStartMs = (request.timestampSeconds - navigationStart) * 1_000;
    const requestEndMs = (request.finishedTimestampSeconds - navigationStart) * 1_000;
    matches.push({
      requestId: request.requestId,
      url: request.url,
      requestStartMs,
      requestEndMs,
      resourceStartMs: resource.startTime,
      resourceEndMs: resource.responseEnd,
      startResidualMs: requestStartMs - resource.startTime,
      endResidualMs: requestEndMs - resource.responseEnd,
    });
  }
  const maxResidualMs = matches.length
    ? Math.max(
        ...matches.flatMap((match) => [
          Math.abs(match.startResidualMs),
          Math.abs(match.endResidualMs),
        ]),
      )
    : null;
  return {
    passed:
      Number.isFinite(navigationStart) &&
      navigationStart > 0 &&
      matches.length > 0 &&
      maxResidualMs !== null &&
      maxResidualMs <= 5,
    navigationStart,
    toleranceMs: 5,
    matchedCount: matches.length,
    maxResidualMs,
    matches,
    unmatchedRequestIds,
  };
}

export function appsNetworkPhase(
  requests: AppsNetworkObservation[],
  navigationStart: number,
  startMs: number,
  endMs: number,
) {
  if (!Number.isFinite(navigationStart) || navigationStart <= 0) {
    throw new Error("Apps phase accounting requires the actual Performance.NavigationStart metric");
  }
  const start = navigationStart + startMs / 1_000;
  const end = navigationStart + endMs / 1_000;
  const select = (kind: "js" | "css") => {
    const resources = requests.filter((request) =>
      kind === "js"
        ? /\.m?js$/u.test(new URL(request.url).pathname)
        : new URL(request.url).pathname.endsWith(".css"),
    );
    if (resources.some((request) => !Number.isFinite(request.timestampSeconds))) {
      throw new Error("Apps phase accounting requires raw Network.requestWillBeSent timestamps");
    }
    const started = resources.filter(
      (request) => request.timestampSeconds! > start && request.timestampSeconds! <= end,
    );
    const completed = resources.filter(
      (request) =>
        request.finishedTimestampSeconds !== undefined &&
        request.finishedTimestampSeconds > start &&
        request.finishedTimestampSeconds <= end,
    );
    const pending = resources.filter(
      (request) =>
        !request.failed &&
        request.timestampSeconds! <= end &&
        (request.finishedTimestampSeconds === undefined || request.finishedTimestampSeconds > end),
    );
    return {
      started,
      completed,
      pendingAtEnd: pending,
      completedEncodedBytes: completed.reduce((sum, request) => sum + (request.wireBytes ?? 0), 0),
    };
  };
  return {
    startMs,
    endMs,
    navigationStart,
    rawClock:
      "CDP MonotonicTime seconds; phase boundaries use actual Performance.NavigationStart + same-document performance.now()/1000",
    js: select("js"),
    css: select("css"),
  };
}
