import { normalizeLegacyDmAliases } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  buildChannelConfigSchema,
  refineChannelDmPolicy,
} from "openclaw/plugin-sdk/channel-config-schema";
import { asObjectRecord } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { z } from "zod";
import { DiscordAccountSchemaBase, discordRootPolicyShape } from "../config-schema-api.js";
import { discordChannelConfigUiHints } from "./config-ui-hints.js";

function normalizeShippedDiscordDmAliases(value: unknown): unknown {
  const entry = asObjectRecord(value);
  if (!entry) {
    return value;
  }

  const updated = normalizeLegacyDmAliases({
    entry,
    pathPrefix: "channels.discord",
    changes: [],
  }).entry;
  const dm = asObjectRecord(updated.dm);
  if (!dm || (dm.policy === undefined && dm.allowFrom === undefined)) {
    return updated;
  }
  const { policy: _policy, allowFrom: _allowFrom, ...retainedDm } = dm;
  const { dm: _dm, ...rest } = updated;
  return Object.keys(retainedDm).length > 0 ? { ...rest, dm: retainedDm } : rest;
}

const DiscordAccountSchema = z.preprocess(
  normalizeShippedDiscordDmAliases,
  DiscordAccountSchemaBase,
);

const DiscordConfigSchemaBase = DiscordAccountSchemaBase.safeExtend({
  ...discordRootPolicyShape,
  accounts: z.record(z.string(), DiscordAccountSchema.optional()).optional(),
  defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
  refineChannelDmPolicy({ channelId: "discord", value, ctx });

  if (!value.accounts) {
    return;
  }
  for (const [accountId, account] of Object.entries(value.accounts)) {
    if (!account) {
      continue;
    }
    refineChannelDmPolicy({ channelId: "discord", value, accountId, ctx });
  }
});

export const DiscordConfigSchema = z.preprocess(
  normalizeShippedDiscordDmAliases,
  DiscordConfigSchemaBase,
);

export const DiscordChannelConfigSchema = buildChannelConfigSchema(DiscordConfigSchema, {
  uiHints: discordChannelConfigUiHints,
});
