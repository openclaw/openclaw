import type { Server } from "node:http";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginHookToolRequesterContext } from "../../plugins/hook-types.js";
import type {
  BeforeToolCallFailureDisposition,
  DeferredPluginToolApproval,
  HookContext,
} from "../agent-tools.before-tool-call.js";
import type { CodexMcpServersConfig } from "../codex-mcp-config.types.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import type { retainBeforeToolCallForNativeHookRelay } from "./host-private-capabilities.js";
import type {
  NativeHookRelayDeferredApprovalOutcome,
  NativeHookRelayEvent,
  NativeHookRelayInvocation,
  NativeHookRelayPermissionApprovalResult,
  NativeHookRelayProvider,
} from "./native-hook-relay-types.js";

type NativeHookRelayApprovalContext = Pick<
  HookContext,
  | "approvalReviewerDeviceId"
  | "trigger"
  | "turnSourceAccountId"
  | "turnSourceChannel"
  | "turnSourceThreadId"
  | "turnSourceTo"
>;

export type NativeHookRelayRegistration = {
  relayId: string;
  provider: NativeHookRelayProvider;
  generationMismatchGraceExpiresAtMs?: number;
  generationMismatchGraceAcceptedGeneration?: string;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  deferMcpToolApprovals?: boolean;
  runId: string;
  channelId?: string;
  requester?: PluginHookToolRequesterContext;
  approvalContext?: NativeHookRelayApprovalContext;
  allowedEvents: readonly NativeHookRelayEvent[];
  /** Keep host policy active for every native tool even without plugin hooks. */
  requirePreToolUse?: boolean;
  /** Wall-clock epoch expiry shared through the cross-process bridge record. */
  expiresAtMs: number;
  signal?: AbortSignal;
  /** Exact host policy capability for authority-bearing native callbacks. */
  runBeforeToolCall?: AgentHarnessHostCapabilities["runBeforeToolCall"];
  /** Foreground-only approval authority supplied by the admitted bundled host. */
  approvalHost?: Pick<AgentHarnessHostCapabilities, "requestApproval" | "waitForApproval">;
  /** Revalidates the exact admitted owner after authority-bearing awaits. */
  assertActive?: AgentHarnessHostCapabilities["assertActive"];
  /** Reads worker-owned execution policy before returning permission to the native runtime. */
  assertActiveAsync?: () => Promise<void>;
  onPreToolUseFailure?: (failure: {
    toolName: string;
    toolCallId: string;
    disposition: Exclude<BeforeToolCallFailureDisposition, "blocked">;
    durationMs: number;
  }) => void | Promise<void>;
};

export type NativeHookRelayRegistrationHandle = NativeHookRelayRegistration & {
  generation?: string;
  shouldRelayEvent: (event: NativeHookRelayEvent) => boolean;
  toolMatcherForEvent: (event: NativeHookRelayEvent) => readonly string[] | undefined;
  commandForEvent: (
    event: NativeHookRelayEvent,
    options?: NativeHookRelayCommandForEventOptions,
  ) => string;
  renew: (ttlMs?: number) => void;
  unregister: () => void;
};

export type RegisterNativeHookRelayParams = {
  provider: NativeHookRelayProvider;
  relayId?: string;
  generation?: string;
  generationMismatchGraceMs?: number;
  agentId?: string;
  sessionId: string;
  sessionKey?: string;
  config?: OpenClawConfig;
  autoApproveMcpTools?: boolean;
  projectedMcpServers?: CodexMcpServersConfig;
  runId: string;
  channelId?: string;
  requester?: PluginHookToolRequesterContext;
  approvalContext?: NativeHookRelayApprovalContext;
  allowedEvents?: readonly NativeHookRelayEvent[];
  /** Whether this relay should run OpenClaw loop detection from native PreToolUse hooks. */
  preToolUseLoopDetection?: boolean;
  /** Never prune the all-tool PreToolUse policy relay. Requires runBeforeToolCall. */
  requirePreToolUse?: boolean;
  ttlMs?: number;
  command?: NativeHookRelayCommandOptions;
  signal?: AbortSignal;
  runBeforeToolCall?: NativeHookRelayRegistration["runBeforeToolCall"];
  assertActive?: NativeHookRelayRegistration["assertActive"];
  assertActiveAsync?: NativeHookRelayRegistration["assertActiveAsync"];
  onPreToolUseFailure?: NativeHookRelayRegistration["onPreToolUseFailure"];
};

type NativeHookRelayCommandOptions = {
  executable?: string;
  nice?: number | false;
  nodeExecutable?: string;
  timeoutMs?: number;
};

type NativeHookRelayCommandForEventOptions = {
  timeoutMs?: number;
  remoteCredentialPath?: string;
};

export type ActiveNativeHookRelayRegistration = NativeHookRelayRegistration & {
  generation: string;
  preToolUseLoopDetection: boolean;
  preToolUseFailureProjections: Map<string, { promise: Promise<void>; settled: boolean }>;
};

export type ActiveNativeHookRelayRegistrationHandle = NativeHookRelayRegistrationHandle & {
  generation: string;
};

export type OwnedNativeHookRelayRegistrationHandle = ActiveNativeHookRelayRegistrationHandle & {
  /** Bind native foreground callbacks to the accepted turn of this run. */
  bindForegroundTurn: (threadId: string, turnId: string) => void;
  /** Explicitly expose only this registration through the token-scoped HTTP callback. */
  enableRemoteCallback: () => { token: string };
  /** Strict policy preparation and direct publication result. */
  ready: Promise<void>;
  /** Requires current foreground authority; direct publication may use the Gateway fallback. */
  prepareInvocation: () => Promise<void>;
  /** Joins accepted policy, publication, renewal and cleanup without retiring retained children. */
  drain: () => Promise<void>;
};

export type NativeHookRelayPendingPermissionApproval = {
  relayId: string;
  promise: Promise<NativeHookRelayPermissionApprovalResult>;
  controller: AbortController;
  waiters: number;
  cancelWhenUnobserved: boolean;
};

export type NativeHookRelayPreToolUseApproval = {
  relayId: string;
  deferredApproval: DeferredPluginToolApproval;
  originalParamsFingerprint: string;
  resolutionPromise?: Promise<NativeHookRelayDeferredApprovalOutcome>;
};

export type NativeHookRelayBridgeRegistration = {
  relayId: string;
  stateDbPath: string;
  token: string;
  server: Server;
  ready: Promise<void>;
  pending: Promise<void>;
  cancelStartup: () => void;
  closing?: Promise<void>;
  remoteEnabled?: boolean;
};

export type NativeHookRelaySharedState = {
  relays: Map<string, ActiveNativeHookRelayRegistration>;
  relayBridges: Map<string, NativeHookRelayBridgeRegistration>;
  pendingOperations: Set<Promise<unknown>>;
  invocations: NativeHookRelayInvocation[];
  pendingPermissionApprovals: Map<string, NativeHookRelayPendingPermissionApproval>;
  pendingPreToolUseApprovals: Map<string, NativeHookRelayPreToolUseApproval>;
  permissionApprovalWindows: Map<string, number[]>;
  permissionAllowAlwaysApprovals: Map<string, { relayId: string; expiresAtMs?: number }>;
};

/** Private bundled-runtime callbacks for retained direct-child hook policy. */
type NativeHookRelayRetention = Readonly<{
  readClaim: (rawPayload: unknown) => string | undefined;
  shouldRetainAfterForegroundClose: () => boolean;
  allowPreToolUse: (claim: string) => boolean;
  awaitForegroundAdmission?: (
    claim: string,
    signal?: AbortSignal,
  ) => Promise<(() => boolean) | undefined>;
  onDispose: () => void;
}>;

/** Records bundled native execution custody without granting action permission. */
export type NativeHookRelayExecutionAdmission = Readonly<{
  toolNames: readonly string[];
  /** A returned guard runs after async admission; a reason denies execution before allow. */
  admit: (
    invocation: NativeHookRelayInvocation,
    assertCurrent: () => void,
    preparation: Readonly<{ signal?: AbortSignal; assertCurrent: () => void }>,
  ) => void | (() => string | void) | Promise<void | (() => string | void)>;
}>;

export type NativeHookRelayOwnerOptions = {
  requireForegroundTurn?: boolean;
  retention?: NativeHookRelayRetention;
  approvalHost?: NativeHookRelayRegistration["approvalHost"];
  executionAdmission?: NativeHookRelayExecutionAdmission;
  postToolUse?: Readonly<{
    toolNames: readonly string[];
    observe: (
      invocation: Readonly<NativeHookRelayInvocation>,
      assertCurrent: () => void,
    ) => void | Promise<void>;
  }>;
};

export type OwnedNativeHookRelayParams = RegisterNativeHookRelayParams &
  NativeHookRelayOwnerOptions;

export type RelayLifetime = {
  foregroundOpen: boolean;
  /** Null requires turn acceptance; undefined preserves public registration semantics. */
  foregroundTurn?: { threadId: string; turnId: string } | null;
  policyReady: Promise<void>;
  /** Process-local monotonic expiry used only by the in-process rearm timer. */
  expiresAtMonotonicMs?: number;
  retained?: ReturnType<typeof retainBeforeToolCallForNativeHookRelay>;
  retention?: NativeHookRelayRetention;
  executionAdmission?: NativeHookRelayExecutionAdmission;
  postToolUse?: NativeHookRelayOwnerOptions["postToolUse"];
  postToolUseWork: Set<Promise<void>>;
  removeAbortListener?: () => void;
  expiryTimer?: ReturnType<typeof setTimeout>;
};
