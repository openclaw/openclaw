import { h as SecretsConfig, l as SecretInput } from "./types.secrets-tbFW-hY6.js";
import { S as AgentToolModelConfig, b as AgentRuntimePolicyConfig, h as ModelsConfigInput, m as ModelsConfig, v as AgentEmbeddedHarnessConfig, x as AgentSandboxConfig, y as AgentModelConfig } from "./types.models-tqxsISRc.js";
import { t as ChatType } from "./chat-type-BtX_XjMF.js";
import { E as SessionConfig, H as TypingMode, U as WebConfig, b as LoggingConfig, g as DmScope, n as BlockStreamingChunkConfig, p as DiagnosticsConfig, r as BlockStreamingCoalesceConfig, v as HumanDelayConfig, y as IdentityConfig } from "./types.base-DS--yneR.js";
import { M as MemoryConfig, O as ToolsConfig, _ as MemorySearchConfig, t as AgentToolsConfig } from "./types.tools-BpgZArJS.js";
import { $t as AudioConfig, Jt as ApprovalsConfig, en as BroadcastConfig, in as CommandsConfig, ln as MessagesConfig, on as GroupChatConfig, r as ChannelsConfig, vn as TtsConfig } from "./types.channels-C67UBRPK.js";
import { t as ProxyConfig } from "./zod-schema.proxy-DnWMhVtZ.js";

//#region src/shared/silent-reply-policy.d.ts
type SilentReplyPolicy = "allow" | "disallow";
type SilentReplyConversationType = "direct" | "group" | "internal";
type SilentReplyPolicyShape = Partial<Record<Exclude<SilentReplyConversationType, "direct">, SilentReplyPolicy>>;
//#endregion
//#region src/config/types.agent-defaults.d.ts
type AgentContextInjection = "always" | "continuation-skip" | "never";
type OptionalBootstrapFileName = "SOUL.md" | "USER.md" | "HEARTBEAT.md" | "IDENTITY.md";
type EmbeddedPiExecutionContract = "default" | "strict-agentic";
type SubagentDelegationMode = "suggest" | "prefer";
type Gpt5PromptOverlayConfig = {
  /** Friendly interaction-style layer for GPT-5-family models (default: friendly). */personality?: "friendly" | "on" | "off";
};
type PromptOverlaysConfig = {
  /** Shared GPT-5-family prompt overlay used across providers. */gpt5?: Gpt5PromptOverlayConfig;
};
type AgentModelEntryConfig = {
  alias?: string; /** Provider-specific API parameters (e.g., GLM-4.7 thinking mode). */
  params?: Record<string, unknown>; /** Optional agent execution runtime for this specific provider/model entry. */
  agentRuntime?: AgentRuntimePolicyConfig; /** Enable streaming for this model (default: true, false for Ollama to avoid SDK issue #1205). */
  streaming?: boolean;
};
type AgentModelListConfig = {
  primary?: string;
  fallbacks?: string[];
};
type AgentContextPruningConfig = {
  mode?: "off" | "cache-ttl"; /** TTL to consider cache expired (duration string, default unit: minutes). */
  ttl?: string;
  keepLastAssistants?: number;
  softTrimRatio?: number;
  hardClearRatio?: number;
  minPrunableToolChars?: number;
  tools?: {
    allow?: string[];
    deny?: string[];
  };
  softTrim?: {
    maxChars?: number;
    headChars?: number;
    tailChars?: number;
  };
  hardClear?: {
    enabled?: boolean;
    placeholder?: string;
  };
};
type AgentStartupContextConfig = {
  /** Enable runtime-owned startup-context prelude on bare session resets (default: true). */enabled?: boolean; /** Which bare reset commands should receive startup context (default: ["new", "reset"]). */
  applyOn?: Array<"new" | "reset">; /** How many dated memory files to load counting backward from today (default: 2). */
  dailyMemoryDays?: number; /** Max bytes to read from each daily memory file before skipping (default: 16384). */
  maxFileBytes?: number; /** Max characters retained from each daily memory file (default: 1200). */
  maxFileChars?: number; /** Max total characters retained across the startup prelude (default: 2800). */
  maxTotalChars?: number;
};
type AgentContextLimitsConfig = {
  /** Default max chars returned by memory_get before truncation metadata/notice (default: 12000). */memoryGetMaxChars?: number; /** Default line window for memory_get when lines is omitted (default: 120). */
  memoryGetDefaultLines?: number; /** Max chars kept for a single live tool result before truncation (default: 16000). */
  toolResultMaxChars?: number; /** Max chars retained from post-compaction AGENTS.md context injection (default: 1800). */
  postCompactionMaxChars?: number;
};
type AgentRunRetriesConfig = {
  /** Base number of run retry iterations (default: 24). */base?: number; /** Additional run retry iterations per fallback profile (default: 8). */
  perProfile?: number; /** Minimum limit for run retry iterations (default: 32). */
  min?: number; /** Maximum limit for run retry iterations (default: 160). */
  max?: number;
};
type CliBackendConfig = {
  /** CLI command to execute (absolute path or on PATH). */command: string; /** Base args applied to every invocation. */
  args?: string[]; /** Output parsing mode (default: json). */
  output?: "json" | "text" | "jsonl"; /** Output parsing mode when resuming a CLI session. */
  resumeOutput?: "json" | "text" | "jsonl"; /** JSONL event dialect for CLIs with provider-specific stream formats. */
  jsonlDialect?: "claude-stream-json"; /** Long-lived CLI process mode. */
  liveSession?: "claude-stdio"; /** Prompt input mode (default: arg). */
  input?: "arg" | "stdin"; /** Max prompt length for arg mode (if exceeded, stdin is used). */
  maxPromptArgChars?: number; /** Extra env vars injected for this CLI. */
  env?: Record<string, string>; /** Env vars to remove before launching this CLI. */
  clearEnv?: string[]; /** Flag used to pass model id (e.g. --model). */
  modelArg?: string; /** Model aliases mapping (config model id → CLI model id). */
  modelAliases?: Record<string, string>; /** Flag used to pass session id (e.g. --session-id). */
  sessionArg?: string; /** Extra args used when resuming a session (use {sessionId} placeholder). */
  sessionArgs?: string[]; /** Alternate args to use when resuming a session (use {sessionId} placeholder). */
  resumeArgs?: string[]; /** When to pass session ids. */
  sessionMode?: "always" | "existing" | "none"; /** JSON fields to read session id from (in order). */
  sessionIdFields?: string[]; /** Flag used to pass system prompt. */
  systemPromptArg?: string; /** Flag used to pass a system prompt file. */
  systemPromptFileArg?: string; /** Config override flag used to pass a system prompt file (e.g. -c). */
  systemPromptFileConfigArg?: string; /** Config override key used to pass a system prompt file. */
  systemPromptFileConfigKey?: string; /** System prompt behavior (append vs replace). */
  systemPromptMode?: "append" | "replace"; /** When to send system prompt. */
  systemPromptWhen?: "first" | "always" | "never"; /** Flag used to pass image paths. */
  imageArg?: string; /** How to pass multiple images. */
  imageMode?: "repeat" | "list"; /** Where staged image files should live before handing them to the CLI. */
  imagePathScope?: "temp" | "workspace"; /** Serialize runs for this CLI. */
  serialize?: boolean; /** Opt in to bounded raw transcript reseed before compaction for safe session resets. */
  reseedFromRawTranscriptWhenUncompacted?: boolean; /** Runtime reliability tuning for this backend's process lifecycle. */
  reliability?: {
    /** Live-session output caps for CLIs that stream JSONL through a long-lived process. */outputLimits?: {
      /** Max raw JSONL characters retained for one live CLI turn. */maxTurnRawChars?: number; /** Max raw JSONL lines retained for one live CLI turn. */
      maxTurnLines?: number;
    }; /** No-output watchdog tuning (fresh vs resumed runs). */
    watchdog?: {
      /** Fresh/new sessions (non-resume). */fresh?: {
        /** Fixed watchdog timeout in ms (overrides ratio when set). */noOutputTimeoutMs?: number; /** Fraction of overall timeout used when fixed timeout is not set. */
        noOutputTimeoutRatio?: number; /** Lower bound for computed watchdog timeout. */
        minMs?: number; /** Upper bound for computed watchdog timeout. */
        maxMs?: number;
      }; /** Resume sessions. */
      resume?: {
        /** Fixed watchdog timeout in ms (overrides ratio when set). */noOutputTimeoutMs?: number; /** Fraction of overall timeout used when fixed timeout is not set. */
        noOutputTimeoutRatio?: number; /** Lower bound for computed watchdog timeout. */
        minMs?: number; /** Upper bound for computed watchdog timeout. */
        maxMs?: number;
      };
    };
  };
};
type AgentDefaultsConfig = {
  /** Global default provider params applied to all models before per-model and per-agent overrides. */params?: Record<string, unknown>; /** Default agent runtime policy. */
  agentRuntime?: AgentRuntimePolicyConfig; /** @deprecated Use agentRuntime. */
  embeddedHarness?: AgentEmbeddedHarnessConfig; /** Primary model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  model?: AgentModelConfig; /** Optional image-capable model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  imageModel?: AgentToolModelConfig; /** Optional image-generation model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  imageGenerationModel?: AgentToolModelConfig; /** Optional video-generation model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  videoGenerationModel?: AgentToolModelConfig; /** Optional music-generation model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  musicGenerationModel?: AgentToolModelConfig;
  /**
   * When true (default), shared image/music/video generation appends other
   * auth-backed provider defaults after explicit primary/fallback refs. Set to
   * false to disable implicit cross-provider fallback while keeping explicit
   * fallbacks.
   */
  mediaGenerationAutoProviderFallback?: boolean; /** Optional PDF-capable model and fallbacks (provider/model). Accepts string or {primary,fallbacks}. */
  pdfModel?: AgentToolModelConfig; /** Maximum PDF file size in megabytes (default: 10). */
  pdfMaxBytesMb?: number; /** Maximum number of PDF pages to process (default: 20). */
  pdfMaxPages?: number; /** Model catalog with optional aliases (full provider/model keys). */
  models?: Record<string, AgentModelEntryConfig>; /** Agent working directory (preferred). Used as the default cwd for agent runs. */
  workspace?: string; /** Optional default allowlist of skills for agents that do not set agents.list[].skills. */
  skills?: string[]; /** Silent-reply policy by conversation type. */
  silentReply?: SilentReplyPolicyShape; /** Optional repository root for system prompt runtime line (overrides auto-detect). */
  repoRoot?: string; /** Optional full system prompt replacement. Primarily for prompt debugging and controlled experiments. */
  systemPromptOverride?: string; /** Provider-independent prompt overlays applied by model family. */
  promptOverlays?: PromptOverlaysConfig; /** Skip bootstrap (BOOTSTRAP.md creation, etc.) for pre-configured deployments. */
  skipBootstrap?: boolean;
  /**
   * List of optional bootstrap filenames to skip writing to the workspace root.
   * Applies to: SOUL.md, USER.md, HEARTBEAT.md, IDENTITY.md.
   * Required workspace setup such as AGENTS.md and TOOLS.md still runs.
   * Example: ["SOUL.md", "USER.md", "HEARTBEAT.md", "IDENTITY.md"]
   */
  skipOptionalBootstrapFiles?: OptionalBootstrapFileName[];
  /**
   * Controls when workspace bootstrap files (AGENTS.md, SOUL.md, etc.) are
   * injected into the system prompt:
   * - always: inject on every turn (default)
   * - continuation-skip: skip injection on safe continuation turns once the
   *   transcript already contains a completed assistant turn
   */
  contextInjection?: AgentContextInjection; /** Max chars for injected bootstrap files before truncation (default: 20000). */
  bootstrapMaxChars?: number; /** Max total chars across all injected bootstrap files (default: 150000). */
  bootstrapTotalMaxChars?: number; /** Experimental agent-default flags. Keep off unless you are intentionally testing a preview surface. */
  experimental?: {
    /**
     * Drop heavyweight non-essential default tools for weaker or smaller local
     * model backends. Experimental preview only.
     */
    localModelLean?: boolean;
  };
  /**
   * Agent-visible bootstrap truncation warning mode:
   * - off: do not inject warning text
   * - once: inject once per unique truncation signature
   * - always: inject on every run with truncation (default)
   */
  bootstrapPromptTruncationWarning?: "off" | "once" | "always"; /** Optional IANA timezone for the user (used in system prompt; defaults to host timezone). */
  userTimezone?: string; /** Runtime-owned first-turn startup context for bare /new and /reset. */
  startupContext?: AgentStartupContextConfig; /** Focused context-budget overrides for high-volume injected/read surfaces. */
  contextLimits?: AgentContextLimitsConfig; /** Time format in system prompt: auto (OS preference), 12-hour, or 24-hour. */
  timeFormat?: "auto" | "12" | "24";
  /**
   * Envelope timestamp timezone: "utc" (default), "local", "user", or an IANA timezone string.
   */
  envelopeTimezone?: string;
  /**
   * Include absolute timestamps in message envelopes ("on" | "off", default: "on").
   */
  envelopeTimestamp?: "on" | "off";
  /**
   * Include elapsed time in message envelopes ("on" | "off", default: "on").
   */
  envelopeElapsed?: "on" | "off"; /** Optional context window cap (used for runtime estimates + status %). */
  contextTokens?: number; /** Optional CLI backends for text-only fallback (claude-cli, etc.). */
  cliBackends?: Record<string, CliBackendConfig>; /** Opt-in: prune old tool results from the LLM context to reduce token usage. */
  contextPruning?: AgentContextPruningConfig; /** Compaction tuning and pre-compaction memory flush behavior. */
  compaction?: AgentCompactionConfig; /** Outer run loop retry iteration boundaries. */
  runRetries?: AgentRunRetriesConfig; /** Embedded Pi runner hardening and compatibility controls. */
  embeddedPi?: {
    /**
     * How embedded Pi should trust workspace-local `.pi/config/settings.json`.
     * - sanitize (default): apply project settings except shellPath/shellCommandPrefix
     * - ignore: ignore project settings entirely
     * - trusted: trust project settings as-is
     */
    projectSettingsPolicy?: "trusted" | "sanitize" | "ignore";
    /**
     * Embedded Pi execution contract:
     * - default: keep the standard runner behavior
     * - strict-agentic: on OpenAI/OpenAI Codex GPT-5-family runs, keep acting until hitting a real blocker
     */
    executionContract?: EmbeddedPiExecutionContract;
  }; /** Vector memory search configuration (per-agent overrides supported). */
  memorySearch?: MemorySearchConfig; /** Default thinking level when no /think directive is present. */
  thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max"; /** Default verbose level when no /verbose directive is present. */
  verboseDefault?: "off" | "on" | "full";
  /**
   * Detail mode for user-visible tool progress in /verbose and editable progress drafts.
   * - explain: compact human summary (default)
   * - raw: include raw command/detail when available
   */
  toolProgressDetail?: "explain" | "raw"; /** Default reasoning level when no /reasoning directive is present. */
  reasoningDefault?: "off" | "on" | "stream"; /** Default elevated level when no /elevated directive is present. */
  elevatedDefault?: "off" | "on" | "ask" | "full"; /** Default block streaming level when no override is present. */
  blockStreamingDefault?: "off" | "on";
  /**
   * Block streaming boundary:
   * - "text_end": end of each assistant text content block (before tool calls)
   * - "message_end": end of the whole assistant message (may include tool blocks)
   */
  blockStreamingBreak?: "text_end" | "message_end"; /** Soft block chunking for streamed replies (min/max chars, prefer paragraph/newline). */
  blockStreamingChunk?: BlockStreamingChunkConfig;
  /**
   * Block reply coalescing (merge streamed chunks before send).
   * idleMs: wait time before flushing when idle.
   */
  blockStreamingCoalesce?: BlockStreamingCoalesceConfig; /** Human-like delay between block replies. */
  humanDelay?: HumanDelayConfig;
  timeoutSeconds?: number; /** Max inbound media size in MB for agent-visible attachments (text note or future image attach). */
  mediaMaxMb?: number;
  /**
   * Max image side length (pixels) when sanitizing base64 image payloads in transcripts/tool results.
   * Default: 1200.
   */
  imageMaxDimensionPx?: number;
  typingIntervalSeconds?: number; /** Typing indicator start mode (never|instant|thinking|message). */
  typingMode?: TypingMode; /** Periodic background heartbeat runs. */
  heartbeat?: {
    /** Heartbeat interval (duration string, default unit: minutes; default: 30m). */every?: string; /** Optional active-hours window (local time); heartbeats run only inside this window. */
    activeHours?: {
      /** Start time (24h, HH:MM). Inclusive. */start?: string; /** End time (24h, HH:MM). Exclusive. Use "24:00" for end-of-day. */
      end?: string; /** Timezone for the window ("user", "local", or IANA TZ id). Default: "user". */
      timezone?: string;
    }; /** Heartbeat model override (provider/model). */
    model?: string; /** Session key for heartbeat runs ("main" or explicit session key). */
    session?: string; /** Delivery target ("last", "none", or a channel id). */
    target?: string; /** Direct/DM delivery policy. Default: "allow". */
    directPolicy?: "allow" | "block"; /** Optional delivery override (E.164 for WhatsApp, chat id for Telegram). Supports :topic:NNN suffix for Telegram topics. */
    to?: string; /** Optional account id for multi-account channels. */
    accountId?: string; /** Override the heartbeat prompt body (default: "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK."). */
    prompt?: string; /** Include the ## Heartbeats system prompt section for the default agent (default: true). */
    includeSystemPromptSection?: boolean; /** Max chars allowed after HEARTBEAT_OK before delivery (default: 30). */
    ackMaxChars?: number; /** Suppress tool error warning payloads during heartbeat runs. */
    suppressToolErrorWarnings?: boolean; /** Run timeout in seconds for heartbeat agent turns. */
    timeoutSeconds?: number;
    /**
     * If true, run heartbeat turns with lightweight bootstrap context.
     * Lightweight mode keeps only HEARTBEAT.md from workspace bootstrap files.
     */
    lightContext?: boolean;
    /**
     * If true, run heartbeat turns in an isolated session with no prior
     * conversation history. The heartbeat only sees its bootstrap context
     * (HEARTBEAT.md when lightContext is also enabled). Dramatically reduces
     * per-heartbeat token cost by avoiding the full session transcript.
     */
    isolatedSession?: boolean;
    /**
     * If true, defer heartbeat runs while this agent's session-keyed subagent or nested command lanes are busy.
     * Cron lanes are always treated as busy for heartbeat deferral.
     */
    skipWhenBusy?: boolean;
    /**
     * When enabled, deliver the model's reasoning payload for heartbeat runs (when available)
     * as a separate message prefixed with `Thinking.` (same as `/reasoning on`).
     *
     * Default: false (only the final heartbeat payload is delivered).
     */
    includeReasoning?: boolean;
  }; /** Max concurrent agent runs across all conversations. Default: 1 (sequential). */
  maxConcurrent?: number; /** Sub-agent defaults (spawned via sessions_spawn). */
  subagents?: {
    /** Prompt-only guidance for how strongly the main agent should delegate work. Default: "suggest". */delegationMode?: SubagentDelegationMode; /** Default allowlist of target agent ids for sessions_spawn. Use "*" to allow any configured target. */
    allowAgents?: string[]; /** Max concurrent sub-agent runs (global lane: "subagent"). Default: 1. */
    maxConcurrent?: number; /** Maximum depth allowed for sessions_spawn chains. Default behavior: 1 (no nested spawns). */
    maxSpawnDepth?: number; /** Maximum active children a single requester session may spawn. Default behavior: 5. */
    maxChildrenPerAgent?: number; /** Auto-archive sub-agent sessions after N minutes (default: 60, set 0 to disable). */
    archiveAfterMinutes?: number; /** Default model selection for spawned sub-agents (string or {primary,fallbacks}). */
    model?: AgentModelConfig; /** Default thinking level for spawned sub-agents (e.g. "off", "low", "medium", "high"). */
    thinking?: string; /** Default run timeout in seconds for spawned sub-agents (0 = no timeout). */
    runTimeoutSeconds?: number; /** Gateway timeout in ms for sub-agent announce delivery calls (default: 120000). */
    announceTimeoutMs?: number; /** Require explicit agentId in sessions_spawn (no default same-as-caller). Default: false. */
    requireAgentId?: boolean;
  }; /** Optional sandbox settings for non-main sessions. */
  sandbox?: AgentSandboxConfig;
};
type AgentCompactionMode = "default" | "safeguard";
type AgentCompactionPostIndexSyncMode = "off" | "async" | "await";
type AgentCompactionIdentifierPolicy = "strict" | "off" | "custom";
type AgentCompactionQualityGuardConfig = {
  /** Enable compaction summary quality audits and regeneration retries. Default: false. */enabled?: boolean; /** Maximum regeneration retries after a failed quality audit. Default: 1 when enabled. */
  maxRetries?: number;
};
type AgentCompactionMidTurnPrecheckConfig = {
  /**
   * Enable structured context pressure checks after tool results are appended
   * and before the next Pi model call. Default: false.
   */
  enabled?: boolean;
};
type AgentCompactionConfig = {
  /** Compaction summarization mode. */mode?: AgentCompactionMode; /** Pi reserve tokens target before floor enforcement. */
  reserveTokens?: number; /** Pi keepRecentTokens budget used for cut-point selection. */
  keepRecentTokens?: number; /** Minimum reserve tokens enforced for Pi compaction (0 disables the floor). */
  reserveTokensFloor?: number; /** Max share of context window for history during safeguard pruning (0.1–0.9, default 0.5). */
  maxHistoryShare?: number; /** Additional compaction-summary instructions that can preserve language or persona continuity. */
  customInstructions?: string; /** Preserve this many most-recent user/assistant turns verbatim in compaction summary context. */
  recentTurnsPreserve?: number; /** Identifier-preservation instruction policy for compaction summaries. */
  identifierPolicy?: AgentCompactionIdentifierPolicy; /** Custom identifier-preservation instructions used when identifierPolicy is "custom". */
  identifierInstructions?: string; /** Optional quality-audit retries for safeguard compaction summaries. */
  qualityGuard?: AgentCompactionQualityGuardConfig; /** Mid-turn precheck for tool-loop context pressure. Default: disabled. */
  midTurnPrecheck?: AgentCompactionMidTurnPrecheckConfig; /** Post-compaction session memory index sync mode. */
  postIndexSync?: AgentCompactionPostIndexSyncMode; /** Pre-compaction memory flush (agentic turn). Default: enabled. */
  memoryFlush?: AgentCompactionMemoryFlushConfig;
  /**
   * H2/H3 section names from AGENTS.md to inject after compaction.
   * Defaults to ["Session Startup", "Red Lines"] when unset.
   * Set to [] to disable post-compaction context injection entirely.
   */
  postCompactionSections?: string[];
  /** Optional model override for compaction summarization (e.g. "openrouter/anthropic/claude-sonnet-4-6").
   * When set, compaction uses this model instead of the agent's primary model.
   * Falls back to the primary model when unset. */
  model?: string; /** Maximum time in seconds for a single compaction operation (default: 900). */
  timeoutSeconds?: number;
  /**
   * Id of a registered compaction provider plugin.
   * When set, the provider's summarize() is called instead of
   * the built-in summarizeInStages(). Falls back to built-in on failure.
   */
  provider?: string;
  /**
   * Rotate the active session JSONL file after compaction so the next turn
   * starts from the compaction summary and unsummarized tail while the old
   * transcript stays archived.
   * Default: false (existing behavior preserved).
   */
  truncateAfterCompaction?: boolean;
  /**
   * Trigger a normal local compaction when the active session JSONL reaches
   * this size (bytes, or byte-size string like "20mb"). Set to 0/unset to
   * disable. Requires truncateAfterCompaction so successful compaction can
   * rotate to a smaller successor transcript. This does not split raw
   * transcript bytes.
   */
  maxActiveTranscriptBytes?: number | string;
  /**
   * Send brief compaction notices to the user when compaction starts and completes.
   * Default: false (silent by default).
   */
  notifyUser?: boolean;
};
type AgentCompactionMemoryFlushConfig = {
  /** Enable the pre-compaction memory flush (default: true). */enabled?: boolean; /** Optional provider/model override used only for pre-compaction memory flush turns. */
  model?: string; /** Run the memory flush when context is within this many tokens of the compaction threshold. */
  softThresholdTokens?: number;
  /**
   * Force a memory flush when transcript size reaches this threshold
   * (bytes, or byte-size string like "2mb"). Set to 0 to disable.
   */
  forceFlushTranscriptBytes?: number | string; /** User prompt used for the memory flush turn (NO_REPLY is enforced if missing). */
  prompt?: string; /** System prompt appended for the memory flush turn. */
  systemPrompt?: string;
};
//#endregion
//#region src/config/types.skills.d.ts
type SkillConfig = {
  enabled?: boolean;
  apiKey?: SecretInput;
  env?: Record<string, string>;
  config?: Record<string, unknown>;
};
type SkillsLoadConfig = {
  /**
   * Additional skill folders to scan (lowest precedence).
   * Each directory should contain skill subfolders with `SKILL.md`.
   */
  extraDirs?: string[];
  /**
   * Real target directories that skill symlinks may resolve into even when they
   * sit outside the configured source root.
   */
  allowSymlinkTargets?: string[]; /** Watch skill folders for changes and refresh the skills snapshot. */
  watch?: boolean; /** Debounce for the skills watcher (ms). */
  watchDebounceMs?: number;
};
type SkillsInstallConfig = {
  preferBrew?: boolean;
  nodeManager?: "npm" | "pnpm" | "yarn" | "bun"; /** Allow gateway clients to install zip archives staged through skills.upload.*. */
  allowUploadedArchives?: boolean;
};
type SkillsLimitsConfig = {
  /** Max number of immediate child directories to consider under a skills root before treating it as suspicious. */maxCandidatesPerRoot?: number; /** Max number of skills to load per skills source (bundled/managed/workspace/extra). */
  maxSkillsLoadedPerSource?: number; /** Max number of skills to include in the model-facing skills prompt. */
  maxSkillsInPrompt?: number; /** Max characters for the model-facing skills prompt block (approx). */
  maxSkillsPromptChars?: number; /** Max size (bytes) allowed for a SKILL.md file to be considered. */
  maxSkillFileBytes?: number;
};
type SkillsConfig = {
  /** Optional bundled-skill allowlist (only affects bundled skills). */allowBundled?: string[];
  load?: SkillsLoadConfig;
  install?: SkillsInstallConfig;
  limits?: SkillsLimitsConfig;
  entries?: Record<string, SkillConfig>;
};
//#endregion
//#region src/config/types.agents.d.ts
type AgentRuntimeAcpConfig = {
  /** ACP harness adapter id (for example codex, claude). */agent?: string; /** Optional ACP backend override for this agent runtime. */
  backend?: string; /** Optional ACP session mode override. */
  mode?: "persistent" | "oneshot"; /** Optional runtime working directory override. */
  cwd?: string;
};
type AgentRuntimeConfig = {
  type: "embedded";
} | {
  type: "acp";
  acp?: AgentRuntimeAcpConfig;
};
type AgentBindingMatch = {
  channel: string;
  /**
   * Channel account to match.
   * - Omitted/empty: matches only the channel default account.
   * - "*": matches every account on the channel.
   * - Any other string: matches that specific account id.
   */
  accountId?: string;
  peer?: {
    kind: ChatType;
    id: string;
  };
  guildId?: string;
  teamId?: string; /** Discord role IDs used for role-based routing. */
  roles?: string[];
};
type AgentRouteBinding = {
  /** Missing type is interpreted as route for backward compatibility. */type?: "route";
  agentId: string;
  comment?: string;
  match: AgentBindingMatch;
  session?: {
    /** Optional session scoping override for conversations matched by this binding. */dmScope?: DmScope;
  };
};
type AgentAcpBinding = {
  type: "acp";
  agentId: string;
  comment?: string;
  match: AgentBindingMatch;
  acp?: {
    mode?: "persistent" | "oneshot";
    label?: string;
    cwd?: string;
    backend?: string;
  };
};
type AgentBinding = AgentRouteBinding | AgentAcpBinding;
type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string; /** Optional human-authored agent description. */
  description?: string;
  workspace?: string;
  agentDir?: string; /** Optional per-agent full system prompt replacement. */
  systemPromptOverride?: AgentDefaultsConfig["systemPromptOverride"]; /** Optional per-agent agent runtime policy override. */
  agentRuntime?: AgentRuntimePolicyConfig; /** @deprecated Use agentRuntime. */
  embeddedHarness?: AgentEmbeddedHarnessConfig;
  model?: AgentModelConfig; /** Per-model metadata overrides for this agent. */
  models?: Record<string, AgentModelEntryConfig>; /** @deprecated Legacy per-agent compaction config is kept for raw doctor migration/repair. */
  compaction?: AgentDefaultsConfig["compaction"]; /** Optional per-agent default thinking level (overrides agents.defaults.thinkingDefault). */
  thinkingDefault?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max"; /** Optional per-agent default verbosity level. */
  verboseDefault?: "off" | "on" | "full"; /** Optional per-agent tool progress detail mode. */
  toolProgressDetail?: AgentDefaultsConfig["toolProgressDetail"]; /** Optional per-agent default reasoning visibility. */
  reasoningDefault?: "on" | "off" | "stream"; /** Optional per-agent default for fast mode. */
  fastModeDefault?: boolean; /** Optional per-agent bootstrap/context injection mode override. */
  contextInjection?: AgentDefaultsConfig["contextInjection"]; /** Optional per-agent max chars for each injected bootstrap file. */
  bootstrapMaxChars?: AgentDefaultsConfig["bootstrapMaxChars"]; /** Optional per-agent max total chars across injected bootstrap files. */
  bootstrapTotalMaxChars?: AgentDefaultsConfig["bootstrapTotalMaxChars"]; /** Optional per-agent experimental flags. Omitted fields inherit agents.defaults.experimental. */
  experimental?: AgentDefaultsConfig["experimental"]; /** Optional allowlist of skills for this agent; omitting it inherits agents.defaults.skills when set, and an explicit list replaces defaults instead of merging. */
  skills?: string[];
  memorySearch?: MemorySearchConfig; /** Human-like delay between block replies for this agent. */
  humanDelay?: HumanDelayConfig; /** Optional per-agent TTS overrides, deep-merged over messages.tts. */
  tts?: TtsConfig; /** Optional per-agent skills subsystem overrides. */
  skillsLimits?: Pick<SkillsLimitsConfig, "maxSkillsPromptChars">; /** Optional per-agent overrides for selected context/token-heavy limits. */
  contextLimits?: AgentContextLimitsConfig;
  contextTokens?: number; /** Optional per-agent heartbeat overrides. */
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  subagents?: {
    /** Prompt-only guidance for how strongly this agent should delegate work. */delegationMode?: SubagentDelegationMode; /** Allow spawning sub-agents under other agent ids. Use "*" to allow any configured target. */
    allowAgents?: string[]; /** Per-agent default model for spawned sub-agents (string or {primary,fallbacks}). */
    model?: AgentModelConfig; /** Require explicit agentId in sessions_spawn (no default same-as-caller). */
    requireAgentId?: boolean;
  }; /** Optional outer run loop retry boundaries. */
  runRetries?: AgentDefaultsConfig["runRetries"]; /** Optional per-agent embedded Pi overrides. */
  embeddedPi?: {
    /** Optional per-agent execution contract override. */executionContract?: EmbeddedPiExecutionContract;
  }; /** Optional per-agent sandbox overrides. */
  sandbox?: AgentSandboxConfig; /** Optional per-agent stream params (e.g. cacheRetention, temperature). */
  params?: Record<string, unknown>;
  tools?: AgentToolsConfig; /** Optional runtime descriptor for this agent. */
  runtime?: AgentRuntimeConfig;
};
type AgentsConfig = {
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
};
//#endregion
//#region src/acp/runtime/types.d.ts
type AcpRuntimePromptMode = "prompt" | "steer";
type AcpRuntimeSessionMode = "persistent" | "oneshot";
type AcpSessionUpdateTag = "agent_message_chunk" | "agent_thought_chunk" | "tool_call" | "tool_call_update" | "usage_update" | "available_commands_update" | "current_mode_update" | "config_option_update" | "session_info_update" | "plan" | (string & {});
type AcpRuntimeControl = "session/set_mode" | "session/set_config_option" | "session/status";
type AcpRuntimeHandle = {
  sessionKey: string;
  backend: string;
  runtimeSessionName: string; /** Effective runtime working directory for this ACP session, if exposed by adapter/runtime. */
  cwd?: string; /** Backend-local record identifier, if exposed by adapter/runtime (for example acpx record id). */
  acpxRecordId?: string; /** Backend-level ACP session identifier, if exposed by adapter/runtime. */
  backendSessionId?: string; /** Upstream harness session identifier, if exposed by adapter/runtime. */
  agentSessionId?: string;
};
type AcpRuntimeEnsureInput = {
  sessionKey: string;
  agent: string;
  mode: AcpRuntimeSessionMode;
  resumeSessionId?: string; /** Optional runtime model override that must be available during session creation. */
  model?: string; /** Optional runtime thinking/reasoning override that must be available during session creation. */
  thinking?: string;
  cwd?: string;
  env?: Record<string, string>;
};
type AcpRuntimeTurnAttachment = {
  mediaType: string;
  data: string;
};
type AcpRuntimeTurnInput = {
  handle: AcpRuntimeHandle;
  text: string;
  attachments?: AcpRuntimeTurnAttachment[];
  mode: AcpRuntimePromptMode;
  requestId: string;
  signal?: AbortSignal;
};
type AcpRuntimeCapabilities = {
  controls: AcpRuntimeControl[];
  /**
   * Optional backend-advertised option keys for session/set_config_option.
   * Empty/undefined means "backend accepts keys, but did not advertise a strict list".
   */
  configOptionKeys?: string[];
};
type AcpRuntimeStatus = {
  summary?: string; /** Backend-local record identifier, if exposed by adapter/runtime. */
  acpxRecordId?: string; /** Backend-level ACP session identifier, if known at status time. */
  backendSessionId?: string; /** Upstream harness session identifier, if known at status time. */
  agentSessionId?: string;
  details?: Record<string, unknown>;
};
type AcpRuntimeDoctorReport = {
  ok: boolean;
  code?: string;
  message: string;
  installCommand?: string;
  details?: string[];
};
type AcpRuntimeEvent = {
  type: "text_delta";
  text: string;
  stream?: "output" | "thought";
  tag?: AcpSessionUpdateTag;
} | {
  type: "status";
  text: string;
  tag?: AcpSessionUpdateTag;
  used?: number;
  size?: number;
} | {
  type: "tool_call";
  text: string;
  tag?: AcpSessionUpdateTag;
  toolCallId?: string;
  status?: string;
  title?: string;
} | {
  type: "done";
  stopReason?: string;
} | {
  type: "error";
  message: string;
  code?: string;
  detailCode?: string;
  retryable?: boolean;
};
type AcpRuntimeTurnResultError = {
  message: string;
  code?: string;
  detailCode?: string;
  retryable?: boolean;
};
type AcpRuntimeTurnResult = {
  status: "completed";
  stopReason?: string;
} | {
  status: "cancelled";
  stopReason?: string;
} | {
  status: "failed";
  error: AcpRuntimeTurnResultError;
};
interface AcpRuntimeTurn {
  readonly requestId: string;
  readonly events: AsyncIterable<AcpRuntimeEvent>;
  readonly result: Promise<AcpRuntimeTurnResult>;
  cancel(input?: {
    reason?: string;
  }): Promise<void>;
  closeStream(input?: {
    reason?: string;
  }): Promise<void>;
}
interface AcpRuntime {
  ensureSession(input: AcpRuntimeEnsureInput): Promise<AcpRuntimeHandle>;
  /**
   * Preferred turn API. Live events are streamed separately from the terminal
   * result so adapters can report failures without relying on legacy done/error
   * events in the stream.
   */
  startTurn?(input: AcpRuntimeTurnInput): AcpRuntimeTurn;
  runTurn(input: AcpRuntimeTurnInput): AsyncIterable<AcpRuntimeEvent>;
  getCapabilities?(input: {
    handle?: AcpRuntimeHandle;
  }): Promise<AcpRuntimeCapabilities> | AcpRuntimeCapabilities;
  getStatus?(input: {
    handle: AcpRuntimeHandle;
    signal?: AbortSignal;
  }): Promise<AcpRuntimeStatus>;
  setMode?(input: {
    handle: AcpRuntimeHandle;
    mode: string;
  }): Promise<void>;
  setConfigOption?(input: {
    handle: AcpRuntimeHandle;
    key: string;
    value: string;
  }): Promise<void>;
  doctor?(): Promise<AcpRuntimeDoctorReport>;
  /**
   * Prepare the next ensureSession for this session key to start fresh instead
   * of reopening backend-owned persistent state.
   */
  prepareFreshSession?(input: {
    sessionKey: string;
  }): Promise<void>;
  cancel(input: {
    handle: AcpRuntimeHandle;
    reason?: string;
  }): Promise<void>;
  close(input: {
    handle: AcpRuntimeHandle;
    reason: string;
    /**
     * Discard backend-owned persistent session state so the next ensureSession
     * starts fresh instead of reopening the same conversation.
     */
    discardPersistentState?: boolean;
  }): Promise<void>;
}
//#endregion
//#region src/config/types.acp.d.ts
type AcpDispatchConfig = {
  /** Master switch for ACP turn dispatch in the reply pipeline. */enabled?: boolean;
};
type AcpStreamConfig = {
  /** Coalescer idle flush window in milliseconds for ACP streamed text. */coalesceIdleMs?: number; /** Maximum text size per streamed chunk. */
  maxChunkChars?: number; /** Suppresses repeated ACP status/tool projection lines within a turn. */
  repeatSuppression?: boolean; /** Live streams chunks or waits for terminal event before delivery. */
  deliveryMode?: "live" | "final_only"; /** Separator inserted before visible text when hidden tool events occurred. */
  hiddenBoundarySeparator?: "none" | "space" | "newline" | "paragraph"; /** Maximum assistant output characters forwarded per turn. */
  maxOutputChars?: number; /** Maximum visible characters for projected session/update lines. */
  maxSessionUpdateChars?: number;
  /**
   * Per-sessionUpdate visibility overrides.
   * Keys not listed here fall back to OpenClaw defaults.
   */
  tagVisibility?: Partial<Record<AcpSessionUpdateTag, boolean>>;
};
type AcpRuntimeConfig = {
  /** Idle runtime TTL in minutes for ACP session workers. */ttlMinutes?: number; /** Optional operator install/setup command shown by `/acp install` and `/acp doctor`. */
  installCommand?: string;
};
type AcpConfig = {
  /** Global ACP runtime gate. */enabled?: boolean;
  dispatch?: AcpDispatchConfig; /** Backend id registered by ACP runtime plugin (for example: acpx). */
  backend?: string; /** Fallback backend ids tried when the primary backend fails with UNAVAILABLE. */
  fallbacks?: string[];
  defaultAgent?: string;
  allowedAgents?: string[];
  maxConcurrentSessions?: number;
  stream?: AcpStreamConfig;
  runtime?: AcpRuntimeConfig;
};
//#endregion
//#region src/config/types.access-groups.d.ts
type DiscordChannelAudienceAccessGroup = {
  /**
   * Discord dynamic audience backed by the users who can currently view a guild
   * channel.
   */
  type: "discord.channelAudience"; /** Guild ID that owns the channel. */
  guildId: string; /** Channel ID whose effective ViewChannel permission defines the audience. */
  channelId: string; /** Audience predicate. Defaults to canViewChannel. */
  membership?: "canViewChannel";
};
type MessageSendersAccessGroup = {
  /**
   * Static sender allowlists that can be referenced by any message channel via
   * accessGroup:<name>.
   */
  type: "message.senders"; /** Sender entries by channel id, plus optional "*" entries shared by all channels. */
  members: Record<string, string[]>;
};
type AccessGroupConfig = DiscordChannelAudienceAccessGroup | MessageSendersAccessGroup;
type AccessGroupsConfig = Record<string, AccessGroupConfig>;
//#endregion
//#region src/config/types.auth.d.ts
type AuthProfileConfig = {
  provider: string;
  /**
   * Auth route selected by this profile id.
   * - api_key: static provider API key
   * - oauth: refreshable OAuth credentials (access+refresh+expires)
   * - token: static bearer-style token (optionally expiring; no refresh)
   * - aws-sdk: AWS SDK default credential chain (no secret in auth-profiles.json)
   */
  mode: "api_key" | "aws-sdk" | "oauth" | "token";
  email?: string;
  displayName?: string;
};
type AuthConfig = {
  profiles?: Record<string, AuthProfileConfig>;
  order?: Record<string, string[]>;
  cooldowns?: {
    /** Default billing backoff (hours). Default: 5. */billingBackoffHours?: number; /** Optional per-provider billing backoff (hours). */
    billingBackoffHoursByProvider?: Record<string, number>; /** Billing backoff cap (hours). Default: 24. */
    billingMaxHours?: number;
    /**
     * Base backoff for high-confidence permanent-auth failures (minutes).
     * Default: 10.
     */
    authPermanentBackoffMinutes?: number;
    /**
     * Cap for high-confidence permanent-auth backoff (minutes). Default: 60.
     */
    authPermanentMaxMinutes?: number;
    /**
     * Failure window for backoff counters (hours). If no failures occur within
     * this window, counters reset. Default: 24.
     */
    failureWindowHours?: number;
    /**
     * Maximum same-provider auth-profile rotations to allow for overloaded
     * errors before escalating to cross-provider model fallback. Default: 1.
     */
    overloadedProfileRotations?: number;
    /**
     * Fixed delay before retrying an overloaded provider/profile rotation.
     * Default: 0.
     */
    overloadedBackoffMs?: number;
    /**
     * Maximum same-provider auth-profile rotations to allow for rate-limit
     * errors before escalating to cross-provider model fallback. Default: 1.
     */
    rateLimitedProfileRotations?: number;
  };
};
//#endregion
//#region src/config/types.browser.d.ts
type BrowserProfileConfig = {
  /** CDP port for this profile. Allocated once at creation, persisted permanently. */cdpPort?: number; /** CDP URL for this profile (use for remote Chrome). */
  cdpUrl?: string; /** Explicit user data directory for existing-session Chrome MCP attachment. */
  userDataDir?: string; /** Override the Chrome MCP command for existing-session profiles. */
  mcpCommand?: string; /** Extra Chrome MCP arguments for existing-session profiles. */
  mcpArgs?: string[]; /** Profile driver (default: openclaw). */
  driver?: "openclaw" | "clawd" | "existing-session"; /** If true, launch this profile in headless mode. Falls back to browser.headless. */
  headless?: boolean; /** Browser executable path for this profile. Falls back to browser.executablePath. */
  executablePath?: string; /** If true, never launch a browser for this profile; only attach. Falls back to browser.attachOnly. */
  attachOnly?: boolean; /** Profile color (hex). Auto-assigned at creation. */
  color: string;
};
type BrowserSnapshotDefaults = {
  /** Default snapshot mode (applies when mode is not provided). */mode?: "efficient";
};
type BrowserTabCleanupConfig = {
  /** Enable best-effort cleanup for tracked primary-agent browser tabs. Default: true */enabled?: boolean; /** Close tracked tabs after this many idle minutes. Set 0 to disable idle cleanup. Default: 120 */
  idleMinutes?: number; /** Keep at most this many tracked tabs per primary session. Set 0 to disable the cap. Default: 8 */
  maxTabsPerSession?: number; /** Cleanup sweep interval in minutes. Default: 5 */
  sweepMinutes?: number;
};
type BrowserSsrFPolicyConfig = {
  /** If true, permit browser navigation to private/internal networks. Default: true */dangerouslyAllowPrivateNetwork?: boolean;
  /**
   * Explicitly allowed hostnames (exact-match), including blocked names like localhost.
   * Example: ["localhost", "metadata.internal"]
   */
  allowedHostnames?: string[];
  /**
   * Hostname allowlist patterns for browser navigation.
   * Supports exact hosts and "*.example.com" wildcard subdomains.
   */
  hostnameAllowlist?: string[];
};
type BrowserConfig = {
  enabled?: boolean; /** If false, disable browser act:evaluate (arbitrary JS). Default: true */
  evaluateEnabled?: boolean; /** Base URL of the CDP endpoint (for remote browsers). Default: loopback CDP on the derived port. */
  cdpUrl?: string; /** Remote CDP HTTP timeout (ms). Default: 1500. */
  remoteCdpTimeoutMs?: number; /** Remote CDP WebSocket handshake timeout (ms). Default: max(remoteCdpTimeoutMs * 2, 2000). */
  remoteCdpHandshakeTimeoutMs?: number; /** Local managed browser launch discovery timeout (ms). Default: 15000. */
  localLaunchTimeoutMs?: number; /** Local managed browser post-launch CDP readiness timeout (ms). Default: 8000. */
  localCdpReadyTimeoutMs?: number; /** Default browser act timeout (ms). Default: 60000. */
  actionTimeoutMs?: number; /** Accent color for the openclaw browser profile (hex). Default: #FF4500 */
  color?: string; /** Override the browser executable path (all platforms). */
  executablePath?: string; /** Start Chrome headless (best-effort). Default: false */
  headless?: boolean; /** Pass --no-sandbox to Chrome (Linux containers). Default: false */
  noSandbox?: boolean; /** If true: never launch; only attach to an existing browser. Default: false */
  attachOnly?: boolean; /** Starting local CDP port for auto-assigned browser profiles. Default derives from gateway port. */
  cdpPortRangeStart?: number; /** Default profile to use when profile param is omitted. Default: "chrome" */
  defaultProfile?: string; /** Named browser profiles with explicit CDP ports or URLs. */
  profiles?: Record<string, BrowserProfileConfig>; /** Default snapshot options (applied by the browser tool/CLI when unset). */
  snapshotDefaults?: BrowserSnapshotDefaults; /** Best-effort cleanup policy for tabs opened by primary-agent browser sessions. */
  tabCleanup?: BrowserTabCleanupConfig; /** SSRF policy for browser navigation/open-tab operations. */
  ssrfPolicy?: BrowserSsrFPolicyConfig;
  /**
   * Additional Chrome launch arguments.
   * Useful for stealth flags, window size overrides, or custom user-agent strings.
   * Example: ["--window-size=1920,1080", "--disable-infobars"]
   */
  extraArgs?: string[];
};
//#endregion
//#region src/config/types.cli.d.ts
type CliBannerTaglineMode = "random" | "default" | "off";
type CliConfig = {
  banner?: {
    /**
     * Controls CLI banner tagline behavior.
     * - "random": pick from tagline pool (default)
     * - "default": always use DEFAULT_TAGLINE
     * - "off": hide tagline text
     */
    taglineMode?: CliBannerTaglineMode;
  };
};
//#endregion
//#region src/config/types.commitments.d.ts
type CommitmentsConfig = {
  /** Enable inferred follow-up extraction, storage, and heartbeat delivery. Default: false. */enabled?: boolean; /** Maximum inferred follow-up commitments delivered per agent session in a rolling day. Default: 3. */
  maxPerDay?: number;
};
//#endregion
//#region src/config/types.crestodian.d.ts
type CrestodianRescueConfig = {
  /**
   * Remote message rescue gate.
   * "auto" enables only for YOLO host posture with sandboxing off.
   */
  enabled?: "auto" | boolean; /** Restrict rescue to owner DMs. Default: true. */
  ownerDmOnly?: boolean; /** Pending write approval TTL in minutes. Default: 15. */
  pendingTtlMinutes?: number;
};
type CrestodianConfig = {
  rescue?: CrestodianRescueConfig;
};
//#endregion
//#region src/config/types.cron.d.ts
/** Error types that can trigger retries for one-shot jobs. */
type CronRetryOn = "rate_limit" | "overloaded" | "network" | "timeout" | "server_error";
type CronRetryConfig = {
  /** Max retries for transient errors before permanent disable (default: 3). */maxAttempts?: number; /** Backoff delays in ms for each retry attempt (default: [30000, 60000, 300000]). */
  backoffMs?: number[]; /** Error types to retry; omit to retry all transient types. */
  retryOn?: CronRetryOn[];
};
type CronFailureAlertConfig = {
  enabled?: boolean;
  after?: number;
  cooldownMs?: number;
  includeSkipped?: boolean;
  mode?: "announce" | "webhook";
  accountId?: string;
};
type CronFailureDestinationConfig = {
  channel?: string;
  to?: string;
  accountId?: string;
  mode?: "announce" | "webhook";
};
type CronConfig = {
  enabled?: boolean;
  store?: string;
  maxConcurrentRuns?: number; /** Override default retry policy for one-shot jobs on transient errors. */
  retry?: CronRetryConfig;
  /**
   * @deprecated Legacy fallback webhook URL used only for stored jobs with notify=true.
   * Prefer per-job delivery.mode="webhook" with delivery.to.
   */
  webhook?: string; /** Bearer token for cron webhook POST delivery. */
  webhookToken?: SecretInput;
  /**
   * How long to retain completed cron run sessions before automatic pruning.
   * Accepts a duration string (e.g. "24h", "7d", "1h30m") or `false` to disable pruning.
   * Default: "24h".
   */
  sessionRetention?: string | false;
  /**
   * Run-log pruning controls for `cron/runs/<jobId>.jsonl`.
   * Defaults: `maxBytes=2_000_000`, `keepLines=2000`.
   */
  runLog?: {
    maxBytes?: number | string;
    keepLines?: number;
  };
  failureAlert?: CronFailureAlertConfig; /** Default destination for failure notifications across all cron jobs. */
  failureDestination?: CronFailureDestinationConfig;
};
//#endregion
//#region src/config/types.gateway.d.ts
type GatewayBindMode = "auto" | "lan" | "loopback" | "custom" | "tailnet";
type GatewayTlsConfig = {
  /** Enable TLS for the gateway server. */enabled?: boolean; /** Auto-generate a self-signed cert if cert/key are missing (default: true). */
  autoGenerate?: boolean; /** PEM certificate path for the gateway server. */
  certPath?: string; /** PEM private key path for the gateway server. */
  keyPath?: string; /** Optional PEM CA bundle for TLS clients (mTLS or custom roots). */
  caPath?: string;
};
type WideAreaDiscoveryConfig = {
  enabled?: boolean; /** Optional unicast DNS-SD domain (e.g. "openclaw.internal"). */
  domain?: string;
};
type MdnsDiscoveryMode = "off" | "minimal" | "full";
type MdnsDiscoveryConfig = {
  /**
   * mDNS/Bonjour discovery broadcast mode (default: minimal).
   * - off: disable mDNS entirely
   * - minimal: omit cliPath/sshPort from TXT records
   * - full: include cliPath/sshPort in TXT records
   */
  mode?: MdnsDiscoveryMode;
};
type DiscoveryConfig = {
  wideArea?: WideAreaDiscoveryConfig;
  mdns?: MdnsDiscoveryConfig;
};
type TalkProviderConfig = {
  /** Provider API key (optional; provider-specific env fallback may apply). */apiKey?: SecretInput; /** Provider-owned Talk config fields. */
  [key: string]: unknown;
};
type TalkRealtimeConfig = {
  /** Active realtime voice provider. */provider?: string; /** Provider-specific realtime voice config keyed by provider id. */
  providers?: Record<string, TalkProviderConfig>; /** Provider model override for realtime sessions. */
  model?: string; /** Provider voice override for realtime sessions. */
  voice?: string; /** Additional system instructions appended to realtime Talk sessions. */
  instructions?: string; /** Realtime execution mode. */
  mode?: "realtime" | "stt-tts" | "transcription"; /** Byte/session transport. */
  transport?: "webrtc" | "provider-websocket" | "gateway-relay" | "managed-room"; /** Tool/agent strategy for realtime sessions. */
  brain?: "agent-consult" | "direct-tools" | "none"; /** How Gateway relay handles final user transcripts when the provider skips a consult. */
  consultRouting?: "provider-direct" | "force-agent-consult";
};
type ResolvedTalkConfig = {
  /** Active Talk TTS provider resolved from the current config payload. */provider: string; /** Provider config for the active Talk provider. */
  config: TalkProviderConfig;
};
type TalkConfig = {
  /** Active Talk TTS provider (for example "acme-speech"). */provider?: string; /** Provider-specific Talk config keyed by provider id. */
  providers?: Record<string, TalkProviderConfig>; /** Realtime Talk provider, model, voice, mode, transport, and brain config. */
  realtime?: TalkRealtimeConfig; /** Optional thinking level override for the agent run behind Talk realtime consults. */
  consultThinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "adaptive" | "max"; /** Optional fast mode override for the agent run behind Talk realtime consults. */
  consultFastMode?: boolean; /** BCP 47 locale id used for Talk speech recognition on device nodes. */
  speechLocale?: string; /** Stop speaking when user starts talking (default: true). */
  interruptOnSpeech?: boolean; /** Milliseconds of user silence before Talk mode sends the transcript after a pause. */
  silenceTimeoutMs?: number;
};
type TalkConfigResponse = TalkConfig & {
  /** Canonical active Talk payload for clients. */resolved?: ResolvedTalkConfig;
};
type GatewayControlUiConfig = {
  /** If false, the Gateway will not serve the Control UI (default /). */enabled?: boolean; /** Optional base path prefix for the Control UI (e.g. "/openclaw"). */
  basePath?: string; /** Optional filesystem root for Control UI assets (defaults to dist/control-ui). */
  root?: string;
  /**
   * Embed sandbox mode for hosted Control UI previews.
   * - strict: no script execution inside embeds
   * - scripts: allow scripts while keeping embeds origin-isolated (default)
   * - trusted: allow scripts and same-origin privileges
   */
  embedSandbox?: "strict" | "scripts" | "trusted";
  /**
   * DANGEROUS: Allow hosted embeds to load absolute external http(s) URLs.
   * Default off; prefer hosted /__openclaw__/canvas or /__openclaw__/a2ui content.
   */
  allowExternalEmbedUrls?: boolean; /** Optional max-width for grouped Control UI chat messages (default: min(900px, 68%)). */
  chatMessageMaxWidth?: string; /** Allowed browser origins for Control UI/WebChat websocket connections. */
  allowedOrigins?: string[];
  /**
   * DANGEROUS: Keep Host-header origin fallback behavior.
   * Supported long-term for deployments that intentionally rely on this policy.
   */
  dangerouslyAllowHostHeaderOriginFallback?: boolean;
  /**
   * Insecure-auth toggle.
   * Control UI still requires secure context + device identity unless
   * dangerouslyDisableDeviceAuth is enabled.
   */
  allowInsecureAuth?: boolean; /** DANGEROUS: Disable device identity checks for the Control UI (default: false). */
  dangerouslyDisableDeviceAuth?: boolean;
};
type GatewayAuthMode = "none" | "token" | "password" | "trusted-proxy";
/**
 * Configuration for trusted reverse proxy authentication.
 * Used when Clawdbot runs behind an identity-aware proxy (Pomerium, Caddy + OAuth, etc.)
 * that handles authentication and passes user identity via headers.
 */
type GatewayTrustedProxyConfig = {
  /**
   * Header name containing the authenticated user identity (required).
   * Common values: "x-forwarded-user", "x-remote-user", "x-pomerium-claim-email"
   */
  userHeader: string;
  /**
   * Additional headers that MUST be present for the request to be trusted.
   * Use this to verify the request actually came through the proxy.
   * Example: ["x-forwarded-proto", "x-forwarded-host"]
   */
  requiredHeaders?: string[];
  /**
   * Optional allowlist of user identities that can access the gateway.
   * If empty or omitted, all authenticated users from the proxy are allowed.
   * Example: ["nick@example.com", "admin@company.org"]
   */
  allowUsers?: string[];
  /**
   * Allow loopback proxy sources (127.0.0.1, ::1) in trusted-proxy mode.
   * Default false; enable only when a same-host reverse proxy is the intended
   * trust boundary and direct Gateway access is otherwise locked down.
   */
  allowLoopback?: boolean;
};
type GatewayAuthConfig = {
  /** Authentication mode for Gateway connections. Defaults to token when unset. */mode?: GatewayAuthMode; /** Shared token for token mode (plaintext or SecretRef). */
  token?: SecretInput; /** Shared password for password mode (consider env instead). */
  password?: SecretInput; /** Allow Tailscale identity headers when serve mode is enabled. */
  allowTailscale?: boolean; /** Rate-limit configuration for failed authentication attempts. */
  rateLimit?: GatewayAuthRateLimitConfig;
  /**
   * Configuration for trusted-proxy auth mode.
   * Required when mode is "trusted-proxy".
   */
  trustedProxy?: GatewayTrustedProxyConfig;
};
type GatewayAuthRateLimitConfig = {
  /** Maximum failed attempts per IP before blocking.  @default 10 */maxAttempts?: number; /** Sliding window duration in milliseconds.  @default 60000 (1 min) */
  windowMs?: number; /** Lockout duration in milliseconds after the limit is exceeded.  @default 300000 (5 min) */
  lockoutMs?: number; /** Exempt localhost/loopback addresses from auth rate limiting.  @default true */
  exemptLoopback?: boolean;
};
type GatewayTailscaleMode = "off" | "serve" | "funnel";
type GatewayTailscaleConfig = {
  /** Tailscale exposure mode for the Gateway control UI. */mode?: GatewayTailscaleMode; /** Reset serve/funnel configuration on shutdown. */
  resetOnExit?: boolean;
  /**
   * When `mode="serve"` and an externally configured Tailscale Funnel route
   * already covers the gateway port, skip re-applying `tailscale serve` on
   * startup. Lets operators manage Funnel exposure outside OpenClaw without
   * losing it across gateway restarts.
   */
  preserveFunnel?: boolean;
};
type GatewayRemoteConfig = {
  /** Whether remote gateway surfaces are enabled. Default: true when absent. */enabled?: boolean; /** Remote Gateway WebSocket URL (ws:// or wss://). */
  url?: string; /** Transport for macOS remote connections (ssh tunnel or direct WS). */
  transport?: "ssh" | "direct"; /** Gateway port on the remote SSH host. Defaults to 18789. */
  remotePort?: number; /** Token for remote auth (when the gateway requires token auth). */
  token?: SecretInput; /** Password for remote auth (when the gateway requires password auth). */
  password?: SecretInput; /** Expected TLS certificate fingerprint (sha256) for remote gateways. */
  tlsFingerprint?: string; /** SSH target for tunneling remote Gateway (user@host). */
  sshTarget?: string; /** SSH identity file path for tunneling remote Gateway. */
  sshIdentity?: string;
};
type GatewayReloadMode = "off" | "restart" | "hot" | "hybrid";
type GatewayReloadConfig = {
  /** Reload strategy for config changes (default: hybrid). */mode?: GatewayReloadMode; /** Debounce window for config reloads (ms). Default: 300. */
  debounceMs?: number;
  /**
   * Optional maximum time (ms) to wait for in-flight operations to complete
   * before forcing a restart. Absent uses the gateway's default bounded wait;
   * 0 waits indefinitely and logs periodic still-pending warnings.
   * Lower positive values risk aborting active subagent LLM calls.
   * @see https://github.com/openclaw/openclaw/issues/65485
   */
  deferralTimeoutMs?: number;
};
type GatewayHttpChatCompletionsConfig = {
  /**
   * If false, the Gateway will not serve `POST /v1/chat/completions`.
   * Default: false when absent.
   */
  enabled?: boolean;
  /**
   * Max request body size in bytes for `/v1/chat/completions`.
   * Default: 20MB.
   */
  maxBodyBytes?: number;
  /**
   * Max number of `image_url` parts processed from the latest user message.
   * Default: 8.
   */
  maxImageParts?: number;
  /**
   * Max cumulative decoded image bytes for all `image_url` parts in one request.
   * Default: 20MB.
   */
  maxTotalImageBytes?: number; /** Image input controls for `image_url` parts. */
  images?: GatewayHttpChatCompletionsImagesConfig;
};
type GatewayHttpChatCompletionsImagesConfig = {
  /** Allow URL fetches for `image_url` parts. Default: false. */allowUrl?: boolean;
  /**
   * Optional hostname allowlist for URL fetches.
   * Supports exact hosts and `*.example.com` wildcards.
   */
  urlAllowlist?: string[]; /** Allowed MIME types (case-insensitive). */
  allowedMimes?: string[]; /** Max bytes per image. Default: 10MB. */
  maxBytes?: number; /** Max redirects when fetching a URL. Default: 3. */
  maxRedirects?: number; /** Fetch timeout in ms. Default: 10s. */
  timeoutMs?: number;
};
type GatewayHttpResponsesConfig = {
  /**
   * If false, the Gateway will not serve `POST /v1/responses` (OpenResponses API).
   * Default: false when absent.
   */
  enabled?: boolean;
  /**
   * Max request body size in bytes for `/v1/responses`.
   * Default: 20MB.
   */
  maxBodyBytes?: number;
  /**
   * Max number of URL-based `input_file` + `input_image` parts per request.
   * Default: 8.
   */
  maxUrlParts?: number; /** File inputs (input_file). */
  files?: GatewayHttpResponsesFilesConfig; /** Image inputs (input_image). */
  images?: GatewayHttpResponsesImagesConfig;
};
type GatewayHttpResponsesFilesConfig = {
  /** Allow URL fetches for input_file. Default: true. */allowUrl?: boolean;
  /**
   * Optional hostname allowlist for URL fetches.
   * Supports exact hosts and `*.example.com` wildcards.
   */
  urlAllowlist?: string[]; /** Allowed MIME types (case-insensitive). */
  allowedMimes?: string[]; /** Max bytes per file. Default: 5MB. */
  maxBytes?: number; /** Max decoded characters per file. Default: 200k. */
  maxChars?: number; /** Max redirects when fetching a URL. Default: 3. */
  maxRedirects?: number; /** Fetch timeout in ms. Default: 10s. */
  timeoutMs?: number; /** PDF handling (application/pdf). */
  pdf?: GatewayHttpResponsesPdfConfig;
};
type GatewayHttpResponsesPdfConfig = {
  /** Max pages to parse/render. Default: 4. */maxPages?: number; /** Max pixels per rendered page. Default: 4M. */
  maxPixels?: number; /** Minimum extracted text length to skip rasterization. Default: 200 chars. */
  minTextChars?: number;
};
type GatewayHttpResponsesImagesConfig = {
  /** Allow URL fetches for input_image. Default: true. */allowUrl?: boolean;
  /**
   * Optional hostname allowlist for URL fetches.
   * Supports exact hosts and `*.example.com` wildcards.
   */
  urlAllowlist?: string[]; /** Allowed MIME types (case-insensitive). */
  allowedMimes?: string[]; /** Max bytes per image. Default: 10MB. */
  maxBytes?: number; /** Max redirects when fetching a URL. Default: 3. */
  maxRedirects?: number; /** Fetch timeout in ms. Default: 10s. */
  timeoutMs?: number;
};
type GatewayHttpEndpointsConfig = {
  chatCompletions?: GatewayHttpChatCompletionsConfig;
  responses?: GatewayHttpResponsesConfig;
};
type GatewayHttpSecurityHeadersConfig = {
  /**
   * Value for the Strict-Transport-Security response header.
   * Set to false to disable explicitly.
   *
   * Example: "max-age=31536000; includeSubDomains"
   */
  strictTransportSecurity?: string | false;
};
type GatewayHttpConfig = {
  endpoints?: GatewayHttpEndpointsConfig;
  securityHeaders?: GatewayHttpSecurityHeadersConfig;
};
type GatewayPushApnsRelayConfig = {
  /** Base HTTPS URL for the external iOS APNs relay service. */baseUrl?: string; /** Timeout in milliseconds for relay send requests (default: 10000). */
  timeoutMs?: number;
};
type GatewayPushApnsConfig = {
  relay?: GatewayPushApnsRelayConfig;
};
type GatewayPushConfig = {
  apns?: GatewayPushApnsConfig;
};
type GatewayNodePairingConfig = {
  /**
   * Opt-in CIDR/IP allowlist for auto-approving first-time node-role pairing.
   * Only applies to fresh node pairing requests with no requested scopes.
   * Default: unset/disabled.
   */
  autoApproveCidrs?: string[];
};
type GatewayNodesConfig = {
  /** Browser routing policy for node-hosted browser proxies. */browser?: {
    /** Routing mode (default: auto). */mode?: "auto" | "manual" | "off"; /** Pin to a specific node id/name (optional). */
    node?: string;
  }; /** Pairing policy for node-role gateway clients. */
  pairing?: GatewayNodePairingConfig; /** Additional node.invoke commands to allow on the gateway. */
  allowCommands?: string[]; /** Commands to deny even if they appear in the defaults or node claims. */
  denyCommands?: string[];
};
type GatewayToolsConfig = {
  /** Tools to deny via gateway HTTP /tools/invoke (extends defaults). */deny?: string[]; /** Tools to explicitly allow (removes from default deny list). */
  allow?: string[];
};
type GatewayWebchatConfig = {
  /** Max characters per text field in chat.history responses before truncation (default: 12000). */chatHistoryMaxChars?: number;
};
type GatewayConfig = {
  /** Single multiplexed port for Gateway WS + HTTP (default: 18789). */port?: number;
  /**
   * Explicit gateway mode. When set to "remote", local gateway start is disabled.
   * When set to "local", the CLI may start the gateway locally.
   */
  mode?: "local" | "remote";
  /**
   * Bind address policy for the Gateway WebSocket + Control UI HTTP server.
   * - auto: Loopback (127.0.0.1) if available, else 0.0.0.0 (fallback to all interfaces)
   * - lan: 0.0.0.0 (all interfaces, no fallback, current BYOH path is IPv4-only)
   * - loopback: 127.0.0.1 (local-only)
   * - tailnet: Tailnet IPv4 if available (100.64.0.0/10), else loopback
   * - custom: User-specified IPv4 address, fallback to 0.0.0.0 if unavailable (requires customBindHost)
   * IPv6-only BYOH is not natively supported on this path today. Use an IPv4 sidecar or proxy.
   * Default: loopback (127.0.0.1).
   */
  bind?: GatewayBindMode; /** Custom IPv4 address for bind="custom" mode. IPv6-only BYOH requires an IPv4 sidecar or proxy. */
  customBindHost?: string;
  controlUi?: GatewayControlUiConfig;
  auth?: GatewayAuthConfig;
  tailscale?: GatewayTailscaleConfig;
  remote?: GatewayRemoteConfig;
  reload?: GatewayReloadConfig;
  tls?: GatewayTlsConfig;
  http?: GatewayHttpConfig;
  push?: GatewayPushConfig;
  nodes?: GatewayNodesConfig;
  /**
   * IPs of trusted reverse proxies (e.g. Traefik, nginx). When a connection
   * arrives from one of these IPs, the Gateway trusts `x-forwarded-for`
   * to determine the client IP for local pairing and HTTP checks.
   */
  trustedProxies?: string[];
  /**
   * Allow `x-real-ip` as a fallback only when `x-forwarded-for` is missing.
   * Default: false (safer fail-closed behavior).
   */
  allowRealIpFallback?: boolean; /** Tool access restrictions for HTTP /tools/invoke endpoint. */
  tools?: GatewayToolsConfig; /** WebChat display/history settings. */
  webchat?: GatewayWebchatConfig;
  /**
   * Pre-auth Gateway WebSocket handshake timeout in milliseconds.
   * Env var OPENCLAW_HANDSHAKE_TIMEOUT_MS takes precedence. Default: 15000.
   */
  handshakeTimeoutMs?: number;
  /**
   * Channel health monitor interval in minutes.
   * Periodically checks channel health and restarts unhealthy channels.
   * Set to 0 to disable. Default: 5.
   */
  channelHealthCheckMinutes?: number;
  /**
   * Stale transport-activity threshold in minutes for the channel health monitor.
   * A connected channel that reports no provider-proven transport activity for
   * this duration is treated as a stale socket and restarted. Default: 30.
   */
  channelStaleEventThresholdMinutes?: number;
  /**
   * Maximum number of health-monitor-initiated channel restarts per hour.
   * Once this limit is reached, the monitor skips further restarts until
   * the rolling window expires. Default: 10.
   */
  channelMaxRestartsPerHour?: number;
};
//#endregion
//#region src/config/types.installs.d.ts
type InstallRecordBase = {
  source: "npm" | "archive" | "path" | "clawhub" | "git";
  spec?: string;
  sourcePath?: string;
  installPath?: string;
  version?: string;
  resolvedName?: string;
  resolvedVersion?: string;
  resolvedSpec?: string;
  integrity?: string;
  shasum?: string;
  resolvedAt?: string;
  installedAt?: string;
  clawhubUrl?: string;
  clawhubPackage?: string;
  clawhubFamily?: "code-plugin" | "bundle-plugin";
  clawhubChannel?: "official" | "community" | "private";
  artifactKind?: "legacy-zip" | "npm-pack";
  artifactFormat?: "zip" | "tgz";
  npmIntegrity?: string;
  npmShasum?: string;
  npmTarballName?: string;
  clawpackSha256?: string;
  clawpackSpecVersion?: number;
  clawpackManifestSha256?: string;
  clawpackSize?: number;
  gitUrl?: string;
  gitRef?: string;
  gitCommit?: string;
};
//#endregion
//#region src/config/types.hooks.d.ts
type HookMappingMatch = {
  path?: string;
  source?: string;
};
type HookMappingTransform = {
  module: string;
  export?: string;
};
type HookMappingConfig = {
  id?: string;
  match?: HookMappingMatch;
  action?: "wake" | "agent";
  wakeMode?: "now" | "next-heartbeat";
  name?: string; /** Route this hook to a specific agent (unknown ids fall back to the default agent). */
  agentId?: string;
  sessionKey?: string;
  messageTemplate?: string;
  textTemplate?: string;
  deliver?: boolean; /** DANGEROUS: Disable external content safety wrapping for this hook. */
  allowUnsafeExternalContent?: boolean;
  /**
   * "last" or any runtime channel id (including plugin channels).
   * Validation against configured/registered channels happens in gateway hooks runtime.
   */
  channel?: "last" | (string & {});
  to?: string; /** Override model for this hook (provider/model or alias). */
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
  transform?: HookMappingTransform;
};
type HooksGmailTailscaleMode = "off" | "serve" | "funnel";
type HooksGmailConfig = {
  account?: string;
  label?: string;
  topic?: string;
  subscription?: string;
  pushToken?: string;
  hookUrl?: string;
  includeBody?: boolean;
  maxBytes?: number;
  renewEveryMinutes?: number; /** DANGEROUS: Disable external content safety wrapping for Gmail hooks. */
  allowUnsafeExternalContent?: boolean;
  serve?: {
    bind?: string;
    port?: number;
    path?: string;
  };
  tailscale?: {
    mode?: HooksGmailTailscaleMode;
    path?: string; /** Optional tailscale serve/funnel target (port, host:port, or full URL). */
    target?: string;
  }; /** Optional model override for Gmail hook processing (provider/model or alias). */
  model?: string; /** Optional thinking level override for Gmail hook processing. */
  thinking?: "off" | "minimal" | "low" | "medium" | "high";
};
type HookConfig = {
  enabled?: boolean;
  env?: Record<string, string>;
  [key: string]: unknown;
};
type HookInstallRecord = InstallRecordBase & {
  hooks?: string[];
};
type InternalHooksConfig = {
  /** Enable hooks system */enabled?: boolean; /** Per-hook configuration overrides */
  entries?: Record<string, HookConfig>; /** Load configuration */
  load?: {
    /** Additional hook directories to scan */extraDirs?: string[];
  }; /** Install records for hook packs or hooks */
  installs?: Record<string, HookInstallRecord>;
};
type HooksConfig = {
  enabled?: boolean;
  path?: string;
  token?: string;
  /**
   * Default session key used for hook agent runs when no request/mapping session key is used.
   * If omitted, OpenClaw generates `hook:<uuid>` per request.
   */
  defaultSessionKey?: string;
  /**
   * Allow `sessionKey` from external `/hooks/agent` request payloads.
   * Default: false.
   */
  allowRequestSessionKey?: boolean;
  /**
   * Optional allowlist for explicit session keys (request + mapping). Example: ["hook:"].
   * Empty/omitted means no prefix restriction.
   */
  allowedSessionKeyPrefixes?: string[];
  /**
   * Restrict explicit hook `agentId` routing to these agent ids.
   * Omit or include `*` to allow any agent. Set `[]` to deny all explicit `agentId` routing.
   */
  allowedAgentIds?: string[];
  maxBodyBytes?: number;
  presets?: string[];
  transformsDir?: string;
  mappings?: HookMappingConfig[];
  gmail?: HooksGmailConfig; /** Internal agent event hooks */
  internal?: InternalHooksConfig;
};
//#endregion
//#region src/config/types.mcp.d.ts
type McpCodexToolApprovalMode = "auto" | "prompt" | "approve";
type McpServerCodexConfig = {
  /** OpenClaw agent ids that should receive this server in Codex app-server threads. */agents?: string[]; /** Codex MCP tool approval mode emitted as default_tools_approval_mode. */
  defaultToolsApprovalMode?: McpCodexToolApprovalMode; /** Codex-native spelling accepted for operator-authored config. */
  default_tools_approval_mode?: McpCodexToolApprovalMode;
};
type McpServerConfig = {
  /** Stdio transport: command to spawn. */command?: string; /** Stdio transport: arguments for the command. */
  args?: string[]; /** Environment variables passed to the server process (stdio only). */
  env?: Record<string, string | number | boolean>; /** Working directory for stdio server. */
  cwd?: string; /** Alias for cwd. */
  workingDirectory?: string; /** HTTP transport: URL of the remote MCP server (http or https). */
  url?: string; /** HTTP transport type for remote MCP servers. */
  transport?: "sse" | "streamable-http"; /** HTTP transport: extra HTTP headers sent with every request. */
  headers?: Record<string, string | number | boolean>; /** Optional connection timeout in milliseconds. */
  connectionTimeoutMs?: number; /** Codex-specific projection controls for Codex app-server/runtime config. */
  codex?: McpServerCodexConfig;
  [key: string]: unknown;
};
type McpConfig = {
  /** Named MCP server definitions managed by OpenClaw. */servers?: Record<string, McpServerConfig>;
  /**
   * Idle TTL for session-scoped bundled MCP runtimes, in milliseconds.
   *
   * Defaults to 10 minutes. Set to 0 to disable idle eviction.
   */
  sessionIdleTtlMs?: number;
};
//#endregion
//#region src/config/types.node-host.d.ts
type NodeHostBrowserProxyConfig = {
  /** Enable the browser proxy on the node host (default: true). */enabled?: boolean; /** Optional allowlist of profile names exposed via the proxy; when set, create/delete profile routes are blocked on the proxy surface. */
  allowProfiles?: string[];
};
type NodeHostConfig = {
  /** Browser proxy settings for node hosts. */browserProxy?: NodeHostBrowserProxyConfig;
};
//#endregion
//#region src/config/types.plugins.d.ts
type PluginEntryConfig = {
  enabled?: boolean;
  hooks?: {
    /** Controls prompt mutation via before_prompt_build and prompt fields from legacy before_agent_start. */allowPromptInjection?: boolean;
    /**
     * Controls access to raw conversation content from conversation hooks including
     * before_agent_run, before_model_resolve, before_agent_reply, llm_input, llm_output,
     * before_agent_finalize, and agent_end.
     * Non-bundled plugins must opt in explicitly; bundled plugins stay allowed unless disabled.
     */
    allowConversationAccess?: boolean; /** Default timeout in milliseconds for this plugin's typed hooks. */
    timeoutMs?: number; /** Per typed-hook timeout overrides in milliseconds. */
    timeouts?: Record<string, number>;
  };
  subagent?: {
    /** Explicitly allow this plugin to request per-run provider/model overrides for subagent runs. */allowModelOverride?: boolean;
    /**
     * Allowed override targets as canonical provider/model refs.
     * Use "*" to explicitly allow any model for this plugin.
     */
    allowedModels?: string[];
  };
  llm?: {
    /** Explicitly allow this plugin to request a model override for api.runtime.llm.complete. */allowModelOverride?: boolean;
    /**
     * Allowed completion model override targets as canonical provider/model refs.
     * Use "*" to explicitly allow any model for this plugin.
     */
    allowedModels?: string[]; /** Explicitly allow this plugin to run completions against a non-default agent id. */
    allowAgentIdOverride?: boolean;
  };
  config?: Record<string, unknown>;
};
type PluginSlotsConfig = {
  /** Select which plugin owns the memory slot ("none" disables memory plugins). */memory?: string; /** Select which plugin owns the context-engine slot. */
  contextEngine?: string;
};
type PluginsLoadConfig = {
  /** Additional plugin/extension paths to load. */paths?: string[];
};
type PluginInstallRecord = Omit<InstallRecordBase, "source"> & {
  source: InstallRecordBase["source"] | "marketplace";
  marketplaceName?: string;
  marketplaceSource?: string;
  marketplacePlugin?: string;
};
type PluginsConfig = {
  /** Enable or disable plugin loading. */enabled?: boolean; /** Optional plugin allowlist (plugin ids). */
  allow?: string[]; /** Optional plugin denylist (plugin ids). */
  deny?: string[];
  /**
   * Controls how bundled plugins participate in runtime provider discovery when
   * `allow` is configured.
   *
   * - `"allowlist"` (default): bundled provider plugins are gated by `allow`
   *   and `entries.<id>.enabled` like third-party plugins.
   * - `"compat"`: legacy mode for migrated configs; bundled provider plugins
   *   can be force-loaded regardless of the allowlist.
   */
  bundledDiscovery?: "compat" | "allowlist";
  load?: PluginsLoadConfig;
  slots?: PluginSlotsConfig;
  entries?: Record<string, PluginEntryConfig>;
  /**
   * Internal transient carrier for plugin install records during command flows.
   * This is intentionally omitted from the config schema and must not be
   * persisted to openclaw.json.
   */
  installs?: Record<string, PluginInstallRecord>;
};
//#endregion
//#region src/config/types.openclaw.d.ts
type SecurityAuditSuppression = {
  /** Exact security audit check id to suppress. */checkId: string; /** Optional case-insensitive substring required in the finding title. */
  titleIncludes?: string; /** Optional case-insensitive substring required in the finding detail. */
  detailIncludes?: string; /** Operator rationale for accepting this standing finding. */
  reason?: string;
};
type SecurityConfig = {
  audit?: {
    /** Accepted security audit findings to omit from active summary/findings. */suppressions?: SecurityAuditSuppression[];
  };
};
type SurfaceConfigEntry = {
  silentReply?: SilentReplyPolicyShape;
};
type OpenClawConfig = {
  $schema?: string;
  meta?: {
    /** Last OpenClaw version that wrote this config. */lastTouchedVersion?: string; /** ISO timestamp when this config was last written. */
    lastTouchedAt?: string;
  };
  auth?: AuthConfig;
  accessGroups?: AccessGroupsConfig;
  acp?: AcpConfig;
  env?: {
    /** Opt-in: import missing secrets from a login shell environment (exec `$SHELL -l -c 'env -0'`). */shellEnv?: {
      enabled?: boolean; /** Timeout for the login shell exec (ms). Default: 15000. */
      timeoutMs?: number;
    }; /** Inline env vars to apply when not already present in the process env. */
    vars?: Record<string, string>; /** Sugar: allow env vars directly under env (string values only). */
    [key: string]: string | Record<string, string> | {
      enabled?: boolean;
      timeoutMs?: number;
    } | undefined;
  };
  wizard?: {
    lastRunAt?: string;
    lastRunVersion?: string;
    lastRunCommit?: string;
    lastRunCommand?: string;
    lastRunMode?: "local" | "remote";
  };
  diagnostics?: DiagnosticsConfig;
  logging?: LoggingConfig;
  security?: SecurityConfig;
  cli?: CliConfig;
  crestodian?: CrestodianConfig;
  update?: {
    /** Update channel for git + npm installs ("stable", "beta", or "dev"). */channel?: "stable" | "beta" | "dev"; /** Check for updates on gateway start (npm installs only). */
    checkOnStart?: boolean; /** Core auto-update policy for package installs. */
    auto?: {
      /** Enable background auto-update checks and apply logic. Default: false. */enabled?: boolean; /** Stable channel minimum delay before auto-apply. Default: 6. */
      stableDelayHours?: number; /** Additional stable-channel jitter window. Default: 12. */
      stableJitterHours?: number; /** Beta channel check cadence. Default: 1 hour. */
      betaCheckIntervalHours?: number;
    };
  };
  browser?: BrowserConfig;
  ui?: {
    /** Accent color for OpenClaw UI chrome (hex). */seamColor?: string;
    assistant?: {
      /** Assistant display name for UI surfaces. */name?: string; /** Assistant avatar (emoji, short text, or image URL/data URI). */
      avatar?: string;
    };
  };
  secrets?: SecretsConfig;
  skills?: SkillsConfig;
  plugins?: PluginsConfig;
  surfaces?: Record<string, SurfaceConfigEntry>;
  models?: ModelsConfig;
  nodeHost?: NodeHostConfig;
  agents?: AgentsConfig;
  tools?: ToolsConfig;
  bindings?: AgentBinding[];
  broadcast?: BroadcastConfig;
  audio?: AudioConfig;
  media?: {
    /** Preserve original uploaded filenames when storing inbound media. */preserveFilenames?: boolean; /** Optional retention window for persisted inbound media cleanup. */
    ttlHours?: number;
  };
  messages?: MessagesConfig;
  commands?: CommandsConfig;
  approvals?: ApprovalsConfig;
  session?: SessionConfig;
  web?: WebConfig;
  channels?: ChannelsConfig;
  cron?: CronConfig;
  commitments?: CommitmentsConfig;
  hooks?: HooksConfig;
  discovery?: DiscoveryConfig;
  talk?: TalkConfig;
  gateway?: GatewayConfig;
  memory?: MemoryConfig;
  mcp?: McpConfig; /** Network-level SSRF protection via an operator-managed forward proxy. */
  proxy?: ProxyConfig;
};
type OpenClawConfigInput = Omit<OpenClawConfig, "models"> & {
  models?: ModelsConfigInput;
};
declare const openClawConfigStateBrand: unique symbol;
type BrandedConfigState<TState extends string> = OpenClawConfig & {
  readonly [openClawConfigStateBrand]?: TState;
};
type SourceConfig = BrandedConfigState<"source">;
type ResolvedSourceConfig = BrandedConfigState<"resolved-source">;
type RuntimeConfig = BrandedConfigState<"runtime">;
type ConfigValidationIssue = {
  path: string;
  message: string;
  allowedValues?: string[];
  allowedValuesHiddenCount?: number;
};
type LegacyConfigIssue = {
  path: string;
  message: string;
};
type ConfigFileSnapshot = {
  path: string;
  exists: boolean;
  raw: string | null;
  parsed: unknown;
  /**
   * Config authored on disk after $include resolution and ${ENV} substitution,
   * but BEFORE runtime defaults are applied.
   */
  sourceConfig: ResolvedSourceConfig;
  /**
   * Config after $include resolution and ${ENV} substitution, but BEFORE runtime
   * defaults are applied. Use this for config set/unset operations to avoid
   * leaking runtime defaults into the written config file.
   */
  resolved: ResolvedSourceConfig;
  valid: boolean; /** Runtime-shaped config used by in-process readers. */
  runtimeConfig: RuntimeConfig; /** @deprecated Prefer runtimeConfig. */
  config: RuntimeConfig;
  hash?: string;
  issues: ConfigValidationIssue[];
  warnings: ConfigValidationIssue[];
  legacyIssues: LegacyConfigIssue[];
};
//#endregion
export { GatewayReloadConfig as $, AcpSessionUpdateTag as $t, HooksGmailTailscaleMode as A, Gpt5PromptOverlayConfig as An, AuthProfileConfig as At, GatewayHttpChatCompletionsImagesConfig as B, AcpRuntimeCapabilities as Bt, HookConfig as C, AgentDefaultsConfig as Cn, CliConfig as Ct, HookMappingTransform as D, AgentStartupContextConfig as Dn, BrowserSsrFPolicyConfig as Dt, HookMappingMatch as E, AgentRunRetriesConfig as En, BrowserSnapshotDefaults as Et, GatewayAuthRateLimitConfig as F, AcpConfig as Ft, GatewayHttpResponsesImagesConfig as G, AcpRuntimePromptMode as Gt, GatewayHttpEndpointsConfig as H, AcpRuntimeEnsureInput as Ht, GatewayBindMode as I, AcpDispatchConfig as It, GatewayNodePairingConfig as J, AcpRuntimeTurn as Jt, GatewayHttpResponsesPdfConfig as K, AcpRuntimeSessionMode as Kt, GatewayConfig as L, AcpRuntimeConfig as Lt, DiscoveryConfig as M, PromptOverlaysConfig as Mn, AccessGroupsConfig as Mt, GatewayAuthConfig as N, SubagentDelegationMode as Nn, DiscordChannelAudienceAccessGroup as Nt, HooksConfig as O, CliBackendConfig as On, BrowserTabCleanupConfig as Ot, GatewayAuthMode as P, SilentReplyConversationType as Pn, MessageSendersAccessGroup as Pt, GatewayPushConfig as Q, AcpRuntimeTurnResultError as Qt, GatewayControlUiConfig as R, AcpStreamConfig as Rt, McpServerConfig as S, AgentContextPruningConfig as Sn, CliBannerTaglineMode as St, HookMappingConfig as T, AgentModelListConfig as Tn, BrowserProfileConfig as Tt, GatewayHttpResponsesConfig as U, AcpRuntimeEvent as Ut, GatewayHttpConfig as V, AcpRuntimeDoctorReport as Vt, GatewayHttpResponsesFilesConfig as W, AcpRuntimeHandle as Wt, GatewayPushApnsConfig as X, AcpRuntimeTurnInput as Xt, GatewayNodesConfig as Y, AcpRuntimeTurnAttachment as Yt, GatewayPushApnsRelayConfig as Z, AcpRuntimeTurnResult as Zt, NodeHostBrowserProxyConfig as _, AgentCompactionMode as _n, CronFailureAlertConfig as _t, OpenClawConfigInput as a, AgentRuntimeAcpConfig as an, GatewayToolsConfig as at, McpConfig as b, AgentContextInjection as bn, CronRetryOn as bt, SecurityAuditSuppression as c, SkillConfig as cn, MdnsDiscoveryConfig as ct, SurfaceConfigEntry as d, SkillsLimitsConfig as dn, TalkConfig as dt, AgentAcpBinding as en, GatewayReloadMode as et, PluginEntryConfig as f, SkillsLoadConfig as fn, TalkConfigResponse as ft, PluginsLoadConfig as g, AgentCompactionMidTurnPrecheckConfig as gn, CronConfig as gt, PluginsConfig as h, AgentCompactionMemoryFlushConfig as hn, WideAreaDiscoveryConfig as ht, OpenClawConfig as i, AgentRouteBinding as in, GatewayTlsConfig as it, InternalHooksConfig as j, OptionalBootstrapFileName as jn, AccessGroupConfig as jt, HooksGmailConfig as k, EmbeddedPiExecutionContract as kn, AuthConfig as kt, SecurityConfig as l, SkillsConfig as ln, MdnsDiscoveryMode as lt, PluginSlotsConfig as m, AgentCompactionIdentifierPolicy as mn, TalkRealtimeConfig as mt, ConfigValidationIssue as n, AgentBindingMatch as nn, GatewayTailscaleConfig as nt, ResolvedSourceConfig as o, AgentRuntimeConfig as on, GatewayTrustedProxyConfig as ot, PluginInstallRecord as p, AgentCompactionConfig as pn, TalkProviderConfig as pt, GatewayHttpSecurityHeadersConfig as q, AcpRuntimeStatus as qt, LegacyConfigIssue as r, AgentConfig as rn, GatewayTailscaleMode as rt, RuntimeConfig as s, AgentsConfig as sn, GatewayWebchatConfig as st, ConfigFileSnapshot as t, AgentBinding as tn, GatewayRemoteConfig as tt, SourceConfig as u, SkillsInstallConfig as un, ResolvedTalkConfig as ut, NodeHostConfig as v, AgentCompactionPostIndexSyncMode as vn, CronFailureDestinationConfig as vt, HookInstallRecord as w, AgentModelEntryConfig as wn, BrowserConfig as wt, McpServerCodexConfig as x, AgentContextLimitsConfig as xn, CommitmentsConfig as xt, McpCodexToolApprovalMode as y, AgentCompactionQualityGuardConfig as yn, CronRetryConfig as yt, GatewayHttpChatCompletionsConfig as z, AcpRuntime as zt };