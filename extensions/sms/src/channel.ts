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
import { createEmptyChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { chunkTextForOutbound } from "openclaw/plugin-sdk/text-chunking";
import {
  inspectSmsAccount,
  isSmsAccountConfigured,
  listSmsAccountIds,
  resolveDefaultSmsAccountId,
  resolveSmsAccount,
} from "./accounts.js";
import { SmsChannelConfigSchema } from "./config-schema.js";
import { collectSmsStartupWarnings, startSmsGatewayAccount } from "./gateway.js";
import type { SmsChannelRuntime } from "./inbound.js";
import {
  looksLikeSmsPhoneNumber,
  normalizeSmsAllowFrom,
  normalizeSmsPhoneNumber,
} from "./phone.js";
import { sendSmsTextChunks } from "./send.js";
import { sendSmsViaTwilio } from "./twilio.js";
import type { ResolvedSmsAccount } from "./types.js";

const CHANNEL_ID = "sms";

const smsConfigAdapter = createHybridChannelConfigAdapter<ResolvedSmsAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds: listSmsAccountIds,
  resolveAccount: resolveSmsAccount,
  defaultAccountId: resolveDefaultSmsAccountId,
  clearBaseFields: [
    "accountSid",
    "authToken",
    "fromNumber",
    "webhookPath",
    "publicWebhookUrl",
    "dangerouslyDisableSignatureValidation",
    "dmPolicy",
    "allowFrom",
    "textChunkLimit",
  ],
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) =>
    normalizeStringEntries(allowFrom.map((entry) => normalizeSmsAllowFrom(String(entry)))),
});

const resolveSmsDmPolicy = createScopedDmSecurityResolver<ResolvedSmsAccount>({
  channelKey: CHANNEL_ID,
  resolvePolicy: (account) => account.dmPolicy,
  resolveAllowFrom: (account) => account.allowFrom,
  policyPathSuffix: "dmPolicy",
  defaultPolicy: "pairing",
  approveHint: "openclaw pairing approve sms <code>",
  normalizeEntry: normalizeSmsAllowFrom,
});

const collectSmsSecurityWarnings = createConditionalWarningCollector<ResolvedSmsAccount>(
  (account) =>
    account.dangerouslyDisableSignatureValidation &&
    "- SMS: Twilio signature validation is disabled. Only use this for local testing.",
  (account) =>
    account.dmPolicy === "open" &&
    account.allowFrom.includes("*") &&
    '- SMS: dmPolicy="open" allows any phone number to message the bot.',
);

function smsSetupPatch(input: Record<string, unknown>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of [
    "accountSid",
    "authToken",
    "fromNumber",
    "webhookPath",
    "publicWebhookUrl",
    "dmPolicy",
    "allowFrom",
  ]) {
    if (input[key] !== undefined) {
      patch[key] = input[key];
    }
  }
  return patch;
}

function applySmsAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId: string;
  input: Record<string, unknown>;
}): OpenClawConfig {
  const patch = smsSetupPatch(params.input);
  const channels = { ...(params.cfg.channels ?? {}) };
  const current = { ...((channels[CHANNEL_ID] as Record<string, unknown> | undefined) ?? {}) };
  if (params.accountId === DEFAULT_ACCOUNT_ID) {
    channels[CHANNEL_ID] = { ...current, ...patch };
    return { ...params.cfg, channels };
  }
  const accounts = { ...((current.accounts as Record<string, unknown> | undefined) ?? {}) };
  accounts[params.accountId] = {
    ...((accounts[params.accountId] as Record<string, unknown> | undefined) ?? {}),
    ...patch,
  };
  channels[CHANNEL_ID] = { ...current, accounts };
  return { ...params.cfg, channels };
}

function createSmsReceipt(params: {
  results: Array<{ sid: string; to: string }>;
  fallbackTo: string;
  kind: "text";
}) {
  const first = params.results[0];
  return {
    channel: CHANNEL_ID,
    messageId: first?.sid ?? `sms-${Date.now()}`,
    chatId: first?.to ?? params.fallbackTo,
    receipt: createMessageReceiptFromOutboundResults({
      results: params.results.map((result) => ({
        channel: CHANNEL_ID,
        messageId: result.sid,
        chatId: result.to,
        conversationId: result.to,
      })),
      threadId: first?.to ?? params.fallbackTo,
      kind: params.kind,
    }),
  };
}

export function resolveSmsTextChunkLimit(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  fallbackLimit?: number;
}): number {
  return (
    resolveSmsAccount(params.cfg, params.accountId).textChunkLimit || params.fallbackLimit || 1500
  );
}

async function sendSmsText(ctx: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  to: string;
  text: string;
}) {
  const account = resolveSmsAccount(ctx.cfg, ctx.accountId);
  const to = normalizeSmsPhoneNumber(ctx.to);
  if (!looksLikeSmsPhoneNumber(to)) {
    throw new Error(`Invalid SMS target: ${ctx.to}`);
  }
  const results = await sendSmsTextChunks({ account, to, text: ctx.text });
  return createSmsReceipt({ results, fallbackTo: to, kind: "text" });
}

const smsMessageAdapter = defineChannelMessageAdapter({
  id: CHANNEL_ID,
  durableFinal: {
    capabilities: {
      text: true,
      media: false,
      messageSendingHooks: true,
    },
  },
  send: {
    text: async (ctx) => await sendSmsText(ctx),
  },
});

export const smsPlugin: ChannelPlugin<ResolvedSmsAccount> = createChatChannelPlugin({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: "SMS",
      selectionLabel: "SMS (Twilio)",
      detailLabel: "Twilio SMS",
      docsPath: "/channels/sms",
      docsLabel: "sms",
      blurb: "Twilio-backed SMS with inbound webhooks and outbound replies.",
      order: 88,
    },
    capabilities: {
      chatTypes: ["direct"],
      media: false,
      threads: false,
      reactions: false,
      edit: false,
      unsend: false,
      reply: false,
      effects: false,
      blockStreaming: false,
    },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
    configSchema: SmsChannelConfigSchema,
    setup: {
      applyAccountConfig: applySmsAccountConfig,
    },
    config: {
      ...smsConfigAdapter,
      inspectAccount: inspectSmsAccount,
      isConfigured: isSmsAccountConfigured,
      unconfiguredReason: () => "SMS requires accountSid, authToken, and fromNumber.",
      describeAccount: (account) => ({
        accountId: account.accountId,
        name: account.fromNumber || "SMS",
        configured: isSmsAccountConfigured(account),
        enabled: account.enabled,
      }),
    },
    messaging: {
      targetPrefixes: ["sms"],
      normalizeTarget: (target) => normalizeSmsPhoneNumber(target),
      targetResolver: {
        looksLikeId: looksLikeSmsPhoneNumber,
        hint: "<+15551234567>",
      },
    },
    directory: createEmptyChannelDirectoryAdapter(),
    gateway: {
      startAccount: async (ctx) => {
        if (!ctx.channelRuntime) {
          ctx.log?.warn?.("SMS channel runtime is not available; webhook route not started");
          return;
        }
        return await startSmsGatewayAccount({
          cfg: ctx.cfg,
          account: ctx.account,
          channelRuntime: ctx.channelRuntime as unknown as SmsChannelRuntime,
          abortSignal: ctx.abortSignal,
          log: ctx.log,
        });
      },
    },
    status: {
      buildCapabilitiesDiagnostics: async ({ account }) => ({
        lines: collectSmsStartupWarnings(account).map((text) => ({ text, tone: "warn" })),
      }),
    },
    agentPrompt: {
      messageToolHints: () => [
        "",
        "### SMS Formatting",
        "SMS is plain text only. Keep replies brief, avoid markdown tables, and split long details into short messages.",
      ],
    },
    message: smsMessageAdapter,
  },
  pairing: {
    text: {
      idLabel: "phoneNumber",
      message: "OpenClaw: your SMS access has been approved.",
      normalizeAllowEntry: normalizeSmsAllowFrom,
      notify: async ({ cfg, id, message, accountId }) => {
        const account = resolveSmsAccount(cfg, accountId);
        await sendSmsViaTwilio({
          account,
          to: normalizeSmsPhoneNumber(id),
          text: message,
        });
      },
    },
  },
  security: {
    resolveDmPolicy: resolveSmsDmPolicy,
    collectWarnings: ({ account }) => collectSmsSecurityWarnings(account),
  },
  outbound: {
    deliveryMode: "gateway",
    chunker: chunkTextForOutbound,
    chunkerMode: "text",
    textChunkLimit: 1500,
    resolveEffectiveTextChunkLimit: resolveSmsTextChunkLimit,
    sendText: sendSmsText,
  },
});
