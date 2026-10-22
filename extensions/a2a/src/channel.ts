import type { ChannelStatusIssue } from "openclaw/plugin-sdk/channel-contract";
import {
  buildChannelOutboundSessionRoute,
  createChatChannelPlugin,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
  waitUntilAbort,
} from "openclaw/plugin-sdk/channel-outbound";
import { channelReadyPatch, channelStoppedPatch } from "openclaw/plugin-sdk/gateway-runtime";
import {
  isHostNoticePayload,
  isReplyPayloadTerminalContent,
} from "openclaw/plugin-sdk/reply-payload";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
  readAccountStatusSnapshot,
  resolveEnabledConfiguredAccountId,
} from "openclaw/plugin-sdk/status-helpers";
import { filterStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { registerPluginHttpRoute } from "openclaw/plugin-sdk/webhook-ingress";
import { DEFAULT_ACCOUNT_ID } from "./accounts.js";
import {
  A2A_AGENT_CARD_PATHS,
  A2A_EXTENDED_CARD_PATH,
  A2A_JSONRPC_PATH,
  A2A_REST_PATH,
  type A2aResolvedCapabilities,
} from "./agent-card.js";
import { A2A_CHANNEL_ID, a2aChannelSetupPlugin } from "./channel-base.js";
import { createA2aHttpHandler } from "./http-routes.js";
import { sendA2aChannelText } from "./outbound.js";
import { A2aPushConfigStore } from "./push-config-store.js";
import { A2aPushSender } from "./push-sender.js";
import { getA2aChannelRuntime } from "./runtime.js";
import { A2aTaskStore } from "./task-store.js";
import type { A2aChannelConfig, ResolvedA2aChannelAccount } from "./types.js";

const A2A_ACCOUNT_STATUS_FIELDS = ["unresolvedPeers", "unresolvedOutboundPeers"] as const;

function normalizeA2aChannelTarget(raw: string): string | undefined {
  const target = raw.trim().replace(/^a2a:/i, "");
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(target) ? target : undefined;
}

/**
 * Resolve the capabilities advertised in the Agent Card and enforced on the
 * gated methods (spec §3.3.4).
 *
 * Streaming is core and on by default. Push notifications and the extended card
 * are opt-in: push makes the Gateway emit POSTs to a URL chosen by the remote
 * peer, and the extended card publishes operator-authored text.
 */
function resolveCapabilities(config: A2aChannelConfig): A2aResolvedCapabilities {
  const configured = config.capabilities ?? {};
  return {
    streaming: configured.streaming !== false,
    pushNotifications: configured.pushNotifications === true,
    extendedAgentCard: configured.extendedAgentCard === true,
  };
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
      startAccount: async (ctx) => {
        const { account } = ctx;
        const config = ctx.cfg;
        if (!account.configured) {
          throw new Error(`A2A channel is not configured for account "${account.accountId}"`);
        }

        ctx.setStatus({
          accountId: account.accountId,
          running: true,
          lifecycle: "starting",
          configured: true,
          enabled: account.enabled,
        });

        const runtime = getA2aChannelRuntime();
        const a2aConfig = account.config;
        const version = runtime.version;
        const capabilities = resolveCapabilities(a2aConfig);
        // Card content is derived from the config loaded at account start, so
        // the start instant is the honest "last modified" for card validators
        // (§8.6.1): a reload restarts the account and with it the timestamp.
        const cardModifiedAt = new Date();
        // SAFETY: Gateway injects its full runtime despite the narrowed public contract.
        const channelRuntime = (ctx.channelRuntime ?? runtime.channel) as PluginRuntime["channel"];
        const store = new A2aTaskStore();
        const pushConfigs = new A2aPushConfigStore();
        const pushSender = capabilities.pushNotifications
          ? new A2aPushSender({ settings: a2aConfig.pushNotifications })
          : null;
        // Fan every task event out to the webhooks registered by that task's peer.
        const stopPushObserver = pushSender
          ? store.onEvent(({ task, event, ownerPeer }) => {
              if (!ownerPeer) {
                return;
              }
              // Configs are resolved at delivery time, not capture time: a
              // registration deleted between the event and the webhook attempt
              // must not still receive it.
              pushSender.notify({
                task,
                resolveConfigs: () => pushConfigs.forTask(ownerPeer, task.id),
                event,
              });
            })
          : () => undefined;
        // Push registrations expire with their task: retention pruning evicts
        // terminal tasks, and their webhooks must not outlive them.
        const stopEvictionObserver = store.onTaskEvicted(({ taskId, ownerPeer }) => {
          if (ownerPeer !== undefined) {
            pushConfigs.deleteForTask(ownerPeer, taskId);
          }
        });
        const unregisterRoutes: Array<() => void> = [];

        const handler = createA2aHttpHandler({
          account,
          config,
          a2aConfig,
          channelRuntime,
          store,
          pushConfigs,
          capabilities,
          version,
          cardModifiedAt,
        });

        try {
          for (const routePath of [
            ...A2A_AGENT_CARD_PATHS,
            A2A_JSONRPC_PATH,
            A2A_EXTENDED_CARD_PATH,
          ]) {
            unregisterRoutes.push(
              // A2A owns fixed global paths on a single account, so a duplicate
              // registration means a stale or conflicting owner. Fail loudly instead
              // of replacing a live handler (GHSA-RQP8-Q22P-5J9Q).
              registerPluginHttpRoute({
                path: routePath,
                auth: "plugin",
                match: "exact",
                pluginId: "a2a",
                source: "a2a-gateway",
                accountId: account.accountId,
                throwOnFailure: true,
                handler,
              }),
            );
          }
          if (a2aConfig.rest?.enabled === true) {
            unregisterRoutes.push(
              registerPluginHttpRoute({
                path: A2A_REST_PATH,
                auth: "plugin",
                match: "prefix",
                pluginId: "a2a",
                source: "a2a-gateway-rest",
                accountId: account.accountId,
                throwOnFailure: true,
                handler,
              }),
            );
          }

          ctx.setStatus(channelReadyPatch({ accountId: account.accountId }));
          await waitUntilAbort(ctx.abortSignal);
        } finally {
          // Stop admission before releasing blocked responses; otherwise shutdown can
          // admit a task after its lifecycle-owned waiters and timers were cleared.
          for (const unregister of unregisterRoutes.toReversed()) {
            unregister();
          }
          stopPushObserver();
          stopEvictionObserver();
          pushSender?.reset();
          pushConfigs.clear();
          store.stop();
          ctx.setStatus(channelStoppedPatch({ accountId: account.accountId }));
        }
      },
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
