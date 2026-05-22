import { type OpenClawConfig } from "./channel-react-action.runtime.js";
type WhatsAppMessageActionParams = {
    action: string;
    params: Record<string, unknown>;
    cfg: OpenClawConfig;
    accountId?: string | null;
    requesterSenderId?: string | null;
    mediaAccess?: {
        localRoots?: readonly string[];
        readFile?: (filePath: string) => Promise<Buffer>;
    };
    mediaLocalRoots?: readonly string[];
    mediaReadFile?: (filePath: string) => Promise<Buffer>;
    toolContext?: {
        currentChannelId?: string | null;
        currentChannelProvider?: string | null;
        currentMessageId?: string | number | null;
    };
};
export declare function handleWhatsAppMessageAction(params: WhatsAppMessageActionParams): Promise<import("@earendil-works/pi-agent-core").AgentToolResult<unknown>>;
export declare const handleWhatsAppReactAction: typeof handleWhatsAppMessageAction;
export {};
