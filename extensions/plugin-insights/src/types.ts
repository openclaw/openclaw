// ============================================================
// OpenClaw SDK-compatible types for plugin-insights
//
// These types mirror the real OpenClaw plugin-sdk interfaces.
// When integrating with the real SDK, replace these with imports
// from openclaw/plugin-sdk/core (or /compat for broader internals),
// @mariozechner/pi-ai, and @mariozechner/pi-agent-core.
// ============================================================

// --- pi-ai compatible message types ---

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
}

export interface ToolCallContent {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}

export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCallContent)[];
  usage: Usage;
  model: string;
  api: string;
  provider: string;
  stopReason: string;
  timestamp: number;
}

export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  content: (TextContent | ImageContent)[];
  isError: boolean;
  timestamp: number;
}

export type PiMessage = UserMessage | AssistantMessage | ToolResultMessage;

// AgentMessage in the real SDK: Message | CustomAgentMessages[keyof CustomAgentMessages]
// We use a broad type to accept any message shape from the runtime
export type AgentMessage = PiMessage | Record<string, unknown>;

// --- ContextEngine types (from openclaw/plugin-sdk → context-engine/types) ---

export interface ContextEngineInfo {
  id: string;
  name: string;
  version?: string;
  ownsCompaction?: boolean;
}

export interface AssembleResult {
  messages: AgentMessage[];
  estimatedTokens: number;
  systemPromptAddition?: string;
}

export interface CompactResult {
  ok: boolean;
  compacted: boolean;
  reason?: string;
}

export interface IngestResult {
  ingested: boolean;
}

export interface BootstrapResult {
  bootstrapped: boolean;
  importedMessages?: number;
  reason?: string;
}

export type SubagentEndReason = "deleted" | "completed" | "swept" | "released";

export interface SubagentSpawnPreparation {
  rollback: () => void | Promise<void>;
}

export interface ContextEngine {
  readonly info: ContextEngineInfo;

  // Required methods
  ingest(params: {
    sessionId: string;
    message: AgentMessage;
    isHeartbeat?: boolean;
  }): Promise<IngestResult>;

  assemble(params: {
    sessionId: string;
    messages: AgentMessage[];
    tokenBudget?: number;
  }): Promise<AssembleResult>;

  compact(params: {
    sessionId: string;
    sessionFile: string;
    tokenBudget?: number;
    force?: boolean;
  }): Promise<CompactResult>;

  // Optional hooks
  bootstrap?(params: { sessionId: string; sessionFile: string }): Promise<BootstrapResult>;

  afterTurn?(params: AfterTurnParams): Promise<void>;

  prepareSubagentSpawn?(params: {
    parentSessionKey: string;
    childSessionKey: string;
    ttlMs?: number;
  }): Promise<SubagentSpawnPreparation | undefined>;

  onSubagentEnded?(params: { childSessionKey: string; reason: SubagentEndReason }): Promise<void>;

  dispose?(): Promise<void>;
}

export type ContextEngineFactory = () => ContextEngine | Promise<ContextEngine>;

/** Parameters passed to afterTurn by the OpenClaw runtime */
export interface AfterTurnParams {
  sessionId: string;
  sessionFile: string;
  messages: AgentMessage[];
  prePromptMessageCount: number;
  autoCompactionSummary?: string;
  isHeartbeat?: boolean;
  tokenBudget?: number;
}

// --- OpenClaw Plugin API types ---

export interface PluginLogger {
  debug?(...args: unknown[]): void;
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Reply payload returned by command handlers */
export interface ReplyPayload {
  text?: string;
  isError?: boolean;
}

export interface PluginCommandContext {
  /** The sender's identifier */
  senderId?: string;
  /** The channel/surface (e.g., "telegram", "discord") */
  channel: string;
  /** Whether the sender is on the allowlist */
  isAuthorizedSender: boolean;
  /** Raw command arguments after the command name (single string) */
  args?: string;
  /** The full normalized command body */
  commandBody: string;
  /** Current OpenClaw configuration */
  config: Record<string, unknown>;
}

export interface OpenClawPluginCommandDefinition {
  name: string;
  description: string;
  nativeNames?: Partial<Record<string, string>> & { default?: string };
  acceptsArgs?: boolean;
  requireAuth?: boolean;
  handler(ctx: PluginCommandContext): ReplyPayload | Promise<ReplyPayload>;
}

/** Tool result type from pi-agent-core */
export interface AgentToolResult {
  content: (TextContent | ImageContent)[];
  details: unknown;
}

/** Agent tool type compatible with real OpenClaw AnyAgentTool (pi-agent-core) */
export interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<AgentToolResult>;
  ownerOnly?: boolean;
}

/** Helper to create a text-only AgentToolResult */
export function textToolResult(text: string): AgentToolResult {
  return { content: [{ type: "text", text }], details: undefined };
}

export interface OpenClawPluginApi {
  id: string;
  name: string;
  version?: string;
  description?: string;
  source: string;
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;

  registerTool(tool: AgentTool): void;
  registerCommand(command: OpenClawPluginCommandDefinition): void;
  registerContextEngine(id: string, factory: ContextEngineFactory): void;
  registerCli?(
    registrar: (ctx: unknown) => void | Promise<void>,
    opts?: { commands?: string[] },
  ): void;
  resolvePath?(input: string): string;

  // Hook registration — supports typed SDK hooks (after_tool_call, etc.)
  on(
    hookName: string,
    handler: (...args: any[]) => void | Promise<void>,
    opts?: { priority?: number },
  ): void;
}

/** Plugin definition shape expected by OpenClaw */
export interface OpenClawPluginDefinition {
  id?: string;
  name?: string;
  description?: string;
  version?: string;
  configSchema?: Record<string, unknown>;
  register?(api: OpenClawPluginApi): void | Promise<void>;
  activate?(api: OpenClawPluginApi): void | Promise<void>;
}

// ============================================================
// Plugin Insights internal types
// ============================================================

export interface PluginInsightsConfig {
  enabled: boolean;
  dbPath: string;
  retentionDays: number;
  llmJudge: LLMJudgeConfig;
}

export interface LLMJudgeConfig {
  enabled: boolean;
  apiKey?: string;
  baseUrl: string;
  model: string;
  maxEvalPerDay: number;
}

export const DEFAULT_CONFIG: PluginInsightsConfig = {
  enabled: true,
  dbPath: "~/.openclaw/plugin-insights.db",
  retentionDays: 90,
  llmJudge: {
    enabled: false,
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    maxEvalPerDay: 20,
  },
};

// DB row types

export interface TurnRow {
  id: number;
  session_id: string;
  turn_index: number;
  timestamp: string;
  user_prompt_preview: string | null;
  assistant_response_preview: string | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  total_tokens: number | null;
  tool_calls_json: string | null;
  plugins_triggered_json: string | null;
  created_at: string;
}

export interface PluginEventRow {
  id: number;
  turn_id: number;
  plugin_id: string;
  detection_method: "tool_call" | "context_injection" | "self_report";
  action: string | null;
  metadata_json: string | null;
  created_at: string;
}

export interface SatisfactionSignalRow {
  id: number;
  turn_id: number;
  signal_type: "accepted" | "retried" | "corrected";
  confidence: number | null;
  next_turn_id: number | null;
  created_at: string;
}

export interface LLMScoreRow {
  id: number;
  turn_id: number;
  accuracy_score: number;
  completeness_score: number;
  relevance_score: number;
  overall_score: number;
  judge_model: string;
  judge_response_json: string | null;
  created_at: string;
}

export interface ToolPluginMappingRow {
  tool_name: string;
  plugin_id: string;
  plugin_name: string | null;
  updated_at: string;
}

export interface PluginInstallRow {
  plugin_id: string;
  first_seen_at: string;
  last_seen_at: string;
}

// Metrics result types

export interface TriggerFrequencyResult {
  pluginId: string;
  totalTriggers: number;
  triggersPerDay: number;
  triggersPerSession: number;
  dailyTrend: { date: string; count: number }[];
}

export interface TokenDeltaResult {
  pluginId: string;
  avgTokensWithPlugin: number;
  avgTokensWithoutPlugin: number;
  deltaTokens: number;
  deltaPercent: number;
  estimatedMonthlyCostUSD: number;
}

export interface ConversationTurnsResult {
  pluginId: string;
  avgTurnsWithPlugin: number;
  avgTurnsWithoutPlugin: number;
  deltaTurns: number;
  deltaPercent: number;
}

export interface ImplicitSatisfactionResult {
  pluginId: string;
  acceptanceRate: number;
  retryRate: number;
  correctionRate: number;
  totalSignals: number;
}

export interface LLMJudgeResult {
  pluginId: string;
  avgScoreWithPlugin: number;
  avgScoreWithoutPlugin: number;
  deltaScore: number;
  sampleCount: number;
}

export interface PluginReport {
  pluginId: string;
  pluginName?: string;
  installedDays: number;
  triggerFrequency: TriggerFrequencyResult;
  tokenDelta: TokenDeltaResult;
  conversationTurns: ConversationTurnsResult;
  implicitSatisfaction: ImplicitSatisfactionResult;
  llmJudge?: LLMJudgeResult;
  verdict: PluginVerdict;
}

export type VerdictLevel = "keep" | "low_usage" | "expensive" | "low_satisfaction" | "remove";

export interface PluginVerdict {
  level: VerdictLevel;
  label: string;
  reason: string;
}

export interface CoverageInfo {
  /** Whether all observed tools have plugin mappings */
  isComplete: boolean;
  /** Tools observed at runtime but not mapped to any plugin */
  unmappedTools: { toolName: string; callCount: number }[];
}

export interface InsightsReport {
  periodStart: string;
  periodEnd: string;
  plugins: PluginReport[];
  generatedAt: string;
  /** Attribution coverage metadata — present when unmapped tools exist */
  coverage?: CoverageInfo;
}

// Insights API (Layer 3) types

export interface InsightsAPIReport {
  pluginId: string;
  action: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

// --- Message utility helpers ---

/** Extract text content from a UserMessage */
export function extractUserText(msg: AgentMessage): string | null {
  if (!msg || typeof msg !== "object" || !("role" in msg)) return null;
  if (msg.role !== "user") return null;

  const userMsg = msg as UserMessage;
  if (typeof userMsg.content === "string") return userMsg.content;
  if (Array.isArray(userMsg.content)) {
    return (
      userMsg.content
        .filter((c): c is TextContent => c.type === "text")
        .map((c) => c.text)
        .join("\n") || null
    );
  }
  return null;
}

/** Extract text content from an AssistantMessage */
export function extractAssistantText(msg: AgentMessage): string | null {
  if (!msg || typeof msg !== "object" || !("role" in msg)) return null;
  if (msg.role !== "assistant") return null;

  const assistantMsg = msg as AssistantMessage;
  if (!Array.isArray(assistantMsg.content)) return null;
  return (
    assistantMsg.content
      .filter((c): c is TextContent => c.type === "text")
      .map((c) => c.text)
      .join("\n") || null
  );
}

/** Extract ToolCall entries from an AssistantMessage */
export function extractToolCalls(msg: AgentMessage): ToolCallContent[] {
  if (!msg || typeof msg !== "object" || !("role" in msg)) return [];
  if (msg.role !== "assistant") return [];

  const assistantMsg = msg as AssistantMessage;
  if (!Array.isArray(assistantMsg.content)) return [];
  return assistantMsg.content.filter((c): c is ToolCallContent => c.type === "toolCall");
}

/** Extract Usage from an AssistantMessage */
export function extractUsage(msg: AgentMessage): Usage | null {
  if (!msg || typeof msg !== "object" || !("role" in msg)) return null;
  if (msg.role !== "assistant") return null;

  const assistantMsg = msg as AssistantMessage;
  return assistantMsg.usage ?? null;
}

/** Extract all text from any message for context scanning.
 *  Handles user, assistant, AND unknown roles (system, context, etc.)
 *  since OpenClaw plugins inject context into system/context messages. */
export function extractAllText(msg: AgentMessage): string | null {
  // Try known roles first
  const known = extractUserText(msg) ?? extractAssistantText(msg);
  if (known) return known;

  // Handle unknown roles (system, context, toolResult, etc.)
  if (!msg || typeof msg !== "object") return null;

  const rec = msg as Record<string, unknown>;

  // String content
  if (typeof rec.content === "string") return rec.content;

  // Array content — extract text parts
  if (Array.isArray(rec.content)) {
    const texts = rec.content
      .filter(
        (c: unknown): c is { type: string; text: string } =>
          typeof c === "object" &&
          c !== null &&
          "text" in c &&
          typeof (c as Record<string, unknown>).text === "string",
      )
      .map((c) => c.text);
    return texts.length > 0 ? texts.join("\n") : null;
  }

  // systemPrompt field (present in some hook events)
  if (typeof rec.systemPrompt === "string") return rec.systemPrompt;

  return null;
}
