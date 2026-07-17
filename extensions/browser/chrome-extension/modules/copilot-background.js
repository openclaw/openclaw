import { CopilotGatewayClient } from "./copilot-gateway.js";
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
  const tabRevisions = new Map();
  const historyTimers = new Map();
  let gatewayStatus = { state: "off", label: "Pair the extension first" };
  let currentConfig = null;
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

  async function refreshConfig() {
    currentConfig = await getConfig();
    const gatewayUrl = gatewayUrlFromPairing(currentConfig.relayUrl, currentConfig.gatewayUrl);
    currentConfig.gatewayUrl = gatewayUrl;
    if (!currentConfig.relayUrl || !gatewayUrl) {
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
      gateway.stop();
      gatewayStatus = { state: "denied", label: error.message };
      broadcastStatus();
      return;
    }
    gateway.start(gatewayUrl);
  }

  async function refreshPanelState(tabId) {
    let tab;
    try {
      tab = await chromeApi.tabs.get(tabId);
    } catch {
      return;
    }
    const shared = await isTabShared(tabId);
    const state = !currentConfig?.relayUrl
      ? "needs-pairing"
      : !shared
        ? "needs-sharing"
        : gatewayStatus.state;
    broadcastTab(tabId, {
      type: "panel.state",
      state,
      label:
        state === "needs-sharing"
          ? "Share this tab before the copilot can act"
          : gatewayStatus.label,
      requestId: gatewayStatus.requestId,
      tab: {
        title: typeof tab.title === "string" ? tab.title : "",
        url: typeof tab.url === "string" ? tab.url : "",
        label: safeTabLabel(tab),
      },
      sessionKey: registry.get(tabId)?.sessionKey,
    });
    if (shared && gatewayStatus.state === "ready") {
      await ensureSession(tabId);
    } else if (!shared) {
      await unsubscribeTab(tabId);
    }
  }

  async function subscribe(entry) {
    if (subscribedKeys.has(entry.sessionKey)) {
      return;
    }
    await gateway.request("sessions.messages.subscribe", { key: entry.sessionKey });
    subscribedKeys.add(entry.sessionKey);
  }

  async function unsubscribeTab(tabId) {
    const entry = registry.get(tabId);
    if (!entry || !subscribedKeys.delete(entry.sessionKey)) {
      return;
    }
    try {
      await gateway.request("sessions.messages.unsubscribe", { key: entry.sessionKey });
    } catch {
      // Socket closure also clears the server-owned allowlist.
    }
  }

  async function hydrate(tabId, entry = registry.get(tabId)) {
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

  async function ensureSessionInner(tabId, revision) {
    if (!gateway.ready || !(await isTabShared(tabId))) {
      return null;
    }
    const { targetId } = await attachDebugger(tabId);
    const binding = {
      kind: "tab",
      tabId,
      target: resolveBindingTarget(currentConfig),
      profile: "chrome",
      targetId,
    };
    let entry = registry.get(tabId);
    if (entry) {
      await registry.updateBinding(tabId, binding);
      entry = registry.get(tabId);
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
        sessionKey,
        sessionId: created?.sessionId,
        binding,
        createdAt: Date.now(),
      });
      try {
        await chromeApi.tabs.get(tabId);
      } catch {
        await registry.closeTab(tabId);
        await drainArchives();
        return null;
      }
    }
    if ((tabRevisions.get(tabId) ?? 0) !== revision) {
      await registry.closeTab(tabId);
      await drainArchives();
      return null;
    }
    await subscribe(entry);
    if ((tabRevisions.get(tabId) ?? 0) !== revision) {
      await unsubscribeTab(tabId);
      await registry.closeTab(tabId);
      await drainArchives();
      return null;
    }
    await hydrate(tabId, entry);
    if ((tabRevisions.get(tabId) ?? 0) !== revision) {
      await unsubscribeTab(tabId);
      await registry.closeTab(tabId);
      await drainArchives();
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

  async function ensureSession(tabId) {
    const current = ensureByTab.get(tabId);
    if (current) {
      return await current;
    }
    const revision = tabRevisions.get(tabId) ?? 0;
    const pending = ensureSessionInner(tabId, revision).finally(() => {
      if (ensureByTab.get(tabId) === pending) {
        ensureByTab.delete(tabId);
      }
    });
    ensureByTab.set(tabId, pending);
    return await pending;
  }

  async function sendMessage(tabId, text) {
    if (sendsByTab.has(tabId)) {
      throw new Error("Wait for the current turn to finish.");
    }
    if (!(await isTabShared(tabId))) {
      throw new Error("This tab is not shared with OpenClaw.");
    }
    const entry = await ensureSession(tabId);
    if (!entry) {
      throw new Error("This tab no longer exists.");
    }
    sendsByTab.add(tabId);
    try {
      const result = await gateway.request(
        "chat.send",
        buildCopilotChatSendParams({
          binding: entry.binding,
          message: text,
          sessionId: entry.sessionId,
          sessionKey: entry.sessionKey,
        }),
      );
      return result;
    } catch (error) {
      sendsByTab.delete(tabId);
      throw error;
    }
  }

  async function shareTab(tabId) {
    await addTabToOpenClawGroup(tabId);
    scheduleTabsSync();
    await refreshPanelState(tabId);
  }

  async function drainArchives() {
    if (!gateway.ready) {
      return;
    }
    for (const entry of registry.pendingArchives()) {
      try {
        await archiveCopilotSession(gateway, entry);
        subscribedKeys.delete(entry.sessionKey);
        await registry.resolveArchive(entry.sessionKey);
      } catch {
        // The watchdog retries after reconnect or after an active run reaches terminal state.
      }
    }
  }

  async function onTabRemoved(tabId) {
    tabRevisions.set(tabId, (tabRevisions.get(tabId) ?? 0) + 1);
    await initialize();
    portsByTab.delete(tabId);
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
    await drainArchives();
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
    port.onMessage.addListener((message) => {
      void (async () => {
        try {
          if (message?.type === "panel.send") {
            await sendMessage(tabId, message.message);
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
        void unsubscribeTab(tabId);
      }
    });
    await refreshPanelState(tabId);
  }

  gateway.onStatus((status) => {
    gatewayStatus = status;
    if (status.state === "ready") {
      subscribedKeys.clear();
      void drainArchives();
    }
    broadcastStatus();
  });

  gateway.onEvent((event) => {
    const sessionKey = sessionKeyFromEvent(event);
    if (!sessionKey) {
      return;
    }
    for (const [tabId, ports] of portsByTab) {
      const entry = registry.get(tabId);
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
        sendsByTab.delete(tabId);
        scheduleHydrate(tabId);
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
    drainArchives,
    registry,
  };
}
