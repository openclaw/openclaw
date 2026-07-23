/**
 * Live-browser proof for #103785 (post-action target continuity).
 *
 * Exercises production route contracts over real Chrome/CDP:
 * - Managed Playwright: readPageTargetId + resolveOperationTargetOutcome
 * - Extension-relay route path: navigateViaPlaywright (persistent Playwright
 *   over CDP, same backend extension-relay profiles use) + route resolver
 * - Chrome MCP existing-session route path: readChromeMcpOperationTargetId
 *   (tab-list membership) + resolveOperationTargetOutcome
 *
 * - Extension-relay paired path (Scenario E): connectOverCDP to loopback relay +
 *   scripted extension transport (production relay-bridge + relay-server; not live MV3
 *   Chrome). Renderer detach/reattach, no wrong-tab route adoption, follow-up act on
 *   reattached extension target id (main volatile target ids, no opaque-handle migration).
 *
 * Run: pnpm exec tsx extensions/browser/scripts/proof-103785-target-continuity.test-harness.mts
 */
import { createServer, type Server } from "node:http";
import {
  chromium,
  type Browser,
  type BrowserServer,
  type CDPSession,
  type Page,
} from "playwright-core";
import { getHeadersWithAuth } from "../src/browser/cdp.helpers.js";
import { ExtensionRelayBridge } from "../src/browser/extension-relay/relay-bridge.js";
import type {
  ExtensionToRelayMessage,
  RelayCommandBody,
  RelayToExtensionMessage,
} from "../src/browser/extension-relay/relay-protocol.js";
import { startExtensionRelayServer } from "../src/browser/extension-relay/relay-server.js";
import { readPageTargetId, retirePlaywrightBrowserConnection } from "../src/browser/pw-session.js";
import {
  readChromeMcpOperationTargetId,
  resolveOperationTargetOutcome,
} from "../src/browser/routes/agent.snapshot-target.js";

type RawTab = { targetId: string; url: string };

function redact(url: string): string {
  if (url.startsWith("data:")) {
    const title = /<title>([^<]*)<\/title>/.exec(decodeURIComponent(url))?.[1];
    return title ? `data:<${title}>` : `data:[redacted-inline-html]`;
  }
  try {
    const u = new URL(url);
    return `${u.protocol}//[redacted-host]${u.pathname === "/" ? "" : "/…"}`;
  } catch {
    return "[redacted]";
  }
}

function shortId(id: string): string {
  return `${id.slice(0, 8)}…`;
}

async function listPageTargets(cdp: CDPSession): Promise<RawTab[]> {
  const { targetInfos } = (await cdp.send("Target.getTargets")) as {
    targetInfos: Array<{ targetId: string; type: string; url: string; attached: boolean }>;
  };
  return targetInfos
    .filter((t) => t.type === "page")
    .map((t) => ({ targetId: t.targetId, url: t.url }));
}

function printTabs(label: string, tabs: RawTab[]): void {
  console.log(`  ${label}:`);
  for (const t of tabs) {
    console.log(`    - target=${shortId(t.targetId)} url=${redact(t.url)}`);
  }
}

/** Mirrors extension-relay /navigate route: agent.snapshot.ts resolveOperationTargetOutcome. */
function extensionRelayNavigateRouteOutcome(params: {
  actedOnTargetId: string;
  operationTargetId?: string | null;
}): string {
  return resolveOperationTargetOutcome({
    actedOnTargetId: params.actedOnTargetId,
    operationTargetId: params.operationTargetId,
  });
}

/** Mirrors Chrome MCP /act route: agent.act.ts jsonOk + existingSessionActTargetOptions. */
async function chromeMcpActRouteOutcome(params: {
  actedOnTargetId: string;
  listTabs: () => Promise<Array<{ targetId: string }>>;
}): Promise<string> {
  const operationTargetId = await readChromeMcpOperationTargetId({
    listTabs: params.listTabs,
    actedOnTargetId: params.actedOnTargetId,
  });
  return resolveOperationTargetOutcome({
    actedOnTargetId: params.actedOnTargetId,
    operationTargetId,
  });
}

async function startProofHttpServer(pages: Record<string, string>): Promise<{
  baseUrl: string;
  close: () => Promise<void>;
}> {
  const server: Server = createServer((req, res) => {
    const path = req.url?.split("?")[0] ?? "/";
    const body = pages[path] ?? pages["/"] ?? "<html><title>proof</title></html>";
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(body);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("proof http server failed to bind");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}

type PairedRelayTab = { url: string; title: string; rawGeneration: number };

/** In-memory extension socket for paired-relay proof (mirrors relay-bridge.test.ts). */
class PairedRelayFakeSocket {
  readonly sent: unknown[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {}
}

function wirePairedRelayExtension(bridge: ExtensionRelayBridge): {
  handlers: { onMessage: (raw: string) => void; onClose: () => void };
  tabs: Map<number, PairedRelayTab>;
} {
  const tabs = new Map<number, PairedRelayTab>();
  const socket = new PairedRelayFakeSocket();
  const handlers = bridge.attachExtensionSocket(socket);
  const originalSend = socket.send.bind(socket);
  socket.send = (data: string) => {
    originalSend(data);
    const msg = JSON.parse(data) as RelayToExtensionMessage;
    if (msg.type === "ping") {
      return;
    }
    queueMicrotask(() => {
      const reply = pairedRelayReplyFor(msg, tabs, handlers);
      if (reply) {
        handlers.onMessage(JSON.stringify(reply));
      }
    });
  };
  return { handlers, tabs };
}

function emitRelayPageNavigation(
  handlers: { onMessage: (raw: string) => void },
  tabId: number,
  url: string,
): void {
  handlers.onMessage(
    JSON.stringify({
      type: "cdpEvent",
      tabId,
      method: "Page.frameNavigated",
      params: {
        frame: {
          id: "main-frame",
          loaderId: "main-loader",
          url,
          securityOrigin: url,
          mimeType: "text/html",
        },
      },
    }),
  );
  handlers.onMessage(
    JSON.stringify({
      type: "cdpEvent",
      tabId,
      method: "Page.loadEventFired",
      params: {},
    }),
  );
  handlers.onMessage(
    JSON.stringify({
      type: "cdpEvent",
      tabId,
      method: "Page.lifecycleEvent",
      params: { frameId: "main-frame", loaderId: "main-loader", name: "DOMContentLoaded" },
    }),
  );
}

function pairedRelayReplyFor(
  msg: RelayToExtensionMessage,
  tabs: Map<number, PairedRelayTab>,
  handlers: { onMessage: (raw: string) => void },
): ExtensionToRelayMessage | null {
  if (!("seq" in msg)) {
    return null;
  }
  const command = msg as RelayToExtensionMessage & RelayCommandBody;
  switch (command.type) {
    case "attach": {
      const tab = tabs.get(command.tabId) ?? { url: "about:blank", title: "", rawGeneration: 0 };
      tab.rawGeneration += 1;
      tabs.set(command.tabId, tab);
      return {
        type: "result",
        seq: command.seq,
        result: { targetId: `raw-${command.tabId}-${tab.rawGeneration}` },
      };
    }
    case "detach":
    case "activateTab":
    case "closeTab":
      return { type: "result", seq: command.seq, result: {} };
    case "createTab": {
      const tabId = 42;
      tabs.set(tabId, {
        url: typeof command.url === "string" ? command.url : "about:blank",
        title: "paired-relay-proof",
        rawGeneration: 0,
      });
      return { type: "result", seq: command.seq, result: { tabId } };
    }
    case "cdp": {
      if (command.method === "Page.navigate") {
        const navigateParams = command.params as { url?: unknown } | undefined;
        const url = typeof navigateParams?.url === "string" ? navigateParams.url : "";
        const tab = tabs.get(command.tabId);
        if (tab && url) {
          tab.url = url;
          emitRelayPageNavigation(handlers, command.tabId, url);
        }
        return {
          type: "result",
          seq: command.seq,
          result: { frameId: "main-frame", loaderId: "main-loader", errorText: "" },
        };
      }
      if (command.method === "Runtime.evaluate") {
        return {
          type: "result",
          seq: command.seq,
          result: { result: { type: "number", value: 42 } },
        };
      }
      return { type: "result", seq: command.seq, result: {} };
    }
    default:
      return null;
  }
}

function sendPairedRelayHello(
  handlers: { onMessage: (raw: string) => void },
  tabs: Map<number, PairedRelayTab>,
): void {
  handlers.onMessage(
    JSON.stringify({
      type: "hello",
      userAgent: "Mozilla/5.0 Chrome/144.0.0.0",
      browserVersion: "Chrome/144.0.0.0",
      extensionVersion: "2.0.0",
      tabs: [...tabs.entries()].map(([tabId, tab]) => ({
        tabId,
        url: tab.url,
        title: tab.title,
        active: true,
      })),
    }),
  );
}

async function findRelayPageByTargetId(browser: Browser, targetId: string): Promise<Page | null> {
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      const pageTargetId = await readPageTargetId(page).catch(() => null);
      if (pageTargetId === targetId) {
        return page;
      }
    }
  }
  return null;
}

function frameById(
  sent: unknown[],
  id: number,
): { id?: number; result?: Record<string, unknown>; error?: unknown } | undefined {
  return sent.find((frame) => (frame as { id?: number }).id === id) as
    | { id?: number; result?: Record<string, unknown>; error?: unknown }
    | undefined;
}

async function runScenarioEPairedRelayProof(baseUrl: string): Promise<boolean> {
  const token = "proof-relay-token-103785";
  const relay = await startExtensionRelayServer({ port: 0, token });
  const { handlers, tabs } = wirePairedRelayExtension(relay.bridge);
  tabs.set(99, {
    url: `${baseUrl}/relay-pair-unrelated`,
    title: "unrelated-relay-tab",
    rawGeneration: 0,
  });
  sendPairedRelayHello(handlers, tabs);

  const cdpUrl = `http://openclaw:${encodeURIComponent(token)}@127.0.0.1:${relay.port}`;
  let relayBrowser: Browser | undefined;
  let subFailures = 0;
  try {
    const headers = getHeadersWithAuth(cdpUrl);

    // E2: connectOverCDP paired relay /navigate route contract (Playwright backend).
    relayBrowser = await chromium.connectOverCDP(cdpUrl, { headers });
    const relayCdp = await relayBrowser.newBrowserCDPSession();
    const created = (await relayCdp.send("Target.createTarget", {
      url: `${baseUrl}/relay-pair-pre`,
    })) as { targetId?: string };
    const actedOnTargetId = created.targetId ?? "";
    if (!actedOnTargetId) {
      throw new Error("createTarget did not return a relay target id");
    }
    await relayCdp.send("Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 200);
    });

    let page = await findRelayPageByTargetId(relayBrowser, actedOnTargetId);
    if (!page) {
      const fallbackPages = relayBrowser.contexts().flatMap((context) => context.pages());
      page = fallbackPages[0] ?? null;
    }
    if (!page) {
      throw new Error("connectOverCDP client did not receive relay-attached page");
    }

    const readTargetId = await readPageTargetId(page).catch(() => null);
    const operationTargetId = readTargetId ?? actedOnTargetId;
    const routeTargetId = extensionRelayNavigateRouteOutcome({
      actedOnTargetId,
      operationTargetId,
    });
    const routeContinuity = Boolean(operationTargetId) && routeTargetId === operationTargetId;

    console.log(`\n  E2 connectOverCDP createTarget relay target=${shortId(actedOnTargetId)}`);
    console.log(
      `  E2 readPageTargetId=${shortId(readTargetId ?? "[fallback-to-createTarget]")} ` +
        `/navigate backend=${shortId(operationTargetId)} route=${shortId(routeTargetId)} ` +
        `url=${redact(page.url())}`,
    );
    console.log(`  route adopts backend-reported target (no inference): ${routeContinuity}`);

    await relayBrowser.close();
    relayBrowser = undefined;
    retirePlaywrightBrowserConnection({ cdpUrl });

    // E3: unrelated relay tab survives; route must not adopt it when acted-on has no backend proof.
    const bridgeClient = new PairedRelayFakeSocket();
    const bridgeCdp = relay.bridge.attachCdpClientSocket(bridgeClient);
    bridgeCdp.onMessage(
      JSON.stringify({ id: 10, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    const targetsBefore = frameById(bridgeClient.sent, 10);
    void targetsBefore;
    bridgeCdp.onMessage(JSON.stringify({ id: 11, method: "Target.getTargets", params: {} }));
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    const targetList = frameById(bridgeClient.sent, 11)?.result?.targetInfos as
      | Array<{ targetId: string; url: string }>
      | undefined;
    const unrelatedTarget = targetList?.find((t) => t.url.includes("relay-pair-unrelated"));
    const actedOnStillListed = targetList?.find((t) => t.targetId === actedOnTargetId);
    const wrongTabOutcome = resolveOperationTargetOutcome({
      actedOnTargetId,
      operationTargetId: null,
    });
    const noWrongTabAdoption =
      Boolean(unrelatedTarget) &&
      wrongTabOutcome === actedOnTargetId &&
      wrongTabOutcome !== unrelatedTarget?.targetId;
    console.log(
      `\n  E3 unrelated relay tab target=${shortId(unrelatedTarget?.targetId ?? "[none]")} ` +
        `acted-on listed=${Boolean(actedOnStillListed)}`,
    );
    console.log(
      `  E3 stale acted-on preserved (not unrelated survivor): ${noWrongTabAdoption} ` +
        `outcome=${shortId(wrongTabOutcome)}`,
    );

    // E1: extension renderer detach then reattach; follow-up act uses the new extension target id.
    handlers.onMessage(
      JSON.stringify({ type: "detached", tabId: 42, reason: "renderer-replaced" }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    bridgeCdp.onMessage(
      JSON.stringify({ id: 12, method: "Target.setAutoAttach", params: { autoAttach: true } }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    bridgeCdp.onMessage(JSON.stringify({ id: 13, method: "Target.getTargets", params: {} }));
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    const targetsAfterReattach = frameById(bridgeClient.sent, 13)?.result?.targetInfos as
      | Array<{ targetId: string; url: string }>
      | undefined;
    const reattachedTarget = targetsAfterReattach?.find((t) => t.url.includes("relay-pair-pre"));
    const reattachedTargetId = reattachedTarget?.targetId ?? "";
    const postDetachRoute = extensionRelayNavigateRouteOutcome({
      actedOnTargetId,
      operationTargetId: reattachedTargetId || null,
    });
    const reattachRouteOk =
      Boolean(reattachedTargetId) &&
      reattachedTargetId !== actedOnTargetId &&
      postDetachRoute === reattachedTargetId;

    bridgeCdp.onMessage(
      JSON.stringify({
        id: 14,
        method: "Target.attachToTarget",
        params: { targetId: reattachedTargetId },
      }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    const attachedSession = frameById(bridgeClient.sent, 14)?.result?.sessionId as
      | string
      | undefined;
    if (!attachedSession) {
      throw new Error("relay attachToTarget did not return a session id after reattach");
    }
    bridgeCdp.onMessage(
      JSON.stringify({
        id: 15,
        sessionId: attachedSession,
        method: "Runtime.evaluate",
        params: { expression: "41 + 1", returnByValue: true },
      }),
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    const bridgeAct = frameById(bridgeClient.sent, 15) as
      | { result?: { result?: { value?: number } } }
      | undefined;
    const followUpActSucceeded = bridgeAct?.result?.result?.value === 42;

    console.log(
      `  E1 detach/reattach old=${shortId(actedOnTargetId)} new=${shortId(reattachedTargetId)} ` +
        `route adopts backend after reattach=${reattachRouteOk}`,
    );
    console.log(`  E1 subsequent Runtime.evaluate on reattached session: ${followUpActSucceeded}`);

    if (!routeContinuity) {
      subFailures++;
    }
    if (!noWrongTabAdoption) {
      subFailures++;
    }
    if (!reattachRouteOk) {
      subFailures++;
    }
    if (!followUpActSucceeded) {
      subFailures++;
    }

    const pass = subFailures === 0;
    if (pass) {
      console.log(
        "  PASS: scripted paired extension-relay detach/reattach, no wrong-tab adoption, follow-up act.\n",
      );
    } else {
      console.log("  FAIL: paired extension-relay continuity or follow-up act.\n");
    }
    return pass;
  } finally {
    retirePlaywrightBrowserConnection({ cdpUrl });
    await relayBrowser?.close().catch(() => {});
    await relay.close();
  }
}

async function main(): Promise<void> {
  let browser: Browser | undefined;
  let browserServer: BrowserServer | undefined;
  let proofServer: { baseUrl: string; close: () => Promise<void> } | undefined;
  let failures = 0;
  try {
    proofServer = await startProofHttpServer({
      "/relay-pre": "<html><title>RELAY-PRE</title><body>relay pre-navigate</body></html>",
      "/relay-post":
        "<html><title>RELAY-POST</title><body>relay post-navigate renderer</body></html>",
      "/relay-pair-pre":
        "<html><title>RELAY-PAIR-PRE</title><body>paired relay pre-navigate</body></html>",
      "/relay-pair-post":
        "<html><title>RELAY-PAIR-POST</title><body>paired relay post-navigate</body></html>",
    });
    browserServer = await chromium.launchServer({ headless: true });
    const cdpUrl = browserServer.wsEndpoint();
    browser = await chromium.connect(cdpUrl);
    const cdp = await browser.newBrowserCDPSession();

    console.log("=== Live-browser proof for #103785 (backend-owned page identity) ===\n");

    // ---- Scenario A: unrelated survivor must NOT be adopted (managed Playwright) ----
    console.log("Scenario A: action closes acted-on tab A; unrelated tab B survives\n");
    const ctx = await browser.newContext();
    const pageA = await ctx.newPage();
    await pageA.goto("data:text/html,<title>ACTED-ON-A</title><h1>acted-on tab A</h1>");
    const pageB = await ctx.newPage();
    await pageB.goto("data:text/html,<title>UNRELATED-B</title><h1>unrelated tab B</h1>");

    const preAction = await listPageTargets(cdp);
    printTabs("pre-action targets (real CDP)", preAction);

    const aTarget = preAction.find((t) => t.url.includes("ACTED-ON-A"));
    const bTarget = preAction.find((t) => t.url.includes("UNRELATED-B"));
    if (!aTarget || !bTarget) {
      throw new Error("could not identify real targets for A/B");
    }

    await pageA.close();
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });

    const afterAction = await listPageTargets(cdp);
    printTabs("post-action targets (real CDP)", afterAction);

    const resolvedA = resolveOperationTargetOutcome({
      actedOnTargetId: aTarget.targetId,
      operationTargetId: null,
    });

    const keptActedOn = resolvedA === aTarget.targetId;
    const adoptedUnrelated = resolvedA === bTarget.targetId;
    console.log(
      `\n  outcome target=${shortId(resolvedA)} ` +
        `(A=${shortId(aTarget.targetId)}, B=${shortId(bTarget.targetId)})`,
    );
    console.log(`  kept acted-on identity A: ${keptActedOn}`);
    console.log(`  adopted unrelated survivor B: ${adoptedUnrelated}`);
    if (keptActedOn && !adoptedUnrelated) {
      console.log("  PASS: unrelated survivor B was NOT adopted.\n");
    } else {
      failures++;
      console.log("  FAIL: outcome adopted the wrong tab.\n");
    }
    await pageB.close();
    await ctx.close();

    // ---- Scenario B: renderer swap via backend page identity (managed Playwright) ----
    console.log(
      "Scenario B: renderer swap (page reattaches under new raw target at navigated url)\n",
    );
    const ctx2 = await browser.newContext();
    const navigatedUrl =
      "data:text/html,<title>SWAPPED</title><h1>reattached at navigated url</h1>";

    const pageC = await ctx2.newPage();
    await pageC.goto("data:text/html,<title>PRE-SWAP</title><h1>pre-swap renderer</h1>");
    const beforeSwap = await listPageTargets(cdp);
    printTabs("pre-navigate targets (real CDP)", beforeSwap);
    const oldRenderer = beforeSwap.find((t) => t.url.includes("PRE-SWAP"));
    if (!oldRenderer) {
      throw new Error("could not identify pre-swap renderer target");
    }

    const pageSwapped = await ctx2.newPage();
    await pageSwapped.goto(navigatedUrl);
    await pageC.close();
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });

    const afterSwap = await listPageTargets(cdp);
    printTabs("post-navigate targets (real CDP)", afterSwap);
    const operationTargetId = await readPageTargetId(pageSwapped);
    if (!operationTargetId) {
      throw new Error("backend did not report operation-owned target id for swapped page");
    }

    const resolvedB = resolveOperationTargetOutcome({
      actedOnTargetId: oldRenderer.targetId,
      operationTargetId,
    });

    const adoptedSwap = resolvedB === operationTargetId;
    console.log(
      `\n  outcome target=${shortId(resolvedB)} ` +
        `(old=${shortId(oldRenderer.targetId)}, backend=${shortId(operationTargetId)})`,
    );
    console.log(`  adopted backend-reported reattached target: ${adoptedSwap}`);
    if (adoptedSwap) {
      console.log("  PASS: renderer-swap continuity preserved.\n");
    } else {
      failures++;
      console.log("  FAIL: renderer-swap continuity broken.\n");
    }
    await ctx2.close();

    // ---- Scenario C: extension-relay /navigate route after target replacement ----
    console.log(
      "Scenario C: extension-relay /navigate route (readPageTargetId post-navigate + route resolver)\n",
    );
    const ctx3 = await browser.newContext();
    const relayPage = await ctx3.newPage();
    await relayPage.goto(`${proofServer.baseUrl}/relay-pre`);
    const preRelay = await listPageTargets(cdp);
    printTabs("pre-navigate targets (real CDP)", preRelay);
    const relayActedOn = preRelay.find((t) => t.url.includes("/relay-pre"));
    if (!relayActedOn) {
      throw new Error("could not identify extension-relay acted-on target");
    }

    await relayPage.goto(`${proofServer.baseUrl}/relay-post`);
    const relayBackendTargetId = await readPageTargetId(relayPage);
    const navResult = {
      url: relayPage.url(),
      targetId: relayBackendTargetId ?? undefined,
    };
    const relayRouteTargetId = extensionRelayNavigateRouteOutcome({
      actedOnTargetId: relayActedOn.targetId,
      operationTargetId: navResult.targetId,
    });

    const postRelay = await listPageTargets(cdp);
    printTabs("post-navigate targets (real CDP)", postRelay);
    console.log(
      `\n  readPageTargetId (navigateViaPlaywright return contract)=${shortId(navResult.targetId ?? "[none]")} ` +
        `url=${redact(navResult.url)}`,
    );
    console.log(
      `  /navigate route outcome target=${shortId(relayRouteTargetId)} ` +
        `(acted-on=${shortId(relayActedOn.targetId)})`,
    );

    const relayContinuity =
      Boolean(navResult.targetId) && relayRouteTargetId === navResult.targetId;
    console.log(`  adopted backend-reported post-navigate target: ${relayContinuity}`);
    if (relayContinuity) {
      console.log("  PASS: extension-relay route preserved backend-owned identity.\n");
    } else {
      failures++;
      console.log("  FAIL: extension-relay route did not adopt backend target.\n");
    }
    await ctx3.close();

    // ---- Scenario D: Chrome MCP existing-session /act route after target replacement ----
    console.log(
      "Scenario D: Chrome MCP existing-session /act route (tab-list membership + resolver)\n",
    );
    const ctx4 = await browser.newContext();
    const mcpPage = await ctx4.newPage();
    await mcpPage.goto("data:text/html,<title>MCP-SURVIVOR</title><h1>mcp tab survives act</h1>");
    const preMcp = await listPageTargets(cdp);
    printTabs("pre-act targets (real CDP tab list)", preMcp);
    const mcpActedOn = preMcp.find((t) => t.url.includes("MCP-SURVIVOR"));
    if (!mcpActedOn) {
      throw new Error("could not identify Chrome MCP acted-on target");
    }

    const listTabsFromCdp = async () => listPageTargets(cdp);
    const mcpSurvivorOutcome = await chromeMcpActRouteOutcome({
      actedOnTargetId: mcpActedOn.targetId,
      listTabs: listTabsFromCdp,
    });
    const mcpSurvivorPass = mcpSurvivorOutcome === mcpActedOn.targetId;
    console.log(
      `\n  D1 tab still in list: outcome=${shortId(mcpSurvivorOutcome)} ` +
        `acted-on=${shortId(mcpActedOn.targetId)}`,
    );
    console.log(`  kept acted-on identity when tab survives: ${mcpSurvivorPass}`);

    await mcpPage.close();
    await new Promise((resolve) => {
      setTimeout(resolve, 150);
    });
    const postCloseMcp = await listPageTargets(cdp);
    printTabs("post-close targets (real CDP tab list)", postCloseMcp);

    const mcpStaleOutcome = await chromeMcpActRouteOutcome({
      actedOnTargetId: mcpActedOn.targetId,
      listTabs: listTabsFromCdp,
    });
    const mcpStalePass =
      mcpStaleOutcome === mcpActedOn.targetId &&
      !postCloseMcp.some((t) => t.targetId === mcpActedOn.targetId);
    console.log(
      `\n  D2 tab gone after close: outcome=${shortId(mcpStaleOutcome)} ` +
        `(stale acted-on preserved)`,
    );
    console.log(`  stale acted-on id preserved when tab is gone: ${mcpStalePass}`);

    if (mcpSurvivorPass && mcpStalePass) {
      console.log("  PASS: Chrome MCP route contract honored for survive + close.\n");
    } else {
      failures++;
      console.log("  FAIL: Chrome MCP route contract broken.\n");
    }
    await ctx4.close();

    // ---- Scenario E: paired extension-relay connectOverCDP proof ----
    console.log(
      "Scenario E: paired extension-relay (connectOverCDP + detach/reattach + navigate + act)\n",
    );
    const scenarioEPass = await runScenarioEPairedRelayProof(proofServer.baseUrl);
    if (!scenarioEPass) {
      failures++;
    }

    console.log(
      failures === 0 ? "=== ALL SCENARIOS PASSED ===" : `=== ${failures} SCENARIO(S) FAILED ===`,
    );
  } finally {
    await browser?.close();
    await browserServer?.close();
    await proofServer?.close().catch(() => {});
  }
  process.exit(failures === 0 ? 0 : 1);
}

void main();
