import type { EmbeddedRunAttemptParamsV2 } from "openclaw/plugin-sdk/agent-harness-runtime";
import type {
  captureAgentHarnessCompletionCustody,
  createAgentHarnessTaskEventSink,
  AgentHarnessCompletionCustody,
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
  AgentHarnessTaskRuntime,
  AgentHarnessTaskRuntimeScope,
  AgentHarnessTaskAssignment,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import type { CodexAppServerClient } from "./client.js";
import type { CodexInferenceThreadQualification } from "./inference-qualification.js";
import type { CodexNativeSubagentDeliveryReceipts } from "./native-subagent-delivery-receipts.js";
import type { CodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import type { CodexNativeSubagentCompletion } from "./native-subagent-notification.js";
import type {
  CodexNativeSubagentSubmission,
  CodexNativeSubagentSubmissionStore,
} from "./native-subagent-submission.js";
import type { NativeSubagentAssignment } from "./native-subagent-task-ids.js";
import type { CodexNativeSubagentTaskMirror } from "./native-subagent-task-mirror.js";

export type NativeSubagentMonitorRuntime = {
  captureAgentHarnessCompletionCustody: typeof captureAgentHarnessCompletionCustody;
  createAgentHarnessTaskEventSink: typeof createAgentHarnessTaskEventSink;
  createAgentHarnessTaskRuntime: typeof createAgentHarnessTaskRuntime;
  deliverAgentHarnessTaskCompletion: typeof deliverAgentHarnessTaskCompletion;
};

export type NativeSubagentMonitorClient = Pick<
  CodexAppServerClient,
  "request" | "addNotificationHandler" | "addCloseHandler" | "getTransportPid"
>;

export type NativeModelSource = NonNullable<
  ReturnType<NonNullable<EmbeddedRunAttemptParamsV2["hostCapabilities"]["retainSourceAuthority"]>>
>;
export type NativeModelBinding = NonNullable<
  ReturnType<NonNullable<NativeModelSource["bindModelExecution"]>>
>;
export type NativeModelMapping = Readonly<{
  nativeModel: Readonly<{ provider: string; model: string }>;
  authorizedModel: Readonly<{ provider: string; model: string }>;
}>;
export type NativeModelSourceCapture = {
  source: NativeModelSource | undefined;
  readonly modelMapping?: NativeModelMapping;
  readonly nativeReviewRequired: boolean;
  recordNativeReviewRequirement: (required: boolean) => void;
  assertCurrent: () => void;
  cancel: () => void;
  release: () => void;
};
export type NativeModelSourceOwner = {
  readonly hasOperatorSource: boolean;
  capture: () => Pick<NativeModelSourceCapture, "source" | "assertCurrent" | "release">;
  release: () => void;
};
export type NativeModelSourceCustody = {
  owner: ParentOwner;
  assertCurrent: () => void;
  release: () => void;
};
export type NativeModelExecution = NativeModelSourceCustody & {
  executionOwner: ParentOwner;
  bindTurn: (turnId: string) => void;
};
export type NativeModelSourceRequest = {
  threadId: string;
  turnId: string;
  parentThreadId?: string;
  parentTurnId?: string;
  rootTurnId?: string;
  signal?: AbortSignal;
};
export type NativeModelInputRequest = {
  threadId: string;
  turnId: string;
  itemId: string;
  targetThreadId: string;
};
export type NativeModelToolInputRequest = Omit<NativeModelInputRequest, "targetThreadId"> & {
  target: string;
  signal?: AbortSignal;
  readQualification: (threadId: string) => CodexInferenceThreadQualification | undefined;
  assertCurrent: () => void;
};

export type ParentOwner = {
  completionCustody?: AgentHarnessCompletionCustody;
  turnId?: string;
  modelSource?: NativeModelSourceOwner;
  modelMapping?: NativeModelMapping;
  configurationQualification?: CodexInferenceThreadQualification;
  nativeInputConfiguration?: true;
  unqualifiedModelExecution?: true;
  claimUnqualifiedModelBinding?: () => NativeModelBinding | undefined;
  interruptModelExecution?: (threadId: string, turnId: string) => void;
  modelExecutionCancelled?: true;
  modelExecutionSettled?: true;
  nativeReviewRequirement?: { required: boolean };
  claimDirectChild?: (threadId: string) => (() => void) | undefined;
  rejectPendingDirectChild?: (threadId: string, reason: string) => void;
  onDirectChildAccepted?: () => void;
};

export type DirectSpawnEvidence = {
  parentThreadId: string;
  childThreadId: string;
  nativeParentThreadId?: string;
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
        modelSource?: NativeModelSourceCustody;
        modelOwner?: ParentOwner;
        /** V1 receipts name model work independently of legacy tool association. */
        modelSourceTurnId?: string;
        modelSourceConsumed?: true;
        /** Unqualified native input cannot borrow a turn from legacy receipt pairing. */
        modelSourceRequiresInference?: true;
        completionCustody?: AgentHarnessCompletionCustody;
      }
  );
export type ParentState = {
  parentThreadId: string;
  // Overlapping runs share this parent; the last owner releases it only after
  // detached children finish recovery and delivery.
  owners: Map<symbol, ParentOwner>;
  modelSourceReferences?: number;
  modelSourceWaiters?: Set<() => void>;
  completedModelTurnsBeforeBinding?: Set<string>;
  // turn/started can precede bindTurn; retain receipt ownership until the
  // foreground run has finalized its reply and releases this registration.
  turnIds: Set<string>;
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
  expectedTask?: AgentHarnessTaskAssignment;
  completionCustody?: AgentHarnessCompletionCustody;
  emitTaskEvent?: ReturnType<typeof createAgentHarnessTaskEventSink>;
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
  modelExecution?: NativeModelExecution;
  cancelledModelTurnId?: string;
};

export type KnownChild = {
  configurationQualification?: CodexInferenceThreadQualification;
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
    modelSource?: NativeModelExecution;
    completionCustody?: AgentHarnessCompletionCustody;
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
  expectedTask: AgentHarnessTaskAssignment;
  completionCustody?: AgentHarnessCompletionCustody;
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
  interruptModelExecution?: (threadId: string, turnId: string) => void;
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
