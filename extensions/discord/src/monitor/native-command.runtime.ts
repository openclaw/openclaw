import { dispatchChannelInboundTurn } from "openclaw/plugin-sdk/channel-inbound";
// Discord plugin module implements native command behavior.
import { resolveDirectStatusReplyForSession } from "openclaw/plugin-sdk/command-status-runtime";
import { ensureConfiguredBindingRouteReady } from "openclaw/plugin-sdk/conversation-binding-runtime";
import { getSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveDiscordNativeInteractionRouteState } from "./native-command-route.js";

export const nativeCommandRuntime = {
  dispatchChannelInboundTurn,
  ensureConfiguredBindingRouteReady,
  resolveDirectStatusReplyForSession,
  resolveDiscordNativeInteractionRouteState,
  getSessionEntry,
};
