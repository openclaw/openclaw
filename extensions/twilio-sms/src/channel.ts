import {
  buildAccountScopedDmSecurityPolicy,
  createAccountStatusSink,
  formatNormalizedAllowFromEntries,
  mapAllowFromEntries,
} from "openclaw/plugin-sdk/compat";
import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
  OpenClawConfig,
} from "openclaw/plugin-sdk/twilio-sms";
import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  buildComputedAccountStatusSnapshot,
  buildProbeChannelStatusSummary,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  normalizeAccountId,
  normalizeE164,
  PAIRING_APPROVED_MESSAGE,
  setAccountEnabledInConfigSection,
  waitUntilAbort,
} from "openclaw/plugin-sdk/twilio-sms";
import type { ChannelSetupInput } from "openclaw/plugin-sdk/twilio-sms";
import {
  listTwilioSmsAccountIds,
  resolveDefaultTwilioSmsAccountId,
  resolveTwilioSmsAccount,
} from "./accounts.js";
import { TwilioSmsConfigSchema } from "./config-schema.js";
import { registerTwilioSmsWebhookTarget, resolveWebhookPathFromConfig } from "./monitor.js";
import { twilioSmsOnboardingAdapter } from "./onboarding.js";
import { probeTwilioSms, type TwilioSmsProbe } from "./probe.js";
import { getTwilioSmsRuntime } from "./runtime.js";
import { sendTwilioSms } from "./send.js";
import {
  looksLikeTwilioSmsTargetId,
  normalizeTwilioSmsAllowEntry,
  normalizeTwilioSmsTarget,
} from "./targets.js";
import type { ResolvedTwilioSmsAccount } from "./types.js";

type TwilioSmsSetupInput = ChannelSetupInput & {
  accountSid?: string;
  authToken?: string;
  phoneNumber?: string;
};

const meta = {
  id: "twilio-sms",
  label: "Twilio SMS",
  selectionLabel: "Twilio SMS",
  detailLabel: "Twilio SMS",
  docsPath: "/channels/twilio-sms",
  docsLabel: "twilio-sms",
  blurb: "SMS/MMS messaging via Twilio Programmable Messaging.",
  systemImage: "message.fill",
  order: 85,
};

export const twilioSmsPlugin: ChannelPlugin<ResolvedTwilioSmsAccount> = {
  id: "twilio-sms",
  meta,
  capabilities: {
    chatTypes: ["direct"],
    media: true,
    reactions: false,
    blockStreaming: true,
  },
  reload: { configPrefixes: ["channels.twilio-sms"] },
  configSchema: buildChannelConfigSchema(TwilioSmsConfigSchema),
  onboarding: twilioSmsOnboardingAdapter,
  config: {
    listAccountIds: (cfg) => listTwilioSmsAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveTwilioSmsAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultTwilioSmsAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "twilio-sms",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "twilio-sms",
        accountId,
        clearBaseFields: ["accountSid", "authToken", "phoneNumber", "webhookPath", "name"],
      }),
    isConfigured: (account) => account.configured,
    describeAccount: (account): ChannelAccountSnapshot => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      mapAllowFromEntries(resolveTwilioSmsAccount({ cfg, accountId }).config.allowFrom),
    formatAllowFrom: ({ allowFrom }) =>
      formatNormalizedAllowFromEntries({
        allowFrom,
        normalizeEntry: (entry) => normalizeTwilioSmsAllowEntry(entry),
      }),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      return buildAccountScopedDmSecurityPolicy({
        cfg,
        channelKey: "twilio-sms",
        accountId,
        fallbackAccountId: account.accountId ?? DEFAULT_ACCOUNT_ID,
        policy: account.config.dmPolicy,
        allowFrom: account.config.allowFrom ?? [],
        policyPathSuffix: "dmPolicy",
        normalizeEntry: (raw) => normalizeTwilioSmsAllowEntry(raw),
      });
    },
  },
  messaging: {
    normalizeTarget: normalizeTwilioSmsTarget,
    targetResolver: {
      looksLikeId: looksLikeTwilioSmsTargetId,
      hint: "<phone_number_e164>",
    },
    formatTargetDisplay: ({ target, display }) => {
      return display?.trim() || target?.trim() || "";
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "twilio-sms",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      const setupInput = input as TwilioSmsSetupInput;
      if (!setupInput.accountSid && !setupInput.authToken && !setupInput.phoneNumber) {
        return "Twilio SMS requires accountSid, authToken, and phoneNumber.";
      }
      if (!setupInput.accountSid) {
        return "Twilio SMS requires accountSid.";
      }
      if (!setupInput.authToken) {
        return "Twilio SMS requires authToken.";
      }
      if (!setupInput.phoneNumber) {
        return "Twilio SMS requires phoneNumber.";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const setupInput = input as TwilioSmsSetupInput;
      const base = applyAccountNameToChannelSection({
        cfg,
        channelKey: "twilio-sms",
        accountId,
        name: setupInput.name,
      });
      const section = (base.channels?.["twilio-sms"] ?? {}) as Record<string, unknown>;
      const accounts = (section.accounts ?? {}) as Record<string, Record<string, unknown>>;
      const acct = accounts[accountId] ?? {};
      if (setupInput.accountSid) {
        acct.accountSid = setupInput.accountSid;
      }
      if (setupInput.authToken) {
        acct.authToken = setupInput.authToken;
      }
      if (setupInput.phoneNumber) {
        acct.phoneNumber = setupInput.phoneNumber;
      }
      if (setupInput.webhookPath) {
        acct.webhookPath = setupInput.webhookPath;
      }
      accounts[accountId] = acct;
      section.accounts = accounts;
      return {
        ...base,
        channels: {
          ...base.channels,
          "twilio-sms": section,
        },
      } as OpenClawConfig;
    },
  },
  pairing: {
    idLabel: "twilioSmsSenderId",
    normalizeAllowEntry: (entry) => normalizeTwilioSmsAllowEntry(entry),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveTwilioSmsAccount({ cfg });
      if (!account.configured) {
        return;
      }
      await sendTwilioSms({
        to: normalizeE164(id),
        body: PAIRING_APPROVED_MESSAGE,
        accountSid: account.config.accountSid!,
        authToken: account.config.authToken!,
        from: account.config.phoneNumber!,
      });
    },
  },
  outbound: {
    deliveryMode: "direct",
    textChunkLimit: 1600,
    resolveTarget: ({ to }) => {
      const trimmed = to?.trim();
      if (!trimmed) {
        return {
          ok: false,
          error: new Error("Delivering to Twilio SMS requires --to <phone_number_e164>"),
        };
      }
      try {
        return { ok: true, to: normalizeE164(trimmed) };
      } catch {
        return {
          ok: false,
          error: new Error(
            `Invalid phone number: ${trimmed}. Use E.164 format (e.g. +15550001234).`,
          ),
        };
      }
    },
    sendText: async ({ cfg, to, text, accountId }) => {
      const account = resolveTwilioSmsAccount({ cfg, accountId });
      if (!account.configured) {
        throw new Error("Twilio SMS account is not configured");
      }
      const result = await sendTwilioSms({
        to,
        body: text,
        accountSid: account.config.accountSid!,
        authToken: account.config.authToken!,
        from: account.config.phoneNumber!,
      });
      return { channel: "twilio-sms", messageId: result.sid };
    },
    sendMedia: async ({ cfg, to, text, mediaUrl, accountId }) => {
      const account = resolveTwilioSmsAccount({ cfg, accountId });
      if (!account.configured) {
        throw new Error("Twilio SMS account is not configured");
      }
      const result = await sendTwilioSms({
        to,
        body: text ?? "",
        accountSid: account.config.accountSid!,
        authToken: account.config.authToken!,
        from: account.config.phoneNumber!,
        mediaUrl: mediaUrl ? [mediaUrl] : undefined,
      });
      return { channel: "twilio-sms", messageId: result.sid };
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
    buildChannelSummary: ({ snapshot }) =>
      buildProbeChannelStatusSummary(snapshot, { baseUrl: null }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeTwilioSms({
        accountSid: account.config.accountSid,
        authToken: account.config.authToken,
        timeoutMs,
      }),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const running = runtime?.running ?? false;
      const probeOk = (probe as TwilioSmsProbe | undefined)?.ok;
      return {
        ...buildComputedAccountStatusSnapshot({
          accountId: account.accountId,
          name: account.name,
          enabled: account.enabled,
          configured: account.configured,
          runtime,
          probe,
        }),
        connected: probeOk ?? running,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      const webhookPath = resolveWebhookPathFromConfig(account.config);
      const core = getTwilioSmsRuntime();
      const statusSink = createAccountStatusSink({
        accountId: ctx.accountId,
        setStatus: ctx.setStatus,
      });

      ctx.log?.info(`[${account.accountId}] starting Twilio SMS (webhook=${webhookPath})`);

      const unregister = registerTwilioSmsWebhookTarget({
        account,
        config: ctx.cfg,
        path: webhookPath,
        runtime: {
          log: (...args: unknown[]) => ctx.log?.info(String(args[0])),
          error: (...args: unknown[]) => ctx.log?.error(String(args[0])),
        },
        core,
        statusSink: (patch) => statusSink(patch),
      });

      // Keep this task alive until abort so gateway runtime does not treat
      // startup as exit (which triggers an auto-restart loop).
      await waitUntilAbort(ctx.abortSignal, () => {
        ctx.log?.info(`[${account.accountId}] stopping Twilio SMS`);
        unregister();
      });
    },
  },
};
