import type { ChannelStatusIssue } from "openclaw/plugin-sdk/channel-contract";
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  isHostNoticePayload,
  isReplyPayloadTerminalContent,
} from "openclaw/plugin-sdk/reply-payload";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
  readAccountStatusSnapshot,
  resolveEnabledConfiguredAccountId,
} from "openclaw/plugin-sdk/status-helpers";
import { filterStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import { A2A_CHANNEL_ID, a2aChannelSetupPlugin } from "./channel-base.js";
import { startA2aGatewayAccount } from "./gateway.js";
import { sendA2aChannelText } from "./outbound.js";
import type { ResolvedA2aChannelAccount } from "./types.js";

const A2A_ACCOUNT_STATUS_FIELDS = ["unresolvedPeers", "unresolvedOutboundPeers"] as const;

function normalizeA2aChannelTarget(raw: string): string | undefined {
  const target = raw.trim().replace(/^a2a:/i, "");
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(target) ? target : undefined;
}

const a2aChannelMessageAdapter = defineChannelMessageAdapter({
  id: A2A_CHANNEL_ID,
  durableFinal: { capabilities: { text: true } },
  send: {
    text: async (ctx) => {
      const result = await sendA2aChannelText({
        cfg: ctx.cfg,
        accountId: ctx.accountId,
        to: ctx.to,
        text: ctx.text,
        assertDirectAdapterHandoff: ctx.assertDirectAdapterHandoff,
      });
      return {
        messageId: result.messageId,
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: A2A_CHANNEL_ID, messageId: result.messageId }],
          kind: "text",
        }),
      };
    },
  },
});

export const a2aChannelPlugin: ChannelPlugin<ResolvedA2aChannelAccount> = createChatChannelPlugin({
  base: {
    ...a2aChannelSetupPlugin,
    messaging: {
      transformReplyPayload: ({ payload }) =>
        isHostNoticePayload(payload) || !isReplyPayloadTerminalContent(payload) ? null : payload,
      normalizeTarget: normalizeA2aChannelTarget,
      inferTargetChatType: () => "direct",
      targetResolver: {
        looksLikeId: (raw) => normalizeA2aChannelTarget(raw) !== undefined,
        hint: "<a2a-peer-name>",
      },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
        const peerName = normalizeA2aChannelTarget(target);
        if (!peerName) {
          return null;
        }
        return buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: A2A_CHANNEL_ID,
          accountId,
          recipientSessionExact: true,
          peer: { kind: "direct", id: peerName },
          chatType: "direct",
          from: `${A2A_CHANNEL_ID}:${accountId ?? DEFAULT_ACCOUNT_ID}`,
          to: peerName,
        });
      },
    },
    status: createComputedAccountStatusAdapter<ResolvedA2aChannelAccount>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      /**
       * Surfaces peers that config loading left unusable because a `${VAR}` credential
       * reference did not resolve. Without this the only signal is one startup log line,
       * while the remote peer just sees a bare 401 or a refused send.
       */
      collectStatusIssues: (accounts) => {
        const issues: ChannelStatusIssue[] = [];
        for (const entry of accounts) {
          const account = readAccountStatusSnapshot(entry, A2A_ACCOUNT_STATUS_FIELDS);
          if (!account) {
            continue;
          }
          // A fully withheld channel reports configured=false, so only enabled accounts are skipped here.
          const accountId = resolveEnabledConfiguredAccountId(account) ?? account.accountId;
          if (account.enabled === false || typeof accountId !== "string" || !accountId) {
            continue;
          }
          const inbound = filterStringEntries(account.unresolvedPeers).filter(Boolean);
          if (inbound.length > 0) {
            issues.push({
              channel: "a2a",
              accountId,
              kind: "config",
              message: `A2A peer${inbound.length === 1 ? "" : "s"} ${inbound.join(", ")} cannot authenticate: the inbound token reference did not resolve, so requests from ${inbound.length === 1 ? "it are" : "them are"} rejected with 401.`,
              fix: `Set the environment variable referenced by channels.a2a.peers.<name>.token for ${inbound.join(", ")}, then reload or restart the gateway.`,
            });
          }
          const outbound = filterStringEntries(account.unresolvedOutboundPeers).filter(Boolean);
          if (outbound.length > 0) {
            issues.push({
              channel: "a2a",
              accountId,
              kind: "config",
              message: `Sends to A2A peer${outbound.length === 1 ? "" : "s"} ${outbound.join(", ")} are refused: the outbound token reference did not resolve.`,
              fix: `Set the environment variable referenced by channels.a2a.peers.<name>.outboundToken for ${outbound.join(", ")}, then reload or restart the gateway.`,
            });
          }
        }
        return issues;
      },
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
          ...(account.unresolvedPeers.length > 0
            ? { unresolvedPeers: account.unresolvedPeers }
            : {}),
          ...(account.unresolvedOutboundPeers.length > 0
            ? { unresolvedOutboundPeers: account.unresolvedOutboundPeers }
            : {}),
        },
      }),
    }),
    gateway: {
      startAccount: startA2aGatewayAccount,
    },
    message: a2aChannelMessageAdapter,
  },
  outbound: {
    base: { deliveryMode: "direct" },
    attachedResults: {
      channel: A2A_CHANNEL_ID,
      sendText: sendA2aChannelText,
    },
  },
});
