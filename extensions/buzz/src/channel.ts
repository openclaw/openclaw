import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  buildChannelOutboundSessionRoute,
  buildThreadAwareOutboundSessionRoute,
  createChatChannelPlugin,
} from "openclaw/plugin-sdk/channel-core";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import {
  createChannelDirectoryAdapter,
  type DirectoryConfigParams,
} from "openclaw/plugin-sdk/directory-runtime";
import { parseThreadSessionSuffix } from "openclaw/plugin-sdk/routing";
import {
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { buzzSetupPlugin } from "./channel.setup.js";
import {
  listBuzzDirectoryGroupsFromConfig,
  listBuzzDirectoryPeersFromConfig,
} from "./directory-config.js";
import { queryBuzzDirectoryProfiles, queryBuzzDirectoryRooms } from "./directory-relay.js";
import { BuzzDirectoryState } from "./directory-state.js";
import {
  buzzOutboundAdapter,
  getActiveBuzzBus,
  sendBuzzTyping,
  startBuzzGatewayAccount,
} from "./gateway.js";
import { connectAuthenticatedBuzzRelaySession, parseBuzzAuthTag } from "./relay-auth.js";
import { discoverBuzzRooms } from "./room-discovery.js";
import { queryBuzzRoomMemberships } from "./room-membership-query.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import {
  buildBuzzTarget,
  looksLikeBuzzTarget,
  normalizeBuzzTarget,
  parseBuzzTarget,
} from "./target.js";
import {
  assertBuzzAccountAvailable,
  decodeBuzzPrivateKey,
  resolveBuzzAccount,
  resolveBuzzAccountConfig,
  type ResolvedBuzzAccount,
} from "./types.js";

const DIRECTORY_LIVE_TIMEOUT_MS = 10_000;

async function loadBuzzDirectoryState(
  params: DirectoryConfigParams,
  refreshRooms: boolean,
): Promise<BuzzDirectoryState | null> {
  const account = resolveBuzzAccount(params);
  if (account.enabled) {
    assertBuzzAccountAvailable(account);
  }
  if (!account.publicKey) {
    return null;
  }
  const channelIds = Object.entries(account.config.groups ?? {})
    .filter(([, config]) => config.enabled !== false)
    .map(([roomId]) => parseBuzzTarget(roomId));
  const state = new BuzzDirectoryState({
    publicKey: account.publicKey,
    fallbackProfileName: account.name ?? "OpenClaw",
    channelIds,
  });
  if (!account.enabled || !account.configured || channelIds.length === 0) {
    return state;
  }
  const activeBus = getActiveBuzzBus(account.accountId);
  if (activeBus) {
    if (refreshRooms) {
      try {
        await activeBus.refreshDirectory();
      } catch {
        // A stalled metadata refresh recycles the relay session. Directory
        // reads can still return the last complete in-memory snapshot.
      }
    }
    return activeBus.directory;
  }

  const timeoutSignal = AbortSignal.timeout(DIRECTORY_LIVE_TIMEOUT_MS);
  const { relay, relayPublicKey } = await connectAuthenticatedBuzzRelaySession({
    relayUrl: account.relayUrl,
    secretKey: decodeBuzzPrivateKey(account.privateKey),
    authTag: parseBuzzAuthTag(account.authTag),
    signal: timeoutSignal,
  });
  try {
    await queryBuzzDirectoryRooms({
      relay,
      relayPublicKey,
      state,
      channelIds,
      signal: timeoutSignal,
    });
    const activeChannelIds = state.activeRoomIds();
    state.replaceMemberships(
      activeChannelIds.length > 0
        ? await queryBuzzRoomMemberships({
            relay,
            relayPublicKey,
            channelIds: activeChannelIds,
            signal: timeoutSignal,
          })
        : new Map(),
    );
    await queryBuzzDirectoryProfiles({
      relay,
      state,
      publicKeys: state.profilePublicKeys(),
      signal: timeoutSignal,
    });
    return state;
  } finally {
    relay.close();
  }
}

const buzzMessageAdapter = createChannelMessageAdapterFromOutbound({
  id: "buzz",
  outbound: buzzOutboundAdapter,
});

type BuzzProbeResult = {
  ok: true;
  publicKey: string;
  roomCount: number;
  rooms: Array<{ id: string; name: string }>;
};

export const buzzPlugin = createChatChannelPlugin<ResolvedBuzzAccount, BuzzProbeResult, unknown, 2>(
  {
    base: {
      ...buzzSetupPlugin,
      threading: {
        resolveReplyTransport: ({ replyDelivery, threadId, replyToId, replyToIsExplicit }) => {
          if (replyDelivery?.replyToMode === "off") {
            return { threadId: null, replyToId: null };
          }
          // Implicit replies belong to the root; explicit child targets keep their nesting.
          return threadId && replyToId && !replyToIsExplicit
            ? { threadId, replyToId: String(threadId) }
            : null;
        },
      },
      agentPrompt: {
        messageToolHints: () => [
          "- Buzz targets: use a configured room UUID, `buzz:<ROOM_UUID>`, or a unique current room name. Use the UUID when room names are ambiguous.",
          "- Buzz mentions: write a unique current room member as `@Display Name`. For an explicit identity, include `nostr:npub...`; the public key must belong to the target room. Any unresolved or ambiguous label needs an explicit identity for every intended member.",
        ],
      },
      config: {
        ...buzzSetupPlugin.config,
        describeAccount: (account) =>
          describeAccountSnapshot({
            account,
            configured: account.configured,
            extra: {
              baseUrl: account.relayUrl,
              publicKey: account.publicKey,
              tokenStatus: account.tokenStatus,
            },
          }),
        resolveAllowFrom: ({ cfg, accountId }) =>
          resolveBuzzAccount({ cfg, accountId }).config.groupAllowFrom,
        resolveDefaultTo: ({ cfg, accountId }) =>
          resolveBuzzAccount({ cfg, accountId }).config.defaultTo,
      },
      secrets: {
        secretTargetRegistryEntries,
        collectRuntimeConfigAssignments,
      },
      messaging: {
        targetPrefixes: ["buzz"],
        normalizeTarget: normalizeBuzzTarget,
        inferTargetChatType: () => "group",
        targetResolver: {
          looksLikeId: looksLikeBuzzTarget,
          hint: "<room UUID|configured room name>",
        },
        resolveOutboundSessionRoute: ({
          cfg,
          agentId,
          accountId,
          target,
          replyToId,
          threadId,
          currentSessionKey,
        }) => {
          const normalized = buildBuzzTarget(parseBuzzTarget(target));
          const baseRoute = buildChannelOutboundSessionRoute({
            cfg,
            agentId,
            channel: "buzz",
            accountId,
            recipientSessionExact: true,
            peer: { kind: "group", id: normalized },
            chatType: "group",
            from: `buzz:${accountId ?? "default"}`,
            to: normalized,
          });
          return buildThreadAwareOutboundSessionRoute({
            route: baseRoute,
            replyToId,
            threadId,
            currentSessionKey,
            canRecoverCurrentThread: () => true,
          });
        },
        resolveSessionConversation: ({ rawId }) => {
          const { baseSessionKey, threadId } = parseThreadSessionSuffix(rawId);
          const channelId = parseBuzzTarget(baseSessionKey ?? rawId);
          return {
            id: channelId,
            threadId,
            baseConversationId: channelId,
            parentConversationCandidates: [channelId],
          };
        },
      },
      status: {
        ...createComputedAccountStatusAdapter<ResolvedBuzzAccount>({
          defaultRuntime: createDefaultChannelRuntimeState("default"),
          buildChannelSummary: ({ snapshot }) => ({
            ok: snapshot.configured,
            label: snapshot.configured ? "configured" : "missing config",
            detail: snapshot.baseUrl ?? "",
          }),
          resolveAccountSnapshot: ({ account }) => ({
            accountId: account.accountId,
            name: account.name,
            enabled: account.enabled,
            configured: account.configured,
            extra: {
              baseUrl: account.relayUrl,
              publicKey: account.publicKey,
              tokenStatus: account.tokenStatus,
            },
          }),
        }),
        probeAccount: async ({ account, timeoutMs }) => {
          assertBuzzAccountAvailable(account);
          const rooms = await discoverBuzzRooms({
            relayUrl: account.relayUrl,
            privateKey: account.privateKey,
            authTag: account.authTag,
            timeoutMs,
          });
          return {
            ok: true,
            publicKey: account.publicKey,
            roomCount: rooms.length,
            rooms: rooms.map((room) => ({ id: room.id, name: room.name })),
          };
        },
      },
      gateway: {
        apiVersion: 2,
        startAccount: startBuzzGatewayAccount,
      },
      heartbeat: {
        sendTyping: sendBuzzTyping,
      },
      directory: createChannelDirectoryAdapter({
        self: async (params) => (await loadBuzzDirectoryState(params, false))?.self() ?? null,
        listPeers: listBuzzDirectoryPeersFromConfig,
        listPeersLive: async (params) =>
          (await loadBuzzDirectoryState(params, false))?.listPeers(params) ?? [],
        listGroups: listBuzzDirectoryGroupsFromConfig,
        listGroupsLive: async (params) => {
          if (!resolveBuzzAccountConfig(params).config.enabled) {
            return listBuzzDirectoryGroupsFromConfig(params);
          }
          return (await loadBuzzDirectoryState(params, true))?.listGroups(params) ?? [];
        },
        listGroupMembers: async (params) =>
          (await loadBuzzDirectoryState(params, false))?.listGroupMembers(params) ?? [],
      }),
      message: buzzMessageAdapter,
    },
    outbound: buzzOutboundAdapter,
  },
);
