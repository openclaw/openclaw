import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  moveSingleAccountChannelSectionToDefaultAccount,
  normalizeAccountId,
  normalizeSecretInputString,
  PAIRING_APPROVED_MESSAGE,
  resolveAllowlistProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  setAccountEnabledInConfigSection,
  type ChannelSetupInput,
  type ChannelPlugin,
} from "openclaw/plugin-sdk/matrix";
import { matrixMessageActions } from "./actions.js";
import { MatrixConfigSchema } from "./config-schema.js";
import { listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } from "./directory-live.js";
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
import {
  getMatrixScopedEnvVarNames,
  hasReadyMatrixEnvAuth,
  resolveMatrixAuth,
  resolveScopedMatrixEnvConfig,
} from "./matrix/client.js";
import { updateMatrixAccountConfig } from "./matrix/config-update.js";
import { resolveMatrixConfigFieldPath, resolveMatrixConfigPath } from "./matrix/config-update.js";
import { normalizeMatrixAllowList, normalizeMatrixUserId } from "./matrix/monitor/allowlist.js";
import { probeMatrix } from "./matrix/probe.js";
import { isSupportedMatrixAvatarSource } from "./matrix/profile.js";
import { sendMessageMatrix } from "./matrix/send.js";
import {
  isMatrixQualifiedUserId,
  normalizeMatrixDirectoryGroupId,
  normalizeMatrixDirectoryUserId,
  normalizeMatrixMessagingTarget,
  resolveMatrixDirectUserId,
} from "./matrix/target-ids.js";
import { matrixOnboardingAdapter } from "./onboarding.js";
import { matrixOutbound } from "./outbound.js";
import { resolveMatrixTargets } from "./resolve-targets.js";
import type { CoreConfig } from "./types.js";

// Mutex for serializing account startup (workaround for concurrent dynamic import race condition)
let matrixStartupLock: Promise<void> = Promise.resolve();

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

function resolveAvatarInput(input: ChannelSetupInput): string | undefined {
  const avatarUrl = (input as ChannelSetupInput & { avatarUrl?: string }).avatarUrl;
  const trimmed = avatarUrl?.trim();
  return trimmed ? trimmed : undefined;
}

export const matrixPlugin: ChannelPlugin<ResolvedMatrixAccount> = {
  id: "matrix",
  meta,
  onboarding: matrixOnboardingAdapter,
  pairing: {
    idLabel: "matrixUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^matrix:/i, ""),
    notifyApproval: async ({ id, accountId }) => {
      await sendMessageMatrix(`user:${id}`, PAIRING_APPROVED_MESSAGE, {
        accountId,
      });
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
    listAccountIds: (cfg) => listMatrixAccountIds(cfg as CoreConfig),
    resolveAccount: (cfg, accountId) => resolveMatrixAccount({ cfg: cfg as CoreConfig, accountId }),
    defaultAccountId: (cfg) => resolveDefaultMatrixAccountId(cfg as CoreConfig),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "matrix",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg: cfg as CoreConfig,
        sectionKey: "matrix",
        accountId,
        clearBaseFields: [
          "name",
          "homeserver",
          "userId",
          "accessToken",
          "password",
          "deviceName",
          "avatarUrl",
          "initialSyncLimit",
        ],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.homeserver,
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const matrixConfig = resolveMatrixAccountConfig({ cfg: cfg as CoreConfig, accountId });
      return (matrixConfig.dm?.allowFrom ?? []).map((entry: string | number) => String(entry));
    },
    formatAllowFrom: ({ allowFrom }) => normalizeMatrixAllowList(allowFrom),
  },
  security: {
    resolveDmPolicy: ({ account, cfg }) => {
      return {
        policy: account.config.dm?.policy ?? "pairing",
        allowFrom: account.config.dm?.allowFrom ?? [],
        policyPath: resolveMatrixConfigFieldPath(cfg as CoreConfig, account.accountId, "dm.policy"),
        allowFromPath: resolveMatrixConfigFieldPath(
          cfg as CoreConfig,
          account.accountId,
          "dm.allowFrom",
        ),
        approveHint: formatPairingApproveHint("matrix"),
        normalizeEntry: (raw) => normalizeMatrixUserId(raw),
      };
    },
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg as CoreConfig);
      const { groupPolicy } = resolveAllowlistProviderRuntimeGroupPolicy({
        providerConfigPresent: (cfg as CoreConfig).channels?.["matrix"] !== undefined,
        groupPolicy: account.config.groupPolicy,
        defaultGroupPolicy,
      });
      const configPath = resolveMatrixConfigPath(cfg as CoreConfig, account.accountId);
      const warnings: string[] = [];
      if (groupPolicy === "open") {
        warnings.push(
          `- Matrix rooms: groupPolicy="open" allows any room to trigger (mention-gated). Set ${configPath}.groupPolicy="allowlist" + ${configPath}.groups (and optionally ${configPath}.groupAllowFrom) to restrict rooms.`,
        );
      }
      if ((account.config.autoJoin ?? "off") === "always") {
        warnings.push(
          `- Matrix invites: autoJoin="always" joins any invited room before message policy applies. Set ${configPath}.autoJoin="allowlist" + ${configPath}.autoJoinAllowlist (or ${configPath}.autoJoin="off") to restrict joins.`,
        );
      }
      return warnings;
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
        const normalized = normalizeMatrixDirectoryUserId(String(entry));
        if (normalized) {
          ids.add(normalized);
        }
      }

      for (const entry of account.config.groupAllowFrom ?? []) {
        const normalized = normalizeMatrixDirectoryUserId(String(entry));
        if (normalized) {
          ids.add(normalized);
        }
      }

      const groups = account.config.groups ?? account.config.rooms ?? {};
      for (const room of Object.values(groups)) {
        for (const entry of room.users ?? []) {
          const normalized = normalizeMatrixDirectoryUserId(String(entry));
          if (normalized) {
            ids.add(normalized);
          }
        }
      }

      return Array.from(ids)
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => {
          const raw = id.startsWith("user:") ? id.slice("user:".length) : id;
          const incomplete = !isMatrixQualifiedUserId(raw);
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
        .map((raw) => normalizeMatrixDirectoryGroupId(raw))
        .filter((id): id is string => Boolean(id))
        .filter((id) => (q ? id.toLowerCase().includes(q) : true))
        .slice(0, limit && limit > 0 ? limit : undefined)
        .map((id) => ({ kind: "group", id }) as const);
      return ids;
    },
    listPeersLive: async ({ cfg, accountId, query, limit }) =>
      listMatrixDirectoryPeersLive({ cfg, accountId, query, limit }),
    listGroupsLive: async ({ cfg, accountId, query, limit }) =>
      listMatrixDirectoryGroupsLive({ cfg, accountId, query, limit }),
  },
  resolver: {
    resolveTargets: async ({ cfg, accountId, inputs, kind, runtime }) =>
      resolveMatrixTargets({ cfg, accountId, inputs, kind, runtime }),
  },
  actions: matrixMessageActions,
  setup: {
    resolveAccountId: ({ accountId, input }) =>
      normalizeAccountId(accountId?.trim() || input?.name?.trim()),
    resolveBindingAccountId: ({ agentId, accountId }) =>
      normalizeAccountId(accountId?.trim() || agentId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as CoreConfig,
        channelKey: "matrix",
        accountId,
        name,
      }),
    validateInput: ({ accountId, input }) => {
      const avatarUrl = resolveAvatarInput(input);
      if (avatarUrl && !isSupportedMatrixAvatarSource(avatarUrl)) {
        return "Matrix avatar URL must be an mxc:// URI or an http(s) URL";
      }
      if (input.useEnv) {
        const scopedEnv = resolveScopedMatrixEnvConfig(accountId, process.env);
        const scopedReady = hasReadyMatrixEnvAuth(scopedEnv);
        if (accountId !== DEFAULT_ACCOUNT_ID && !scopedReady) {
          const keys = getMatrixScopedEnvVarNames(accountId);
          return `Set per-account env vars for "${accountId}" (for example ${keys.homeserver} + ${keys.accessToken} or ${keys.userId} + ${keys.password}).`;
        }
        return null;
      }
      if (!input.homeserver?.trim()) {
        return "Matrix requires --homeserver";
      }
      const accessToken = input.accessToken?.trim();
      const password = input.password?.trim();
      const userId = input.userId?.trim();
      if (!accessToken && !password) {
        return "Matrix requires --access-token or --password";
      }
      if (!accessToken) {
        if (!userId) {
          return "Matrix requires --user-id when using --password";
        }
        if (!password) {
          return "Matrix requires --password when using --user-id";
        }
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const promoted =
        normalizeAccountId(accountId) !== DEFAULT_ACCOUNT_ID
          ? moveSingleAccountChannelSectionToDefaultAccount({
              cfg: cfg as CoreConfig,
              channelKey: "matrix",
            })
          : (cfg as CoreConfig);
      const namedConfig = applyAccountNameToChannelSection({
        cfg: promoted,
        channelKey: "matrix",
        accountId,
        name: input.name,
      });
      const next = namedConfig as CoreConfig;
      if (input.useEnv) {
        return updateMatrixAccountConfig(next, accountId, {
          enabled: true,
          homeserver: null,
          userId: null,
          accessToken: null,
          password: null,
          deviceId: null,
          deviceName: null,
        });
      }
      const accessToken = input.accessToken?.trim();
      const password = normalizeSecretInputString(input.password);
      const userId = input.userId?.trim();
      return updateMatrixAccountConfig(next as CoreConfig, accountId, {
        homeserver: input.homeserver?.trim(),
        userId: password && !userId ? null : userId,
        accessToken: accessToken || (password ? null : undefined),
        password: password || (accessToken ? null : undefined),
        deviceName: input.deviceName?.trim(),
        avatarUrl: resolveAvatarInput(input),
        initialSyncLimit: input.initialSyncLimit,
      });
    },
  },
  outbound: matrixOutbound,
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    collectStatusIssues: (accounts) =>
      accounts.flatMap((account) => {
        const lastError = typeof account.lastError === "string" ? account.lastError.trim() : "";
        if (!lastError) {
          return [];
        }
        return [
          {
            channel: "matrix",
            accountId: account.accountId,
            kind: "runtime",
            message: `Channel error: ${lastError}`,
          },
        ];
      }),
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      baseUrl: snapshot.baseUrl ?? null,
      running: snapshot.running ?? false,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs, cfg }) => {
      try {
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
      lastInboundAt: runtime?.lastInboundAt ?? null,
      lastOutboundAt: runtime?.lastOutboundAt ?? null,
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
};
