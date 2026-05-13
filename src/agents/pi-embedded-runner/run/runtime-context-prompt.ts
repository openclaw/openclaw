import {
  OPENCLAW_NEXT_TURN_RUNTIME_CONTEXT_HEADER,
  OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
  OPENCLAW_RUNTIME_CONTEXT_NOTICE,
  OPENCLAW_RUNTIME_EVENT_HEADER,
} from "../../internal-runtime-context.js";
import type { CurrentTurnPromptContext } from "./params.js";
export { OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE };

const OPENCLAW_RUNTIME_EVENT_USER_PROMPT = "Continue the OpenClaw runtime event.";

type RuntimeContextSession = {
  sendCustomMessage: (
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: Record<string, unknown>;
    },
    options?: { deliverAs?: "nextTurn"; triggerTurn?: boolean },
  ) => Promise<void>;
};

type RuntimeContextPromptParts = {
  prompt: string;
  runtimeContext?: string;
  runtimeOnly?: boolean;
  runtimeSystemContext?: string;
};

export function buildCurrentTurnPromptContextPrefix(
  context: CurrentTurnPromptContext | undefined,
): string {
  return context?.text.trim() ?? "";
}

export function buildCurrentTurnPrompt(params: {
  context: CurrentTurnPromptContext | undefined;
  prompt: string;
}): string {
  const prefix = buildCurrentTurnPromptContextPrefix(params.context);
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

export function resolveRuntimeContextPromptParts(params: {
  effectivePrompt: string;
  transcriptPrompt?: string;
}): RuntimeContextPromptParts {
  const transcriptPrompt = params.transcriptPrompt;
  if (transcriptPrompt === undefined || transcriptPrompt === params.effectivePrompt) {
    return { prompt: params.effectivePrompt };
  }

  const prompt = transcriptPrompt.trim();
  const runtimeContext =
    removeLastPromptOccurrence(params.effectivePrompt, transcriptPrompt)?.trim() ||
    params.effectivePrompt.trim();
  if (!prompt) {
    return runtimeContext
      ? {
          prompt: OPENCLAW_RUNTIME_EVENT_USER_PROMPT,
          runtimeContext,
          runtimeOnly: true,
          runtimeSystemContext: buildRuntimeEventSystemContext(runtimeContext),
        }
      : { prompt: "" };
  }

  return runtimeContext ? { prompt, runtimeContext } : { prompt };
}

// Routes channel-supplied current-turn metadata (e.g. inbound Telegram `Conversation info` and
// `Sender` blocks) into the hidden runtime-context stream instead of the visible user prompt, so
// the user message text submitted to the provider stays equal to the user-authored body. The
// metadata still reaches the model as a hidden next-turn custom message via
// `queueRuntimeContextForNextTurn`. Mirrors the trust-boundary split introduced for legacy
// `<<<OPENCLAW_INTERNAL_CONTEXT>>>` prompts (see 11e6928b3edc).
export function resolveCurrentTurnPromptSubmission(params: {
  effectivePrompt: string;
  transcriptPrompt?: string;
  currentTurnContext: CurrentTurnPromptContext | undefined;
}): RuntimeContextPromptParts {
  const base = resolveRuntimeContextPromptParts({
    effectivePrompt: params.effectivePrompt,
    transcriptPrompt: params.transcriptPrompt,
  });
  const channelText = params.currentTurnContext?.text.trim() ?? "";
  if (!channelText || base.runtimeOnly) {
    // Skip the merge for runtime-event turns: their hidden context flows via the system prompt,
    // not via queueRuntimeContextForNextTurn, so a merge here would silently drop the channel
    // metadata. Leaving channel context untouched preserves the pre-fix behavior for that path.
    return base;
  }
  const combined = base.runtimeContext ? `${channelText}\n\n${base.runtimeContext}` : channelText;
  return { ...base, runtimeContext: combined };
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

export function buildRuntimeContextSystemContext(runtimeContext: string): string {
  return buildRuntimeContextMessageContent({ runtimeContext, kind: "next-turn" });
}

export function buildRuntimeEventSystemContext(runtimeContext: string): string {
  return buildRuntimeContextMessageContent({ runtimeContext, kind: "runtime-event" });
}

export async function queueRuntimeContextForNextTurn(params: {
  session: RuntimeContextSession;
  runtimeContext?: string;
}): Promise<void> {
  const runtimeContext = params.runtimeContext?.trim();
  if (!runtimeContext) {
    return;
  }
  await params.session.sendCustomMessage(
    {
      customType: OPENCLAW_RUNTIME_CONTEXT_CUSTOM_TYPE,
      content: runtimeContext,
      display: false,
      details: { source: "openclaw-runtime-context" },
    },
    { deliverAs: "nextTurn" },
  );
}
