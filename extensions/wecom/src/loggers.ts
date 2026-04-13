import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";

export const wecomLog = createSubsystemLogger("gateway/channels/wecom");
export const wecomMcpLog = wecomLog.child("mcp");
export const wecomUploadLog = wecomLog.child("upload");
export const wecomWebhookLog = wecomLog.child("webhook");
export const wecomOutboundLog = wecomLog.child("outbound");
