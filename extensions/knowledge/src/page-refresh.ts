import { loadVocabulary } from "./inspection-client.js";
import type { Page } from "./page-context.js";
import { el, time } from "./page-dom.js";
import { countScribesOn, renderScribesTab } from "./scribes-view.js";
import { storeLabel, storeOf } from "./stores-view.js";
import { showLoadingFailure } from "./view-frame.js";

// Agent-dependent header and search copy shows once the first scope check settles.
const revealCopy = (ui: Page) => ui.root.classList.remove("knowledge-copy-pending");
// Reserved count slots that no count will fill this time.
const dropPendingCounts = (...tabs: HTMLElement[]) => {
  for (const tab of tabs) {
    tab.querySelector(".knowledge-tab-count-pending")?.remove();
  }
};

type Vocabulary = Awaited<ReturnType<typeof loadVocabulary>>;

/** Read both tab counts together: the page total from the vocabulary, Scribes once per agent.
 * A `null` vocabulary failed to load; the Scribes tab reads its own count. */
async function loadTabCounts(ui: Page, vocabularyRequest: Promise<Vocabulary | null | undefined>) {
  const { s } = ui;
  const agent = ui.viewedAgent();
  const [vocabulary, scribesOn] = await Promise.all([
    vocabularyRequest,
    s.scribesCountAgent === agent || s.tab === "scribes"
      ? undefined
      : countScribesOn(s.context.host, agent).catch(() => null),
  ]);
  return { agent, vocabulary, scribesOn };
}

// Commit both tab labels in one layout pass so the centered tabs move at most once.
function applyTabCounts(
  ui: Page,
  n: number,
  { agent, vocabulary, scribesOn }: Awaited<ReturnType<typeof loadTabCounts>>,
  ready: boolean,
) {
  const { s, browseTab, scribesTab } = ui;
  if (s.disposed || n !== s.statusGeneration) {
    return;
  }
  // A ready store whose vocabulary was not read again, or failed to load, keeps its count.
  if (vocabulary === null) {
    dropPendingCounts(browseTab);
  } else if (!ready || vocabulary) {
    browseTab.replaceChildren(document.createTextNode("Browse"));
  }
  if (vocabulary) {
    const pageCount = vocabulary.definitions.reduce((sum, d) => sum + d.recordCount, 0);
    const countBadge = el("span", pageCount.toLocaleString(), "knowledge-tab-count");
    countBadge.setAttribute("aria-hidden", "true");
    browseTab.append(countBadge);
  }
  // An unreadable count drops the reserved slot and is read again on the next check.
  if (scribesOn !== undefined) {
    renderScribesTab(scribesTab, scribesOn ?? 0);
    s.scribesCountAgent = scribesOn === null ? "" : agent;
  }
}

/** Re-check store facts and status, reset store-bound state on change, then reload or offer updates. */
export async function refreshScope(ui: Page, replaceLocation = true) {
  const {
    s,
    base,
    feature,
    root,
    content,
    status,
    banner,
    updates,
    recentBack,
    displayName,
    announce,
    viewKey,
    load,
    renderToolbar,
    renderStoreContext,
    writeLocation,
  } = ui;
  if (s.disposed) {
    return;
  }
  if (!s.context.host.connection.connected) {
    revealCopy(ui);
    dropPendingCounts(ui.browseTab, ui.scribesTab);
    ++s.statusGeneration;
    status.textContent = s.viewReady ? "Reconnecting…" : "Offline";
    status.hidden = false;
    banner.hidden = false;
    banner.textContent = `Can’t reach the vault. ${s.viewReady ? `Showing the last readable view, checked at ${s.lastChecked ? time(s.lastChecked) : "an unknown time"}. Retrying.` : "Reconnect to read your agent’s knowledge."}`;
    return;
  }
  if (s.refreshing) {
    s.refreshAgain = true;
    s.pendingReplaceLocation &&= replaceLocation;
    return;
  }
  s.refreshing = true;
  const n = ++s.statusGeneration;
  let observedGeneration = s.generation;
  try {
    // Store facts name the agent to read when several agents have no default, so status
    // starts alongside them only when its routing cannot depend on them: no agent named yet
    // (re-asked below if the facts pick one), or facts already known from an earlier check.
    // A linked agent before the first snapshot may be the default and must not be proxied.
    const viewingBefore = s.viewing,
      factsBefore = s.storesSnapshot;
    let statusRequest = !s.viewing || s.storesSnapshot ? feature.invoke("status", {}) : undefined;
    statusRequest?.catch(() => undefined);
    const stores = await base.invoke("stores_snapshot", {}).catch(() => undefined);
    if (s.disposed || n !== s.statusGeneration || !s.context.host.connection.connected) {
      return;
    }
    if (stores) {
      s.storesSnapshot = stores;
      if (!s.viewing && !stores.defaultAgent) {
        const supported = stores.agents.filter((a) => a.supported),
          selected = s.context.host.agents.selectedId;
        s.viewing = (supported.find((a) => a.id === selected)?.id ?? supported[0]?.id)!;
      }
      renderStoreContext();
    }
    // Re-ask when the facts changed the routing: a newly named agent, or a default agent that
    // differs from earlier facts. First facts naming a default keep the ordinary request.
    if (
      !statusRequest ||
      s.viewing !== viewingBefore ||
      (factsBefore && s.storesSnapshot?.defaultAgent !== factsBefore.defaultAgent)
    ) {
      statusRequest = feature.invoke("status", {});
    }
    const report = await statusRequest;
    if (s.disposed || n !== s.statusGeneration || !s.context.host.connection.connected) {
      return;
    }
    const nextIdentity = JSON.stringify([report.agent, report.vault, report.scope]);
    if (s.identity && s.identity !== nextIdentity) {
      // The viewed agent's store changed (an assignment or recovery). Never
      // show one store's content under another's label: reset store-bound
      // navigation and say what happened.
      ++s.generation;
      ++s.suggestGeneration;
      root.querySelector(".knowledge-chat-handoff")?.remove();
      if (!s.expectedVault) {
        s.selectedId = "";
        // Settings and Scribes are not store content, so they stay open; a first scribe write
        // that creates the store must not send the operator away from the scribe they watch.
        if (s.tab !== "settings" && s.tab !== "scribes") {
          s.tab = "recent";
        }
        s.offset = 0;
        s.recentCursor = undefined;
        recentBack.length = 0;
        s.browseBack = [];
      }
      s.snapshot = undefined;
      s.viewReady = false;
      s.vocabulary = undefined;
      s.retainedViews.clear();
      content.replaceChildren();
      renderToolbar();
      const entry = s.storesSnapshot && storeOf(s.storesSnapshot, report.agent);
      observedGeneration = s.generation;
      announce(
        `${displayName(report.agent)}’s knowledge store changed${entry ? ` to ${storeLabel(entry, displayName)}` : ""}.${s.expectedVault && s.expectedVault !== report.vault ? " This link still points to the original store." : " Showing it now."}`,
      );
    }
    const stateChanged = s.storeState !== report.store;
    s.scopeMismatch = Boolean(s.expectedVault && report.vault && s.expectedVault !== report.vault);
    s.scopeChecked = true;
    s.viewing = report.agent;
    if (!s.expectedVault && report.vault) {
      s.expectedVault = report.vault;
    }
    s.identity = nextIdentity;
    s.agentId = report.agent;
    s.storeState = report.store;
    s.storeMessage = report.message;
    renderStoreContext();
    revealCopy(ui);
    writeLocation(replaceLocation);
    if (stateChanged) {
      renderToolbar();
    }
    s.lastChecked = new Date().toISOString();
    status.textContent = "";
    status.hidden = true;
    banner.hidden = true;
    banner.textContent = "";
    const unchanged = Boolean(
      s.viewReady &&
      s.displayView === viewKey() &&
      report.snapshot &&
      s.snapshot === report.snapshot,
    );
    const ready = s.storeState === "ready" && !s.scopeMismatch;
    // Tab counts load beside the view. The vocabulary is read again only when content may have
    // changed; the Scribes count once per viewed agent.
    const readVocabulary = ready && (!unchanged || !s.vocabulary);
    // Views read the vocabulary as soon as it arrives, not when both counts are known.
    const vocabularyRequest = readVocabulary
      ? loadVocabulary(feature).then((vocabulary) => {
          if (!s.disposed && n === s.statusGeneration) {
            s.vocabulary = vocabulary;
          }
          return vocabulary;
        })
      : Promise.resolve(undefined);
    vocabularyRequest.catch(() => undefined);
    // Counts never fail the refresh; only the view can.
    const counts =
      readVocabulary || !ready || s.scribesCountAgent !== ui.viewedAgent()
        ? loadTabCounts(
            ui,
            vocabularyRequest.catch(() => null),
          ).then((found) => applyTabCounts(ui, n, found, ready))
        : undefined;
    const reloadView = async () => {
      if (s.disposed || n !== s.statusGeneration) {
        return;
      }
      // Scribe state lives in sessions and automations, not the vault, so the vault snapshot
      // cannot tell whether the Scribes tab is current: reload it in the background every resync.
      if (
        s.tab === "scribes" &&
        s.viewReady &&
        !s.loadingGeneration &&
        s.displayView === viewKey()
      ) {
        await load(true);
        return;
      }
      if (s.loadingGeneration || unchanged) {
        return;
      }
      if (s.storeState !== "ready") {
        if (!s.viewReady || s.displayView !== viewKey()) {
          await load();
        }
        return;
      }
      if (s.scopeMismatch) {
        await load();
        return;
      }
      // A navigation started during the check owns the screen now.
      if (s.generation !== observedGeneration || s.loadingGeneration) {
        return;
      }
      if (
        s.viewReady &&
        s.displayView === viewKey() &&
        s.tab === "recent" &&
        !s.selectedId &&
        !s.recentCursor
      ) {
        const recent = await feature.invoke("recent", { limit: 50, groupBySource: true });
        if (s.disposed || n !== s.statusGeneration || s.generation !== observedGeneration) {
          return;
        }
        const count = recent.items.filter((item) => item.sequence > s.recentSequence).length;
        s.pendingSnapshot = report.snapshot;
        updates.textContent = count
          ? `↑ ${count}${recent.nextBefore !== null ? "+" : ""} activity ${count === 1 ? "update" : "updates"} · Show`
          : "Knowledge changed · Show";
        updates.hidden = false;
        return;
      }
      if (await load(s.viewReady && s.displayView === viewKey())) {
        s.snapshot = report.snapshot;
      }
    };
    // Browse lists page types from the vocabulary, so its rows wait for it (not the counts).
    const view =
      readVocabulary && s.tab === "browse" && !s.selectedId
        ? vocabularyRequest.then(reloadView)
        : reloadView();
    await Promise.all([counts, view]);
  } catch (error) {
    revealCopy(ui);
    dropPendingCounts(ui.browseTab, ui.scribesTab);
    if (!s.disposed && n === s.statusGeneration) {
      status.textContent = "Refresh unavailable";
      status.hidden = false;
      if (!s.viewReady) {
        showLoadingFailure(ui, error, () => {
          void refreshScope(ui);
        });
      }
    }
  } finally {
    s.refreshing = false;
    if (s.refreshAgain) {
      s.refreshAgain = false;
      const replace = s.pendingReplaceLocation;
      s.pendingReplaceLocation = true;
      void refreshScope(ui, replace);
    }
  }
}
