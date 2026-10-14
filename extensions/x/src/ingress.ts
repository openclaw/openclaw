import type {
  ChannelIngressContextBinding,
  ResolveStableChannelMessageIngressParams,
} from "openclaw/plugin-sdk/channel-ingress-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { resolveXAccount } from "./accounts.js";
import { normalizeXUserId, openXAllowlist, XAllowlistChangedError } from "./allowlist.js";
import type { XPost } from "./api.js";
import { resolveXGuestSettings, resolveXSenderTier } from "./guest-policy.js";
import { getXRuntime } from "./runtime.js";

export const xMentionFacts = { canDetectMention: true, wasMentioned: true };

/** Renew only the source permission, never the admitted run or its selected route. */
export function createXPublicationPreparation(params: {
  accountId: string;
  post: XPost;
  cfg: OpenClawConfig;
  readConfig: () => OpenClawConfig;
  route: { agentId: string; sessionKey: string };
  assertActive: () => void;
}): () => Promise<(() => void) | null> {
  return async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        params.assertActive();
      } catch {
        return null;
      }
      const cfg = params.readConfig();
      // Never apply a new routing configuration to a prompt prepared under the old one.
      if (cfg !== params.cfg) {
        return null;
      }
      const route = resolveAgentRoute({
        cfg,
        channel: "x",
        accountId: params.accountId,
        peer: { kind: "group", id: params.post.conversation_id },
      });
      // The pending prompt and tool policy were built for this exact configuration.
      // A different route/tier requires a new turn, not transplanting this run's authority.
      if (
        route.agentId !== params.route.agentId ||
        route.sessionKey !== params.route.sessionKey ||
        resolveXAccount(cfg, params.accountId).config.autoPublishWorkSessions !== true
      ) {
        return null;
      }
      try {
        const authorization = await resolveXIngress(params.accountId, params.post, cfg);
        try {
          params.assertActive();
        } catch {
          return null;
        }
        if (params.readConfig() !== cfg) {
          return null;
        }
        const assertCurrent = () => {
          params.assertActive();
          authorization.assertCurrent();
          if (params.readConfig() !== cfg) {
            throw new Error("X work-session publication policy changed; send a new mention.");
          }
        };
        assertCurrent();
        if (!authorization.ingress.senderAccess.allowed || authorization.tier !== "maintainer") {
          return null;
        }
        return assertCurrent;
      } catch (error) {
        if (!(error instanceof XAllowlistChangedError)) {
          throw error;
        }
        if (attempt >= 2) {
          return null;
        }
      }
    }
  };
}

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
