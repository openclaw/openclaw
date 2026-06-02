import {
  extractInternalRuntimeContext,
  OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
  OPENCLAW_RUNTIME_EVENT_HEADER,
} from "../../internal-runtime-context.js";
import type { CurrentInboundPromptContext } from "./params.js";
export { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE };

const OPENCLAW_RUNTIME_EVENT_USER_PROMPT = "Continue the OpenClaw runtime event.";

type RuntimeContextPromptParts = {
  prompt: string;
  modelPrompt?: string;
  runtimeContext?: string;
  runtimeOnly?: boolean;
  runtimeSystemContext?: string;
};

/** Hidden custom transcript row used to carry runtime context between turns. */
export type RuntimeContextCustomMessage = {
  role: "custom";
  customType: string;
  content: string;
  display: false;
  details: { source: "openclaw-runtime-context" };
  timestamp: number;
};

type EmptyTranscriptMode = "model-prompt" | "runtime-event";

/**
 * Returns current-turn context text, optionally choosing resumable text for
 * backends that need a replay-safe prompt after interruption.
 */
export function buildCurrentInboundPromptContextPrefix(
  context: CurrentInboundPromptContext | undefined,
  options?: { preferResumableText?: boolean },
): string {
  const text =
    options?.preferResumableText === true
      ? (context?.resumableText ?? context?.text)
      : context?.text;
  return text?.trim() ?? "";
}

/** Prepends current inbound context to the user prompt with the context-owned joiner. */
export function buildCurrentInboundPrompt(params: {
  context: CurrentInboundPromptContext | undefined;
  prompt: string;
  preferResumableText?: boolean;
}): string {
  const prefix = buildCurrentInboundPromptContextPrefix(params.context, {
    preferResumableText: params.preferResumableText,
  });
  if (!prefix) {
    return params.prompt;
  }
  if (!params.prompt) {
    return prefix;
  }
  return [prefix, params.prompt].join(params.context?.promptJoiner ?? "\n\n");
}

function removeLastPromptOccurrence(text: string, prompt: string): string | null {
  const index = text.lastIndexOf(prompt);
  if (index === -1) {
    return null;
  }
  const before = text.slice(0, index).trimEnd();
  const after = text.slice(index + prompt.length).trimStart();
  return [before, after]
    .filter((part) => part.length > 0)
    .join("\n\n")
    .trim();
}

/**
 * Separates model-visible prompt text from hidden runtime context carried in
 * transcript-aware prompts. Runtime-only events get a synthetic user prompt so
 * provider calls remain valid while the real details stay in system context.
 */
export function resolveRuntimeContextPromptParts(params: {
  effectivePrompt: string;
  transcriptPrompt?: string;
  modelPrompt?: string;
  emptyTranscriptMode?: EmptyTranscriptMode;
}): RuntimeContextPromptParts {
  const transcriptPrompt = params.transcriptPrompt;
  const shouldExtractInternalRuntimeContext = transcriptPrompt !== undefined;
  // Only transcript-aware calls extract hidden runtime context. Raw provider
  // probes and no-transcript prompts preserve delimiter text literally.
  const extracted = shouldExtractInternalRuntimeContext
    ? extractInternalRuntimeContext(params.effectivePrompt)
    : { text: params.effectivePrompt };
  const modelPrompt =
    params.modelPrompt === undefined
      ? undefined
      : shouldExtractInternalRuntimeContext
        ? extractInternalRuntimeContext(params.modelPrompt)
        : { text: params.modelPrompt };
  const modelPromptText = modelPrompt?.text ?? transcriptPrompt ?? extracted.text;
  const prompt = transcriptPrompt ?? extracted.text;
  if (!prompt.trim() && params.emptyTranscriptMode === "model-prompt") {
    return {
      prompt: extracted.text,
      ...(modelPromptText.trim() && modelPromptText !== extracted.text
        ? { modelPrompt: modelPromptText }
        : {}),
      ...(extracted.runtimeContext ? { runtimeContext: extracted.runtimeContext } : {}),
    };
  }
  const hiddenRuntimeContext = modelPrompt
    ? (removeLastPromptOccurrence(extracted.text, modelPrompt.text)?.trim() ??
      (transcriptPrompt
        ? removeLastPromptOccurrence(extracted.text, transcriptPrompt)?.trim()
        : undefined))
    : transcriptPrompt
      ? removeLastPromptOccurrence(extracted.text, transcriptPrompt)?.trim()
      : undefined;
  // Runtime context can come from explicit internal blocks or from prompt text
  // hidden from the transcript. Keep it separate from model-only retry text.
  const runtimeContext =
    [hiddenRuntimeContext, extracted.runtimeContext]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n\n") || (!prompt.trim() ? extracted.text.trim() : undefined);
  if (!prompt.trim()) {
    return runtimeContext
      ? {
          prompt: OPENCLAW_RUNTIME_EVENT_USER_PROMPT,
          ...(modelPromptText.trim() && modelPromptText !== OPENCLAW_RUNTIME_EVENT_USER_PROMPT
            ? { modelPrompt: modelPromptText }
            : {}),
          runtimeContext,
          runtimeOnly: true,
          runtimeSystemContext: buildRuntimeEventSystemContext(runtimeContext),
        }
      : {
          prompt: "",
          ...(modelPromptText ? { modelPrompt: modelPromptText } : {}),
        };
  }

  return {
    prompt,
    ...(modelPromptText.trim() && modelPromptText !== prompt
      ? { modelPrompt: modelPromptText }
      : {}),
    ...(runtimeContext ? { runtimeContext } : {}),
  };
}

function buildRuntimeContextMessageContent(params: {
  runtimeContext: string;
  kind: "next-turn" | "runtime-event";
}): string {
  return [
    params.kind === "runtime-event"
      ? OPENCLAW_RUNTIME_EVENT_HEADER
      : OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
    OPENCLAW_RUNTIME_CONTEXT_NOTICE,
    "",
    params.runtimeContext,
  ].join("\n");
}

/** Builds prompt-local system context for runtime details tied to the next turn. */
export function buildRuntimeContextSystemContext(runtimeContext: string): string {
  return buildRuntimeContextMessageContent({ runtimeContext, kind: "next-turn" });
}

/** Builds prompt-local system context for runtime-generated event turns. */
export function buildRuntimeEventSystemContext(runtimeContext: string): string {
  return buildRuntimeContextMessageContent({ runtimeContext, kind: "runtime-event" });
}

/** Converts hidden runtime context into a non-displayed custom transcript row. */
export function buildRuntimeContextCustomMessage(
  runtimeContext: string | undefined,
): RuntimeContextCustomMessage | undefined {
  const trimmedRuntimeContext = runtimeContext?.trim();
  if (!trimmedRuntimeContext) {
    return undefined;
  }
  return {
    role: "custom",
    customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
    content: buildRuntimeContextSystemContext(trimmedRuntimeContext),
    display: false,
    details: { source: "openclaw-runtime-context" },
    timestamp: Date.now(),
  };
}
