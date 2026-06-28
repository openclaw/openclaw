// Signal plugin module implements channel behavior.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { buildDmGroupAccountAllowlistAdapter } from "openclaw/plugin-sdk/allowlist-config-edit";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { defineChannelMessageAdapter } from "openclaw/plugin-sdk/channel-outbound";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/channel-outbound";
import { createPairingPrefixStripper } from "openclaw/plugin-sdk/channel-pairing";
import {
  attachChannelToResult,
  attachChannelToResults,
} from "openclaw/plugin-sdk/channel-send-result";
import { PAIRING_APPROVED_MESSAGE } from "openclaw/plugin-sdk/channel-status";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { resolveChannelMediaMaxBytes } from "openclaw/plugin-sdk/media-runtime";
import { chunkText, resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-chunking";
import { buildOutboundBaseSessionKey, type RoutePeer } from "openclaw/plugin-sdk/routing";
import {
  buildBaseChannelStatusSummary,
  collectStatusIssuesFromLastError,
  createComputedAccountStatusAdapter,
  createDefaultChannelRuntimeState,
} from "openclaw/plugin-sdk/status-helpers";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { resolveSignalAccount, type ResolvedSignalAccount } from "./accounts.js";
import {
  shouldSuppressLocalSignalExecApprovalPrompt,
  signalApprovalCapability,
} from "./approval-native.js";
import { markdownToSignalTextChunks } from "./format.js";
import { signalMessageActions } from "./message-actions.js";
import { looksLikeSignalTargetId, normalizeSignalMessagingTarget } from "./normalize.js";
import { resolveSignalOutboundTarget } from "./outbound-session.js";
import { resolveSignalReactionLevel } from "./reaction-level.js";
import { signalSetupAdapter } from "./setup-core.js";
import {
  createSignalPluginBase,
  signalConfigAdapter,
  signalSecurityAdapter,
  signalSetupWizard,
} from "./shared.js";
type SignalSendFn = typeof import("./send.runtime.js").sendMessageSignal;
type SignalProbe = import("./probe.js").SignalProbe;
type SignalApprovalReactionsModule = typeof import("./approval-reactions.js");

let signalMonitorModulePromise: Promise<typeof import("./monitor.js")> | null = null;
let signalProbeModulePromise: Promise<typeof import("./probe.js")> | null = null;
let signalSendRuntimePromise: Promise<typeof import("./send.runtime.js")> | null = null;
let signalApprovalReactionsModulePromise: Promise<SignalApprovalReactionsModule> | null = null;

async function loadSignalMonitorModule() {
  signalMonitorModulePromise ??= import("./monitor.js");
  return await signalMonitorModulePromise;
}

async function loadSignalProbeModule() {
  signalProbeModulePromise ??= import("./probe.js");
  return await signalProbeModulePromise;
}

async function loadSignalSendRuntime() {
  signalSendRuntimePromise ??= import("./send.runtime.js");
  return await signalSendRuntimePromise;
}

async function loadSignalApprovalReactionsModule() {
  signalApprovalReactionsModulePromise ??= import("./approval-reactions.js");
  return await signalApprovalReactionsModulePromise;
}

async function resolveSignalSendContext(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  accountId?: string;
  deps?: { [channelId: string]: unknown };
}) {
  const send =
    resolveOutboundSendDep<SignalSendFn>(params.deps, "signal") ??
    (await loadSignalSendRuntime()).sendMessageSignal;
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
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  accountId?: string;
  deps?: { [channelId: string]: unknown };
}) {
  const { send, maxBytes } = await resolveSignalSendContext(params);
  return await send(params.to, params.text, {
    cfg: params.cfg,
    ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    ...(params.mediaLocalRoots?.length ? { mediaLocalRoots: params.mediaLocalRoots } : {}),
    ...(params.mediaReadFile ? { mediaReadFile: params.mediaReadFile } : {}),
    maxBytes,
    accountId: params.accountId ?? undefined,
  });
}

type SignalMessageContextExtras = {
  deps?: { [channelId: string]: unknown };
};

function attachSignalVisibleText<T extends object>(result: T, visibleText: string) {
  const meta =
    "meta" in result && result.meta && typeof result.meta === "object"
      ? (result.meta as Record<string, unknown>)
      : {};
  return {
    ...result,
    meta: {
      ...meta,
      signalVisibleText: visibleText,
    },
  };
}

const signalMessageAdapter = defineChannelMessageAdapter({
  id: "signal",
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
    },
  },
  send: {
    text: async (ctx) =>
      await sendSignalOutbound({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        accountId: ctx.accountId ?? undefined,
        deps: (ctx as typeof ctx & SignalMessageContextExtras).deps,
      }),
    media: async (ctx) =>
      await sendSignalOutbound({
        cfg: ctx.cfg,
        to: ctx.to,
        text: ctx.text,
        mediaUrl: ctx.mediaUrl,
        mediaLocalRoots: ctx.mediaLocalRoots,
        mediaReadFile: ctx.mediaReadFile,
        accountId: ctx.accountId ?? undefined,
        deps: (ctx as typeof ctx & SignalMessageContextExtras).deps,
      }),
  },
});

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
  const lower = normalizeLowercaseStringOrEmpty(to);
  if (lower.startsWith("group:")) {
    return "group" as const;
  }
  if (lower.startsWith("username:") || lower.startsWith("u:")) {
    return "direct" as const;
  }
  return "direct" as const;
}

function buildSignalBaseSessionKey(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  peer: RoutePeer;
}) {
  return buildOutboundBaseSessionKey({ ...params, channel: "signal" });
}

function resolveSignalOutboundSessionRoute(params: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  agentId: string;
  accountId?: string | null;
  target: string;
}) {
  const resolved = resolveSignalOutboundTarget(params.target);
  if (!resolved) {
    return null;
  }
  const baseSessionKey = buildSignalBaseSessionKey({
    cfg: params.cfg,
    agentId: params.agentId,
    accountId: params.accountId,
    peer: resolved.peer,
  });
  return {
    sessionKey: baseSessionKey,
    baseSessionKey,
    ...resolved,
  };
}

async function sendFormattedSignalText(ctx: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  text: string;
  accountId?: string | null;
  replyToId?: string | null;
  quoteAuthor?: string | null;
  deps?: { [channelId: string]: unknown };
  abortSignal?: AbortSignal;
}) {
  const { send, maxBytes } = await resolveSignalSendContext({
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
  let first = true;
  for (const chunk of chunks) {
    ctx.abortSignal?.throwIfAborted();
    const result = await send(ctx.to, chunk.text, {
      cfg: ctx.cfg,
      maxBytes,
      accountId: ctx.accountId ?? undefined,
      replyTo: first ? (ctx.replyToId ?? undefined) : undefined,
      quoteAuthor: first ? (ctx.quoteAuthor ?? undefined) : undefined,
      textMode: "plain",
      textStyles: chunk.styles,
    });
    results.push(attachSignalVisibleText(result, chunk.text));
    first = false;
  }
  return attachChannelToResults("signal", results);
}

async function sendFormattedSignalMedia(ctx: {
  cfg: Parameters<typeof resolveSignalAccount>[0]["cfg"];
  to: string;
  text: string;
  mediaUrl: string;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  accountId?: string | null;
  replyToId?: string | null;
  quoteAuthor?: string | null;
  deps?: { [channelId: string]: unknown };
  abortSignal?: AbortSignal;
}) {
  ctx.abortSignal?.throwIfAborted();
  const { send, maxBytes } = await resolveSignalSendContext({
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
    ...(ctx.mediaReadFile ? { mediaReadFile: ctx.mediaReadFile } : {}),
    maxBytes,
    accountId: ctx.accountId ?? undefined,
    replyTo: ctx.replyToId ?? undefined,
    quoteAuthor: ctx.quoteAuthor ?? undefined,
    textMode: "plain",
    textStyles: formatted.styles,
  });
  return attachChannelToResult("signal", attachSignalVisibleText(result, formatted.text));
}

async function registerDeliveredSignalApprovalPayloadForReactions(
  params: Parameters<NonNullable<ChannelOutboundAdapter["afterDeliverPayload"]>>[0],
) {
  const account = resolveSignalAccount({
    cfg: params.cfg,
    accountId: params.target.accountId ?? undefined,
  });
  if (!account.config.account) {
    return;
  }
  const { registerSignalApprovalReactionTargetForDeliveredPayload } =
    await loadSignalApprovalReactionsModule();
  registerSignalApprovalReactionTargetForDeliveredPayload({
    cfg: params.cfg,
    target: params.target,
    payload: params.payload,
    results: params.results,
    targetAuthor: account.config.account,
  });
}

async function renderSignalApprovalPayloadForReactions(
  params: Parameters<NonNullable<ChannelOutboundAdapter["renderPresentation"]>>[0],
) {
  const account = resolveSignalAccount({
    cfg: params.ctx.cfg,
    accountId: params.ctx.accountId ?? undefined,
  });
  if (!account.config.account) {
    return null;
  }
  const { addSignalApprovalReactionHintToStructuredPayload } =
    await loadSignalApprovalReactionsModule();
  return addSignalApprovalReactionHintToStructuredPayload({
    cfg: params.ctx.cfg,
    accountId: params.ctx.accountId ?? undefined,
    to: params.ctx.to,
    payload: params.payload,
    targetAuthor: account.config.account,
  });
}

export const signalPlugin: ChannelPlugin<ResolvedSignalAccount, SignalProbe> =
  createChatChannelPlugin({
    base: {
      ...createSignalPluginBase({
        setupWizard: signalSetupWizard,
        setup: signalSetupAdapter,
      }),
      actions: signalMessageActions,
      approvalCapability: signalApprovalCapability,
      allowlist: buildDmGroupAccountAllowlistAdapter({
        channelId: "signal",
        resolveAccount: resolveSignalAccount,
        normalize: ({ cfg, accountId, values }) =>
          signalConfigAdapter.formatAllowFrom!({ cfg, accountId, allowFrom: values }),
        resolveDmAllowFrom: (account) => account.config.allowFrom,
        resolveGroupAllowFrom: (account) => account.config.groupAllowFrom,
        resolveDmPolicy: (account) => account.config.dmPolicy,
        resolveGroupPolicy: (account) => account.config.groupPolicy,
      }),
      agentPrompt: {
        reactionGuidance: ({ cfg, accountId }) => {
          const level = resolveSignalReactionLevel({
            cfg,
            accountId: accountId ?? undefined,
          }).agentReactionGuidance;
          return level ? { level, channelLabel: "Signal" } : undefined;
        },
      },
      messaging: {
        targetPrefixes: ["signal"],
        normalizeTarget: normalizeSignalMessagingTarget,
        inferTargetChatType: ({ to }) => inferSignalTargetChatType(to),
        resolveOutboundSessionRoute: (params) => resolveSignalOutboundSessionRoute(params),
        targetResolver: {
          looksLikeId: looksLikeSignalTargetId,
          hint: "<E.164|uuid:ID|group:ID|signal:group:ID|signal:+E.164>",
        },
      },
      heartbeat: {
        sendTyping: async ({ cfg, to, accountId }) => {
          await (
            await loadSignalSendRuntime()
          ).sendTypingSignal(to, {
            cfg,
            ...(accountId ? { accountId } : {}),
          });
        },
        clearTyping: async ({ cfg, to, accountId }) => {
          await (
            await loadSignalSendRuntime()
          ).sendTypingSignal(to, {
            cfg,
            ...(accountId ? { accountId } : {}),
            stop: true,
          });
        },
      },
      status: createComputedAccountStatusAdapter<ResolvedSignalAccount, SignalProbe>({
        defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID),
        collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("signal", accounts),
        buildChannelSummary: ({ snapshot }) =>
          buildBaseChannelStatusSummary(snapshot, {
            baseUrl: snapshot.baseUrl ?? null,
            probe: snapshot.probe,
            lastProbeAt: snapshot.lastProbeAt ?? null,
          }),
        probeAccount: async ({ account, timeoutMs }) => {
          const baseUrl = account.baseUrl;
          const { probeSignal } = await loadSignalProbeModule();
          return await probeSignal(baseUrl, timeoutMs, {
            apiMode: account.config?.apiMode ?? "auto",
          });
        },
        formatCapabilitiesProbe: ({ probe }) =>
          probe?.version ? [{ text: `Signal daemon: ${probe.version}` }] : [],
        resolveAccountSnapshot: ({ account }) => ({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          extra: {
            baseUrl: account.baseUrl,
          },
        }),
      }),
      gateway: {
        startAccount: async (ctx) => {
          const account = ctx.account;
          ctx.setStatus({
            accountId: account.accountId,
            baseUrl: account.baseUrl,
          });
          ctx.log?.info(`[${account.accountId}] starting provider (${account.baseUrl})`);
          const { monitorSignalProvider } = await loadSignalMonitorModule();
          return await monitorSignalProvider({
            accountId: account.accountId,
            config: ctx.cfg,
            runtime: ctx.runtime,
            channelRuntime: ctx.channelRuntime,
            abortSignal: ctx.abortSignal,
            mediaMaxMb: account.config.mediaMaxMb,
          });
        },
      },
      message: signalMessageAdapter,
    },
    pairing: {
      text: {
        idLabel: "signalNumber",
        message: PAIRING_APPROVED_MESSAGE,
        normalizeAllowEntry: createPairingPrefixStripper(/^signal:/i),
        notify: async ({ cfg, id, message }) => {
          await (
            await loadSignalSendRuntime()
          ).sendMessageSignal(id, message, {
            cfg,
          });
        },
      },
    },
    security: signalSecurityAdapter,
    outbound: {
      base: {
        deliveryMode: "direct",
        chunker: chunkText,
        chunkerMode: "text",
        textChunkLimit: 4000,
        sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
        shouldSuppressLocalPayloadPrompt: ({ cfg, accountId, payload, hint }) =>
          shouldSuppressLocalSignalExecApprovalPrompt({
            cfg,
            accountId,
            payload,
            hint,
          }),
        afterDeliverPayload: async (params) =>
          await registerDeliveredSignalApprovalPayloadForReactions(params),
        renderPresentation: async (params) => await renderSignalApprovalPayloadForReactions(params),
        sendFormattedText: async ({
          cfg,
          to,
          text,
          accountId,
          replyToId,
          quoteAuthor,
          deps,
          abortSignal,
        }) =>
          await sendFormattedSignalText({
            cfg,
            to,
            text,
            accountId,
            replyToId,
            quoteAuthor,
            deps,
            abortSignal,
          }),
        sendFormattedMedia: async ({
          cfg,
          to,
          text,
          mediaUrl,
          mediaLocalRoots,
          mediaReadFile,
          accountId,
          replyToId,
          quoteAuthor,
          deps,
          abortSignal,
        }) =>
          await sendFormattedSignalMedia({
            cfg,
            to,
            text,
            mediaUrl,
            mediaLocalRoots,
            mediaReadFile,
            accountId,
            replyToId,
            quoteAuthor,
            deps,
            abortSignal,
          }),
      },
      attachedResults: {
        channel: "signal",
        sendText: async ({ cfg, to, text, accountId, deps }) =>
          await sendSignalOutbound({
            cfg,
            to,
            text,
            accountId: accountId ?? undefined,
            deps,
          }),
        sendMedia: async ({
          cfg,
          to,
          text,
          mediaUrl,
          mediaLocalRoots,
          mediaReadFile,
          accountId,
          deps,
        }) =>
          await sendSignalOutbound({
            cfg,
            to,
            text,
            mediaUrl,
            mediaLocalRoots,
            mediaReadFile,
            accountId: accountId ?? undefined,
            deps,
          }),
      },
    },
  });
