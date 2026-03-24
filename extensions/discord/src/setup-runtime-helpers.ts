import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import type {
  ChannelSetupDmPolicy,
  ChannelSetupWizard,
  WizardPrompter,
} from "openclaw/plugin-sdk/setup-runtime";
import {
  resolveDefaultDiscordSetupAccountId,
  resolveDiscordSetupAccountConfig,
} from "./setup-account-state.js";

export function parseMentionOrPrefixedId(params: {
  value: string;
  mentionPattern: RegExp;
  prefixPattern?: RegExp;
  idPattern: RegExp;
  normalizeId?: (id: string) => string;
}): string | null {
  const trimmed = params.value.trim();
  if (!trimmed) {
    return null;
  }
  const mentionMatch = trimmed.match(params.mentionPattern);
  if (mentionMatch?.[1]) {
    return params.normalizeId ? params.normalizeId(mentionMatch[1]) : mentionMatch[1];
  }
  if (params.prefixPattern?.test(trimmed)) {
    const stripped = trimmed.replace(params.prefixPattern, "").trim();
    if (!stripped || !params.idPattern.test(stripped)) {
      return null;
    }
    return params.normalizeId ? params.normalizeId(stripped) : stripped;
  }
  if (!params.idPattern.test(trimmed)) {
    return null;
  }
  return params.normalizeId ? params.normalizeId(trimmed) : trimmed;
}

function splitSetupEntries(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function mergeAllowFromEntries(
  current: Array<string | number> | null | undefined,
  additions: Array<string | number>,
): string[] {
  const merged = [...(current ?? []), ...additions]
    .map((value) => String(value).trim())
    .filter(Boolean);
  return [...new Set(merged)];
}

function patchDiscordChannelConfigForAccount(params: {
  cfg: OpenClawConfig;
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  const accountId = normalizeAccountId(params.accountId);
  const channelConfig = (params.cfg.channels?.discord as Record<string, unknown> | undefined) ?? {};
  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...params.cfg,
      channels: {
        ...params.cfg.channels,
        discord: {
          ...channelConfig,
          ...params.patch,
          enabled: true,
        },
      },
    };
  }
  const accounts =
    (channelConfig.accounts as Record<string, Record<string, unknown>> | undefined) ?? {};
  const accountConfig = accounts[accountId] ?? {};
  return {
    ...params.cfg,
    channels: {
      ...params.cfg.channels,
      discord: {
        ...channelConfig,
        enabled: true,
        accounts: {
          ...accounts,
          [accountId]: {
            ...accountConfig,
            ...params.patch,
            enabled: true,
          },
        },
      },
    },
  };
}

export function setSetupChannelEnabled(
  cfg: OpenClawConfig,
  channel: string,
  enabled: boolean,
): OpenClawConfig {
  const channelConfig = (cfg.channels?.[channel] as Record<string, unknown> | undefined) ?? {};
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      [channel]: {
        ...channelConfig,
        enabled,
      },
    },
  };
}

export function patchChannelConfigForAccount(params: {
  cfg: OpenClawConfig;
  channel: "discord";
  accountId: string;
  patch: Record<string, unknown>;
}): OpenClawConfig {
  return patchDiscordChannelConfigForAccount({
    cfg: params.cfg,
    accountId: params.accountId,
    patch: params.patch,
  });
}

export function createLegacyCompatChannelDmPolicy(params: {
  label: string;
  channel: "discord";
  promptAllowFrom?: ChannelSetupDmPolicy["promptAllowFrom"];
}): ChannelSetupDmPolicy {
  return {
    label: params.label,
    channel: params.channel,
    policyKey: `channels.${params.channel}.dmPolicy`,
    allowFromKey: `channels.${params.channel}.allowFrom`,
    getCurrent: (cfg) =>
      (
        cfg.channels?.[params.channel] as
          | {
              dmPolicy?: "open" | "pairing" | "allowlist";
              dm?: { policy?: "open" | "pairing" | "allowlist" };
            }
          | undefined
      )?.dmPolicy ??
      (
        cfg.channels?.[params.channel] as
          | {
              dmPolicy?: "open" | "pairing" | "allowlist";
              dm?: { policy?: "open" | "pairing" | "allowlist" };
            }
          | undefined
      )?.dm?.policy ??
      "pairing",
    setPolicy: (cfg, policy) =>
      patchDiscordChannelConfigForAccount({
        cfg,
        accountId: DEFAULT_ACCOUNT_ID,
        patch: {
          dmPolicy: policy,
          ...(policy === "open"
            ? {
                allowFrom: [
                  ...new Set(
                    [
                      ...(((
                        cfg.channels?.discord as { allowFrom?: Array<string | number> } | undefined
                      )?.allowFrom ?? []) as Array<string | number>),
                      "*",
                    ]
                      .map((value) => String(value).trim())
                      .filter(Boolean),
                  ),
                ],
              }
            : {}),
        },
      }),
    ...(params.promptAllowFrom ? { promptAllowFrom: params.promptAllowFrom } : {}),
  };
}

async function noteChannelLookupFailure(params: {
  prompter: Pick<WizardPrompter, "note">;
  label: string;
  error: unknown;
}) {
  await params.prompter.note(
    `Channel lookup failed; keeping entries as typed. ${String(params.error)}`,
    params.label,
  );
}

export function createAccountScopedAllowFromSection(params: {
  credentialInputKey?: NonNullable<ChannelSetupWizard["allowFrom"]>["credentialInputKey"];
  helpTitle?: string;
  helpLines?: string[];
  message: string;
  placeholder: string;
  invalidWithoutCredentialNote: string;
  parseId: NonNullable<NonNullable<ChannelSetupWizard["allowFrom"]>["parseId"]>;
  resolveEntries: NonNullable<NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]>;
}): NonNullable<ChannelSetupWizard["allowFrom"]> {
  return {
    ...(params.helpTitle ? { helpTitle: params.helpTitle } : {}),
    ...(params.helpLines ? { helpLines: params.helpLines } : {}),
    ...(params.credentialInputKey ? { credentialInputKey: params.credentialInputKey } : {}),
    message: params.message,
    placeholder: params.placeholder,
    invalidWithoutCredentialNote: params.invalidWithoutCredentialNote,
    parseId: params.parseId,
    resolveEntries: params.resolveEntries,
    apply: ({ cfg, accountId, allowFrom }) =>
      patchDiscordChannelConfigForAccount({
        cfg,
        accountId,
        patch: { dmPolicy: "allowlist", allowFrom },
      }),
  };
}

export function createAccountScopedGroupAccessSection<TResolved>(params: {
  label: string;
  placeholder: string;
  helpTitle?: string;
  helpLines?: string[];
  skipAllowlistEntries?: boolean;
  currentPolicy: NonNullable<ChannelSetupWizard["groupAccess"]>["currentPolicy"];
  currentEntries: NonNullable<ChannelSetupWizard["groupAccess"]>["currentEntries"];
  updatePrompt: NonNullable<ChannelSetupWizard["groupAccess"]>["updatePrompt"];
  resolveAllowlist?: NonNullable<
    NonNullable<ChannelSetupWizard["groupAccess"]>["resolveAllowlist"]
  >;
  fallbackResolved: (entries: string[]) => TResolved;
  applyAllowlist: (params: {
    cfg: OpenClawConfig;
    accountId: string;
    resolved: TResolved;
  }) => OpenClawConfig;
}): NonNullable<ChannelSetupWizard["groupAccess"]> {
  return {
    label: params.label,
    placeholder: params.placeholder,
    ...(params.helpTitle ? { helpTitle: params.helpTitle } : {}),
    ...(params.helpLines ? { helpLines: params.helpLines } : {}),
    ...(params.skipAllowlistEntries ? { skipAllowlistEntries: true } : {}),
    currentPolicy: params.currentPolicy,
    currentEntries: params.currentEntries,
    updatePrompt: params.updatePrompt,
    setPolicy: ({ cfg, accountId, policy }) =>
      patchDiscordChannelConfigForAccount({
        cfg,
        accountId,
        patch: { groupPolicy: policy },
      }),
    ...(params.resolveAllowlist
      ? {
          resolveAllowlist: async ({ cfg, accountId, credentialValues, entries, prompter }) => {
            try {
              return await params.resolveAllowlist!({
                cfg,
                accountId,
                credentialValues,
                entries,
                prompter,
              });
            } catch (error) {
              await noteChannelLookupFailure({
                prompter,
                label: params.label,
                error,
              });
              return params.fallbackResolved(entries);
            }
          },
        }
      : {}),
    applyAllowlist: ({ cfg, accountId, resolved }) =>
      params.applyAllowlist({
        cfg,
        accountId,
        resolved: resolved as TResolved,
      }),
  };
}

export function createAllowlistSetupWizardProxy<TGroupResolved>(params: {
  loadWizard: () => Promise<ChannelSetupWizard>;
  createBase: (handlers: {
    promptAllowFrom: NonNullable<ChannelSetupDmPolicy["promptAllowFrom"]>;
    resolveAllowFromEntries: NonNullable<
      NonNullable<ChannelSetupWizard["allowFrom"]>["resolveEntries"]
    >;
    resolveGroupAllowlist: NonNullable<
      NonNullable<NonNullable<ChannelSetupWizard["groupAccess"]>["resolveAllowlist"]>
    >;
  }) => ChannelSetupWizard;
  fallbackResolvedGroupAllowlist: (entries: string[]) => TGroupResolved;
}) {
  return params.createBase({
    promptAllowFrom: async ({ cfg, prompter, accountId }) => {
      const wizard = await params.loadWizard();
      if (!wizard.dmPolicy?.promptAllowFrom) {
        return cfg;
      }
      return await wizard.dmPolicy.promptAllowFrom({ cfg, prompter, accountId });
    },
    resolveAllowFromEntries: async ({ cfg, accountId, credentialValues, entries }) => {
      const wizard = await params.loadWizard();
      if (!wizard.allowFrom) {
        return entries.map((input) => ({ input, resolved: false, id: null }));
      }
      return await wizard.allowFrom.resolveEntries({
        cfg,
        accountId,
        credentialValues,
        entries,
      });
    },
    resolveGroupAllowlist: async ({ cfg, accountId, credentialValues, entries, prompter }) => {
      const wizard = await params.loadWizard();
      if (!wizard.groupAccess?.resolveAllowlist) {
        return params.fallbackResolvedGroupAllowlist(entries) as Awaited<
          ReturnType<
            NonNullable<NonNullable<ChannelSetupWizard["groupAccess"]>["resolveAllowlist"]>
          >
        >;
      }
      return (await wizard.groupAccess.resolveAllowlist({
        cfg,
        accountId,
        credentialValues,
        entries,
        prompter,
      })) as Awaited<
        ReturnType<NonNullable<NonNullable<ChannelSetupWizard["groupAccess"]>["resolveAllowlist"]>>
      >;
    },
  });
}

export async function resolveEntriesWithOptionalToken<TResult>(params: {
  token?: string | null;
  entries: string[];
  buildWithoutToken: (input: string) => TResult;
  resolveEntries: (params: { token: string; entries: string[] }) => Promise<TResult[]>;
}): Promise<TResult[]> {
  const token = params.token?.trim();
  if (!token) {
    return params.entries.map(params.buildWithoutToken);
  }
  return await params.resolveEntries({
    token,
    entries: params.entries,
  });
}

export async function promptLegacyChannelAllowFromForAccount(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
  noteTitle: string;
  noteLines: string[];
  message: string;
  placeholder: string;
  parseId: (value: string) => string | null;
  invalidWithoutTokenNote: string;
  resolveEntries: (params: {
    token: string;
    entries: string[];
  }) => Promise<Array<{ input: string; resolved: boolean; id?: string | null }>>;
  resolveToken: (accountId: string) => string | null | undefined;
  resolveExisting: (accountId: string, cfg: OpenClawConfig) => Array<string | number>;
}): Promise<OpenClawConfig> {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultDiscordSetupAccountId(params.cfg),
  );
  await params.prompter.note(params.noteLines.join("\n"), params.noteTitle);
  const token = params.resolveToken(accountId);
  const existing = params.resolveExisting(accountId, params.cfg);

  while (true) {
    const entry = await params.prompter.text({
      message: params.message,
      placeholder: params.placeholder,
      initialValue: existing[0] ? String(existing[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = splitSetupEntries(String(entry));
    if (!token) {
      const ids = parts.map(params.parseId).filter(Boolean) as string[];
      if (ids.length !== parts.length) {
        await params.prompter.note(params.invalidWithoutTokenNote, params.noteTitle);
        continue;
      }
      return patchDiscordChannelConfigForAccount({
        cfg: params.cfg,
        accountId,
        patch: {
          dmPolicy: "allowlist",
          allowFrom: mergeAllowFromEntries(existing, ids),
        },
      });
    }

    const results = await params.resolveEntries({ token, entries: parts }).catch(() => null);
    if (!results) {
      await params.prompter.note("Failed to resolve usernames. Try again.", params.noteTitle);
      continue;
    }
    const unresolved = results.filter((result) => !result.resolved || !result.id);
    if (unresolved.length > 0) {
      await params.prompter.note(
        `Could not resolve: ${unresolved.map((result) => result.input).join(", ")}`,
        params.noteTitle,
      );
      continue;
    }
    return patchDiscordChannelConfigForAccount({
      cfg: params.cfg,
      accountId,
      patch: {
        dmPolicy: "allowlist",
        allowFrom: mergeAllowFromEntries(
          existing,
          results.map((result) => result.id as string),
        ),
      },
    });
  }
}
