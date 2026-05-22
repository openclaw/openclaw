import type { OpenClawConfig } from "../config/types.js";
import type { GroupToolPolicyConfig } from "../config/types.tools.js";
type BlueBubblesGroupContext = {
    cfg: OpenClawConfig;
    accountId?: string | null;
    groupId?: string | null;
    senderId?: string | null;
    senderName?: string | null;
    senderUsername?: string | null;
    senderE164?: string | null;
};
type FacadeModule = {
    isAllowedBlueBubblesSender: (params: {
        allowFrom: Array<string | number>;
        sender: string;
        chatId?: number | null;
        chatGuid?: string | null;
        chatIdentifier?: string | null;
    }) => boolean;
    resolveBlueBubblesGroupRequireMention: (params: BlueBubblesGroupContext) => boolean;
    resolveBlueBubblesGroupToolPolicy: (params: BlueBubblesGroupContext) => GroupToolPolicyConfig | undefined;
};
export declare const isAllowedBlueBubblesSender: FacadeModule["isAllowedBlueBubblesSender"];
export declare const resolveBlueBubblesGroupRequireMention: FacadeModule["resolveBlueBubblesGroupRequireMention"];
export declare const resolveBlueBubblesGroupToolPolicy: FacadeModule["resolveBlueBubblesGroupToolPolicy"];
export {};
