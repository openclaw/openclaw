import {
  CopilotGatewayClient,
  isDefinitiveGatewayRejection,
  waitForCopilotGatewayReady,
} from "./copilot-gateway.js";
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
  if (entry.ensureCreated) {
    // The worker may have stopped after persisting creation intent but before
    // sending it. sessions.create adopts the same key, making cleanup idempotent.
    await gateway.request("sessions.create", {
      key: entry.sessionKey,
      label: "Browser copilot",
    });
  }
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

export function selectCopilotPanelState({ paired, shared, abortPending, gatewayState }) {
  if (!paired) {
    return "needs-pairing";
  }
  if (!shared) {
    return "needs-sharing";
  }
  return abortPending ? "reconciling" : gatewayState;
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
  revokeDebugger,
  restoreDebugger,
  scheduleTabsSync,
  gateway = new CopilotGatewayClient(),
  recoveryGatewayFactory = () => new CopilotGatewayClient(),
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
  const consentRevisions = new Map();
  const consentByTab = new Map();
  const historyTimers = new Map();
  let gatewayStatus = { state: "off", label: "Pair the extension first" };
  let currentConfig = null;
  let gatewayRevision = 0;
  let gatewayStatusRevision = 0;
  let reconciledGatewayStatusRevision = 0;
  let lastReadyStatus = null;
  let abortRetryTimer = null;
  let abortRetryDelayMs = 250;
  let custodyInitialized = null;
  let initialized = null;
  let lifecycleChain = Promise.resolve();
  let staleRecovery = null;
  let staleRecoveryRetryTimer = null;
  let pendingGatewayRevocation = Promise.resolve();
  let configTransitioning = false;

  async function initializeCustody() {
    if (custodyInitialized) {
      return await custodyInitialized;
    }
    custodyInitialized = (async () => {
      const tabs = await chromeApi.tabs.query({});
      await registry.initialize(
        new Set(tabs.map((tab) => tab.id).filter((tabId) => typeof tabId === "number")),
      );
      await panelBindings.initialize();
      const activeScopes = new Set(
        registry
          .list()
          .filter((entry) => entry.activeRunId)
          .map((entry) => entry.gatewayScope),
      );
      // MV3 can discard process memory mid-run. Rebuild the debugger deny set
      // from durable run custody before relay attachments can resume.
      await Promise.allSettled([...activeScopes].map((scope) => revokeActiveBindings(scope)));
    })();
    return await custodyInitialized;
  }

  async function initialize() {
    if (initialized) {
      return await initialized;
    }
    initialized = (async () => {
      await initializeCustody();
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

  function broadcastStatus(options) {
    for (const tabId of portsByTab.keys()) {
      void refreshPanelState(tabId, options);
    }
  }

  function currentGatewayScope() {
    return typeof currentConfig?.gatewayUrl === "string" ? currentConfig.gatewayUrl : null;
  }

  async function restoreDebuggerIfReleased(tabId) {
    if (registry.list().some((entry) => entry.tabId === tabId && entry.activeRunId)) {
      return;
    }
    await restoreDebugger(tabId);
  }

  function currentReadyEpoch() {
    const gatewayScope = currentGatewayScope();
    if (
      !gatewayScope ||
      configTransitioning ||
      !gateway.ready ||
      gatewayStatus.state !== "ready" ||
      reconciledGatewayStatusRevision !== gatewayStatusRevision
    ) {
      return null;
    }
    return {
      gatewayScope,
      configRevision: gatewayRevision,
      statusRevision: gatewayStatusRevision,
    };
  }

  function readyEpochIsCurrent(epoch) {
    return (
      epoch?.gatewayScope === currentGatewayScope() &&
      epoch.configRevision === gatewayRevision &&
      epoch.statusRevision === gatewayStatusRevision &&
      reconciledGatewayStatusRevision === epoch.statusRevision &&
      !configTransitioning &&
      gateway.ready &&
      gatewayStatus.state === "ready"
    );
  }

  async function applyConfig() {
    const nextConfig = await getConfig();
    const nextGatewayScope = gatewayUrlFromPairing(nextConfig.relayUrl, nextConfig.gatewayUrl);
    const previousGatewayScope = currentGatewayScope();
    if (!previousGatewayScope) {
      const staleScopes = registry.gatewayScopes().filter((scope) => scope !== nextGatewayScope);
      if (staleScopes.length > 0) {
        for (const staleScope of staleScopes) {
          await registry.closeInactiveScope(staleScope);
        }
        scheduleStaleRecovery();
      }
    }
    if (previousGatewayScope && previousGatewayScope !== nextGatewayScope) {
      configTransitioning = true;
      clearAbortRetry();
      lastReadyStatus = null;
      gatewayStatusRevision += 1;
      reconciledGatewayStatusRevision = 0;
      gatewayRevision += 1;
      gatewayStatus = { state: "connecting", label: "Changing Gateway" };
      broadcastStatus();
      let needsStaleRecovery = false;
      try {
        await revokeActiveBindings(previousGatewayScope);
        await Promise.allSettled([...ensureByTab.values()].map((entry) => entry.promise));
        await drainAborts(previousGatewayScope);
        const hasPendingAborts = registry.pendingAborts(previousGatewayScope).length > 0;
        if (hasPendingAborts) {
          await registry.closeInactiveScope(previousGatewayScope);
        } else {
          await registry.closeScope(previousGatewayScope);
        }
        await drainArchives(previousGatewayScope);
        needsStaleRecovery =
          hasPendingAborts || registry.pendingArchives(previousGatewayScope).length > 0;
      } catch {
        // The next Gateway may start, but old-scope custody remains denied and
        // the recovery client owns cleanup. Never strand the controller mid-switch.
        needsStaleRecovery = true;
      } finally {
        gateway.stop();
        sendsByTab.clear();
        subscribedKeys.clear();
        configTransitioning = false;
      }
      if (needsStaleRecovery) {
        scheduleStaleRecovery();
      }
    }
    currentConfig = { ...nextConfig, gatewayUrl: nextGatewayScope };
    configTransitioning = false;
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

  function runLifecycle(task) {
    const pending = lifecycleChain.then(task);
    lifecycleChain = pending.catch(() => undefined);
    return pending;
  }

  function refreshConfig() {
    // Config changes and stale-scope recovery share one owner. Otherwise a
    // scope can become current while a recovery client is still destroying it.
    return runLifecycle(applyConfig);
  }

  async function refreshPanelState(
    tabId,
    { shared: knownShared, ensureSetup = false, hydrateHistory = false, suspended = false } = {},
  ) {
    let tab;
    try {
      tab = await chromeApi.tabs.get(tabId);
    } catch {
      return;
    }
    const shared = typeof knownShared === "boolean" ? knownShared : await isTabShared(tabId);
    const entry = registry.get(tabId, currentGatewayScope());
    const state = selectCopilotPanelState({
      paired: Boolean(currentConfig?.relayUrl),
      shared,
      abortPending: Boolean(entry?.abortPending),
      gatewayState: gatewayStatus.state,
    });
    const panelState = {
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
    };
    if (!shared) {
      broadcastTab(tabId, panelState);
      if (!suspended) {
        await suspendTab(tabId, { detachInactive: true });
      }
      return;
    }
    if (state !== "ready") {
      broadcastTab(tabId, panelState);
      return;
    }
    const needsSetup =
      ensureSetup || !entry || !subscribedKeys.has(entry.sessionKey) || !entry.binding;
    if (!needsSetup) {
      broadcastTab(tabId, panelState);
      return;
    }
    broadcastTab(tabId, {
      ...panelState,
      state: "connecting",
      label: "Preparing this tab",
    });
    try {
      const prepared = await ensureSession(tabId, { hydrateHistory });
      if (prepared) {
        await refreshPanelState(tabId, { shared: await isTabShared(tabId) });
      }
    } catch (error) {
      broadcastTab(tabId, {
        ...panelState,
        state: "error",
        label: error?.message || "Could not prepare this tab",
      });
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

  async function suspendTab(tabId, { expectedPortRevision, detachInactive = false } = {}) {
    if (expectedPortRevision !== undefined && portRevisions.get(tabId) !== expectedPortRevision) {
      return;
    }
    const gatewayScope = currentGatewayScope();
    const entry = registry.get(tabId, gatewayScope);
    // Revoke local delivery and CDP access before any fallible Gateway RPC.
    const unsubscribing = unsubscribeTab(tabId, gatewayScope);
    const detaching = entry?.activeRunId
      ? revokeDebugger(tabId)
      : detachInactive
        ? revokeDebugger(tabId).then(() => restoreDebuggerIfReleased(tabId))
        : Promise.resolve();
    const queued = await registry.queueAbort(tabId, gatewayScope);
    sendsByTab.delete(tabId);
    await Promise.allSettled([unsubscribing, detaching]);
    if (queued && gateway.ready) {
      await abortEntry(queued);
    }
  }

  function scheduleSuspend(tabId, portRevision) {
    const pending = suspendTab(tabId, { expectedPortRevision: portRevision }).finally(() => {
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
      !configTransitioning &&
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
    let shared = false;
    try {
      shared = await isTabShared(tabId);
    } catch {
      // Missing or unreadable tab state is not authorized to retain CDP access.
    }
    await suspendTab(tabId, { detachInactive: !shared });
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
    const staleActiveSession = registry
      .list()
      .find(
        (entry) =>
          entry.tabId === tabId && entry.gatewayScope !== gatewayScope && entry.activeRunId,
      );
    if (staleActiveSession) {
      throw new Error("This tab is still stopping a run from its previous Gateway.");
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
      entry = await registry.put(tabId, {
        gatewayScope,
        sessionKey,
        binding,
        createdAt: Date.now(),
        provisional: true,
        creationPending: false,
      });
    }
    if (entry?.provisional) {
      if (!sessionSetupIsCurrent(tabId, tabRevision, configRevision, gatewayScope)) {
        await registry.closeTab(tabId);
        await drainArchives(gatewayScope);
        return null;
      }
      // Persist the generated key before the RPC. Retrying sessions.create with
      // that key adopts a commit whose response was lost instead of leaking it.
      entry = await registry.markSessionCreationPending(tabId, gatewayScope);
      if (!entry) {
        return null;
      }
      let created;
      try {
        created = await gateway.request("sessions.create", {
          key: entry.sessionKey,
          label: "Browser copilot",
        });
      } catch (error) {
        if (isDefinitiveGatewayRejection(error)) {
          await registry.discardProvisionalSession(tabId, gatewayScope);
        }
        throw error;
      }
      entry = await registry.confirmSession(tabId, gatewayScope, created?.sessionId);
      if (!entry) {
        return null;
      }
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
    return entry;
  }

  async function ensureSession(tabId, { hydrateHistory = true } = {}) {
    const current = ensureByTab.get(tabId);
    if (current) {
      current.hydrateHistory ||= hydrateHistory;
      return await current.promise;
    }
    const gatewayScope = currentGatewayScope();
    if (!gatewayScope) {
      return null;
    }
    const tabRevision = tabRevisions.get(tabId) ?? 0;
    const configRevision = gatewayRevision;
    const request = { hydrateHistory, promise: null };
    const pending = ensureSessionInner(tabId, tabRevision, configRevision, gatewayScope, false)
      .then(async (entry) => {
        if (entry && request.hydrateHistory) {
          await hydrate(tabId, entry);
        }
        return entry;
      })
      .finally(() => {
        if (ensureByTab.get(tabId) === request) {
          ensureByTab.delete(tabId);
        }
      });
    request.promise = pending;
    ensureByTab.set(tabId, request);
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
    const readyEpoch = currentReadyEpoch();
    if (!readyEpoch) {
      throw new Error("Gateway is still reconciling this tab.");
    }
    if (!(await isTabShared(tabId))) {
      throw new Error("This tab is not shared with OpenClaw.");
    }
    const entry = await ensureSession(tabId, { hydrateHistory: false });
    if (!entry) {
      throw new Error("This tab no longer exists.");
    }
    if (!readyEpochIsCurrent(readyEpoch) || entry.gatewayScope !== readyEpoch.gatewayScope) {
      throw new Error("Gateway connection changed while preparing this tab.");
    }
    const params = buildCopilotChatSendParams({
      binding: entry.binding,
      message: text,
      sessionId: entry.sessionId,
      sessionKey: entry.sessionKey,
    });
    if (!readyEpochIsCurrent(readyEpoch)) {
      throw new Error("Gateway connection changed while preparing this tab.");
    }
    const started = await registry.startRun(tabId, entry.gatewayScope, params.idempotencyKey);
    if (!started) {
      throw new Error("Wait for the current turn to finish.");
    }
    let submitted = false;
    try {
      const stillShared = await isTabShared(tabId);
      const stillOwnsPanel = panelOwnsSend(tabId, port, portRevision);
      const stillOwnsGateway = readyEpochIsCurrent(readyEpoch);
      if (!stillShared || !stillOwnsPanel || !stillOwnsGateway) {
        if (!stillShared || !stillOwnsPanel) {
          await suspendTab(tabId, { detachInactive: !stillShared });
        }
        throw new Error(
          !stillShared
            ? "This tab is not shared with OpenClaw."
            : !stillOwnsPanel
              ? "This panel is no longer attached to the tab."
              : "Gateway connection changed while preparing this tab.",
        );
      }
      sendsByTab.add(tabId);
      submitted = true;
      const result = await gateway.request("chat.send", params);
      return result;
    } catch (error) {
      sendsByTab.delete(tabId);
      if (!submitted || isDefinitiveGatewayRejection(error)) {
        const finished = await registry.finishRun(
          entry.gatewayScope,
          entry.sessionKey,
          params.idempotencyKey,
        );
        if (finished) {
          await restoreDebuggerIfReleased(tabId);
        }
      } else {
        await revokeDebugger(tabId);
        const queued = await registry.queueAbort(tabId, entry.gatewayScope);
        if (queued) {
          scheduleAbortRetry();
        } else {
          await restoreDebuggerIfReleased(tabId);
        }
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
        if (typeof entry.tabId === "number") {
          await restoreDebuggerIfReleased(entry.tabId);
        }
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
      scheduleAbortRetry(entry.gatewayScope);
      return false;
    }
    sendsByTab.delete(entry.tabId);
    const finished = await registry.finishRun(
      entry.gatewayScope,
      entry.sessionKey,
      entry.activeRunId,
    );
    if (finished) {
      await restoreDebuggerIfReleased(entry.tabId);
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
  }

  function clearAbortRetry() {
    if (abortRetryTimer) {
      clearTimeout(abortRetryTimer);
      abortRetryTimer = null;
    }
    abortRetryDelayMs = 250;
  }

  function scheduleAbortRetry(gatewayScope = currentGatewayScope()) {
    const statusRevision = gatewayStatusRevision;
    if (
      abortRetryTimer ||
      !gateway.ready ||
      !gatewayScope ||
      configTransitioning ||
      currentGatewayScope() !== gatewayScope
    ) {
      return;
    }
    const delayMs = abortRetryDelayMs;
    abortRetryTimer = setTimeout(() => {
      abortRetryTimer = null;
      void (async () => {
        if (
          currentGatewayScope() !== gatewayScope ||
          gatewayStatusRevision !== statusRevision ||
          !gateway.ready
        ) {
          return;
        }
        await drainAborts(gatewayScope);
        if (
          currentGatewayScope() !== gatewayScope ||
          gatewayStatusRevision !== statusRevision ||
          !gateway.ready
        ) {
          return;
        }
        if (registry.pendingAborts(gatewayScope).length > 0) {
          abortRetryDelayMs = Math.min(abortRetryDelayMs * 2, 5_000);
          scheduleAbortRetry();
        } else {
          abortRetryDelayMs = 250;
          if (gatewayStatus.state === "error" && lastReadyStatus) {
            gatewayStatus = lastReadyStatus;
            reconciledGatewayStatusRevision = statusRevision;
            broadcastStatus({ ensureSetup: true, hydrateHistory: true });
          }
        }
      })();
    }, delayMs);
  }

  async function reconcileGatewayReady(status, statusRevision, gatewayScope, revocation) {
    await revocation;
    if (
      !gatewayScope ||
      statusRevision !== gatewayStatusRevision ||
      configTransitioning ||
      !gateway.ready ||
      currentGatewayScope() !== gatewayScope
    ) {
      return;
    }
    // A connection gap loses terminal events. Abort every run whose durable
    // custody is still active before panels can send again.
    await registry.queueActiveAborts(gatewayScope);
    await drainAborts(gatewayScope);
    await drainArchives(gatewayScope);
    if (
      statusRevision !== gatewayStatusRevision ||
      configTransitioning ||
      !gateway.ready ||
      currentGatewayScope() !== gatewayScope
    ) {
      return;
    }
    const hasPendingAborts = registry.pendingAborts(gatewayScope).length > 0;
    gatewayStatus = hasPendingAborts
      ? { state: "error", label: "Could not stop the previous tab run" }
      : status;
    reconciledGatewayStatusRevision = hasPendingAborts ? 0 : statusRevision;
    broadcastStatus(hasPendingAborts ? undefined : { ensureSetup: true, hydrateHistory: true });
  }

  function scheduleStaleRecovery() {
    if (staleRecoveryRetryTimer) {
      return;
    }
    staleRecoveryRetryTimer = setTimeout(() => {
      staleRecoveryRetryTimer = null;
      void drainStaleScopes();
    }, 5_000);
  }

  function drainStaleScopes() {
    if (staleRecovery) {
      return staleRecovery;
    }
    if (staleRecoveryRetryTimer) {
      clearTimeout(staleRecoveryRetryTimer);
      staleRecoveryRetryTimer = null;
    }
    let retry = false;
    const pending = runLifecycle(async () => {
      const currentScope = currentGatewayScope();
      const staleScopes = registry.gatewayScopes().filter((scope) => scope !== currentScope);
      for (const staleScope of staleScopes) {
        if (await recoverPersistedScope(staleScope)) {
          continue;
        }
        await registry.closeInactiveScope(staleScope);
        retry = true;
      }
      if (gateway.ready && gatewayStatus.state === "ready") {
        broadcastStatus({ ensureSetup: true, hydrateHistory: true });
      }
    }).catch(() => {
      retry = true;
    });
    staleRecovery = pending;
    void pending.then(() => {
      if (staleRecovery === pending) {
        staleRecovery = null;
      }
      if (retry) {
        scheduleStaleRecovery();
      }
    });
    return pending;
  }

  async function recoverPersistedScope(gatewayScope) {
    const scopedEntries = registry.list().filter((entry) => entry.gatewayScope === gatewayScope);
    const needsGateway =
      registry.pendingArchives(gatewayScope).length > 0 ||
      scopedEntries.some(
        (entry) => !entry.provisional || entry.creationPending || entry.activeRunId,
      );
    if (!needsGateway) {
      await registry.closeScope(gatewayScope);
      return true;
    }
    const recoveryGateway = recoveryGatewayFactory();
    try {
      await waitForCopilotGatewayReady(recoveryGateway, gatewayScope);
      await registry.queueActiveAborts(gatewayScope);
      for (const entry of registry.pendingAborts(gatewayScope)) {
        await recoveryGateway.request("sessions.abort", {
          key: entry.sessionKey,
          runId: entry.activeRunId,
        });
        const finished = await registry.finishRun(
          entry.gatewayScope,
          entry.sessionKey,
          entry.activeRunId,
        );
        if (finished) {
          await restoreDebuggerIfReleased(entry.tabId);
        }
      }
      await registry.closeScope(gatewayScope);
      for (const entry of registry.pendingArchives(gatewayScope)) {
        await archiveCopilotSession(recoveryGateway, entry);
        await registry.resolveArchive(gatewayScope, entry.sessionKey);
        if (typeof entry.tabId === "number") {
          await restoreDebuggerIfReleased(entry.tabId);
        }
      }
      return (
        registry.pendingAborts(gatewayScope).length === 0 &&
        registry.pendingArchives(gatewayScope).length === 0
      );
    } catch {
      return false;
    } finally {
      recoveryGateway.stop();
    }
  }

  async function onTabRemoved(tabId) {
    tabRevisions.set(tabId, (tabRevisions.get(tabId) ?? 0) + 1);
    consentRevisions.set(tabId, (consentRevisions.get(tabId) ?? 0) + 1);
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
      await ensureByTab.get(tabId)?.promise;
    } catch {
      // Closing the tab still owns cleanup when a concurrent session setup failed.
    }
    await registry.closeTab(tabId);
    await panelBindings.remove(tabId);
    await drainArchives(currentGatewayScope());
  }

  async function onConsentChanged(changedTabId, { revoked = false } = {}) {
    await initialize();
    const tabIds =
      typeof changedTabId === "number"
        ? portsByTab.has(changedTabId) ||
          registry.list().some((entry) => entry.tabId === changedTabId)
          ? [changedTabId]
          : []
        : [...new Set([...portsByTab.keys(), ...registry.list().map((entry) => entry.tabId)])];
    await Promise.all(
      tabIds.map((tabId) => {
        const revision = (consentRevisions.get(tabId) ?? 0) + 1;
        consentRevisions.set(tabId, revision);
        const previous = consentByTab.get(tabId) ?? Promise.resolve();
        const pending = previous
          .catch(() => undefined)
          .then(async () => {
            // Event-time revocation is sticky even if a later update observes
            // the tab re-shared. CDP must detach for the revoked interval.
            if (revoked) {
              await suspendTab(tabId, { detachInactive: true });
            }
            if (consentRevisions.get(tabId) !== revision) {
              return;
            }
            let shared = false;
            try {
              shared = await isTabShared(tabId);
            } catch {
              // Missing tab state is treated as revoked consent.
            }
            if (!shared) {
              await suspendTab(tabId, { detachInactive: true });
            }
            if (consentRevisions.get(tabId) !== revision) {
              return;
            }
            try {
              shared = await isTabShared(tabId);
            } catch {
              shared = false;
            }
            if (consentRevisions.get(tabId) !== revision) {
              return;
            }
            if (shared) {
              await restoreDebuggerIfReleased(tabId);
            }
            await refreshPanelState(tabId, { shared, suspended: !shared });
          })
          .finally(() => {
            if (consentByTab.get(tabId) === pending) {
              consentByTab.delete(tabId);
            }
          });
        consentByTab.set(tabId, pending);
        return pending;
      }),
    );
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
        const disconnectedRevision = (portRevisions.get(tabId) ?? 0) + 1;
        portRevisions.set(tabId, disconnectedRevision);
        void scheduleSuspend(tabId, disconnectedRevision);
      }
    });
    await suspendByTab.get(tabId);
    await refreshPanelState(tabId, { ensureSetup: true, hydrateHistory: true });
  }

  async function revokeActiveBindings(gatewayScope) {
    const activeEntries = registry
      .list()
      .filter((entry) => entry.gatewayScope === gatewayScope && entry.activeRunId);
    await Promise.allSettled([
      registry.queueActiveAborts(gatewayScope),
      ...activeEntries.map((entry) => revokeDebugger(entry.tabId)),
    ]);
  }

  gateway.onStatus((status) => {
    const statusRevision = ++gatewayStatusRevision;
    // A new connection epoch owns its own abort retry timer.
    clearAbortRetry();
    subscribedKeys.clear();
    if (status.state === "ready") {
      const gatewayScope = currentGatewayScope();
      lastReadyStatus = status;
      gatewayStatus = { state: "connecting", label: "Reconciling previous tab runs" };
      broadcastStatus();
      void runLifecycle(() =>
        reconcileGatewayReady(status, statusRevision, gatewayScope, pendingGatewayRevocation),
      ).catch(() => {
        if (gatewayScope === currentGatewayScope() && statusRevision === gatewayStatusRevision) {
          gatewayStatus = { state: "error", label: "Could not reconcile previous tab runs" };
          broadcastStatus();
        }
      });
      return;
    }
    reconciledGatewayStatusRevision = 0;
    const gatewayScope = currentGatewayScope();
    if (gatewayScope) {
      pendingGatewayRevocation = revokeActiveBindings(gatewayScope);
    } else {
      pendingGatewayRevocation = Promise.resolve();
    }
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
      if (entry?.sessionKey !== sessionKey || !subscribedKeys.has(sessionKey)) {
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
          if (gatewayScope) {
            void registry
              .finishRun(gatewayScope, entry.sessionKey, runId)
              .then(async (finished) => {
                if (finished) {
                  await restoreDebuggerIfReleased(tabId);
                  void refreshPanelState(tabId);
                }
                void drainArchives(gatewayScope);
              });
            continue;
          }
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
    initializeCustody,
    initialize,
    preparePanel,
    onConsentChanged,
    onTabRemoved,
    refreshConfig,
    drainAborts,
    drainArchives,
    drainStaleScopes,
    registry,
  };
}
