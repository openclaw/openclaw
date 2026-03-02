/**
 * CLI onboarding wizard for the telegram-userbot channel.
 *
 * Guides users through:
 *   1. API credentials (apiId + apiHash from my.telegram.org)
 *   2. Phone number
 *   3. Interactive authentication (login code + optional 2FA password)
 *   4. Saving session via SessionStore
 *   5. Saving config (apiId, apiHash) and DM policy
 */

import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  mergeAllowFromEntries,
  normalizeAccountId,
  promptAccountId,
} from "openclaw/plugin-sdk";
import {
  listTelegramUserbotAccountIds,
  resolveDefaultTelegramUserbotAccountId,
  resolveTelegramUserbotAccount,
} from "./adapters/config.js";
import { UserbotClient } from "./client.js";
import { TELEGRAM_USERBOT_CHANNEL_ID } from "./config-schema.js";
import { SessionStore } from "./session-store.js";

const channel = TELEGRAM_USERBOT_CHANNEL_ID;
const CHANNEL_KEY = "telegram-userbot";

// ---------------------------------------------------------------------------
// Config patching helpers
// ---------------------------------------------------------------------------

/** Patch the telegram-userbot config for a given account (default or named). */
function applyAccountPatch(
  cfg: OpenClawConfig,
  accountId: string,
  patch: Record<string, unknown>,
): OpenClawConfig {
  const channelSection = (cfg.channels?.[CHANNEL_KEY] as Record<string, unknown> | undefined) ?? {};

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        [CHANNEL_KEY]: {
          ...channelSection,
          enabled: true,
          ...patch,
        },
      },
    } as OpenClawConfig;
  }

  const existingAccounts = (channelSection.accounts as Record<string, unknown> | undefined) ?? {};
  const existingAccount =
    (existingAccounts[accountId] as Record<string, unknown> | undefined) ?? {};

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [CHANNEL_KEY]: {
        ...channelSection,
        enabled: true,
        accounts: {
          ...existingAccounts,
          [accountId]: {
            ...existingAccount,
            enabled: true,
            ...patch,
          },
        },
      },
    },
  } as OpenClawConfig;
}

function setUserbotDmPolicy(
  cfg: OpenClawConfig,
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled",
): OpenClawConfig {
  const channelSection = (cfg.channels?.[CHANNEL_KEY] as Record<string, unknown> | undefined) ?? {};
  const allowFrom =
    dmPolicy === "open"
      ? addWildcardAllowFrom(
          (channelSection.allowFrom as Array<string | number> | undefined) ?? undefined,
        )
      : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [CHANNEL_KEY]: {
        ...channelSection,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  } as OpenClawConfig;
}

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

async function promptApiCredentials(params: {
  prompter: WizardPrompter;
  currentApiId?: number;
  currentApiHash?: string;
}): Promise<{ apiId: number; apiHash: string }> {
  const { prompter, currentApiId, currentApiHash } = params;

  const apiIdRaw = await prompter.text({
    message: "Telegram API ID (from my.telegram.org)",
    initialValue: currentApiId ? String(currentApiId) : undefined,
    placeholder: "12345678",
    validate: (value) => {
      const trimmed = String(value ?? "").trim();
      if (!trimmed) return "Required";
      const parsed = Number.parseInt(trimmed, 10);
      if (!Number.isFinite(parsed) || parsed <= 0) return "Must be a positive integer";
      return undefined;
    },
  });
  const apiId = Number.parseInt(String(apiIdRaw).trim(), 10);

  const apiHashRaw = await prompter.text({
    message: "Telegram API hash (from my.telegram.org)",
    initialValue: currentApiHash || undefined,
    placeholder: "0123456789abcdef0123456789abcdef",
    validate: (value) => {
      const trimmed = String(value ?? "").trim();
      if (!trimmed) return "Required";
      if (trimmed.length < 10) return "API hash seems too short";
      return undefined;
    },
  });
  const apiHash = String(apiHashRaw).trim();

  return { apiId, apiHash };
}

async function noteApiCredentialsHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Telegram Userbot connects your personal Telegram account via MTProto.",
      "You need API credentials from https://my.telegram.org/apps :",
      "  1. Log in with your phone number",
      '  2. Go to "API development tools"',
      "  3. Copy the API ID and API hash",
      "",
      `Docs: ${formatDocsLink("/channels/telegram-userbot", "channels/telegram-userbot")}`,
    ].join("\n"),
    "Telegram Userbot setup",
  );
}

// ---------------------------------------------------------------------------
// AllowFrom prompt
// ---------------------------------------------------------------------------

async function promptUserbotAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  const account = resolveTelegramUserbotAccount({ cfg, accountId });
  const existingAllowFrom = account.config.allowFrom ?? [];

  await prompter.note(
    [
      "Allowlist Telegram users by their numeric user ID.",
      "Find user IDs in gateway logs (from.id) or via @userinfobot.",
      "Multiple entries: comma-separated.",
      `Docs: ${formatDocsLink("/channels/telegram-userbot", "channels/telegram-userbot")}`,
    ].join("\n"),
    "Telegram Userbot allowlist",
  );

  const entry = await prompter.text({
    message: "Telegram Userbot allowFrom (numeric user ids)",
    placeholder: "123456789, 987654321",
    initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) return "Required";
      const parts = raw
        .split(/[\n,;]+/g)
        .map((p) => p.trim())
        .filter(Boolean);
      for (const part of parts) {
        if (part !== "*" && !/^\d+$/.test(part)) {
          return `Invalid user ID: "${part}" (must be numeric)`;
        }
      }
      return undefined;
    },
  });

  const parts = String(entry)
    .split(/[\n,;]+/g)
    .map((p) => p.trim())
    .filter(Boolean);
  const unique = mergeAllowFromEntries(existingAllowFrom, parts);

  return applyAccountPatch(cfg, accountId, {
    dmPolicy: "allowlist",
    allowFrom: unique,
  });
}

// ---------------------------------------------------------------------------
// DM policy
// ---------------------------------------------------------------------------

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Telegram Userbot",
  channel,
  policyKey: `channels.${CHANNEL_KEY}.dmPolicy`,
  allowFromKey: `channels.${CHANNEL_KEY}.allowFrom`,
  getCurrent: (cfg) => {
    const section = cfg.channels?.[CHANNEL_KEY] as Record<string, unknown> | undefined;
    return (section?.dmPolicy as "pairing" | "allowlist" | "open" | "disabled") ?? "pairing";
  },
  setPolicy: (cfg, policy) => setUserbotDmPolicy(cfg, policy),
  promptAllowFrom: async ({ cfg, prompter, accountId }) => {
    const id =
      accountId && normalizeAccountId(accountId)
        ? normalizeAccountId(accountId)
        : resolveDefaultTelegramUserbotAccountId(cfg);
    return promptUserbotAllowFrom({ cfg, prompter, accountId: id });
  },
};

// ---------------------------------------------------------------------------
// Interactive auth helper (extracted for testability)
// ---------------------------------------------------------------------------

export type CreateClientFn = (config: { apiId: number; apiHash: string }) => UserbotClient;

/**
 * Default factory that creates a real UserbotClient.
 * Overridable in tests to avoid real network calls.
 */
export const defaultCreateClient: CreateClientFn = (config) => new UserbotClient(config);

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export function buildTelegramUserbotOnboardingAdapter(deps?: {
  createClient?: CreateClientFn;
  sessionStore?: SessionStore;
}): ChannelOnboardingAdapter {
  const createClient = deps?.createClient ?? defaultCreateClient;
  const sessionStore = deps?.sessionStore ?? new SessionStore();

  return {
    channel,
    dmPolicy,

    getStatus: async ({ cfg }) => {
      const accountIds = listTelegramUserbotAccountIds(cfg);
      let configured = false;

      for (const accountId of accountIds) {
        const account = resolveTelegramUserbotAccount({ cfg, accountId });
        if (!account.configured) continue;
        // Config present AND session file exists = fully configured
        const hasSession = await sessionStore.exists(accountId);
        if (hasSession) {
          configured = true;
          break;
        }
      }

      return {
        channel,
        configured,
        statusLines: [
          `Telegram Userbot: ${configured ? "configured" : "needs API credentials + login"}`,
        ],
        selectionHint: configured ? "configured" : "needs API ID + hash",
        quickstartScore: configured ? 2 : 5,
      };
    },

    configure: async ({
      cfg,
      prompter,
      accountOverrides,
      shouldPromptAccountIds,
      forceAllowFrom,
    }) => {
      const override = (accountOverrides as Partial<Record<string, string>>)[channel]?.trim();
      const defaultAccountId = resolveDefaultTelegramUserbotAccountId(cfg);
      let accountId = override ? normalizeAccountId(override) : defaultAccountId;

      if (shouldPromptAccountIds && !override) {
        accountId = await promptAccountId({
          cfg,
          prompter,
          label: "Telegram Userbot",
          currentId: accountId,
          listAccountIds: listTelegramUserbotAccountIds,
          defaultAccountId,
        });
      }

      const account = resolveTelegramUserbotAccount({ cfg, accountId });
      const hasSession = await sessionStore.exists(accountId);
      const alreadyReady = account.configured && hasSession;

      // If already fully set up, ask whether to keep the current session
      if (alreadyReady) {
        const keepSession = await prompter.confirm({
          message: "Telegram Userbot already configured. Keep current session?",
          initialValue: true,
        });
        if (keepSession) {
          let next = applyAccountPatch(cfg, accountId, {});
          if (forceAllowFrom) {
            next = await promptUserbotAllowFrom({ cfg: next, prompter, accountId });
          }
          return { cfg: next, accountId };
        }
      }

      // Step 1: API credentials
      if (!account.configured) {
        await noteApiCredentialsHelp(prompter);
      }

      let apiId = account.apiId;
      let apiHash = account.apiHash;

      if (!account.configured) {
        const creds = await promptApiCredentials({ prompter });
        apiId = creds.apiId;
        apiHash = creds.apiHash;
      } else {
        const keepCreds = await prompter.confirm({
          message: `API credentials configured (apiId=${apiId}). Keep them?`,
          initialValue: true,
        });
        if (!keepCreds) {
          const creds = await promptApiCredentials({
            prompter,
            currentApiId: apiId,
            currentApiHash: apiHash,
          });
          apiId = creds.apiId;
          apiHash = creds.apiHash;
        }
      }

      // Save API credentials to config immediately
      let next = applyAccountPatch(cfg, accountId, { apiId, apiHash });

      // Step 2: Phone number
      const phoneRaw = await prompter.text({
        message: "Telegram phone number (international format, e.g. +1234567890)",
        validate: (value) => {
          const raw = String(value ?? "").trim();
          if (!raw) return "Required";
          const cleaned = raw.replace(/[\s\-()]/g, "");
          if (!/^\+\d{7,15}$/.test(cleaned)) {
            return "Use international format: +<country code><number>";
          }
          return undefined;
        },
      });
      const phone = String(phoneRaw)
        .trim()
        .replace(/[\s\-()]/g, "");

      // Step 3: Interactive authentication
      await prompter.note(
        [
          "Telegram will send a login code to your Telegram app.",
          "You will be prompted to enter it next.",
          "If you have 2FA enabled, you will also be asked for your password.",
        ].join("\n"),
        "Authentication",
      );

      const client = createClient({ apiId, apiHash });

      try {
        await client.connectInteractive({
          apiId,
          apiHash,
          phone,
          codeCallback: async () => {
            const code = await prompter.text({
              message: "Enter the login code sent to your Telegram app",
              validate: (v) => (v?.trim() ? undefined : "Required"),
            });
            return String(code).trim();
          },
          passwordCallback: async () => {
            const password = await prompter.text({
              message: "Enter your 2FA password",
              validate: (v) => (v?.trim() ? undefined : "Required"),
            });
            return String(password).trim();
          },
        });

        // Step 4: Save session string
        const sessionString = client.getSessionString();
        await sessionStore.save(accountId, sessionString);

        // Step 5: Display success with user info
        try {
          const me = await client.getMe();
          const display = me.username ? `@${me.username}` : (me.firstName ?? "unknown");
          const userId = me.id?.toString() ?? "unknown";
          await prompter.note(`Connected as ${display} (ID: ${userId})`, "Telegram Userbot");
        } catch {
          await prompter.note(
            "Session saved successfully. Could not fetch user info.",
            "Telegram Userbot",
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await prompter.note(`Authentication failed: ${msg}\nRe-run onboarding to retry.`, "Error");
        // Return with saved API credentials even if auth fails
        return { cfg: next, accountId };
      } finally {
        try {
          await client.disconnect();
        } catch {
          // best-effort disconnect
        }
      }

      if (forceAllowFrom) {
        next = await promptUserbotAllowFrom({ cfg: next, prompter, accountId });
      }

      return { cfg: next, accountId };
    },

    disable: (cfg) => ({
      ...cfg,
      channels: {
        ...cfg.channels,
        [CHANNEL_KEY]: {
          ...(cfg.channels?.[CHANNEL_KEY] as Record<string, unknown> | undefined),
          enabled: false,
        },
      },
    }),
  };
}

/** Default adapter instance used at runtime. */
export const telegramUserbotOnboardingAdapter: ChannelOnboardingAdapter =
  buildTelegramUserbotOnboardingAdapter();
