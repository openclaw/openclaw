import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveContextTokensForModel } from "./context.js";
import { DEFAULT_CONTEXT_TOKENS } from "./defaults.js";

function positiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

function sameRuntimeModel(params: {
  entry?: SessionEntry;
  provider?: string;
  model?: string;
}): boolean {
  if (!params.entry) {
    return false;
  }
  const entryModel = params.entry.model?.trim();
  const nextModel = params.model?.trim();
  if (entryModel && nextModel && entryModel !== nextModel) {
    return false;
  }
  const entryProvider = params.entry.modelProvider?.trim();
  const nextProvider = params.provider?.trim();
  if (entryProvider && nextProvider && entryProvider !== nextProvider) {
    return false;
  }
  return true;
}

export function resolvePreservedSessionContextTokens(params: {
  cfg?: OpenClawConfig;
  provider?: string;
  model?: string;
  runtimeContextTokens?: number;
  contextTokensOverride?: number;
  existingContextTokens?: number;
  existingEntry?: SessionEntry;
  fallbackContextTokens?: number;
  allowAsyncLoad?: boolean;
}): number {
  const candidates: number[] = [];
  const add = (value: number | undefined) => {
    const resolved = positiveInteger(value);
    if (resolved !== undefined) {
      candidates.push(resolved);
    }
  };

  add(params.runtimeContextTokens);
  add(params.contextTokensOverride);
  add(params.existingContextTokens);
  if (
    sameRuntimeModel({
      entry: params.existingEntry,
      provider: params.provider,
      model: params.model,
    })
  ) {
    add(params.existingEntry?.contextTokens);
  }
  add(params.cfg?.agents?.defaults?.contextTokens);
  add(
    resolveContextTokensForModel({
      cfg: params.cfg,
      provider: params.provider,
      model: params.model,
      fallbackContextTokens: params.fallbackContextTokens ?? DEFAULT_CONTEXT_TOKENS,
      allowAsyncLoad: params.allowAsyncLoad,
    }),
  );
  add(params.fallbackContextTokens);
  add(DEFAULT_CONTEXT_TOKENS);

  return Math.max(...candidates);
}
