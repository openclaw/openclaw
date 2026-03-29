/**
 * Configuration parsing and defaults for MS Teams voice support.
 */

import type { MSTeamsVoiceConfig, MSTeamsVoicePermissionMode } from "../../runtime-api.js";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_WORKER_ADDRESS = "localhost:9442";
const DEFAULT_SILENCE_DURATION_MS = 1_000;
const DEFAULT_MIN_SEGMENT_SECONDS = 0.35;
const DEFAULT_PERMISSION_MODE: MSTeamsVoicePermissionMode = "rsc-with-admin-media";
const DEFAULT_STT_PROVIDER = "openai-realtime";

// ---------------------------------------------------------------------------
// Resolved config (all defaults applied)
// ---------------------------------------------------------------------------

export type ResolvedTeamsVoiceConfig = {
  enabled: boolean;
  permissionMode: MSTeamsVoicePermissionMode;
  autoJoin: Array<{ joinUrl: string }>;
  workerAddress: string;
  sttProvider: string;
  silenceDurationMs: number;
  minSegmentSeconds: number;
  transcriptFallback: false | "rsc" | "tenant-wide";
};

export function resolveTeamsVoiceConfig(
  raw: MSTeamsVoiceConfig | undefined,
): ResolvedTeamsVoiceConfig {
  return {
    enabled: raw?.enabled ?? false,
    permissionMode: raw?.permissionMode ?? DEFAULT_PERMISSION_MODE,
    autoJoin: raw?.autoJoin ?? [],
    workerAddress: raw?.workerAddress ?? DEFAULT_WORKER_ADDRESS,
    sttProvider: raw?.sttProvider ?? DEFAULT_STT_PROVIDER,
    silenceDurationMs: raw?.silenceDurationMs ?? DEFAULT_SILENCE_DURATION_MS,
    minSegmentSeconds: raw?.minSegmentSeconds ?? DEFAULT_MIN_SEGMENT_SECONDS,
    transcriptFallback: raw?.transcriptFallback ?? false,
  };
}
