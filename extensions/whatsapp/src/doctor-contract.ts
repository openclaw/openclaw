import type { ChannelDoctorConfigMutation } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const rawAckReaction = cfg.messages?.ackReaction;
  const legacyAckReaction = typeof rawAckReaction === "string" ? rawAckReaction.trim() : undefined;
  if (!legacyAckReaction || cfg.channels?.whatsapp === undefined) {
    return { config: cfg, changes: [] };
  }
  if (cfg.channels.whatsapp?.ackReaction !== undefined) {
    return { config: cfg, changes: [] };
  }

  const legacyScope = cfg.messages?.ackReactionScope ?? "group-mentions";
  // "off"/"none" means the user explicitly disabled ack reactions; do not migrate.
  if (legacyScope === "off" || legacyScope === "none") {
    return { config: cfg, changes: [] };
  }
  let direct = true;
  let group: "always" | "mentions" | "never" = "mentions";
  if (legacyScope === "all") {
    direct = true;
    group = "always";
  } else if (legacyScope === "direct") {
    direct = true;
    group = "never";
  } else if (legacyScope === "group-all") {
    direct = false;
    group = "always";
  } else if (legacyScope === "group-mentions") {
    direct = false;
    group = "mentions";
  }

  return {
    config: {
      ...cfg,
      channels: {
        ...cfg.channels,
        whatsapp: {
          ...cfg.channels?.whatsapp,
          ackReaction: { emoji: legacyAckReaction, direct, group },
        },
      },
    },
    changes: [
      `Copied messages.ackReaction → channels.whatsapp.ackReaction (scope: ${legacyScope}).`,
    ],
  };
}
