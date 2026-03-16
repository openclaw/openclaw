import {
  buildAccountScopedAllowlistConfigEditor,
  buildAccountScopedDmSecurityPolicy,
  createScopedAccountConfigAccessors,
  collectAllowlistProviderRestrictSendersWarnings,
} from "openclaw/plugin-sdk/compat";
import {
  buildBaseAccountStatusSnapshot,
  buildBaseChannelStatusSummary,
  buildChannelConfigSchema,
  collectStatusIssuesFromLastError,
  createDefaultChannelRuntimeState,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  getChatChannelMeta,
  listSignalAccountIds,
  looksLikeSignalTargetId,
  normalizeE164,
  normalizeSignalMessagingTarget,
  PAIRING_APPROVED_MESSAGE,
  resolveChannelMediaMaxBytes,
  resolveDefaultSignalAccountId,
  resolveSignalAccount,
  setAccountEnabledInConfigSection,
  SignalConfigSchema,
  type ChannelMessageActionAdapter,
  type ChannelPlugin,
  type ResolvedSignalAccount,
} from "openclaw/plugin-sdk/signal";
import { resolveTextChunkLimit } from "../../../src/auto-reply/chunk.js";
import { resolveMarkdownTableMode } from "../../../src/config/markdown-tables.js";
import { resolveOutboundSendDep } from "../../../src/infra/outbound/send-deps.js";
import { markdownToSignalTextChunks } from "./format.js";
import type { SignalProbe } from "./probe.js";
import { getSignalRuntime } from "./runtime.js";
import { createSignalSetupWizardProxy, signalSetupAdapter } from "./setup-core.js";

async function loadSignalChannelRuntime() {
  return await import("./channel.runtime.js");
}

const signalSetupWizard = createSignalSetupWizardProxy(async () => ({
  signalSetupWizard: (await loadSignalChannelRuntime()).signalSetupWizard,
}));

const signalMessageActions: ChannelMessageActionAdapter = {
  listActions: (ctx) => getSignalRuntime().channel.signal.messageActions?.listActions?.(ctx) ?? [],
  supportsAction: (ctx) =>
    getSignalRuntime().channel.signal.messageActions?.supportsAction?.(ctx) ?? false,
  handleAction: async (ctx) => {
    const ma = getSignalRuntime().channel.signal.messageActions;
    if (!ma?.handleAction) {
      throw new Error("Signal message actions not available");
    }
    return ma.handleAction(ctx);
  },
};

const signalConfigAccessors = createScopedAccountConfigAccessors({
  resolveAccount: ({ cfg, accountId }) => resolveSignalAccount({ cfg, accountId }),
  resolveAllowFrom: (account: ResolvedSignalAccount) => account.config.allowFrom,
  formatAllowFrom: (allowFrom) =>
    allowFrom
      .map((entry) => String(entry).trim())
      .filter(Boolean)
      .map((entry) => (entry === "*" ? "*" : normalizeE164(entry.replace(/^signal:/i, ""))))
      .filter(Boolean),
  resolveDefaultTo: (account: ResolvedSignalAccount) => account.config.defaultTo,
});

type SignalSendFn = ReturnType<typeof getSignalRuntime>["channel"]["signal"]["sendMessageSignal"];

function resolveSignalSendContext(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string;
  deps?: { [channelId: string]: unknown };
}) {
  const send =
    resolveOutboundSendDep<SignalSendFn>(params.deps, "signal") ??
    getSignalRuntime().channel.signal.sendMessageSignal;
  const maxBytes = resolveChannelMediaMaxBytes({
    cfg: params.cfg,
    resolveChannelLimitMb: ({ cfg, accountId }) =>
      cfg.channels?.signal?.accounts?.[accountId]?.mediaMaxMb ?? cfg.channels?.signal?.mediaMaxMb,
    accountId: params.accountId,
  });
  return { send, maxBytes };
}

async function sendSignalOutbound(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  text: string;
  mediaUrl?: string;
  mediaLocalRoots?: readonly string[];
  accountId?: string;
  deps?: { [channelId: string]: unknown };
}) {
  const { send, maxBytes } = resolveSignalSendContext(params);
  return await send(params.to, params.text, {
    cfg: params.cfg,
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    maxBytes,
    accountId: params.accountId ?? undefined,
  });
}

function inferSignalTargetChatType(rawTo: string) {
  let to = rawTo.trim();
  if (!to) {
    return undefined;
  }
  if (/^signal:/i.test(to)) {
    to = to.replace(/^signal:/i, "").trim();
  }
  if (!to) {
    return undefined;
  }
  const lower = to.toLowerCase();
  if (lower.startsWith("group:")) {
    return "group" as const;
  }
  if (lower.startsWith("username:") || lower.startsWith("u:")) {
    return "direct" as const;
  }
  return "direct" as const;
}

function parseSignalExplicitTarget(raw: string) {
  const normalized = normalizeSignalMessagingTarget(raw);
  if (!normalized) {
    return null;
  }
  return {
    to: normalized,
    chatType: inferSignalTargetChatType(normalized),
  };
}

async function sendFormattedSignalText(ctx: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  text: string;
  accountId?: string | null;
  deps?: { [channelId: string]: unknown };
  abortSignal?: AbortSignal;
}) {
  const { send, maxBytes } = resolveSignalSendContext({
    cfg: ctx.cfg,
    accountId: ctx.accountId ?? undefined,
    deps: ctx.deps,
  });
  const limit = resolveTextChunkLimit(ctx.cfg, "signal", ctx.accountId ?? undefined, {
    fallbackLimit: 4000,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg: ctx.cfg,
    channel: "signal",
    accountId: ctx.accountId ?? undefined,
  });
  let chunks =
    limit === undefined
      ? markdownToSignalTextChunks(ctx.text, Number.POSITIVE_INFINITY, { tableMode })
      : markdownToSignalTextChunks(ctx.text, limit, { tableMode });
  if (chunks.length === 0 && ctx.text) {
    chunks = [{ text: ctx.text, styles: [] }];
  }
  const results = [];
  for (const chunk of chunks) {
    ctx.abortSignal?.throwIfAborted();
    const result = await send(ctx.to, chunk.text, {
      cfg: ctx.cfg,
      maxBytes,
      accountId: ctx.accountId ?? undefined,
      textMode: "plain",
      textStyles: chunk.styles,
    });
    results.push({ channel: "signal" as const, ...result });
  }
  return results;
}

async function sendFormattedSignalMedia(ctx: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  text: string;
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  accountId?: string | null;
  deps?: { [channelId: string]: unknown };
  abortSignal?: AbortSignal;
}) {
  ctx.abortSignal?.throwIfAborted();
  const { send, maxBytes } = resolveSignalSendContext({
    cfg: ctx.cfg,
    accountId: ctx.accountId ?? undefined,
    deps: ctx.deps,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg: ctx.cfg,
    channel: "signal",
    accountId: ctx.accountId ?? undefined,
  });
  const formatted = markdownToSignalTextChunks(ctx.text, Number.POSITIVE_INFINITY, {
    tableMode,
  })[0] ?? {
    text: ctx.text,
    styles: [],
  };
  const result = await send(ctx.to, formatted.text, {
    cfg: ctx.cfg,
    mediaUrl: ctx.mediaUrl,
    mediaLocalRoots: ctx.mediaLocalRoots,
    maxBytes,
    accountId: ctx.accountId ?? undefined,
    textMode: "plain",
    textStyles: formatted.styles,
  });
  return { channel: "signal" as const, ...result };
}

export const signalPlugin: ChannelPlugin<ResolvedSignalAccount> = {
  id: "signal",
  meta: {
    ...getChatChannelMeta("signal"),
  },
  setupWizard: signalSetupWizard,
  pairing: {
    idLabel: "signalNumber",
    normalizeAllowEntry: (entry) => entry.replace(/^signal:/i, ""),
    notifyApproval: async ({ id }) => {
      await getSignalRuntime().channel.signal.sendMessageSignal(id, PAIRING_APPROVED_MESSAGE);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    media: true,
    reactions: true,
  },
  actions: signalMessageActions,
  streaming: {
    blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
  },
  reload: { configPrefixes: ["channels.signal"] },
  configSchema: buildChannelConfigSchema(SignalConfigSchema),
  config: {
    listAccountIds: (cfg) => listSignalAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveSignalAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultSignalAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "signal",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "signal",
        accountId,
        clearBaseFields: ["account", "httpUrl", "httpHost", "httpPort", "cliPath", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      baseUrl: account.baseUrl,
    }),
    ...signalConfigAccessors,
  },
  allowlist: {
    supportsScope: ({ scope }) => scope === "dm" || scope === "group" || scope === "all",
    readConfig: ({ cfg, accountId }) => {
      const account = resolveSignalAccount({ cfg, accountId });
      return {
        dmAllowFrom: (account.config.allowFrom ?? []).map(String),
        groupAllowFrom: (account.config.groupAllowFrom ?? []).map(String),
        dmPolicy: account.config.dmPolicy,
        groupPolicy: account.config.groupPolicy,
      };
    },
    applyConfigEdit: buildAccountScopedAllowlistConfigEditor({
      channelId: "signal",
      normalize: ({ cfg, accountId, values }) =>
        signalConfigAccessors.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
      resolvePaths: (scope) => ({
        readPaths: [[scope === "dm" ? "allowFrom" : "groupAllowFrom"]],
        writePath: [scope === "dm" ? "allowFrom" : "groupAllowFrom"],
      }),
    }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      return buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: "signal",
        accountId,
        fallbackAccountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        policy: account.config.dmPolicy,
        allowFrom: account.config.allowFrom ?? [],
        policyPathSuffix: "dmPolicy",
        normalizeEntry: (raw) => normalizeE164(raw.replace(/^signal:/i, "").trim()),
      });
    },
    collectWarnings: ({ account, cfg }) => {
      return collectAllowlistProviderRestrictSendersWarnings({
        cfg,
        providerConfigPresent: cfg.channels?.signal !== undefined,
        configuredGroupPolicy: account.config.groupPolicy,
        surface: "Signal groups",
        openScope: "any member",
        groupPolicyPath: "channels.signal.groupPolicy",
        groupAllowFromPath: "channels.signal.groupAllowFrom",
        mentionGated: false,
      });
    },
  },
  messaging: {
    normalizeTarget: normalizeSignalMessagingTarget,
    parseExplicitTarget: ({ raw }) => parseSignalExplicitTarget(raw),
    inferTargetChatType: ({ to }) => inferSignalTargetChatType(to),
    targetResolver: {
      looksLikeId: looksLikeSignalTargetId,
      hint: "<E.164|uuid:ID|group:ID|signal:group:ID|signal:+E.164>",
    },
  },
  setup: signalSetupAdapter,
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getSignalRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 4000,
    sendFormattedText: async ({ cfg, to, text, accountId, deps, abortSignal }) =>
      await sendFormattedSignalText({
        cfg,
        to,
        text,
        accountId,
        deps,
        abortSignal,
      }),
    sendFormattedMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaLocalRoots,
      accountId,
      deps,
      abortSignal,
    }) =>
      await sendFormattedSignalMedia({
        cfg,
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId,
        deps,
        abortSignal,
      }),
    sendText: async ({ cfg, to, text, accountId, deps }) => {
      const result = await sendSignalOutbound({
        cfg,
        to,
        text,
        accountId: accountId ?? undefined,
        deps,
      });
      return { channel: "signal", ...result };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, mediaLocalRoots, accountId, deps }) => {
      const result = await sendSignalOutbound({
        cfg,
        to,
        text,
        mediaUrl,
        mediaLocalRoots,
        accountId: accountId ?? undefined,
        deps,
      });
      return { channel: "signal", ...result };
    },
  },
  status: {
    defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("signal", accounts),
    buildChannelSummary: ({ snapshot }) => ({
      ...buildBaseChannelStatusSummary(snapshot),
      baseUrl: snapshot.baseUrl ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) => {
      const baseUrl = account.baseUrl;
      return await getSignalRuntime().channel.signal.probeSignal(baseUrl, timeoutMs);
    },
    formatCapabilitiesProbe: ({ probe }) =>
      (probe as SignalProbe | undefined)?.version
        ? [{ text: `Signal daemon: ${(probe as SignalProbe).version}` }]
        : [],
    buildAccountSnapshot: ({ account, runtime, probe }) => ({
      ...buildBaseAccountStatusSnapshot({ account, runtime, probe }),
      baseUrl: account.baseUrl,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.setStatus({
        accountId: account.accountId,
        baseUrl: account.baseUrl,
      });
      ctx.log?.info(`[${account.accountId}] starting provider (${account.baseUrl})`);
      // Lazy import: the monitor pulls the reply pipeline; avoid ESM init cycles.
      return getSignalRuntime().channel.signal.monitorSignalProvider({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        mediaMaxMb: account.config.mediaMaxMb,
      });
    },
  },
};
