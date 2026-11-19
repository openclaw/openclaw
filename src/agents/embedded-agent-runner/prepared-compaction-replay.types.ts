import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import type { TranscriptPolicy } from "../transcript-policy.types.js";

/** Serializable policy, not configuration or provider callbacks. */
export type PreparedCompactionReplayOptions = {
  model: ProviderRuntimeModel;
  policy: TranscriptPolicy;
  sessionId: string;
  allowedToolNames: string[];
  imageLimits: ImageSanitizationLimits;
  historyLimit?: number;
  replayEnabled: boolean;
  observedTokenCount?: number;
};
