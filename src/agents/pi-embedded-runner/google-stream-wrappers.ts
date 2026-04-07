import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type { ThinkLevel } from "../../auto-reply/thinking.js";
import { streamWithPayloadPatch } from "./stream-payload-utils.js";

function isGemini31Model(modelId: string): boolean {
  const normalized = modelId.toLowerCase();
  return normalized.includes("gemini-3.1-pro") || normalized.includes("gemini-3.1-flash");
}

function isGemma4Model(modelId: string): boolean {
  let normalized = modelId.trim().toLowerCase();
  // Google-style fully-qualified IDs may carry a "models/" or "tunedModels/"
  // prefix; the Gemma 4 normalization must apply to those too.
  if (normalized.startsWith("models/")) {
    normalized = normalized.slice("models/".length);
  } else if (normalized.startsWith("tunedmodels/")) {
    normalized = normalized.slice("tunedmodels/".length);
  }
  return normalized.startsWith("gemma-4");
}

function mapThinkLevelToGoogleThinkingLevel(
  thinkingLevel: ThinkLevel,
): "MINIMAL" | "LOW" | "MEDIUM" | "HIGH" | undefined {
  switch (thinkingLevel) {
    case "minimal":
      return "MINIMAL";
    case "low":
      return "LOW";
    case "medium":
    case "adaptive":
      return "MEDIUM";
    case "high":
    case "xhigh":
      return "HIGH";
    default:
      return undefined;
  }
}

function mapThinkLevelToGemma4ThinkingLevel(
  thinkingLevel?: ThinkLevel,
): "MINIMAL" | "HIGH" | undefined {
  switch (thinkingLevel) {
    case "off":
    case "minimal":
    case "low":
      return "MINIMAL";
    case "medium":
    case "adaptive":
    case "high":
    case "xhigh":
      return "HIGH";
    default:
      return undefined;
  }
}

function normalizeGemma4ThinkingLevel(value: unknown): "MINIMAL" | "HIGH" | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  switch (value.trim().toUpperCase()) {
    case "MINIMAL":
    case "LOW":
      return "MINIMAL";
    case "MEDIUM":
    case "HIGH":
      return "HIGH";
    default:
      return undefined;
  }
}

function sanitizeThinkingConfigObject(
  thinkingConfigObj: Record<string, unknown>,
  modelId: string | undefined,
  thinkingLevel: ThinkLevel | undefined,
): void {
  if (typeof modelId === "string" && isGemma4Model(modelId)) {
    const hadThinkingBudget = thinkingConfigObj.thinkingBudget !== undefined;
    delete thinkingConfigObj.thinkingBudget;

    const mappedLevel =
      mapThinkLevelToGemma4ThinkingLevel(thinkingLevel) ??
      normalizeGemma4ThinkingLevel(thinkingConfigObj.thinkingLevel) ??
      (hadThinkingBudget ? "MINIMAL" : undefined);

    if (mappedLevel) {
      thinkingConfigObj.thinkingLevel = mappedLevel;
    }
    return;
  }

  const thinkingBudget = thinkingConfigObj.thinkingBudget;
  if (typeof thinkingBudget !== "number" || thinkingBudget >= 0) {
    return;
  }

  // pi-ai can emit thinkingBudget=-1 for some Gemini 3.1 IDs; a negative budget
  // is invalid for Google-compatible backends and can lead to malformed handling.
  delete thinkingConfigObj.thinkingBudget;

  if (
    typeof modelId === "string" &&
    isGemini31Model(modelId) &&
    thinkingLevel &&
    thinkingLevel !== "off" &&
    thinkingConfigObj.thinkingLevel === undefined
  ) {
    const mappedLevel = mapThinkLevelToGoogleThinkingLevel(thinkingLevel);
    if (mappedLevel) {
      thinkingConfigObj.thinkingLevel = mappedLevel;
    }
  }
}

export function sanitizeGoogleThinkingPayload(params: {
  payload: unknown;
  modelId?: string;
  thinkingLevel?: ThinkLevel;
}): void {
  if (!params.payload || typeof params.payload !== "object") {
    return;
  }
  const payloadObj = params.payload as Record<string, unknown>;

  // pi-ai's streamSimple wraps thinking under `config.thinkingConfig`, while
  // the boundary-aware transport (createGoogleGenerativeAiTransportStreamFn)
  // emits it under `generationConfig.thinkingConfig`. Sanitize whichever is
  // present so the same Gemma 4 / Gemini 3.1 fix-ups apply on both paths.
  for (const parentKey of ["config", "generationConfig"] as const) {
    const parent = payloadObj[parentKey];
    if (!parent || typeof parent !== "object") {
      continue;
    }
    const parentObj = parent as Record<string, unknown>;
    const thinkingConfig = parentObj.thinkingConfig;
    if (!thinkingConfig || typeof thinkingConfig !== "object") {
      continue;
    }
    sanitizeThinkingConfigObject(
      thinkingConfig as Record<string, unknown>,
      params.modelId,
      params.thinkingLevel,
    );
  }
}

export function createGoogleThinkingPayloadWrapper(
  baseStreamFn: StreamFn | undefined,
  thinkingLevel?: ThinkLevel,
): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    return streamWithPayloadPatch(underlying, model, context, options, (payload) => {
      if (model.api === "google-generative-ai") {
        sanitizeGoogleThinkingPayload({
          payload,
          modelId: model.id,
          thinkingLevel,
        });
      }
    });
  };
}
