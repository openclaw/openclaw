import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import {
  adaptScopedAccountAccessor,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import type {
  ChannelDoctorAdapter,
  ChannelThreadingToolContext,
} from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createRuntimeOutboundDelegates } from "openclaw/plugin-sdk/channel-outbound";
import {
  createAllowlistProviderOpenWarningCollector,
  createConditionalWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { createScopedAccountReplyToModeResolver } from "openclaw/plugin-sdk/conversation-runtime";
import {
  createChannelDirectoryAdapter,
  createResolvedDirectoryEntriesLister,
  createRuntimeDirectoryLiveAdapter,
} from "openclaw/plugin-sdk/directory-runtime";
import {
  createLazyRuntimeNamedExport,
  createLazyRuntimeModule,
} from "openclaw/plugin-sdk/lazy-runtime";
import {
  buildProbeChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  chunkTextForOutbound,
  sanitizeAssistantVisibleText,
} from "openclaw/plugin-sdk/text-chunking";
import { matrixMessageActions } from "./actions.js";
import { matrixApprovalCapability } from "./approval-native.js";
import { createMatrixPairingText, createMatrixProbeAccount } from "./channel-account-paths.js";
import { createMatrixMessageAdapter } from "./channel-message-adapter.js";
import { matrixPluginBase } from "./channel.setup.js";
import {
  legacyConfigRules as MATRIX_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig as normalizeMatrixCompatibilityConfig,
} from "./doctor-contract.js";
import { shouldSuppressLocalMatrixExecApprovalPrompt } from "./exec-approvals.js";
import {
  resolveMatrixGroupRequireMention,
  resolveMatrixGroupToolPolicy,
} from "./group-mentions.js";
import {
  resolveDefaultMatrixAccountId,
  resolveMatrixAccountConfig,
  type ResolvedMatrixAccount,
} from "./matrix/accounts.js";
import { resolveMatrixConversationRouteOwner } from "./matrix/conversation-route-owner.js";
import { normalizeMatrixUserId } from "./matrix/monitor/allowlist.js";
import type { MatrixProbe } from "./matrix/probe.js";
import {
  normalizeMatrixMessagingTarget,
  resolveMatrixDirectUserId,
  resolveMatrixTargetIdentity,
} from "./matrix/target-ids.js";
import {
  setMatrixThreadBindingIdleTimeoutBySessionKey,
  setMatrixThreadBindingMaxAgeBySessionKey,
} from "./matrix/thread-bindings-shared.js";
import { matrixResolverAdapter } from "./resolver.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { resolveMatrixOutboundSessionRoute } from "./session-route.js";
import {
  defaultTopLevelPlacement,
  resolveMatrixInboundConversation,
} from "./thread-binding-api.js";
import type { CoreConfig, MatrixConfig } from "./types.js";

const loadMatrixChannelRuntime = createLazyRuntimeNamedExport(
  () => import("./channel.runtime.js"),
  "matrixChannelRuntime",
);

const loadMatrixDoctorModule = createLazyRuntimeModule(() => import("./doctor.js"));
// Share the import across account starts; the monitor pulls in the reply pipeline.
const loadMatrixMonitorModule = createLazyRuntimeModule(() =>
  import("./matrix/monitor/index.js").catch((error: unknown) => {
    loadMatrixMonitorModule.clear();
    throw error;
  }),
);

const matrixDoctor: ChannelDoctorAdapter = {
  dmAllowFromMode: "nestedOnly",
  groupModel: "sender",
  groupAllowFromFallbackToAllowFrom: false,
  warnOnEmptyGroupSenderAllowlist: true,
  legacyConfigRules: MATRIX_LEGACY_CONFIG_RULES,
  normalizeCompatibilityConfig: normalizeMatrixCompatibilityConfig,
  runConfigSequence: async ({ cfg, env, shouldRepair }) =>
    await (await loadMatrixDoctorModule()).runMatrixDoctorSequence({ cfg, env, shouldRepair }),
  cleanStaleConfig: async ({ cfg }) =>
    await (await loadMatrixDoctorModule()).cleanStaleMatrixPluginConfig(cfg),
};

const listMatrixDirectoryPeersFromConfig = createResolvedDirectoryEntriesLister<MatrixConfig>({
  kind: "user",
  resolveAccount: (cfg, accountId) =>
    resolveMatrixAccountConfig({
      cfg,
      accountId: accountId ?? resolveDefaultMatrixAccountId(cfg),
    }),
  resolveSources: (account) => [
    account.dm?.allowFrom ?? [],
    account.groupAllowFrom ?? [],
    ...Object.values(account.groups ?? account.rooms ?? {}).map((room) => room.users ?? []),
  ],
  normalizeId: (entry) => {
    const raw = entry.replace(/^matrix:/i, "").trim();
    if (!raw || raw === "*") {
      return null;
    }
    const lowered = normalizeLowercaseStringOrEmpty(raw);
    const cleaned = lowered.startsWith("user:") ? raw.slice("user:".length).trim() : raw;
    return cleaned.startsWith("@") ? `user:${cleaned}` : cleaned;
  },
});

const listMatrixDirectoryGroupsFromConfig = createResolvedDirectoryEntriesLister<MatrixConfig>({
  kind: "group",
  resolveAccount: (cfg, accountId) =>
    resolveMatrixAccountConfig({
      cfg,
      accountId: accountId ?? resolveDefaultMatrixAccountId(cfg),
    }),
  resolveSources: (account) => [Object.keys(account.groups ?? account.rooms ?? {})],
  normalizeId: (entry) => {
    const raw = entry.replace(/^matrix:/i, "").trim();
    if (!raw || raw === "*") {
      return null;
    }
    const lowered = normalizeLowercaseStringOrEmpty(raw);
    if (lowered.startsWith("room:") || lowered.startsWith("channel:")) {
      return raw;
    }
    return raw.startsWith("!") ? `room:${raw}` : raw;
  },
});

function projectMatrixConversationBinding(binding: {
  boundAt: number;
  metadata?: {
    lastActivityAt?: number;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
  };
}) {
  return {
    boundAt: binding.boundAt,
    lastActivityAt:
      typeof binding.metadata?.lastActivityAt === "number"
        ? binding.metadata.lastActivityAt
        : binding.boundAt,
    idleTimeoutMs:
      typeof binding.metadata?.idleTimeoutMs === "number"
        ? binding.metadata.idleTimeoutMs
        : undefined,
    maxAgeMs:
      typeof binding.metadata?.maxAgeMs === "number" ? binding.metadata.maxAgeMs : undefined,
  };
}

const resolveMatrixDmPolicy = createScopedDmSecurityResolver<ResolvedMatrixAccount>({
  channelKey: "matrix",
  resolvePolicy: (account) => account.config.dm?.policy,
  resolveAllowFrom: (account) => account.config.dm?.allowFrom,
  allowFromPathSuffix: "dm.",
  normalizeEntry: (raw) => normalizeMatrixUserId(raw),
});

const collectMatrixGroupPolicyWarnings =
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

function collectMatrixGroupPolicyWarningsForAccount(params: {
  account: ResolvedMatrixAccount;
  cfg: CoreConfig;
}): string[] {
  const warnings = collectMatrixGroupPolicyWarnings(params);
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
  return warnings;
}

const collectMatrixOpenGroupFindings = createConditionalWarningCollector.findings({
  collectWarnings: collectMatrixGroupPolicyWarningsForAccount,
  checkId: "channels.matrix.groups.open",
  severity: "warn",
  title: "Matrix security warning",
});

function collectMatrixSecurityWarningsForAccount(params: {
  account: ResolvedMatrixAccount;
  cfg: CoreConfig;
}) {
  const findings = collectMatrixOpenGroupFindings(params);
  if (
    params.account.accountId !== DEFAULT_ACCOUNT_ID ||
    params.account.config.autoJoin !== "always"
  ) {
    return findings;
  }
  const autoJoinPath = resolveMatrixAccountConfigPath(params.account.accountId, "autoJoin");
  const autoJoinAllowlistPath = resolveMatrixAccountConfigPath(
    params.account.accountId,
    "autoJoinAllowlist",
  );
  return [
    ...findings,
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

function resolveMatrixCommandConversation(params: {
  threadId?: string;
  originatingTo?: string;
  commandTo?: string;
  fallbackTo?: string;
}) {
  const parentConversationId = [params.originatingTo, params.commandTo, params.fallbackTo]
    .map((candidate) => {
      const trimmed = candidate?.trim();
      if (!trimmed) {
        return undefined;
      }
      const target = resolveMatrixTargetIdentity(trimmed);
      return target?.kind === "room" ? target.id : undefined;
    })
    .find((candidate): candidate is string => Boolean(candidate));
  if (params.threadId) {
    return {
      conversationId: params.threadId,
      ...(parentConversationId ? { parentConversationId } : {}),
    };
  }
  return parentConversationId ? { conversationId: parentConversationId } : null;
}

function resolveMatrixDeliveryTarget(params: {
  conversationId: string;
  parentConversationId?: string;
}) {
  const parentConversationId = params.parentConversationId?.trim();
  if (parentConversationId && parentConversationId !== params.conversationId.trim()) {
    const parentTarget = resolveMatrixTargetIdentity(parentConversationId);
    if (parentTarget?.kind === "room") {
      return {
        to: `room:${parentTarget.id}`,
        threadId: params.conversationId.trim(),
      };
    }
  }
  const conversationTarget = resolveMatrixTargetIdentity(params.conversationId);
  if (conversationTarget?.kind === "room") {
    return { to: `room:${conversationTarget.id}` };
  }
  return null;
}

function matchesMatrixToolContextRoom(params: {
  target: string;
  toolContext: ChannelThreadingToolContext;
}): boolean {
  const { toolContext } = params;
  if (toolContext.currentChannelProvider && toolContext.currentChannelProvider !== "matrix") {
    return false;
  }
  const currentTarget = toolContext.currentChannelId
    ? resolveMatrixTargetIdentity(toolContext.currentChannelId)
    : null;
  const target = resolveMatrixTargetIdentity(params.target);
  // A Matrix user target can select a different DM room; only verified room IDs may share threads.
  return (
    currentTarget?.kind === "room" && target?.kind === "room" && currentTarget.id === target.id
  );
}

const matrixChannelOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown",
  textChunkLimit: 4000,
  sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
  deliveryCapabilities: {
    durableFinal: {
      text: true,
      media: true,
      replyTo: true,
      thread: true,
      messageSendingHooks: true,
      afterCommit: true,
      reconcileUnknownSend: true,
    },
  },
  presentationCapabilities: {
    supported: true,
    buttons: true,
    selects: true,
    context: true,
    divider: true,
    limits: {
      text: {
        markdownDialect: "markdown",
        supportsEdit: true,
      },
    },
  },
  shouldSuppressLocalPayloadPrompt: shouldSuppressLocalMatrixExecApprovalPrompt,
  ...createRuntimeOutboundDelegates({
    getRuntime: loadMatrixChannelRuntime,
    renderPresentation: {
      resolve: (runtime) => runtime.matrixOutbound.renderPresentation,
      unavailableMessage: "Matrix outbound presentation rendering is unavailable",
    },
    sendPayload: {
      resolve: (runtime) => runtime.matrixOutbound.sendPayload,
      unavailableMessage: "Matrix outbound payload delivery is unavailable",
    },
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
};

const matrixMessageAdapter = createMatrixMessageAdapter({
  outbound: matrixChannelOutbound,
  getRuntime: loadMatrixChannelRuntime,
});

export const matrixPlugin: ChannelPlugin<ResolvedMatrixAccount, MatrixProbe> =
  createChatChannelPlugin<ResolvedMatrixAccount, MatrixProbe>({
    base: {
      ...matrixPluginBase,
      meta: { ...matrixPluginBase.meta, markdownCapable: true },
      capabilities: {
        ...matrixPluginBase.capabilities,
        tts: {
          voice: {
            synthesisTarget: "voice-note",
          },
        },
      },
      approvalCapability: matrixApprovalCapability,
      groups: {
        resolveRequireMention: resolveMatrixGroupRequireMention,
        resolveToolPolicy: resolveMatrixGroupToolPolicy,
      },
      conversationBindings: {
        supportsCurrentConversationBinding: true,
        bindingStore: "adapter",
        defaultTopLevelPlacement,
        setIdleTimeoutBySessionKey: ({ targetSessionKey, accountId, idleTimeoutMs }) =>
          setMatrixThreadBindingIdleTimeoutBySessionKey({
            targetSessionKey,
            accountId: accountId ?? "",
            idleTimeoutMs,
          }).map(projectMatrixConversationBinding),
        setMaxAgeBySessionKey: ({ targetSessionKey, accountId, maxAgeMs }) =>
          setMatrixThreadBindingMaxAgeBySessionKey({
            targetSessionKey,
            accountId: accountId ?? "",
            maxAgeMs,
          }).map(projectMatrixConversationBinding),
      },
      messaging: {
        defaultMarkdownTableMode: "block",
        targetPrefixes: ["matrix"],
        targetIdComparison: "case-sensitive",
        normalizeTarget: normalizeMatrixMessagingTarget,
        inferTargetChatType: ({ to }) => {
          const target = resolveMatrixTargetIdentity(to);
          return target ? (target.kind === "user" ? "direct" : "channel") : undefined;
        },
        resolveInboundConversation: resolveMatrixInboundConversation,
        resolveDeliveryTarget: resolveMatrixDeliveryTarget,
        resolveOutboundSessionRoute: resolveMatrixOutboundSessionRoute,
        resolveConversationRouteOwner: resolveMatrixConversationRouteOwner,
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
          const entries = await listMatrixDirectoryPeersFromConfig(params);
          return entries.map((entry) => {
            const raw = entry.id.startsWith("user:") ? entry.id.slice("user:".length) : entry.id;
            const incomplete = !raw.startsWith("@") || !raw.includes(":");
            return incomplete
              ? Object.assign({}, entry, { name: `incomplete id; expected @user:server` })
              : entry;
          });
        },
        listGroups: async (params) => await listMatrixDirectoryGroupsFromConfig(params),
        ...createRuntimeDirectoryLiveAdapter({
          getRuntime: loadMatrixChannelRuntime,
          listPeersLive: (runtime) => runtime.listMatrixDirectoryPeersLive,
          listGroupsLive: (runtime) => runtime.listMatrixDirectoryGroupsLive,
        }),
      }),
      resolver: matrixResolverAdapter,
      actions: matrixMessageActions,
      message: matrixMessageAdapter,
      secrets: {
        secretTargetRegistryEntries,
        collectRuntimeConfigAssignments,
      },
      bindings: {
        compileConfiguredBinding: ({ conversationId }) =>
          normalizeMatrixAcpConversationId(conversationId),
        matchInboundConversation: ({ compiledBinding, conversationId, parentConversationId }) =>
          matchMatrixAcpConversation({
            bindingConversationId: compiledBinding.conversationId,
            conversationId,
            parentConversationId,
          }),
        resolveCommandConversation: resolveMatrixCommandConversation,
      },
      status: createComputedAccountStatusAdapter<ResolvedMatrixAccount, MatrixProbe>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("matrix", accounts),
        buildChannelSummary: ({ snapshot }) =>
          buildProbeChannelStatusSummary(snapshot, { baseUrl: snapshot.baseUrl ?? null }),
        probeAccount: async ({ account, timeoutMs, cfg }) =>
          await createMatrixProbeAccount({
            resolveMatrixAuth: async (params) =>
              (await loadMatrixChannelRuntime()).resolveMatrixAuth(params),
            probeMatrix: async (params) =>
              await (await loadMatrixChannelRuntime()).probeMatrix(params),
          })({
            account,
            timeoutMs,
            cfg,
          }),
        resolveAccountSnapshot: ({ account, runtime }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            baseUrl: account.homeserver,
            lastProbeAt: runtime?.lastProbeAt ?? null,
            lastInboundAt: runtime?.lastInboundAt ?? null,
            lastOutboundAt: runtime?.lastOutboundAt ?? null,
          },
        }),
      }),
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

          const { monitorMatrixProvider } = await loadMatrixMonitorModule();
          return monitorMatrixProvider({
            runtime: ctx.runtime,
            channelRuntime: ctx.channelRuntime,
            abortSignal: ctx.abortSignal,
            mediaMaxMb: account.config.mediaMaxMb,
            initialSyncLimit: account.config.initialSyncLimit,
            replyToMode: account.config.replyToMode,
            accountId: account.accountId,
            setStatus: ctx.setStatus,
          });
        },
      },
      doctor: matrixDoctor,
      heartbeat: {
        sendTyping: async ({ cfg, to, accountId }) => {
          await (
            await loadMatrixChannelRuntime()
          ).sendTypingMatrix(to, true, {
            cfg: cfg as CoreConfig,
            ...(accountId ? { accountId } : {}),
          });
        },
        clearTyping: async ({ cfg, to, accountId }) => {
          await (
            await loadMatrixChannelRuntime()
          ).sendTypingMatrix(to, false, {
            cfg: cfg as CoreConfig,
            ...(accountId ? { accountId } : {}),
          });
        },
      },
    },
    security: {
      resolveDmPolicy: resolveMatrixDmPolicy,
      collectWarnings: ({ account, cfg }) =>
        collectMatrixSecurityWarningsForAccount({ account, cfg: cfg as CoreConfig }),
    },
    pairing: {
      text: createMatrixPairingText(
        async (to, message, options) =>
          await (await loadMatrixChannelRuntime()).sendMessageMatrix(to, message, options),
      ),
    },
    threading: {
      matchesToolContextTarget: matchesMatrixToolContextRoom,
      resolveAutoThreadId: ({ to, toolContext }) => {
        const threadId = normalizeOptionalString(toolContext?.currentThreadTs);
        if (!threadId || !toolContext) {
          return undefined;
        }
        return matchesMatrixToolContextRoom({ target: to, toolContext }) ? threadId : undefined;
      },
      resolveReplyToMode: createScopedAccountReplyToModeResolver<
        ReturnType<typeof resolveMatrixAccountConfig>
      >({
        resolveAccount: adaptScopedAccountAccessor(resolveMatrixAccountConfig),
        resolveReplyToMode: (account) => account.replyToMode,
      }),
      buildToolContext: ({ context, hasRepliedRef }) => {
        const currentTarget = context.To;
        return {
          currentChannelId: normalizeOptionalString(currentTarget),
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
    outbound: matrixChannelOutbound,
  });
