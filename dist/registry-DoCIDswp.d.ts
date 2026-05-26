import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { j as MemoryCitationsMode } from "./types.tools-BpgZArJS.js";
import { i as LlmCompleteResult, r as LlmCompleteParams } from "./types-core-DxqEkbXr.js";
import { AgentMessage } from "@earendil-works/pi-agent-core";

//#region src/context-engine/types.d.ts
type AssembleResult = {
  /** Ordered messages to use as model context */messages: AgentMessage[]; /** Estimated total tokens in assembled context */
  estimatedTokens: number;
  /**
   * Controls which token estimate the runner treats as authoritative for
   * preemptive overflow prechecks. The returned `messages` are always the
   * prompt sent to the model; this only affects the precheck's token comparison.
   *
   * - "assembled": the precheck uses only the assembled prompt's estimate.
   * - "preassembly_may_overflow": the precheck takes the maximum of the
   *   assembled estimate and the pre-assembly (unwindowed) session-history
   *   estimate. Engines opt into this when their assembled view can hide an
   *   overflow that would still affect the underlying transcript.
   *
   * Defaults to "assembled".
   */
  promptAuthority?: "assembled" | "preassembly_may_overflow"; /** Optional context-engine-provided instructions prepended to the runtime system prompt */
  systemPromptAddition?: string;
  /**
   * Optional projection lifecycle for hosts with persistent backend threads.
   *
   * Context engines that return `thread_bootstrap` ask the host to inject the
   * assembled context once for the supplied epoch, then reuse the backend
   * thread until the epoch changes. Engines that omit this field retain the
   * legacy per-turn projection behavior.
   */
  contextProjection?: ContextEngineProjection;
};
type ContextEngineProjection = {
  /** How the assembled context should be projected into the backend runtime. */mode: "per_turn" | "thread_bootstrap"; /** Stable context epoch. Changing this tells persistent backends to rotate. */
  epoch?: string; /** Optional diagnostic fingerprint for the projected context payload. */
  fingerprint?: string;
};
type ContextEngineOperation = "agent-run" | "manual-compact" | "subagent-spawn";
type ContextEngineHostCapability = "bootstrap" | "assemble-before-prompt" | "after-turn" | "maintain" | "compact" | "runtime-llm-complete" | "thread-bootstrap-projection";
type ContextEngineHostRequirements = {
  /** Host capabilities required before the engine can safely serve this operation. */requiredCapabilities: ContextEngineHostCapability[]; /** Optional engine-authored guidance appended to the host compatibility error. */
  unsupportedMessage?: string;
};
type CompactResult = {
  ok: boolean;
  compacted: boolean;
  reason?: string;
  result?: {
    summary?: string;
    firstKeptEntryId?: string;
    tokensBefore: number;
    tokensAfter?: number;
    details?: unknown; /** Session id after compaction, when the runtime rotated transcripts. */
    sessionId?: string; /** Session file after compaction, when the runtime rotated transcripts. */
    sessionFile?: string;
  };
};
type IngestResult = {
  /** Whether the message was ingested (false if duplicate or no-op) */ingested: boolean;
};
type IngestBatchResult = {
  /** Number of messages ingested from the supplied batch */ingestedCount: number;
};
type BootstrapResult = {
  /** Whether bootstrap ran and initialized the engine's store */bootstrapped: boolean; /** Number of historical messages imported (if applicable) */
  importedMessages?: number; /** Optional reason when bootstrap was skipped */
  reason?: string;
};
type ContextEngineInfo = {
  id: string;
  name: string;
  version?: string; /** True when the engine manages its own compaction lifecycle. */
  ownsCompaction?: boolean;
  /**
   * Controls how turn-triggered maintenance should be executed.
   *
   * Engines remain compatible by default unless the host explicitly opts into
   * background turn maintenance.
   */
  turnMaintenanceMode?: "foreground" | "background";
  /**
   * Host capability requirements for operations where using an unsupported
   * runtime would silently degrade or corrupt the engine's behavior.
   */
  hostRequirements?: Partial<Record<ContextEngineOperation, ContextEngineHostRequirements>>;
};
type SubagentSpawnPreparation = {
  /** Roll back pre-spawn setup when subagent launch fails. */rollback: () => void | Promise<void>;
};
type SubagentEndReason = "deleted" | "completed" | "swept" | "released";
type TranscriptRewriteReplacement = {
  /** Existing transcript entry id to replace on the active branch. */entryId: string; /** Replacement message content for that entry. */
  message: AgentMessage;
};
type TranscriptRewriteRequest = {
  /** Message entry replacements to apply in one branch-and-reappend pass. */replacements: TranscriptRewriteReplacement[];
};
type TranscriptRewriteResult = {
  /** Whether the active branch changed. */changed: boolean; /** Estimated bytes removed from the active branch message payloads. */
  bytesFreed: number; /** Number of transcript message entries rewritten. */
  rewrittenEntries: number; /** Optional reason when no rewrite occurred. */
  reason?: string;
};
type ContextEngineMaintenanceResult = TranscriptRewriteResult;
type ContextEnginePromptCacheRetention = "none" | "short" | "long" | "in_memory" | "24h";
type ContextEnginePromptCacheUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};
type ContextEnginePromptCacheObservationChangeCode = "cacheRetention" | "model" | "streamStrategy" | "systemPrompt" | "tools" | "transport";
type ContextEnginePromptCacheObservationChange = {
  code: ContextEnginePromptCacheObservationChangeCode;
  detail: string;
};
type ContextEnginePromptCacheObservation = {
  broke: boolean;
  previousCacheRead?: number;
  cacheRead?: number;
  changes?: ContextEnginePromptCacheObservationChange[];
};
type ContextEnginePromptCacheInfo = {
  /** Runtime-resolved retention for the actual provider/model/request path. */retention?: ContextEnginePromptCacheRetention; /** Usage from the most recent API call, not accumulated retry/tool-loop totals. */
  lastCallUsage?: ContextEnginePromptCacheUsage; /** Result from the runtime's prompt-cache observability heuristic. */
  observation?: ContextEnginePromptCacheObservation; /** Last known cache-touch timestamp from runtime-managed cache-TTL bookkeeping. */
  lastCacheTouchAt?: number; /** Known cache expiry time when the runtime can source it confidently. */
  expiresAt?: number;
};
type ContextEngineRuntimeContext = Record<string, unknown> & {
  /**
   * True when the host has explicitly opted this maintenance run into
   * consuming deferred compaction debt.
   */
  allowDeferredCompactionExecution?: boolean; /** Runtime-resolved context window budget for the active model call. */
  tokenBudget?: number; /** Best-effort current prompt/context token estimate for this turn. */
  currentTokenCount?: number; /** Optional prompt-cache telemetry for cache-aware engines. */
  promptCache?: ContextEnginePromptCacheInfo;
  /**
   * Safe transcript rewrite helper implemented by the runtime.
   *
   * Engines decide what is safe to rewrite; the runtime owns how the session
   * DAG is updated on disk.
   */
  rewriteTranscriptEntries?: (request: TranscriptRewriteRequest) => Promise<TranscriptRewriteResult>; /** LLM completion capability for engines that need model inference. */
  llm?: {
    complete: (params: LlmCompleteParams) => Promise<LlmCompleteResult>;
  };
};
/**
 * ContextEngine defines the pluggable contract for context management.
 *
 * Required methods define a generic lifecycle; optional methods allow engines
 * to provide additional capabilities (retrieval, lineage, etc.).
 */
interface ContextEngine {
  /** Engine identifier and metadata */
  readonly info: ContextEngineInfo;
  /**
   * Initialize engine state for a session, optionally importing historical context.
   */
  bootstrap?(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
  }): Promise<BootstrapResult>;
  /**
   * Run transcript maintenance after bootstrap, successful turns, or compaction.
   *
   * Engines can use runtimeContext.rewriteTranscriptEntries() to request safe
   * branch-and-reappend transcript rewrites without depending on Pi internals.
   */
  maintain?(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<ContextEngineMaintenanceResult>;
  /**
   * Ingest a single message into the engine's store.
   */
  ingest(params: {
    sessionId: string;
    sessionKey?: string;
    message: AgentMessage; /** True when the message belongs to a heartbeat run. */
    isHeartbeat?: boolean;
  }): Promise<IngestResult>;
  /**
   * Ingest a completed turn batch as a single unit.
   */
  ingestBatch?(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[]; /** True when the batch belongs to a heartbeat run. */
    isHeartbeat?: boolean;
  }): Promise<IngestBatchResult>;
  /**
   * Execute optional post-turn lifecycle work after a run attempt completes.
   * Engines can use this to persist canonical context and trigger background
   * compaction decisions.
   */
  afterTurn?(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    messages: AgentMessage[]; /** Number of messages that existed before the prompt was sent. */
    prePromptMessageCount: number; /** Optional auto-compaction summary emitted by the runtime. */
    autoCompactionSummary?: string; /** True when this turn belongs to a heartbeat run. */
    isHeartbeat?: boolean; /** Optional model context token budget for proactive compaction. */
    tokenBudget?: number; /** Optional runtime-owned context for engines that need caller state. */
    runtimeContext?: ContextEngineRuntimeContext;
  }): Promise<void>;
  /**
   * Assemble model context under a token budget.
   * Returns an ordered set of messages ready for the model.
   */
  assemble(params: {
    sessionId: string;
    sessionKey?: string;
    messages: AgentMessage[];
    tokenBudget?: number; /** Tool names available for this run so engines can align prompt guidance with runtime tool access. */
    availableTools?: Set<string>; /** Active memory citation mode when engines want to mirror memory prompt guidance. */
    citationsMode?: MemoryCitationsMode;
    /** Current model identifier (e.g. "claude-opus-4", "gpt-4o", "qwen2.5-7b").
     *  Allows context engine plugins to adapt formatting per model. */
    model?: string; /** The incoming user prompt for this turn (useful for retrieval-oriented engines). */
    prompt?: string;
  }): Promise<AssembleResult>;
  /**
   * Compact context to reduce token usage.
   * May create summaries, prune old turns, etc.
   *
   * The host always bounds this call with a finite safety timeout (the same
   * one that protects native runtime compaction). Engines that run long
   * operations SHOULD additionally honor `abortSignal` so an in-flight
   * compaction can be canceled promptly on run abort or host timeout instead
   * of running to completion in the background.
   */
  compact(params: {
    sessionId: string;
    sessionKey?: string;
    sessionFile: string;
    tokenBudget?: number; /** Force compaction even below the default trigger threshold. */
    force?: boolean; /** Optional live token estimate from the caller's active context. */
    currentTokenCount?: number; /** Controls convergence target; defaults to budget. */
    compactionTarget?: "budget" | "threshold";
    customInstructions?: string; /** Optional runtime-owned context for engines that need caller state. */
    runtimeContext?: ContextEngineRuntimeContext;
    /**
     * Optional abort signal honored before and during compaction. The host
     * aborts it on run-level abort or when its compaction safety timeout
     * fires; engines should stop work and reject promptly when it aborts.
     */
    abortSignal?: AbortSignal;
  }): Promise<CompactResult>;
  /**
   * Prepare context-engine-managed subagent state before the child run starts.
   *
   * Implementations can return a rollback handle that is invoked when spawn
   * fails after preparation succeeds.
   */
  prepareSubagentSpawn?(params: {
    parentSessionKey: string;
    childSessionKey: string;
    contextMode?: "isolated" | "fork";
    parentSessionId?: string;
    parentSessionFile?: string;
    childSessionId?: string;
    childSessionFile?: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined>;
  /**
   * Notify the context engine that a subagent lifecycle ended.
   */
  onSubagentEnded?(params: {
    childSessionKey: string;
    reason: SubagentEndReason;
  }): Promise<void>;
  /**
   * Dispose of any resources held by the engine.
   */
  dispose?(): Promise<void>;
}
//#endregion
//#region src/context-engine/registry.d.ts
/**
 * Runtime context passed to context engine factories during resolution.
 * Provides config and path information so plugins can initialize engines
 * without fragile workarounds.
 */
type ContextEngineFactoryContext = {
  config?: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
};
/**
 * A factory that creates a ContextEngine instance.
 * Supports async creation for engines that need DB connections etc.
 *
 * The factory receives a {@link ContextEngineFactoryContext} with runtime
 * environment context (config, paths). Existing no-arg factories remain
 * backward compatible because TypeScript permits assigning functions with
 * fewer parameters to wider signatures.
 */
type ContextEngineFactory = (ctx: ContextEngineFactoryContext) => ContextEngine | Promise<ContextEngine>;
type ContextEngineRegistrationResult = {
  ok: true;
} | {
  ok: false;
  existingOwner: string;
};
/**
 * Public SDK entry point for third-party registrations.
 *
 * This path is intentionally unprivileged: it cannot claim core-owned ids and
 * it cannot safely refresh an existing registration because the caller's
 * identity is not authenticated.
 */
declare function registerContextEngine(id: string, factory: ContextEngineFactory): ContextEngineRegistrationResult;
/**
 * Return the trusted plugin id that registered a resolved context engine.
 */
declare function resolveContextEngineOwnerPluginId(engine: ContextEngine | undefined | null): string | undefined;
/**
 * Options for {@link resolveContextEngine}.
 */
type ResolveContextEngineOptions = {
  agentDir?: string;
  workspaceDir?: string;
};
/**
 * Resolve which ContextEngine to use based on plugin slot configuration.
 *
 * Resolution order:
 *   1. `config.plugins.slots.contextEngine` (explicit slot override)
 *   2. Default slot value ("legacy")
 *
 * When `config` is provided it is forwarded to the factory as part of a
 * {@link ContextEngineFactoryContext}. Additional runtime paths can be
 * supplied via `options`. Existing no-arg factories continue to work
 * because JavaScript permits extra arguments at call sites.
 *
 * Non-default engines that fail (unregistered, factory throw, or contract
 * violation) are logged and silently replaced by the default engine.
 * Throws only when the default engine itself cannot be resolved.
 */
declare function resolveContextEngine(config?: OpenClawConfig, options?: ResolveContextEngineOptions): Promise<ContextEngine>;
//#endregion
export { TranscriptRewriteRequest as C, TranscriptRewriteReplacement as S, ContextEngineRuntimeContext as _, resolveContextEngineOwnerPluginId as a, SubagentEndReason as b, CompactResult as c, ContextEngineHostRequirements as d, ContextEngineInfo as f, ContextEnginePromptCacheInfo as g, ContextEngineProjection as h, resolveContextEngine as i, ContextEngine as l, ContextEngineOperation as m, ContextEngineFactoryContext as n, AssembleResult as o, ContextEngineMaintenanceResult as p, registerContextEngine as r, BootstrapResult as s, ContextEngineFactory as t, ContextEngineHostCapability as u, IngestBatchResult as v, TranscriptRewriteResult as w, SubagentSpawnPreparation as x, IngestResult as y };