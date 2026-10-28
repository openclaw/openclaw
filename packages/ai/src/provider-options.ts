import type Anthropic from "@anthropic-ai/sdk";
import type { ProviderContext, ProviderModel, ProviderStreamOptions } from "./provider-types.js";
import type { OpenAIReasoningEffort } from "./providers/openai-reasoning-effort.js";
import type { OpenAICompletionsToolChoice } from "./providers/openai-tool-projection.js";
import type { StreamOptions } from "./types.js";

/** Identity of a provider compaction checkpoint the server rejected on replay. */
export type CompactionReplayRejection = {
  data: string;
  id?: string;
};

/** @deprecated Use CompactionReplayRejection. */
export type OpenAIResponsesCompactionRejection = CompactionReplayRejection;

export type CodeModeToolSurfaceObservation = {
  beforeToolIdentities: readonly string[];
  afterToolIdentities: readonly string[];
};

type RequestModelIdentity = Pick<ProviderModel, "provider" | "id" | "api"> & { baseUrl?: string };
const measuredRequestPressures = new WeakMap<
  ProviderContext,
  Pick<ProviderContext, "messages" | "tools" | "systemPrompt"> & {
    model: RequestModelIdentity;
    tokens: number;
  }
>();

/** Request-local pressure admitted by the host's matched provider-usage owner. */
export const measuredRequestPressure = {
  set(model: RequestModelIdentity, context: ProviderContext, tokens: number | undefined): void {
    if (tokens === undefined) {
      measuredRequestPressures.delete(context);
      return;
    }
    measuredRequestPressures.set(context, {
      model: { provider: model.provider, id: model.id, api: model.api, baseUrl: model.baseUrl },
      messages: context.messages,
      tools: context.tools,
      systemPrompt: context.systemPrompt,
      tokens,
    });
  },
  get(model: RequestModelIdentity, context: ProviderContext): number | undefined {
    const pressure = measuredRequestPressures.get(context);
    return pressure &&
      pressure.model.provider === model.provider &&
      pressure.model.id === model.id &&
      pressure.model.api === model.api &&
      pressure.model.baseUrl === model.baseUrl &&
      pressure.messages === context.messages &&
      pressure.tools === context.tools &&
      pressure.systemPrompt === context.systemPrompt
      ? pressure.tokens
      : undefined;
  },
};

const CODE_MODE_TOOL_SURFACE_OBSERVER = Symbol("openaiCodeModeToolSurfaceObserver");
const CODE_MODE_TOOL_SURFACE_COLLECTOR = Symbol("openaiCodeModeToolSurfaceCollector");
const STRICT_REASONING_TAG_TEXT = Symbol("openaiStrictReasoningTagText");
type CodeModeToolSurfaceObserver = (observation: CodeModeToolSurfaceObservation) => void;

function markStrictReasoningTagText(options: object): void {
  Reflect.set(options, STRICT_REASONING_TAG_TEXT, true);
}

function isStrictReasoningTagText(options: object | undefined): boolean {
  return options ? Reflect.get(options, STRICT_REASONING_TAG_TEXT) === true : false;
}

export const codeModeToolSurfaceObserver = {
  set(
    options: object,
    observer: CodeModeToolSurfaceObserver,
    collector?: CodeModeToolSurfaceObserver,
  ): void {
    Reflect.set(options, CODE_MODE_TOOL_SURFACE_OBSERVER, observer);
    if (collector) {
      Reflect.set(options, CODE_MODE_TOOL_SURFACE_COLLECTOR, collector);
    }
  },
  get(options: object | undefined): CodeModeToolSurfaceObserver | undefined {
    if (!options) {
      return undefined;
    }
    const observer: unknown = Reflect.get(options, CODE_MODE_TOOL_SURFACE_OBSERVER);
    return typeof observer === "function" ? (observation) => observer(observation) : undefined;
  },
  getCollector(options: object | undefined): CodeModeToolSurfaceObserver | undefined {
    if (!options) {
      return undefined;
    }
    const collector: unknown = Reflect.get(options, CODE_MODE_TOOL_SURFACE_COLLECTOR);
    return typeof collector === "function" ? (observation) => collector(observation) : undefined;
  },
};

/** Internal output policy for callers that must not recover ambiguous reasoning as visible text. */
export const reasoningTagTextPolicy = {
  markStrict: markStrictReasoningTagText,
  isStrict: isStrictReasoningTagText,
  copy(source: object | undefined, target: object): void {
    if (isStrictReasoningTagText(source)) {
      markStrictReasoningTagText(target);
    }
  },
};

const PREPARED_REQUEST_SUFFIX = Symbol("preparedRequestSuffix");

/** The caller supplies a captured wire prefix; transport repair must retain its late tool results. */
export const preparedRequestSuffix = {
  mark(context: object, toolCallIds: ReadonlySet<string>): void {
    Reflect.set(context, PREPARED_REQUEST_SUFFIX, toolCallIds);
  },
  has(context: object): boolean {
    return Reflect.has(context, PREPARED_REQUEST_SUFFIX);
  },
  hasToolCall(context: object, id: string): boolean {
    // SAFETY: Only mark() writes this private carrier, with captured prefix wire IDs.
    const ids = Reflect.get(context, PREPARED_REQUEST_SUFFIX) as ReadonlySet<string> | undefined;
    return ids?.has(id) ?? false;
  },
  toolCallId(context: object, id: string, normalized: string): string {
    // SAFETY: Only mark() writes this private carrier, with the captured prefix's wire IDs.
    const ids = Reflect.get(context, PREPARED_REQUEST_SUFFIX) as ReadonlySet<string> | undefined;
    return ids && !ids.has(id) && ids.has(normalized) ? normalized : id;
  },
};

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

export type AnthropicContextManagementOptions = {
  anthropicServerCompaction?: boolean;
  anthropicCompactThreshold?: number;
  cacheTtlPruning?: { tools?: { allow?: string[]; deny?: string[] } };
  /** Internal owner notification after Anthropic rejects a replayed compaction checkpoint. */
  onCompactionRejected?: (checkpoint: CompactionReplayRejection) => void;
};

/** Provider options shared by the Anthropic provider and canonical transport. */
export interface AnthropicOptions extends StreamOptions, AnthropicContextManagementOptions {
  /**
   * Enable extended thinking.
   * For Opus 4.6+ and Sonnet 4.6: uses adaptive thinking (model decides when/how much to think).
   * For older models: uses budget-based thinking with thinkingBudgetTokens.
   */
  thinkingEnabled?: boolean;
  /**
   * Token budget for extended thinking (older models only).
   * Ignored for Opus 4.6+ and Sonnet 4.6, which use adaptive thinking.
   */
  thinkingBudgetTokens?: number;
  /**
   * Effort level for adaptive thinking (Opus 4.6+ and Sonnet 4.6).
   * Controls how much thinking Claude allocates:
   * - "max": Always thinks with no constraints (Opus 4.6 only)
   * - "xhigh": Highest reasoning level (Opus 4.7+)
   * - "high": Always thinks, deep reasoning (default)
   * - "medium": Moderate thinking, may skip for simple queries
   * - "low": Minimal thinking, skips for simple tasks
   * Ignored for older models.
   */
  effort?: AnthropicEffort;
  /**
   * Controls how thinking content is returned in API responses.
   * - "summarized": Thinking blocks contain summarized thinking text (default here).
   * - "omitted": Thinking blocks return an empty thinking field; the encrypted
   *   signature still travels back for multi-turn continuity. Use for faster
   *   time-to-first-text-token when your UI does not surface thinking.
   *
   * Note: Anthropic's API default for Claude Opus 4.7+ and Claude Mythos Preview
   * is "omitted". We default to "summarized" here to keep behavior consistent
   * with older Claude 4 models. Set this explicitly to "omitted" to opt in.
   */
  thinkingDisplay?: AnthropicThinkingDisplay;
  interleavedThinking?: boolean;
  toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
  /**
   * Pre-built Anthropic client instance. When provided, skips internal client
   * construction entirely. Use this to inject alternative SDK clients such as
   * `AnthropicVertex` that shares the same messaging API.
   */
  client?: Anthropic;
}

/** Options shared by the OpenAI Responses and Completions transports. */
export type BaseOpenAIStreamOptions = ProviderStreamOptions & {
  topP?: number;
  authProfileId?: string;
  firstEventTimeoutMs?: number;
  onFirstEventTimeout?: (reason: Error) => void;
  /** Internal owner notification after a server rejects a persisted compaction checkpoint. */
  onCompactionRejected?: (checkpoint: CompactionReplayRejection) => void;
  openclawCodeModeToolSurface?: boolean;
  openclawCodeModeAllowedHostedToolTypes?: Set<string>;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
};

/** Superset retained under the provider's published compatibility type name. */
export type OpenAICompletionsOptions = BaseOpenAIStreamOptions & {
  streaming?: boolean;
  toolChoice?: OpenAICompletionsToolChoice;
  reasoning?: OpenAIReasoningEffort | "off";
  reasoningEffort?: OpenAIReasoningEffort | "off";
};
