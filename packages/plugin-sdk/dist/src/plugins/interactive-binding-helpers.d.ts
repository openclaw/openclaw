import { requestPluginConversationBinding } from "./conversation-binding.js";
import type { PluginConversationBindingRequestParams } from "./types.js";
type RegisteredInteractiveMetadata = {
    pluginId: string;
    pluginName?: string;
    pluginRoot?: string;
};
type PluginBindingConversation = Parameters<typeof requestPluginConversationBinding>[0]["conversation"];
export declare function createInteractiveConversationBindingHelpers(params: {
    registration: RegisteredInteractiveMetadata;
    senderId?: string;
    conversation: PluginBindingConversation;
}): {
    requestConversationBinding: (binding?: PluginConversationBindingRequestParams) => Promise<import("./conversation-binding.types.ts").PluginConversationBindingRequestResult>;
    detachConversationBinding: () => Promise<{
        removed: boolean;
    }>;
    getCurrentConversationBinding: () => Promise<import("./conversation-binding.types.ts").PluginConversationBinding | null>;
};
export {};
