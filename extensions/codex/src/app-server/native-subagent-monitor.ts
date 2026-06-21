/**
 * Mirrors Codex native subagent lifecycle and completion into OpenClaw task
 * runtime records, with app-server history as the recovery source.
 */
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
  isDurableAgentHarnessCompletionDelivery,
  type AgentHarnessTaskRecord,
  type AgentHarnessTaskRuntime,
  type AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { asFiniteNumber, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { compareCodexAppServerVersions, type CodexAppServerClient } from "./client.js";
import {
  extractCodexNativeSubagentCompletions,
  type CodexNativeSubagentCompletion,
} from "./native-subagent-notification.js";
import {
  CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
  CODEX_NATIVE_SUBAGENT_RUNTIME,
  CODEX_NATIVE_SUBAGENT_TASK_KIND,
} from "./native-subagent-task-ids.js";
import {
  codexNativeSubagentRunId,
  CodexNativeSubagentTaskMirror,
} from "./native-subagent-task-mirror.js";
import type { CodexServerNotification, JsonObject, JsonValue } from "./protocol.js";
import { isJsonObject } from "./protocol.js";

type NativeSubagentMonitorRuntime = {
  createAgentHarnessTaskRuntime: typeof createAgentHarnessTaskRuntime;
  deliverAgentHarnessTaskCompletion: typeof deliverAgentHarnessTaskCompletion;
};

type NativeSubagentMonitorClient = Pick<
  CodexAppServerClient,
  "request" | "addNotificationHandler" | "addCloseHandler" | "getServerVersion"
>;

type ParentState = {
  parentThreadId: string;
  // Overlapping runs share this parent; the last owner releases it only after
  // detached children finish recovery and delivery.
  ownerCount: number;
  requesterSessionKey?: string;
  taskRuntimeScope?: AgentHarnessTaskRuntimeScope;
  agentId?: string;
  taskRuntime?: AgentHarnessTaskRuntime;
  mirror?: CodexNativeSubagentTaskMirror;
};

type ChildState = {
  childThreadId: string;
  parentThreadId: string;
  agentPathKeys: Set<string>;
  recoveryAttempt: number;
  recoveryTimer?: ReturnType<typeof setTimeout>;
  recoveryInFlight?: Promise<boolean>;
  terminal: boolean;
  fallbackCompletion?: CodexNativeSubagentCompletion;
  fallbackEventAt?: number;
  pendingCompletion?: CodexNativeSubagentCompletion;
  completionDeliveryAttempt: number;
  completionDeliveryTimer?: ReturnType<typeof setTimeout>;
  deliveringCompletion: boolean;
  deliveryOwnerKey?: string;
};

type RecoveredCompletion = CodexNativeSubagentCompletion & {
  completedAt?: number;
};

type ThreadRecovery = {
  parentThreadId?: string;
  completion?: RecoveredCompletion;
  fallbackCompletion?: RecoveredCompletion;
  threadState: "unavailable" | "system_error" | "other";
};

type ThreadStatusRevision = {
  value: number;
  readers: number;
};

type TaskRecoveryCandidate = {
  childThreadId: string;
  requesterSessionKey: string;
  taskRuntimeScope: AgentHarnessTaskRuntimeScope;
  agentId?: string;
  taskRuntime: AgentHarnessTaskRuntime;
};

type MonitorOptions = {
  recoveryPollDelaysMs?: readonly number[];
  completionDeliveryRetryDelaysMs?: readonly number[];
  completionDeliveryMaxAttempts?: number;
  now?: () => number;
  retainClient?: () => () => void;
};

const DEFAULT_RECOVERY_POLL_DELAYS_MS = [
  2_000, 5_000, 10_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];
const DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS = [
  5_000, 15_000, 30_000, 60_000, 120_000, 300_000,
];
const RECENT_TERMINAL_TASK_RECONCILE_GRACE_MS = 60_000;
const THREAD_READ_TIMEOUT_MS = 30_000;
const LIVE_THREAD_TURNS_SNAPSHOT_VERSION = "0.139.0";
const NATIVE_SUBAGENT_NOTIFICATION_METHODS = new Set([
  "thread/started",
  "thread/status/changed",
  "item/started",
  "item/completed",
  // App-server exposes no typed terminal subagent result. Keep this one raw
  // boundary until its protocol provides the child's terminal status and text.
  "rawResponseItem/completed",
]);

const defaultRuntime: NativeSubagentMonitorRuntime = {
  createAgentHarnessTaskRuntime,
  deliverAgentHarnessTaskCompletion,
};

const monitors = new WeakMap<CodexAppServerClient, CodexNativeSubagentMonitor>();
const completionDeliveryOwners = new Map<string, ChildState>();

export type CodexNativeSubagentMonitorRegistration = {
  unregister: () => void;
};

/** Registers or updates the sole monitor bound to an app-server client. */
export function registerCodexNativeSubagentMonitor(params: {
  client: CodexAppServerClient;
  parentThreadId: string;
  requesterSessionKey?: string;
  taskRuntimeScope?: AgentHarnessTaskRuntimeScope;
  agentId?: string;
  runtime?: NativeSubagentMonitorRuntime;
  retainClient?: () => () => void;
}): CodexNativeSubagentMonitorRegistration {
  let monitor = monitors.get(params.client);
  if (!monitor) {
    monitor = new CodexNativeSubagentMonitor(params.client, params.runtime ?? defaultRuntime, {
      retainClient: params.retainClient,
    });
    monitors.set(params.client, monitor);
  }
  return monitor.registerParent({
    parentThreadId: params.parentThreadId,
    requesterSessionKey: params.requesterSessionKey,
    taskRuntimeScope: params.taskRuntimeScope,
    agentId: params.agentId,
  });
}

/** Tracks native subagent notifications, history recovery, and parent delivery. */
export class CodexNativeSubagentMonitor {
  private readonly parentStates = new Map<string, ParentState>();
  private readonly childStates = new Map<string, ChildState>();
  private readonly childThreadIdsByAgentPath = new Map<string, string>();
  private readonly taskReconciliations = new Map<string, Promise<void>>();
  private readonly threadStatusRevisions = new Map<string, ThreadStatusRevision>();
  private readonly recoveryPollDelaysMs: readonly number[];
  private readonly completionDeliveryRetryDelaysMs: readonly number[];
  private readonly completionDeliveryMaxAttempts: number;
  private readonly now: () => number;
  private readonly removeNotificationHandler: () => void;
  private readonly removeCloseHandler: () => void;
  private readonly retainClient?: () => () => void;
  private releaseClientRetention?: () => void;
  private disposed = false;

  constructor(
    private readonly client: NativeSubagentMonitorClient,
    private readonly runtime: NativeSubagentMonitorRuntime = defaultRuntime,
    options: MonitorOptions = {},
  ) {
    this.recoveryPollDelaysMs = options.recoveryPollDelaysMs ?? DEFAULT_RECOVERY_POLL_DELAYS_MS;
    this.completionDeliveryRetryDelaysMs =
      options.completionDeliveryRetryDelaysMs ?? DEFAULT_COMPLETION_DELIVERY_RETRY_DELAYS_MS;
    this.completionDeliveryMaxAttempts =
      options.completionDeliveryMaxAttempts ?? this.completionDeliveryRetryDelaysMs.length;
    this.now = options.now ?? Date.now;
    this.retainClient = options.retainClient;
    this.removeNotificationHandler = client.addNotificationHandler(async (notification) => {
      if (!NATIVE_SUBAGENT_NOTIFICATION_METHODS.has(notification.method)) {
        return;
      }
      await this.handleNotification(notification);
    });
    this.removeCloseHandler = client.addCloseHandler(() => this.dispose());
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.removeNotificationHandler();
    this.removeCloseHandler();
    for (const childState of this.childStates.values()) {
      // Terminal delivery no longer needs app-server. Keep its bounded retry
      // alive if idle-pool eviction closes this client between attempts.
      if (childState.terminal && childState.pendingCompletion) {
        this.clearRecoveryTimers(childState);
        continue;
      }
      this.unregisterChild(childState);
    }
    this.releaseClientRetention?.();
    this.releaseClientRetention = undefined;
    for (const state of this.parentStates.values()) {
      state.ownerCount = 0;
    }
    for (const [parentThreadId] of this.parentStates) {
      if (
        ![...this.childStates.values()].some(
          (childState) => childState.parentThreadId === parentThreadId,
        )
      ) {
        this.parentStates.delete(parentThreadId);
      }
    }
  }

  registerParent(params: {
    parentThreadId: string;
    requesterSessionKey?: string;
    taskRuntimeScope?: AgentHarnessTaskRuntimeScope;
    agentId?: string;
  }): CodexNativeSubagentMonitorRegistration {
    const parentThreadId = params.parentThreadId.trim();
    if (!parentThreadId) {
      throw new Error("Codex native subagent monitor requires a parent thread id");
    }
    if (this.disposed) {
      throw new Error("Codex native subagent monitor is closed");
    }
    let state = this.parentStates.get(parentThreadId);
    if (
      state?.requesterSessionKey &&
      params.requesterSessionKey &&
      state.requesterSessionKey !== params.requesterSessionKey
    ) {
      throw new Error(`Codex thread ${parentThreadId} is already bound to another session`);
    }
    if (!state) {
      state = { parentThreadId, ownerCount: 0 };
      this.parentStates.set(parentThreadId, state);
    }
    state.ownerCount += 1;
    state.requesterSessionKey ??= params.requesterSessionKey;
    state.taskRuntimeScope ??= params.taskRuntimeScope;
    state.agentId ??= params.agentId;
    this.prepareParentTaskRuntime(state);
    for (const childState of this.childStates.values()) {
      if (childState.parentThreadId === parentThreadId && childState.pendingCompletion) {
        void this.deliverPendingCompletion(state, childState);
      }
    }
    let registered = true;
    const registeredState = state;
    // Recovery may perform several bounded history reads. It must never delay
    // the foreground parent turn that established this registration.
    void this.reconcileTaskRowsForParent(registeredState).catch((error: unknown) => {
      embeddedAgentLog.warn("Failed to reconcile Codex native subagent task rows", {
        parentThreadId,
        error: formatErrorMessage(error),
      });
    });
    return {
      unregister: () => {
        if (!registered) {
          return;
        }
        registered = false;
        const current = this.parentStates.get(parentThreadId);
        if (current) {
          current.ownerCount -= 1;
          this.pruneParentIfUnused(current);
        }
      },
    };
  }

  private prepareParentTaskRuntime(state: ParentState): void {
    if (!state.requesterSessionKey || !state.taskRuntimeScope) {
      return;
    }
    state.taskRuntime ??= this.runtime.createAgentHarnessTaskRuntime({
      runtime: CODEX_NATIVE_SUBAGENT_RUNTIME,
      taskKind: CODEX_NATIVE_SUBAGENT_TASK_KIND,
      scope: state.taskRuntimeScope,
      runIdPrefix: CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX,
    });
    state.mirror ??= new CodexNativeSubagentTaskMirror(
      {
        parentThreadId: state.parentThreadId,
        requesterSessionKey: state.requesterSessionKey,
        agentId: state.agentId,
      },
      state.taskRuntime,
    );
  }

  /** Handles one notification from the client-wide router observer. */
  private async handleNotification(notification: CodexServerNotification): Promise<void> {
    if (this.disposed) {
      return;
    }
    const state = this.resolveMirrorState(notification);
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const threadId = params ? readString(params, "threadId")?.trim() : undefined;
    const threadStatus = isJsonObject(params?.status)
      ? normalizeIdentifier(readString(params.status, "type"))
      : undefined;
    const tracksThreadStatus = Boolean(threadId && this.threadStatusRevisions.has(threadId));
    if (
      notification.method === "thread/status/changed" &&
      threadId &&
      threadStatus &&
      tracksThreadStatus
    ) {
      this.threadStatusRevisions.get(threadId)!.value += 1;
    }
    if (
      !state &&
      (!threadId ||
        (!this.parentStates.has(threadId) &&
          !this.childStates.has(threadId) &&
          !tracksThreadStatus))
    ) {
      return;
    }
    if (state?.mirror) {
      try {
        state.mirror.handleNotification(notification);
      } catch (error) {
        embeddedAgentLog.warn("Failed to mirror Codex native subagent lifecycle event", {
          method: notification.method,
          error: formatErrorMessage(error),
        });
      }
    }
    if (notification.method === "thread/status/changed" && threadId && threadStatus) {
      const childState = this.childStates.get(threadId);
      if (threadStatus !== "systemerror") {
        if (childState) {
          this.clearSystemErrorFallback(childState);
        }
      } else {
        void this.reconcileChildThread(threadId)
          .catch((error: unknown) => {
            this.logRecoveryFailure(threadId, error);
            return false;
          })
          .then((reconciled) => {
            if (!reconciled && childState && this.childStates.get(threadId) === childState) {
              this.scheduleRecoveryPoll(childState);
            }
          });
      }
    }
    await this.handleCompletionNotification(notification);
  }

  /** Reads one child through app-server history and delivers a terminal result when present. */
  async reconcileChildThread(childThreadIdInput: string): Promise<boolean> {
    const childState = this.childStates.get(childThreadIdInput.trim());
    if (!childState || childState.terminal || this.disposed) {
      return false;
    }
    if (childState.recoveryInFlight) {
      return await childState.recoveryInFlight;
    }
    const recovery = this.reconcileChildState(childState);
    childState.recoveryInFlight = recovery;
    try {
      return await recovery;
    } finally {
      if (childState.recoveryInFlight === recovery) {
        childState.recoveryInFlight = undefined;
      }
    }
  }

  private resolveMirrorState(notification: CodexServerNotification): ParentState | undefined {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    if (!params) {
      return undefined;
    }
    if (notification.method === "thread/started") {
      const thread = isJsonObject(params.thread) ? params.thread : undefined;
      const parentThreadId = readThreadParentThreadId(thread);
      const childThreadId = thread ? readString(thread, "id")?.trim() : undefined;
      const agentPath = readString(readThreadSpawnSource(thread), "agent_path")?.trim();
      const state = parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
      if (state && childThreadId && parentThreadId) {
        return this.registerChildThread(
          parentThreadId,
          childThreadId,
          agentPath === undefined ? {} : { agentPath },
        )
          ? state
          : undefined;
      }
      return state;
    }
    if (notification.method === "thread/status/changed") {
      const childThreadId = readString(params, "threadId")?.trim();
      const parentThreadId = childThreadId
        ? this.childStates.get(childThreadId)?.parentThreadId
        : undefined;
      return parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
    }
    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = isJsonObject(params.item) ? params.item : undefined;
      const parentThreadId = item
        ? (readString(item, "senderThreadId") ?? readString(params, "threadId"))?.trim()
        : undefined;
      const state = parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
      if (state && parentThreadId) {
        const isSpawnAgentTool = normalizeIdentifier(readString(item, "tool")) === "spawnagent";
        const childThreadIds = isSpawnAgentTool
          ? new Set([
              ...readStringArray(item?.receiverThreadIds),
              ...readObjectStringKeys(item?.agentsStates),
            ])
          : new Set(readStringArray(item?.receiverThreadIds));
        let accepted = true;
        for (const childThreadId of childThreadIds) {
          accepted = Boolean(this.registerChildThread(parentThreadId, childThreadId)) && accepted;
        }
        if (!accepted) {
          return undefined;
        }
      }
      return state;
    }
    return undefined;
  }

  private async handleCompletionNotification(notification: CodexServerNotification): Promise<void> {
    const params = isJsonObject(notification.params) ? notification.params : undefined;
    const parentThreadId = params ? readString(params, "threadId")?.trim() : undefined;
    const state = parentThreadId ? this.parentStates.get(parentThreadId) : undefined;
    if (!state) {
      return;
    }
    for (const nativeCompletion of extractCodexNativeSubagentCompletions(notification)) {
      const childThreadId = this.childThreadIdsByAgentPath.get(
        buildParentAgentPathKey(state.parentThreadId, nativeCompletion.agentPath),
      );
      const childState = childThreadId ? this.childStates.get(childThreadId) : undefined;
      if (
        !childState ||
        childState.parentThreadId !== state.parentThreadId ||
        childState.transcriptTerminal
      ) {
        embeddedAgentLog.warn(
          "Ignoring Codex native subagent completion for unknown child thread",
          {
            parentThreadId: state.parentThreadId,
            agentPath: nativeCompletion.agentPath,
          },
        );
        continue;
      }
      const completion: CodexNativeSubagentCompletion = {
        childThreadId: childState.childThreadId,
        status: nativeCompletion.status,
        statusLabel: nativeCompletion.statusLabel,
        result: nativeCompletion.result,
      };
      if (isNoFinalCompletion(completion)) {
        const eventAt = this.now();
        this.setRecoveryFallback(childState, completion, eventAt);
        await this.reconcileChildThread(childState.childThreadId).catch((error: unknown) => {
          this.logRecoveryFailure(childState.childThreadId, error);
          return false;
        });
        continue;
      }
      await this.processCompletion(state, childState, completion);
    }
  }

  private async reconcileChildState(childState: ChildState): Promise<boolean> {
    const state = this.parentStates.get(childState.parentThreadId);
    if (!state) {
      return false;
    }
    const statusRead = this.retainThreadStatusRevision(childState.childThreadId);
    try {
      const recovery = await this.readThreadRecovery(childState.childThreadId);
      // Notification handlers run concurrently. A later status transition wins
      // over this read so stale history cannot complete or re-arm the child.
      if (
        !statusRead.isCurrent() ||
        this.childStates.get(childState.childThreadId) !== childState
      ) {
        return false;
      }
      if (recovery.parentThreadId && recovery.parentThreadId !== childState.parentThreadId) {
        embeddedAgentLog.warn("Codex native subagent parent did not match monitor state", {
          childThreadId: childState.childThreadId,
          expectedParentThreadId: childState.parentThreadId,
          actualParentThreadId: recovery.parentThreadId,
        });
        this.unregisterChild(childState);
        return false;
      }
      if (recovery.threadState === "other") {
        this.clearSystemErrorFallback(childState);
      }
      const completion = recovery.completion;
      if (!completion) {
        if (recovery.fallbackCompletion) {
          this.setRecoveryFallback(
            childState,
            recovery.fallbackCompletion,
            recovery.fallbackCompletion.completedAt ?? this.now(),
          );
        }
        return false;
      }
      if (isNoFinalCompletion(completion)) {
        this.setRecoveryFallback(childState, completion, completion.completedAt ?? this.now());
        return false;
      }
      await this.processCompletion(state, childState, completion, completion.completedAt);
      return true;
    } finally {
      statusRead.release();
    }
  }

  private requestThreadRead(childThreadId: string, includeTurns: boolean) {
    return this.client.request(
      "thread/read",
      {
        threadId: childThreadId,
        includeTurns,
      },
      {
        timeoutMs: THREAD_READ_TIMEOUT_MS,
      },
    );
  }

  private requestLatestThreadTurn(childThreadId: string) {
    return this.client.request(
      "thread/turns/list",
      {
        threadId: childThreadId,
        limit: 1,
        sortDirection: "desc",
        itemsView: "full",
      },
      { timeoutMs: THREAD_READ_TIMEOUT_MS },
    );
  }

  private async readThreadRecovery(childThreadId: string): Promise<ThreadRecovery> {
    // Fresh threads can expose lineage before includeTurns history is materialized.
    // Register that lineage now so the normal child backoff owns later full reads.
    const response = await this.requestThreadRead(childThreadId, true).catch(() =>
      this.requestThreadRead(childThreadId, false),
    );
    const thread = isJsonObject(response.thread) ? response.thread : undefined;
    if (!thread || readString(thread, "id")?.trim() !== childThreadId) {
      return { threadState: "unavailable" };
    }
    const threadStatus = isJsonObject(thread.status)
      ? normalizeIdentifier(readString(thread.status, "type"))
      : undefined;
    let completion: RecoveredCompletion | undefined;
    let fallbackCompletion: RecoveredCompletion | undefined;
    if (threadStatus === "active") {
      completion = undefined;
    } else if (threadStatus === "systemerror") {
      const version = this.client.getServerVersion();
      // Codex 0.139 makes thread/turns/list merge the live active snapshot.
      // Older custom binaries cannot safely distinguish it from stale history.
      if (
        version &&
        compareCodexAppServerVersions(version, LIVE_THREAD_TURNS_SNAPSHOT_VERSION) >= 0
      ) {
        const turnsResponse = await this.requestLatestThreadTurn(childThreadId).catch(
          () => undefined,
        );
        const data =
          isJsonObject(turnsResponse) && Array.isArray(turnsResponse.data)
            ? turnsResponse.data
            : [];
        const latestTurn = isJsonObject(data[0]) ? data[0] : undefined;
        completion = latestTurn ? readTurnCompletion(latestTurn, childThreadId) : undefined;
      } else {
        // Older supported app-servers cannot merge the live turn into thread/read.
        // Retry first, then deliver this typed failure instead of pinning the client forever.
        fallbackCompletion = systemErrorFallbackCompletion(childThreadId);
      }
    } else {
      completion = readThreadCompletion(thread, childThreadId);
    }
    return {
      parentThreadId: readThreadParentThreadId(thread),
      completion,
      fallbackCompletion,
      threadState:
        threadStatus === "systemerror" ? "system_error" : threadStatus ? "other" : "unavailable",
    };
  }

  private async processCompletion(
    state: ParentState,
    childState: ChildState,
    completion: CodexNativeSubagentCompletion,
    eventAt: number = this.now(),
  ): Promise<void> {
    if (childState.terminal) {
      return;
    }
    if (!this.claimCompletionDelivery(state, childState)) {
      this.unregisterChild(childState);
      return;
    }
    childState.terminal = true;
    this.clearRecoveryTimers(childState);
    state.mirror?.markAuthoritativeCompletion(completion.childThreadId);
    state.taskRuntime?.finalizeTaskRunByRunId({
      runId: codexNativeSubagentRunId(completion.childThreadId),
      status: completion.status,
      endedAt: eventAt,
      lastEventAt: eventAt,
      ...(completion.status === "succeeded" ? {} : { error: completion.result }),
      progressSummary: completion.result,
      terminalSummary: completion.result,
    });
    if (!state.requesterSessionKey) {
      this.unregisterChild(childState);
      return;
    }
    childState.pendingCompletion = completion;
    state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
      runId: codexNativeSubagentRunId(completion.childThreadId),
      deliveryStatus: "pending",
    });
    this.releaseClientRetentionIfIdle();
    await this.deliverPendingCompletion(state, childState);
  }

  private async deliverPendingCompletion(
    state: ParentState,
    childState: ChildState,
  ): Promise<void> {
    const completion = childState.pendingCompletion;
    if (!completion || !state.requesterSessionKey || !state.taskRuntimeScope) {
      return;
    }
    if (childState.deliveringCompletion) {
      return;
    }
    childState.deliveringCompletion = true;
    try {
      const delivery = await this.runtime.deliverAgentHarnessTaskCompletion({
        scope: state.taskRuntimeScope,
        childSessionKey: codexNativeSubagentRunId(completion.childThreadId),
        childSessionId: completion.childThreadId,
        announceId: `codex-native:${state.parentThreadId}:${completion.childThreadId}:${completion.status}`,
        announceType: "Codex native subagent",
        taskLabel: "Codex native subagent",
        status: completion.status,
        statusLabel: completion.statusLabel,
        result: completion.result,
        replyInstruction:
          "Use the Codex native subagent result to continue or wrap up the parent task. If this is a Discord/channel session, send the visible response with the message tool instead of only writing a transcript final answer. Reply in your normal assistant voice and do not expose internal notification markup.",
      });
      if (isDurableAgentHarnessCompletionDelivery(delivery)) {
        childState.pendingCompletion = undefined;
        childState.completionDeliveryAttempt = 0;
        state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
          runId: codexNativeSubagentRunId(completion.childThreadId),
          deliveryStatus: "delivered",
        });
        this.unregisterChild(childState);
        return;
      }
      const error = delivery.error ?? "completion delivery did not produce a parent response";
      state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
        runId: codexNativeSubagentRunId(completion.childThreadId),
        deliveryStatus: "pending",
        error,
      });
      this.scheduleCompletionDeliveryRetry(childState);
    } catch (error) {
      state.taskRuntime?.setDetachedTaskDeliveryStatusByRunId({
        runId: codexNativeSubagentRunId(completion.childThreadId),
        deliveryStatus: "pending",
        error: formatErrorMessage(error),
      });
      this.scheduleCompletionDeliveryRetry(childState);
      embeddedAgentLog.warn("Failed to deliver Codex native subagent completion", {
        parentThreadId: state.parentThreadId,
        childThreadId: completion.childThreadId,
        error: formatErrorMessage(error),
      });
    } finally {
      childState.deliveringCompletion = false;
    }
  }

  private scheduleCompletionDeliveryRetry(childState: ChildState): void {
    if (
      !childState.pendingCompletion ||
      childState.completionDeliveryTimer ||
      this.childStates.get(childState.childThreadId) !== childState
    ) {
      return;
    }
    if (childState.completionDeliveryAttempt >= this.completionDeliveryMaxAttempts) {
      this.unregisterChild(childState);
      return;
    }
    const delayMs = delayForAttempt(
      this.completionDeliveryRetryDelaysMs,
      childState.completionDeliveryAttempt++,
    );
    childState.completionDeliveryTimer = setTimeout(() => {
      childState.completionDeliveryTimer = undefined;
      if (this.childStates.get(childState.childThreadId) !== childState) {
        return;
      }
      const state = this.parentStates.get(childState.parentThreadId);
      if (state) {
        void this.deliverPendingCompletion(state, childState);
      }
    }, delayMs);
    unrefTimer(childState.completionDeliveryTimer);
  }

  private registerChildThread(
    parentThreadIdInput: string,
    childThreadIdInput: string,
    options: { agentPath?: string } = {},
  ): ChildState | undefined {
    const parentThreadId = parentThreadIdInput.trim();
    const childThreadId = childThreadIdInput.trim();
    if (!parentThreadId || !childThreadId || this.disposed) {
      return undefined;
    }
    let childState = this.childStates.get(childThreadId);
    if (childState && childState.parentThreadId !== parentThreadId) {
      embeddedAgentLog.warn("Ignoring Codex native subagent child reparenting", {
        childThreadId,
        existingParentThreadId: childState.parentThreadId,
        attemptedParentThreadId: parentThreadId,
      });
      return undefined;
    }
    if (!childState) {
      this.releaseClientRetention ??= this.retainClient?.();
      childState = {
        childThreadId,
        parentThreadId,
        agentPathKeys: new Set<string>(),
        recoveryAttempt: 0,
        terminal: false,
        completionDeliveryAttempt: 0,
        deliveringCompletion: false,
      };
      this.childStates.set(childThreadId, childState);
      this.threadStatusRevisions.set(
        childThreadId,
        this.threadStatusRevisions.get(childThreadId) ?? { value: 0, readers: 0 },
      );
    }
    this.registerAgentPath(childState, childThreadId);
    this.parentStates
      .get(parentThreadId)
      ?.mirror?.markAuthoritativeCompletionExpected(childThreadId);
    const agentPath = normalizeOptionalString(options.agentPath);
    if (agentPath) {
      this.registerAgentPath(childState, agentPath);
    }
    this.scheduleRecoveryPoll(childState);
    return childState;
  }

  private registerAgentPath(childState: ChildState, agentPath: string): void {
    const key = buildParentAgentPathKey(childState.parentThreadId, agentPath);
    const existingChild = this.childThreadIdsByAgentPath.get(key);
    if (existingChild && existingChild !== childState.childThreadId) {
      embeddedAgentLog.warn("Ignoring conflicting Codex native subagent agent path", {
        parentThreadId: childState.parentThreadId,
        agentPath,
        existingChildThreadId: existingChild,
        attemptedChildThreadId: childState.childThreadId,
      });
      return;
    }
    this.childThreadIdsByAgentPath.set(key, childState.childThreadId);
    childState.agentPathKeys.add(key);
  }

  private unregisterChild(childState: ChildState): void {
    this.clearRecoveryTimers(childState);
    if (childState.completionDeliveryTimer) {
      clearTimeout(childState.completionDeliveryTimer);
    }
    const deliveryOwnerKey = childState.deliveryOwnerKey;
    if (deliveryOwnerKey && completionDeliveryOwners.get(deliveryOwnerKey) === childState) {
      completionDeliveryOwners.delete(deliveryOwnerKey);
    }
    childState.deliveryOwnerKey = undefined;
    for (const key of childState.agentPathKeys) {
      if (this.childThreadIdsByAgentPath.get(key) === childState.childThreadId) {
        this.childThreadIdsByAgentPath.delete(key);
      }
    }
    if (this.childStates.get(childState.childThreadId) === childState) {
      this.childStates.delete(childState.childThreadId);
    }
    const statusRevision = this.threadStatusRevisions.get(childState.childThreadId);
    if (statusRevision?.readers === 0) {
      this.threadStatusRevisions.delete(childState.childThreadId);
    }
    this.releaseClientRetentionIfIdle();
    const state = this.parentStates.get(childState.parentThreadId);
    if (state) {
      this.pruneParentIfUnused(state);
    }
  }

  private releaseClientRetentionIfIdle(): void {
    if ([...this.childStates.values()].some((childState) => !childState.terminal)) {
      return;
    }
    this.releaseClientRetention?.();
    this.releaseClientRetention = undefined;
  }

  private claimCompletionDelivery(state: ParentState, childState: ChildState): boolean {
    const requesterSessionKey = state.requesterSessionKey?.trim();
    if (!requesterSessionKey) {
      return true;
    }
    const key = `${requesterSessionKey}\0${childState.childThreadId}`;
    const owner = completionDeliveryOwners.get(key);
    if (owner) {
      return owner === childState;
    }
    const runId = codexNativeSubagentRunId(childState.childThreadId);
    if (
      state.taskRuntime
        ?.listTaskRecords()
        .some((task) => task.runId === runId && task.deliveryStatus === "delivered")
    ) {
      return false;
    }
    // Delivery no longer needs the app-server client. Keep one process owner
    // across client replacement so fallback steering cannot inject twice.
    completionDeliveryOwners.set(key, childState);
    childState.deliveryOwnerKey = key;
    return true;
  }

  private pruneParentIfUnused(state: ParentState): void {
    if (state.ownerCount > 0) {
      return;
    }
    for (const childState of this.childStates.values()) {
      if (childState.parentThreadId === state.parentThreadId) {
        return;
      }
    }
    if (this.parentStates.get(state.parentThreadId) === state) {
      this.parentStates.delete(state.parentThreadId);
    }
  }

  private scheduleRecoveryPoll(childState: ChildState): void {
    if (
      childState.terminal ||
      childState.recoveryTimer ||
      this.disposed ||
      this.recoveryPollDelaysMs.length === 0
    ) {
      return;
    }
    const delayMs = delayForAttempt(this.recoveryPollDelaysMs, childState.recoveryAttempt++);
    childState.recoveryTimer = setTimeout(() => {
      childState.recoveryTimer = undefined;
      void this.reconcileChildThread(childState.childThreadId)
        .catch((error: unknown) => {
          this.logRecoveryFailure(childState.childThreadId, error);
          return false;
        })
        .then(async (reconciled) => {
          if (reconciled || this.childStates.get(childState.childThreadId) !== childState) {
            return;
          }
          const fallback = childState.fallbackCompletion;
          const state = this.parentStates.get(childState.parentThreadId);
          // Give thread/read two persistence windows before delivering the
          // typed no-final result; otherwise a just-written final can be lost.
          if (fallback && state && childState.recoveryAttempt >= 2) {
            await this.processCompletion(
              state,
              childState,
              fallback,
              childState.fallbackEventAt ?? this.now(),
            );
            return;
          }
          this.scheduleRecoveryPoll(childState);
        });
    }, delayMs);
    unrefTimer(childState.recoveryTimer);
  }

  private setRecoveryFallback(
    childState: ChildState,
    completion: CodexNativeSubagentCompletion,
    eventAt: number,
  ): void {
    if (childState.terminal || childState.fallbackCompletion) {
      return;
    }
    if (childState.recoveryTimer) {
      clearTimeout(childState.recoveryTimer);
      childState.recoveryTimer = undefined;
    }
    childState.recoveryAttempt = 0;
    childState.fallbackCompletion = completion;
    childState.fallbackEventAt = eventAt;
    this.scheduleRecoveryPoll(childState);
  }

  private clearSystemErrorFallback(childState: ChildState): void {
    if (childState.fallbackCompletion?.statusLabel !== "system_error") {
      return;
    }
    childState.fallbackCompletion = undefined;
    childState.fallbackEventAt = undefined;
  }

  private retainThreadStatusRevision(threadId: string): {
    isCurrent: () => boolean;
    release: () => void;
  } {
    const revision = this.threadStatusRevisions.get(threadId) ?? { value: 0, readers: 0 };
    this.threadStatusRevisions.set(threadId, revision);
    revision.readers += 1;
    const capturedValue = revision.value;
    let retained = true;
    return {
      isCurrent: () =>
        this.threadStatusRevisions.get(threadId) === revision && revision.value === capturedValue,
      release: () => {
        if (!retained) {
          return;
        }
        retained = false;
        revision.readers -= 1;
        if (
          revision.readers === 0 &&
          !this.childStates.has(threadId) &&
          this.threadStatusRevisions.get(threadId) === revision
        ) {
          this.threadStatusRevisions.delete(threadId);
        }
      },
    };
  }

  private clearRecoveryTimers(childState: ChildState): void {
    if (childState.recoveryTimer) {
      clearTimeout(childState.recoveryTimer);
      childState.recoveryTimer = undefined;
    }
  }

  private async reconcileTaskRowsForParent(state: ParentState): Promise<void> {
    if (
      this.disposed ||
      this.parentStates.get(state.parentThreadId) !== state ||
      !state.taskRuntime ||
      !state.requesterSessionKey ||
      !state.taskRuntimeScope
    ) {
      return;
    }
    // The scoped runtime already filters runtime, task kind, and run-id prefix.
    // Keep the session check because multiple parents can share one client.
    const candidates = new Map<string, TaskRecoveryCandidate>();
    for (const task of state.taskRuntime.listTaskRecords()) {
      if (
        task.requesterSessionKey !== state.requesterSessionKey ||
        !this.shouldReconcileCodexNativeTask(task)
      ) {
        continue;
      }
      const childThreadId = task.runId!.slice(CODEX_NATIVE_SUBAGENT_RUN_ID_PREFIX.length).trim();
      candidates.set(childThreadId, {
        requesterSessionKey: state.requesterSessionKey,
        childThreadId,
        taskRuntimeScope: state.taskRuntimeScope,
        agentId: state.agentId,
        taskRuntime: state.taskRuntime,
      });
    }
    for (const candidate of candidates.values()) {
      await this.reconcileTaskCandidate(candidate);
    }
  }

  private async reconcileTaskCandidate(candidate: TaskRecoveryCandidate): Promise<void> {
    const key = `${candidate.requesterSessionKey}\0${candidate.childThreadId}`;
    const existing = this.taskReconciliations.get(key);
    if (existing) {
      await existing;
      return;
    }
    // Hold single-flight through delivery. Releasing after the read lets a slower
    // reconcile recreate a just-pruned child and deliver the same result twice.
    const reconciliation = this.reconcileTaskCandidateOnce(candidate);
    this.taskReconciliations.set(key, reconciliation);
    try {
      await reconciliation;
    } finally {
      if (this.taskReconciliations.get(key) === reconciliation) {
        this.taskReconciliations.delete(key);
      }
    }
  }

  private async reconcileTaskCandidateOnce(candidate: TaskRecoveryCandidate): Promise<void> {
    const childBeforeRead = this.childStates.get(candidate.childThreadId);
    const statusRead = this.retainThreadStatusRevision(candidate.childThreadId);
    try {
      let recovery: ThreadRecovery;
      try {
        recovery = await this.readThreadRecovery(candidate.childThreadId);
      } catch (error) {
        this.logRecoveryFailure(candidate.childThreadId, error);
        return;
      }
      if (
        !statusRead.isCurrent() ||
        this.childStates.get(candidate.childThreadId) !== childBeforeRead
      ) {
        return;
      }
      const parentThreadId = recovery.parentThreadId;
      if (!parentThreadId) {
        return;
      }
      let state = this.parentStates.get(parentThreadId);
      if (state && state.requesterSessionKey !== candidate.requesterSessionKey) {
        return;
      }
      if (!state) {
        // A requester-scoped task row survives Codex parent rotation. thread/read
        // restores that old lineage; an existing foreign requester above still wins.
        state = {
          parentThreadId,
          ownerCount: 0,
          requesterSessionKey: candidate.requesterSessionKey,
          taskRuntimeScope: candidate.taskRuntimeScope,
          agentId: candidate.agentId,
          taskRuntime: candidate.taskRuntime,
        };
        this.prepareParentTaskRuntime(state);
        this.parentStates.set(parentThreadId, state);
      }
      const childState = this.registerChildThread(parentThreadId, candidate.childThreadId);
      if (!childState) {
        this.pruneParentIfUnused(state);
        return;
      }
      if (recovery.threadState === "other") {
        this.clearSystemErrorFallback(childState);
      }
      const completion = recovery.completion;
      if (!completion) {
        if (recovery.fallbackCompletion) {
          this.setRecoveryFallback(
            childState,
            recovery.fallbackCompletion,
            recovery.fallbackCompletion.completedAt ?? this.now(),
          );
          return;
        }
        this.scheduleRecoveryPoll(childState);
        return;
      }
      if (isNoFinalCompletion(completion)) {
        this.setRecoveryFallback(childState, completion, completion.completedAt ?? this.now());
        return;
      }
      await this.processCompletion(state, childState, completion, completion.completedAt);
    } finally {
      statusRead.release();
    }
  }

  private shouldReconcileCodexNativeTask(task: AgentHarnessTaskRecord): boolean {
    if (task.status === "running" || task.deliveryStatus === "pending") {
      return true;
    }
    if (task.deliveryStatus !== "not_applicable" || task.endedAt === undefined) {
      return false;
    }
    return task.endedAt >= this.now() - RECENT_TERMINAL_TASK_RECONCILE_GRACE_MS;
  }

  private logRecoveryFailure(childThreadId: string, error: unknown): void {
    embeddedAgentLog.debug("Codex native subagent history is not ready", {
      childThreadId,
      error: formatErrorMessage(error),
    });
  }
}

function readThreadCompletion(
  thread: JsonObject,
  childThreadId: string,
): RecoveredCompletion | undefined {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (!isJsonObject(turn)) {
      continue;
    }
    return readTurnCompletion(turn, childThreadId);
  }
  return undefined;
}

function systemErrorFallbackCompletion(childThreadId: string): RecoveredCompletion {
  return {
    childThreadId,
    status: "failed",
    statusLabel: "system_error",
    result: "Codex app-server reported a system error for the native subagent thread.",
  };
}

function readTurnCompletion(
  turn: JsonObject,
  childThreadId: string,
): RecoveredCompletion | undefined {
  const status = normalizeIdentifier(readString(turn, "status"));
  if (status === "inprogress" || !status) {
    return undefined;
  }
  const result = readLastAgentMessage(turn);
  const completedAtSeconds = asFiniteNumber(turn.completedAt);
  const completedAt =
    completedAtSeconds === undefined ? undefined : Math.round(completedAtSeconds * 1_000);
  if (status === "completed") {
    return {
      childThreadId,
      status: "succeeded",
      statusLabel: result ? "task_complete" : "completed_without_final_message",
      result: result ?? "Codex native subagent completed without a final assistant message.",
      completedAt,
    };
  }
  if (status === "interrupted") {
    return {
      childThreadId,
      status: "cancelled",
      statusLabel: "task_interrupted",
      result: result ?? "Codex native subagent was interrupted.",
      completedAt,
    };
  }
  if (status === "failed") {
    const turnError = turn.error;
    const error = isJsonObject(turnError) ? readString(turnError, "message")?.trim() : undefined;
    return {
      childThreadId,
      status: "failed",
      statusLabel: "task_failed",
      result: result ?? error ?? "Codex native subagent failed.",
      completedAt,
    };
  }
  return undefined;
}

function readLastAgentMessage(turn: JsonObject): string | undefined {
  const items = Array.isArray(turn.items) ? turn.items : [];
  let legacyResult: string | undefined;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (!isJsonObject(item)) {
      continue;
    }
    if (normalizeIdentifier(readString(item, "type")) !== "agentmessage") {
      continue;
    }
    const text = readString(item, "text")?.trim();
    if (!text) {
      continue;
    }
    const phase = normalizeIdentifier(readString(item, "phase"));
    if (phase === "finalanswer") {
      return text;
    }
    if (!phase) {
      legacyResult ??= text;
    }
  }
  return legacyResult;
}

function toChildTurnCompletion(
  childState: ChildState,
  turn: JsonObject,
): CodexNativeSubagentCompletion | undefined {
  const status = readString(turn, "status");
  if (status === "completed") {
    const turnId = readString(turn, "id");
    const result = turnId ? lastChildAssistantMessage(childState, turnId) : undefined;
    return {
      childThreadId: childState.childThreadId,
      status: "succeeded",
      statusLabel: result ? "turn_completed" : "completed_without_final_message",
      result: result ?? "Codex native subagent completed without a final assistant message.",
    };
  }
  if (status === "failed") {
    return {
      childThreadId: childState.childThreadId,
      status: "failed",
      statusLabel: "turn_failed",
      result: readTurnErrorMessage(turn) ?? "Codex native subagent failed.",
    };
  }
  return undefined;
}

function lastChildAssistantMessage(childState: ChildState, turnId: string): string | undefined {
  const assistantMessages = childState.assistantMessagesByTurn.get(turnId);
  if (!assistantMessages) {
    return undefined;
  }
  for (let index = assistantMessages.order.length - 1; index >= 0; index -= 1) {
    const itemId = assistantMessages.order[index];
    if (
      assistantMessages.finalMessageIds.has(itemId) &&
      !assistantMessages.commentaryIds.has(itemId)
    ) {
      const text = normalizeOptionalString(assistantMessages.texts.get(itemId));
      if (text) {
        return text;
      }
    }
  }
  return undefined;
}

function readTurnErrorMessage(turn: JsonObject): string | undefined {
  const error = isJsonObject(turn.error) ? turn.error : undefined;
  return (
    normalizeOptionalString(readString(error, "message")) ??
    normalizeOptionalString(
      isJsonObject(error?.codexErrorInfo) ? readString(error.codexErrorInfo, "message") : undefined,
    )
  );
}

function buildParentAgentPathKey(parentThreadId: string, agentPath: string): string {
  return `${parentThreadId}\0${agentPath}`;
}

function isNoFinalCompletion(completion: CodexNativeSubagentCompletion): boolean {
  return (
    completion.status === "succeeded" &&
    completion.statusLabel === "completed_without_final_message"
  );
}

function delayForAttempt(delays: readonly number[], attempt: number): number {
  return Math.max(1, delays[Math.min(attempt, delays.length - 1)] ?? 1);
}

function readThreadParentThreadId(thread: JsonObject | undefined): string | undefined {
  return (
    readString(thread, "parentThreadId")?.trim() ??
    readString(readThreadSpawnSource(thread), "parent_thread_id")?.trim()
  );
}

function readThreadSpawnSource(thread: JsonObject | undefined): JsonObject | undefined {
  const source = isJsonObject(thread?.source) ? thread.source : undefined;
  const subAgent = isJsonObject(source?.subAgent) ? source.subAgent : undefined;
  return isJsonObject(subAgent?.thread_spawn) ? subAgent.thread_spawn : undefined;
}

function readString(record: JsonObject | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}

function readObjectStringKeys(value: JsonValue | undefined): string[] {
  return isJsonObject(value) ? Object.keys(value).filter((entry) => entry.trim() !== "") : [];
}

function normalizeIdentifier(value: string | undefined): string | undefined {
  return value?.replace(/[^a-z0-9]/giu, "").toLowerCase();
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  if (typeof timer === "object" && timer && "unref" in timer) {
    (timer as { unref: () => void }).unref();
  }
}
