import { defineControlUiPlugin } from "openclaw/plugin-sdk/control-ui";
import { createFeatureClient } from "openclaw/plugin-sdk/feature-contract";
import { browse } from "./browse-view.js";
import { browserContract } from "./browser-contract.js";
import { coalesceChanges } from "./change-refresh.js";
import type { contract } from "./contract.js";
import { agentDisplayName } from "./knowledge-presentation.js";
import type { Page } from "./page-context.js";
import { button, el } from "./page-dom.js";
import { locationKey, locationParams, readLocation } from "./page-location.js";
import { refreshScope } from "./page-refresh.js";
import { createPageState, type RecentCursor } from "./page-state.js";
import { captureReadingState } from "./reading-state.js";
import { recent } from "./recent-view.js";
import { showDetail } from "./record-view.js";
import { scribes } from "./scribes-view.js";
import { temporalFilterForm, type TemporalSelection } from "./search-date-filters.js";
import { searchForm, searchResults } from "./search-view.js";
import { registerSessionPanel } from "./session-panel.js";
import { settings } from "./settings-view.js";
import { viewingClient } from "./store-view-client.js";
import { storeBar, storeLabel, storeNotice, storeOf, type SettingsSection } from "./stores-view.js";
import { icon } from "./ui-icons.js";
import { commitContent, prepareLoading, showLoadingFailure } from "./view-frame.js";
import "./control-ui.css";

export default defineControlUiPlugin({
  id: browserContract.pluginId,
  activate(host) {
    const removeSessionPanel = registerSessionPanel(host);
    const removeNavigation = host.ui.registerNavigation({
      id: "knowledge",
      label: "Knowledge",
      page: { id: "overview" },
      icon: "book",
    });
    const removePage = host.ui.registerPage({
      id: "overview",
      label: "Knowledge",
      mount(container, initialContext) {
        const s = createPageState(initialContext, readLocation(initialContext.props));
        // Store settings and the viewing selector. Every other call goes through
        // `feature`, which reads as the selected agent's effective store.
        const base = createFeatureClient<typeof contract>(browserContract, s.context.host);
        const feature = viewingClient(base, () => ({
          agent: s.viewing,
          defaultAgent: s.storesSnapshot?.defaultAgent,
        }));
        const root = el("section", undefined, "knowledge-page"),
          header = el("header", undefined, "knowledge-header"),
          title = el("div"),
          actions = el("div", undefined, "knowledge-actions");
        const subtitle = el("p");
        title.append(el("h1", "Knowledge"), subtitle);
        const status = el("span", "Connecting…", "knowledge-status");
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        const settingsButton = button("", () => openSettings("stores"), "knowledge-icon-button");
        settingsButton.setAttribute("aria-label", "Settings");
        settingsButton.title = "Stores, vocabulary and vault status";
        settingsButton.append(icon("settings"));
        actions.append(status, settingsButton);
        const storeContext = el("div", undefined, "knowledge-store-slot");
        title.append(storeContext);
        const storePlaceholder = el(
          "div",
          undefined,
          "knowledge-store-bar knowledge-store-placeholder",
        );
        storePlaceholder.setAttribute("aria-hidden", "true");
        storePlaceholder.append(
          el("span", undefined, "knowledge-skeleton"),
          el("span", undefined, "knowledge-skeleton"),
        );
        storeContext.append(storePlaceholder);
        const announcer = el("p", "", "knowledge-visually-hidden");
        announcer.setAttribute("role", "status");
        announcer.setAttribute("aria-live", "polite");
        const nav = el("nav", undefined, "knowledge-tabs");
        nav.setAttribute("aria-label", "Knowledge views");
        // These are text navigation tabs, not host .btn controls. Theme-specific
        // .btn rules otherwise reintroduce filled backgrounds in light mode.
        const recentTab = button("Recent", () => navigate("recent"), "knowledge-tab"),
          browseTab = button("Browse", () => navigate("browse"), "knowledge-tab"),
          scribesTab = button("Scribes", () => navigate("scribes"), "knowledge-tab");
        nav.append(recentTab, browseTab, scribesTab);
        const banner = el("p", "", "knowledge-notice"),
          toolbar = el("div", undefined, "knowledge-toolbar"),
          content = el("div", undefined, "knowledge-content");
        banner.hidden = true;
        header.append(title, nav, actions);
        const body = el("div", undefined, "knowledge-page-body");
        const loading = el("div", "", "knowledge-loading knowledge-muted");
        loading.hidden = true;
        loading.setAttribute("role", "status");
        loading.setAttribute("aria-live", "polite");
        body.append(banner, toolbar, loading, content);
        root.append(header, body);
        container.append(root);
        const temporalSelection = (): TemporalSelection => ({
          since: s.since,
          until: s.until,
          timeField: s.timeField,
        });
        const updates = button(
          "",
          () => {
            updates.hidden = true;
            void load(true).then((ok) => {
              if (ok) {
                s.snapshot = s.pendingSnapshot;
                s.pendingSnapshot = undefined;
              }
            });
          },
          "knowledge-new-saves",
        );
        updates.hidden = true;
        toolbar.after(updates);
        const recentBack: RecentCursor[] = [];
        const recentExpanded = new Set<number | string>();
        const agentName = (id = s.agentId) => agentDisplayName(id, s.context.host.agents.rows);
        const askLabel = () => `Ask ${agentName() ?? "your agent"}`;
        const searchPlaceholder = () =>
          `Find a person, project, or anything ${agentName() ?? "your agent"} saved…`;
        // Header copy names the configured agent; rerun when its identity or name changes.
        const renderAgentCopy = () => {
          subtitle.textContent =
            s.storesSnapshot && storeOf(s.storesSnapshot, viewedAgent())?.kind === "named"
              ? "Knowledge saved here, and where it came from."
              : `What ${agentName() ?? "your agent"} has saved, and where it came from.`;
          const input = root.querySelector<HTMLInputElement>(
            ".knowledge-search:not(.knowledge-search-compact) input",
          );
          if (input) {
            input.placeholder = searchPlaceholder();
          }
        };
        const viewKey = () =>
          JSON.stringify([
            s.viewing,
            s.expectedVault,
            s.scopeMismatch,
            s.storeState,
            s.tab,
            s.settingsSection,
            s.selectedId,
            s.scribe,
            s.kind,
            s.type,
            s.offset,
            s.includeHistory,
            s.browseQuery,
            s.originFilter,
            s.query,
            s.recentCursor,
            s.since,
            s.until,
            s.timeField,
          ]);
        const evidenceLoaders = new WeakMap<HTMLDetailsElement, () => Promise<void>>();
        const live = (n: number) =>
          !s.disposed &&
          !s.context.signal.aborted &&
          (n === s.generation || n === s.displayGeneration) &&
          s.context.host.connection.connected;
        const errorText = (error: unknown) =>
          s.context.host.redact(error instanceof Error ? error.message : String(error));
        const failure = (error: unknown) => el("p", errorText(error), "knowledge-error");
        const empty = (heading: string, text: string) => {
          const n = el("div", undefined, "knowledge-empty");
          n.append(el("h2", heading), el("p", text));
          return n;
        };
        const currentLocation = () => ({
          agent: s.viewing,
          vault: s.expectedVault,
          tab: s.tab,
          record: s.selectedId,
          scribe: s.scribe,
          section: s.settingsSection,
          kind: s.kind,
          type: s.type,
          query: s.query,
          filter: s.browseQuery,
          history: s.includeHistory,
          origin: s.originFilter,
          offset: s.offset,
          back: s.browseBack.filter((n) => n < s.offset),
          cursor: s.recentCursor,
          since: s.since,
          until: s.until,
          timeField: s.timeField,
        });
        function writeLocation(replace = false) {
          if (!s.scopeChecked) {
            return;
          }
          const state = currentLocation(),
            key = locationKey(state);
          if (s.routeKey === key) {
            return;
          }
          s.routeKey = key; // The host echoes navigation through update; do not reload twice.
          s.context.host.navigation.openPage(
            { id: "overview", params: locationParams(state) },
            { replace },
          );
        }
        function restoreLocation(props: Readonly<Record<string, string>>) {
          const next = readLocation(props),
            key = locationKey(next);
          if (key === s.routeKey) {
            return;
          }
          const sameScope =
            s.scopeChecked && next.agent === s.viewing && next.vault === s.expectedVault;
          s.routeKey = key;
          ({
            agent: s.viewing,
            vault: s.expectedVault,
            tab: s.tab,
            record: s.selectedId,
            scribe: s.scribe,
            section: s.settingsSection,
            kind: s.kind,
            type: s.type,
            query: s.query,
            filter: s.browseQuery,
            history: s.includeHistory,
            origin: s.originFilter,
            offset: s.offset,
            back: s.browseBack,
            cursor: s.recentCursor,
          } = next);
          ({ since: s.since, until: s.until, timeField: s.timeField } = next);
          ++s.generation;
          ++s.statusGeneration;
          ++s.suggestGeneration;
          s.loadingGeneration = 0;
          s.snapshot = undefined;
          s.searchSnapshot = undefined;
          recentBack.length = 0;
          recentExpanded.clear();
          updates.hidden = true;
          s.pendingSnapshot = undefined;
          root.querySelector(".knowledge-chat-handoff")?.remove();
          if (!sameScope) {
            s.scopeChecked = false;
            s.scopeMismatch = false;
            s.identity = "";
            s.vocabulary = undefined;
            s.viewReady = false;
            s.mountedScreen = "";
            content.replaceChildren();
          }
          renderToolbar();
          prepareLoading(ui, s.generation);
          if (sameScope) {
            void load();
          } else {
            void refresh();
          }
        }
        function navigate(next: typeof s.tab) {
          updates.hidden = true;
          s.pendingSnapshot = undefined;
          s.tab = next;
          s.selectedId = "";
          s.scribe = "";
          s.offset = 0;
          s.browseBack = [];
          s.recentCursor = undefined;
          recentBack.length = 0;
          renderToolbar();
          void load();
        }
        /** Applying date filters restarts search pagination. */
        function applyTemporal(next: TemporalSelection) {
          ({ since: s.since, until: s.until, timeField: s.timeField } = next);
          s.offset = 0;
          s.browseBack = [];
          s.searchSnapshot = undefined;
          renderToolbar();
          void load();
        }
        /** Host roster names first; agent IDs are never shown when a name exists. */
        const displayName = (id: string) =>
          agentDisplayName(id, s.context.host.agents.rows) ??
          s.storesSnapshot?.agents.find((a) => a.id === id)?.name ??
          id;
        const viewedAgent = () => s.viewing || s.storesSnapshot?.defaultAgent || s.agentId;
        const announce = (text: string) => {
          announcer.textContent = "";
          announcer.textContent = text;
        };
        const ui: Page = {
          s,
          base,
          feature,
          root,
          content,
          loading,
          status,
          banner,
          announcer,
          updates,
          browseTab,
          scribesTab,
          recentBack,
          recentExpanded,
          evidenceLoaders,
          live,
          errorText,
          failure,
          empty,
          agentName,
          askLabel,
          searchPlaceholder,
          displayName,
          viewedAgent,
          announce,
          viewKey,
          open,
          load,
          refresh,
          renderToolbar,
          renderStoreContext,
          navigate,
          openSettings,
          writeLocation,
          temporalSelection,
        };
        function openSettings(section: SettingsSection) {
          s.settingsSection = section;
          navigate("settings");
        }
        function renderStoreContext() {
          const signature = JSON.stringify([
            s.storesSnapshot,
            viewedAgent(),
            s.storesSnapshot?.agents.map((agent) => displayName(agent.id)),
          ]);
          if (signature !== s.storeContextSignature) {
            s.storeContextSignature = signature;
            storeContext.replaceChildren();
            if (s.storesSnapshot?.agents.length) {
              storeContext.append(
                storeBar(s.storesSnapshot, viewedAgent(), displayName, selectAgent, () =>
                  openSettings("stores"),
                ),
              );
            }
          }
          renderAgentCopy();
        }
        /** Switch the viewed agent. Store-bound state resets; nothing is provisioned. */
        function selectAgent(agent: string) {
          if (agent === viewedAgent()) {
            return;
          }
          ++s.statusGeneration;
          s.loadingGeneration = 0;
          s.viewing = agent;
          s.expectedVault = "";
          s.scopeChecked = false;
          s.scopeMismatch = false;
          s.identity = "";
          s.snapshot = undefined;
          ++s.generation;
          ++s.suggestGeneration;
          s.viewReady = false;
          s.vocabulary = undefined;
          s.browseBack = [];
          root.querySelector(".knowledge-chat-handoff")?.remove();
          content.replaceChildren();
          const entry = s.storesSnapshot && storeOf(s.storesSnapshot, agent);
          announce(
            `Viewing ${displayName(agent)}’s knowledge${entry ? `: ${storeLabel(entry, displayName)}` : ""}.`,
          );
          renderStoreContext();
          s.tab = s.tab === "settings" || s.tab === "scribes" ? s.tab : "recent";
          s.selectedId = "";
          s.scribe = "";
          s.offset = 0;
          s.recentCursor = undefined;
          recentBack.length = 0;
          renderToolbar();
          s.mountedScreen = "";
          prepareLoading(ui, s.generation);
          void refresh(false);
        }
        function open(id: string) {
          if (s.tab === "settings" || s.tab === "scribes") {
            s.tab = "browse";
          }
          updates.hidden = true;
          s.pendingSnapshot = undefined;
          s.selectedId = id;
          renderToolbar();
          void load();
        }
        function renderToolbar() {
          recentTab.setAttribute("aria-pressed", String(!s.selectedId && s.tab === "recent"));
          browseTab.setAttribute("aria-pressed", String(!s.selectedId && s.tab === "browse"));
          scribesTab.setAttribute("aria-pressed", String(s.tab === "scribes"));
          toolbar.replaceChildren();
          ++s.suggestGeneration;
          clearTimeout(s.timer);
          // Nothing to search until the viewed store is ready.
          if (
            s.selectedId ||
            s.tab === "settings" ||
            s.tab === "scribes" ||
            s.tab === "browse" ||
            s.storeState !== "ready"
          ) {
            return;
          }
          toolbar.append(searchForm(ui));
          if (s.tab === "search") {
            toolbar.append(temporalFilterForm(temporalSelection(), applyTemporal));
          }
        }

        async function load(background = false): Promise<boolean> {
          if (s.disposed) {
            return false;
          }
          if (!s.scopeChecked) {
            prepareLoading(ui, s.generation);
            void refresh();
            return false;
          }
          writeLocation();
          const n = ++s.generation,
            nextView = viewKey(),
            nextScreen = JSON.stringify([s.tab, s.selectedId]);
          if (!s.context.host.connection.connected) {
            void refresh();
            return false;
          }
          if (!background) {
            s.connectionPages = 1;
          }
          // Stage incoming data while the destination frame stays mounted.
          // Same-view requests retain readable rows until the newest response commits.
          const target = el("div");
          s.staging = target;
          s.loadingGeneration = n;
          if (!background) {
            prepareLoading(ui, n);
          }
          try {
            await (async () => {
              if (s.scopeMismatch) {
                target.replaceChildren(
                  empty(
                    "This link belongs to a different knowledge store",
                    "The selected agent no longer uses the store named in this link. No page from another store has been opened.",
                  ),
                  button("Open current store", () => {
                    s.expectedVault = "";
                    s.scopeChecked = false;
                    s.scopeMismatch = false;
                    s.selectedId = "";
                    s.tab = "recent";
                    s.offset = 0;
                    s.recentCursor = undefined;
                    void refresh(false);
                  }),
                );
                return;
              }
              if (s.tab === "settings") {
                return await settings(ui, n, target);
              }
              // Scribes are conversations and automations, readable before the store exists.
              if (s.tab === "scribes") {
                return await scribes(ui, n, target);
              }
              // A store that isn't ready has nothing to read; say why instead.
              if (s.storeState !== "ready") {
                target.replaceChildren(
                  storeNotice(
                    s.storesSnapshot && viewedAgent()
                      ? storeOf(s.storesSnapshot, viewedAgent())
                      : undefined,
                    s.storeState,
                    s.storeMessage,
                    agentName() ?? "your agent",
                    displayName,
                    () => openSettings("stores"),
                    () => void refresh(),
                  ),
                );
                return;
              }
              if (s.selectedId) {
                return await showDetail(ui, s.selectedId, n, target, s.connectionPages, background);
              }
              if (s.tab === "recent") {
                return await recent(ui, n, target);
              }
              if (s.tab === "browse") {
                return await browse(ui, n, target);
              }
              return await searchResults(ui, n, target);
            })();
            if (!live(n) || n !== s.generation) {
              return false;
            }
            if (background) {
              // Read state after the requests: interactions while checking still win.
              let reading = captureReadingState(content);
              const retained = new Map(
                [...content.querySelectorAll<HTMLElement>("[data-preserve-signature]")].map(
                  (node) => [node.dataset.readingKey, node],
                ),
              );
              const reusable = (node: HTMLElement) => {
                const old = retained.get(node.dataset.readingKey);
                return old?.dataset.preserveSignature === node.dataset.preserveSignature
                  ? old
                  : undefined;
              };
              await Promise.all(
                [...target.querySelectorAll<HTMLDetailsElement>(".knowledge-claim > details")]
                  .filter((node) => reading.expanded(node) && !reusable(node.parentElement!))
                  .map((node) => evidenceLoaders.get(node)?.() ?? Promise.resolve()),
              );
              if (!live(n) || n !== s.generation) {
                return false;
              }
              reading = captureReadingState(content);
              for (const node of target.querySelectorAll<HTMLElement>(
                "[data-preserve-signature]",
              )) {
                const old = reusable(node);
                if (old) {
                  node.replaceWith(old);
                }
              }
              commitContent(ui, target);
              reading.restore(content);
            } else {
              const reading = captureReadingState(content);
              commitContent(ui, target);
              // Preserve list-option focus, but never carry a collapsed preview
              // into a standalone detail where evidence is open by default.
              if (s.displayScreen === nextScreen) {
                reading.restore(content);
              }
            }
            s.displayGeneration = n;
            s.displayView = nextView;
            s.displayScreen = nextScreen;
            s.viewReady = true;
            return true;
          } catch (error) {
            if (live(n) && n === s.generation) {
              if (background) {
                status.textContent = "Refresh unavailable";
                status.hidden = false;
              } else {
                showLoadingFailure(ui, error, () => {
                  void load();
                });
              }
            }
            return false;
          } finally {
            if (s.staging === target) {
              s.staging = undefined;
            }
            if (s.loadingGeneration === n) {
              s.loadingGeneration = 0;
              content.removeAttribute("aria-busy");
              if (!loading.querySelector(".knowledge-error")) {
                loading.hidden = true;
              }
            }
          }
        }
        function refresh(replaceLocation?: boolean) {
          return refreshScope(ui, replaceLocation);
        }
        let connected = s.context.host.connection.connected;
        const rosterKey = () =>
          JSON.stringify(
            s.context.host.agents.rows.map((agent) => [agent.id, agent.name, agent.identity?.name]),
          );
        let names = rosterKey();
        const unsubscribe = s.context.host.subscribe(() => {
          const nextNames = rosterKey(),
            namesChanged = names !== nextNames;
          names = nextNames;
          if (namesChanged) {
            renderAgentCopy();
          }
          if (namesChanged && s.viewReady && connected) {
            root.querySelector(".knowledge-chat-handoff")?.remove();
            void load(true);
          }
          if (connected !== s.context.host.connection.connected) {
            connected = s.context.host.connection.connected;
            ++s.suggestGeneration;
            toolbar.querySelector(".knowledge-suggestions")?.replaceChildren();
            void refresh();
          }
        });
        const changes = coalesceChanges(
          () => void refresh(),
          () => s.context.presented,
        );
        const unwatch = feature.on("changed", changes.changed);
        const resync = setInterval(() => {
          if (s.context.host.connection.connected && changes.active()) {
            void refresh();
          }
        }, 30000);
        const focusSearch = (event: KeyboardEvent) => {
          if (
            event.key !== "/" ||
            event.ctrlKey ||
            event.metaKey ||
            event.altKey ||
            event.target instanceof HTMLInputElement ||
            event.target instanceof HTMLTextAreaElement ||
            (event.target instanceof HTMLElement && event.target.isContentEditable)
          ) {
            return;
          }
          const input = root.querySelector<HTMLInputElement>("input[type=search]");
          if (input) {
            event.preventDefault();
            input.focus();
          }
        };
        document.addEventListener("keydown", focusSearch);
        renderToolbar();
        renderAgentCopy();
        prepareLoading(ui, s.generation);
        void refresh();
        return {
          update(next) {
            s.context = next;
            restoreLocation(next.props);
            changes.resume();
          },
          dispose() {
            document.removeEventListener("keydown", focusSearch);
            s.disposed = true;
            changes.dispose();
            ++s.generation;
            ++s.statusGeneration;
            ++s.suggestGeneration;
            clearTimeout(s.timer);
            clearInterval(resync);
            unwatch();
            unsubscribe();
            root.remove();
          },
        };
      },
    });
    return () => {
      removeSessionPanel();
      removePage();
      removeNavigation();
    };
  },
});
