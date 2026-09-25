import type {
  CaptureQueryPreset as StoredCaptureQueryPreset,
  CaptureSessionSummary,
} from "openclaw/plugin-sdk/proxy-capture";
import type {
  QaBusConversationKind,
  QaBusStateSnapshot,
} from "openclaw/plugin-sdk/qa-channel-protocol";
import type { QaLabLatestReport, QaLabScenarioOutcome, QaLabScenarioRun } from "../../api.js";
import type {
  QaLabExecutionKind,
  QaLabResolvedRunPlan,
  QaLabRunnerSnapshot,
  QaLabRunSelection,
} from "../../runner-contract.js";
import type {
  QaEvidenceArtifactView,
  QaEvidenceGalleryEntryView,
  QaEvidenceGalleryModel,
  QaEvidenceMatrixCellView,
  QaEvidenceProducerContext,
  QaEvidenceProducerContextFile,
} from "../../shared/evidence-gallery-types.js";

export type ReportEnvelope = {
  report: QaLabLatestReport | null;
};

export type SeedScenario = {
  id: string;
  title: string;
  surface: string;
  objective: string;
  successCriteria: string[];
  docsRefs?: string[];
  codeRefs?: string[];
  execution?: {
    kind?: QaLabExecutionKind;
    channel?: string;
  };
  runtimePairLane?: "core" | "extended" | "soak";
};

export type Bootstrap = {
  baseUrl: string;
  latestReport: ReportEnvelope["report"];
  controlUiUrl: string | null;
  controlUiEmbeddedUrl: string | null;
  kickoffTask: string;
  scenarios: SeedScenario[];
  defaults: {
    conversationKind: "direct" | "channel";
    conversationId: string;
    senderId: string;
    senderName: string;
  };
  runner: RunnerSnapshot;
  runnerCatalog: {
    status: "loading" | "ready" | "failed";
    real: RunnerModelOption[];
    channels: string[];
    profiles: Array<{
      id: string;
      evidenceMode: "full" | "slim";
      channelDriver: "qa-channel" | "crabline" | "live";
      categoryIds: string[];
    }>;
  };
};

export type ScenarioOutcome = QaLabScenarioOutcome;
type ScenarioRun = QaLabScenarioRun;

export type RunnerSelection = QaLabRunSelection;
export type RunnerResolvedPlan = QaLabResolvedRunPlan;
type RunnerSnapshot = QaLabRunnerSnapshot;

export type RunnerModelOption = {
  key: string;
  name: string;
  provider: string;
  input: string;
  preferred: boolean;
};

export type OutcomesEnvelope = {
  run: ScenarioRun | null;
};

export type CaptureEventView = {
  id?: number;
  ts: number;
  protocol: string;
  direction: string;
  kind: string;
  flowId: string;
  method?: string;
  host?: string;
  path?: string;
  status?: number;
  closeCode?: number;
  contentType?: string;
  headersJson?: string;
  dataText?: string;
  payloadPreview?: string;
  dataBlobId?: string;
  errorText?: string;
  provider?: string;
  api?: string;
  model?: string;
  captureOrigin?: string;
};

export type CaptureQueryPreset = "none" | StoredCaptureQueryPreset;

export type CaptureSessionsEnvelope = {
  sessions: CaptureSessionSummary[];
};

export type CaptureEventsEnvelope = {
  events: CaptureEventView[];
};

export type CaptureQueryEnvelope = {
  rows: Array<Record<string, string | number | null>>;
};

type CaptureObservedDimension = {
  value: string;
  count: number;
};

type CaptureCoverageSummary = {
  sessionId: string;
  totalEvents: number;
  unlabeledEventCount: number;
  providers: CaptureObservedDimension[];
  apis: CaptureObservedDimension[];
  models: CaptureObservedDimension[];
  hosts: CaptureObservedDimension[];
  localPeers: CaptureObservedDimension[];
};

export type CaptureCoverageEnvelope = {
  coverage: CaptureCoverageSummary;
};

export type CaptureStartupProbeStatus = {
  label: string;
  url: string;
  ok: boolean;
  error?: string;
};

export type CaptureStartupStatus = {
  proxy: CaptureStartupProbeStatus;
  gateway: CaptureStartupProbeStatus;
  qaLab: CaptureStartupProbeStatus;
};

export type CaptureStartupStatusEnvelope = {
  status: CaptureStartupStatus;
};

type EvidenceStatus = QaEvidenceGalleryEntryView["status"];
export type EvidenceArtifactView = QaEvidenceArtifactView;
export type EvidenceEntryView = QaEvidenceGalleryEntryView;
export type EvidenceProducerContextFile = QaEvidenceProducerContextFile;
export type EvidenceMatrixCell = QaEvidenceMatrixCellView;
export type EvidenceProducerContext = QaEvidenceProducerContext;
type EvidenceGalleryModel = QaEvidenceGalleryModel;

export type EvidenceEnvelope = {
  evidence: EvidenceGalleryModel | null;
};

export type CaptureSavedView = {
  id: string;
  name: string;
  sessionIds: string[];
  kindFilter: string[];
  providerFilter: string[];
  hostFilter: string[];
  searchText: string;
  headerMode: "key" | "all" | "hidden";
  viewMode: "list" | "timeline";
  groupMode: "none" | "flow" | "host-path" | "burst";
  timelineLaneMode: "domain" | "provider" | "flow";
  timelineLaneSort: "most-events" | "most-errors" | "severity" | "alphabetical";
  timelineZoom: 75 | 100 | 150 | 200 | 300;
  timelineSparklineMode: "session-relative" | "lane-relative";
  errorsOnly: boolean;
  detailPlacement: "right" | "bottom";
  payloadLayout: "formatted" | "raw" | null;
  payloadExtent: "preview" | "full";
};

export type TabId = "chat" | "results" | "report" | "events" | "capture" | "evidence";

export type UiState = {
  theme: "light" | "dark";
  bootstrap: Bootstrap | null;
  snapshot: QaBusStateSnapshot | null;
  latestReport: ReportEnvelope["report"];
  scenarioRun: ScenarioRun | null;
  captureSessions: CaptureSessionSummary[];
  captureEvents: CaptureEventView[];
  captureQueryPreset: CaptureQueryPreset;
  captureQueryRows: Array<Record<string, string | number | null>>;
  captureKindFilter: string[];
  captureProviderFilter: string[];
  captureHostFilter: string[];
  captureSearchText: string;
  captureHeaderMode: "key" | "all" | "hidden";
  captureViewMode: "list" | "timeline";
  captureGroupMode: "none" | "flow" | "host-path" | "burst";
  captureTimelineLaneMode: "domain" | "provider" | "flow";
  captureTimelineLaneSort: "most-events" | "most-errors" | "severity" | "alphabetical";
  captureTimelinePreviousLaneSort:
    | "most-events"
    | "most-errors"
    | "severity"
    | "alphabetical"
    | null;
  captureTimelineLaneSearch: string;
  captureTimelineZoom: 75 | 100 | 150 | 200 | 300;
  captureTimelineSparklineMode: "session-relative" | "lane-relative";
  captureTimelineWindowStartPct: number | null;
  captureTimelineWindowEndPct: number | null;
  captureTimelineBrushAnchorPct: number | null;
  captureTimelineBrushCurrentPct: number | null;
  captureTimelineFocusSelectedFlow: boolean;
  captureTimelineFocusedLaneMode: "all" | "only-matching" | "collapse-background";
  captureTimelineFocusedLaneThreshold: "any" | "events-2" | "percent-10" | "percent-25";
  captureDetailPlacement: "right" | "bottom";
  captureDetailSplitPct: number;
  captureDetailSplitDragging: boolean;
  captureDetailView: "overview" | "flow" | "payload" | "headers";
  capturePreferredDetailView: "overview" | "flow" | "payload" | "headers" | null;
  captureFlowDetailLayout: "nav-first" | "pair-first" | null;
  capturePayloadDetailLayout: "formatted" | "raw" | null;
  capturePayloadExtent: "preview" | "full";
  capturePayloadEventSort: "stream" | "name" | "size";
  capturePayloadEventFilter: string;
  captureErrorsOnly: boolean;
  captureCoverage: CaptureCoverageSummary | null;
  captureStartupStatus: CaptureStartupStatus | null;
  evidence: EvidenceGalleryModel | null;
  evidenceArtifactFilter: "all" | EvidenceArtifactView["mediaKind"];
  evidenceError: string | null;
  evidenceLoading: boolean;
  evidencePathDraft: string;
  evidenceSearchText: string;
  evidenceStatusFilter: "all" | EvidenceStatus;
  captureControlsExpanded: boolean;
  captureSummaryExpanded: boolean;
  captureSavedViews: CaptureSavedView[];
  captureSelectedSessionsExpanded: boolean;
  sidebarCollapsed: boolean;
  sidebarPanel: "scenarios" | "config" | "run";
  captureCollapsedLaneIds: string[];
  capturePinnedLaneIds: string[];
  selectedCaptureSessionIds: string[];
  selectedCaptureEventKey: string | null;
  selectedEvidenceEntryKey: string | null;
  selectedConversationKey: string | null;
  selectedThreadId: string | null;
  selectedScenarioId: string | null;
  activeTab: TabId;
  runnerDraft: RunnerSelection | null;
  runnerDraftDirty: boolean;
  runnerPlanOverride: RunnerResolvedPlan | null;
  composer: {
    conversationKind: QaBusConversationKind;
    conversationId: string;
    senderId: string;
    senderName: string;
    text: string;
  };
  busy: boolean;
  error: string | null;
};
