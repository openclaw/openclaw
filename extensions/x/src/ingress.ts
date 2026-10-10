import type {
  ChannelIngressContextBinding,
  ResolveStableChannelMessageIngressParams,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveXAccount } from "./accounts.js";
import { normalizeXUserId, openXAllowlist } from "./allowlist.js";
import type { XPost } from "./api.js";
import { resolveXGuestSettings, resolveXSenderTier } from "./guest-policy.js";
import { getXRuntime } from "./runtime.js";

export const xMentionFacts = { canDetectMention: true, wasMentioned: true };

export async function resolveXIngress(
  accountId: string,
  post: XPost,
  cfg: OpenClawConfig,
  contextBinding?: ChannelIngressContextBinding,
  childSessionPublication?: ResolveStableChannelMessageIngressParams["childSessionPublication"],
) {
  const core = getXRuntime();
  const account = resolveXAccount(cfg, accountId);
  const snapshot = await openXAllowlist(core).readSnapshot(
    accountId,
    account.config.verifiedFromGitHub,
  );
  // 2026.9.8 only invokes readStoreAllowFrom for DMs. This admin-owned store
  // supplies raw group entries; the host still owns all matching and policy.
  const groupAllowFrom = [...(account.config.allowFrom ?? []), ...snapshot.allowFrom];
  const tier = resolveXSenderTier(account, post.author_id);
  const guestsEnabled = resolveXGuestSettings(account).enabled;
  const ingress = await core.channel.inbound.ingress.resolveStable({
    channelId: "x",
    accountId,
    cfg,
    identity: {
      key: "x-user-id",
      normalize: (value) => normalizeXUserId(value) ?? "",
      sensitivity: "pii",
      entryIdPrefix: "x-entry",
    },
    subject: { stableId: post.author_id },
    conversation: { kind: "group", id: post.conversation_id },
    contextBinding,
    childSessionPublication,
    event: { kind: "message", authMode: "inbound", mayPair: false },
    dmPolicy: "disabled",
    groupPolicy:
      account.config.groupPolicy === "disabled" ? "disabled" : guestsEnabled ? "open" : "allowlist",
    allowFrom: account.config.allowFrom ?? [],
    groupAllowFrom,
    mentionFacts: xMentionFacts,
    policy: {
      groupAllowFromFallbackToAllowFrom: true,
      activation: { requireMention: true, allowTextCommands: false },
    },
  });
  const assertCurrent = () => {
    snapshot.assertCurrent();
    if (getXRuntime() !== core) {
      throw new Error("X runtime changed during authorization");
    }
  };
  assertCurrent();
  const githubEntry = snapshot.github?.entries.find((entry) => entry.xUserId === post.author_id);
  return {
    ingress,
    assertCurrent,
    tier,
    github:
      githubEntry && snapshot.github
        ? { repo: snapshot.github.repo, entry: githubEntry }
        : undefined,
  };
}
