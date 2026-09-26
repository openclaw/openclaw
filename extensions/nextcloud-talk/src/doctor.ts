// Nextcloud Talk plugin module implements doctor behavior.
import os from "node:os";
import path from "node:path";
import type {
  ChannelDoctorAdapter,
  ChannelDoctorSequenceResult,
} from "openclaw/plugin-sdk/channel-contract";
import { fileExists } from "openclaw/plugin-sdk/file-access-runtime";
import { resolveGatewayPort } from "openclaw/plugin-sdk/gateway-config-runtime";
import { migratePersistentDedupeLegacyJsonFile } from "openclaw/plugin-sdk/persistent-dedupe";
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
import {
  NEXTCLOUD_TALK_PLUGIN_ID,
  NEXTCLOUD_TALK_REPLAY_DEDUPE_MAX_ENTRIES,
  NEXTCLOUD_TALK_REPLAY_DEDUPE_NAMESPACE_PREFIX,
  NEXTCLOUD_TALK_REPLAY_DEDUPE_TTL_MS,
} from "./replay-migration-contract.js";
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
    if (
      result.code === "missing_response_feature" ||
      result.code === "bot_not_found" ||
      result.code === "api_error" ||
      result.code === "request_failed"
    ) {
      warnings.push(`- channels.nextcloud-talk.${account.accountId}: ${result.message}`);
    }
  }
  return warnings;
}

async function repairNextcloudTalkReplayDedupeState(params: {
  cfg: CoreConfig;
  env?: NodeJS.ProcessEnv;
}): Promise<{ changes: string[]; warnings: string[] }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const env = params.env ?? process.env;
  const stateDir = resolveStateDir(env, os.homedir);
  const replayDir = path.join(stateDir, "nextcloud-talk", "replay-dedupe");

  for (const accountId of listNextcloudTalkAccountIds(params.cfg)) {
    const legacyPath = path.join(replayDir, `${sanitizeLegacyReplaySegment(accountId)}.json`);
    if (!fileExists(legacyPath)) {
      continue;
    }
    try {
      const result = await migratePersistentDedupeLegacyJsonFile({
        filePath: legacyPath,
        namespace: accountId,
        ttlMs: NEXTCLOUD_TALK_REPLAY_DEDUPE_TTL_MS,
        memoryMaxSize: 0,
        pluginId: NEXTCLOUD_TALK_PLUGIN_ID,
        namespacePrefix: NEXTCLOUD_TALK_REPLAY_DEDUPE_NAMESPACE_PREFIX,
        stateMaxEntries: NEXTCLOUD_TALK_REPLAY_DEDUPE_MAX_ENTRIES,
        env,
      });
      changes.push(
        `Migrated Nextcloud Talk replay dedupe cache for account "${accountId}" to SQLite (${result.imported} imported, ${result.skippedExpired} expired, ${result.skippedExisting} already current).`,
      );
    } catch (error) {
      warnings.push(
        `Skipped Nextcloud Talk replay dedupe cache for account "${accountId}": ${String(error)}`,
      );
    }
  }

  return { changes, warnings };
}

export const nextcloudTalkDoctor: ChannelDoctorAdapter = {
  legacyConfigRules: NEXTCLOUD_TALK_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeNextcloudTalkCompatibilityConfig,
  runConfigSequence: runNextcloudTalkDoctorSequence,
  collectPreviewWarnings: collectNextcloudTalkBotResponseWarnings,
  repairConfig: async ({ cfg, env }) => {
    const repair = await repairNextcloudTalkReplayDedupeState({
      cfg,
      ...(env ? { env } : {}),
    });
    return {
      config: cfg,
      changes: repair.changes,
      warnings: repair.warnings,
    };
  },
};
