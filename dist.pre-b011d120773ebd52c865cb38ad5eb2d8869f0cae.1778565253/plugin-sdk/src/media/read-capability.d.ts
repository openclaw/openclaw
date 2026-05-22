import type { OpenClawConfig } from "../config/types.js";
import type { OutboundMediaAccess, OutboundMediaReadFile } from "./load-options.js";
type OutboundHostMediaPolicyContext = {
    sessionKey?: string;
    messageProvider?: string;
    groupId?: string | null;
    groupChannel?: string | null;
    groupSpace?: string | null;
    accountId?: string | null;
    requesterSenderId?: string | null;
    requesterSenderName?: string | null;
    requesterSenderUsername?: string | null;
    requesterSenderE164?: string | null;
};
export declare function createAgentScopedHostMediaReadFile(params: {
    cfg: OpenClawConfig;
    agentId?: string;
    workspaceDir?: string;
} & OutboundHostMediaPolicyContext): OutboundMediaReadFile | undefined;
export declare function resolveAgentScopedOutboundMediaAccess(params: {
    cfg: OpenClawConfig;
    agentId?: string;
    mediaSources?: readonly string[];
    workspaceDir?: string;
    mediaAccess?: OutboundMediaAccess;
    mediaReadFile?: OutboundMediaReadFile;
} & OutboundHostMediaPolicyContext): OutboundMediaAccess;
export {};
