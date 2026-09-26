import { formatErrorMessage as formatSharedErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { QaBusStateSnapshot } from "openclaw/plugin-sdk/qa-channel-protocol";
import { defaultQaModelForMode, isQaFastModeEnabled } from "../../model-selection.js";
import { normalizeCaptureSavedView, normalizeCaptureSavedViews } from "./capture-saved-view.js";
import { getJson, getJsonNoStore, postJson, QaLabHttpError } from "./http.js";
import { conversationSelectionKey, findConversationBySelectionKey } from "./ui-conversation-key.js";
import { captureEventKey } from "./ui-render-capture-events.js";
import { redactSensitiveText } from "./ui-render-capture-redaction.js";
import { captureRenderState, restoreRenderState } from "./ui-render-state.js";
import {
  type Bootstrap,
  type EvidenceEnvelope,
  type OutcomesEnvelope,
  type ReportEnvelope,
  type RunnerResolvedPlan,
  type RunnerSelection,
  type CaptureEventsEnvelope,
  type CaptureCoverageEnvelope,
  type CaptureQueryEnvelope,
  type CaptureSessionsEnvelope,
  type CaptureStartupStatusEnvelope,
  type CaptureSavedView,
  type UiState,
  renderQaLabUi,
} from "./ui-render.js";
import { stateFingerprint } from "./ui-state-fingerprint.js";
import { bindTabNavigation } from "./ui-tab-navigation.js";

function formatErrorMessage(error: unknown): string {
  return redactSensitiveText(formatSharedErrorMessage(error));
}

function countCaptureDimension(
  events: UiState["captureEvents"],
  pick: (event: UiState["captureEvents"][number]) => string | undefined,
) {
  const counts = new Map<string, number>();
  for (const event of events) {
    const value = pick(event)?.trim();
    if (!value) {
      continue;
    }
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ value, count }))
    .toSorted((left, right) => right.count - left.count || left.value.localeCompare(right.value));
}

function summarizeCaptureCoverageFromEvents(
  sessionIds: string[],
  events: UiState["captureEvents"],
): UiState["captureCoverage"] {
  const unlabeledEventCount = events.filter(
    (event) => !event.provider?.trim() && !event.api?.trim() && !event.model?.trim(),
  ).length;
  return {
    sessionId: sessionIds.join(","),
    totalEvents: events.length,
    unlabeledEventCount,
    providers: countCaptureDimension(events, (event) => event.provider),
    apis: countCaptureDimension(events, (event) => event.api),
    models: countCaptureDimension(events, (event) => event.model),
    hosts: countCaptureDimension(events, (event) => event.host),
    localPeers: countCaptureDimension(events, (event) => {
      const host = event.host?.trim();
      return host && /^(127\.0\.0\.1|localhost)(:\d+)?$/i.test(host) ? host : undefined;
    }),
  };
}

function defaultModelsForProviderMode(
  mode: RunnerSelection["providerMode"],
  bootstrap?: Bootstrap | null,
): Pick<RunnerSelection, "primaryModel" | "alternateModel" | "fastMode"> {
  const preferredLiveModel = bootstrap?.runnerCatalog.real[0]?.key;
  if (mode === "live-frontier") {
    const primaryModel = defaultQaModelForMode(mode, { preferredLiveModel });
    const alternateModel = defaultQaModelForMode(mode, { alternate: true, preferredLiveModel });
    return {
      primaryModel,
      alternateModel,
      fastMode: isQaFastModeEnabled({ primaryModel, alternateModel }),
    };
  }
  const primaryModel = defaultQaModelForMode(mode);
  const alternateModel = defaultQaModelForMode(mode, { alternate: true });
  return {
    primaryModel,
    alternateModel,
    fastMode: isQaFastModeEnabled({ primaryModel, alternateModel }),
  };
}

function cloneRunnerSelection(selection: RunnerSelection): RunnerSelection {
  return {
    ...selection,
    runtimePair: selection.runtimePair ? [...selection.runtimePair] : null,
    scenarioIds: selection.scenarioIds ? [...selection.scenarioIds] : null,
  };
}

function detectTheme(): "light" | "dark" {
  const stored = localStorage.getItem("qa-lab-theme");
  if (stored === "light" || stored === "dark") {
    return stored;
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function detectSidebarCollapsed(): boolean {
  return localStorage.getItem("qa-lab-sidebar-collapsed") === "1";
}

function detectSidebarPanel(): UiState["sidebarPanel"] {
  const stored = localStorage.getItem("qa-lab-sidebar-panel");
  return stored === "config" || stored === "run" ? stored : "scenarios";
}

const CAPTURE_SAVED_VIEWS_KEY = "qa-lab-capture-saved-views";

function loadCaptureSavedViews(): CaptureSavedView[] {
  try {
    const raw = localStorage.getItem(CAPTURE_SAVED_VIEWS_KEY);
    if (!raw) {
      return [];
    }
    return normalizeCaptureSavedViews(JSON.parse(raw) as unknown);
  } catch {
    return [];
  }
}

function persistCaptureSavedViews(savedViews: CaptureSavedView[]) {
  localStorage.setItem(
    CAPTURE_SAVED_VIEWS_KEY,
    JSON.stringify(normalizeCaptureSavedViews(savedViews)),
  );
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  return (
    target.isContentEditable ||
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

function createCaptureFilters() {
  return {
    captureKindFilter: [],
    captureProviderFilter: [],
    captureHostFilter: [],
    captureSearchText: "",
    captureHeaderMode: "key",
    captureViewMode: "list",
    captureGroupMode: "none",
    captureTimelineLaneMode: "domain",
    captureTimelineLaneSort: "most-events",
    captureTimelinePreviousLaneSort: null,
    captureTimelineLaneSearch: "",
    captureTimelineZoom: 100,
    captureTimelineSparklineMode: "session-relative",
    captureTimelineWindowStartPct: null,
    captureTimelineWindowEndPct: null,
    captureTimelineBrushAnchorPct: null,
    captureTimelineBrushCurrentPct: null,
    captureTimelineFocusSelectedFlow: false,
    captureTimelineFocusedLaneMode: "all",
    captureTimelineFocusedLaneThreshold: "any",
    captureErrorsOnly: false,
    captureCollapsedLaneIds: [],
    capturePinnedLaneIds: [],
    selectedCaptureEventKey: null,
  } satisfies Partial<UiState>;
}

export async function createQaLabApp(root: HTMLDivElement) {
  const initialUrl = new URL(window.location.href);
  const initialEvidencePath =
    initialUrl.searchParams.get("evidencePath")?.trim() ||
    initialUrl.searchParams.get("path")?.trim() ||
    "";
  const state: UiState = {
    ...createCaptureFilters(),
    theme: detectTheme(),
    bootstrap: null,
    snapshot: null,
    latestReport: null,
    scenarioRun: null,
    captureSessions: [],
    captureEvents: [],
    captureQueryPreset: "none",
    captureQueryRows: [],
    captureDetailPlacement: "right",
    captureDetailSplitPct: 34,
    captureDetailSplitDragging: false,
    captureDetailView: "overview",
    capturePreferredDetailView: null,
    captureFlowDetailLayout: null,
    capturePayloadDetailLayout: null,
    capturePayloadExtent: "preview",
    capturePayloadEventSort: "stream",
    capturePayloadEventFilter: "",
    captureCoverage: null,
    captureStartupStatus: null,
    evidence: null,
    evidenceArtifactFilter: "all",
    evidenceError: null,
    evidenceLoading: false,
    evidencePathDraft: initialEvidencePath,
    evidenceSearchText: "",
    evidenceStatusFilter: "all",
    captureControlsExpanded: false,
    captureSummaryExpanded: false,
    captureSavedViews: loadCaptureSavedViews(),
    captureSelectedSessionsExpanded: false,
    sidebarCollapsed: detectSidebarCollapsed(),
    sidebarPanel: detectSidebarPanel(),
    selectedCaptureSessionIds: [],
    selectedEvidenceEntryKey: null,
    selectedConversationKey: null,
    selectedThreadId: null,
    selectedScenarioId: null,
    activeTab: initialUrl.pathname === "/evidence" || initialEvidencePath ? "evidence" : "chat",
    runnerDraft: null,
    runnerDraftDirty: false,
    runnerPlanOverride: null,
    composer: {
      conversationKind: "direct",
      conversationId: "alice",
      senderId: "alice",
      senderName: "Alice",
      text: "",
    },
    busy: false,
    error: null,
  };

  /* Track whether user has scrolled up in the chat */
  let chatScrollLocked = true;
  let previousMessageCount = 0;

  let lastFingerprint = "";
  let renderDeferred = false;
  let previousRunnerStatus: string | null = null;
  let currentUiVersion: string | null = null;
  let syncingCaptureTimelineScroll = false;
  let sparklineSweepActive = false;
  let sparklineSweepAnchorStartPct: number | null = null;
  let sparklineSweepAnchorEndPct: number | null = null;
  let sparklineSweepCurrentStartPct: number | null = null;
  let sparklineSweepCurrentEndPct: number | null = null;
  let captureGlobalListenersBound = false;

  function isSelectOpen(): boolean {
    const active = document.activeElement;
    return active !== null && root.contains(active) && active.tagName === "SELECT";
  }

  async function refresh() {
    try {
      const [bootstrap, snapshot, report, outcomes] = await Promise.all([
        getJson<Bootstrap>("/api/bootstrap"),
        getJson<QaBusStateSnapshot>("/api/state"),
        getJson<ReportEnvelope>("/api/report"),
        getJson<OutcomesEnvelope>("/api/outcomes"),
      ]);
      state.bootstrap = bootstrap;
      state.snapshot = snapshot;
      state.latestReport = report.report ?? bootstrap.latestReport;
      state.scenarioRun = outcomes.run;
      if (!state.evidencePathDraft.trim() && bootstrap.runner.artifacts?.evidencePath) {
        state.evidencePathDraft = bootstrap.runner.artifacts.evidencePath;
      }
      if (!state.runnerDraft || !state.runnerDraftDirty) {
        state.runnerDraft = cloneRunnerSelection(bootstrap.runner.selection);
        state.runnerDraftDirty = false;
      }
      if (!state.selectedConversationKey) {
        const firstConversation = snapshot.conversations[0];
        state.selectedConversationKey = firstConversation
          ? conversationSelectionKey(firstConversation)
          : null;
      }
      if (!state.selectedScenarioId) {
        state.selectedScenarioId = bootstrap.scenarios[0]?.id ?? null;
      }
      if (!state.composer.conversationId) {
        state.composer = {
          ...state.composer,
          conversationKind: bootstrap.defaults.conversationKind,
          conversationId: bootstrap.defaults.conversationId,
          senderId: bootstrap.defaults.senderId,
          senderName: bootstrap.defaults.senderName,
        };
      }
      state.error = null;
    } catch (error) {
      state.error = formatErrorMessage(error);
    }

    try {
      const sessions = await getJson<CaptureSessionsEnvelope>("/api/capture/sessions");
      const startupStatusPromise = getJson<CaptureStartupStatusEnvelope>(
        "/api/capture/startup-status",
      );
      state.captureSessions = sessions.sessions;
      const availableSessionIds = new Set(sessions.sessions.map((session) => session.id));
      state.selectedCaptureSessionIds = state.selectedCaptureSessionIds.filter((id) =>
        availableSessionIds.has(id),
      );
      if (state.selectedCaptureSessionIds.length === 0) {
        state.selectedCaptureSessionIds = sessions.sessions[0]?.id ? [sessions.sessions[0].id] : [];
      }
      const startupStatusResult = await Promise.allSettled([startupStatusPromise]);
      state.captureStartupStatus =
        startupStatusResult[0]?.status === "fulfilled" ? startupStatusResult[0].value.status : null;
      if (state.selectedCaptureSessionIds.length > 0) {
        const eventsPromises = state.selectedCaptureSessionIds.map((sessionId) =>
          getJson<CaptureEventsEnvelope>(
            `/api/capture/events?sessionId=${encodeURIComponent(sessionId)}`,
          ),
        );
        const singleSessionId =
          state.selectedCaptureSessionIds.length === 1 ? state.selectedCaptureSessionIds[0] : null;
        const coveragePromise = singleSessionId
          ? getJson<CaptureCoverageEnvelope>(
              `/api/capture/coverage?sessionId=${encodeURIComponent(singleSessionId)}`,
            )
          : Promise.resolve<CaptureCoverageEnvelope | null>(null);
        const queryPromise =
          state.captureQueryPreset === "none"
            ? Promise.resolve<CaptureQueryEnvelope>({ rows: [] })
            : singleSessionId
              ? getJson<CaptureQueryEnvelope>(
                  `/api/capture/query?sessionId=${encodeURIComponent(
                    singleSessionId,
                  )}&preset=${encodeURIComponent(state.captureQueryPreset)}`,
                )
              : Promise.resolve<CaptureQueryEnvelope>({ rows: [] });
        const [eventsResult, coverageResult, queryResult] = await Promise.allSettled([
          Promise.all(eventsPromises),
          coveragePromise,
          queryPromise,
        ]);
        if (eventsResult.status !== "fulfilled") {
          throw eventsResult.reason;
        }
        state.captureEvents = eventsResult.value
          .flatMap((envelope) => envelope.events)
          .toSorted(
            (left, right) =>
              right.ts - left.ts || String(right.id ?? "").localeCompare(String(left.id ?? "")),
          );
        state.captureCoverage =
          coverageResult.status === "fulfilled" && coverageResult.value
            ? coverageResult.value.coverage
            : summarizeCaptureCoverageFromEvents(
                state.selectedCaptureSessionIds,
                state.captureEvents,
              );
        state.captureQueryRows = queryResult.status === "fulfilled" ? queryResult.value.rows : [];
        if (
          !state.selectedCaptureEventKey ||
          !state.captureEvents.some(
            (event) => captureEventKey(event) === state.selectedCaptureEventKey,
          )
        ) {
          const first = state.captureEvents[0];
          state.selectedCaptureEventKey = first ? captureEventKey(first) : null;
        }
      } else {
        state.captureEvents = [];
        state.captureCoverage = null;
        state.captureQueryRows = [];
        state.selectedCaptureEventKey = null;
      }
    } catch (error) {
      state.error = formatErrorMessage(error);
    }

    /* Auto-switch to chat when a run starts so user can watch live */
    const currentRunnerStatus = state.bootstrap?.runner.status ?? null;
    if (currentRunnerStatus === "running" && previousRunnerStatus !== "running") {
      state.activeTab = "chat";
      chatScrollLocked = true;
    }
    previousRunnerStatus = currentRunnerStatus;

    /* Only re-render when data actually changed; defer if a <select> is open */
    const fp = stateFingerprint(state);
    if (fp !== lastFingerprint) {
      lastFingerprint = fp;
      renderDeferred = true;
    }
    if (renderDeferred && !isSelectOpen()) {
      renderDeferred = false;
      render();
    }
  }

  async function pollUiVersion() {
    if (document.visibilityState === "hidden") {
      return;
    }
    try {
      const payload = await getJsonNoStore<{ version: string | null }>("/api/ui-version");
      if (!currentUiVersion) {
        currentUiVersion = payload.version;
        return;
      }
      if (payload.version && payload.version !== currentUiVersion) {
        window.location.reload();
      }
    } catch {
      // Ignore transient rebuild windows while the dist dir is being rewritten.
    }
  }

  function updateRunnerDraft(mutator: (draft: RunnerSelection) => RunnerSelection) {
    const fallback = state.bootstrap?.runner.selection;
    if (!state.runnerDraft && fallback) {
      state.runnerDraft = cloneRunnerSelection(fallback);
    }
    if (!state.runnerDraft) {
      return;
    }
    state.runnerDraft = mutator(state.runnerDraft);
    state.runnerDraftDirty = true;
    state.runnerPlanOverride = null;
    render();
  }

  async function runBusyAction(action: () => Promise<void>) {
    state.busy = true;
    render();
    try {
      await action();
    } catch (error) {
      state.error = formatErrorMessage(error);
      render();
    } finally {
      state.busy = false;
      render();
    }
  }

  async function runSelfCheck() {
    state.error = null;
    await runBusyAction(async () => {
      const result = await postJson<{ report: string; outputPath: string }>(
        "/api/scenario/self-check",
        {},
      );
      state.latestReport = {
        outputPath: result.outputPath,
        markdown: result.report,
        generatedAt: new Date().toISOString(),
      };
      state.activeTab = "report";
      await refresh();
    });
  }

  async function resetState() {
    await runBusyAction(async () => {
      await postJson("/api/reset", {});
      state.latestReport = null;
      state.selectedThreadId = null;
      await refresh();
    });
  }

  async function sendInbound() {
    const conversationId = state.composer.conversationId.trim();
    const text = state.composer.text.trim();
    if (!conversationId || !text) {
      state.error = "Conversation id and text are required.";
      render();
      return;
    }
    state.error = null;
    await runBusyAction(async () => {
      const selectedConversation = findConversationBySelectionKey(
        state.snapshot?.conversations ?? [],
        state.selectedConversationKey,
      );
      const accountId = selectedConversation?.accountId ?? "default";
      const selectedThreadId =
        selectedConversation?.id === conversationId &&
        selectedConversation.kind === state.composer.conversationKind
          ? state.selectedThreadId
          : null;
      await postJson("/api/inbound/message", {
        accountId,
        conversation: {
          id: conversationId,
          kind: state.composer.conversationKind,
          ...(state.composer.conversationKind !== "direct" ? { title: conversationId } : {}),
        },
        senderId: state.composer.senderId.trim() || "alice",
        senderName: state.composer.senderName.trim() || undefined,
        text,
        ...(selectedThreadId ? { threadId: selectedThreadId } : {}),
      });
      state.selectedConversationKey = conversationSelectionKey({
        accountId,
        id: conversationId,
        kind: state.composer.conversationKind,
      });
      state.selectedThreadId = selectedThreadId;
      state.composer.text = "";
      chatScrollLocked = true;
      await refresh();
    });
  }

  async function runSuite() {
    if (!state.runnerDraft) {
      state.error = "Runner selection not ready yet.";
      render();
      return;
    }
    state.busy = true;
    state.error = null;
    render();
    try {
      const result = await postJson<{ runner: { selection: RunnerSelection } }>(
        "/api/scenario/suite",
        {
          profile: state.runnerDraft.profile,
          channel: state.runnerDraft.channel,
          channelDriver: state.runnerDraft.channelDriver,
          evidenceMode: state.runnerDraft.evidenceMode,
          providerMode: state.runnerDraft.providerMode,
          primaryModel: state.runnerDraft.primaryModel,
          alternateModel: state.runnerDraft.alternateModel,
          fastMode: state.runnerDraft.fastMode,
          runtimePair: state.runnerDraft.runtimePair,
          runtimePairLane: state.runnerDraft.runtimePairLane,
          scenarioIds: state.runnerDraft.scenarioIds,
        },
      );
      state.runnerDraft = cloneRunnerSelection(result.runner.selection);
      state.runnerDraftDirty = false;
      state.runnerPlanOverride = null;
      state.activeTab = "chat";
      await refresh();
    } catch (error) {
      if (error instanceof QaLabHttpError) {
        const plan = (error.payload as { plan?: RunnerResolvedPlan } | null)?.plan;
        if (plan) {
          state.runnerPlanOverride = plan;
          state.sidebarPanel = "run";
        }
      }
      state.error = formatErrorMessage(error);
      render();
    } finally {
      state.busy = false;
      render();
    }
  }

  async function loadEvidence(pathOverride?: string) {
    const evidencePath = (pathOverride ?? state.evidencePathDraft).trim();
    if (!evidencePath) {
      state.evidenceError = "Evidence path is required.";
      render();
      return;
    }
    state.evidenceLoading = true;
    state.evidenceError = null;
    render();
    try {
      const payload = await getJson<EvidenceEnvelope>(
        `/api/evidence?path=${encodeURIComponent(evidencePath)}`,
      );
      state.evidence = payload.evidence;
      state.evidencePathDraft = payload.evidence?.evidencePath ?? evidencePath;
      state.selectedEvidenceEntryKey = payload.evidence?.entries[0]?.key ?? null;
      const url = new URL(window.location.href);
      url.pathname = "/evidence";
      url.searchParams.set("path", state.evidencePathDraft);
      window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    } catch (error) {
      state.evidence = null;
      state.selectedEvidenceEntryKey = null;
      state.evidenceError = formatErrorMessage(error);
    } finally {
      state.evidenceLoading = false;
      render();
    }
  }

  async function sendKickoff() {
    state.error = null;
    await runBusyAction(async () => {
      await postJson("/api/kickoff", {});
      state.activeTab = "chat";
      chatScrollLocked = true;
      await refresh();
    });
  }

  function downloadReport() {
    if (!state.latestReport?.markdown) {
      return;
    }
    const blob = new Blob([state.latestReport.markdown], { type: "text/markdown;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = "qa-report.md";
    anchor.click();
    URL.revokeObjectURL(href);
  }

  function toggleTheme() {
    state.theme = state.theme === "dark" ? "light" : "dark";
    localStorage.setItem("qa-lab-theme", state.theme);
    render();
  }

  function toggleSidebar() {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    localStorage.setItem("qa-lab-sidebar-collapsed", state.sidebarCollapsed ? "1" : "0");
    render();
  }

  function setSidebarPanel(panel: UiState["sidebarPanel"]) {
    state.sidebarPanel = panel;
    localStorage.setItem("qa-lab-sidebar-panel", panel);
    if (state.sidebarCollapsed) {
      state.sidebarCollapsed = false;
      localStorage.setItem("qa-lab-sidebar-collapsed", "0");
    }
    render();
  }

  function applyCaptureSavedView(view: CaptureSavedView) {
    const normalized = normalizeCaptureSavedView(view);
    if (!normalized) {
      return;
    }
    state.selectedCaptureSessionIds = [...normalized.sessionIds];
    state.captureKindFilter = [...normalized.kindFilter];
    state.captureProviderFilter = [...normalized.providerFilter];
    state.captureHostFilter = [...normalized.hostFilter];
    state.captureSearchText = normalized.searchText;
    state.captureHeaderMode = normalized.headerMode;
    state.captureViewMode = normalized.viewMode;
    state.captureGroupMode = normalized.groupMode;
    state.captureTimelineLaneMode = normalized.timelineLaneMode;
    state.captureTimelineLaneSort = normalized.timelineLaneSort;
    state.captureTimelineZoom = normalized.timelineZoom;
    state.captureTimelineSparklineMode = normalized.timelineSparklineMode;
    state.captureErrorsOnly = normalized.errorsOnly;
    state.captureDetailPlacement = normalized.detailPlacement;
    state.capturePayloadDetailLayout = normalized.payloadLayout;
    state.capturePayloadExtent = normalized.payloadExtent;
    state.selectedCaptureEventKey = null;
  }

  function buildCaptureSavedView(name: string): CaptureSavedView {
    return {
      id: crypto.randomUUID(),
      name,
      sessionIds: [...state.selectedCaptureSessionIds],
      kindFilter: [...state.captureKindFilter],
      providerFilter: [...state.captureProviderFilter],
      hostFilter: [...state.captureHostFilter],
      searchText: state.captureSearchText,
      headerMode: state.captureHeaderMode,
      viewMode: state.captureViewMode,
      groupMode: state.captureGroupMode,
      timelineLaneMode: state.captureTimelineLaneMode,
      timelineLaneSort: state.captureTimelineLaneSort,
      timelineZoom: state.captureTimelineZoom,
      timelineSparklineMode: state.captureTimelineSparklineMode,
      errorsOnly: state.captureErrorsOnly,
      detailPlacement: state.captureDetailPlacement,
      payloadLayout: state.capturePayloadDetailLayout,
      payloadExtent: state.capturePayloadExtent,
    };
  }

  function trackChatScroll() {
    const el = root.querySelector<HTMLElement>("#chat-messages");
    if (!el) {
      return;
    }
    el.addEventListener("scroll", () => {
      const threshold = 40;
      chatScrollLocked = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    });
  }

  function scrollChatToBottom(force?: boolean) {
    const el = root.querySelector<HTMLElement>("#chat-messages");
    if (!el) {
      return;
    }
    const newCount = state.snapshot?.messages.length ?? 0;
    if (force || (chatScrollLocked && newCount !== previousMessageCount)) {
      el.scrollTop = el.scrollHeight;
    }
    previousMessageCount = newCount;
  }

  function bindEvents() {
    const bindValue = (
      selector: string,
      event: "input" | "change",
      handleValue: (value: string) => void,
    ) => {
      const field = root.querySelector<HTMLInputElement | HTMLSelectElement>(selector);
      field?.addEventListener(event, () => handleValue(field.value));
    };

    bindTabNavigation(root, (nextTab) => {
      state.activeTab = nextTab;
      render();
    });

    root.querySelectorAll<HTMLElement>("[data-conversation-key]").forEach((node) => {
      node.addEventListener("click", () => {
        state.selectedConversationKey = node.dataset.conversationKey ?? null;
        state.selectedThreadId = null;
        if (state.activeTab !== "chat") {
          state.activeTab = "chat";
        }
        render();
      });
    });

    root.querySelectorAll<HTMLElement>("[data-thread-select]").forEach((node) => {
      node.addEventListener("click", () => {
        const val = node.dataset.threadSelect;
        if (val === "root") {
          state.selectedThreadId = null;
        } else {
          state.selectedThreadId = val ?? null;
          const conversationKey = node.dataset.threadConversationKey;
          if (conversationKey) {
            state.selectedConversationKey = conversationKey;
          }
        }
        render();
      });
    });

    root.querySelectorAll<HTMLElement>("[data-scenario-id]").forEach((node) => {
      node.addEventListener("click", () => {
        state.selectedScenarioId = node.dataset.scenarioId ?? null;
        if (state.activeTab !== "results") {
          state.activeTab = "results";
        }
        render();
      });
    });

    const bindAction = (action: string, handler: () => void) => {
      root
        .querySelector<HTMLElement>(`[data-action='${action}']`)
        ?.addEventListener("click", handler);
    };
    bindAction("refresh", () => void refresh());
    bindAction("reset", () => void resetState());
    bindAction("toggle-theme", toggleTheme);
    bindAction("toggle-sidebar", toggleSidebar);
    root.querySelectorAll<HTMLElement>("[data-sidebar-panel]").forEach((node) => {
      node.addEventListener("click", () => {
        const panel = node.dataset.sidebarPanel;
        if (panel === "config" || panel === "run" || panel === "scenarios") {
          setSidebarPanel(panel);
        }
      });
    });
    bindAction("self-check", () => void runSelfCheck());
    bindAction("run-suite", () => void runSuite());
    bindAction("kickoff", () => void sendKickoff());
    bindAction("send", () => void sendInbound());
    bindAction("download-report", downloadReport);
    bindAction("load-evidence", () => void loadEvidence());
    bindAction("open-run-evidence", () => {
      const evidencePath = state.bootstrap?.runner.artifacts?.evidencePath;
      if (!evidencePath) {
        return;
      }
      state.activeTab = "evidence";
      void loadEvidence(evidencePath);
    });

    bindAction("select-all-scenarios", () => {
      updateRunnerDraft((d) => ({
        ...d,
        scenarioIds: state.bootstrap?.scenarios.map((s) => s.id) ?? d.scenarioIds,
      }));
    });
    bindAction("clear-scenarios", () => {
      updateRunnerDraft((d) => ({ ...d, scenarioIds: null }));
    });

    root.querySelectorAll<HTMLInputElement>("[data-scenario-toggle-id]").forEach((node) => {
      node.addEventListener("change", () => {
        const scenarioId = node.dataset.scenarioToggleId;
        if (!scenarioId) {
          return;
        }
        updateRunnerDraft((draft) => {
          const selected = new Set(
            draft.scenarioIds ??
              (!state.runnerDraftDirty
                ? state.bootstrap?.runner.plan?.selectedScenarios.map((scenario) => scenario.id)
                : undefined) ??
              [],
          );
          if (node.checked) {
            selected.add(scenarioId);
          } else {
            selected.delete(scenarioId);
          }
          const orderedIds = state.bootstrap?.scenarios
            .map((s) => s.id)
            .filter((id) => selected.has(id)) ?? [...selected];
          return { ...draft, scenarioIds: orderedIds };
        });
      });
    });

    bindValue("#run-profile", "change", (profile) => {
      const profileDefaults = state.bootstrap?.runnerCatalog.profiles.find(
        (entry) => entry.id === profile,
      );
      updateRunnerDraft((draft) => ({
        ...draft,
        profile,
        channelDriver: profileDefaults?.channelDriver ?? draft.channelDriver,
        evidenceMode: profileDefaults?.evidenceMode ?? draft.evidenceMode,
        scenarioIds: null,
      }));
    });
    bindValue("#provider-mode", "change", (value) => {
      const mode = value === "live-frontier" ? "live-frontier" : "mock-openai";
      updateRunnerDraft((d) => ({
        ...d,
        providerMode: mode,
        ...defaultModelsForProviderMode(mode, state.bootstrap),
      }));
    });
    bindValue("#channel-driver", "change", (value) => {
      const channelDriver = value === "crabline" || value === "live" ? value : "qa-channel";
      updateRunnerDraft((draft) => ({ ...draft, channelDriver }));
    });
    bindValue("#execution-channel", "change", (value) => {
      const channel = value.trim() || null;
      updateRunnerDraft((draft) => ({ ...draft, channel }));
    });
    bindValue("#evidence-mode", "change", (value) => {
      const evidenceMode = value === "slim" ? "slim" : "full";
      updateRunnerDraft((draft) => ({ ...draft, evidenceMode }));
    });
    bindValue("#runtime-pair", "change", (value) => {
      const runtimePair: RunnerSelection["runtimePair"] =
        value === "openclaw,codex" ? ["openclaw", "codex"] : null;
      updateRunnerDraft((draft) => ({ ...draft, runtimePair }));
    });
    bindValue("#runtime-pair-lane", "change", (value) => {
      const runtimePairLane =
        value === "core" || value === "extended" || value === "soak" ? value : null;
      updateRunnerDraft((draft) => ({ ...draft, runtimePairLane }));
    });
    bindValue("#primary-model", "change", (primaryModel) => {
      updateRunnerDraft((d) => ({
        ...d,
        primaryModel,
        fastMode: isQaFastModeEnabled({ primaryModel, alternateModel: d.alternateModel }),
      }));
    });
    bindValue("#alternate-model", "change", (alternateModel) => {
      updateRunnerDraft((d) => ({
        ...d,
        alternateModel,
        fastMode: isQaFastModeEnabled({ primaryModel: d.primaryModel, alternateModel }),
      }));
    });

    bindValue("#evidence-path", "input", (value) => {
      state.evidencePathDraft = value;
    });
    root.querySelector<HTMLInputElement>("#evidence-path")?.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void loadEvidence();
      }
    });
    bindValue("#evidence-status-filter", "change", (value) => {
      state.evidenceStatusFilter =
        value === "pass" || value === "fail" || value === "blocked" || value === "skipped"
          ? value
          : "all";
      state.selectedEvidenceEntryKey = null;
      render();
    });
    bindValue("#evidence-artifact-filter", "change", (value) => {
      state.evidenceArtifactFilter =
        value === "image" ||
        value === "video" ||
        value === "json" ||
        value === "text" ||
        value === "file"
          ? value
          : "all";
      state.selectedEvidenceEntryKey = null;
      render();
    });
    bindValue("#evidence-search", "input", (value) => {
      state.evidenceSearchText = value;
      state.selectedEvidenceEntryKey = null;
      render();
    });
    root.querySelectorAll<HTMLElement>("[data-evidence-entry-key]").forEach((node) => {
      node.addEventListener("click", () => {
        state.selectedEvidenceEntryKey = node.dataset.evidenceEntryKey ?? null;
        render();
      });
    });

    root.querySelector<HTMLSelectElement>("#capture-session")?.addEventListener("change", (e) => {
      state.selectedCaptureSessionIds = readMultiSelect(e.currentTarget as HTMLSelectElement);
      state.selectedCaptureEventKey = null;
      void refresh();
    });
    root.querySelector<HTMLButtonElement>("#capture-save-view")?.addEventListener("click", () => {
      const name = window.prompt("Saved view name");
      const trimmed = name?.trim();
      if (!trimmed) {
        return;
      }
      state.captureSavedViews = [buildCaptureSavedView(trimmed), ...state.captureSavedViews].slice(
        0,
        12,
      );
      persistCaptureSavedViews(state.captureSavedViews);
      render();
    });
    bindValue("#capture-saved-view", "change", (id) => {
      const view = state.captureSavedViews.find((candidate) => candidate.id === id);
      if (!view) {
        return;
      }
      applyCaptureSavedView(view);
      void refresh();
    });
    root.querySelector<HTMLButtonElement>("#capture-delete-view")?.addEventListener("click", () => {
      const select = root.querySelector<HTMLSelectElement>("#capture-saved-view");
      const id = select?.value?.trim();
      if (!id) {
        return;
      }
      state.captureSavedViews = state.captureSavedViews.filter((view) => view.id !== id);
      persistCaptureSavedViews(state.captureSavedViews);
      render();
    });
    root.querySelectorAll<HTMLButtonElement>("[data-capture-session-remove]").forEach((node) => {
      node.addEventListener("click", () => {
        const sessionId = node.dataset.captureSessionRemove?.trim();
        if (!sessionId) {
          return;
        }
        state.selectedCaptureSessionIds = state.selectedCaptureSessionIds.filter(
          (id) => id !== sessionId,
        );
        state.selectedCaptureEventKey = null;
        void refresh();
      });
    });
    root
      .querySelector<HTMLButtonElement>("#capture-toggle-selected-sessions")
      ?.addEventListener("click", () => {
        state.captureSelectedSessionsExpanded = !state.captureSelectedSessionsExpanded;
        render();
      });
    root
      .querySelector<HTMLButtonElement>("#capture-delete-selected-sessions")
      ?.addEventListener("click", () => {
        void (async () => {
          if (state.selectedCaptureSessionIds.length === 0) {
            return;
          }
          const confirmed = window.confirm(
            `Delete ${state.selectedCaptureSessionIds.length} selected capture session${
              state.selectedCaptureSessionIds.length === 1 ? "" : "s"
            }?`,
          );
          if (!confirmed) {
            return;
          }
          await postJson("/api/capture/delete-sessions", {
            sessionIds: state.selectedCaptureSessionIds,
          });
          state.selectedCaptureSessionIds = [];
          state.selectedCaptureEventKey = null;
          await refresh();
        })();
      });
    root.querySelector<HTMLButtonElement>("#capture-purge-all")?.addEventListener("click", () => {
      void (async () => {
        const confirmed = window.confirm("Purge all captured sessions, events, and blobs?");
        if (!confirmed) {
          return;
        }
        await postJson("/api/capture/purge", {});
        state.selectedCaptureSessionIds = [];
        state.selectedCaptureEventKey = null;
        await refresh();
      })();
    });
    bindValue("#capture-preset", "change", (value) => {
      state.captureQueryPreset = value as UiState["captureQueryPreset"];
      void refresh();
    });
    const readMultiSelect = (select: HTMLSelectElement) =>
      [...select.selectedOptions].map((option) => option.value).filter(Boolean);
    for (const [selector, field] of [
      ["#capture-kind-filter", "captureKindFilter"],
      ["#capture-provider-filter", "captureProviderFilter"],
      ["#capture-host-filter", "captureHostFilter"],
    ] as const) {
      root.querySelector<HTMLSelectElement>(selector)?.addEventListener("change", (e) => {
        state[field] = readMultiSelect(e.currentTarget as HTMLSelectElement);
        state.selectedCaptureEventKey = null;
        render();
      });
    }
    bindValue("#capture-header-mode", "change", (value) => {
      state.captureHeaderMode = value === "all" || value === "hidden" ? value : "key";
      render();
    });
    bindValue("#capture-view-mode", "change", (value) => {
      state.captureViewMode = value === "timeline" ? "timeline" : "list";
      state.captureCollapsedLaneIds = [];
      state.capturePinnedLaneIds = [];
      state.captureTimelineWindowStartPct = null;
      state.captureTimelineWindowEndPct = null;
      state.captureTimelineBrushAnchorPct = null;
      state.captureTimelineBrushCurrentPct = null;
      state.selectedCaptureEventKey = null;
      render();
    });
    bindValue("#capture-group-mode", "change", (value) => {
      state.captureGroupMode =
        value === "flow" || value === "host-path" || value === "burst" ? value : "none";
      state.selectedCaptureEventKey = null;
      render();
    });
    bindValue("#capture-timeline-lane-mode", "change", (value) => {
      state.captureTimelineLaneMode = value === "provider" || value === "flow" ? value : "domain";
      state.captureTimelinePreviousLaneSort = null;
      state.captureCollapsedLaneIds = [];
      state.capturePinnedLaneIds = [];
      state.selectedCaptureEventKey = null;
      render();
    });
    bindValue("#capture-timeline-lane-sort", "change", (value) => {
      const nextSort =
        value === "most-errors" || value === "severity" || value === "alphabetical"
          ? value
          : "most-events";
      if (nextSort !== state.captureTimelineLaneSort) {
        state.captureTimelinePreviousLaneSort = state.captureTimelineLaneSort;
      }
      state.captureTimelineLaneSort = nextSort;
      render();
    });
    bindValue("#capture-timeline-lane-search", "input", (value) => {
      state.captureTimelineLaneSearch = value ?? "";
      render();
    });
    bindValue("#capture-timeline-zoom", "change", (value) => {
      const zoom = Number(value);
      state.captureTimelineZoom =
        zoom === 75 || zoom === 150 || zoom === 200 || zoom === 300 ? zoom : 100;
      render();
    });
    bindValue("#capture-timeline-sparkline-mode", "change", (value) => {
      state.captureTimelineSparklineMode =
        value === "lane-relative" ? "lane-relative" : "session-relative";
      render();
    });
    root
      .querySelector<HTMLButtonElement>("#capture-timeline-clear-window")
      ?.addEventListener("click", () => {
        state.captureTimelineWindowStartPct = null;
        state.captureTimelineWindowEndPct = null;
        state.captureTimelineBrushAnchorPct = null;
        state.captureTimelineBrushCurrentPct = null;
        state.selectedCaptureEventKey = null;
        render();
      });
    root
      .querySelector<HTMLInputElement>("#capture-timeline-focus-flow")
      ?.addEventListener("change", (e) => {
        state.captureTimelineFocusSelectedFlow = (e.currentTarget as HTMLInputElement).checked;
        if (!state.captureTimelineFocusSelectedFlow) {
          state.captureTimelineFocusedLaneMode = "all";
          state.captureTimelineFocusedLaneThreshold = "any";
        }
        render();
      });
    bindValue("#capture-timeline-focused-lane-mode", "change", (value) => {
      state.captureTimelineFocusedLaneMode =
        value === "only-matching" || value === "collapse-background" ? value : "all";
      render();
    });
    bindValue("#capture-timeline-focused-lane-threshold", "change", (value) => {
      state.captureTimelineFocusedLaneThreshold =
        value === "events-2" || value === "percent-10" || value === "percent-25" ? value : "any";
      render();
    });
    bindValue("#capture-detail-placement", "change", (value) => {
      state.captureDetailPlacement = value === "bottom" ? "bottom" : "right";
      render();
    });
    root
      .querySelector<HTMLElement>("[data-capture-detail-splitter]")
      ?.addEventListener("mousedown", (event) => {
        if (event.button !== 0 || state.captureDetailPlacement !== "right") {
          return;
        }
        const splitRoot = root.querySelector<HTMLElement>("[data-capture-detail-split-root]");
        if (!splitRoot) {
          return;
        }
        const rect = splitRoot.getBoundingClientRect();
        state.captureDetailSplitDragging = true;
        render();
        const handleMove = (moveEvent: MouseEvent) => {
          const localX = moveEvent.clientX - rect.left;
          const nextPct = ((rect.width - localX) / rect.width) * 100;
          state.captureDetailSplitPct = Math.max(22, Math.min(55, Number(nextPct.toFixed(2))));
          render();
        };
        const handleUp = () => {
          state.captureDetailSplitDragging = false;
          window.removeEventListener("mousemove", handleMove);
          window.removeEventListener("mouseup", handleUp);
          render();
        };
        window.addEventListener("mousemove", handleMove);
        window.addEventListener("mouseup", handleUp);
        event.preventDefault();
      });
    root
      .querySelector<HTMLElement>("[data-capture-detail-splitter]")
      ?.addEventListener("dblclick", () => {
        state.captureDetailSplitPct = 34;
        state.captureDetailSplitDragging = false;
        render();
      });
    const bindCaptureRadio = (name: string, select: (value: string) => void) => {
      root.querySelectorAll<HTMLInputElement>(`input[name="${name}"]`).forEach((node) => {
        node.addEventListener("change", () => {
          if (node.checked) {
            select(node.value);
            render();
          }
        });
      });
    };
    bindCaptureRadio("capture-detail-view", (value) => {
      state.captureDetailView =
        value === "flow" || value === "payload" || value === "headers" ? value : "overview";
      state.capturePreferredDetailView = state.captureDetailView;
    });
    bindCaptureRadio("capture-flow-layout", (value) => {
      state.captureFlowDetailLayout = value === "pair-first" ? "pair-first" : "nav-first";
    });
    bindCaptureRadio("capture-payload-layout", (value) => {
      state.capturePayloadDetailLayout = value === "raw" ? "raw" : "formatted";
    });
    bindCaptureRadio("capture-payload-extent", (value) => {
      state.capturePayloadExtent = value === "full" ? "full" : "preview";
    });
    bindCaptureRadio("capture-payload-event-sort", (value) => {
      state.capturePayloadEventSort = value === "name" || value === "size" ? value : "stream";
    });
    bindValue("#capture-payload-event-filter", "input", (value) => {
      state.capturePayloadEventFilter = value ?? "";
      render();
    });
    bindValue("#capture-search-filter", "input", (value) => {
      state.captureSearchText = value ?? "";
      state.selectedCaptureEventKey = null;
      render();
    });
    root
      .querySelector<HTMLInputElement>("#capture-errors-only")
      ?.addEventListener("change", (e) => {
        state.captureErrorsOnly = (e.currentTarget as HTMLInputElement).checked;
        state.selectedCaptureEventKey = null;
        render();
      });
    root
      .querySelector<HTMLButtonElement>("#capture-summary-toggle")
      ?.addEventListener("click", () => {
        state.captureSummaryExpanded = !state.captureSummaryExpanded;
        render();
      });
    root
      .querySelector<HTMLButtonElement>("#capture-controls-toggle")
      ?.addEventListener("click", () => {
        state.captureControlsExpanded = !state.captureControlsExpanded;
        render();
      });
    root
      .querySelector<HTMLButtonElement>("#capture-clear-filters")
      ?.addEventListener("click", () => {
        Object.assign(state, createCaptureFilters());
        render();
      });
    root.querySelectorAll<HTMLElement>("[data-capture-lane-toggle]").forEach((node) => {
      node.addEventListener("click", () => {
        const laneId = node.dataset.captureLaneToggle;
        if (!laneId) {
          return;
        }
        const collapsed = new Set(state.captureCollapsedLaneIds);
        if (collapsed.has(laneId)) {
          collapsed.delete(laneId);
        } else {
          collapsed.add(laneId);
        }
        state.captureCollapsedLaneIds = [...collapsed];
        render();
      });
    });
    root.querySelectorAll<HTMLElement>("[data-capture-lane-pin]").forEach((node) => {
      node.addEventListener("click", () => {
        const laneId = node.dataset.captureLanePin;
        if (!laneId) {
          return;
        }
        const pinned = new Set(state.capturePinnedLaneIds);
        if (pinned.has(laneId)) {
          pinned.delete(laneId);
        } else {
          pinned.add(laneId);
        }
        state.capturePinnedLaneIds = [...pinned];
        render();
      });
    });
    root.querySelectorAll<HTMLElement>("[data-capture-event]").forEach((node) => {
      node.addEventListener("click", () => {
        state.selectedCaptureEventKey = node.dataset.captureEvent ?? null;
        render();
      });
    });
    root.querySelectorAll<HTMLButtonElement>("[data-copy-text]").forEach((node) => {
      node.addEventListener("click", () => {
        const text = node.dataset.copyText ?? "";
        if (!text) {
          return;
        }
        void navigator.clipboard.writeText(text).catch(() => undefined);
      });
    });
    root.querySelectorAll<HTMLElement>("[data-capture-sparkline-window]").forEach((node) => {
      const readWindow = () => {
        const start = Number(node.dataset.captureWindowStart ?? "NaN");
        const end = Number(node.dataset.captureWindowEnd ?? "NaN");
        return Number.isFinite(start) && Number.isFinite(end) ? { start, end } : null;
      };
      node.addEventListener("mousedown", (event) => {
        if (event.button !== 0) {
          return;
        }
        const windowRange = readWindow();
        if (!windowRange) {
          return;
        }
        sparklineSweepActive = true;
        sparklineSweepAnchorStartPct = windowRange.start;
        sparklineSweepAnchorEndPct = windowRange.end;
        sparklineSweepCurrentStartPct = windowRange.start;
        sparklineSweepCurrentEndPct = windowRange.end;
        state.captureTimelineBrushAnchorPct = windowRange.start;
        state.captureTimelineBrushCurrentPct = windowRange.end;
        render();
      });
      node.addEventListener("mouseenter", () => {
        if (!sparklineSweepActive) {
          return;
        }
        const windowRange = readWindow();
        if (!windowRange) {
          return;
        }
        sparklineSweepCurrentStartPct = windowRange.start;
        sparklineSweepCurrentEndPct = windowRange.end;
        const previewStart = Math.min(
          sparklineSweepAnchorStartPct ?? windowRange.start,
          windowRange.start,
        );
        const previewEnd = Math.max(sparklineSweepAnchorEndPct ?? windowRange.end, windowRange.end);
        state.captureTimelineBrushAnchorPct = previewStart;
        state.captureTimelineBrushCurrentPct = previewEnd;
        render();
      });
    });
    const timelineViewports = [...root.querySelectorAll<HTMLElement>(".capture-timeline-viewport")];
    timelineViewports.forEach((node) => {
      node.addEventListener("scroll", () => {
        if (syncingCaptureTimelineScroll) {
          return;
        }
        syncingCaptureTimelineScroll = true;
        const nextLeft = node.scrollLeft;
        for (const other of timelineViewports) {
          if (other !== node && other.scrollLeft !== nextLeft) {
            other.scrollLeft = nextLeft;
          }
        }
        syncingCaptureTimelineScroll = false;
      });
    });
    root.querySelectorAll<HTMLElement>("[data-capture-timeline-brush-surface]").forEach((node) => {
      node.addEventListener("mousedown", (event) => {
        if (event.button !== 0) {
          return;
        }
        const viewport = node;
        const trackWidth = Number(viewport.dataset.captureTimelineTrackWidth ?? "0");
        if (!Number.isFinite(trackWidth) || trackWidth <= 0) {
          return;
        }
        const percentFromEvent = (clientX: number) => {
          const rect = viewport.getBoundingClientRect();
          const localX = clientX - rect.left + viewport.scrollLeft;
          return Math.min(100, Math.max(0, (localX / trackWidth) * 100));
        };
        const anchorPct = percentFromEvent(event.clientX);
        state.captureTimelineBrushAnchorPct = anchorPct;
        state.captureTimelineBrushCurrentPct = anchorPct;
        render();
        const handleMove = (moveEvent: MouseEvent) => {
          state.captureTimelineBrushCurrentPct = percentFromEvent(moveEvent.clientX);
          render();
        };
        const handleUp = () => {
          const anchor = state.captureTimelineBrushAnchorPct;
          const current = state.captureTimelineBrushCurrentPct;
          if (anchor != null && current != null) {
            const start = Math.min(anchor, current);
            const end = Math.max(anchor, current);
            if (end - start >= 1) {
              state.captureTimelineWindowStartPct = start;
              state.captureTimelineWindowEndPct = end;
              state.selectedCaptureEventKey = null;
            }
          }
          state.captureTimelineBrushAnchorPct = null;
          state.captureTimelineBrushCurrentPct = null;
          window.removeEventListener("mousemove", handleMove);
          window.removeEventListener("mouseup", handleUp);
          render();
        };
        window.addEventListener("mousemove", handleMove);
        window.addEventListener("mouseup", handleUp);
      });
    });
    if (!captureGlobalListenersBound) {
      captureGlobalListenersBound = true;
      window.addEventListener("mouseup", (event) => {
        if (!sparklineSweepActive) {
          return;
        }
        const anchorStart = sparklineSweepAnchorStartPct;
        const anchorEnd = sparklineSweepAnchorEndPct;
        const currentStart = sparklineSweepCurrentStartPct;
        const currentEnd = sparklineSweepCurrentEndPct;
        sparklineSweepActive = false;
        sparklineSweepAnchorStartPct = null;
        sparklineSweepAnchorEndPct = null;
        sparklineSweepCurrentStartPct = null;
        sparklineSweepCurrentEndPct = null;
        if (
          anchorStart == null ||
          anchorEnd == null ||
          currentStart == null ||
          currentEnd == null
        ) {
          state.captureTimelineBrushAnchorPct = null;
          state.captureTimelineBrushCurrentPct = null;
          render();
          return;
        }
        const start = Math.min(anchorStart, currentStart);
        const end = Math.max(anchorEnd, currentEnd);
        const width = Math.max(0.01, end - start);
        const expand = event.shiftKey ? width : 0;
        state.captureTimelineWindowStartPct = Math.max(0, Math.min(100, start - expand));
        state.captureTimelineWindowEndPct = Math.max(0, Math.min(100, end + expand));
        state.captureTimelineBrushAnchorPct = null;
        state.captureTimelineBrushCurrentPct = null;
        state.selectedCaptureEventKey = null;
        render();
      });
      root.addEventListener("keydown", (event) => {
        if (state.activeTab !== "capture") {
          return;
        }
        if (isEditableElement(event.target)) {
          return;
        }
        if (event.key === "1" || event.key === "2" || event.key === "3" || event.key === "4") {
          const radios = [
            ...root.querySelectorAll<HTMLInputElement>('input[name="capture-detail-view"]'),
          ].filter((node) => !node.disabled);
          const index = Number(event.key) - 1;
          const target = radios[index];
          if (target) {
            event.preventDefault();
            target.checked = true;
            state.captureDetailView =
              target.value === "flow" || target.value === "payload" || target.value === "headers"
                ? target.value
                : "overview";
            state.capturePreferredDetailView = state.captureDetailView;
            render();
          }
          return;
        }
        if (state.captureViewMode !== "timeline") {
          return;
        }
        if (
          event.key !== "ArrowLeft" &&
          event.key !== "ArrowRight" &&
          event.key !== "Home" &&
          event.key !== "End" &&
          event.key !== "Escape"
        ) {
          return;
        }
        if (event.key === "Escape") {
          if (
            state.captureTimelineWindowStartPct != null ||
            state.captureTimelineBrushAnchorPct != null
          ) {
            event.preventDefault();
            state.captureTimelineWindowStartPct = null;
            state.captureTimelineWindowEndPct = null;
            state.captureTimelineBrushAnchorPct = null;
            state.captureTimelineBrushCurrentPct = null;
            state.selectedCaptureEventKey = null;
            render();
          }
          return;
        }
        const markers = [
          ...root.querySelectorAll<HTMLElement>(".capture-timeline [data-capture-event]"),
        ];
        if (markers.length === 0) {
          return;
        }
        const currentIndex = markers.findIndex(
          (node) => (node.dataset.captureEvent ?? null) === state.selectedCaptureEventKey,
        );
        let nextIndex = Math.max(currentIndex, 0);
        if (event.key === "Home") {
          nextIndex = 0;
        } else if (event.key === "End") {
          nextIndex = markers.length - 1;
        } else if (event.key === "ArrowLeft") {
          nextIndex = currentIndex <= 0 ? 0 : currentIndex - 1;
        } else if (event.key === "ArrowRight") {
          nextIndex = currentIndex < 0 ? 0 : Math.min(markers.length - 1, currentIndex + 1);
        }
        const next = markers[nextIndex];
        if (!next) {
          return;
        }
        event.preventDefault();
        state.selectedCaptureEventKey = next.dataset.captureEvent ?? null;
        render();
      });
    }

    bindValue("#conversation-kind", "change", (selectedKind) => {
      state.composer.conversationKind =
        selectedKind === "channel" || selectedKind === "group" ? selectedKind : "direct";
    });
    bindValue("#conversation-id", "input", (value) => {
      state.composer.conversationId = value;
    });
    bindValue("#sender-id", "input", (value) => {
      state.composer.senderId = value;
    });
    bindValue("#sender-name", "input", (value) => {
      state.composer.senderName = value;
    });

    const textarea = root.querySelector<HTMLTextAreaElement>("#composer-text");
    if (textarea) {
      textarea.addEventListener("input", (e) => {
        state.composer.text = (e.currentTarget as HTMLTextAreaElement).value;

        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
      });
      textarea.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          void sendInbound();
        }
      });
    }

    trackChatScroll();
  }

  function render() {
    const renderState = captureRenderState(root);
    const composerText = state.composer.text;

    root.innerHTML = renderQaLabUi(state);
    bindEvents();

    /* Restore composer text (since we re-rendered) */
    const textEl = root.querySelector<HTMLTextAreaElement>("#composer-text");
    if (textEl && composerText) {
      textEl.value = composerText;
      textEl.style.height = "auto";
      textEl.style.height = `${Math.min(textEl.scrollHeight, 120)}px`;
    }

    restoreRenderState(root, renderState);

    if (
      state.activeTab === "capture" &&
      state.captureViewMode === "timeline" &&
      state.selectedCaptureEventKey
    ) {
      const selectedTimelineMarker = root.querySelector<HTMLElement>(
        `.capture-timeline [data-capture-event="${CSS.escape(state.selectedCaptureEventKey)}"]`,
      );
      if (selectedTimelineMarker) {
        selectedTimelineMarker.scrollIntoView({ block: "nearest", inline: "center" });
      }
    }

    requestAnimationFrame(() => scrollChatToBottom());
  }

  render();
  await refresh();
  if (initialEvidencePath) {
    await loadEvidence(initialEvidencePath);
  }
  void pollUiVersion();
  setInterval(() => void refresh(), 1_000);
  setInterval(() => void pollUiVersion(), 1_000);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
