/**
 * Email channel plugin definition.
 *
 * This is a minimal channel plugin optimized for the American Claw use case:
 * - Inbound arrives via gateway RPC (registered in index.ts)
 * - Outbound is handled by the inbound handler's deliver callback
 * - No IMAP/SMTP, no polling, no auth flows
 * - dmPolicy defaults to "open" (email addresses are self-authenticating)
 */

import {
  DEFAULT_ACCOUNT_ID,
  getChatChannelMeta,
  type ChannelPlugin,
} from "openclaw/plugin-sdk";
import type { ResolvedEmailAccount } from "./types.js";
import {
  listEmailAccountIds,
  resolveDefaultEmailAccountId,
  resolveEmailAccount,
} from "./accounts.js";

const meta = getChatChannelMeta("email" as never);

export const emailPlugin: ChannelPlugin<ResolvedEmailAccount> = {
  id: "email" as never,
  meta: {
    ...meta,
    // Override meta defaults for email
    id: "email" as never,
    label: "Email",
    icon: "email",
    showConfigured: false,
    quickstartAllowFrom: false,
    forceAccountBinding: false,
    preferSessionLookupForAnnounceTarget: false,
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  // Email channel config is written by American Claw provisioning.
  // No user-facing onboarding wizard needed.
  reload: { configPrefixes: ["channels.email"] },
  gatewayMethods: ["email.inbound"],
  config: {
    listAccountIds: (cfg) => listEmailAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveEmailAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultEmailAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const channels = cfg.channels as Record<string, unknown> ?? {};
      const emailSection = channels.email as Record<string, unknown> ?? {};
      const accounts = (emailSection.accounts ?? {}) as Record<string, Record<string, unknown>>;
      const existing = accounts[accountKey] ?? {};
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          email: {
            ...emailSection,
            accounts: {
              ...accounts,
              [accountKey]: {
                ...existing,
                enabled,
              },
            },
          },
        },
      } as typeof cfg;
    },
    deleteAccount: ({ cfg, accountId }) => {
      const accountKey = accountId || DEFAULT_ACCOUNT_ID;
      const channels = cfg.channels as Record<string, unknown> ?? {};
      const emailSection = { ...(channels.email as Record<string, unknown> ?? {}) };
      const accounts = { ...((emailSection.accounts ?? {}) as Record<string, unknown>) };
      delete accounts[accountKey];
      return {
        ...cfg,
        channels: {
          ...cfg.channels,
          email: {
            ...emailSection,
            accounts: Object.keys(accounts).length ? accounts : undefined,
          },
        },
      } as typeof cfg;
    },
    isEnabled: (account) => account.enabled,
    disabledReason: () => "disabled",
    isConfigured: (account) => Boolean(account.address && account.outboundUrl),
    unconfiguredReason: () => "not configured",
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.address && account.outboundUrl),
      address: account.address,
      dmPolicy: account.dmPolicy,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      resolveEmailAccount({ cfg, accountId }).allowFrom?.map((e) => String(e)),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim().toLowerCase())
        .filter(Boolean),
  },
  security: {
    resolveDmPolicy: ({ account }) => ({
      // Email is inherently "open" — anyone who knows the address can email.
      // The address itself serves as the access control.
      policy: account.dmPolicy ?? "open",
      allowFrom: account.allowFrom ?? [],
      policyPath: `channels.email.accounts.${account.accountId}.dmPolicy`,
      allowFromPath: `channels.email.accounts.${account.accountId}.`,
      approveHint: "Add the sender's email to channels.email.allowFrom",
      normalizeEntry: (raw: string) => raw.toLowerCase().trim(),
    }),
  },
  outbound: {
    deliveryMode: "gateway",
    textChunkLimit: 50000, // Email has no practical text limit
    resolveTarget: ({ to, allowFrom }) => {
      const trimmed = to?.trim() ?? "";
      if (trimmed && trimmed.includes("@")) {
        return { ok: true, to: trimmed };
      }
      // Fall back to first allowFrom entry
      const firstAllow = (allowFrom ?? []).find((e) => String(e).includes("@"));
      if (firstAllow) {
        return { ok: true, to: String(firstAllow) };
      }
      return {
        ok: false,
        error: new Error(
          "Email target required: provide an email address or configure channels.email.allowFrom",
        ),
      };
    },
    // sendText is not used directly — outbound is handled by the inbound
    // handler's deliver callback which POSTs to American Claw.
    // This is here as a fallback for any framework code that calls it.
    sendText: async ({ to, text }) => {
      // This should not normally be called; outbound is handled in the
      // inbound gateway handler's deliver callback.
      return {
        channel: "email",
        ok: false,
        error: `Direct sendText not supported for email. Target: ${to}, length: ${text.length}`,
      };
    },
  },
  // Email has no persistent connection to start/stop — inbound arrives via RPC.
  gateway: {
    startAccount: async (ctx) => {
      ctx.log?.info(
        `[${ctx.accountId}] email channel ready (${ctx.account.address})`,
      );
      // No persistent connection needed.
      // The "email.inbound" gateway method handles all inbound traffic.
    },
  },
};
