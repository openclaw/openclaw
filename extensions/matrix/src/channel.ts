import {
  createScopedChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  createAllowlistProviderOpenWarningCollector,
  projectWarningCollector,
} from "openclaw/plugin-sdk/channel-policy";
import {
  createChannelDirectoryAdapter,
  createPairingPrefixStripper,
  createScopedAccountReplyToModeResolver,
  createRuntimeDirectoryLiveAdapter,
  createRuntimeOutboundDelegates,
  createTextPairingAdapter,
  listResolvedDirectoryEntriesFromSources,
} from "openclaw/plugin-sdk/channel-runtime";
import { createLazyRuntimeNamedExport } from "openclaw/plugin-sdk/lazy-runtime";
import { buildTrafficStatusSummary } from "../../shared/channel-status-summary.js";
import {
  buildChannelConfigSchema,
  buildProbeChannelStatusSummary,
  collectStatusIssuesFromLastError,
  DEFAULT_ACCOUNT_ID,
  PAIRING_APPROVED_MESSAGE,
  type ChannelPlugin,
} from "../runtime-api.js";
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
import { getMatrixRuntime } from "./runtime.js";
import { resolveMatrixOutboundSessionRoute } from "./session-route.js";
import { matrixSetupAdapter } from "./setup-core.js";
import { matrixSetupWizard } from "./setup-surface.js";
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

function normalizeMatrixMessagingTarget(raw: string): string | undefined {
  let normalized = raw.trim();
  if (!normalized) {
    return undefined;
  }
  const lowered = normalized.toLowerCase();
  if (lowered.startsWith("matrix:")) {
    normalized = normalized.slice("matrix:".length).trim();
  }
  const stripped = normalized.replace(/^(room|channel|user):/i, "").trim();
  return stripped || undefined;
}

const matrixConfigAdapter = createScopedChannelConfigAdapter<
  ResolvedMatrixAccount,
  ReturnType<typeof resolveMatrixAccountConfig>,
  CoreConfig
>({
  sectionKey: "matrix",
  listAccountIds: listMatrixAccountIds,
  resolveAccount: (cfg, accountId) => resolveMatrixAccount({ cfg, accountId }),
  resolveAccessorAccount: ({ cfg, accountId }) =>
    resolveMatrixAccountConfig({ cfg: cfg as CoreConfig, accountId }),
  defaultAccountId: resolveDefaultMatrixAccountId,
  clearBaseFields: [
    "name",
    "homeserver",
    "userId",
    "accessToken",
    "password",
    "deviceName",
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

export const matrixPlugin: ChannelPlugin<ResolvedMatrixAccount> = {
  id: "matrix",
  meta,
  setupWizard: matrixSetupWizard,
  pairing: createTextPairingAdapter({
    idLabel: "matrixUserId",
    message: PAIRING_APPROVED_MESSAGE,
    normalizeAllowEntry: createPairingPrefixStripper(/^matrix:/i),
    notify: async ({ id, message }) => {
      const { sendMessageMatrix } = await loadMatrixChannelRuntime();
      await sendMessageMatrix(`user:${id}`, message);
    },
  }),
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
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.homeserver,
    }),
  },
  security: {
    resolveDmPolicy: resolveMatrixDmPolicy,
    collectWarnings: projectWarningCollector(
      ({ account, cfg }: { account: ResolvedMatrixAccount; cfg: unknown }) => ({
        account,
        cfg: cfg as CoreConfig,
      }),
      collectMatrixSecurityWarnings,
    ),
  },
  groups: {
    resolveRequireMention: resolveMatrixGroupRequireMention,
    resolveToolPolicy: resolveMatrixGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: createScopedAccountReplyToModeResolver({
      resolveAccount: (cfg, accountId) =>
        resolveMatrixAccountConfig({ cfg: cfg as CoreConfig, accountId }),
      resolveReplyToMode: (account) => account.replyToMode,
    }),
    buildToolContext: ({ context, hasRepliedRef }) => {
      const currentTarget = context.To;
      return {
        currentChannelId: currentTarget?.trim() || undefined,
        currentThreadTs:
          context.MessageThreadId != null ? String(context.MessageThreadId) : context.ReplyToId,
        hasRepliedRef,
      };
    },
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
      const entries = listResolvedDirectoryEntriesFromSources({
        ...params,
        kind: "user",
        resolveAccount: (cfg, accountId) =>
          resolveMatrixAccount({ cfg: cfg as CoreConfig, accountId }),
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
      listResolvedDirectoryEntriesFromSources({
        ...params,
        kind: "group",
        resolveAccount: (cfg, accountId) =>
          resolveMatrixAccount({ cfg: cfg as CoreConfig, accountId }),
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
    resolveTargets: async ({ cfg, inputs, kind, runtime }) =>
      (await loadMatrixChannelRuntime()).resolveMatrixTargets({ cfg, inputs, kind, runtime }),
  },
  actions: matrixMessageActions,
  setup: matrixSetupAdapter,
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
        });
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          elapsedMs: 0,
        };
      }
    },
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.homeserver,
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
      probe,
      lastProbeAt: runtime?.lastProbeAt ?? null,
      ...buildTrafficStatusSummary(runtime),
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.homeserver,
      });
      ctx.log?.info(`[${account.accountId}] starting provider (${account.homeserver ?? "matrix"})`);

      // Serialize startup: wait for any previous startup to complete import phase.
      // This works around a race condition with concurrent dynamic imports.
      //
      // INVARIANT: The import() below cannot hang because:
      // 1. It only loads local ESM modules with no circular awaits
      // 2. Module initialization is synchronous (no top-level await in ./matrix/index.js)
      // 3. The lock only serializes the import phase, not the provider startup
      const previousLock = matrixStartupLock;
      let releaseLock: () => void = () => {};
      matrixStartupLock = new Promise<void>((resolve) => {
        releaseLock = resolve;
      });
      await previousLock;

      // Lazy import: the monitor pulls the reply pipeline; avoid ESM init cycles.
      // Wrap in try/finally to ensure lock is released even if import fails.
      let monitorMatrixProvider: typeof import("./matrix/index.js").monitorMatrixProvider;
      try {
        const module = await import("./matrix/index.js");
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
};
