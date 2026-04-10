import { attachChannelToResult } from "openclaw/plugin-sdk/channel-send-result";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  campfireChannelConfigSchema,
  campfireConfigAdapter,
  resolveCampfireAccount,
} from "./config.js";
import { campfireGateway } from "./monitor/provider.js";
import { sendCampfireText } from "./send.js";
import {
  resolveCampfireOutboundSessionRoute,
  resolveCampfireRoomIdFromTarget,
} from "./session-route.js";
import { campfireSetupAdapter } from "./setup-core.js";
import type { ResolvedCampfireAccount } from "./types.js";
import { isCampfireUrlInWorkspaceScope, isValidCampfireUrl } from "./workspace-url.js";

function assertCampfireOutboundTarget(target: string, account: ResolvedCampfireAccount): string {
  const normalizedTarget = target.trim();
  if (!normalizedTarget) {
    throw new Error("Campfire target URL is required");
  }

  if (!isValidCampfireUrl(normalizedTarget)) {
    throw new Error("Campfire target must be a valid URL");
  }

  if (!isCampfireUrlInWorkspaceScope(normalizedTarget, account.baseUrl)) {
    throw new Error("Campfire target must match channels.campfire.baseUrl");
  }

  return normalizedTarget;
}

export function createCampfirePlugin(params?: {
  sendText?: typeof sendCampfireText;
  now?: () => number;
  gateway?: typeof campfireGateway;
}): ChannelPlugin<ResolvedCampfireAccount> {
  const sendText = params?.sendText ?? sendCampfireText;
  const now = params?.now ?? Date.now;
  const gateway = params?.gateway ?? campfireGateway;

  return {
    id: "campfire",
    meta: {
      id: "campfire",
      label: "Campfire",
      selectionLabel: "Campfire (Webhook)",
      detailLabel: "Campfire",
      docsPath: "/channels/campfire",
      docsLabel: "campfire",
      blurb: "Self-hosted 37signals Campfire webhook integration.",
      order: 65,
    },
    capabilities: {
      chatTypes: ["group"],
      media: false,
      threads: false,
      reactions: false,
      nativeCommands: false,
      blockStreaming: true,
    },
    reload: {
      configPrefixes: ["channels.campfire"],
    },
    configSchema: campfireChannelConfigSchema,
    config: {
      ...campfireConfigAdapter,
      isConfigured: (account) => account.configured,
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        baseUrl: account.baseUrl ? "[set]" : "[missing]",
      }),
    },
    setup: campfireSetupAdapter,
    messaging: {
      normalizeTarget: (target) => target.trim() || undefined,
      resolveOutboundSessionRoute: (params) => resolveCampfireOutboundSessionRoute(params),
      targetResolver: {
        looksLikeId: (id) => isValidCampfireUrl(id.trim()),
        hint: "<campfire room webhook URL>",
      },
    },
    outbound: {
      deliveryMode: "direct",
      textChunkLimit: 4000,
      sendText: async ({ cfg, to, text, accountId }) => {
        const account = resolveCampfireAccount(cfg, accountId);
        const target = assertCampfireOutboundTarget(to, account);
        const roomId = resolveCampfireRoomIdFromTarget(target);

        await sendText(target, text, account.botKey, account.textChunkLimit);
        return attachChannelToResult("campfire", {
          ...(roomId ? { chatId: `campfire:room:${roomId}` } : {}),
          messageId: `campfire-${now()}`,
        });
      },
    },
    gateway,
  };
}

export const campfirePlugin = createCampfirePlugin();
