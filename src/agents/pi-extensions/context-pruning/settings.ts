import { parseDurationMs } from "../../../cli/parse-duration.js";

export type ContextPruningToolMatch = {
  allow?: string[];
  deny?: string[];
};
export type ContextPruningMode = "off" | "cache-ttl" | "always";

export type ContextPruningConfig = {
  mode?: ContextPruningMode;
  /** TTL to consider cache expired (duration string, default unit: minutes). */
  ttl?: string;
  keepLastAssistants?: number;
  softTrimRatio?: number;
  hardClearRatio?: number;
  minPrunableToolChars?: number;
  tools?: ContextPruningToolMatch;
  softTrim?: {
    maxChars?: number;
    headChars?: number;
    tailChars?: number;
  };
  hardClear?: {
    enabled?: boolean;
    placeholder?: string;
  };
};

export type EffectiveContextPruningSettings = {
  mode: Exclude<ContextPruningMode, "off">;
  ttlMs: number;
  keepLastAssistants: number;
  softTrimRatio: number;
  hardClearRatio: number;
  minPrunableToolChars: number;
  tools: ContextPruningToolMatch;
  softTrim: {
    maxChars: number;
    headChars: number;
    tailChars: number;
  };
  hardClear: {
    enabled: boolean;
    placeholder: string;
  };
};

export const DEFAULT_CONTEXT_PRUNING_SETTINGS: EffectiveContextPruningSettings = {
  mode: "always",
  ttlMs: 5 * 60 * 1000,
  keepLastAssistants: 3,
  softTrimRatio: 0.8,
  hardClearRatio: 0.92,
  minPrunableToolChars: 30_000,
  tools: {},
  softTrim: {
    maxChars: 6_000,
    headChars: 2_500,
    tailChars: 2_500,
  },
  hardClear: {
    enabled: true,
    placeholder: "[Old tool result content cleared]",
  },
};

export function computeEffectiveSettings(raw: unknown): EffectiveContextPruningSettings | null {
  if (!raw || typeof raw !== "object") {
    // Missing config => default ON (always) for token efficiency.
    return structuredClone(DEFAULT_CONTEXT_PRUNING_SETTINGS);
  }
  const cfg = raw as ContextPruningConfig;
  const mode = cfg.mode ?? "always";
  if (mode === "off") {
    return null;
  }

  const s: EffectiveContextPruningSettings = structuredClone(DEFAULT_CONTEXT_PRUNING_SETTINGS);
  s.mode = mode;

  if (typeof cfg.ttl === "string") {
    try {
      s.ttlMs = parseDurationMs(cfg.ttl, { defaultUnit: "m" });
    } catch {
      // keep default ttl
    }
  }

  if (typeof cfg.keepLastAssistants === "number" && Number.isFinite(cfg.keepLastAssistants)) {
    s.keepLastAssistants = Math.max(0, Math.floor(cfg.keepLastAssistants));
  }
  if (typeof cfg.softTrimRatio === "number" && Number.isFinite(cfg.softTrimRatio)) {
    s.softTrimRatio = Math.min(1, Math.max(0, cfg.softTrimRatio));
  }
  if (typeof cfg.hardClearRatio === "number" && Number.isFinite(cfg.hardClearRatio)) {
    s.hardClearRatio = Math.min(1, Math.max(0, cfg.hardClearRatio));
  }
  if (typeof cfg.minPrunableToolChars === "number" && Number.isFinite(cfg.minPrunableToolChars)) {
    s.minPrunableToolChars = Math.max(0, Math.floor(cfg.minPrunableToolChars));
  }
  if (cfg.tools) {
    s.tools = cfg.tools;
  }
  if (cfg.softTrim) {
    if (typeof cfg.softTrim.maxChars === "number" && Number.isFinite(cfg.softTrim.maxChars)) {
      s.softTrim.maxChars = Math.max(0, Math.floor(cfg.softTrim.maxChars));
    }
    if (typeof cfg.softTrim.headChars === "number" && Number.isFinite(cfg.softTrim.headChars)) {
      s.softTrim.headChars = Math.max(0, Math.floor(cfg.softTrim.headChars));
    }
    if (typeof cfg.softTrim.tailChars === "number" && Number.isFinite(cfg.softTrim.tailChars)) {
      s.softTrim.tailChars = Math.max(0, Math.floor(cfg.softTrim.tailChars));
    }
  }
  if (cfg.hardClear) {
    if (typeof cfg.hardClear.enabled === "boolean") {
      s.hardClear.enabled = cfg.hardClear.enabled;
    }
    if (typeof cfg.hardClear.placeholder === "string" && cfg.hardClear.placeholder.trim()) {
      s.hardClear.placeholder = cfg.hardClear.placeholder.trim();
    }
  }

  return s;
}
