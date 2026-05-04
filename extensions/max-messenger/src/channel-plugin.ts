import {
  buildChannelConfigSchema,
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { createLoggedPairingApprovalNotifier } from "openclaw/plugin-sdk/channel-pairing";
import { maxMessengerGatewayAdapter } from "./adapters/gateway.adapter.js";
import {
  maxMessengerConfigAdapter,
  maxMessengerPairingTextAdapter,
  maxMessengerSecurityAdapter,
} from "./adapters/identity.adapter.js";
import { maxMessengerOutboundAdapter } from "./adapters/outbound.adapter.js";
import { MaxConfigSchema } from "./config-schema.js";
import { looksLikeMaxTargetId, normalizeMaxMessagingTarget } from "./normalize.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import type { ResolvedMaxAccount } from "./types.js";

const meta = {
  id: "max-messenger",
  label: "MAX",
  selectionLabel: "MAX (Russian messenger)",
  detailLabel: "MAX bot",
  docsPath: "/channels/max-messenger",
  docsLabel: "max-messenger",
  blurb: "Russian messenger MAX (by VK). Polling supervisor + agent reply pipeline (Phase 1B).",
  aliases: ["max"],
  order: 70,
  markdownCapable: true,
};

/**
 * MAX Messenger channel plugin.
 *
 * Phase 1A scaffolded the file layout. Phase 1B.1 added the custom polling
 * supervisor + HTTP wrapper; Phase 1B.2 added integration tests and config
 * schema wiring; Phase 1B.3 (this surface) wires the inbound dispatcher,
 * pairing controller, security DM resolver, and target normalization so the
 * agent reply pipeline (`dispatchInboundReplyWithBase`) routes
 * `message_created` events end-to-end.
 */
export const maxMessengerPlugin: ChannelPlugin<ResolvedMaxAccount> = createChatChannelPlugin({
  base: {
    id: "max-messenger",
    meta,
    capabilities: {
      chatTypes: ["direct", "group"],
      reactions: false,
      threads: false,
      media: false,
      nativeCommands: false,
      blockStreaming: true,
    },
    reload: { configPrefixes: ["channels.max-messenger"] },
    configSchema: buildChannelConfigSchema(MaxConfigSchema),
    config: maxMessengerConfigAdapter,
    messaging: {
      targetPrefixes: ["max-messenger", "max"],
      normalizeTarget: normalizeMaxMessagingTarget,
      targetResolver: {
        looksLikeId: looksLikeMaxTargetId,
        hint: "<chatId>",
      },
    },
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
    setup: {
      // Phase 2 ships the interactive wizard; for now accept the input shape
      // and return cfg as-is. The setup adapter is required by the SDK base.
      applyAccountConfig: ({ cfg }) => cfg,
    },
    gateway: maxMessengerGatewayAdapter,
  },
  pairing: {
    text: {
      ...maxMessengerPairingTextAdapter,
      notify: createLoggedPairingApprovalNotifier(
        ({ id }) => `[max-messenger] User ${id} approved for pairing`,
      ),
    },
  },
  security: maxMessengerSecurityAdapter,
  outbound: maxMessengerOutboundAdapter,
});
