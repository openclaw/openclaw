/**
 * Builds runtime context prompt fragments and custom session messages.
 */
import {
  extractInternalRuntimeContext,
  INTERNAL_RUNTIME_CONTEXT_BEGIN,
  INTERNAL_RUNTIME_CONTEXT_END,
  OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
  OPENCLAW_RUNTIME_EVENT_HEADER,
} from "../../internal-runtime-context.js";
import type { CurrentInboundPromptContext } from "./params.js";

const OPENCLAW_RUNTIME_EVENT_USER_PROMPT = "Continue the OpenClaw runtime event.";

type RuntimeContextPromptParts = {
  prompt: string;
  modelPrompt?: string;
  runtimeContext?: string;
  runtimeOnly?: boolean;
  runtimeSystemContext?: string;
};

/** Hidden custom transcript message that carries runtime context into model conversion. */
export type RuntimeContextCustomMessage = {
  role: "custom";
  customType: string;
  content: string;
  display: false;
  details: { source: "openclaw-runtime-context" };
  timestamp: number;
};

type EmptyTranscriptMode = "model-prompt" | "runtime-event";

/** Combines inbound context and the current prompt using the channel-provided joiner. */
export function buildCurrentInboundPrompt(params: {
  context: CurrentInboundPromptContext | undefined;
  prompt: string;
  preferResumableText?: boolean;
}): string {
  const contextText =
    params.preferResumableText === true
      ? (params.context?.resumableText ?? params.context?.text)
      : params.context?.text;
  const prefix = contextText?.trim() ?? "";
  if (!prefix) {
    return params.prompt;
  }
  if (!params.prompt) {
    return prefix;
  }
  return [prefix, params.prompt].join(params.context?.promptJoiner ?? "\n\n");
}

function splitLastPromptOccurrence(
  text: string,
  prompt: string,
): { before: string; after: string } | null {
  const index = text.lastIndexOf(prompt);
  if (index === -1) {
    return null;
  }
  return {
    before: text.slice(0, index),
    after: text.slice(index + prompt.length),
  };
}

function removePromptContextAroundOccurrence(params: {
  text: string;
  prompt: string;
  hiddenBefore: string;
  hiddenAfter: string;
}): string | null {
  const hiddenBefore = params.hiddenBefore.trim();
  const hiddenAfter = params.hiddenAfter.trim();
  let stripped: string | null = null;
  let searchFrom = 0;
  while (searchFrom <= params.text.length) {
    const index = params.text.indexOf(params.prompt, searchFrom);
    if (index === -1) {
      return stripped;
    }
    const before = params.text.slice(0, index).trimEnd();
    const after = params.text.slice(index + params.prompt.length).trimStart();
    if (
      (!hiddenBefore || before.endsWith(hiddenBefore)) &&
      (!hiddenAfter || after.startsWith(hiddenAfter))
    ) {
      const keptBefore = hiddenBefore
        ? before.slice(0, before.length - hiddenBefore.length).trimEnd()
        : before;
      const keptAfter = hiddenAfter ? after.slice(hiddenAfter.length).trimStart() : after;
      stripped = [keptBefore, params.prompt, keptAfter]
        .filter((part) => part.length > 0)
        .join("\n\n")
        .trim();
    }
    searchFrom = index + Math.max(1, params.prompt.length);
  }
}

/**
 * Separates user-authored prompt text from hidden runtime context. Transcript
 * prompt stays user-visible; model prompt may carry runtime-only additions that
 * should be delivered as hidden context instead of persisted as user text.
 */
export function resolveRuntimeContextPromptParts(params: {
  effectivePrompt: string;
  transcriptPrompt?: string;
  modelPrompt?: string;
  emptyTranscriptMode?: EmptyTranscriptMode;
}): RuntimeContextPromptParts {
  const transcriptPrompt = params.transcriptPrompt;
  const shouldExtractInternalRuntimeContext = transcriptPrompt !== undefined;
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
  const hiddenPromptParts = modelPrompt
    ? (splitLastPromptOccurrence(extracted.text, modelPrompt.text) ??
      (transcriptPrompt ? splitLastPromptOccurrence(extracted.text, transcriptPrompt) : undefined))
    : transcriptPrompt
      ? splitLastPromptOccurrence(extracted.text, transcriptPrompt)
      : undefined;
  const hiddenRuntimeContext = hiddenPromptParts
    ? [hiddenPromptParts.before, hiddenPromptParts.after]
        .map((part) => part.trim())
        .filter((part) => part.length > 0)
        .join("\n\n")
    : undefined;
  // The hidden context is whatever remains after removing the last visible
  // prompt occurrence, plus any explicit internal runtime-context block.
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
          runtimeSystemContext: buildRuntimeContextMessageContent({
            runtimeContext,
            kind: "runtime-event",
          }),
        }
      : {
          prompt: "",
          ...(modelPromptText ? { modelPrompt: modelPromptText } : {}),
        };
  }

  // When hooks added pre-prompt context, modelPromptText still contains the
  // system-event prefix that was separated into runtimeContext. Strip it so
  // events aren't delivered to the model twice (Message A and Message B).
  const hasHiddenPromptContext = Boolean(
    hiddenPromptParts?.before.trim() || hiddenPromptParts?.after.trim(),
  );
  const returnModelPromptText =
    hasHiddenPromptContext && hiddenPromptParts && modelPrompt
      ? (removePromptContextAroundOccurrence({
          text: modelPromptText,
          prompt: transcriptPrompt ?? extracted.text,
          hiddenBefore: hiddenPromptParts.before,
          hiddenAfter: hiddenPromptParts.after,
        }) ?? modelPromptText)
      : modelPromptText;

  return {
    prompt,
    ...(returnModelPromptText.trim() && returnModelPromptText !== prompt
      ? { modelPrompt: returnModelPromptText }
      : {}),
    ...(runtimeContext ? { runtimeContext } : {}),
  };
}

function buildRuntimeContextMessageContent(params: {
  runtimeContext: string;
  kind: "next-turn" | "runtime-event";
}): string {
  // Wrap the runtime context body in delimited internal-context markers so
  // stripInternalRuntimeContext can fully remove the block when it leaks
  // into user-visible surfaces (e.g. Feishu streaming cards, #92589).
  return [
    params.kind === "runtime-event"
      ? OPENCLAW_RUNTIME_EVENT_HEADER
      : OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
    OPENCLAW_RUNTIME_CONTEXT_NOTICE,
    "",
    INTERNAL_RUNTIME_CONTEXT_BEGIN,
    params.runtimeContext,
    INTERNAL_RUNTIME_CONTEXT_END,
  ].join("\n");
}

/** Creates a non-displayed custom transcript message for runtime context, if any exists. */
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
    content: buildRuntimeContextMessageContent({
      runtimeContext: trimmedRuntimeContext,
      kind: "next-turn",
    }),
    display: false,
    details: { source: "openclaw-runtime-context" },
    timestamp: Date.now(),
  };
}
