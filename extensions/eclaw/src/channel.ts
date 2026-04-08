/**
 * E-Claw channel plugin.
 *
 * E-Claw (https://eclawbot.com) is an AI chat platform for live wallpaper
 * character entities on Android. Each connected device has a small number
 * of character "slots"; an OpenClaw bot claims a slot and exchanges
 * messages with the device owner (and other entities on the same device)
 * via the E-Claw channel HTTP API.
 *
 * This plugin ships the minimal ChannelPlugin surface needed for bundled
 * discovery — config resolution, outbound send, gateway start/stop, and a
 * stub setup adapter. Inbound dispatch runs through the webhook-handler
 * module which delegates to the OpenClaw reply runtime.
 *
 * Doc references (OpenClaw repo):
 *   - docs/plugins/sdk-channel-plugins.md §"Channel plugin contract" —
 *     `createChatChannelPlugin` is the stable factory; config adapter,
 *     messaging normalizer, directory adapter, and setup surface are
 *     the four required slots.
 *   - docs/plugins/architecture.md §"Plugin SDK import paths" —
 *     every import here uses `openclaw/plugin-sdk/<subpath>` so the
 *     extension package boundary check passes.
 *   - AGENTS.md §"Architecture Boundaries" → "Extension package
 *     boundary guardrail" — no relative imports outside this package.
 */

import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { createHybridChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { listAccountIds, resolveAccount } from "./accounts.js";
import { EclawChannelConfigSchema } from "./config-schema.js";
import {
  startEclawAccount,
  stopEclawAccount,
  type EclawGatewayContext,
} from "./gateway.js";
import { sendEclawMedia, sendEclawText } from "./send.js";
import { eclawSetupAdapter, eclawSetupWizard } from "./setup-adapter.js";
import type { ResolvedEclawAccount } from "./types.js";

const CHANNEL_ID = "eclaw";

const eclawConfigAdapter = createHybridChannelConfigAdapter<ResolvedEclawAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds,
  resolveAccount,
  defaultAccountId: () => DEFAULT_ACCOUNT_ID,
  clearBaseFields: ["apiKey", "apiBase", "botName", "webhookUrl"],
  resolveAllowFrom: () => [],
  formatAllowFrom: () => [],
});

type EclawOutboundContext = {
  cfg: OpenClawConfig;
  to: string;
  text?: string;
  mediaUrl?: string;
  mediaType?: string;
  accountId?: string | null;
};
type EclawSendTextContext = EclawOutboundContext & { text: string };

export const eclawPlugin = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "E-Claw",
      selectionLabel: "E-Claw (AI Live Wallpaper)",
      detailLabel: "E-Claw",
      docsPath: "/channels/eclaw",
      docsLabel: "eclaw",
      blurb:
        "Connect OpenClaw to E-Claw — an AI chat platform for live wallpaper character entities on Android.",
      order: 95,
      aliases: ["eclaw", "e-claw", "claw"],
    },
    capabilities: {
      chatTypes: ["direct" as const],
      media: true,
      reactions: false,
      threads: false,
      edit: false,
      unsend: false,
      reply: false,
      effects: false,
      blockStreaming: false,
    },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
    configSchema: EclawChannelConfigSchema,
    setup: eclawSetupAdapter,
    setupWizard: eclawSetupWizard,
    config: {
      ...eclawConfigAdapter,
      isConfigured: (account: ResolvedEclawAccount) => Boolean(account.apiKey?.trim()),
    },
    messaging: {
      normalizeTarget: (target: string) => {
        const trimmed = target?.trim();
        if (!trimmed) {
          return undefined;
        }
        return trimmed.replace(/^eclaw:/i, "").trim();
      },
      targetResolver: {
        looksLikeId: (id: string) => {
          const trimmed = id?.trim();
          if (!trimmed) {
            return false;
          }
          // E-Claw conversationIds are "<deviceId>:<entityId>" or numeric slot IDs.
          return /^[\w-]+:\d+$/.test(trimmed) || /^\d+$/.test(trimmed);
        },
        hint: "<deviceId>:<entityId>",
      },
    },
    directory: createEmptyChannelDirectoryAdapter(),
    gateway: {
      startAccount: async (ctx: EclawGatewayContext) => startEclawAccount(ctx),
      stopAccount: async (ctx: EclawGatewayContext) => stopEclawAccount(ctx),
    },
    agentPrompt: {
      messageToolHints: () => [
        "",
        "### E-Claw Formatting",
        "E-Claw renders your replies on top of an Android live wallpaper character.",
        "Keep replies concise (1-3 short sentences) so they fit the wallpaper overlay.",
        "Plain text only; no Markdown, buttons, or code blocks.",
        "Use the `[SILENT]` token when there is nothing worth saying in a bot-to-bot exchange.",
      ],
    },
  },
  outbound: {
    deliveryMode: "direct" as const,
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId }: EclawSendTextContext) =>
      sendEclawText({ to, text, accountId }),
    sendMedia: async ({ to, text, mediaUrl, mediaType, accountId }: EclawOutboundContext) =>
      sendEclawMedia({ to, text, mediaUrl, mediaType, accountId }),
  },
});
