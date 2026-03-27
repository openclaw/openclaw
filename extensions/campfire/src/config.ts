import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { createHybridChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-schema";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { z } from "zod";
import type {
  CampfireAccountConfig,
  CampfireChannelConfig,
  ResolvedCampfireAccount,
} from "./types.js";

const DEFAULT_TEXT_CHUNK_LIMIT = 4000;

function trimOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeAllowFrom(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0);
}

function resolveCampfireConfigSection(cfg: OpenClawConfig): CampfireChannelConfig {
  const section = cfg.channels?.campfire;
  if (!section || typeof section !== "object" || Array.isArray(section)) {
    return {};
  }
  return section as CampfireChannelConfig;
}

function hasTopLevelAccountFields(section: CampfireChannelConfig): boolean {
  return (
    section.baseUrl !== undefined ||
    section.botKey !== undefined ||
    section.webhookSecret !== undefined ||
    section.allowFrom !== undefined ||
    section.webhookPath !== undefined ||
    section.textChunkLimit !== undefined ||
    section.enabled !== undefined ||
    section.name !== undefined
  );
}

export function listCampfireAccountIds(cfg: OpenClawConfig): string[] {
  const section = resolveCampfireConfigSection(cfg);
  const fromAccounts =
    section.accounts && typeof section.accounts === "object"
      ? Object.keys(section.accounts).filter(Boolean)
      : [];
  const ids = new Set(fromAccounts);
  if (fromAccounts.length === 0 || hasTopLevelAccountFields(section)) {
    ids.add(DEFAULT_ACCOUNT_ID);
  }
  return [...ids].toSorted((a, b) => a.localeCompare(b));
}

export function resolveDefaultCampfireAccountId(cfg: OpenClawConfig): string {
  const section = resolveCampfireConfigSection(cfg);
  const ids = listCampfireAccountIds(cfg);
  const preferred = trimOptionalString(section.defaultAccount);
  if (preferred && ids.includes(preferred)) {
    return preferred;
  }
  if (ids.includes(DEFAULT_ACCOUNT_ID)) {
    return DEFAULT_ACCOUNT_ID;
  }
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveCampfireAccountOverride(
  section: CampfireChannelConfig,
  accountId: string,
): CampfireAccountConfig {
  const accounts = section.accounts;
  if (!accounts || typeof accounts !== "object") {
    return {};
  }
  const override = accounts[accountId];
  if (!override || typeof override !== "object" || Array.isArray(override)) {
    return {};
  }
  return override;
}

export function resolveCampfireAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedCampfireAccount {
  const section = resolveCampfireConfigSection(cfg);
  const resolvedAccountId = trimOptionalString(accountId) ?? resolveDefaultCampfireAccountId(cfg);
  const {
    accounts: _accounts,
    defaultAccount: _defaultAccount,
    ...base
  } = section as CampfireChannelConfig;
  const override = resolveCampfireAccountOverride(section, resolvedAccountId);
  const merged: CampfireAccountConfig = {
    ...base,
    ...override,
  };

  const baseUrl = (trimOptionalString(merged.baseUrl) ?? "").replace(/\/+$/, "");
  const botKey = trimOptionalString(merged.botKey) ?? "";
  const topLevelWebhookPath = trimOptionalString(base.webhookPath);
  const accountWebhookPath = trimOptionalString(override.webhookPath);
  const webhookPath =
    accountWebhookPath ??
    (resolvedAccountId === DEFAULT_ACCOUNT_ID ? topLevelWebhookPath : undefined) ??
    `/channels/campfire/webhook/${resolvedAccountId}`;
  const textChunkLimit =
    typeof merged.textChunkLimit === "number" &&
    Number.isFinite(merged.textChunkLimit) &&
    merged.textChunkLimit > 0
      ? Math.floor(merged.textChunkLimit)
      : DEFAULT_TEXT_CHUNK_LIMIT;

  return {
    accountId: resolvedAccountId,
    name: trimOptionalString(merged.name),
    enabled: merged.enabled !== false,
    baseUrl,
    botKey,
    webhookSecret: trimOptionalString(merged.webhookSecret),
    allowFrom: normalizeAllowFrom(merged.allowFrom),
    webhookPath,
    textChunkLimit,
    configured: Boolean(baseUrl && botKey),
  };
}

export const campfireAccountSchema = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    baseUrl: z.string().url().optional(),
    botKey: z.string().min(1).optional(),
    webhookSecret: z.string().optional(),
    allowFrom: z.array(z.string()).optional(),
    webhookPath: z.string().optional(),
    textChunkLimit: z.number().int().positive().optional(),
  })
  .strict();

export const campfireConfigSchema: z.ZodType<CampfireChannelConfig> = campfireAccountSchema.extend({
  defaultAccount: z.string().optional(),
  accounts: z.record(z.string(), campfireAccountSchema.optional()).optional(),
});

export const campfireChannelConfigSchema = buildChannelConfigSchema(campfireConfigSchema);

export const campfireConfigAdapter = createHybridChannelConfigAdapter<ResolvedCampfireAccount>({
  sectionKey: "campfire",
  listAccountIds: (cfg) => listCampfireAccountIds(cfg),
  resolveAccount: (cfg, accountId) => resolveCampfireAccount(cfg, accountId),
  defaultAccountId: (cfg) => resolveDefaultCampfireAccountId(cfg),
  clearBaseFields: [
    "name",
    "enabled",
    "baseUrl",
    "botKey",
    "webhookSecret",
    "allowFrom",
    "webhookPath",
    "textChunkLimit",
  ],
  preserveSectionOnDefaultDelete: true,
  resolveAllowFrom: (account) => account.allowFrom,
  formatAllowFrom: (allowFrom) =>
    allowFrom.map((entry) => String(entry).trim()).filter((entry) => entry.length > 0),
});
