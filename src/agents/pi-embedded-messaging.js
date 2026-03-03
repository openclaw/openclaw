import { getChannelPlugin, normalizeChannelId } from "../channels/plugins/index.js";
const CORE_MESSAGING_TOOLS = new Set(["sessions_send", "message"]);
// Provider docking: any plugin with `actions` opts into messaging tool handling.
export function isMessagingTool(toolName) {
    if (CORE_MESSAGING_TOOLS.has(toolName)) {
        return true;
    }
    const providerId = normalizeChannelId(toolName);
    return Boolean(providerId && getChannelPlugin(providerId)?.actions);
}
export function isMessagingToolSendAction(toolName, args) {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (toolName === "sessions_send") {
        return true;
    }
    if (toolName === "message") {
        return action === "send" || action === "thread-reply";
    }
    const providerId = normalizeChannelId(toolName);
    if (!providerId) {
        return false;
    }
    const plugin = getChannelPlugin(providerId);
    if (!plugin?.actions?.extractToolSend) {
        return false;
    }
    return Boolean(plugin.actions.extractToolSend({ args })?.to);
}
