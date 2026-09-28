import type {
  ChannelDoctorAdapter,
  ChannelDoctorSequenceResult,
} from "openclaw/plugin-sdk/channel-contract";
import {
  buildMutableAllowEntryDetector,
  collectStandardAllowlistLists,
  createDangerousNameMatchingMutableAllowlistWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveGatewayPort } from "openclaw/plugin-sdk/gateway-config-runtime";
import { resolveMSTeamsLegacyWebhook, resolveMSTeamsWebhookPathIssue } from "./webhook-route.js";

const isMSTeamsMutableAllowEntry = buildMutableAllowEntryDetector({
  prefixes: ["msteams:", "user:"],
  stableIdPattern: /^[^\s@]+$/,
});

const collectMSTeamsMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "msteams",
    detector: isMSTeamsMutableAllowEntry,
    collectLists: (scope) => collectStandardAllowlistLists(scope),
  });

function runMSTeamsWebhookDoctorSequence({
  cfg,
  env,
}: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): ChannelDoctorSequenceResult {
  const channel = cfg.channels?.msteams;
  if (!channel || channel.enabled === false) {
    return { changeNotes: [], warningNotes: [], infoNotes: [] };
  }
  const pathIssue = resolveMSTeamsWebhookPathIssue({ cfg, env });
  if (pathIssue) {
    return { changeNotes: [], warningNotes: [pathIssue], infoNotes: [] };
  }
  const path = channel.webhook?.path || "/api/messages";
  const port = resolveGatewayPort(cfg, env);
  const legacy = resolveMSTeamsLegacyWebhook(channel);
  return {
    changeNotes: [],
    warningNotes: [],
    infoNotes: [
      legacy
        ? `Microsoft Teams: compatibility port ${legacy.port} continues forwarding to Gateway route ${path}. To use only the Gateway listener, update the Azure Bot messaging endpoint or reverse-proxy upstream to Gateway port ${port}${path}, verify delivery, then set channels.msteams.legacyWebhook=false to close the old port.`
        : `Microsoft Teams webhooks use Gateway port ${port}${path}; the compatibility listener is disabled by channels.msteams.legacyWebhook=false. Point the Azure Bot messaging endpoint or reverse-proxy upstream to this route.`,
    ],
  };
}

export const msteamsDoctor = {
  dmAllowFromMode: "topOnly",
  groupModel: "hybrid",
  groupAllowFromFallbackToAllowFrom: true,
  warnOnEmptyGroupSenderAllowlist: true,
  collectMutableAllowlistWarnings: collectMSTeamsMutableAllowlistWarnings,
  runConfigSequence: runMSTeamsWebhookDoctorSequence,
} satisfies ChannelDoctorAdapter;
