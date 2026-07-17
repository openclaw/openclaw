import { CopilotGatewayClient, isDefinitiveGatewayRejection } from "./copilot-gateway.js";
import { CopilotPanelBindingRegistry, CopilotSessionRegistry } from "./copilot-session-registry.js";
import {
  buildCopilotChatSendParams,
  deriveTabSessionKey,
  gatewayUrlFromPairing,
} from "./panel-core.js";

const PANEL_PATH = "sidepanel.html";
const PANEL_PORT = "openclaw-copilot-panel";

function parsePanelBindingUrl(chromeApi, raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const token = url.searchParams.get("binding");
  if (
    url.protocol !== "chrome-extension:" ||
    url.host !== chromeApi.runtime.id ||
    !url.pathname.endsWith(`/${PANEL_PATH}`) ||
    !token ||
    [...url.searchParams].length !== 1 ||
    url.hash
  ) {
    return null;
  }
  return { token, url: url.toString() };
}

export async function resolveSidePanelTabId(chromeApi, port, panelBindings) {
  const binding = parsePanelBindingUrl(chromeApi, port.sender?.url);
  if (!binding) {
    throw new Error("Copilot is available only in a tab-specific side panel.");
  }
  const tabId = await panelBindings.resolve(binding.token);
  if (!Number.isInteger(tabId) || tabId < 0) {
    throw new Error("This panel does not hold a live tab binding.");
  }
  const contexts = await chromeApi.runtime.getContexts({
    contextTypes: ["SIDE_PANEL"],
  });
  const documentId = port.sender?.documentId;
  // Chrome reports tabId=-1 for SIDE_PANEL contexts. The unguessable URL maps
  // to the tab; this live-context check prevents a normal extension page from claiming it.
  const context = contexts.find(
    (candidate) =>
      candidate.contextType === "SIDE_PANEL" &&
      candidate.documentUrl === binding.url &&
      (typeof documentId !== "string" || candidate.documentId === documentId),
  );
  if (!context) {
    throw new Error("Chrome did not bind this panel to a tab.");
  }
  return tabId;
}

export async function archiveCopilotSession(gateway, entry) {
  try {
    await gateway.request("sessions.messages.unsubscribe", { key: entry.sessionKey });
  } catch {
    // The allowlist is connection-local. A closed socket already stopped delivery.
  }
  try {
    await gateway.request("sessions.abort", { key: entry.sessionKey });
  } catch {
    // Archive is authoritative; it will reject while a run is still active and retry later.
  }
  await gateway.request("sessions.patch", { key: entry.sessionKey, archived: true });
}

function sessionKeyFromEvent(event) {
  const payload = event?.payload;
  if (!payload || typeof payload !== "object") {
    return null;
  }
  return typeof payload.sessionKey === "string" ? payload.sessionKey : null;
}

function isLoopbackUrl(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  } catch {
    return false;
  }
}

function resolveBindingTarget(config) {
  try {
    const relay = new URL(config.relayUrl);
    if (relay.pathname.endsWith("/browser/extension")) {
      return "host";
    }
    if (isLoopbackUrl(config.relayUrl) && isLoopbackUrl(config.gatewayUrl)) {
      return "host";
    }
  } catch {
    // Fall through to the explicit topology denial below.
  }
  throw new Error(
    "Copilot needs a direct Gateway relay. Browser-node routing is not yet supported.",
  );
}

function safeTabLabel(tab) {
  try {
    const url = new URL(tab.url ?? "");
    return url.hostname || url.protocol.replace(":", "") || "Browser tab";
  } catch {
    return "Browser tab";
  }
}

/** Background-owned session custody for all tab-specific panel documents. */
export function createCopilotController({
  chromeApi = chrome,
  getConfig,
  isTabShared,
  addTabToOpenClawGroup,
  attachDebugger,
  scheduleTabsSync,
  gateway = new CopilotGatewayClient(),
}) {
  const registry = new CopilotSessionRegistry(chromeApi.storage);
  const panelBindings = new CopilotPanelBindingRegistry(chromeApi.storage.session);
  const portsByTab = new Map();
  const subscribedKeys = new Set();
  const sendsByTab = new Set();
  const ensureByTab = new Map();
  const suspendByTab = new Map();
  const tabRevisions = new Map();
  const portRevisions = new Map();
  const historyTimers = new Map();
  let gatewayStatus = { state: "off", label: "Pair the extension first" };
  let currentConfig = null;
  let gatewayRevision = 0;
  let gatewayStatusRevision = 0;
  let lastReadyStatus = null;
  let abortRetryTimer = null;
  let abortRetryDelayMs = 250;
  let initialized = null;

  async function initialize() {
    if (initialized) {
      return await initialized;
    }
    initialized = (async () => {
      const tabs = await chromeApi.tabs.query({});
      await registry.initialize(
        new Set(tabs.map((tab) => tab.id).filter((tabId) => typeof tabId === "number")),
      );
      await panelBindings.initialize();
      await refreshConfig();
    })();
    return await initialized;
  }

  function post(port, message) {
    try {
      port.postMessage(message);
    } catch {
      // Panel closed between the state read and delivery.
    }
  }

  function broadcastTab(tabId, message) {
    for (const port of portsByTab.get(tabId) ?? []) {
      post(port, message);
    }
  }

  function broadcastStatus() {
    for (const tabId of portsByTab.keys()) {
      void refreshPanelState(tabId);
    }
  }

  function currentGatewayScope() {
    return typeof currentConfig?.gatewayUrl === "string" ? currentConfig.gatewayUrl : null;
  }

  async function refreshConfig() {
    const nextConfig = await getConfig();
    const nextGatewayScope = gatewayUrlFromPairing(nextConfig.relayUrl, nextConfig.gatewayUrl);
    const previousGatewayScope = currentGatewayScope();
    if (previousGatewayScope && previousGatewayScope !== nextGatewayScope) {
      clearAbortRetry();
      lastReadyStatus = null;
      gatewayStatusRevision += 1;
      gatewayRevision += 1;
      await registry.closeScope(previousGatewayScope);
      await drainArchives(previousGatewayScope);
      gateway.stop();
      await Promise.allSettled([...ensureByTab.values()]);
      sendsByTab.clear();
      subscribedKeys.clear();
    }
    currentConfig = { ...nextConfig, gatewayUrl: nextGatewayScope };
    if (!currentConfig.relayUrl || !nextGatewayScope) {
      gateway.stop();
      gatewayStatus = {
        state: "off",
        label: currentConfig.relayUrl
          ? "Pair again to add the Gateway endpoint"
          : "Pair the extension first",
      };
      broadcastStatus();
      return;
    }
    try {
      resolveBindingTarget(currentConfig);
    } catch (error) {
      clearAbortRetry();
      lastReadyStatus = null;
      gatewayStatusRevision += 1;
      await registry.closeScope(nextGatewayScope);
      await drainArchives(nextGatewayScope);
      gateway.stop();
      gatewayStatus = { state: "denied", label: error.message };
      broadcastStatus();
      return;
    }
    gateway.start(nextGatewayScope);
  }

  async function refreshPanelState(tabId) {
    let tab;
    try {
      tab = await chromeApi.tabs.get(tabId);
    } catch {
      return;
    }
    const shared = await isTabShared(tabId);
    const entry = registry.get(tabId, currentGatewayScope());
    const reconcilingRun = Boolean(entry?.activeRunId);
    const state = !currentConfig?.relayUrl
      ? "needs-pairing"
      : !shared
        ? "needs-sharing"
        : reconcilingRun
          ? "reconciling"
          : gatewayStatus.state;
    broadcastTab(tabId, {
      type: "panel.state",
      state,
      label:
        state === "needs-sharing"
          ? "Share this tab before the copilot can act"
          : state === "reconciling"
            ? "Stopping the previous tab run"
            : gatewayStatus.label,
      requestId: gatewayStatus.requestId,
      tab: {
        title: typeof tab.title === "string" ? tab.title : "",
        url: typeof tab.url === "string" ? tab.url : "",
        label: safeTabLabel(tab),
      },
      sessionKey: entry?.sessionKey,
    });
    if (shared && gatewayStatus.state === "ready") {
      await ensureSession(tabId);
    } else if (!shared) {
      await suspendTab(tabId);
    }
  }

  async function subscribe(entry) {
    if (subscribedKeys.has(entry.sessionKey)) {
      return;
    }
    await gateway.request("sessions.messages.subscribe", { key: entry.sessionKey });
    subscribedKeys.add(entry.sessionKey);
  }

  async function unsubscribeTab(tabId, gatewayScope = currentGatewayScope()) {
    const entry = registry.get(tabId, gatewayScope);
    if (!entry || !subscribedKeys.delete(entry.sessionKey)) {
      return;
    }
    try {
      await gateway.request("sessions.messages.unsubscribe", { key: entry.sessionKey });
    } catch {
      // Socket closure also clears the server-owned allowlist.
    }
  }

  async function suspendTab(tabId, expectedPortRevision) {
    if (expectedPortRevision !== undefined && portRevisions.get(tabId) !== expectedPortRevision) {
      return;
    }
    const gatewayScope = currentGatewayScope();
    const entry = registry.get(tabId, gatewayScope);
    const queued = await registry.queueAbort(tabId, gatewayScope);
    sendsByTab.delete(tabId);
    if (queued && gateway.ready) {
      await abortEntry(queued);
    }
    if (expectedPortRevision !== undefined && portRevisions.get(tabId) !== expectedPortRevision) {
      return;
    }
    await unsubscribeTab(tabId, gatewayScope);
  }

  function scheduleSuspend(tabId, portRevision) {
    const pending = suspendTab(tabId, portRevision).finally(() => {
      if (suspendByTab.get(tabId) === pending) {
        suspendByTab.delete(tabId);
      }
    });
    suspendByTab.set(tabId, pending);
    return pending;
  }

  async function hydrate(tabId, entry = registry.get(tabId, currentGatewayScope())) {
    if (!entry || !portsByTab.has(tabId)) {
      return;
    }
    try {
      const history = await gateway.request("chat.history", {
        sessionKey: entry.sessionKey,
        limit: 200,
      });
      broadcastTab(tabId, {
        type: "panel.history",
        sessionKey: entry.sessionKey,
        messages: Array.isArray(history?.messages) ? history.messages : [],
      });
    } catch (error) {
      broadcastTab(tabId, { type: "panel.error", message: error.message });
    }
  }

  function scheduleHydrate(tabId) {
    if (historyTimers.has(tabId)) {
      return;
    }
    historyTimers.set(
      tabId,
      setTimeout(() => {
        historyTimers.delete(tabId);
        void hydrate(tabId);
      }, 100),
    );
  }

  function sessionSetupIsCurrent(tabId, tabRevision, configRevision, gatewayScope) {
    return (
      (tabRevisions.get(tabId) ?? 0) === tabRevision &&
      gatewayRevision === configRevision &&
      currentGatewayScope() === gatewayScope
    );
  }

  async function sessionSetupIsAuthorized(tabId, tabRevision, configRevision, gatewayScope) {
    if (
      !sessionSetupIsCurrent(tabId, tabRevision, configRevision, gatewayScope) ||
      !portsByTab.has(tabId)
    ) {
      return false;
    }
    try {
      const shared = await isTabShared(tabId);
      return (
        shared &&
        portsByTab.has(tabId) &&
        sessionSetupIsCurrent(tabId, tabRevision, configRevision, gatewayScope)
      );
    } catch {
      return false;
    }
  }

  async function suspendUnauthorizedSetup(tabId) {
    await suspendTab(tabId);
    if (portsByTab.has(tabId)) {
      void refreshPanelState(tabId);
    }
  }

  async function ensureSessionInner(
    tabId,
    tabRevision,
    configRevision,
    gatewayScope,
    hydrateHistory,
  ) {
    if (!gateway.ready || !(await isTabShared(tabId))) {
      return null;
    }
    const { targetId } = await attachDebugger(tabId);
    if (!sessionSetupIsCurrent(tabId, tabRevision, configRevision, gatewayScope)) {
      return null;
    }
    if (!(await sessionSetupIsAuthorized(tabId, tabRevision, configRevision, gatewayScope))) {
      await suspendUnauthorizedSetup(tabId);
      return null;
    }
    const binding = {
      kind: "tab",
      tabId,
      target: resolveBindingTarget(currentConfig),
      profile: "chrome",
      targetId,
    };
    let entry = registry.get(tabId, gatewayScope);
    if (entry) {
      await registry.updateBinding(tabId, gatewayScope, binding);
      entry = registry.get(tabId, gatewayScope);
    } else {
      const mainSessionKey = gateway.hello?.snapshot?.sessionDefaults?.mainSessionKey;
      const sessionKey = deriveTabSessionKey(mainSessionKey, crypto.randomUUID());
      if (!sessionKey) {
        throw new Error("Gateway did not provide a main session key.");
      }
      const created = await gateway.request("sessions.create", {
        key: sessionKey,
        label: "Browser copilot",
      });
      entry = await registry.put(tabId, {
        gatewayScope,
        sessionKey,
        sessionId: created?.sessionId,
        binding,
        createdAt: Date.now(),
      });
      try {
        await chromeApi.tabs.get(tabId);
      } catch {
        await registry.closeTab(tabId);
        await drainArchives(gatewayScope);
        return null;
      }
    }
    if (!sessionSetupIsCurrent(tabId, tabRevision, configRevision, gatewayScope)) {
      await registry.closeTab(tabId);
      await drainArchives(gatewayScope);
      return null;
    }
    if (!(await sessionSetupIsAuthorized(tabId, tabRevision, configRevision, gatewayScope))) {
      await suspendUnauthorizedSetup(tabId);
      return null;
    }
    await subscribe(entry);
    if (!sessionSetupIsCurrent(tabId, tabRevision, configRevision, gatewayScope)) {
      await unsubscribeTab(tabId, gatewayScope);
      await registry.closeTab(tabId);
      await drainArchives(gatewayScope);
      return null;
    }
    if (!(await sessionSetupIsAuthorized(tabId, tabRevision, configRevision, gatewayScope))) {
      await suspendUnauthorizedSetup(tabId);
      return null;
    }
    if (hydrateHistory) {
      await hydrate(tabId, entry);
    }
    if (!sessionSetupIsCurrent(tabId, tabRevision, configRevision, gatewayScope)) {
      await unsubscribeTab(tabId, gatewayScope);
      await registry.closeTab(tabId);
      await drainArchives(gatewayScope);
      return null;
    }
    if (!(await sessionSetupIsAuthorized(tabId, tabRevision, configRevision, gatewayScope))) {
      await suspendUnauthorizedSetup(tabId);
      return null;
    }
    broadcastTab(tabId, {
      type: "panel.state",
      state: "ready",
      label: "Bound to this tab",
      sessionKey: entry.sessionKey,
    });
    return entry;
  }

  async function ensureSession(tabId, { hydrateHistory = true } = {}) {
    const current = ensureByTab.get(tabId);
    if (current) {
      return await current;
    }
    const gatewayScope = currentGatewayScope();
    if (!gatewayScope) {
      return null;
    }
    const tabRevision = tabRevisions.get(tabId) ?? 0;
    const configRevision = gatewayRevision;
    const pending = ensureSessionInner(
      tabId,
      tabRevision,
      configRevision,
      gatewayScope,
      hydrateHistory,
    ).finally(() => {
      if (ensureByTab.get(tabId) === pending) {
        ensureByTab.delete(tabId);
      }
    });
    ensureByTab.set(tabId, pending);
    return await pending;
  }

  function panelOwnsSend(tabId, port, portRevision) {
    return portRevisions.get(tabId) === portRevision && portsByTab.get(tabId)?.has(port) === true;
  }

  async function sendMessage(tabId, port, portRevision, text) {
    if (!panelOwnsSend(tabId, port, portRevision)) {
      throw new Error("This panel is no longer attached to the tab.");
    }
    if (sendsByTab.has(tabId)) {
      throw new Error("Wait for the current turn to finish.");
    }
    if (!(await isTabShared(tabId))) {
      throw new Error("This tab is not shared with OpenClaw.");
    }
    const entry = await ensureSession(tabId, { hydrateHistory: false });
    if (!entry) {
      throw new Error("This tab no longer exists.");
    }
    const params = buildCopilotChatSendParams({
      binding: entry.binding,
      message: text,
      sessionId: entry.sessionId,
      sessionKey: entry.sessionKey,
    });
    const started = await registry.startRun(tabId, entry.gatewayScope, params.idempotencyKey);
    if (!started) {
      throw new Error("Wait for the current turn to finish.");
    }
    const stillShared = await isTabShared(tabId);
    if (!stillShared || !panelOwnsSend(tabId, port, portRevision)) {
      await registry.finishRun(entry.gatewayScope, entry.sessionKey, params.idempotencyKey);
      await suspendTab(tabId);
      throw new Error(
        stillShared
          ? "This panel is no longer attached to the tab."
          : "This tab is not shared with OpenClaw.",
      );
    }
    sendsByTab.add(tabId);
    try {
      const result = await gateway.request("chat.send", params);
      return result;
    } catch (error) {
      sendsByTab.delete(tabId);
      if (isDefinitiveGatewayRejection(error)) {
        await registry.finishRun(entry.gatewayScope, entry.sessionKey, params.idempotencyKey);
      } else {
        await registry.queueAbort(tabId, entry.gatewayScope);
        scheduleAbortRetry();
      }
      await refreshPanelState(tabId);
      throw error;
    }
  }

  async function shareTab(tabId) {
    await addTabToOpenClawGroup(tabId);
    scheduleTabsSync();
    await refreshPanelState(tabId);
  }

  async function drainArchives(gatewayScope = currentGatewayScope()) {
    if (!gateway.ready || !gatewayScope) {
      return;
    }
    for (const entry of registry.pendingArchives(gatewayScope)) {
      try {
        await archiveCopilotSession(gateway, entry);
        subscribedKeys.delete(entry.sessionKey);
        await registry.resolveArchive(gatewayScope, entry.sessionKey);
      } catch {
        // The watchdog retries after reconnect or after an active run reaches terminal state.
      }
    }
  }

  async function abortEntry(entry) {
    try {
      await gateway.request("sessions.abort", {
        key: entry.sessionKey,
        runId: entry.activeRunId,
      });
    } catch {
      scheduleAbortRetry();
      return false;
    }
    sendsByTab.delete(entry.tabId);
    const finished = await registry.finishRun(
      entry.gatewayScope,
      entry.sessionKey,
      entry.activeRunId,
    );
    if (finished) {
      broadcastTab(entry.tabId, { type: "panel.turn-reset" });
      void refreshPanelState(entry.tabId);
    }
    return true;
  }

  async function drainAborts(gatewayScope = currentGatewayScope()) {
    if (!gateway.ready || !gatewayScope) {
      return;
    }
    for (const entry of registry.pendingAborts(gatewayScope)) {
      await abortEntry(entry);
    }
    if (
      registry.pendingAborts(gatewayScope).length === 0 &&
      gatewayStatus.state === "error" &&
      lastReadyStatus
    ) {
      gatewayStatus = lastReadyStatus;
      broadcastStatus();
    }
  }

  function clearAbortRetry() {
    if (abortRetryTimer) {
      clearTimeout(abortRetryTimer);
      abortRetryTimer = null;
    }
    abortRetryDelayMs = 250;
  }

  function scheduleAbortRetry() {
    const gatewayScope = currentGatewayScope();
    if (abortRetryTimer || !gateway.ready || !gatewayScope) {
      return;
    }
    const delayMs = abortRetryDelayMs;
    abortRetryTimer = setTimeout(() => {
      abortRetryTimer = null;
      void (async () => {
        await drainAborts(gatewayScope);
        if (registry.pendingAborts(gatewayScope).length > 0) {
          abortRetryDelayMs = Math.min(abortRetryDelayMs * 2, 5_000);
          scheduleAbortRetry();
        } else {
          abortRetryDelayMs = 250;
        }
      })();
    }, delayMs);
  }

  async function reconcileGatewayReady(status, statusRevision) {
    const gatewayScope = currentGatewayScope();
    if (!gatewayScope) {
      return;
    }
    // A connection gap loses terminal events. Abort every run whose durable
    // custody is still active before panels can send again.
    await registry.queueActiveAborts(gatewayScope);
    await drainAborts(gatewayScope);
    await drainArchives(gatewayScope);
    if (
      statusRevision !== gatewayStatusRevision ||
      !gateway.ready ||
      currentGatewayScope() !== gatewayScope
    ) {
      return;
    }
    gatewayStatus = registry.pendingAborts(gatewayScope).length
      ? { state: "error", label: "Could not stop the previous tab run" }
      : status;
    broadcastStatus();
  }

  async function onTabRemoved(tabId) {
    tabRevisions.set(tabId, (tabRevisions.get(tabId) ?? 0) + 1);
    await initialize();
    portsByTab.delete(tabId);
    portRevisions.set(tabId, (portRevisions.get(tabId) ?? 0) + 1);
    sendsByTab.delete(tabId);
    const timer = historyTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      historyTimers.delete(tabId);
    }
    try {
      await ensureByTab.get(tabId);
    } catch {
      // Closing the tab still owns cleanup when a concurrent session setup failed.
    }
    await registry.closeTab(tabId);
    await panelBindings.remove(tabId);
    await drainArchives(currentGatewayScope());
  }

  async function onConsentChanged() {
    await initialize();
    for (const tabId of portsByTab.keys()) {
      await refreshPanelState(tabId);
    }
  }

  async function preparePanel(tabId) {
    if (!Number.isInteger(tabId)) {
      throw new Error("No active tab.");
    }
    await chromeApi.tabs.get(tabId);
    const binding = await panelBindings.bind(tabId);
    return { path: `${PANEL_PATH}?binding=${encodeURIComponent(binding)}` };
  }

  async function connectPort(port) {
    await initialize();
    let tabId;
    try {
      tabId = await resolveSidePanelTabId(chromeApi, port, panelBindings);
    } catch (error) {
      post(port, { type: "panel.state", state: "denied", label: error.message });
      port.disconnect();
      return;
    }
    const ports = portsByTab.get(tabId) ?? new Set();
    ports.add(port);
    portsByTab.set(tabId, ports);
    const portRevision = (portRevisions.get(tabId) ?? 0) + 1;
    portRevisions.set(tabId, portRevision);
    port.onMessage.addListener((message) => {
      void (async () => {
        try {
          if (message?.type === "panel.send") {
            await sendMessage(tabId, port, portRevision, message.message);
          } else if (message?.type === "panel.share") {
            await shareTab(tabId);
          } else if (message?.type === "panel.refresh") {
            await refreshPanelState(tabId);
          }
        } catch (error) {
          post(port, { type: "panel.error", message: error.message });
        }
      })();
    });
    port.onDisconnect.addListener(() => {
      ports.delete(port);
      if (ports.size === 0) {
        portsByTab.delete(tabId);
        const portRevision = (portRevisions.get(tabId) ?? 0) + 1;
        portRevisions.set(tabId, portRevision);
        void scheduleSuspend(tabId, portRevision);
      }
    });
    await suspendByTab.get(tabId);
    await refreshPanelState(tabId);
  }

  gateway.onStatus((status) => {
    const statusRevision = ++gatewayStatusRevision;
    subscribedKeys.clear();
    if (status.state === "ready") {
      lastReadyStatus = status;
      gatewayStatus = { state: "connecting", label: "Reconciling previous tab runs" };
      broadcastStatus();
      void reconcileGatewayReady(status, statusRevision);
      return;
    }
    clearAbortRetry();
    lastReadyStatus = null;
    gatewayStatus = status;
    broadcastStatus();
  });

  gateway.onEvent((event) => {
    const sessionKey = sessionKeyFromEvent(event);
    if (!sessionKey) {
      return;
    }
    for (const [tabId, ports] of portsByTab) {
      const entry = registry.get(tabId, currentGatewayScope());
      if (entry?.sessionKey !== sessionKey) {
        continue;
      }
      for (const port of ports) {
        post(port, { type: "panel.event", event });
      }
      const state = event.payload?.state;
      if (event.event === "session.message") {
        scheduleHydrate(tabId);
      }
      if (
        event.event === "chat" &&
        (state === "final" || state === "aborted" || state === "error")
      ) {
        const runId = event.payload?.runId;
        if (typeof runId === "string" && entry.activeRunId === runId) {
          const gatewayScope = currentGatewayScope();
          sendsByTab.delete(tabId);
          scheduleHydrate(tabId);
          void registry.finishRun(gatewayScope, entry.sessionKey, runId);
        }
        void drainArchives();
      }
    }
  });

  chromeApi.runtime.onConnect.addListener((port) => {
    if (port.name === PANEL_PORT) {
      void connectPort(port);
    }
  });

  return {
    initialize,
    preparePanel,
    onConsentChanged,
    onTabRemoved,
    refreshConfig,
    drainAborts,
    drainArchives,
    registry,
  };
}
