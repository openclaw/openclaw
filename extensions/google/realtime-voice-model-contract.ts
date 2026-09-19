import { type ThinkingConfig, ThinkingLevel } from "@google/genai";
import { resolveGoogleGemini3ThinkingLevel } from "./thinking-api.js";

/** The thinking-related provider settings the Live model contracts read. */
export type GoogleLiveThinkingSettings = {
  thinkingLevel?: "minimal" | "low" | "medium" | "high";
  thinkingBudget?: number;
};

function normalizeGoogleLiveModelId(model: string): string {
  return model.startsWith("models/") ? model.slice("models/".length) : model;
}

// Gemini 3.1 Live replaces client-content text and async tools with realtime text
// and sequential function responses; explicit older models keep their prior contract.
export function isGemini31LiveModel(model: string): boolean {
  const modelId = normalizeGoogleLiveModelId(model);
  return modelId.startsWith("gemini-3.1-") && modelId.includes("-live");
}

// Gemini 3.8 Live (`gemini-3.8-live`) keeps the async tool contract but closes the
// session (1007) on any thinking config. Gemini 3.8 Live Extended Thinking
// (`gemini-3.8-live-extended-thinking`) requires NON_BLOCKING tools, closes the session
// (1007) on function response scheduling, drops a call after a `willContinue` interim
// instead of waiting for the final result, and takes `thinkingLevel` low|medium|high.
// Both verified against the live API on 2026-09-19.
function isGemini38LiveModel(model: string): boolean {
  return normalizeGoogleLiveModelId(model).startsWith("gemini-3.8-live");
}

function isGemini38LiveExtendedThinkingModel(model: string): boolean {
  const modelId = normalizeGoogleLiveModelId(model);
  return modelId.startsWith("gemini-3.8-live") && modelId.includes("extended-thinking");
}

export function supportsAsyncFunctionCalling(model: string): boolean {
  return !isGemini31LiveModel(model);
}

// Continuation means an interim `willContinue` response scheduled WHEN_IDLE before the
// final result. Extended Thinking rejects the scheduling and abandons the call after the
// interim, so it gets one final response per call like Gemini 3.1 Live.
export function modelSupportsToolResultContinuation(model: string): boolean {
  return supportsAsyncFunctionCalling(model) && !isGemini38LiveExtendedThinkingModel(model);
}

// Gemini Live has no response.cancel. Extended Thinking documents that a completed
// client-content turn interrupts active generation; the server then emits `interrupted`
// and `turnComplete`. Other Live models only interrupt through server-side VAD on input
// audio.
export function supportsClientContentInterrupt(model: string): boolean {
  return isGemini38LiveExtendedThinkingModel(model);
}

/**
 * A completed client turn interrupts the current Extended Thinking generation: the server
 * answers with `interrupted` (cleared audio) and `turnComplete` (response done). Silence
 * after that is best effort, not a guarantee: an empty turn makes the model resume its task
 * a few seconds later, and this bracketed instruction usually leaves it silent and idle
 * (measured live at thinking level high) but live runs still saw it speak again after the
 * cancelled completion. Callers must tolerate further output.
 */
export function buildGoogleLiveInterruptTurn(): {
  turns: Array<{ role: "user"; parts: Array<{ text: string }> }>;
  turnComplete: true;
} {
  return {
    turns: [
      {
        role: "user",
        parts: [{ text: "[You were interrupted. Stop speaking and wait silently.]" }],
      },
    ],
    turnComplete: true,
  };
}

function resolveGemini38LiveExtendedThinkingLevel(
  config: GoogleLiveThinkingSettings,
): ThinkingLevel | undefined {
  switch (config.thinkingLevel) {
    case "minimal": // MINIMAL is rejected by this model; LOW is the nearest supported level.
    case "low":
      return ThinkingLevel.LOW;
    case "medium":
      return ThinkingLevel.MEDIUM;
    case "high":
      return ThinkingLevel.HIGH;
    default:
      break;
  }
  if (typeof config.thinkingBudget !== "number" || config.thinkingBudget < 0) {
    return undefined;
  }
  if (config.thinkingBudget <= 2048) {
    return ThinkingLevel.LOW;
  }
  if (config.thinkingBudget <= 8192) {
    return ThinkingLevel.MEDIUM;
  }
  return ThinkingLevel.HIGH;
}

export function buildThinkingConfig(
  config: GoogleLiveThinkingSettings,
  model: string,
): ThinkingConfig | undefined {
  if (isGemini31LiveModel(model)) {
    const thinkingLevel = resolveGoogleGemini3ThinkingLevel({
      modelId: model,
      thinkingLevel: config.thinkingLevel,
      thinkingBudget: config.thinkingBudget,
    });
    return thinkingLevel ? { thinkingLevel: ThinkingLevel[thinkingLevel] } : undefined;
  }
  if (isGemini38LiveModel(model)) {
    if (!isGemini38LiveExtendedThinkingModel(model)) {
      return undefined;
    }
    const thinkingLevel = resolveGemini38LiveExtendedThinkingLevel(config);
    return thinkingLevel ? { thinkingLevel } : undefined;
  }
  if (typeof config.thinkingBudget === "number") {
    return { thinkingBudget: config.thinkingBudget };
  }
  return undefined;
}
