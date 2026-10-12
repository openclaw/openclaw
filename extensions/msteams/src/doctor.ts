import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
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
import { listMSTeamsAccountIds, resolveMSTeamsAccountConfig } from "./accounts.js";
import {
  resolveMSTeamsLegacyWebhook,
  resolveMSTeamsLegacyWebhookConfigPath,
  resolveMSTeamsWebhookPathIssue,
} from "./webhook-route.js";

const isMSTeamsMutableAllowEntry = buildMutableAllowEntryDetector({
  prefixes: ["msteams:", "user:"],
  stableIdPattern: /^[^\s@]+$/,
});

const collectMSTeamsMutableAllowlistWarnings =
  createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "msteams",
    detector: isMSTeamsMutableAllowEntry,
    collectLists: collectStandardAllowlistLists,
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
  const warningNotes: string[] = [];
  const infoNotes: string[] = [];
  const port = resolveGatewayPort(cfg, env);
  for (const accountId of listMSTeamsAccountIds(cfg)) {
    const accountConfig = resolveMSTeamsAccountConfig(cfg, accountId);
    if (accountConfig.enabled === false) {
      continue;
    }
    const pathIssue = resolveMSTeamsWebhookPathIssue({ cfg, env, accountId, accountConfig });
    if (pathIssue) {
      warningNotes.push(pathIssue);
      continue;
    }
    const path = accountConfig.webhook?.path || "/api/messages";
    const legacy = resolveMSTeamsLegacyWebhook(accountConfig);
    const label =
      accountId === DEFAULT_ACCOUNT_ID ? "Microsoft Teams" : `Microsoft Teams (${accountId})`;
    infoNotes.push(
      legacy
        ? `${label}: compatibility port ${legacy.port} continues forwarding to Gateway route ${path}. To use only the Gateway listener, update the Azure Bot messaging endpoint or reverse-proxy upstream to Gateway port ${port}${path}, verify delivery, then remove the ${resolveMSTeamsLegacyWebhookConfigPath(cfg, accountId)} pin to close the old port.`
        : `${label} webhooks use Gateway port ${port}${path}; no compatibility listener is configured. Point the Azure Bot messaging endpoint or reverse-proxy upstream to this route.`,
    );
  }
  return { changeNotes: [], warningNotes, infoNotes };
}

export const msteamsDoctor = {
  dmAllowFromMode: "topOnly",
  groupModel: "hybrid",
  groupAllowFromFallbackToAllowFrom: true,
  warnOnEmptyGroupSenderAllowlist: true,
  collectMutableAllowlistWarnings: collectMSTeamsMutableAllowlistWarnings,
  runConfigSequence: runMSTeamsWebhookDoctorSequence,
} satisfies ChannelDoctorAdapter;
