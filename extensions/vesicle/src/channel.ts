import { describeWebhookAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  formatTrimmedAllowFromEntries,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { getChatChannelMeta } from "openclaw/plugin-sdk/channel-plugin-common";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  listVesicleAccountIds,
  resolveDefaultVesicleAccountId,
  resolveVesicleAccount,
  type ResolvedVesicleAccount,
} from "./accounts.js";
import { VesicleChannelConfigSchema } from "./config-schema.js";
import type { VesicleProbe } from "./probe.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { sendMessageVesicle } from "./send.js";
import { applyVesicleSetup } from "./setup.js";
import { vesicleStatus } from "./status.js";
import {
  inferVesicleTargetChatType,
  looksLikeVesicleExplicitTargetId,
  normalizeVesicleMessagingTarget,
  resolveVesicleOutboundSessionRoute,
} from "./targets.js";

const CHANNEL_ID = "vesicle" as const;
const meta = { ...getChatChannelMeta(CHANNEL_ID) };

const vesicleConfigAdapter = createScopedChannelConfigAdapter<ResolvedVesicleAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds: listVesicleAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveVesicleAccount),
  defaultAccountId: resolveDefaultVesicleAccountId,
  clearBaseFields: ["serverUrl", "authToken", "webhookPath", "webhookSecret", "name"],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) => formatTrimmedAllowFromEntries(allowFrom),
  resolveDefaultTo: (account) => account.config.defaultTo,
});

export const vesiclePlugin = createChatChannelPlugin<ResolvedVesicleAccount, VesicleProbe>({
  base: {
    id: CHANNEL_ID,
    meta,
    capabilities: {
      chatTypes: ["direct", "group"],
    },
    reload: { configPrefixes: ["channels.vesicle"] },
    configSchema: VesicleChannelConfigSchema,
    config: {
      ...vesicleConfigAdapter,
      isConfigured: (account) => account.configured,
      describeAccount: (account) =>
        describeWebhookAccountSnapshot({
          account,
          configured: account.configured,
          extra: {
            baseUrl: account.baseUrl,
          },
        }),
    },
    setup: {
      applyAccountConfig: ({ cfg, accountId, input }) =>
        applyVesicleSetup({
          cfg,
          accountId,
          input: input as Record<string, unknown>,
        }),
    },
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
    messaging: {
      normalizeTarget: normalizeVesicleMessagingTarget,
      inferTargetChatType: ({ to }) => inferVesicleTargetChatType(to),
      resolveOutboundSessionRoute: (params) => resolveVesicleOutboundSessionRoute(params),
      targetResolver: {
        looksLikeId: looksLikeVesicleExplicitTargetId,
        hint: "<chat_guid:GUID>",
        resolveTarget: async ({ normalized }) => {
          const to = normalizeOptionalString(normalized);
          if (!to || !looksLikeVesicleExplicitTargetId(to)) {
            return null;
          }
          const chatType = inferVesicleTargetChatType(to);
          if (!chatType) {
            return null;
          }
          return {
            to,
            kind: chatType === "direct" ? "user" : "group",
            source: "normalized" as const,
          };
        },
      },
    },
    status: vesicleStatus,
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      textChunkLimit: 4000,
      resolveTarget: ({ to }) => {
        const trimmed = normalizeOptionalString(to);
        if (!trimmed) {
          return {
            ok: false,
            error: new Error("Delivering to Vesicle requires --to <chat_guid:GUID>"),
          };
        }
        if (!looksLikeVesicleExplicitTargetId(trimmed)) {
          return {
            ok: false,
            error: new Error(
              "Vesicle currently sends only to existing chats; use --to chat_guid:<GUID>",
            ),
          };
        }
        return { ok: true, to: trimmed };
      },
    },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async ({ cfg, to, text, accountId }) =>
        await sendMessageVesicle(to, text, {
          cfg,
          accountId: accountId ?? undefined,
        }),
    },
  },
});
