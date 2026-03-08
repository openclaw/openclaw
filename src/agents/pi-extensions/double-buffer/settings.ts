/**
 * Configuration types for the double-buffered context window extension.
 */

/**
 * User-facing configuration for double-buffer context management.
 * All thresholds are expressed as ratios of the context window capacity (0..1).
 */
export type DoubleBufferConfig = {
  /** Ratio of context capacity at which to start background checkpoint (default: 0.70). */
  checkpointThreshold?: number;
  /** Ratio of context capacity at which to swap buffers (default: 0.95). */
  swapThreshold?: number;
  /** Maximum number of summary generations before meta-summarizing. undefined means no limit (renewal disabled). */
  maxGenerations?: number;
  /** Custom instructions to include in summarization prompts. */
  customInstructions?: string;
};

/** Validated, fully-resolved settings used at runtime. */
export type EffectiveDoubleBufferSettings = {
  checkpointThreshold: number;
  swapThreshold: number;
  /** undefined means no limit (renewal disabled). */
  maxGenerations: number | undefined;
  customInstructions: string | undefined;
};

export const DEFAULT_DOUBLE_BUFFER_SETTINGS: EffectiveDoubleBufferSettings = {
  checkpointThreshold: 0.7,
  swapThreshold: 0.95,
  maxGenerations: undefined,
  customInstructions: undefined,
};

function clampRatio(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Resolve raw user config into validated effective settings.
 * Returns null if the config is invalid or explicitly disabled.
 */
export function computeEffectiveDoubleBufferSettings(
  raw: unknown,
): EffectiveDoubleBufferSettings | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const cfg = raw as DoubleBufferConfig;
  const settings: EffectiveDoubleBufferSettings = structuredClone(DEFAULT_DOUBLE_BUFFER_SETTINGS);

  if (typeof cfg.checkpointThreshold === "number" && Number.isFinite(cfg.checkpointThreshold)) {
    settings.checkpointThreshold = clampRatio(cfg.checkpointThreshold, 0.1, 0.95);
  }

  if (typeof cfg.swapThreshold === "number" && Number.isFinite(cfg.swapThreshold)) {
    settings.swapThreshold = clampRatio(cfg.swapThreshold, 0.5, 1.0);
  }

  // Ensure swap > checkpoint (otherwise the concurrent phase has zero width).
  if (settings.swapThreshold <= settings.checkpointThreshold) {
    settings.swapThreshold = Math.min(1.0, settings.checkpointThreshold + 0.1);
  }

  if (typeof cfg.maxGenerations === "number" && Number.isFinite(cfg.maxGenerations)) {
    settings.maxGenerations = Math.max(1, Math.floor(cfg.maxGenerations));
  }

  if (typeof cfg.customInstructions === "string" && cfg.customInstructions.trim().length > 0) {
    settings.customInstructions = cfg.customInstructions.trim();
  }

  return settings;
}
