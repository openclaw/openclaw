import type {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
  AgentHarnessTaskRuntime,
  AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import type { CodexAppServerClient } from "./client.js";
import type {
  CodexNativeSubagentDeliveryReceipts,
  CodexNativeSubagentReceiptSampling,
} from "./native-subagent-delivery-receipts.js";
import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import type { CodexNativeSubagentCompletion } from "./native-subagent-notification.js";
import type {
  CodexNativeSubagentSubmission,
  CodexNativeSubagentSubmissionStore,
} from "./native-subagent-submission.js";
import type { NativeSubagentAssignment } from "./native-subagent-task-ids.js";
import type { CodexNativeSubagentTaskMirror } from "./native-subagent-task-mirror.js";

export type NativeSubagentMonitorRuntime = {
  createAgentHarnessTaskRuntime: typeof createAgentHarnessTaskRuntime;
  deliverAgentHarnessTaskCompletion: typeof deliverAgentHarnessTaskCompletion;
};

export type NativeSubagentMonitorClient = Pick<
  CodexAppServerClient,
  "request" | "addNotificationHandler" | "addCloseHandler" | "getTransportPid"
>;

export type ParentOwner = {
  turnId?: string;
  isTurnYielded?: () => boolean;
  claimDirectChild?: (threadId: string) => (() => void) | undefined;
  rejectPendingDirectChild?: (threadId: string, reason: string) => void;
  onDirectChildAccepted?: () => void;
};

export type DirectSpawnEvidence = {
  parentThreadId: string;
  childThreadId: string;
  agentPath?: string;
};
export type NativeChildAdmissionEvidence = DirectSpawnEvidence &
  (
    | { kind: "spawn" }
    | {
        kind: "interaction";
        nativeTurnId?: string;
        itemId?: string;
        owner?: ParentOwner;
        admittedOwner?: ParentOwner;
      }
  );
export type ParentState = {
  parentThreadId: string;
  // Overlapping runs share this parent; the last owner releases it only after
  // detached children finish recovery and delivery.
  owners: Map<symbol, ParentOwner>;
  // turn/started can precede bindTurn; retain receipt ownership until the
  // foreground run has finalized its reply and releases this registration.
  turns: Map<string, CodexNativeSubagentReceiptSampling>;
  deliveryReceipts: CodexNativeSubagentDeliveryReceipts;
  requesterSessionKey?: string;
  taskRuntimeScope?: AgentHarnessTaskRuntimeScope;
  historyOwner?: CodexNativeSubagentHistoryOwner;
  agentId?: string;
  taskRuntime?: AgentHarnessTaskRuntime;
  mirror?: CodexNativeSubagentTaskMirror;
  submissionStore?: CodexNativeSubagentSubmissionStore;
};

export type NativeExecutionWait = {
  kind: "approval" | "user_input" | "agent_messages" | "children";
  dependencies?: Array<{ runId: string }>;
  pendingCount?: number;
};

export type NativeTurnEnd = "completed" | "failed" | "interrupted";
export type NativeTurnState = "active" | NativeTurnEnd;
export type NativeTurnObservation = {
  turnId: string;
  state: NativeTurnState | undefined;
  startObserved?: true;
};

export type ChildState = NativeSubagentAssignment & {
  deliveryReceipts: CodexNativeSubagentDeliveryReceipts;
  parentThreadId: string;
  nativeParentThreadId: string;
  readonly agentId?: string;
  nativeTurnState?: NativeTurnState;
  activityWait?: { itemId: string; wait: NativeExecutionWait };
  activityObserved?: true;
  recoveryAttempt: number;
  recoveryTimer?: ReturnType<typeof setTimeout>;
  recoveryInFlight?: Promise<boolean>;
  terminal: boolean;
  fallbackCompletion?: RecoveredCompletion;
  pendingCompletion?: RecoveredCompletion;
  completionTaskPhase?: "finalize" | "delivery";
  completionTaskId?: string;
  // Cold reconstruction requires its saved requester, not a later live registration.
  requiresHistoryOwner?: true;
  subscriptionClosed?: true;
  nativeCompletionDelivered: boolean;
  completionDeliveryAttempt: number;
  completionDeliveryTimer?: ReturnType<typeof setTimeout>;
  deliveringCompletion: boolean;
  deliveryOwnerKey?: string;
  settledWithoutCompletion: boolean;
  releaseDirectChild?: () => void;
  directOwner?: ParentOwner;
};

export type KnownChild = {
  parent: ParentState;
  nativeParentThreadId: string;
  deliveryReceipts: CodexNativeSubagentDeliveryReceipts;
  assignment: NativeSubagentAssignment & { terminal: boolean; unanchored?: true };
  turnId?: string;
  observedTurns: Map<string, { awaitingInteraction?: true }>;
  pendingTurns: Array<{
    turnId: string;
    state: NativeTurnState | undefined;
    admittedOwner?: ParentOwner;
    admittedSubmission?: CodexNativeSubagentSubmission;
  }>;
  agentPaths: Set<string>;
};

export type RecoveredCompletion = CodexNativeSubagentCompletion & {
  completedAt?: number;
};

export type ThreadRecovery = {
  parentThreadId?: string;
  agentPath?: string;
  assignmentUnresolved?: true;
  assignmentTurnId?: string;
  nativeTurnId?: string;
  nativeTurnState?: NativeTurnState;
  observedPendingTurns: Array<{ turnId: string; state: NativeTurnState | undefined }>;
  completion?: RecoveredCompletion;
  fallbackCompletion?: RecoveredCompletion;
  resumable: boolean;
  threadState: "unavailable" | "active" | "system_error" | "other";
};

export type ThreadStatusRevision = {
  value: number;
  readers: number;
  terminal?: true;
  parentThreadId?: string;
};

export type TaskRecoveryCandidate = NativeSubagentAssignment & {
  readonly taskId: string;
  terminal: boolean;
  observedTurns: NativeTurnObservation[];
  deliveryReceipts: CodexNativeSubagentDeliveryReceipts;
  parentState: ParentState;
  recoveryAttempt: number;
  requesterSessionKey: string;
  taskRuntimeScope: AgentHarnessTaskRuntimeScope;
  agentId?: string;
  taskRuntime: AgentHarnessTaskRuntime;
};

export type MonitorOptions = {
  recoveryPollDelaysMs?: readonly number[];
  completionDeliveryRetryDelaysMs?: readonly number[];
  completionDeliveryMaxRetries?: number;
  now?: () => number;
  retainClient?: () => (() => void) | undefined;
  retainParentThread?: (threadId: string) => (() => void) | undefined;
  hasObservationBacking?: (parentThreadId: string, childThreadId: string) => boolean;
  claimChildThread?: (threadId: string) => Promise<unknown>;
  retainChildThread?: (threadId: string) => Promise<unknown>;
  releaseChildThread?: (threadId: string) => Promise<unknown>;
  captureChildThreadForget?: (threadId: string) => Promise<(() => void) | undefined>;
};
