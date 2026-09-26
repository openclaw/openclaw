import type Anthropic from "@anthropic-ai/sdk";
import type { OpenAIReasoningEffort } from "./providers/openai-reasoning-effort.js";
import type { OpenAICompletionsToolChoice } from "./providers/openai-tool-projection.js";
import type { StreamOptions } from "./types.js";

export type OpenAIResponsesCompactionRejection = {
  data: string;
  id?: string;
};

export type CodeModeToolSurfaceObservation = {
  beforeToolIdentities: readonly string[];
  afterToolIdentities: readonly string[];
};

const CODE_MODE_TOOL_SURFACE_OBSERVER = Symbol("openaiCodeModeToolSurfaceObserver");
const CODE_MODE_TOOL_SURFACE_COLLECTOR = Symbol("openaiCodeModeToolSurfaceCollector");
const STRICT_REASONING_TAG_TEXT = Symbol("openaiStrictReasoningTagText");
const STRICT_REASONING_TAG_TEXT_ON_FLUSH = Symbol("openaiStrictReasoningTagTextOnFlush");
type CodeModeToolSurfaceObserver = (observation: CodeModeToolSurfaceObservation) => void;

function markStrictReasoningTagText(options: object): void {
  Reflect.set(options, STRICT_REASONING_TAG_TEXT, true);
}

function isStrictReasoningTagText(options: object | undefined): boolean {
  return options ? Reflect.get(options, STRICT_REASONING_TAG_TEXT) === true : false;
}

function markStrictReasoningTagTextOnFlush(options: object): void {
  Reflect.set(options, STRICT_REASONING_TAG_TEXT_ON_FLUSH, true);
}

function isStrictReasoningTagTextOnFlush(options: object | undefined): boolean {
  return options ? Reflect.get(options, STRICT_REASONING_TAG_TEXT_ON_FLUSH) === true : false;
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

/**
 * Internal output policy for reasoning-tag text, with two explicit strictness levels:
 *
 * - `markStrict` (full strict): buffers text and classifies every reasoning tag only at the
 *   final flush, so ambiguous reasoning is never recovered as visible text. Meant for
 *   non-streaming internal consumers (TTS, titles/labels via host-prepared isolated
 *   completion, simple-completion-execution compaction) that must not leak reasoning.
 * - `markStrictOnFlush` (strict-on-flush): keeps incremental streaming intact and hides an
 *   unclosed reasoning block only at flush. Meant for interactive chat streams (e.g. the
 *   MiMo inline-thinking leak) where visible text must keep flowing token by token. If the
 *   same stream also emits native reasoning deltas, the transport escalates the shared
 *   partitioner to full strict at that boundary, so the incremental-streaming benefit
 *   applies to tag-only segments.
 */
export const reasoningTagTextPolicy = {
  markStrict: markStrictReasoningTagText,
  isStrict: isStrictReasoningTagText,
  markStrictOnFlush: markStrictReasoningTagTextOnFlush,
  isStrictOnFlush: isStrictReasoningTagTextOnFlush,
  copy(source: object | undefined, target: object): void {
    if (isStrictReasoningTagText(source)) {
      markStrictReasoningTagText(target);
    }
    if (isStrictReasoningTagTextOnFlush(source)) {
      markStrictReasoningTagTextOnFlush(target);
    }
  },
};

/** Resolve the transport-level strict reasoning-tag mode from request options. */
export function resolveStrictReasoningTagsMode(
  options: object | undefined | null,
): boolean | "on-flush" {
  if (isStrictReasoningTagText(options ?? undefined)) {
    return true;
  }
  if (isStrictReasoningTagTextOnFlush(options ?? undefined)) {
    return "on-flush";
  }
  return false;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

export type AnthropicContextManagementOptions = {
  anthropicServerCompaction?: boolean;
  anthropicCompactThreshold?: number;
  cacheTtlPruning?: { tools?: { allow?: string[]; deny?: string[] } };
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
export type BaseOpenAIStreamOptions = StreamOptions & {
  topP?: number;
  authProfileId?: string;
  firstEventTimeoutMs?: number;
  onFirstEventTimeout?: (reason: Error) => void;
  /** Internal owner notification after a server rejects a persisted compaction checkpoint. */
  onCompactionRejected?: (checkpoint: OpenAIResponsesCompactionRejection) => void;
  openclawCodeModeToolSurface?: boolean;
  openclawCodeModeAllowedHostedToolTypes?: Set<string>;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
};

/** Superset retained under the provider's published compatibility type name. */
export type OpenAICompletionsOptions = BaseOpenAIStreamOptions & {
  toolChoice?: OpenAICompletionsToolChoice;
  reasoning?: OpenAIReasoningEffort | "off";
  reasoningEffort?: OpenAIReasoningEffort | "off";
};
