import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  ClawdbotConfig,
  DmPolicy,
  WizardPrompter,
} from "openclaw/plugin-sdk";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  normalizeAccountId,
  promptAccountId,
} from "openclaw/plugin-sdk";
import {
  listFeishuAccountIds,
  resolveDefaultFeishuAccountId,
  resolveFeishuAccount,
  resolveFeishuCredentials,
} from "./accounts.js";
import { probeFeishu } from "./probe.js";
import type { FeishuConfig } from "./types.js";

const channel = "feishu" as const;

function resolveOnboardingAccountId(cfg: ClawdbotConfig, accountId?: string | null): string {
  const raw = accountId?.trim();
  if (raw) {
    return normalizeAccountId(raw);
  }
  return resolveDefaultFeishuAccountId(cfg);
}

function upsertFeishuAccountConfig(
  cfg: ClawdbotConfig,
  accountId: string,
  patch: Partial<FeishuConfig>,
): ClawdbotConfig {
  const normalizedAccountId = normalizeAccountId(accountId);
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;

  if (normalizedAccountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        feishu: {
          ...feishuCfg,
          ...patch,
        },
      },
    };
  }

  const existingAccount = feishuCfg?.accounts?.[normalizedAccountId];
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...feishuCfg,
        enabled: true,
        accounts: {
          ...feishuCfg?.accounts,
          [normalizedAccountId]: {
            ...existingAccount,
            enabled: existingAccount?.enabled ?? true,
            ...patch,
          },
        },
      },
    },
  };
}

function setFeishuDmPolicy(
  cfg: ClawdbotConfig,
  dmPolicy: DmPolicy,
  accountId?: string,
): ClawdbotConfig {
  const resolvedAccountId = resolveOnboardingAccountId(cfg, accountId);
  const account = resolveFeishuAccount({ cfg, accountId: resolvedAccountId });
  // Feishu channel config does not support "disabled" as a dmPolicy value.
  const effectiveDmPolicy = dmPolicy === "disabled" ? "pairing" : dmPolicy;
  const allowFrom =
    effectiveDmPolicy === "open"
      ? addWildcardAllowFrom(account.config.allowFrom)?.map((entry) => String(entry))
      : undefined;
  return upsertFeishuAccountConfig(cfg, resolvedAccountId, {
    dmPolicy: effectiveDmPolicy,
    ...(allowFrom ? { allowFrom } : {}),
  });
}

function setFeishuAllowFrom(
  cfg: ClawdbotConfig,
  allowFrom: string[],
  accountId?: string,
): ClawdbotConfig {
  const resolvedAccountId = resolveOnboardingAccountId(cfg, accountId);
  return upsertFeishuAccountConfig(cfg, resolvedAccountId, { allowFrom });
}

function parseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

async function promptFeishuAllowFrom(params: {
  cfg: ClawdbotConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<ClawdbotConfig> {
  const accountId = resolveOnboardingAccountId(params.cfg, params.accountId);
  const existing = resolveFeishuAccount({ cfg: params.cfg, accountId }).config.allowFrom ?? [];
  const accountLabel = accountId === DEFAULT_ACCOUNT_ID ? "default" : accountId;
  await params.prompter.note(
    [
      `Account: ${accountLabel}`,
      "Allowlist Feishu DMs by open_id or user_id.",
      "You can find user open_id in Feishu admin console or via API.",
      "Examples:",
      "- ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
      "- on_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    ].join("\n"),
    "Feishu allowlist",
  );

  while (true) {
    const entry = await params.prompter.text({
      message: "Feishu allowFrom (user open_ids)",
      placeholder: "ou_xxxxx, ou_yyyyy",
      initialValue: existing[0] ? String(existing[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
    });
    const parts = parseAllowFromInput(String(entry));
    if (parts.length === 0) {
      await params.prompter.note("Enter at least one user.", "Feishu allowlist");
      continue;
    }

    const unique = [
      ...new Set([...existing.map((v) => String(v).trim()).filter(Boolean), ...parts]),
    ];
    return setFeishuAllowFrom(params.cfg, unique, accountId);
  }
}

async function noteFeishuCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Go to Feishu Open Platform (open.feishu.cn)",
      "2) Create a self-built app",
      "3) Get App ID and App Secret from Credentials page",
      "4) Enable required permissions: im:message, im:chat, contact:user.base:readonly",
      "5) Publish the app or add it to a test group",
      "Tip: you can also set FEISHU_APP_ID / FEISHU_APP_SECRET env vars.",
      `Docs: ${formatDocsLink("/channels/feishu", "feishu")}`,
    ].join("\n"),
    "Feishu credentials",
  );
}

function setFeishuGroupPolicy(
  cfg: ClawdbotConfig,
  groupPolicy: "open" | "allowlist" | "disabled",
  accountId?: string,
): ClawdbotConfig {
  const resolvedAccountId = resolveOnboardingAccountId(cfg, accountId);
  return upsertFeishuAccountConfig(cfg, resolvedAccountId, { enabled: true, groupPolicy });
}

function setFeishuGroupAllowFrom(
  cfg: ClawdbotConfig,
  groupAllowFrom: string[],
  accountId?: string,
): ClawdbotConfig {
  const resolvedAccountId = resolveOnboardingAccountId(cfg, accountId);
  return upsertFeishuAccountConfig(cfg, resolvedAccountId, { groupAllowFrom });
}

function setFeishuDomain(
  cfg: ClawdbotConfig,
  domain: "feishu" | "lark",
  accountId?: string,
): ClawdbotConfig {
  const resolvedAccountId = resolveOnboardingAccountId(cfg, accountId);
  return upsertFeishuAccountConfig(cfg, resolvedAccountId, { domain });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Feishu",
  channel,
  policyKey: "channels.feishu.dmPolicy",
  allowFromKey: "channels.feishu.allowFrom",
  getCurrent: (cfg) => {
    const accountId = resolveDefaultFeishuAccountId(cfg);
    return resolveFeishuAccount({ cfg, accountId }).config.dmPolicy ?? "pairing";
  },
  setPolicy: (cfg, policy, accountId?: string) => setFeishuDmPolicy(cfg, policy, accountId),
  promptAllowFrom: promptFeishuAllowFrom,
};

export const feishuOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg, accountOverrides }) => {
    const override = accountOverrides?.feishu?.trim();
    const accountIds = override
      ? [resolveOnboardingAccountId(cfg, override)]
      : listFeishuAccountIds(cfg);
    const accounts = accountIds.map((accountId) => resolveFeishuAccount({ cfg, accountId }));
    const configuredAccounts = accounts.filter((account) => account.configured);
    const configured = configuredAccounts.length > 0;

    // Try to probe if configured
    let probeResult = null;
    if (configuredAccounts[0]) {
      try {
        probeResult = await probeFeishu(configuredAccounts[0]);
      } catch {
        // Ignore probe errors
      }
    }

    const statusLines: string[] = [];
    if (!configured) {
      statusLines.push("Feishu: needs app credentials");
    } else if (probeResult?.ok) {
      const probeAccountId = configuredAccounts[0]?.accountId ?? DEFAULT_ACCOUNT_ID;
      const accountNote = probeAccountId === DEFAULT_ACCOUNT_ID ? "" : ` [${probeAccountId}]`;
      statusLines.push(
        `Feishu${accountNote}: connected as ${probeResult.botName ?? probeResult.botOpenId ?? "bot"}`,
      );
      if (!override && configuredAccounts.length > 1) {
        statusLines.push(`Feishu: ${configuredAccounts.length} account(s) configured`);
      }
    } else if (!override && configuredAccounts.length > 1) {
      statusLines.push(
        `Feishu: configured (${configuredAccounts.length} account(s), connection not verified)`,
      );
    } else {
      statusLines.push("Feishu: configured (connection not verified)");
    }

    return {
      channel,
      configured,
      statusLines,
      selectionHint: configured ? "configured" : "needs app creds",
      quickstartScore: configured ? 2 : 0,
    };
  },

  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    const feishuOverride = accountOverrides?.feishu?.trim();
    const defaultFeishuAccountId = resolveDefaultFeishuAccountId(cfg);
    let feishuAccountId = feishuOverride
      ? normalizeAccountId(feishuOverride)
      : defaultFeishuAccountId;
    if (shouldPromptAccountIds && !feishuOverride) {
      feishuAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "Feishu",
        currentId: feishuAccountId,
        listAccountIds: listFeishuAccountIds,
        defaultAccountId: defaultFeishuAccountId,
      });
    }
    const accountLabel = feishuAccountId === DEFAULT_ACCOUNT_ID ? "default" : feishuAccountId;
    const currentAccount = resolveFeishuAccount({ cfg, accountId: feishuAccountId });
    const resolved = resolveFeishuCredentials(currentAccount.config);
    const hasConfigCreds = Boolean(
      currentAccount.config.appId?.trim() && currentAccount.config.appSecret?.trim(),
    );
    const canUseEnv = Boolean(
      feishuAccountId === DEFAULT_ACCOUNT_ID &&
      !hasConfigCreds &&
      process.env.FEISHU_APP_ID?.trim() &&
      process.env.FEISHU_APP_SECRET?.trim(),
    );

    let next = cfg;
    let appId: string | null = null;
    let appSecret: string | null = null;
    const appIdPrompt =
      feishuAccountId === DEFAULT_ACCOUNT_ID
        ? "Enter Feishu App ID"
        : `Enter Feishu App ID for account "${accountLabel}"`;
    const appSecretPrompt =
      feishuAccountId === DEFAULT_ACCOUNT_ID
        ? "Enter Feishu App Secret"
        : `Enter Feishu App Secret for account "${accountLabel}"`;

    if (!resolved) {
      await noteFeishuCredentialHelp(prompter);
    }

    if (canUseEnv) {
      const keepEnv = await prompter.confirm({
        message: "FEISHU_APP_ID + FEISHU_APP_SECRET detected. Use env vars?",
        initialValue: true,
      });
      if (keepEnv) {
        next = upsertFeishuAccountConfig(next, feishuAccountId, { enabled: true });
      } else {
        appId = String(
          await prompter.text({
            message: appIdPrompt,
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        appSecret = String(
          await prompter.text({
            message: appSecretPrompt,
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else if (hasConfigCreds) {
      const keep = await prompter.confirm({
        message: `Feishu credentials already configured for account "${accountLabel}". Keep them?`,
        initialValue: true,
      });
      if (!keep) {
        appId = String(
          await prompter.text({
            message: appIdPrompt,
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
        appSecret = String(
          await prompter.text({
            message: appSecretPrompt,
            validate: (value) => (value?.trim() ? undefined : "Required"),
          }),
        ).trim();
      }
    } else {
      appId = String(
        await prompter.text({
          message: appIdPrompt,
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
      appSecret = String(
        await prompter.text({
          message: appSecretPrompt,
          validate: (value) => (value?.trim() ? undefined : "Required"),
        }),
      ).trim();
    }

    if (appId && appSecret) {
      next = upsertFeishuAccountConfig(next, feishuAccountId, {
        enabled: true,
        appId,
        appSecret,
      });

      // Test connection
      const testAccount = resolveFeishuAccount({ cfg: next, accountId: feishuAccountId });
      try {
        const probe = await probeFeishu(testAccount);
        if (probe.ok) {
          await prompter.note(
            `Connected as ${probe.botName ?? probe.botOpenId ?? "bot"}`,
            `Feishu connection test (${accountLabel})`,
          );
        } else {
          await prompter.note(
            `Connection failed: ${probe.error ?? "unknown error"}`,
            `Feishu connection test (${accountLabel})`,
          );
        }
      } catch (err) {
        await prompter.note(
          `Connection test failed: ${String(err)}`,
          `Feishu connection test (${accountLabel})`,
        );
      }
    }

    // Domain selection
    const currentDomain =
      resolveFeishuAccount({ cfg: next, accountId: feishuAccountId }).config.domain ?? "feishu";
    const domain = await prompter.select({
      message: "Which Feishu domain?",
      options: [
        { value: "feishu", label: "Feishu (feishu.cn) - China" },
        { value: "lark", label: "Lark (larksuite.com) - International" },
      ],
      initialValue: currentDomain,
    });
    if (domain) {
      next = setFeishuDomain(next, domain as "feishu" | "lark", feishuAccountId);
    }

    // Group policy
    const groupPolicyAccount = resolveFeishuAccount({ cfg: next, accountId: feishuAccountId });
    const groupPolicy = await prompter.select({
      message: "Group chat policy",
      options: [
        { value: "allowlist", label: "Allowlist - only respond in specific groups" },
        { value: "open", label: "Open - respond in all groups (requires mention)" },
        { value: "disabled", label: "Disabled - don't respond in groups" },
      ],
      initialValue: groupPolicyAccount.config.groupPolicy ?? "allowlist",
    });
    if (groupPolicy) {
      next = setFeishuGroupPolicy(
        next,
        groupPolicy as "open" | "allowlist" | "disabled",
        feishuAccountId,
      );
    }

    // Group allowlist if needed
    if (groupPolicy === "allowlist") {
      const existing =
        resolveFeishuAccount({ cfg: next, accountId: feishuAccountId }).config.groupAllowFrom ?? [];
      const entry = await prompter.text({
        message: "Group chat allowlist (chat_ids)",
        placeholder: "oc_xxxxx, oc_yyyyy",
        initialValue: existing.length > 0 ? existing.map(String).join(", ") : undefined,
      });
      if (entry) {
        const parts = parseAllowFromInput(String(entry));
        if (parts.length > 0) {
          next = setFeishuGroupAllowFrom(next, parts, feishuAccountId);
        }
      }
    }

    return { cfg: next, accountId: feishuAccountId };
  },

  dmPolicy,

  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: { ...cfg.channels?.feishu, enabled: false },
    },
  }),
};
