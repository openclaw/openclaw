import {
  addTabToOpenClawGroup,
  isTabSelected as isTabInOpenClawGroup,
} from "./relay-tab-groups.js";

const EXPLICIT_SELECTED_TAB_IDS_KEY = "explicitSelectedTabIdsV1";
const EXPLICIT_SELECTED_TAB_BACKEND_KEY = "explicitSelectedTabBackendV1";
const MAX_EXPLICIT_SELECTED_TABS = 256;
const REPLACEMENT_TAB_ATTEMPTS = 8;
const REPLACEMENT_TAB_RETRY_MS = 50;

const STORAGE_ERROR = "Selected-tab storage is unavailable; no tabs were shared.";

function normalizeTabIds(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((id) => Number.isInteger(id) && id >= 0))].slice(
    0,
    MAX_EXPLICIT_SELECTED_TABS,
  );
}

/**
 * Keep Chrome's tab-group access model until the user explicitly chooses the
 * popup's compatibility sharing path. Arc and Dia do not reliably implement
 * chrome.tabGroups, so that path switches to a session-scoped tab-id ledger.
 * The persistent backend marker prevents a browser restart from widening back
 * to stale tab groups after Chromium clears the session-scoped ids.
 */
export function createSelectedTabsController({ chromeApi = chrome, getGroupColor }) {
  let explicitSelection = false;
  let backendMarkerPersisted = false;
  let selectedTabIds = new Set();
  let sessionStorageAvailable = true;
  let readyPromise;
  let mutationQueue = Promise.resolve();

  function ensureReady() {
    if (!readyPromise) {
      readyPromise = (async () => {
        const [backendResult, idsResult] = await Promise.allSettled([
          chromeApi.storage.local.get([EXPLICIT_SELECTED_TAB_BACKEND_KEY]),
          chromeApi.storage.session.get([EXPLICIT_SELECTED_TAB_IDS_KEY]),
        ]);
        if (backendResult.status === "rejected") {
          // Unknown backend state must never widen into tab-group authority.
          explicitSelection = true;
          selectedTabIds.clear();
          sessionStorageAvailable = false;
          return;
        }
        backendMarkerPersisted = backendResult.value?.[EXPLICIT_SELECTED_TAB_BACKEND_KEY] === true;
        explicitSelection = backendMarkerPersisted;
        if (idsResult.status === "rejected") {
          if (explicitSelection) {
            selectedTabIds.clear();
            sessionStorageAvailable = false;
          }
          return;
        }
        selectedTabIds = new Set(normalizeTabIds(idsResult.value?.[EXPLICIT_SELECTED_TAB_IDS_KEY]));
      })();
    }
    return readyPromise;
  }

  function mutate(operation) {
    const run = mutationQueue.then(async () => {
      await ensureReady();
      return await operation();
    });
    mutationQueue = run.catch(() => undefined);
    return run;
  }

  async function waitForMutations() {
    await ensureReady();
    await mutationQueue;
  }

  async function persist(nextIds, { allowRecovery = false } = {}) {
    if (!sessionStorageAvailable && !allowRecovery) {
      throw new Error(STORAGE_ERROR);
    }
    try {
      await chromeApi.storage.session.set({ [EXPLICIT_SELECTED_TAB_IDS_KEY]: [...nextIds] });
    } catch (error) {
      sessionStorageAvailable = false;
      selectedTabIds.clear();
      throw new Error(STORAGE_ERROR, { cause: error });
    }
    sessionStorageAvailable = true;
    selectedTabIds = nextIds;
  }

  async function enableExplicitSelection() {
    if (backendMarkerPersisted) {
      return;
    }
    try {
      await chromeApi.storage.local.set({ [EXPLICIT_SELECTED_TAB_BACKEND_KEY]: true });
    } catch (error) {
      throw new Error(STORAGE_ERROR, { cause: error });
    }
    backendMarkerPersisted = true;
    explicitSelection = true;
  }

  async function validateTab(tabId, created) {
    if (!Number.isInteger(tabId) || tabId < 0) {
      throw new Error("No valid tab to share.");
    }
    const tab = await chromeApi.tabs.get(tabId);
    created?.assertCurrent();
    if (
      created &&
      (tab.id !== created.tab.id ||
        tab.windowId !== created.tab.windowId ||
        tab.incognito !== created.tab.incognito)
    ) {
      throw new Error(`tab ${tabId} changed during creation`);
    }
    return tab;
  }

  async function validateReplacementTab(tabId) {
    let lastError;
    for (let attempt = 0; attempt < REPLACEMENT_TAB_ATTEMPTS; attempt += 1) {
      try {
        return await validateTab(tabId);
      } catch (error) {
        lastError = error;
        if (attempt + 1 < REPLACEMENT_TAB_ATTEMPTS) {
          await new Promise((resolve) => {
            setTimeout(resolve, REPLACEMENT_TAB_RETRY_MS);
          });
        }
      }
    }
    throw lastError;
  }

  async function isExplicit() {
    await waitForMutations();
    return explicitSelection;
  }

  async function has(tabId) {
    await waitForMutations();
    return explicitSelection && sessionStorageAvailable && selectedTabIds.has(tabId);
  }

  async function isSelected(tab) {
    await waitForMutations();
    if (explicitSelection) {
      return sessionStorageAvailable && selectedTabIds.has(tab?.id);
    }
    const selectedByGroup = await isTabInOpenClawGroup(tab);
    // A compatibility transition can overtake the browser API lookup. Re-read
    // the authoritative backend before returning so stale group membership can
    // never widen the newly activated session ledger.
    await waitForMutations();
    return explicitSelection
      ? sessionStorageAvailable && selectedTabIds.has(tab?.id)
      : selectedByGroup;
  }

  async function add(tabId, created) {
    await ensureReady();
    if (!explicitSelection) {
      await validateTab(tabId, created);
      await addTabToOpenClawGroup(tabId, { chromeApi, getGroupColor, created });
      return;
    }
    await mutate(async () => {
      await validateTab(tabId, created);
      if (selectedTabIds.size >= MAX_EXPLICIT_SELECTED_TABS && !selectedTabIds.has(tabId)) {
        throw new Error(`No more than ${MAX_EXPLICIT_SELECTED_TABS} tabs can be shared.`);
      }
      const previous = new Set(selectedTabIds);
      const next = new Set(previous);
      next.add(tabId);
      await persist(next);
      try {
        created?.assertCurrent();
      } catch (error) {
        try {
          await persist(previous);
        } catch {
          // persist() already cleared in-memory authority and poisoned writes.
        }
        throw error;
      }
    });
  }

  async function remove(tabId) {
    if (!Number.isInteger(tabId) || tabId < 0) {
      return;
    }
    await ensureReady();
    if (!explicitSelection) {
      try {
        await chromeApi.tabs.ungroup([tabId]);
      } catch {
        // The tab may already be gone.
      }
      return;
    }
    await mutate(async () => {
      const next = new Set(selectedTabIds);
      next.delete(tabId);
      await persist(next);
    });
  }

  async function replaceTab(addedTabId, removedTabId) {
    if (
      !Number.isInteger(addedTabId) ||
      addedTabId < 0 ||
      !Number.isInteger(removedTabId) ||
      removedTabId < 0
    ) {
      return false;
    }
    await ensureReady();
    if (!explicitSelection) {
      return false;
    }
    return await mutate(async () => {
      const wasSelected = selectedTabIds.has(removedTabId);
      const withoutRemoved = new Set(selectedTabIds);
      withoutRemoved.delete(removedTabId);
      if (wasSelected) {
        // Revoke the retired identity before waiting for Chromium to publish its
        // replacement. Readers stay behind this serialized, fail-closed mutation.
        await persist(withoutRemoved);
        await validateReplacementTab(addedTabId);
        const withReplacement = new Set(withoutRemoved);
        withReplacement.add(addedTabId);
        await persist(withReplacement);
      } else if (withoutRemoved.size !== selectedTabIds.size) {
        await persist(withoutRemoved);
      }
      return wasSelected;
    });
  }

  async function replaceWith(tabId) {
    return await mutate(async () => {
      await validateTab(tabId);
      await enableExplicitSelection();
      // One storage write is the consent boundary: readers wait behind this
      // mutation and never observe an intermediate empty or widened scope.
      await persist(new Set([tabId]), { allowRecovery: true });
    });
  }

  async function reset() {
    return await mutate(async () => {
      // Stay fail-closed until both stores confirm that the explicit backend and
      // every session-scoped grant are gone.
      explicitSelection = true;
      sessionStorageAvailable = false;
      selectedTabIds.clear();
      await chromeApi.storage.session.remove([EXPLICIT_SELECTED_TAB_IDS_KEY]);
      await chromeApi.storage.local.remove([EXPLICIT_SELECTED_TAB_BACKEND_KEY]);
      backendMarkerPersisted = false;
      explicitSelection = false;
      sessionStorageAvailable = true;
    });
  }

  return { add, has, isExplicit, isSelected, remove, replaceTab, replaceWith, reset };
}
