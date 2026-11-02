import type {
  ChannelDoctorConfigMutation,
  ChannelDoctorLegacyConfigRule,
} from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createLegacyWebhookListenerDoctorContract,
  defineChannelAliasMigration,
} from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { resolveMSTeamsCredentials } from "./src/token-config.js";

const webhookMigration = createLegacyWebhookListenerDoctorContract({
  channelKey: "msteams",
  defaultPort: 3978,
  webhookKey: "webhook",
  portKey: "port",
  hostKey: null,
  preserveAuthoredActivation: true,
});
export const { historicalWebhookListener } = webhookMigration;

const streamingAliasMigration = defineChannelAliasMigration({
  channelId: "msteams",
  // Teams previews default to partial streaming, matching the runtime default
  // in reply-dispatcher when no mode is configured.
  streaming: { defaultMode: "partial" },
});

// Before #190740 Teams group chats only matched broadcast keys that carried the
// `conversation:` target prefix; the documented form is the bare conversation id.
const LEGACY_BROADCAST_PREFIX = "msteams:conversation:";

function listLegacyBroadcastKeys(broadcast: unknown): string[] {
  if (!broadcast || typeof broadcast !== "object" || Array.isArray(broadcast)) {
    return [];
  }
  // Only group chats (`19:…@thread.v2`) moved to the bare id; DMs and channels
  // still resolve through their previous broadcast identity.
  return Object.keys(broadcast).filter((key) => {
    const id = key.slice(LEGACY_BROADCAST_PREFIX.length);
    return key.startsWith(LEGACY_BROADCAST_PREFIX) && /^19:.+@thread\.v2$/i.test(id);
  });
}

const broadcastKeyRule: ChannelDoctorLegacyConfigRule = {
  path: ["broadcast"],
  message:
    'broadcast."msteams:conversation:<group-chat-id>" is legacy; use broadcast."msteams:<group-chat-id>" instead. Run "openclaw doctor --fix".',
  match: (value) => listLegacyBroadcastKeys(value).length > 0,
};

export function normalizeLegacyBroadcastKeys({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const legacyKeys = listLegacyBroadcastKeys(cfg.broadcast);
  if (legacyKeys.length === 0) {
    return { config: cfg, changes: [] };
  }
  const broadcast: NonNullable<OpenClawConfig["broadcast"]> = { ...cfg.broadcast };
  const changes: string[] = [];
  const warnings: string[] = [];
  for (const legacyKey of legacyKeys) {
    const canonicalKey = `msteams:${legacyKey.slice(LEGACY_BROADCAST_PREFIX.length)}`;
    if (Object.hasOwn(broadcast, canonicalKey)) {
      // The canonical entry already wins at runtime; drop the superseded key.
      const differs =
        JSON.stringify(broadcast[canonicalKey]) !== JSON.stringify(broadcast[legacyKey]);
      delete broadcast[legacyKey];
      changes.push(`Removed broadcast."${legacyKey}"; kept existing broadcast."${canonicalKey}".`);
      if (differs) {
        warnings.push(
          `broadcast."${legacyKey}" differed from broadcast."${canonicalKey}"; the canonical participants were kept.`,
        );
      }
      continue;
    }
    broadcast[canonicalKey] = broadcast[legacyKey];
    delete broadcast[legacyKey];
    changes.push(`Moved broadcast."${legacyKey}" → broadcast."${canonicalKey}".`);
  }
  return {
    config: changes.length ? { ...cfg, broadcast } : cfg,
    changes,
    ...(warnings.length ? { warnings } : {}),
  };
}

export const legacyConfigRules: ChannelDoctorLegacyConfigRule[] = [
  ...webhookMigration.legacyConfigRules,
  ...streamingAliasMigration.legacyConfigRules,
  broadcastKeyRule,
];

export function normalizeHistoricalWebhookConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const webhook = webhookMigration.normalizeCompatibilityConfig({ cfg });
  return {
    ...webhook,
    historicalWebhookAccountIds:
      cfg.channels?.msteams === undefined && !resolveMSTeamsCredentials()
        ? null
        : cfg.channels?.msteams?.enabled === false
          ? []
          : [undefined],
  };
}

export function normalizeCompatibilityConfig({
  cfg,
}: {
  cfg: OpenClawConfig;
}): ChannelDoctorConfigMutation {
  const webhook = normalizeHistoricalWebhookConfig({ cfg });
  const channel = streamingAliasMigration.normalizeChannelConfig({
    cfg: webhook.config,
    changes: webhook.changes,
  });
  const broadcast = normalizeLegacyBroadcastKeys({ cfg: channel.config });
  const warnings = broadcast.warnings ?? [];
  return {
    ...channel,
    config: broadcast.config,
    changes: [...channel.changes, ...broadcast.changes],
    ...(warnings.length ? { warnings } : {}),
    historicalWebhookAccountIds: webhook.historicalWebhookAccountIds,
  };
}
