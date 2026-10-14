import { ACCESS_MODE_ALL, ACCESS_MODE_SELECTED, parsePairingString } from "./relay-core.js";
import { isTabSelected } from "./relay-tab-groups.js";
import { isValidTabId } from "./tab-eligibility.js";

/** Own manual/native pairing transactions and compact popup/options messages. */
export function createPopupMessageHandler({
  chromeApi = chrome,
  pairingConfigStore,
  policy,
  accessReady,
  getConfig,
  getRelayState,
  getRelayStatusHint,
  getNativeBootstrapStatus,
  enableNativeBootstrap,
  onManualPairing,
  onUnpairStart,
  isRetiredCopilotCustodyBlocked,
  requireAutomationAllowed,
  discardRetiredCopilotCustody,
  resetRelayState,
  suspendRelayConnections,
  resumeRelayConnections,
  reconcilePairingInvalidation,
  reconcileAccessMode,
  runAccessMutation,
  detachAllDebuggerSessions,
  syncTabsToRelay,
  closeRelaySocket,
  connectRelay,
  setBadge,
  detachDebugger,
  removeTabFromOpenClawGroup,
  addTabToOpenClawGroup,
  scheduleTabsSync,
  pauseTab,
}) {
  let pairingGeneration = 0;

  const assertPairingCurrent = (generation) => {
    if (generation !== pairingGeneration) {
      throw new Error("Pairing was superseded by a newer request.");
    }
  };

  async function applyPairing({
    pairing,
    pairingString,
    accessMode,
    source = "manual",
    isCurrent = () => true,
  }) {
    await requireAutomationAllowed();
    if (!isCurrent()) {
      return { ok: false };
    }
    const parsed = pairing ?? parsePairingString(pairingString);
    if (!parsed) {
      return { ok: false, error: "Invalid pairing string." };
    }
    if (source === "native" && (await getConfig()).relayUrl) {
      return { ok: false, existing: true };
    }
    if (source === "manual") {
      await onManualPairing();
    }
    if (!isCurrent()) {
      return { ok: false };
    }
    const generation = ++pairingGeneration;
    const pairingIsCurrent = () => generation === pairingGeneration && isCurrent();
    const assertCurrent = () => {
      assertPairingCurrent(generation);
      if (!isCurrent()) {
        throw new Error("Automatic pairing was canceled.");
      }
    };
    suspendRelayConnections();
    closeRelaySocket();
    await accessReady;
    if (!isCurrent()) {
      return { ok: false };
    }
    assertPairingCurrent(generation);
    return await runAccessMutation(async () => {
      if (!isCurrent()) {
        return { ok: false };
      }
      assertPairingCurrent(generation);
      if (source === "native" && (await getConfig()).relayUrl) {
        return { ok: false, existing: true };
      }
      if (!isCurrent()) {
        return { ok: false };
      }
      assertPairingCurrent(generation);
      suspendRelayConnections();
      closeRelaySocket();
      const normalizedMode =
        accessMode === ACCESS_MODE_SELECTED ? ACCESS_MODE_SELECTED : ACCESS_MODE_ALL;
      const downgrading =
        policy.mode === ACCESS_MODE_ALL && normalizedMode === ACCESS_MODE_SELECTED;
      if (downgrading) {
        policy.beginTransition();
      }
      try {
        await pairingConfigStore.save(parsed, "orange", normalizedMode);
        assertCurrent();
        await reconcileAccessMode(normalizedMode, { transitioning: downgrading });
        assertCurrent();
        policy.setEnabled(true);
        resetRelayState();
        resumeRelayConnections();
        await connectRelay(pairingIsCurrent);
        if (!pairingIsCurrent()) {
          closeRelaySocket();
          setBadge("off");
          assertCurrent();
        }
      } catch (error) {
        if (downgrading) {
          policy.endTransition();
        }
        if (source === "native" && !isCurrent()) {
          // A dispatched storage write can finish after opt-out. This serialized
          // transaction still owns that unadopted pairing, so remove it before exit.
          policy.setEnabled(false);
          closeRelaySocket();
          setBadge("off");
          await pairingConfigStore.clear();
          return { ok: false };
        }
        throw error;
      }
      return { ok: true };
    });
  }

  async function unpair() {
    pairingGeneration += 1;
    const disabledPersisted = onUnpairStart();
    policy.setEnabled(false);
    policy.invalidateAll();
    suspendRelayConnections();
    resetRelayState();
    closeRelaySocket();
    setBadge("off");
    await accessReady;
    policy.setEnabled(false);
    policy.invalidateAll();
    closeRelaySocket();
    setBadge("off");
    await runAccessMutation(async () => {
      policy.setEnabled(false);
      const detaching = detachAllDebuggerSessions();
      await syncTabsToRelay();
      await disabledPersisted;
      await pairingConfigStore.clear();
      await policy.clearDenied();
      await detaching;
      await discardRetiredCopilotCustody();
      resetRelayState();
      closeRelaySocket();
      setBadge("off");
    });
    return { ok: true };
  }

  const handler = (msg, reply) => {
    let settled = false;
    const sendResponse = (response) => {
      if (!settled) {
        settled = true;
        reply(response);
      }
    };
    void (async () => {
      try {
        switch (msg?.type) {
          case "getStatus": {
            await accessReady;
            const retiredCopilotCustodyBlocked = isRetiredCopilotCustodyBlocked();
            const nativeBootstrap = await getNativeBootstrapStatus();
            const { relayUrl, accessMode } = await getConfig();
            await reconcilePairingInvalidation();
            const accessible = await policy.listAccessibleTabs();
            const hint = getRelayStatusHint();
            return sendResponse({
              paired: Boolean(relayUrl),
              state: getRelayState(),
              accessMode,
              accessibleTabCount: accessible.length,
              relayUrl: relayUrl ?? "",
              nativeBootstrap,
              retiredCopilotCustodyBlocked,
              ...(hint ? { hint } : {}),
            });
          }
          case "pair":
            return sendResponse(
              await applyPairing({
                pairingString: msg.pairingString,
                accessMode: msg.accessMode,
                source: "manual",
              }),
            );
          case "unpair":
            return sendResponse(await unpair());
          case "setNativeBootstrapEnabled":
            if (typeof msg.enabled !== "boolean") {
              return sendResponse({ ok: false, error: "Invalid automatic setup setting." });
            }
            return sendResponse({ ok: true, result: await enableNativeBootstrap(msg.enabled) });
          case "setAccessMode": {
            if (msg.accessMode !== ACCESS_MODE_ALL && msg.accessMode !== ACCESS_MODE_SELECTED) {
              return sendResponse({ ok: false, error: "Invalid access mode." });
            }
            await requireAutomationAllowed();
            const restricting = msg.accessMode === ACCESS_MODE_SELECTED;
            if (restricting) {
              policy.beginTransition();
            }
            let storedMode;
            try {
              await accessReady;
              storedMode = await runAccessMutation(async () => {
                const mode = await pairingConfigStore.setAccessMode(msg.accessMode);
                await reconcileAccessMode(mode, { transitioning: restricting });
                return mode;
              });
            } catch (error) {
              if (restricting) {
                policy.endTransition();
              }
              throw error;
            }
            return sendResponse({ ok: true, accessMode: storedMode });
          }
          case "toggleTabAccess": {
            const tabId = msg.tabId;
            if (
              !isValidTabId(tabId) ||
              (msg.accessMode !== ACCESS_MODE_ALL && msg.accessMode !== ACCESS_MODE_SELECTED) ||
              typeof msg.grant !== "boolean"
            ) {
              return sendResponse({ ok: false, error: "Invalid tab access action." });
            }
            await accessReady;
            await requireAutomationAllowed();
            if (policy.mode !== msg.accessMode) {
              return sendResponse({
                ok: false,
                error: "Browser access mode changed. Refresh and retry.",
              });
            }
            const revocation = policy.beginRevocation(tabId);
            try {
              await runAccessMutation(async () => {
                if (policy.mode !== msg.accessMode) {
                  throw new Error("Browser access mode changed. Refresh and retry.");
                }
                if (policy.mode === ACCESS_MODE_ALL) {
                  if (msg.grant && policy.isDenied(tabId)) {
                    await policy.allow(tabId);
                  } else if (!msg.grant && !policy.isDenied(tabId)) {
                    await pauseTab(tabId);
                  }
                } else {
                  const selected = await isTabSelected(await chromeApi.tabs.get(tabId));
                  if (msg.grant !== selected) {
                    policy.invalidateTab(tabId);
                    if (!msg.grant) {
                      await detachDebugger(tabId);
                    }
                    await (msg.grant ? addTabToOpenClawGroup : removeTabFromOpenClawGroup)(tabId);
                  }
                }
                scheduleTabsSync();
                await syncTabsToRelay();
              });
            } finally {
              policy.endRevocation(revocation);
            }
            const state = await policy.inspectTab(tabId);
            return sendResponse({ ok: true, accessible: state.accessible, denied: state.denied });
          }
          case "getTabAccess": {
            await accessReady;
            const state = await policy.inspectTab(msg.tabId);
            return sendResponse({
              accessMode: policy.mode,
              accessible: state.accessible,
              eligible: state.eligible,
              denied: state.denied,
            });
          }
          default:
            sendResponse({ ok: false, error: "unknown message" });
        }
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    })();
    return true;
  };

  handler.applyPairing = applyPairing;
  return handler;
}
