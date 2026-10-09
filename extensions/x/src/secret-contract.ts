import {
  collectNestedChannelFieldAssignments,
  collectSimpleChannelFieldAssignments,
  createChannelSecretContract,
  isRecord,
} from "openclaw/plugin-sdk/channel-secret-basic-runtime";

const fields = ["clientSecret", "refreshToken", "bearerToken"] as const;
export const channelSecrets = createChannelSecretContract({
  channelKey: "x",
  account: [...fields, "verifiedFromGitHub.token"],
  channel: [...fields, "verifiedFromGitHub.token"],
  collect(params) {
    for (const field of fields) {
      collectSimpleChannelFieldAssignments({
        ...params,
        field,
        topInactiveReason: `no enabled X account inherits this top-level ${field}.`,
        accountInactiveReason: "X account is disabled.",
      });
    }
    const githubConfig = (config: Record<string, unknown>) =>
      isRecord(config.verifiedFromGitHub) ? config.verifiedFromGitHub : {};
    const base = githubConfig(params.channel);
    const hasRepo = (account: Record<string, unknown>) =>
      Boolean(githubConfig(account).repo ?? base.repo);
    collectNestedChannelFieldAssignments({
      ...params,
      nestedKey: "verifiedFromGitHub",
      field: "token",
      topLevelActive: params.surface.channelEnabled && Boolean(base.repo),
      topLevelInheritedAccountActive: ({ account, enabled }) =>
        enabled && hasRepo(account) && !Object.hasOwn(githubConfig(account), "token"),
      accountActive: ({ account, enabled }) => enabled && hasRepo(account),
      topInactiveReason:
        "no enabled X account with a GitHub repository inherits this verifiedFromGitHub token.",
      accountInactiveReason: "X account is disabled or verifiedFromGitHub.repo is unset.",
    });
  },
});

export const { secretTargetRegistryEntries, collectRuntimeConfigAssignments } = channelSecrets;
