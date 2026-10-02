import os from "node:os";
import path from "node:path";
import type {
  ChannelDoctorAdapter,
  ChannelDoctorSequenceResult,
} from "openclaw/plugin-sdk/channel-contract";
import { fileExists } from "openclaw/plugin-sdk/file-access-runtime";
import { resolveGatewayPort } from "openclaw/plugin-sdk/gateway-config-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  isNextcloudTalkAccountConfigured,
  listNextcloudTalkAccountIds,
  resolveNextcloudTalkAccount,
} from "./accounts.js";
import { probeNextcloudTalkBotResponseFeature } from "./bot-preflight.js";
import {
  legacyConfigRules as NEXTCLOUD_TALK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeNextcloudTalkCompatibilityConfig,
} from "./doctor-contract.js";
import type { CoreConfig } from "./types.js";
import {
  DEFAULT_NEXTCLOUD_TALK_WEBHOOK_PATH,
  describeNextcloudTalkWebhookRouteConflict,
  resolveNextcloudTalkLegacyWebhook,
} from "./webhook-route.js";

function sanitizeLegacyReplaySegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function runNextcloudTalkDoctorSequence(params: {
  cfg: CoreConfig;
  env?: NodeJS.ProcessEnv;
}): ChannelDoctorSequenceResult {
  const infoNotes: string[] = [];
  const warningNotes: string[] = [];
  for (const accountId of listNextcloudTalkAccountIds(params.cfg)) {
    const account = resolveNextcloudTalkAccount({ cfg: params.cfg, accountId });
    if (!account.enabled || !isNextcloudTalkAccountConfigured(account)) {
      continue;
    }
    const gatewayPort = resolveGatewayPort({ gateway: params.cfg.gateway }, params.env);
    const webhookPath = account.config.webhookPath ?? DEFAULT_NEXTCLOUD_TALK_WEBHOOK_PATH;
    const destination = `Gateway port ${gatewayPort}${webhookPath}`;
    const legacyListener = resolveNextcloudTalkLegacyWebhook(account.config);
    const routeConflict = describeNextcloudTalkWebhookRouteConflict(webhookPath, gatewayPort);
    if (routeConflict) {
      warningNotes.push(
        `- channels.nextcloud-talk.${account.accountId}: ${routeConflict}` +
          (legacyListener
            ? ` Legacy webhook listener ${legacyListener.host}:${legacyListener.port} remains available; verify the new route before setting legacyWebhook: false.`
            : " This account cannot start until the callback path is changed."),
      );
    } else if (legacyListener) {
      infoNotes.push(
        `- channels.nextcloud-talk.${account.accountId}: legacy webhook listener ${legacyListener.host}:${legacyListener.port} forwards to the Gateway route. ` +
          `Point the Nextcloud callback or reverse-proxy upstream to ${destination}, verify delivery, then set legacyWebhook: false to disable this account's legacy forwarding.`,
      );
    } else {
      infoNotes.push(
        `- channels.nextcloud-talk.${account.accountId}: legacyWebhook is false; use ${destination} for the Nextcloud callback or reverse-proxy upstream.`,
      );
    }
  }
  return { changeNotes: [], warningNotes, infoNotes };
}

async function collectNextcloudTalkBotResponseWarnings(params: {
  cfg: CoreConfig;
}): Promise<string[]> {
  const warnings: string[] = [];
  for (const accountId of listNextcloudTalkAccountIds(params.cfg)) {
    const account = resolveNextcloudTalkAccount({ cfg: params.cfg, accountId });
    if (!account.enabled || !account.secret || !account.baseUrl) {
      continue;
    }
    const result = await probeNextcloudTalkBotResponseFeature({
      account,
      timeoutMs: 5_000,
    });
    if (!result.ok) {
      warnings.push(`- channels.nextcloud-talk.${account.accountId}: ${result.message}`);
    }
  }
  return warnings;
}

export const nextcloudTalkDoctor: ChannelDoctorAdapter = {
  legacyConfigRules: NEXTCLOUD_TALK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeNextcloudTalkCompatibilityConfig,
  runConfigSequence: runNextcloudTalkDoctorSequence,
  collectPreviewWarnings: collectNextcloudTalkBotResponseWarnings,
  repairConfig: ({ cfg, doctorFixCommand, env = process.env }) => {
    const replayDir = path.join(
      resolveStateDir(env, os.homedir),
      "nextcloud-talk",
      "replay-dedupe",
    );
    for (const accountId of listNextcloudTalkAccountIds(cfg)) {
      const legacyPath = path.join(replayDir, `${sanitizeLegacyReplaySegment(accountId)}.json`);
      if (fileExists(legacyPath)) {
        throw new Error(
          `Retired pre-July Nextcloud Talk replay state at ${legacyPath} was left unchanged. Install OpenClaw 2026.9.5, run "${doctorFixCommand}", then upgrade to latest. See https://docs.openclaw.ai/install/updating#upgrading-very-old-versions.`,
        );
      }
    }
    return { config: cfg, changes: [] };
  },
};
