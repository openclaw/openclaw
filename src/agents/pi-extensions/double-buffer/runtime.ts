/**
 * Per-session runtime registry for the double-buffer extension.
 */

import type { Api, Model } from "@mariozechner/pi-ai";
import { createSessionManagerRuntimeRegistry } from "../session-manager-runtime-registry.js";
import type { EffectiveDoubleBufferSettings } from "./settings.js";

export type DoubleBufferRuntimeValue = {
  settings: EffectiveDoubleBufferSettings;
  contextWindowTokens?: number;
  /**
   * Model for summarization. Passed through runtime because `ctx.model`
   * may be undefined in some execution paths.
   */
  model?: Model<Api>;
  /** Pre-resolved API key for the model. */
  apiKey?: string;
  /** Seed the active buffer with a prior summary (e.g. from a previous compaction). */
  initialSummary?: string;
};

const registry = createSessionManagerRuntimeRegistry<DoubleBufferRuntimeValue>();

export const setDoubleBufferRuntime = registry.set;

export const getDoubleBufferRuntime = registry.get;
