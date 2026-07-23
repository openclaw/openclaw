// Rcs plugin module implements channel behavior.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import {
  createHybridChannelConfigAdapter,
  createScopedDmSecurityResolver,
} from "openclaw/plugin-sdk/channel-config-helpers";
import { createChatChannelPlugin, type ChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import {
  createMessageReceiptFromOutboundResults,
  defineChannelMessageAdapter,
} from "openclaw/plugin-sdk/channel-outbound";
import { createConditionalWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-send-result";
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { resolveOutboundMediaUrls } from "openclaw/plugin-sdk/reply-payload";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import {
  inspectRcsAccount,
  isRcsAccountConfigured,
  listRcsAccountIds,
  resolveDefaultRcsAccountId,
  resolveRcsAccount,
} from "./accounts.js";
import { looksLikeRcsTarget, normalizeRcsAllowFrom, normalizeRcsIdentity } from "./address.js";
import { RcsChannelConfigSchema } from "./config-schema.js";
import { presentationToTwilioContent, type TwilioContentSpec } from "./content.js";
import { collectRcsStartupWarnings, startRcsGatewayAccount } from "./gateway.js";
import type { RcsChannelRuntime } from "./inbound.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { sendRcsMedia, sendRcsTextChunks, toRcsPlainText } from "./send.js";
import {
  buildRcsDeliveryStatusLines,
  formatRcsProbeLines,
  probeRcsAccount,
  type RcsProbe,
} from "./status.js";
import { sendRcsContentViaTwilio } from "./twilio.js";
import type { ResolvedRcsAccount } from "./types.js";

const CHANNEL_ID = "rcs";

const rcsConfigAdapter = createHybridChannelConfigAdapter<ResolvedRcsAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds: listRcsAccountIds,
  resolveAccount: resolveRcsAccount,
  defaultAccountId: resolveDefaultRcsAccountId,
  clearBaseFields: [
    "accountSid",
    "authToken",
    "messagingServiceSid",
    "senderId",
    "transport",
    "defaultTo",
    "webhookPath",
    "publicWebhookUrl",
    "statusCallbacks",
    "dangerouslyDisableSignatureValidation",
    "dmPolicy",
    "allowFrom",
    "textChunkLimit",
  ],
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) =>
    normalizeStringEntries(allowFrom.map((entry) => normalizeRcsAllowFrom(String(entry)))),
  resolveDefaultTo: (account) => account.defaultTo,
});

const resolveRcsDmPolicy = createScopedDmSecurityResolver<ResolvedRcsAccount>({
  channelKey: CHANNEL_ID,
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowFrom,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "pairing",
  approveHint: "openclaw pairing approve rcs <code>",
  normalizeEntry: normalizeRcsAllowFrom,
});

const collectRcsSecurityWarnings = createConditionalWarningCollector<ResolvedRcsAccount>(
  (account) =>
    account.dangerouslyDisableSignatureValidation &&
    "- RCS: Twilio signature validation is disabled. Only use this for local testing.",
  (account) =>
    account.dmPolicy === "open" &&
    account.allowFrom.includes("*") &&
    '- RCS: dmPolicy="open" allows any phone number to message the bot.',
);

function rcsSetupPatch(input: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of [
    "accountSid",
    "authToken",
    "messagingServiceSid",
    "senderId",
    "transport",
    "defaultTo",
    "webhookPath",
    "publicWebhookUrl",
    "statusCallbacks",
    "dmPolicy",
    "allowFrom",
  ]) {
    if (input[key] !== undefined) {
      patch[key] = input[key];
    }
  }
  return patch;
}

function applyRcsAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: Record<string, unknown>;
}): OpenClawConfig {
  const patch = rcsSetupPatch(params.input);
  const channels = { ...params.cfg.channels };
  const current = { ...(channels[CHANNEL_ID] as Record<string, unknown> | undefined) };
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    channels[CHANNEL_ID] = { ...current, ...patch };
    return { ...params.cfg, channels };
  }
  const accounts = { ...(current.accounts as Record<string, unknown> | undefined) };
  accounts[params.accountId] = {
    ...(accounts[params.accountId] as Record<string, unknown> | undefined),
    ...patch,
  };
  channels[CHANNEL_ID] = { ...current, accounts };
  return { ...params.cfg, channels };
}

function createRcsReceipt(params: {
  results: Array<{ sid: string; to: string; from?: string; status?: string }>;
  kind: "text" | "media";
}) {
  const first = params.results[0];
  if (!first) {
    throw new Error("RCS send did not return a Twilio Message SID.");
  }
  return {
    channel: CHANNEL_ID,
    messageId: first.sid,
    chatId: first.to,
    receipt: createMessageReceiptFromOutboundResults({
      results: params.results.map((result) => ({
        channel: CHANNEL_ID,
        messageId: result.sid,
        chatId: result.to,
        toJid: result.to,
        conversationId: result.to,
        meta: {
          ...(result.from ? { from: result.from } : {}),
          ...(result.status ? { status: result.status } : {}),
        },
      })),
      threadId: first.to,
      kind: params.kind,
    }),
  };
}

function resolveRcsTextChunkLimit(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  fallbackLimit?: number;
}): number {
  return (
    resolveRcsAccount(params.cfg, params.accountId).textChunkLimit || params.fallbackLimit || 1600
  );
}

function resolveRcsTo(ctx: { cfg: OpenClawConfig; accountId?: string | null; to: string }): {
  account: ResolvedRcsAccount;
  to: string;
} {
  const account = resolveRcsAccount(ctx.cfg, ctx.accountId);
  const to = normalizeRcsIdentity(ctx.to) || account.defaultTo;
  if (!looksLikeRcsTarget(to)) {
    throw new Error(`Invalid RCS target: ${ctx.to}`);
  }
  return { account, to };
}

async function sendRcsText(ctx: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
}) {
  const { account, to } = resolveRcsTo(ctx);
  const results = await sendRcsTextChunks({ account, to, text: ctx.text });
  return createRcsReceipt({ results, kind: "text" });
}

async function sendRcsMediaMessage(ctx: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
}) {
  const { account, to } = resolveRcsTo(ctx);
  const mediaUrls = resolveOutboundMediaUrls(ctx) ?? [];
  if (!mediaUrls.length) {
    if (!ctx.text) {
      throw new Error("RCS media send requires mediaUrl or text.");
    }
    const results = await sendRcsTextChunks({ account, to, text: ctx.text });
    return createRcsReceipt({ results, kind: "text" });
  }
  const results = await sendRcsMedia({
    account,
    to,
    mediaUrls,
    ...(ctx.text ? { text: ctx.text } : {}),
  });
  return createRcsReceipt({ results, kind: "media" });
}

type RcsChannelData = { rcs?: { content?: TwilioContentSpec } };

type RcsRenderParams = Parameters<NonNullable<ChannelOutboundAdapter["renderPresentation"]>>[0];
type RcsPayloadContext = Parameters<NonNullable<ChannelOutboundAdapter["sendPayload"]>>[0];

// RCS Business Messaging rich-content limits (Twilio Content API): up to 11
// suggested replies/actions per message with short suggestion text. Core adapts
// portable presentation blocks to these bounds before renderPresentation runs.
const RCS_PRESENTATION_CAPABILITIES = {
  supported: true,
  buttons: true,
  selects: true,
  context: true,
  divider: false,
  charts: false,
  tables: false,
  limits: {
    actions: {
      maxActions: 11,
      maxActionsPerRow: 11,
      maxRows: 1,
      maxLabelLength: 20,
      maxValueBytes: 200,
      supportsStyles: false,
      supportsDisabled: false,
    },
    selects: {
      maxOptions: 11,
      maxLabelLength: 20,
      maxValueBytes: 200,
    },
    text: {
      maxLength: 1600,
      encoding: "characters" as const,
      markdownDialect: "plain" as const,
    },
  },
} satisfies NonNullable<ChannelOutboundAdapter["presentationCapabilities"]>;

// Translate an adapted portable presentation into a Twilio RCS content template
// stashed on channelData; returning null lets core fall back to plain text.
function renderRcsPresentation(params: RcsRenderParams): RcsRenderParams["payload"] | null {
  const content = presentationToTwilioContent({
    presentation: params.presentation,
    fallbackText: params.payload.text,
    mediaUrls: resolveOutboundMediaUrls(params.payload),
  });
  if (!content) {
    return null;
  }
  return {
    ...params.payload,
    channelData: {
      ...params.payload.channelData,
      rcs: { content } satisfies RcsChannelData["rcs"],
    },
  };
}

async function sendRcsPayload(ctx: RcsPayloadContext) {
  const content = (ctx.payload.channelData as RcsChannelData | undefined)?.rcs?.content;
  if (content) {
    const { account, to } = resolveRcsTo({ cfg: ctx.cfg, accountId: ctx.accountId, to: ctx.to });
    const result = await sendRcsContentViaTwilio({ account, to, content });
    return createRcsReceipt({ results: [result], kind: "text" });
  }
  // No rich content rendered onto this payload: deliver it exactly as the plain
  // text/media send paths do, so gateway routing to sendPayload never drops a
  // normal reply's media or text.
  const mediaUrls = resolveOutboundMediaUrls(ctx.payload);
  if (mediaUrls.length > 0) {
    return await sendRcsMediaMessage({
      cfg: ctx.cfg,
      accountId: ctx.accountId,
      to: ctx.to,
      ...(ctx.text ? { text: ctx.text } : {}),
      mediaUrls,
    });
  }
  return await sendRcsText({ cfg: ctx.cfg, accountId: ctx.accountId, to: ctx.to, text: ctx.text });
}

const rcsMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      media: true,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async (ctx) => await sendRcsText(ctx),
    media: async (ctx) => await sendRcsMediaMessage(ctx),
  },
});

export const rcsPlugin: ChannelPlugin<ResolvedRcsAccount, RcsProbe> = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "RCS",
      selectionLabel: "RCS (Twilio)",
      detailLabel: "Twilio RCS",
      docsPath: "/channels/rcs",
      docsLabel: "rcs",
      blurb: "Twilio RCS Business Messaging with rich media, read receipts, and SMS fallback.",
      order: 89,
    },
    capabilities: {
      chatTypes: ["direct"],
      media: true,
      threads: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: false,
      effects: false,
      blockStreaming: false,
    },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
    configSchema: RcsChannelConfigSchema,
    setup: {
      applyAccountConfig: applyRcsAccountConfig,
    },
    config: {
      ...rcsConfigAdapter,
      inspectAccount: inspectRcsAccount,
      isConfigured: isRcsAccountConfigured,
      unconfiguredReason: () =>
        "RCS requires accountSid, authToken, and messagingServiceSid or senderId.",
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.senderId || account.messagingServiceSid || "RCS",
        configured: isRcsAccountConfigured(account),
        enabled: account.enabled,
      }),
    },
    messaging: {
      targetPrefixes: ["rcs", "twilio-rcs"],
      normalizeTarget: (target) => normalizeRcsIdentity(target),
      targetResolver: {
        looksLikeId: looksLikeRcsTarget,
        hint: "<+15551234567 or rcs:+15551234567>",
      },
    },
    directory: createEmptyChannelDirectoryAdapter(),
    gateway: {
      startAccount: async (ctx) => {
        if (!ctx.channelRuntime) {
          ctx.log?.warn?.("RCS channel runtime is not available; webhook route not started");
          return;
        }
        return await startRcsGatewayAccount({
          cfg: ctx.cfg,
          account: ctx.account,
          channelRuntime: ctx.channelRuntime as unknown as RcsChannelRuntime,
          abortSignal: ctx.abortSignal,
          log: ctx.log,
        });
      },
    },
    status: {
      buildAccountSnapshot: ({ account }) => {
        const configured = isRcsAccountConfigured(account);
        return {
          accountId: account.accountId,
          name: account.senderId || account.messagingServiceSid || "RCS",
          enabled: account.enabled,
          configured,
          statusState: !account.enabled ? "disabled" : configured ? "configured" : "unconfigured",
        };
      },
      probeAccount: async ({ account, timeoutMs }) => await probeRcsAccount({ account, timeoutMs }),
      formatCapabilitiesProbe: ({ probe }) => formatRcsProbeLines(probe),
      buildCapabilitiesDiagnostics: async ({ account }) => ({
        lines: [
          ...collectRcsStartupWarnings(account).map((text) => ({ text, tone: "warn" as const })),
          // Surface the recorded read/delivered receipts on the channel status
          // surface so the agent can see whether its last outbound RCS message
          // was delivered or read, without depending on a live Twilio probe.
          ...buildRcsDeliveryStatusLines(account.accountId),
        ],
      }),
    },
    secrets: {
      secretTargetRegistryEntries,
      collectRuntimeConfigAssignments,
    },
    agentPrompt: {
      messageToolHints: () => [
        "",
        "### RCS Formatting",
        "RCS renders plain text with generous length limits and rich media. Keep replies conversational; avoid markdown tables. Media must be public http(s) URLs.",
      ],
    },
    message: rcsMessageAdapter,
  },
  pairing: {
    text: {
      idLabel: "phoneNumber",
      message: "OpenClaw: your RCS access has been approved.",
      normalizeAllowEntry: normalizeRcsAllowFrom,
      notify: async ({ cfg, id, message, accountId }) => {
        const account = resolveRcsAccount(cfg, accountId);
        await sendRcsTextChunks({
          account,
          to: normalizeRcsIdentity(id),
          text: message,
        });
      },
    },
  },
  security: {
    resolveDmPolicy: resolveRcsDmPolicy,
    collectWarnings: ({ account }) => collectRcsSecurityWarnings(account),
  },
  outbound: {
    deliveryMode: "gateway",
    chunker: chunkTextForOutbound,
    chunkerMode: "text",
    textChunkLimit: 1600,
    resolveEffectiveTextChunkLimit: resolveRcsTextChunkLimit,
    resolveTarget: ({ cfg, to, accountId }) => {
      const explicit = normalizeRcsIdentity(to ?? "");
      if (explicit) {
        return { ok: true, to: explicit };
      }
      if (cfg) {
        const account = resolveRcsAccount(cfg, accountId);
        if (account.defaultTo) {
          return { ok: true, to: account.defaultTo };
        }
      }
      return { ok: false, error: new Error("RCS target must be an E.164 phone number.") };
    },
    sanitizeText: ({ text }) => toRcsPlainText(text),
    presentationCapabilities: RCS_PRESENTATION_CAPABILITIES,
    renderPresentation: renderRcsPresentation,
    sendPayload: sendRcsPayload,
    sendText: sendRcsText,
    sendMedia: async (ctx) => await sendRcsMediaMessage(ctx),
  },
});
