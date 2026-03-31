import {
  buildTokenChannelStatusSummary,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
  createDependentCredentialStatusIssueCollector,
} from "openclaw/plugin-sdk/status-helpers";
import { DEFAULT_ACCOUNT_ID, type ChannelPlugin, type ResolvedLineAccount } from "../api.js";
import { hasLineCredentials } from "./account-helpers.js";
import { probeLineBot } from "./probe.js";

const collectLineStatusIssues = createDependentCredentialStatusIssueCollector({
  channel: "line",
  dependencySourceKey: "tokenSource",
  missingPrimaryMessage: "LINE channel access token not configured",
  missingDependentMessage: "LINE channel secret not configured",
});

export const lineStatusAdapter: NonNullable<ChannelPlugin<ResolvedLineAccount>["status"]> =
  createComputedAccountStatusAdapter<ResolvedLineAccount>({
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: collectLineStatusIssues,
    buildChannelSummary: ({ snapshot }) => buildTokenChannelStatusSummary(snapshot),
    probeAccount: async ({ account, timeoutMs }) =>
      await probeLineBot(account.channelAccessToken, timeoutMs),
    resolveAccountSnapshot: ({ account }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: hasLineCredentials(account),
      extra: {
        tokenSource: account.tokenSource,
        mode: "webhook",
      },
    }),
  });
