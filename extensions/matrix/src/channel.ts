import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import type { CoreConfig } from "./types.js";
import { matrixMessageActions } from "./actions.js";
import { MatrixConfigSchema } from "./config-schema.js";
import { listMatrixDirectoryGroupsLive, listMatrixDirectoryPeersLive } from "./directory-live.js";
import {
  resolveMatrixGroupRequireMention,
  resolveMatrixGroupToolPolicy,
} from "./group-mentions.js";
import {
  listMatrixAccountIds,
  resolveDefaultMatrixAccountId,
  resolveMatrixAccount,
  type ResolvedMatrixAccount,
} from "./matrix/accounts.js";
import { resolveMatrixAuth } from "./matrix/client.js";
import { normalizeMatrixAllowList, normalizeMatrixUserId } from "./matrix/monitor/allowlist.js";
import { probeMatrix } from "./matrix/probe.js";
import { sendMessageMatrix } from "./matrix/send.js";
import { matrixOnboardingAdapter } from "./onboarding.js";
import { matrixOutbound } from "./outbound.js";
import { resolveMatrixTargets } from "./resolve-targets.js";

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

function buildMatrixConfigUpdate(
  cfg: CoreConfig,
  input: {
    homeserver?: string;
    userId?: string;
    accessToken?: string;
    password?: string;
    deviceName?: string;
    initialSyncLimit?: number;
  },
): CoreConfig {
  const existing = cfg.channels?.matrix ?? {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      matrix: {
        ...existing,
        enabled: true,
        ...(input.homeserver ? { homeserver: input.homeserver } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.accessToken ? { accessToken: input.accessToken } : {}),
        ...(input.password ? { password: input.password } : {}),
        ...(input.deviceName ? { deviceName: input.deviceName } : {}),
        ...(typeof input.initialSyncLimit === "number"
          ? { initialSyncLimit: input.initialSyncLimit }
          : {}),
      },
    },
  };
}

export const matrixPlugin: ChannelPlugin<ResolvedMatrixAccount> = {
  id: "matrix",
  meta,
  onboarding: matrixOnboardingAdapter,
  pairing: {
    idLabel: "matrixUserId",
    normalizeAllowEntry: (entry) => entry.replace(/^matrix:/i, ""),
    notifyApproval: async ({ id }) => {
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
    resolveAllowFrom: ({ cfg }) =>
      ((cfg as CoreConfig).channels?.matrix?.dm?.allowFrom ?? []).map((entry) => String(entry)),
    formatAllowFrom: ({ allowFrom }) => normalizeMatrixAllowList(allowFrom),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      policy: account.config.dm?.policy ?? "pairing",
      allowFrom: account.config.dm?.allowFrom ?? [],
      policyPath: "channels.matrix.dm.policy",
      allowFromPath: "channels.matrix.dm.allowFrom",
      approveHint: formatPairingApproveHint("matrix"),
      normalizeEntry: (raw) => normalizeMatrixUserId(raw),
    }),
    collectWarnings: ({ account, cfg }) => {
      const defaultGroupPolicy = (cfg as CoreConfig).channels?.defaults?.groupPolicy;
      const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
      if (groupPolicy !== "open") {
        return [];
      }
      return [
        '- Matrix rooms: groupPolicy="open" allows any room to trigger (mention-gated). Set channels.matrix.groupPolicy="allowlist" + channels.matrix.groups (and optionally channels.matrix.groupAllowFrom) to restrict rooms.',
      ];
    },
  },
  groups: {
    resolveRequireMention: resolveMatrixGroupRequireMention,
    resolveToolPolicy: resolveMatrixGroupToolPolicy,
  },
  threading: {
    resolveReplyToMode: ({ cfg }) => (cfg as CoreConfig).channels?.matrix?.replyToMode ?? "off",
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
    listPeersLive: async ({ cfg, query, limit }) =>
      listMatrixDirectoryPeersLive({ cfg, query, limit }),
    listGroupsLive: async ({ cfg, query, limit }) =>
      listMatrixDirectoryGroupsLive({ cfg, query, limit }),
  },
  resolver: {
    resolveTargets: async ({ cfg, inputs, kind, runtime }) =>
      resolveMatrixTargets({ cfg, inputs, kind, runtime }),
  },
  actions: matrixMessageActions,
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg: cfg as CoreConfig,
        channelKey: "matrix",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (input.useEnv) {
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
    applyAccountConfig: ({ cfg, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg: cfg as CoreConfig,
        channelKey: "matrix",
        accountId: DEFAULT_ACCOUNT_ID,
        name: input.name,
      });
      if (input.useEnv) {
        return {
          ...namedConfig,
          channels: {
            ...namedConfig.channels,
            matrix: {
              ...namedConfig.channels?.matrix,
              enabled: true,
            },
          },
        } as CoreConfig;
      }
      return buildMatrixConfigUpdate(namedConfig as CoreConfig, {
        homeserver: input.homeserver?.trim(),
        userId: input.userId?.trim(),
        accessToken: input.accessToken?.trim(),
        password: input.password?.trim(),
        deviceName: input.deviceName?.trim(),
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
