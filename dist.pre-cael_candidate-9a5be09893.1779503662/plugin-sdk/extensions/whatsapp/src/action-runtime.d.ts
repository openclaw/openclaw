import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAuthorizedWhatsAppOutboundTarget } from "./action-runtime-target-auth.js";
import { sendReactionWhatsApp } from "./send.js";
export declare const whatsAppActionRuntime: {
    resolveAuthorizedWhatsAppOutboundTarget: typeof resolveAuthorizedWhatsAppOutboundTarget;
    sendReactionWhatsApp: typeof sendReactionWhatsApp;
};
export declare function handleWhatsAppAction(params: Record<string, unknown>, cfg: OpenClawConfig): Promise<AgentToolResult<unknown>>;
