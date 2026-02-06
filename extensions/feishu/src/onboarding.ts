import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  DmPolicy,
  OpenClawConfig,
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
} from "openclaw/plugin-sdk";

const channel = "feishu" as const;

function setFeishuDmPolicy(cfg: OpenClawConfig, policy: DmPolicy): OpenClawConfig {
  const allowFrom =
    policy === "open" ? addWildcardAllowFrom(cfg.channels?.feishu?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...cfg.channels?.feishu,
        enabled: true,
        dmPolicy: policy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

async function noteFeishuSetup(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Create a Feishu/Lark app and enable Bot + Event Subscription (WebSocket).",
      "Copy the App ID and App Secret from the app credentials page.",
      'Lark (global): use open.larksuite.com and set domain="lark".',
      `Docs: ${formatDocsLink("/channels/feishu", "channels/feishu")}`,
    ].join("\n"),
    "Feishu setup",
  );
}

function normalizeAllowEntry(entry: string): string {
  return entry.replace(/^(feishu|lark):/i, "").trim();
}

function resolveDomainChoice(domain?: string | null): "feishu" | "lark" {
  const normalized = String(domain ?? "").toLowerCase();
  if (normalized.includes("lark") || normalized.includes("larksuite")) {
    return "lark";
  }
  return "feishu";
}

async function promptFeishuAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string | null;
}): Promise<OpenClawConfig> {
  const { cfg, prompter } = params;
  const accountId = normalizeAccountId(params.accountId);
  const isDefault = accountId === DEFAULT_ACCOUNT_ID;
  const existingAllowFrom = isDefault
    ? (cfg.channels?.feishu?.allowFrom ?? [])
    : (cfg.channels?.feishu?.accounts?.[accountId]?.allowFrom ?? []);

  const entry = await prompter.text({
    message: "Feishu allowFrom (open_id or union_id)",
    placeholder: "ou_xxx",
    initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return "Required";
      }
      const entries = raw
        .split(/[\n,;]+/g)
        .map((item) => normalizeAllowEntry(item))
        .filter(Boolean);
      const invalid = entries.filter((item) => item !== "*" && !/^o[un]_[a-zA-Z0-9]+$/.test(item));
      if (invalid.length > 0) {
        return `Invalid Feishu ids: ${invalid.join(", ")}`;
      }
      return undefined;
    },
  });

  const parsed = String(entry)
    .split(/[\n,;]+/g)
    .map((item) => normalizeAllowEntry(item))
    .filter(Boolean);
  const merged = [
    ...existingAllowFrom.map((item) => normalizeAllowEntry(String(item))),
    ...parsed,
  ].filter(Boolean);
  const unique = Array.from(new Set(merged));

  if (isDefault) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        feishu: {
          ...cfg.channels?.feishu,
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: unique,
        },
      },
    };
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...cfg.channels?.feishu,
        enabled: true,
        accounts: {
          ...cfg.channels?.feishu?.accounts,
          [accountId]: {
            ...cfg.channels?.feishu?.accounts?.[accountId],
            enabled: cfg.channels?.feishu?.accounts?.[accountId]?.enabled ?? true,
            dmPolicy: "allowlist",
            allowFrom: unique,
          },
        },
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "Feishu",
  channel,
  policyKey: "channels.feishu.dmPolicy",
  allowFromKey: "channels.feishu.allowFrom",
  getCurrent: (cfg) => cfg.channels?.feishu?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setFeishuDmPolicy(cfg, policy),
  promptAllowFrom: promptFeishuAllowFrom,
};

function updateFeishuConfig(
  cfg: OpenClawConfig,
  accountId: string,
  updates: { appId?: string; appSecret?: string; domain?: string; enabled?: boolean },
): OpenClawConfig {
  const isDefault = accountId === DEFAULT_ACCOUNT_ID;
  const next = { ...cfg } as OpenClawConfig;
  const feishu = { ...next.channels?.feishu } as Record<string, unknown>;
  const accounts = feishu.accounts
    ? { ...(feishu.accounts as Record<string, unknown>) }
    : undefined;

  if (isDefault && !accounts) {
    return {
      ...next,
      channels: {
        ...next.channels,
        feishu: {
          ...feishu,
          ...updates,
          enabled: updates.enabled ?? true,
        },
      },
    };
  }

  const resolvedAccounts = accounts ?? {};
  const existing = (resolvedAccounts[accountId] as Record<string, unknown>) ?? {};
  resolvedAccounts[accountId] = {
    ...existing,
    ...updates,
    enabled: updates.enabled ?? true,
  };

  return {
    ...next,
    channels: {
      ...next.channels,
      feishu: {
        ...feishu,
        accounts: resolvedAccounts,
      },
    },
  };
}

export const feishuOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const configured = listFeishuAccountIds(cfg).some((id) => {
      const acc = resolveFeishuAccount({ cfg, accountId: id });
      return acc.tokenSource !== "none";
    });
    return {
      channel,
      configured,
      statusLines: [`Feishu: ${configured ? "configured" : "needs app credentials"}`],
      selectionHint: configured ? "configured" : "requires app credentials",
      quickstartScore: configured ? 1 : 10,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    let next = cfg;
    const override = accountOverrides.feishu?.trim();
    const defaultId = resolveDefaultFeishuAccountId(next);
    let accountId = override ? normalizeAccountId(override) : defaultId;

    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg: next,
        prompter,
        label: "Feishu",
        currentId: accountId,
        listAccountIds: listFeishuAccountIds,
        defaultAccountId: defaultId,
      });
    }

    await noteFeishuSetup(prompter);

    const resolved = resolveFeishuAccount({ cfg: next, accountId });
    const domainChoice = await prompter.select({
      message: "Feishu domain",
      options: [
        { value: "feishu", label: "Feishu (China) — open.feishu.cn" },
        { value: "lark", label: "Lark (global) — open.larksuite.com" },
      ],
      initialValue: resolveDomainChoice(resolved.config.domain),
    });
    const domain = domainChoice === "lark" ? "lark" : "feishu";

    const isDefault = accountId === DEFAULT_ACCOUNT_ID;
    const envAppId = process.env.FEISHU_APP_ID?.trim();
    const envSecret = process.env.FEISHU_APP_SECRET?.trim();
    if (isDefault && envAppId && envSecret) {
      const useEnv = await prompter.confirm({
        message: "FEISHU_APP_ID/FEISHU_APP_SECRET detected. Use env vars?",
        initialValue: true,
      });
      if (useEnv) {
        next = updateFeishuConfig(next, accountId, { enabled: true, domain });
        return { cfg: next, accountId };
      }
    }
    const appId = String(
      await prompter.text({
        message: "Feishu App ID (cli_...)",
        initialValue: resolved.config.appId?.trim() || undefined,
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
      }),
    ).trim();

    const appSecret = String(
      await prompter.text({
        message: "Feishu App Secret",
        initialValue: resolved.config.appSecret?.trim() || undefined,
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
      }),
    ).trim();

    next = updateFeishuConfig(next, accountId, { appId, appSecret, domain, enabled: true });

    return { cfg: next, accountId };
  },
};
