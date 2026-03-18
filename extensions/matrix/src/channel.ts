import {
  createScopedAccountConfigAccessors,
  createScopedChannelConfigBase,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import {
  buildOpenGroupPolicyWarning,
  collectAllowlistProviderGroupPolicyWarnings,
} from "openclaw/plugin-sdk/channel-policy";
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

const matrixConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) =>
    resolveMatrixAccountConfig({ cfg: cfg as CoreConfig, accountId }),
  resolveAllowFrom: (account) => account.dm?.allowFrom,
  formatAllowFrom: (allowFrom) => normalizeMatrixAllowList(allowFrom),
});

const matrixConfigBase = createScopedChannelConfigBase<ResolvedMatrixAccount, CoreConfig>({
  sectionKey: "matrix",
  listAccountIds: listMatrixAccountIds,
  resolveAccount: (cfg, accountId) => resolveMatrixAccount({ cfg, accountId }),
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
});

const resolveMatrixDmPolicy = createScopedDmSecurityResolver<ResolvedMatrixAccount>({
  channelKey: "matrix",
  resolvePolicy: (account) => account.config.dm?.policy,
  resolveAllowFrom: (account) => account.config.dm?.allowFrom,
  allowFromPathSuffix: "dm.",
  normalizeEntry: (raw) => normalizeMatrixUserId(raw),
});

export const matrixPlugin: ChannelPlugin<ResolvedMatrixAccount> = {
  id: "matrix",
  meta,
  setupWizard: matrixSetupWizard,
  pairing: {
    idLabel: "matrixUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^matrix:/i, ""),
    notifyApproval: async ({ id }) => {
      const { sendMessageMatrix } = await loadMatrixChannelRuntime();
      await sendMessageMatrix(`user:${id}`, PAIRING_APPROVED_MESSAGE);
    },
  },
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
    ...matrixConfigBase,
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.homeserver,
    }),
    ...matrixConfigAccessors,
  },
  security: {
    resolveDmPolicy: resolveMatrixDmPolicy,
    collectWarnings: ({ account, cfg }) => {
      return collectAllowlistProviderGroupPolicyWarnings({
        cfg: cfg as CoreConfig,
        providerConfigPresent: (cfg as CoreConfig).channels?.matrix !== undefined,
        configuredGroupPolicy: account.config.groupPolicy,
        collect: (groupPolicy) =>
          groupPolicy === "open"
            ? [
                buildOpenGroupPolicyWarning({
                  surface: "Matrix rooms",
                  openBehavior: "allows any room to trigger (mention-gated)",
                  remediation:
                    'Set channels.matrix.groupPolicy="allowlist" + channels.matrix.groups (and optionally channels.matrix.groupAllowFrom) to restrict rooms',
                }),
              ]
            : [],
      });
    },
  },
  groups: {
    resolveRequireMention: resolveMatrixGroupRequireMention,
    resolveToolPolicy: resolveMatrixGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: ({ cfg, accountId }) =>
      resolveMatrixAccountConfig({ cfg: cfg as CoreConfig, accountId }).replyToMode ?? "off",
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
  directory: {
    self: async () => null,
    listPeers: async ({ cfg, accountId, query, limit }) => {
      const account = resolveMatrixAccount({ cfg: cfg as CoreConfig, accountId });
      const q = query?.trim().toLowerCase() || "";
      const ids = new Set<string>();

      for (const entry of account.config.dm?.allowFrom ?? []) {
        const raw = String(entry).trim();
        if (!raw || raw === "*") {
          continue;
        }
        ids.add(raw.replace(/^matrix:/i, ""));
      }

      for (const entry of account.config.groupAllowFrom ?? []) {
        const raw = String(entry).trim();
        if (!raw || raw === "*") {
          continue;
        }
        ids.add(raw.replace(/^matrix:/i, ""));
      }

      const groups = account.config.groups ?? account.config.rooms ?? {};
      for (const room of Object.values(groups)) {
        for (const entry of room.users ?? []) {
          const raw = String(entry).trim();
          if (!raw || raw === "*") {
            continue;
          }
          ids.add(raw.replace(/^matrix:/i, ""));
        }
      }

      return Array.from(ids)
        .map((raw) => raw.trim())
        .filter(Boolean)
        .map((raw) => {
          const lowered = raw.toLowerCase();
          const cleaned = lowered.startsWith("user:") ? raw.slice("user:".length).trim() : raw;
          if (cleaned.startsWith("@")) {
            return `user:${cleaned}`;
          }
          return cleaned;
        })
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => {
          const raw = id.startsWith("user:") ? id.slice("user:".length) : id;
          const incomplete = !raw.startsWith("@") || !raw.includes(":");
          return {
            kind: "user",
            id,
            ...(incomplete ? { name: "incomplete id; expected @user:server" } : {}),
          };
        });
    },
    listGroups: async ({ cfg, accountId, query, limit }) => {
      const account = resolveMatrixAccount({ cfg: cfg as CoreConfig, accountId });
      const q = query?.trim().toLowerCase() || "";
      const groups = account.config.groups ?? account.config.rooms ?? {};
      const ids = Object.keys(groups)
        .map((raw) => raw.trim())
        .filter((raw) => Boolean(raw) && raw !== "*")
        .map((raw) => raw.replace(/^matrix:/i, ""))
        .map((raw) => {
          const lowered = raw.toLowerCase();
          if (lowered.startsWith("room:") || lowered.startsWith("channel:")) {
            return raw;
          }
          if (raw.startsWith("!")) {
            return `room:${raw}`;
          }
          return raw;
        })
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
      return ids;
    },
    listPeersLive: async ({ cfg, accountId, query, limit }) =>
      (await loadMatrixChannelRuntime()).listMatrixDirectoryPeersLive({
        cfg,
        accountId,
        query,
        limit,
      }),
    listGroupsLive: async ({ cfg, accountId, query, limit }) =>
      (await loadMatrixChannelRuntime()).listMatrixDirectoryGroupsLive({
        cfg,
        accountId,
        query,
        limit,
      }),
  },
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
    sendText: async (params) => {
      const outbound = (await loadMatrixChannelRuntime()).matrixOutbound;
      if (!outbound.sendText) {
        throw new Error("Matrix outbound text delivery is unavailable");
      }
      return await outbound.sendText(params);
    },
    sendMedia: async (params) => {
      const outbound = (await loadMatrixChannelRuntime()).matrixOutbound;
      if (!outbound.sendMedia) {
        throw new Error("Matrix outbound media delivery is unavailable");
      }
      return await outbound.sendMedia(params);
    },
    sendPoll: async (params) => {
      const outbound = (await loadMatrixChannelRuntime()).matrixOutbound;
      if (!outbound.sendPoll) {
        throw new Error("Matrix outbound poll delivery is unavailable");
      }
      return await outbound.sendPoll(params);
    },
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
