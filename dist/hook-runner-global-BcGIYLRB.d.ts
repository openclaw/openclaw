import { t as HookEntry } from "./types-BCpQVPCb.js";
import { $ as PluginHookModelCallStartedEvent, A as PluginHookBeforeMessageWriteResult, Bt as PluginHookInboundClaimEvent, C as PluginHookBeforeInstallEvent, E as PluginHookBeforeInstallResult, F as PluginHookCronChangedEvent, G as PluginHookGatewayStartEvent, Gt as PluginHookMessageSentEvent, Ht as PluginHookMessageReceivedEvent, I as PluginHookGatewayContext, J as PluginHookInboundClaimResult, K as PluginHookGatewayStopEvent, M as PluginHookBeforeToolCallEvent, Mt as PluginAgentTurnPrepareResult, N as PluginHookBeforeToolCallResult, Nt as PluginHeartbeatPromptContributionEvent, Pt as PluginHeartbeatPromptContributionResult, Q as PluginHookModelCallEndedEvent, Qt as InputGateDecision, S as PluginHookBeforeInstallContext, St as PluginHookToolResultPersistResult, Ut as PluginHookMessageSendingEvent, Vt as PluginHookMessageContext, Wt as PluginHookMessageSendingResult, X as PluginHookLlmOutputEvent, Y as PluginHookLlmInputEvent, Zt as GateHookResult, _ as PluginHookBeforeCompactionEvent, _t as PluginHookToolContext, an as PluginHookBeforeModelResolveResult, at as PluginHookSessionContext, b as PluginHookBeforeDispatchResult, bt as PluginHookToolResultPersistContext, c as PluginHookAfterToolCallEvent, ct as PluginHookSessionStartEvent, d as PluginHookBeforeAgentFinalizeEvent, dt as PluginHookSubagentDeliveryTargetResult, en as PluginHookBeforeAgentStartEvent, et as PluginHookName, f as PluginHookBeforeAgentFinalizeResult, ft as PluginHookSubagentEndedEvent, h as PluginHookBeforeAgentRunEvent, ht as PluginHookSubagentSpawningResult, in as PluginHookBeforeModelResolveEvent, it as PluginHookReplyDispatchResult, j as PluginHookBeforeResetEvent, jt as PluginAgentTurnPrepareEvent, k as PluginHookBeforeMessageWriteEvent, l as PluginHookAgentContext, lt as PluginHookSubagentContext, m as PluginHookBeforeAgentReplyResult, mt as PluginHookSubagentSpawningEvent, nn as PluginHookBeforeAgentStartResult, nt as PluginHookReplyDispatchContext, on as PluginHookBeforePromptBuildEvent, ot as PluginHookSessionEndEvent, p as PluginHookBeforeAgentReplyEvent, pt as PluginHookSubagentSpawnedEvent, rt as PluginHookReplyDispatchEvent, s as PluginHookAfterCompactionEvent, sn as PluginHookBeforePromptBuildResult, tt as PluginHookRegistration, u as PluginHookAgentEndEvent, ut as PluginHookSubagentDeliveryTargetEvent, v as PluginHookBeforeDispatchContext, xt as PluginHookToolResultPersistEvent, y as PluginHookBeforeDispatchEvent, zt as PluginHookInboundClaimContext } from "./hook-types-BKz-S4lu.js";

//#region src/plugins/hook-registry.types.d.ts
type PluginLegacyHookRegistration = {
  pluginId: string;
  entry: HookEntry;
  events: string[];
  source: string;
  rootDir?: string;
};
type HookRunnerRegistry = {
  hooks: PluginLegacyHookRegistration[];
  typedHooks: PluginHookRegistration[];
};
type GlobalHookRunnerRegistry = HookRunnerRegistry & {
  plugins: Array<{
    id: string;
    status: "loaded" | "disabled" | "error";
  }>;
};
//#endregion
//#region src/plugins/hooks.d.ts
type HookRunnerLogger = {
  debug?: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};
type HookFailurePolicy = "fail-open" | "fail-closed";
type VoidHookRunOptions = {
  unrefTimeout?: boolean;
};
type HookRunnerOptions = {
  logger?: HookRunnerLogger; /** If true, errors in hooks will be caught and logged instead of thrown */
  catchErrors?: boolean;
  /**
   * Optional per-hook failure policy.
   * Defaults to fail-open unless explicitly overridden for a hook name.
   */
  failurePolicyByHook?: Partial<Record<PluginHookName, HookFailurePolicy>>;
  /**
   * Optional timeout for void/observation hooks. A timed-out hook is logged and
   * the runner continues, but the plugin's underlying work is not cancelled.
   */
  voidHookTimeoutMsByHook?: Partial<Record<PluginHookName, number>>;
  /**
   * Optional timeout for modifying hooks. A timed-out hook is logged and skipped,
   * but the plugin's underlying work is not cancelled.
   */
  modifyingHookTimeoutMsByHook?: Partial<Record<PluginHookName, number>>;
};
type PluginTargetedInboundClaimOutcome = {
  status: "handled";
  result: PluginHookInboundClaimResult;
} | {
  status: "missing_plugin";
} | {
  status: "no_handler";
} | {
  status: "declined";
} | {
  status: "error";
  error: string;
};
/**
 * Create a hook runner for a specific registry.
 */
declare function createHookRunner(registry: GlobalHookRunnerRegistry, options?: HookRunnerOptions): {
  runBeforeModelResolve: (event: PluginHookBeforeModelResolveEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeModelResolveResult | undefined>;
  runAgentTurnPrepare: (event: PluginAgentTurnPrepareEvent, ctx: PluginHookAgentContext) => Promise<PluginAgentTurnPrepareResult | undefined>;
  runBeforePromptBuild: (event: PluginHookBeforePromptBuildEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforePromptBuildResult | undefined>;
  runBeforeAgentStart: (event: PluginHookBeforeAgentStartEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeAgentStartResult | undefined>;
  runBeforeAgentReply: (event: PluginHookBeforeAgentReplyEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeAgentReplyResult | undefined>;
  runModelCallStarted: (event: PluginHookModelCallStartedEvent, ctx: PluginHookAgentContext) => Promise<void>;
  runModelCallEnded: (event: PluginHookModelCallEndedEvent, ctx: PluginHookAgentContext) => Promise<void>;
  runLlmInput: (event: PluginHookLlmInputEvent, ctx: PluginHookAgentContext) => Promise<void>;
  runLlmOutput: (event: PluginHookLlmOutputEvent, ctx: PluginHookAgentContext) => Promise<void>;
  runBeforeAgentFinalize: (event: PluginHookBeforeAgentFinalizeEvent, ctx: PluginHookAgentContext) => Promise<PluginHookBeforeAgentFinalizeResult | undefined>;
  runAgentEnd: (event: PluginHookAgentEndEvent, ctx: PluginHookAgentContext, options?: VoidHookRunOptions) => Promise<void>;
  runBeforeCompaction: (event: PluginHookBeforeCompactionEvent, ctx: PluginHookAgentContext) => Promise<void>;
  runAfterCompaction: (event: PluginHookAfterCompactionEvent, ctx: PluginHookAgentContext) => Promise<void>;
  runBeforeReset: (event: PluginHookBeforeResetEvent, ctx: PluginHookAgentContext) => Promise<void>;
  runBeforeAgentRun: (event: PluginHookBeforeAgentRunEvent, ctx: PluginHookAgentContext) => Promise<GateHookResult<InputGateDecision> | undefined>;
  runInboundClaim: (event: PluginHookInboundClaimEvent, ctx: PluginHookInboundClaimContext) => Promise<PluginHookInboundClaimResult | undefined>;
  runInboundClaimForPlugin: (pluginId: string, event: PluginHookInboundClaimEvent, ctx: PluginHookInboundClaimContext) => Promise<PluginHookInboundClaimResult | undefined>;
  runInboundClaimForPluginOutcome: (pluginId: string, event: PluginHookInboundClaimEvent, ctx: PluginHookInboundClaimContext) => Promise<PluginTargetedInboundClaimOutcome>;
  runMessageReceived: (event: PluginHookMessageReceivedEvent, ctx: PluginHookMessageContext) => Promise<void>;
  runBeforeDispatch: (event: PluginHookBeforeDispatchEvent, ctx: PluginHookBeforeDispatchContext) => Promise<PluginHookBeforeDispatchResult | undefined>;
  runReplyDispatch: (event: PluginHookReplyDispatchEvent, ctx: PluginHookReplyDispatchContext) => Promise<PluginHookReplyDispatchResult | undefined>;
  runMessageSending: (event: PluginHookMessageSendingEvent, ctx: PluginHookMessageContext) => Promise<PluginHookMessageSendingResult | undefined>;
  runMessageSent: (event: PluginHookMessageSentEvent, ctx: PluginHookMessageContext) => Promise<void>;
  runBeforeToolCall: (event: PluginHookBeforeToolCallEvent, ctx: PluginHookToolContext) => Promise<PluginHookBeforeToolCallResult | undefined>;
  runAfterToolCall: (event: PluginHookAfterToolCallEvent, ctx: PluginHookToolContext) => Promise<void>;
  runToolResultPersist: (event: PluginHookToolResultPersistEvent, ctx: PluginHookToolResultPersistContext) => PluginHookToolResultPersistResult | undefined;
  runBeforeMessageWrite: (event: PluginHookBeforeMessageWriteEvent, ctx: {
    agentId?: string;
    sessionKey?: string;
  }) => PluginHookBeforeMessageWriteResult | undefined;
  runSessionStart: (event: PluginHookSessionStartEvent, ctx: PluginHookSessionContext) => Promise<void>;
  runSessionEnd: (event: PluginHookSessionEndEvent, ctx: PluginHookSessionContext) => Promise<void>;
  runSubagentSpawning: (event: PluginHookSubagentSpawningEvent, ctx: PluginHookSubagentContext) => Promise<PluginHookSubagentSpawningResult | undefined>;
  runSubagentDeliveryTarget: (event: PluginHookSubagentDeliveryTargetEvent, ctx: PluginHookSubagentContext) => Promise<PluginHookSubagentDeliveryTargetResult | undefined>;
  runSubagentSpawned: (event: PluginHookSubagentSpawnedEvent, ctx: PluginHookSubagentContext) => Promise<void>;
  runSubagentEnded: (event: PluginHookSubagentEndedEvent, ctx: PluginHookSubagentContext) => Promise<void>;
  runGatewayStart: (event: PluginHookGatewayStartEvent, ctx: PluginHookGatewayContext) => Promise<void>;
  runGatewayStop: (event: PluginHookGatewayStopEvent, ctx: PluginHookGatewayContext) => Promise<void>;
  runHeartbeatPromptContribution: (event: PluginHeartbeatPromptContributionEvent, ctx: PluginHookAgentContext) => Promise<PluginHeartbeatPromptContributionResult | undefined>;
  runCronChanged: (event: PluginHookCronChangedEvent, ctx: PluginHookGatewayContext) => Promise<void>;
  runBeforeInstall: (event: PluginHookBeforeInstallEvent, ctx: PluginHookBeforeInstallContext) => Promise<PluginHookBeforeInstallResult | undefined>;
  hasHooks: (hookName: PluginHookName) => boolean;
  getHookCount: (hookName: PluginHookName) => number;
};
type HookRunner = ReturnType<typeof createHookRunner>;
//#endregion
//#region src/plugins/hook-runner-global.d.ts
/**
 * Initialize the global hook runner with a plugin registry.
 * Called once when plugins are loaded during gateway startup.
 */
declare function initializeGlobalHookRunner(registry: GlobalHookRunnerRegistry): void;
/**
 * Get the global hook runner.
 * Returns null if plugins haven't been loaded yet.
 */
declare function getGlobalHookRunner(): HookRunner | null;
/**
 * Get the global plugin registry.
 * Returns null if plugins haven't been loaded yet.
 */
declare function getGlobalPluginRegistry(): GlobalHookRunnerRegistry | null;
/**
 * Check if any hooks are registered for a given hook name.
 */
declare function hasGlobalHooks(hookName: Parameters<HookRunner["hasHooks"]>[0]): boolean;
declare function runGlobalGatewayStopSafely(params: {
  event: PluginHookGatewayStopEvent;
  ctx: PluginHookGatewayContext;
  onError?: (err: unknown) => void;
}): Promise<void>;
/**
 * Reset the global hook runner (for testing).
 */
declare function resetGlobalHookRunner(): void;
//#endregion
export { resetGlobalHookRunner as a, initializeGlobalHookRunner as i, getGlobalPluginRegistry as n, runGlobalGatewayStopSafely as o, hasGlobalHooks as r, getGlobalHookRunner as t };