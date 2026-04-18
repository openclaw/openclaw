import type { ProviderWrapStreamFnContext } from "openclaw/plugin-sdk/plugin-entry";
import { createPayloadPatchStreamWrapper } from "openclaw/plugin-sdk/provider-stream-shared";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export type GoogleThinkingLevel = "MINIMAL" | "LOW" | "MEDIUM" | "HIGH";
export type GoogleThinkingInputLevel =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "adaptive"
  | "high"
  | "xhigh";

export function isGoogleThinkingRequiredModel(modelId: string): boolean {
  return normalizeLowercaseStringOrEmpty(modelId).includes("gemini-2.5-pro");
}

export function isGoogleGemini3ProModel(modelId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return /(?:^|\/)gemini-(?:3(?:\.\d+)?-pro|pro-latest)(?:-|$)/.test(normalized);
}

export function isGoogleGemini3FlashModel(modelId: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(modelId);
  return /(?:^|\/)gemini-(?:3(?:\.\d+)?-flash|flash(?:-lite)?-latest)(?:-|$)/.test(normalized);
}

export function isGoogleGemini3ThinkingLevelModel(modelId: string): boolean {
  return isGoogleGemini3ProModel(modelId) || isGoogleGemini3FlashModel(modelId);
}

export function resolveGoogleGemini3ThinkingLevel(params: {
  modelId?: string;
  thinkingLevel?: GoogleThinkingInputLevel;
  thinkingBudget?: number;
}): GoogleThinkingLevel | undefined {
  if (typeof params.modelId !== "string") {
    return undefined;
  }
  if (isGoogleGemini3ProModel(params.modelId)) {
    switch (params.thinkingLevel) {
      case "off":
      case "minimal":
      case "low":
        return "LOW";
      case "medium":
      case "adaptive":
      case "high":
      case "xhigh":
        return "HIGH";
    }
    if (typeof params.thinkingBudget === "number") {
      return params.thinkingBudget <= 2048 ? "LOW" : "HIGH";
    }
    return undefined;
  }
  if (!isGoogleGemini3FlashModel(params.modelId)) {
    return undefined;
  }
  switch (params.thinkingLevel) {
    case "off":
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
  }
  if (typeof params.thinkingBudget !== "number") {
    return undefined;
  }
  if (params.thinkingBudget <= 0) {
    return "MINIMAL";
  }
  if (params.thinkingBudget <= 2048) {
    return "LOW";
  }
  if (params.thinkingBudget <= 8192) {
    return "MEDIUM";
  }
  return "HIGH";
}

export function stripInvalidGoogleThinkingBudget(params: {
  thinkingConfig: Record<string, unknown>;
  modelId?: string;
}): boolean {
  if (
    params.thinkingConfig.thinkingBudget !== 0 ||
    typeof params.modelId !== "string" ||
    !isGoogleThinkingRequiredModel(params.modelId)
  ) {
    return false;
  }
  delete params.thinkingConfig.thinkingBudget;
  return true;
}

function isGemma4Model(modelId: string): boolean {
  return normalizeLowercaseStringOrEmpty(modelId).startsWith("gemma-4");
}

function mapThinkLevelToGemma4ThinkingLevel(
  thinkingLevel?: GoogleThinkingInputLevel,
): "MINIMAL" | "HIGH" | undefined {
  switch (thinkingLevel) {
    case "off":
      return undefined;
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

export function sanitizeGoogleThinkingPayload(params: {
  payload: unknown;
  modelId?: string;
  thinkingLevel?: GoogleThinkingInputLevel;
}): void {
  if (!params.payload || typeof params.payload !== "object") {
    return;
  }
  const payloadObj = params.payload as Record<string, unknown>;
  sanitizeGoogleThinkingConfigContainer({
    container: payloadObj.config,
    modelId: params.modelId,
    thinkingLevel: params.thinkingLevel,
  });
  sanitizeGoogleThinkingConfigContainer({
    container: payloadObj.generationConfig,
    modelId: params.modelId,
    thinkingLevel: params.thinkingLevel,
  });
}

function sanitizeGoogleThinkingConfigContainer(params: {
  container: unknown;
  modelId?: string;
  thinkingLevel?: GoogleThinkingInputLevel;
}): void {
  if (!params.container || typeof params.container !== "object") {
    return;
  }
  const configObj = params.container as Record<string, unknown>;
  const thinkingConfig = configObj.thinkingConfig;
  if (!thinkingConfig || typeof thinkingConfig !== "object") {
    return;
  }
  const thinkingConfigObj = thinkingConfig as Record<string, unknown>;

  if (typeof params.modelId === "string" && isGemma4Model(params.modelId)) {
    const normalizedThinkingLevel = normalizeGemma4ThinkingLevel(thinkingConfigObj.thinkingLevel);
    const explicitMappedLevel = mapThinkLevelToGemma4ThinkingLevel(params.thinkingLevel);
    const disabledViaBudget =
      typeof thinkingConfigObj.thinkingBudget === "number" && thinkingConfigObj.thinkingBudget <= 0;
    const hadThinkingBudget = thinkingConfigObj.thinkingBudget !== undefined;
    delete thinkingConfigObj.thinkingBudget;

    if (
      params.thinkingLevel === "off" ||
      (disabledViaBudget && explicitMappedLevel === undefined && !normalizedThinkingLevel)
    ) {
      delete thinkingConfigObj.thinkingLevel;
      if (Object.keys(thinkingConfigObj).length === 0) {
        delete configObj.thinkingConfig;
      }
      return;
    }

    const mappedLevel =
      explicitMappedLevel ?? normalizedThinkingLevel ?? (hadThinkingBudget ? "MINIMAL" : undefined);

    if (mappedLevel) {
      thinkingConfigObj.thinkingLevel = mappedLevel;
    }
    return;
  }

  const thinkingBudget = thinkingConfigObj.thinkingBudget;

  if (typeof params.modelId === "string" && isGoogleGemini3ThinkingLevelModel(params.modelId)) {
    const mappedLevel = resolveGoogleGemini3ThinkingLevel({
      modelId: params.modelId,
      thinkingLevel: params.thinkingLevel,
      thinkingBudget: typeof thinkingBudget === "number" ? thinkingBudget : undefined,
    });
    delete thinkingConfigObj.thinkingBudget;
    if (mappedLevel) {
      thinkingConfigObj.thinkingLevel = mappedLevel;
    }
    if (Object.keys(thinkingConfigObj).length === 0) {
      delete configObj.thinkingConfig;
    }
    return;
  }

  if (
    stripInvalidGoogleThinkingBudget({ thinkingConfig: thinkingConfigObj, modelId: params.modelId })
  ) {
    if (Object.keys(thinkingConfigObj).length === 0) {
      delete configObj.thinkingConfig;
    }
    return;
  }

  if (typeof thinkingBudget !== "number" || thinkingBudget >= 0) {
    return;
  }

  delete thinkingConfigObj.thinkingBudget;
  if (Object.keys(thinkingConfigObj).length === 0) {
    delete configObj.thinkingConfig;
  }
}

export function createGoogleThinkingPayloadWrapper(
  baseStreamFn: ProviderWrapStreamFnContext["streamFn"],
  thinkingLevel?: GoogleThinkingInputLevel,
): NonNullable<ProviderWrapStreamFnContext["streamFn"]> {
  return createPayloadPatchStreamWrapper(baseStreamFn, ({ payload, model }) => {
    if (model.api === "google-generative-ai") {
      sanitizeGoogleThinkingPayload({
        payload,
        modelId: model.id,
        thinkingLevel,
      });
    }
  });
}

export function createGoogleThinkingStreamWrapper(
  ctx: ProviderWrapStreamFnContext,
): NonNullable<ProviderWrapStreamFnContext["streamFn"]> {
  return createGoogleThinkingPayloadWrapper(ctx.streamFn, ctx.thinkingLevel);
}
