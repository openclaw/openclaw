import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  defineChannelAliasMigration,
  stripRetiredChannelKeys,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { MatrixStreamingMode } from "./types.js";

function parseMatrixStreamingMode(value: unknown): MatrixStreamingMode | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "partial" ||
    normalized === "quiet" ||
    normalized === "progress" ||
    normalized === "off"
    ? normalized
    : null;
}

// Matrix has a preview stream mode with the channel-local "quiet" value, so it
// overrides the generic mode parser (which would collapse "quiet" to the
// default). Runtime defaults to "off" when streaming is absent or the object
// has no mode (resolveMatrixStreamingMode in matrix/monitor/index.ts), and the
// account merge replaces the root streaming object wholesale
// (resolveMergedAccountConfig without a streaming deep-merge), so migration
// seeds materialized account objects with the inherited root settings.
// `streamMode` was never a Matrix key (no schema field, no runtime read), so
// it is stripped as junk below instead of being treated as mode intent.
const streamingAliasMigration = defineChannelAliasMigration<MatrixStreamingMode>({
  channelId: "matrix",
  streaming: {
    defaultMode: "off",
    resolveMode: (entry) => {
      const streaming = isRecord(entry.streaming) ? entry.streaming : null;
      const parsed = parseMatrixStreamingMode(streaming ? streaming.mode : entry.streaming);
      if (parsed) {
        return parsed;
      }
      return entry.streaming === true ? "partial" : "off";
    },
  },
  accountStreamingReplacesRoot: true,
});

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] =
  streamingAliasMigration.legacyConfigRules;

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const changes: string[] = [];
  // `streamMode` was never honored by Matrix, so remove it before the generic
  // alias migration can mistake it for mode intent.
  const withoutJunkStreamMode = stripRetiredChannelKeys({
    cfg,
    channelId: "matrix",
    keys: new Set(["streamMode"]),
    scope: "root-and-accounts",
    onRemove: ({ key, pathPrefix }) =>
      changes.push(`Removed ${pathPrefix}.${key} (never read by the Matrix runtime).`),
  }).config;
  return streamingAliasMigration.normalizeChannelConfig({
    cfg: withoutJunkStreamMode,
    changes,
  });
}
