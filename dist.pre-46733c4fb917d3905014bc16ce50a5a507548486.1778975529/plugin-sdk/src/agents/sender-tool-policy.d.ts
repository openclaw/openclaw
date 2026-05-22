import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
type SenderToolPolicyParams = {
    config?: OpenClawConfig;
    agentId?: string;
    messageProvider?: string | null;
    senderId?: string | null;
    senderName?: string | null;
    senderUsername?: string | null;
    senderE164?: string | null;
};
export declare function resolveSenderToolPolicy(params: SenderToolPolicyParams): SandboxToolPolicy | undefined;
export {};
