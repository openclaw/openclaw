import type {
  WorkboardBoardSummary,
  WorkboardCard,
  WorkboardPriority,
  WorkboardStatus,
  WorkboardTemplateId,
} from "@openclaw/workboard-contract";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { TaskSummary } from "../tasks/task-summary.ts";

export * from "@openclaw/workboard-contract";
export type { WorkboardBoardSummary } from "@openclaw/workboard-contract";

type WorkboardLifecycleState =
  | "unlinked"
  | "unknown"
  | "unavailable"
  | "ambiguous"
  | "idle"
  | "queued"
  | "running"
  | "stale"
  | "succeeded"
  | "failed";

export type WorkboardLifecycle = {
  session: GatewaySessionRow | null;
  state: WorkboardLifecycleState;
  targetStatus?: WorkboardStatus;
  sourceUpdatedAt?: number;
};

export type WorkboardTaskSummary = TaskSummary;

type WorkboardDependencyParent = {
  id: string;
  title: string;
  status?: WorkboardStatus;
  done: boolean;
  missing: boolean;
};

export type WorkboardDependencyState = {
  parents: WorkboardDependencyParent[];
  blockedParents: WorkboardDependencyParent[];
};

export type WorkboardDispatchSummary = {
  started: number;
  failures: number;
  promoted: number;
  blocked: number;
  reclaimed: number;
  orchestrated: number;
};

export type WorkboardRefreshSource = "initial" | "manual" | "live";

export type WorkboardHealthKey =
  | "running"
  | "blocked"
  | "stale"
  | "readyUnassigned"
  | "missingProof"
  | "failedAttempts";

export type WorkboardUiState = {
  loading: boolean;
  loaded: boolean;
  loadAttempted: boolean;
  mutationReadiness: "ready" | "canonical_reload_required" | "stale_edit_draft";
  error: string | null;
  cards: WorkboardCard[];
  boards: WorkboardBoardSummary[];
  statuses: readonly WorkboardStatus[];
  tasksByCardId: Map<string, WorkboardTaskSummary>;
  missingTaskIds: Set<string>;
  lastDispatchSummary: WorkboardDispatchSummary | null;
  dispatching: boolean;
  query: string;
  searchOpen: boolean;
  priorityFilter: Set<WorkboardPriority>;
  statusFilter: Set<WorkboardStatus>;
  attentionFilter: Set<"stale" | "missingProof">;
  donePeriod: "all" | "week";
  agentFilter: string;
  boardFilter: string;
  activeHealthHighlight: WorkboardHealthKey | null;
  showArchived: boolean;
  layout: "comfortable" | "compact";
  emptyColumnMode: "show" | "collapse" | "hide";
  collapsedStatuses: Set<WorkboardStatus>;
  expandedEmptyStatuses: Set<WorkboardStatus>;
  lastRefreshAt: number | null;
  lastRefreshStartedAt: number | null;
  lastRefreshError: string | null;
  lastRefreshSource: WorkboardRefreshSource | null;
  lifecycleTasksPrepared: boolean;
  lifecycleTasksPreparedAt: number | null;
  lifecycleTaskRefreshFailed: boolean;
  lifecycleTaskRefreshRetryAt: number | null;
  lifecycleTaskRefreshContinueAt: number | null;
  lifecycleTaskRefreshError: string | null;
  lifecycleConfirmedTaskIds: Set<string>;
  lifecycleTaskConfirmationStartedAt: number | null;
  draftOpen: boolean;
  draftSaving: boolean;
  editingCardId: string | null;
  editingCardBase: WorkboardCard | null;
  draftTitle: string;
  draftNotes: string;
  draftStatus: WorkboardStatus;
  draftPriority: WorkboardPriority;
  draftLabels: string;
  draftAgentId: string;
  draftSessionKey: string;
  draftTemplateId: WorkboardTemplateId | "";
  draftCommentBody: string;
  detailCardId: string | null;
  detailCommentBody: string;
  busyCardIds: Set<string>;
  draggedCardId: string | null;
  capturingSessionKeys: Set<string>;
};

export type WorkboardTaskLinkState = Pick<
  WorkboardUiState,
  "cards" | "tasksByCardId" | "missingTaskIds"
>;
