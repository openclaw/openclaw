import {
  buildChannelConfigSchema,
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { maxMessengerGatewayAdapter } from "./adapters/gateway.adapter.js";
import { maxMessengerConfigAdapter } from "./adapters/identity.adapter.js";
import { maxMessengerOutboundAdapter } from "./adapters/outbound.adapter.js";
import { MaxConfigSchema } from "./config-schema.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import type { ResolvedMaxAccount } from "./types.js";

const meta = {
  id: "max-messenger",
  label: "MAX",
  selectionLabel: "MAX (Russian messenger)",
  detailLabel: "MAX bot",
  docsPath: "/channels/max-messenger",
  docsLabel: "max-messenger",
  blurb: "Russian messenger MAX (by VK). Phase 1A scaffolding only — polling lands in Phase 1B.",
  aliases: ["max"],
  order: 70,
  markdownCapable: true,
};

/**
 * MAX Messenger channel plugin (Phase 1A scaffolding).
 *
 * Assembled from per-concern adapter modules under `./adapters/`. Phase 1B
 * swaps the `gateway` body for the polling supervisor (plan.md §6.1.6) and
 * the `outbound` body for real `api.sendMessage` calls.
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
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
    setup: {
      // Phase 1A: minimum viable setup — accept the input shape, return cfg as-is.
      // Real setup wizard wiring lands in Phase 2 alongside webhook onboarding.
      applyAccountConfig: ({ cfg }) => cfg,
    },
    gateway: maxMessengerGatewayAdapter,
  },
  outbound: maxMessengerOutboundAdapter,
});
