import {
  createScopedDmSecurityResolver,
  createTopLevelChannelConfigAdapter,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { missingTargetError } from "openclaw/plugin-sdk/channel-feedback";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import {
  DEFAULT_ACCOUNT_ID,
  formatPairingApproveHint,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/channel-plugin-common";
import {
  buildChannelOutboundSessionRoute,
  stripChannelTargetPrefix,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/core";
import {
  buildPassiveChannelStatusSummary,
  buildTrafficStatusSummary,
} from "openclaw/plugin-sdk/extension-shared";
import {
  collectStatusIssuesFromLastError,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { nostrSetupPlugin } from "./channel.setup.js";
import type { NostrProfile } from "./config-schema.js";
import {
  getActiveNostrBuses,
  nostrOutboundAdapter,
  nostrPairingTextAdapter,
  startNostrGatewayAccount,
} from "./gateway.js";
import { normalizePubkey } from "./nostr-key-utils.js";
import type { ProfilePublishResult } from "./nostr-profile.js";
import { nostrSetupContract, nostrSetupWizard } from "./setup-surface.js";
import {
  listNostrAccountIds,
  resolveDefaultNostrAccountId,
  resolveNostrAccount,
  type ResolvedNostrAccount,
} from "./types.js";

const NOSTR_TARGET_HINT = "<npub|hex pubkey|nostr:npub...>";

function stripNostrTargetPrefix(target: string): string {
  return target.trim().replace(/^nostr:/i, "");
}

function normalizeNostrTarget(target: string): string {
  const cleaned = stripNostrTargetPrefix(target);
  try {
    return normalizePubkey(cleaned);
  } catch {
    // Invalid prefixed tokens must stay distinct from "*" so formatting cannot widen access.
    return target.trim();
  }
}

function inferNostrTargetChatType(target: string): "direct" | undefined {
  try {
    normalizePubkey(stripNostrTargetPrefix(target));
    return "direct";
  } catch {
    return undefined;
  }
}

function resolveNostrOutboundSessionRoute(params: ChannelOutboundSessionRouteParams) {
  const rawTarget = stripChannelTargetPrefix(params.target, "nostr");
  let target: string;
  try {
    target = normalizePubkey(rawTarget);
  } catch {
    return null;
  }
  return buildChannelOutboundSessionRoute({
    cfg: params.cfg,
    agentId: params.agentId,
    channel: "nostr",
    accountId: params.accountId,
    recipientSessionExact: true,
    peer: {
      kind: "direct",
      id: target,
    },
    chatType: "direct",
    from: `nostr:${target}`,
    to: `nostr:${target}`,
  });
}

const resolveNostrDmPolicy = createScopedDmSecurityResolver<ResolvedNostrAccount>({
  channelKey: "nostr",
  resolvePolicy: (account) => account.config.dmPolicy,
  resolveAllowFrom: (account) => account.config.allowFrom,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "pairing",
  approveHint: formatPairingApproveHint("nostr"),
  normalizeEntry: normalizeNostrTarget,
});

const nostrConfigAdapter = createTopLevelChannelConfigAdapter<ResolvedNostrAccount>({
  sectionKey: "nostr",
  resolveAccount: (cfg) => resolveNostrAccount({ cfg }),
  listAccountIds: listNostrAccountIds,
  defaultAccountId: resolveDefaultNostrAccountId,
  deleteMode: "clear-fields",
  clearBaseFields: [
    "name",
    "defaultAccount",
    "privateKey",
    "relays",
    "dmPolicy",
    "allowFrom",
    "profile",
  ],
  resolveAllowFrom: (account) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    normalizeStringEntries(allowFrom).map(normalizeNostrTarget).filter(Boolean),
});

const nostrMessageAdapter = createChannelMessageAdapterFromOutbound({
  id: "nostr",
  outbound: nostrOutboundAdapter,
});

const nostrPluginOutboundAdapter: ChannelOutboundAdapter = {
  ...nostrOutboundAdapter,
  resolveTarget: ({ to }) => {
    const trimmed = to?.trim() ?? "";
    if (!trimmed) {
      return {
        ok: false,
        error: missingTargetError("Nostr", NOSTR_TARGET_HINT),
      };
    }
    try {
      return { ok: true, to: normalizePubkey(stripNostrTargetPrefix(trimmed)) };
    } catch {
      return {
        ok: false,
        error: new Error("Nostr target must be a 64-character hex pubkey or npub value"),
      };
    }
  },
};

export const nostrPlugin: ChannelPlugin<ResolvedNostrAccount> = createChatChannelPlugin({
  base: {
    ...nostrSetupPlugin,
    setupContract: nostrSetupContract,
    setupWizard: nostrSetupWizard,
    config: {
      ...nostrSetupPlugin.config,
      ...nostrConfigAdapter,
    },
    messaging: {
      targetPrefixes: ["nostr"],
      normalizeTarget: normalizeNostrTarget,
      inferTargetChatType: ({ to }) => inferNostrTargetChatType(to),
      targetResolver: {
        looksLikeId: (input, normalized) => {
          const trimmed = normalized?.trim() || stripNostrTargetPrefix(input);
          return (
            trimmed.startsWith("npub1") ||
            trimmed.startsWith("NPUB1") ||
            /^[0-9a-fA-F]{64}$/.test(trimmed)
          );
        },
        hint: NOSTR_TARGET_HINT,
      },
      resolveOutboundSessionRoute: resolveNostrOutboundSessionRoute,
    },
    message: nostrMessageAdapter,
    status: createComputedAccountStatusAdapter<ResolvedNostrAccount>({
      defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
      collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("nostr", accounts),
      buildChannelSummary: ({ snapshot }) =>
        buildPassiveChannelStatusSummary(snapshot, {
          publicKey: snapshot.publicKey ?? null,
        }),
      resolveAccountSnapshot: ({ account, runtime }) => ({
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured: account.configured,
        extra: {
          publicKey: account.publicKey,
          profile: account.profile,
          ...buildTrafficStatusSummary(runtime),
        },
      }),
    }),
    gateway: {
      startAccount: startNostrGatewayAccount,
    },
  },
  pairing: {
    text: nostrPairingTextAdapter,
  },
  security: {
    resolveDmPolicy: resolveNostrDmPolicy,
  },
  outbound: nostrPluginOutboundAdapter,
});

export async function publishNostrProfile(
  accountId: string | undefined,
  profile: NostrProfile,
): Promise<ProfilePublishResult> {
  const resolvedAccountId = accountId ?? DEFAULT_ACCOUNT_ID;
  const bus = getActiveNostrBuses().get(resolvedAccountId);
  if (!bus) {
    throw new Error(`Nostr bus not running for account ${resolvedAccountId}`);
  }
  return bus.publishProfile(profile);
}

export async function getNostrProfileState(accountId: string = DEFAULT_ACCOUNT_ID) {
  const bus = getActiveNostrBuses().get(accountId);
  if (!bus) {
    return null;
  }
  return bus.getProfileState();
}
