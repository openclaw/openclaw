import { type RequestClient } from "@buape/carbon";
import { type DiscordComponentMessageSpec } from "./components.js";
import type { DiscordSendResult } from "./send.types.js";
type DiscordComponentSendOpts = {
    accountId?: string;
    token?: string;
    rest?: RequestClient;
    silent?: boolean;
    replyTo?: string;
    sessionKey?: string;
    agentId?: string;
    mediaUrl?: string;
    mediaLocalRoots?: readonly string[];
    filename?: string;
};
export declare function sendDiscordComponentMessage(to: string, spec: DiscordComponentMessageSpec, opts?: DiscordComponentSendOpts): Promise<DiscordSendResult>;
export {};
