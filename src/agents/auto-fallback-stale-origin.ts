// Shared stale-origin detection for auto-fallback model pins.
import { hasSessionAutoModelFallbackProvenance } from "../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import {
  modelKey,
  normalizeModelRef,
  resolvePersistedOverrideModelRef,
} from "./model-selection.js";

type AutoFallbackOriginEntry = Pick<
  SessionEntry,
  | "providerOverride"
  | "modelOverride"
  | "modelOverrideSource"
  | "modelOverrideFallbackOriginProvider"
  | "modelOverrideFallbackOriginModel"
>;

function resolveOverrideKey(params: {
  defaultProvider: string;
  overrideProvider?: string;
  overrideModel?: string;
}): string | null {
  const ref = resolvePersistedOverrideModelRef(params);
  if (!ref) {
    return null;
  }
  const normalized = normalizeModelRef(ref.provider, ref.model);
  return modelKey(normalized.provider, normalized.model);
}

/** Detects auto-fallback pins whose recorded origin no longer matches the current primary. */
export function isStaleAutoFallbackOriginOverride(params: {
  entry: AutoFallbackOriginEntry | null | undefined;
  defaultProvider: string;
  defaultModel: string;
  primaryProvider?: string;
  primaryModel?: string;
}): boolean {
  const entry = params.entry;
  if (!entry) {
    return false;
  }
  const recoveredAutoFallbackOverride =
    entry.modelOverrideSource === undefined && hasSessionAutoModelFallbackProvenance(entry);
  if (entry.modelOverrideSource !== "auto" && !recoveredAutoFallbackOverride) {
    return false;
  }

  const storedOverrideKey = resolveOverrideKey({
    defaultProvider: params.defaultProvider,
    overrideProvider: entry.providerOverride,
    overrideModel: entry.modelOverride,
  });
  const originKey = resolveOverrideKey({
    defaultProvider: params.defaultProvider,
    overrideProvider: entry.modelOverrideFallbackOriginProvider,
    overrideModel: entry.modelOverrideFallbackOriginModel,
  });
  const primaryKey = resolveOverrideKey({
    defaultProvider: params.defaultProvider,
    overrideProvider: params.primaryProvider ?? params.defaultProvider,
    overrideModel: params.primaryModel ?? params.defaultModel,
  });
  if (!storedOverrideKey || !originKey || !primaryKey) {
    return false;
  }
  return originKey !== primaryKey && storedOverrideKey !== primaryKey;
}
