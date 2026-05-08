export type JsonObject = Record<string, unknown>;

export type GatewayRequestOptions = {
  expectFinal?: boolean;
  timeoutMs?: number | null;
};

export type GatewayEvent = {
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: unknown;
};

export type OpenClawTransport = {
  request<T = unknown>(
    method: string,
    params?: unknown,
    options?: GatewayRequestOptions,
  ): Promise<T>;
  events(filter?: (event: GatewayEvent) => boolean): AsyncIterable<GatewayEvent>;
  close?(): Promise<void> | void;
};

export type ConnectableOpenClawTransport = OpenClawTransport & {
  connect(): Promise<void>;
};

export type RuntimeSelection =
  | "auto"
  | { type: "embedded"; id: "pi" | "codex" | (string & {}) }
  | { type: "cli"; id: "claude-cli" | (string & {}) }
  | { type: "acp"; harness: "claude" | "cursor" | "gemini" | "opencode" | (string & {}) }
  | { type: "managed"; provider: "local" | "node" | "testbox" | "cloud" | (string & {}) };

export type EnvironmentSelection =
  | { type: "local"; cwd?: string }
  | { type: "gateway"; url?: string; cwd?: string }
  | { type: "node"; nodeId: string; cwd?: string }
  | { type: "managed"; provider: string; repo?: string; ref?: string }
  | { type: "ephemeral"; provider: string; repo?: string; ref?: string };

export type EnvironmentSummary = {
  id: string;
  type: "local" | "gateway" | "node" | "managed" | "ephemeral" | (string & {});
  label?: string;
  status: "available" | "unavailable" | "starting" | "stopping" | "error";
  capabilities?: string[];
};

export type EnvironmentsListResult = {
  environments: EnvironmentSummary[];
};

export type WorkspaceSelection = {
  cwd?: string;
  repo?: string;
  ref?: string;
};

export type ApprovalMode = "ask" | "never" | "auto" | "trusted";

export type RunStatus = "accepted" | "completed" | "failed" | "cancelled" | "timed_out";

export type RunTimestamp = string | number;

export type SDKMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  name?: string;
  toolCallId?: string;
};

export type ArtifactSummary = {
  id: string;
  runId?: string;
  taskId?: string;
  sessionId?: string;
  sessionKey?: string;
  type:
    | "file"
    | "patch"
    | "diff"
    | "log"
    | "media"
    | "screenshot"
    | "trajectory"
    | "pull_request"
    | "workspace"
    | (string & {});
  title?: string;
  mimeType?: string;
  sizeBytes?: number;
  messageSeq?: number;
  source?: string;
  download?: {
    mode: "bytes" | "url" | "unsupported" | (string & {});
  };
  createdAt?: string;
  expiresAt?: string;
};

export type ArtifactQuery =
  | { sessionKey: string; runId?: string; taskId?: string }
  | { runId: string; sessionKey?: string; taskId?: string }
  | { taskId: string; sessionKey?: string; runId?: string };

export type ArtifactsListResult = {
  artifacts: ArtifactSummary[];
};

export type ArtifactsGetResult = {
  artifact: ArtifactSummary;
};

export type ArtifactsDownloadResult = {
  artifact: ArtifactSummary;
  encoding?: "base64";
  data?: string;
  url?: string;
};

export type TaskSummary = {
  id: string;
  runtime: "subagent" | "acp" | "cli" | "cron" | (string & {});
  sourceId?: string;
  sessionKey: string;
  ownerKey: string;
  scope: "session" | "system" | (string & {});
  childSessionKey?: string;
  flowId?: string;
  parentTaskId?: string;
  agentId?: string;
  runId?: string;
  label?: string;
  title: string;
  status: "queued" | "running" | "succeeded" | "failed" | "timed_out" | "cancelled" | "lost";
  deliveryStatus:
    | "pending"
    | "delivered"
    | "session_queued"
    | "failed"
    | "parent_missing"
    | "not_applicable";
  notifyPolicy: "done_only" | "state_changes" | "silent";
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  lastEventAt?: number;
  cleanupAfter?: number;
  error?: string;
  progressSummary?: string;
  terminalSummary?: string;
  terminalOutcome?: "succeeded" | "blocked";
};

export type TaskRunAggregateSummary = {
  total: number;
  active: number;
  terminal: number;
  failures: number;
  byStatus: Record<string, number>;
  byRuntime: Record<string, number>;
};

export type TaskFlowSummary = {
  id: string;
  syncMode: "task_mirrored" | "managed" | (string & {});
  ownerKey: string;
  requesterOrigin?: unknown;
  controllerId?: string;
  revision: number;
  status:
    | "queued"
    | "running"
    | "waiting"
    | "blocked"
    | "succeeded"
    | "failed"
    | "cancelled"
    | "lost";
  notifyPolicy: "done_only" | "state_changes" | "silent";
  goal: string;
  currentStep?: string;
  cancelRequestedAt?: number;
  createdAt: number;
  updatedAt: number;
  endedAt?: number;
};

export type TaskFlowDetail = TaskFlowSummary & {
  state?: unknown;
  wait?: unknown;
  blocked?: {
    taskId?: string;
    summary?: string;
  };
  tasks: TaskSummary[];
  taskSummary: TaskRunAggregateSummary;
};

export type TasksListParams = {
  sessionKey?: string;
  ownerKey?: string;
  agentId?: string;
  runId?: string;
  status?: TaskSummary["status"];
  active?: boolean;
};

export type TasksListResult = {
  tasks: TaskSummary[];
};

export type TasksGetResult = {
  task: TaskSummary;
};

export type TasksCancelResult = {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  task?: TaskSummary;
};

export type TaskFlowsListParams = {
  ownerKey?: string;
  status?: TaskFlowSummary["status"];
  active?: boolean;
};

export type TaskFlowsListResult = {
  flows: TaskFlowDetail[];
};

export type TaskFlowsGetResult = {
  flow: TaskFlowDetail;
};

export type TaskFlowsCancelResult = {
  found: boolean;
  cancelled: boolean;
  reason?: string;
  flow?: TaskFlowDetail;
};

export type AssistantContinueCandidate = {
  taskId: string;
  title: string;
  workspace: string;
  source: string;
  status: string;
  risk: string;
  owner: string;
  allowedActions: string[];
  handoffState: string;
  updatedAt: string;
  reason: string;
  record: Record<string, unknown>;
};

export type AssistantStatusResult = {
  generatedAt: string;
  taskIndexUpdatedAt?: string;
  taskCount: number;
  activeTaskCount: number;
  pendingDecisionCount: number;
  continueCandidateCount: number;
  tasks: Record<string, unknown>[];
  decisions: Record<string, unknown>[];
  continueCandidates: AssistantContinueCandidate[];
  safeSources: string[];
  excludedSources: string[];
  loadErrors: string[];
};

export type AssistantDecisionsListResult = {
  generatedAt: string;
  count: number;
  decisions: Record<string, unknown>[];
  safeSources: string[];
  excludedSources: string[];
  loadErrors: string[];
};

export type AssistantContinueCandidatesResult = {
  generatedAt: string;
  count: number;
  candidates: AssistantContinueCandidate[];
  policy: {
    allowed: string;
    hardBoundary: string;
  };
  safeSources: string[];
  excludedSources: string[];
  loadErrors: string[];
};

export type SDKError = {
  code?: string;
  message: string;
  details?: unknown;
};

export type ToolInvokeParams = {
  args?: JsonObject;
  sessionKey?: string;
  agentId?: string;
  confirm?: boolean;
  idempotencyKey?: string;
};

export type ToolInvokeResult = {
  ok: boolean;
  toolName: string;
  output?: unknown;
  requiresApproval?: boolean;
  approvalId?: string;
  source?: string;
  error?: SDKError;
};

export type RunResult = {
  runId: string;
  status: RunStatus;
  sessionId?: string;
  sessionKey?: string;
  taskId?: string;
  startedAt?: RunTimestamp;
  endedAt?: RunTimestamp;
  output?: {
    text?: string;
    messages?: SDKMessage[];
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    costUsd?: number;
  };
  artifacts?: ArtifactSummary[];
  error?: SDKError;
  raw?: unknown;
};

export type OpenClawEventType =
  | "run.created"
  | "run.queued"
  | "run.started"
  | "run.completed"
  | "run.failed"
  | "run.cancelled"
  | "run.timed_out"
  | "assistant.delta"
  | "assistant.message"
  | "thinking.delta"
  | "tool.call.started"
  | "tool.call.delta"
  | "tool.call.completed"
  | "tool.call.failed"
  | "approval.requested"
  | "approval.resolved"
  | "question.requested"
  | "question.answered"
  | "artifact.created"
  | "artifact.updated"
  | "session.created"
  | "session.updated"
  | "session.compacted"
  | "task.updated"
  | "git.branch"
  | "git.diff"
  | "git.pr"
  | "raw";

export type OpenClawEvent<TData = unknown> = {
  version: 1;
  id: string;
  ts: number;
  type: OpenClawEventType;
  runId?: string;
  sessionId?: string;
  sessionKey?: string;
  taskId?: string;
  agentId?: string;
  data: TData;
  raw?: GatewayEvent;
};

export type AgentRunParams = {
  input: string;
  agentId?: string;
  model?: string;
  thinking?: string;
  sessionId?: string;
  sessionKey?: string;
  deliver?: boolean;
  attachments?: unknown[];
  timeoutMs?: number;
  label?: string;
  runtime?: RuntimeSelection;
  environment?: EnvironmentSelection;
  workspace?: WorkspaceSelection;
  approvals?: ApprovalMode;
  idempotencyKey?: string;
};

export type SessionCreateParams = {
  key?: string;
  agentId?: string;
  label?: string;
  model?: string;
  parentSessionKey?: string;
  task?: string;
  message?: string;
};

export type SessionSendParams = {
  key: string;
  message: string;
  thinking?: string;
  attachments?: unknown[];
  timeoutMs?: number;
  idempotencyKey?: string;
};

export type SessionTarget = {
  key: string;
  sessionId?: string;
  agentId?: string;
  label?: string;
};

export type RunCreateParams = AgentRunParams;
