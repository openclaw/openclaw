import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import { collectA2aStatusIssues } from "./status-issues.js";
import type { ResolvedA2aChannelAccount } from "./types.js";

export const a2aChannelStatus = createComputedAccountStatusAdapter<ResolvedA2aChannelAccount>({
  defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
  collectStatusIssues: collectA2aStatusIssues,
  buildChannelSummary: ({ snapshot }) => ({
    configured: snapshot.configured ?? false,
    running: snapshot.running ?? false,
  }),
  resolveAccountSnapshot: ({ account }) => ({
    accountId: account.accountId,
    enabled: account.enabled,
    configured: account.configured,
    extra: {
      peerCount: Object.keys(account.config.peers ?? {}).length,
      // Names only: these peers stay unavailable until their token variable is set.
      ...(account.unresolvedPeers.length > 0 ? { unresolvedPeers: account.unresolvedPeers } : {}),
      ...(account.unresolvedOutboundPeers.length > 0
        ? { unresolvedOutboundPeers: account.unresolvedOutboundPeers }
        : {}),
    },
  }),
});
