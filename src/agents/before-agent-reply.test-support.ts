import { vi } from "vitest";
import type { ReplyPayload } from "../auto-reply/reply-payload.js";
import type { ChannelOutboundAdapter } from "../channels/plugins/types.public.js";
import { createHookRunner } from "../plugins/hooks.js";
import { createLazyPluginRuntime } from "../plugins/loader-module-runtime.js";
import { createPluginRegistry } from "../plugins/registry.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import { createChannelTestPluginBase } from "../test-utils/channel-plugins.js";

export function createRegisteredBeforeAgentReplyFixture(reply: ReplyPayload) {
  const builder = createPluginRegistry({
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    runtime: createLazyPluginRuntime({
      loadPluginModule: () => {
        throw new Error("Claimed replies must not load the plugin runtime");
      },
    }),
    activateGlobalSideEffects: false,
  });
  const record = createPluginRecord({ id: "claimed-reply-proof", origin: "bundled" });
  builder.registry.plugins.push(record);
  const api = builder.createApi(record, { config: {} });
  const handler = vi.fn(() => ({ handled: true as const, reply }));
  api.on("before_agent_reply", handler);
  const sendText = vi.fn<NonNullable<ChannelOutboundAdapter["sendText"]>>(async () => ({
    channel: "slack",
    messageId: "claimed-text-delivered",
  }));
  const sendMedia = vi.fn<NonNullable<ChannelOutboundAdapter["sendMedia"]>>(async () => ({
    channel: "slack",
    messageId: "claimed-media-delivered",
  }));
  api.registerChannel({
    plugin: {
      ...createChannelTestPluginBase({
        id: "slack",
        label: "Slack",
        config: { listAccountIds: () => [], resolveAccount: () => ({}) },
      }),
      outbound: { deliveryMode: "direct", sendText, sendMedia },
    },
  });
  return {
    registry: builder.registry,
    hookRunner: createHookRunner(builder.registry),
    handler,
    sendText,
    sendMedia,
  };
}
