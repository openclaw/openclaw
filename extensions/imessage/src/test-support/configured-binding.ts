import type { ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createTestRegistry,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import {
  matchIMessageAcpConversation,
  normalizeIMessageAcpConversationId,
} from "../conversation-id.js";

export function installIMessageConfiguredBindingRegistryForTest(): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: "imessage",
        source: "test",
        plugin: {
          id: "imessage",
          bindings: {
            compileConfiguredBinding: ({ conversationId }) =>
              normalizeIMessageAcpConversationId(conversationId),
            matchInboundConversation: ({ compiledBinding, conversationId }) =>
              matchIMessageAcpConversation({
                bindingConversationId: compiledBinding.conversationId,
                conversationId,
              }),
          } satisfies NonNullable<ChannelPlugin["bindings"]>,
        },
      },
    ]),
  );
}
