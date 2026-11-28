import type { ChannelMessagingAdapter } from "openclaw/plugin-sdk/core";
import { resolveMSTeamsDirectTarget } from "./approval-auth.js";
import { looksLikeMSTeamsTargetId, normalizeMSTeamsMessagingTarget } from "./resolve-allowlist.js";
import { inferMSTeamsTargetChatType, resolveMSTeamsOutboundSessionRoute } from "./session-route.js";

/** Microsoft Teams target grammar, direct-message mapping, and outbound session routing. */
export const msteamsMessagingAdapter: ChannelMessagingAdapter = {
  targetPrefixes: ["msteams", "teams"],
  directTargetStyle: "user-prefixed",
  normalizeTarget: normalizeMSTeamsMessagingTarget,
  resolveDirectTarget: resolveMSTeamsDirectTarget,
  inferTargetChatType: ({ to }) => inferMSTeamsTargetChatType(to),
  resolveOutboundSessionRoute: resolveMSTeamsOutboundSessionRoute,
  targetResolver: {
    looksLikeId: looksLikeMSTeamsTargetId,
    hint: "<conversationId|user:ID|conversation:ID>",
  },
};
