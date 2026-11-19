import { resolveExpiresAtMsFromDurationMs } from "openclaw/plugin-sdk/number-runtime";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";

const TOKEN_TTL_MS = 15 * 60_000;
// Keep callback retention separate from the message replay budget and its 24h window.
export const cardActionReplayGuard = createChannelReplayGuard<string>({
  dedupe: {
    pluginId: "feishu",
    namespacePrefix: "feishu.card-actions",
    ttlMs: TOKEN_TTL_MS,
    memoryMaxSize: 1_000,
    stateMaxEntries: 10_000,
  },
  buildReplayKey: (token) =>
    resolveExpiresAtMsFromDurationMs(TOKEN_TTL_MS) === undefined ? undefined : token,
});

export const resolvedCardActionChatTypes = new Map<
  string,
  { value: "p2p" | "group"; expiresAt: number }
>();
