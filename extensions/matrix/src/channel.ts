import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import {
  adaptScopedAccountAccessor,
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  createPairingPrefixStripper,
  createTextPairingAdapter,
} from "openclaw/plugin-sdk/channel-pairing";
import {
  createAllowlistProviderOpenWarningCollector,
  projectWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import { createScopedAccountReplyToModeResolver } from "openclaw/plugin-sdk/conversation-runtime";
import { createChatChannelPlugin } from "openclaw/plugin-sdk/core";
import {
  createChannelDirectoryAdapter,
  createRuntimeDirectoryLiveAdapter,
  listResolvedDirectoryEntriesFromSources,
} from "openclaw/plugin-sdk/directory-runtime";
import { buildTrafficStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { createRuntimeOutboundDelegates } from "openclaw/plugin-sdk/outbound-runtime";
import { matrixMessageActions } from "./actions.js";
import { MatrixConfigSchema } from "./config-schema.js";
import {
  resolveMatrixGroupRequireMention,
  resolveMatrixGroupToolPolicy,
} from "./group-mentions.js";
import {
  listMatrixAccountIds,
  resolveMatrixAccountConfig,
  resolveDefaultMatrixAccountId,
  resolveMatrixAccount,
  type ResolvedMatrixAccount,
} from "./matrix/accounts.js";
import { normalizeMatrixAllowList, normalizeMatrixUserId } from "./matrix/monitor/allowlist.js";
import type { MatrixProbe } from "./matrix/probe.js";
import {
  normalizeMatrixMessagingTarget,
  resolveMatrixDirectUserId,
  resolveMatrixTargetIdentity,
} from "./matrix/target-ids.js";
import {
  buildComputedAccountStatusSnapshot,
  buildChannelConfigSchema,
  buildProbeChannelStatusSummary,
  collectStatusIssuesFromLastError,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  type ChannelPlugin,
} from "./runtime-api.js";
import { getMatrixRuntime } from "./runtime.js";
import { resolveMatrixOutboundSessionRoute } from "./session-route.js";
import { matrixSetupAdapter } from "./setup-core.js";
import type { CoreConfig } from "./types.js";

// Mutex for serializing account startup (workaround for concurrent dynamic import race condition)
let matrixStartupLock: Promise<void> = Promise.resolve();

const loadMatrixChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "matrixChannelRuntime",
);

const meta = {
  id: "matrix",
  label: "Matrix",
  selectionLabel: "Matrix (plugin)",
  docsPath: "/channels/matrix",
  docsLabel: "matrix",
  blurb: "open protocol; configure a homeserver + access token.",
  order: 70,
  quickstartAllowFrom: true,
};

const matrixConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedMatrixAccount,
  ReturnType<typeof resolveMatrixAccountConfig>,
  CoreConfig
>({
  sectionKey: "matrix",
  listAccountIds: listMatrixAccountIds,
  resolveAccount: adaptScopedAccountAccessor(resolveMatrixAccount),
  resolveAccessorAccount: ({ cfg, accountId }) =>
    resolveMatrixAccountConfig({ cfg: cfg as CoreConfig, accountId }),
  defaultAccountId: resolveDefaultMatrixAccountId,
  clearBaseFields: [
    "name",
    "homeserver",
    "allowPrivateNetwork",
    "userId",
    "accessToken",
    "password",
    "deviceId",
    "deviceName",
    "avatarUrl",
    "initialSyncLimit",
  ],
  resolveAllowFrom: (account) => account.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => normalizeMatrixAllowList(allowFrom),
});

const resolveMatrixDmPolicy = createScopedDmSecurityResolver<ResolvedMatrixAccount>({
  channelKey: "matrix",
  resolvePolicy: (account) => account.config.dm?.policy,
  resolveAllowFrom: (account) => account.config.dm?.allowFrom,
  allowFromPathSuffix: "dm.",
  normalizeEntry: (raw) => normalizeMatrixUserId(raw),
});

const collectMatrixSecurityWarnings =
  createAllowlistProviderOpenWarningCollector<ResolvedMatrixAccount>({
    providerConfigPresent: (cfg) => (cfg as CoreConfig).channels?.matrix !== undefined,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    buildOpenWarning: {
      surface: "Matrix rooms",
      openBehavior: "allows any room to trigger (mention-gated)",
      remediation:
        'Set channels.matrix.groupPolicy="allowlist" + channels.matrix.groups (and optionally channels.matrix.groupAllowFrom) to restrict rooms',
    },
  });

function resolveMatrixAccountConfigPath(accountId: string, field: string): string {
  return accountId === DEFAULT_ACCOUNT_ID
    ? `channels.matrix.${field}`
    : `channels.matrix.accounts.${accountId}.${field}`;
}

function collectMatrixSecurityWarningsForAccount(params: {
  account: ResolvedMatrixAccount;
  cfg: CoreConfig;
}): string[] {
  const warnings = collectMatrixSecurityWarnings(params);
  if (params.account.accountId !== DEFAULT_ACCOUNT_ID) {
    const groupPolicyPath = resolveMatrixAccountConfigPath(params.account.accountId, "groupPolicy");
    const groupsPath = resolveMatrixAccountConfigPath(params.account.accountId, "groups");
    const groupAllowFromPath = resolveMatrixAccountConfigPath(
      params.account.accountId,
      "groupAllowFrom",
    );
    return warnings.map((warning) =>
      warning
        .replace("channels.matrix.groupPolicy", groupPolicyPath)
        .replace("channels.matrix.groups", groupsPath)
        .replace("channels.matrix.groupAllowFrom", groupAllowFromPath),
    );
  }
  if (params.account.config.autoJoin !== "always") {
    return warnings;
  }
  const autoJoinPath = resolveMatrixAccountConfigPath(params.account.accountId, "autoJoin");
  const autoJoinAllowlistPath = resolveMatrixAccountConfigPath(
    params.account.accountId,
    "autoJoinAllowlist",
  );
  return [
    ...warnings,
    `- Matrix invites: autoJoin="always" joins any invited room before message policy applies. Set ${autoJoinPath}="allowlist" + ${autoJoinAllowlistPath} (or ${autoJoinPath}="off") to restrict joins.`,
  ];
}

function normalizeMatrixAcpConversationId(conversationId: string) {
  const target = resolveMatrixTargetIdentity(conversationId);
  if (!target || target.kind !== "room") {
    return null;
  }
  return { conversationId: target.id };
}

function matchMatrixAcpConversation(params: {
  bindingConversationId: string;
  conversationId: string;
  parentConversationId?: string;
}) {
  const binding = normalizeMatrixAcpConversationId(params.bindingConversationId);
  if (!binding) {
    return null;
  }
  if (binding.conversationId === params.conversationId) {
    return { conversationId: params.conversationId, matchPriority: 2 };
  }
  if (
    params.parentConversationId &&
    params.parentConversationId !== params.conversationId &&
    binding.conversationId === params.parentConversationId
  ) {
    return {
      conversationId: params.parentConversationId,
      matchPriority: 1,
    };
  }
  return null;
}

export const matrixPlugin: ChannelPlugin<ResolvedMatrixAccount, MatrixProbe> =
  createChatChannelPlugin({
    base: {
      id: "matrix",
      meta,
      capabilities: {
        chatTypes: ["direct", "group", "thread"],
        polls: true,
        reactions: true,
        threads: true,
        media: true,
      },
      reload: { configPrefixes: ["channels.matrix"] },
      configSchema: buildChannelConfigSchema(MatrixConfigSchema),
      config: {
        ...matrixConfigAdapter,
        isConfigured: (account) => account.configured,
        describeAccount: (account) =>
          describeAccountSnapshot({
            account,
            configured: account.configured,
            extra: {
              baseUrl: account.homeserver,
            },
          }),
      },
      groups: {
        resolveRequireMention: resolveMatrixGroupRequireMention,
        resolveToolPolicy: resolveMatrixGroupToolPolicy,
      },
      messaging: {
        normalizeTarget: normalizeMatrixMessagingTarget,
        resolveOutboundSessionRoute: (params) => resolveMatrixOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: (raw) => {
            const trimmed = raw.trim();
            if (!trimmed) {
              return false;
            }
            if (/^(matrix:)?[!#@]/i.test(trimmed)) {
              return true;
            }
            return trimmed.includes(":");
          },
          hint: "<room|alias|user>",
        },
      },
      directory: createChannelDirectoryAdapter({
        listPeers: async (params) => {
          const entries = listResolvedDirectoryEntriesFromSources<ResolvedMatrixAccount>({
            ...params,
            kind: "user",
            resolveAccount: adaptScopedAccountAccessor(resolveMatrixAccount),
            resolveSources: (account) => [
              account.config.dm?.allowFrom ?? [],
              account.config.groupAllowFrom ?? [],
              ...Object.values(account.config.groups ?? account.config.rooms ?? {}).map(
                (room) => room.users ?? [],
              ),
            ],
            normalizeId: (entry) => {
              const raw = entry.replace(/^matrix:/i, "").trim();
              if (!raw || raw === "*") {
                return null;
              }
              const lowered = raw.toLowerCase();
              const cleaned = lowered.startsWith("user:") ? raw.slice("user:".length).trim() : raw;
              return cleaned.startsWith("@") ? `user:${cleaned}` : cleaned;
            },
          });
          return entries.map((entry) => {
            const raw = entry.id.startsWith("user:") ? entry.id.slice("user:".length) : entry.id;
            const incomplete = !raw.startsWith("@") || !raw.includes(":");
            return incomplete ? { ...entry, name: "incomplete id; expected @user:server" } : entry;
          });
        },
        listGroups: async (params) =>
          listResolvedDirectoryEntriesFromSources<ResolvedMatrixAccount>({
            ...params,
            kind: "group",
            resolveAccount: adaptScopedAccountAccessor(resolveMatrixAccount),
            resolveSources: (account) => [
              Object.keys(account.config.groups ?? account.config.rooms ?? {}),
            ],
            normalizeId: (entry) => {
              const raw = entry.replace(/^matrix:/i, "").trim();
              if (!raw || raw === "*") {
                return null;
              }
              const lowered = raw.toLowerCase();
              if (lowered.startsWith("room:") || lowered.startsWith("channel:")) {
                return raw;
              }
              return raw.startsWith("!") ? `room:${raw}` : raw;
            },
          }),
        ...createRuntimeDirectoryLiveAdapter({
          getRuntime: loadMatrixChannelRuntime,
          listPeersLive: (runtime) => runtime.listMatrixDirectoryPeersLive,
          listGroupsLive: (runtime) => runtime.listMatrixDirectoryGroupsLive,
        }),
      }),
      resolver: {
        resolveTargets: async ({ cfg, accountId, inputs, kind, runtime }) =>
          (await loadMatrixChannelRuntime()).resolveMatrixTargets({
            cfg,
            accountId,
            inputs,
            kind,
            runtime,
          }),
      },
      actions: matrixMessageActions,
      setup: matrixSetupAdapter,
      bindings: {
        compileConfiguredBinding: ({ conversationId }) =>
          normalizeMatrixAcpConversationId(conversationId),
        matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) =>
          matchMatrixAcpConversation({
            bindingConversationId: compiledBinding.conversationId,
            conversationId,
            parentConversationId,
          }),
      },
      status: {
        defaultRuntime: {
          accountId: DEFAULT_ACCOUNT_ID,
          running: false,
          lastStartAt: null,
          lastStopAt: null,
          lastError: null,
        },
        collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("matrix", accounts),
        buildChannelSummary: ({ snapshot }) =>
          buildProbeChannelStatusSummary(snapshot, { baseUrl: snapshot.baseUrl ?? null }),
        probeAccount: async ({ account, timeoutMs, cfg }) => {
          try {
            const { probeMatrix, resolveMatrixAuth } = await loadMatrixChannelRuntime();
            const auth = await resolveMatrixAuth({
              cfg: cfg as CoreConfig,
              accountId: account.accountId,
            });
            return await probeMatrix({
              homeserver: auth.homeserver,
              accessToken: auth.accessToken,
              userId: auth.userId,
              timeoutMs,
              accountId: account.accountId,
              allowPrivateNetwork: auth.allowPrivateNetwork,
              ssrfPolicy: auth.ssrfPolicy,
            });
          } catch (err) {
            return {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
              elapsedMs: 0,
            };
          }
        },
        buildAccountSnapshot: ({ account, runtime, probe }) =>
          buildComputedAccountStatusSnapshot(
            {
              accountId: account.accountId,
              name: account.name,
              enabled: account.enabled,
              configured: account.configured,
              runtime,
              probe,
            },
            {
              baseUrl: account.homeserver,
              lastProbeAt: runtime?.lastProbeAt ?? null,
              ...buildTrafficStatusSummary(runtime),
            },
          ),
      },
      gateway: {
        startAccount: async (ctx) => {
          const account = ctx.account;
          ctx.setStatus({
            accountId: account.accountId,
            baseUrl: account.homeserver,
          });
          ctx.log?.info(
            `[${account.accountId}] starting provider (${account.homeserver ?? "matrix"})`,
          );

          // Serialize startup: wait for any previous startup to complete import phase.
          // This works around a race condition with concurrent dynamic imports.
          //
          // INVARIANT: The import() below cannot hang because:
          // 1. It only loads local ESM modules with no circular awaits
          // 2. Module initialization is synchronous (no top-level await in ./matrix/monitor/index.js)
          // 3. The lock only serializes the import phase, not the provider startup
          const previousLock = matrixStartupLock;
          let releaseLock: () => void = () => {};
          matrixStartupLock = new Promise<void>((resolve) => {
            releaseLock = resolve;
          });
          await previousLock;

          // Lazy import: the monitor pulls the reply pipeline; avoid ESM init cycles.
          // Wrap in try/finally to ensure lock is released even if import fails.
          let monitorMatrixProvider: typeof import("./matrix/monitor/index.js").monitorMatrixProvider;
          try {
            const module = await import("./matrix/monitor/index.js");
            monitorMatrixProvider = module.monitorMatrixProvider;
          } finally {
            // Release lock after import completes or fails
            releaseLock();
          }

          return monitorMatrixProvider({
            runtime: ctx.runtime,
            abortSignal: ctx.abortSignal,
            mediaMaxMb: account.config.mediaMaxMb,
            initialSyncLimit: account.config.initialSyncLimit,
            replyToMode: account.config.replyToMode,
            accountId: account.accountId,
          });
        },
      },
    },
    security: {
      resolveDmPolicy: resolveMatrixDmPolicy,
      collectWarnings: projectWarningCollector(
        ({ account, cfg }: { account: ResolvedMatrixAccount; cfg: unknown }) => ({
          account,
          cfg: cfg as CoreConfig,
        }),
        collectMatrixSecurityWarningsForAccount,
      ),
    },
    pairing: {
      text: {
        idLabel: "matrixUserId",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^matrix:/i),
        notify: async ({ id, message, accountId }) => {
          const { sendMessageMatrix } = await loadMatrixChannelRuntime();
          await sendMessageMatrix(`user:${id}`, message, {
            ...(accountId ? { accountId } : {}),
          });
        },
      },
    },
    threading: {
      resolveReplyToMode: createScopedAccountReplyToModeResolver<
        ReturnType<typeof resolveMatrixAccountConfig>
      >({
        resolveAccount: adaptScopedAccountAccessor(resolveMatrixAccountConfig),
        resolveReplyToMode: (account) => account.replyToMode,
      }),
      buildToolContext: ({ context, hasRepliedRef }) => {
        const currentTarget = context.To;
        return {
          currentChannelId: currentTarget?.trim() || undefined,
          currentThreadTs:
            context.MessageThreadId != null ? String(context.MessageThreadId) : undefined,
          currentDirectUserId: resolveMatrixDirectUserId({
            from: context.From,
            to: context.To,
            chatType: context.ChatType,
          }),
          hasRepliedRef,
        };
      },
    },
    outbound: {
      deliveryMode: "direct",
      chunker: (text, limit) => getMatrixRuntime().channel.text.chunkMarkdownText!(text, limit),
      chunkerMode: "markdown",
      textChunkLimit: 4000,
      ...createRuntimeOutboundDelegates({
        getRuntime: loadMatrixChannelRuntime,
        sendText: {
          resolve: (runtime) => runtime.matrixOutbound.sendText,
          unavailableMessage: "Matrix outbound text delivery is unavailable",
        },
        sendMedia: {
          resolve: (runtime) => runtime.matrixOutbound.sendMedia,
          unavailableMessage: "Matrix outbound media delivery is unavailable",
        },
        sendPoll: {
          resolve: (runtime) => runtime.matrixOutbound.sendPoll,
          unavailableMessage: "Matrix outbound poll delivery is unavailable",
        },
      }),
    },
  });
