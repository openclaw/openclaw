/**
 * Estimates prompt pressure and decides pre-prompt compaction routing.
 */
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { SessionContextBudgetStatus } from "../../../config/sessions.js";
import { estimateStringChars } from "../../../utils/cjk-chars.js";
import {
  MIN_PROMPT_BUDGET_RATIO,
  MIN_PROMPT_BUDGET_TOKENS,
} from "../../agent-compaction-constants.js";
import { SAFETY_MARGIN } from "../../compaction.js";
import { resolveOpenAIStrictToolSetting } from "../../openai-strict-tool-setting.js";
import { projectOpenAITools } from "../../openai-tool-projection.js";
import {
  normalizeOpenAIStrictToolParameters,
  resolveOpenAIProjectedToolsStrictToolFlag,
} from "../../openai-tool-schema.js";
import type { AgentMessage, BashExecutionMessage } from "../../runtime/index.js";
import {
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  bashExecutionToText,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
} from "../../runtime/index.js";
import { estimateToolResultReductionPotential } from "../tool-result-truncation.js";
import type { PreemptiveCompactionRoute } from "./preemptive-compaction.types.js";

export const PREEMPTIVE_OVERFLOW_ERROR_TEXT =
  "Context overflow: prompt too large for the model (precheck).";

const ESTIMATED_CHARS_PER_TOKEN = 4;
const TOOL_RESULT_CHARS_PER_TOKEN = 2;
const JSON_PAYLOAD_CHARS_PER_TOKEN = 3;
const MESSAGE_BOUNDARY_OVERHEAD_TOKENS = 12;
const CONTENT_BLOCK_OVERHEAD_TOKENS = 6;
const IMAGE_BLOCK_TOKENS = 2_000;
const TRUNCATION_ROUTE_BUFFER_TOKENS = 512;
const LIGHTWEIGHT_MIN_PROMPT_BUDGET_RATIO = 0.875;

type ToolSchemaTokenPressureSource = {
  name?: unknown;
  description?: unknown;
  parameters?: unknown;
  inputSchema?: unknown;
};

type ToolSchemaBudgetCompat = {
  supportsStrictMode?: unknown;
  unsupportedToolSchemaKeywords?: unknown;
  omitEmptyArrayItems?: unknown;
};

type ToolSchemaBudgetModel = {
  provider?: unknown;
  api?: unknown;
  baseUrl?: unknown;
  id?: unknown;
  compat?: unknown;
};

type OpenAIToolPayloadShape = "responses" | "completions";

/** Pre-prompt routing decision plus the budget facts used to explain it in logs and session state. */
export type PreemptiveCompactionDecision = {
  route: PreemptiveCompactionRoute;
  shouldCompact: boolean;
  estimatedPromptTokens: number;
  pressureSource?: string;
  promptBudgetBeforeReserve: number;
  overflowTokens: number;
  toolResultReducibleChars: number;
  effectiveReserveTokens: number;
};

/** Token pressure reported by the rendered provider-boundary prompt when available. */
export type LlmBoundaryTokenPressure = {
  estimatedPromptTokens: number;
  source: string;
  renderedChars?: number;
};

function estimateStringTokenPressure(text: string, charsPerToken = ESTIMATED_CHARS_PER_TOKEN) {
  return Math.ceil(estimateStringChars(text) / charsPerToken);
}

function estimateJsonPayloadTokenPressure(
  value: unknown,
  charsPerToken = JSON_PAYLOAD_CHARS_PER_TOKEN,
): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      ? Math.ceil(estimateStringChars(serialized) / charsPerToken)
      : 1;
  } catch {
    return 256;
  }
}

function estimateIdentifierTokenPressure(
  value: unknown,
  charsPerToken = JSON_PAYLOAD_CHARS_PER_TOKEN,
): number {
  if (value == null) {
    return 0;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return estimateStringTokenPressure(String(value), charsPerToken);
  }
  return estimateJsonPayloadTokenPressure(value, charsPerToken);
}

function estimateContentBlockTokenPressure(
  block: unknown,
  charsPerToken = ESTIMATED_CHARS_PER_TOKEN,
): number {
  if (typeof block === "string") {
    return estimateStringTokenPressure(block, charsPerToken);
  }
  if (!isRecord(block)) {
    return estimateJsonPayloadTokenPressure(block, charsPerToken);
  }

  const type = block.type;
  if (type === "text" && typeof block.text === "string") {
    return CONTENT_BLOCK_OVERHEAD_TOKENS + estimateStringTokenPressure(block.text, charsPerToken);
  }
  if (type === "thinking" && typeof block.thinking === "string") {
    return (
      CONTENT_BLOCK_OVERHEAD_TOKENS + estimateStringTokenPressure(block.thinking, charsPerToken)
    );
  }
  if (type === "image") {
    return IMAGE_BLOCK_TOKENS;
  }
  return CONTENT_BLOCK_OVERHEAD_TOKENS + estimateJsonPayloadTokenPressure(block, charsPerToken);
}

function estimateToolResultContentTokenPressure(content: unknown): number {
  if (typeof content === "string") {
    return estimateStringTokenPressure(content, TOOL_RESULT_CHARS_PER_TOKEN);
  }
  if (Array.isArray(content)) {
    return content.reduce(
      (sum, block) => sum + estimateContentBlockTokenPressure(block, TOOL_RESULT_CHARS_PER_TOKEN),
      0,
    );
  }
  if (content !== undefined) {
    return estimateJsonPayloadTokenPressure(content, TOOL_RESULT_CHARS_PER_TOKEN);
  }
  return 0;
}

function estimateAssistantToolCallTokenPressure(block: Record<string, unknown>): number {
  const args = block.arguments ?? block.input ?? block.args ?? {};
  return (
    CONTENT_BLOCK_OVERHEAD_TOKENS +
    estimateIdentifierTokenPressure(block.name, JSON_PAYLOAD_CHARS_PER_TOKEN) +
    estimateJsonPayloadTokenPressure(args, JSON_PAYLOAD_CHARS_PER_TOKEN)
  );
}

function estimateContentTokenPressure(content: unknown): number {
  if (typeof content === "string") {
    return estimateStringTokenPressure(content);
  }
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => sum + estimateContentBlockTokenPressure(block), 0);
  }
  if (content !== undefined) {
    return estimateJsonPayloadTokenPressure(content);
  }
  return 0;
}

function estimateToolSchemaTokenPressure(
  tools: readonly ToolSchemaTokenPressureSource[] | undefined,
  model: ToolSchemaBudgetModel | undefined,
): number {
  if (!tools?.length) {
    return 0;
  }
  const payload = buildProviderVisibleToolBudgetPayload(tools, model);
  return Math.max(
    0,
    Math.ceil(
      estimateJsonPayloadTokenPressure(payload, JSON_PAYLOAD_CHARS_PER_TOKEN) * SAFETY_MARGIN,
    ),
  );
}

function buildProviderVisibleToolBudgetPayload(
  tools: readonly ToolSchemaTokenPressureSource[],
  model: ToolSchemaBudgetModel | undefined,
): unknown {
  const openAIToolPayloadShape = resolveOpenAIToolPayloadShape(model?.api);
  if (openAIToolPayloadShape) {
    return buildOpenAIToolBudgetPayload(tools, model, openAIToolPayloadShape);
  }
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? tool.inputSchema ?? {},
    },
  }));
}

function resolveOpenAIToolPayloadShape(api: unknown): OpenAIToolPayloadShape | undefined {
  switch (api) {
    case "openai-responses":
    case "openai-chatgpt-responses":
    case "azure-openai-responses":
      return "responses";
    case "openai-completions":
      return "completions";
    default:
      return undefined;
  }
}

function buildOpenAIToolBudgetPayload(
  tools: readonly ToolSchemaTokenPressureSource[],
  model: ToolSchemaBudgetModel | undefined,
  shape: OpenAIToolPayloadShape,
): unknown {
  const projection = projectOpenAITools(
    tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters ?? tool.inputSchema ?? {},
    })),
  );
  const modelCompat = readToolSchemaBudgetCompat(model?.compat);
  const supportsStrictMode =
    shape === "completions" && typeof modelCompat?.supportsStrictMode === "boolean"
      ? modelCompat.supportsStrictMode
      : undefined;
  const strict = resolveOpenAIProjectedToolsStrictToolFlag(
    projection,
    resolveOpenAIStrictToolSetting(model ?? {}, {
      transport: "stream",
      ...(supportsStrictMode !== undefined ? { supportsStrictMode } : {}),
    }),
  );
  return projection.tools.map((tool) => {
    const parameters = normalizeOpenAIStrictToolParameters(
      tool.parameters,
      strict === true,
      modelCompat,
    );
    if (shape === "responses") {
      return {
        type: "function",
        name: tool.name,
        description: tool.description,
        parameters,
        ...(strict !== undefined ? { strict } : {}),
      };
    }
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters,
        ...(strict !== undefined ? { strict } : {}),
      },
    };
  });
}

function readToolSchemaBudgetCompat(compat: unknown): ToolSchemaBudgetCompat | undefined {
  if (!isRecord(compat)) {
    return undefined;
  }
  return {
    supportsStrictMode: compat.supportsStrictMode,
    unsupportedToolSchemaKeywords: compat.unsupportedToolSchemaKeywords,
    omitEmptyArrayItems: compat.omitEmptyArrayItems,
  };
}

function isToolResultMessage(message: AgentMessage): boolean {
  const record = message as unknown as { role?: unknown; type?: unknown };
  return record.role === "toolResult" || record.role === "tool" || record.type === "toolResult";
}

function estimateMessageTokenPressure(message: AgentMessage): number {
  const record = message as unknown as Record<string, unknown>;
  let tokens = MESSAGE_BOUNDARY_OVERHEAD_TOKENS;

  if (isToolResultMessage(message)) {
    tokens += estimateToolResultContentTokenPressure(record.content);
    tokens += estimateIdentifierTokenPressure(record.toolName ?? record.tool_name);
    return tokens;
  }

  if (record.role === "bashExecution") {
    if (record.excludeFromContext === true) {
      return 0;
    }
    tokens += estimateStringTokenPressure(
      bashExecutionToText(record as unknown as BashExecutionMessage),
    );
    return tokens;
  }

  if (record.role === "branchSummary") {
    const summary = typeof record.summary === "string" ? record.summary : "";
    tokens += estimateStringTokenPressure(BRANCH_SUMMARY_PREFIX + summary + BRANCH_SUMMARY_SUFFIX);
    return tokens;
  }

  if (record.role === "compactionSummary") {
    const summary = typeof record.summary === "string" ? record.summary : "";
    tokens += estimateStringTokenPressure(
      COMPACTION_SUMMARY_PREFIX + summary + COMPACTION_SUMMARY_SUFFIX,
    );
    return tokens;
  }

  if (record.role === "assistant") {
    const content = record.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (isRecord(block) && (block.type === "toolCall" || block.type === "tool_use")) {
          tokens += estimateAssistantToolCallTokenPressure(block);
        } else {
          tokens += estimateContentBlockTokenPressure(block);
        }
      }
    } else {
      tokens += estimateContentTokenPressure(content);
    }

    const toolCalls = record.toolCalls ?? record.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const toolCall of toolCalls) {
        tokens += isRecord(toolCall)
          ? estimateAssistantToolCallTokenPressure(toolCall)
          : estimateJsonPayloadTokenPressure(toolCall);
      }
    }
    return tokens;
  }

  tokens += estimateContentTokenPressure(record.content);
  return tokens;
}

/**
 * Estimates the prompt pressure at the LLM boundary from transcript messages,
 * optional system prompt, and current prompt text. The result intentionally
 * includes a safety margin because this path runs before provider tokenization.
 */
export function estimateLlmBoundaryTokenPressure(params: {
  messages: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
}): number {
  const historyTokens = params.messages.reduce(
    (sum, message) => sum + estimateMessageTokenPressure(message),
    0,
  );
  const systemTokens =
    typeof params.systemPrompt === "string" && params.systemPrompt.trim().length > 0
      ? MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.systemPrompt)
      : 0;
  const promptTokens =
    MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.prompt);
  return Math.max(0, Math.ceil((historyTokens + systemTokens + promptTokens) * SAFETY_MARGIN));
}

/** Estimates only the rendered prompt/system portion when history has already been accounted for. */
export function estimateRenderedLlmBoundaryTokenPressure(params: {
  systemPrompt?: string;
  prompt: string;
}): number {
  const systemTokens =
    typeof params.systemPrompt === "string" && params.systemPrompt.trim().length > 0
      ? MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.systemPrompt)
      : 0;
  const promptTokens =
    MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.prompt);
  return Math.max(0, Math.ceil((systemTokens + promptTokens) * SAFETY_MARGIN));
}

function normalizeLlmBoundaryTokenPressure(
  pressure: LlmBoundaryTokenPressure | undefined,
): LlmBoundaryTokenPressure | undefined {
  if (!pressure || !Number.isFinite(pressure.estimatedPromptTokens)) {
    return undefined;
  }
  const estimatedPromptTokens = Math.max(0, Math.ceil(pressure.estimatedPromptTokens));
  return {
    estimatedPromptTokens,
    source: pressure.source.trim() || "rendered_llm_boundary",
    ...(typeof pressure.renderedChars === "number" && Number.isFinite(pressure.renderedChars)
      ? { renderedChars: Math.max(0, Math.ceil(pressure.renderedChars)) }
      : {}),
  };
}

/**
 * Decides whether a run should compact before submitting the prompt, and
 * whether reducible tool results can avoid or follow compaction. Rendered LLM
 * boundary pressure wins over local transcript estimates when supplied.
 */
export function shouldPreemptivelyCompactBeforePrompt(params: {
  messages: AgentMessage[];
  unwindowedMessages?: AgentMessage[];
  systemPrompt?: string;
  prompt: string;
  contextMode?: "full" | "lightweight";
  promptImageCount?: number;
  tools?: readonly ToolSchemaTokenPressureSource[];
  toolBudgetModel?: ToolSchemaBudgetModel;
  contextTokenBudget: number;
  reserveTokens: number;
  toolResultMaxChars?: number;
  llmBoundaryTokenPressure?: LlmBoundaryTokenPressure;
}): PreemptiveCompactionDecision {
  let messagesForPressure = params.messages;
  const llmBoundaryTokenPressure = normalizeLlmBoundaryTokenPressure(
    params.llmBoundaryTokenPressure,
  );
  let estimatedPromptTokens =
    llmBoundaryTokenPressure?.estimatedPromptTokens ??
    estimateLlmBoundaryTokenPressure({
      messages: params.messages,
      systemPrompt: params.systemPrompt,
      prompt: params.prompt,
    });
  let pressureSource = llmBoundaryTokenPressure?.source ?? "transcript_estimate";
  if (params.unwindowedMessages && params.unwindowedMessages !== params.messages) {
    const unwindowedEstimatedPromptTokens = estimateLlmBoundaryTokenPressure({
      messages: params.unwindowedMessages,
      systemPrompt: params.systemPrompt,
      prompt: params.prompt,
    });
    if (unwindowedEstimatedPromptTokens > estimatedPromptTokens) {
      estimatedPromptTokens = unwindowedEstimatedPromptTokens;
      messagesForPressure = params.unwindowedMessages;
      pressureSource = "unwindowed_transcript_estimate";
    }
  }
  const contextTokenBudget = Math.max(1, Math.floor(params.contextTokenBudget));
  const promptImageCount = Math.max(0, Math.floor(params.promptImageCount ?? 0));
  const requestedReserveTokens = Math.max(0, Math.floor(params.reserveTokens));
  const sharedMinPromptBudget = Math.min(
    MIN_PROMPT_BUDGET_TOKENS,
    Math.max(1, Math.floor(contextTokenBudget * MIN_PROMPT_BUDGET_RATIO)),
  );
  const lightweightPromptBudgetEligible =
    params.contextMode === "lightweight" &&
    promptImageCount === 0 &&
    params.messages.length === 0 &&
    (!params.unwindowedMessages || params.unwindowedMessages.length === 0);
  const toolSchemaTokens = lightweightPromptBudgetEligible
    ? estimateToolSchemaTokenPressure(params.tools, params.toolBudgetModel)
    : 0;
  const lightweightMinPromptBudget = lightweightPromptBudgetEligible
    ? Math.max(
        sharedMinPromptBudget,
        Math.max(
          1,
          Math.floor(contextTokenBudget * LIGHTWEIGHT_MIN_PROMPT_BUDGET_RATIO) - toolSchemaTokens,
        ),
      )
    : sharedMinPromptBudget;
  const minPromptBudget = Math.min(
    lightweightMinPromptBudget,
    Math.max(1, contextTokenBudget - toolSchemaTokens),
  );
  // Keep a minimum prompt budget even when reserveTokens asks for most of the context window.
  const effectiveReserveTokens = Math.min(
    requestedReserveTokens,
    Math.max(0, contextTokenBudget - toolSchemaTokens - minPromptBudget),
  );
  const promptBudgetBeforeReserve = Math.max(
    1,
    contextTokenBudget - effectiveReserveTokens - toolSchemaTokens,
  );
  const overflowTokens = Math.max(0, estimatedPromptTokens - promptBudgetBeforeReserve);
  const toolResultPotential = estimateToolResultReductionPotential({
    messages: messagesForPressure,
    contextWindowTokens: params.contextTokenBudget,
    maxCharsOverride: params.toolResultMaxChars,
  });
  const overflowChars = overflowTokens * ESTIMATED_CHARS_PER_TOKEN;
  const truncationBufferChars = TRUNCATION_ROUTE_BUFFER_TOKENS * ESTIMATED_CHARS_PER_TOKEN;
  const truncateOnlyThresholdChars = Math.max(
    overflowChars + truncationBufferChars,
    Math.ceil(overflowChars * 1.5),
  );
  const toolResultReducibleChars = toolResultPotential.maxReducibleChars;

  let route: PreemptiveCompactionRoute = "fits";
  if (overflowTokens > 0) {
    // Choose truncate-only only when available reduction comfortably exceeds the overflow.
    if (toolResultReducibleChars <= 0) {
      route = "compact_only";
    } else if (toolResultReducibleChars >= truncateOnlyThresholdChars) {
      route = "truncate_tool_results_only";
    } else {
      route = "compact_then_truncate";
    }
  }
  return {
    route,
    shouldCompact: route === "compact_only" || route === "compact_then_truncate",
    estimatedPromptTokens,
    pressureSource,
    promptBudgetBeforeReserve,
    overflowTokens,
    toolResultReducibleChars,
    effectiveReserveTokens,
  };
}

/** Formats the compact operator log line for one pre-prompt budget check. */
export function formatPrePromptPrecheckLog(params: {
  result: PreemptiveCompactionDecision;
  sessionKey?: string;
  sessionId?: string;
  provider: string;
  modelId: string;
  messageCount: number;
  unwindowedMessageCount?: number;
  contextTokenBudget: number;
  reserveTokens: number;
  sessionFile?: string;
}): string {
  const { result } = params;
  return (
    `[context-overflow-precheck] pre-prompt check ` +
    `sessionKey=${params.sessionKey ?? params.sessionId ?? "unknown"} ` +
    `provider=${params.provider}/${params.modelId} ` +
    `route=${result.route} ` +
    `estimatedPromptTokens=${result.estimatedPromptTokens} ` +
    `pressureSource=${result.pressureSource ?? "unknown"} ` +
    `promptBudgetBeforeReserve=${result.promptBudgetBeforeReserve} ` +
    `overflowTokens=${result.overflowTokens} ` +
    `toolResultReducibleChars=${result.toolResultReducibleChars} ` +
    `reserveTokens=${params.reserveTokens} ` +
    `effectiveReserveTokens=${result.effectiveReserveTokens} ` +
    `contextTokenBudget=${params.contextTokenBudget} ` +
    `messages=${params.messageCount} ` +
    `unwindowedMessages=${params.unwindowedMessageCount ?? params.messageCount} ` +
    `sessionFile=${params.sessionFile}`
  );
}

/** Converts the pre-prompt decision into the persisted session context-budget status record. */
export function buildPrePromptContextBudgetStatus(params: {
  result: PreemptiveCompactionDecision;
  provider: string;
  modelId: string;
  messageCount: number;
  unwindowedMessageCount?: number;
  contextTokenBudget: number;
  reserveTokens: number;
  sessionId?: string;
  now?: number;
}): SessionContextBudgetStatus {
  const { result } = params;
  const remainingPromptBudgetTokens = Math.max(
    0,
    result.promptBudgetBeforeReserve - result.estimatedPromptTokens,
  );
  return {
    schemaVersion: 1,
    source: "pre-prompt-estimate",
    updatedAt: params.now ?? Date.now(),
    provider: params.provider,
    model: params.modelId,
    route: result.route,
    shouldCompact: result.shouldCompact,
    estimatedPromptTokens: result.estimatedPromptTokens,
    contextTokenBudget: Math.max(1, Math.floor(params.contextTokenBudget)),
    promptBudgetBeforeReserve: result.promptBudgetBeforeReserve,
    reserveTokens: Math.max(0, Math.floor(params.reserveTokens)),
    effectiveReserveTokens: result.effectiveReserveTokens,
    remainingPromptBudgetTokens,
    overflowTokens: result.overflowTokens,
    toolResultReducibleChars: result.toolResultReducibleChars,
    messageCount: Math.max(0, Math.floor(params.messageCount)),
    unwindowedMessageCount: Math.max(
      0,
      Math.floor(params.unwindowedMessageCount ?? params.messageCount),
    ),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
  };
}
