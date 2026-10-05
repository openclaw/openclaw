import type { ChannelIngressContextBinding } from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveXAccount } from "./accounts.js";
import { normalizeXUserId, openXAllowlist } from "./allowlist.js";
import type { XPost } from "./api.js";
import { getXRuntime } from "./runtime.js";

export const xMentionFacts = { canDetectMention: true, wasMentioned: true };

export async function resolveXIngress(
  accountId: string,
  post: XPost,
  cfg: OpenClawConfig,
  contextBinding?: ChannelIngressContextBinding,
) {
  const core = getXRuntime();
  const account = resolveXAccount(cfg, accountId);
  const snapshot = await openXAllowlist(core).readSnapshot(accountId);
  // 2026.9.8 only invokes readStoreAllowFrom for DMs. This admin-owned store
  // supplies raw group entries; the host still owns all matching and policy.
  const groupAllowFrom = [...(account.config.allowFrom ?? []), ...snapshot.allowFrom];
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
    event: { kind: "message", authMode: "inbound", mayPair: false },
    dmPolicy: "disabled",
    groupPolicy: account.config.groupPolicy ?? "allowlist",
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
  return { ingress, assertCurrent };
}
