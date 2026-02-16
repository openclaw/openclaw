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
  listDingTalkAccountIds,
  resolveDefaultDingTalkAccountId,
  resolveDingTalkAccount,
} from "openclaw/plugin-sdk";

const channel = "dingtalk" as const;

function normalizeAllowEntry(entry: string): string {
  return entry.replace(/^(dingtalk|dingtalk-connector|dd|ding):/i, "").trim();
}

function setDingTalkDmPolicy(cfg: OpenClawConfig, policy: DmPolicy): OpenClawConfig {
  const allowFrom =
    policy === "open" ? addWildcardAllowFrom(cfg.channels?.dingtalk?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: {
        ...cfg.channels?.dingtalk,
        enabled: true,
        dmPolicy: policy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

async function noteDingTalkSetup(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "Create a DingTalk app and enable Stream mode for the bot.",
      "Copy the App Key (clientId) and App Secret (clientSecret).",
      "The gateway should be running for stream delivery.",
      `Docs: ${formatDocsLink("/channels/dingtalk", "channels/dingtalk")}`,
    ].join("\n"),
    "DingTalk setup",
  );
}

async function promptDingTalkAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string | null;
}): Promise<OpenClawConfig> {
  const { cfg, prompter } = params;
  const accountId = normalizeAccountId(params.accountId);
  const isDefault = accountId === DEFAULT_ACCOUNT_ID;
  const existingAllowFrom = isDefault
    ? (cfg.channels?.dingtalk?.allowFrom ?? [])
    : (cfg.channels?.dingtalk?.accounts?.[accountId]?.allowFrom ?? []);

  const entry = await prompter.text({
    message: "DingTalk allowFrom (user id or *)",
    placeholder: "123456789",
    initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
    validate: (value) => {
      const raw = String(value ?? "").trim();
      if (!raw) {
        return "Required";
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
        dingtalk: {
          ...cfg.channels?.dingtalk,
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
      dingtalk: {
        ...cfg.channels?.dingtalk,
        enabled: true,
        accounts: {
          ...cfg.channels?.dingtalk?.accounts,
          [accountId]: {
            ...cfg.channels?.dingtalk?.accounts?.[accountId],
            enabled: cfg.channels?.dingtalk?.accounts?.[accountId]?.enabled ?? true,
            dmPolicy: "allowlist",
            allowFrom: unique,
          },
        },
      },
    },
  };
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "DingTalk",
  channel,
  policyKey: "channels.dingtalk.dmPolicy",
  allowFromKey: "channels.dingtalk.allowFrom",
  getCurrent: (cfg) => cfg.channels?.dingtalk?.dmPolicy ?? "open",
  setPolicy: (cfg, policy) => setDingTalkDmPolicy(cfg, policy),
  promptAllowFrom: promptDingTalkAllowFrom,
};

function updateDingTalkConfig(
  cfg: OpenClawConfig,
  accountId: string,
  updates: { clientId?: string; clientSecret?: string; enabled?: boolean },
): OpenClawConfig {
  const isDefault = accountId === DEFAULT_ACCOUNT_ID;
  const next = { ...cfg } as OpenClawConfig;
  const dingtalk = { ...next.channels?.dingtalk } as Record<string, unknown>;
  const accounts = dingtalk.accounts
    ? { ...(dingtalk.accounts as Record<string, unknown>) }
    : undefined;

  if (isDefault && !accounts) {
    return {
      ...next,
      channels: {
        ...next.channels,
        dingtalk: {
          ...dingtalk,
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
      dingtalk: {
        ...dingtalk,
        accounts: resolvedAccounts,
      },
    },
  };
}

export const dingtalkOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const configured = listDingTalkAccountIds(cfg).some((id) => {
      const acc = resolveDingTalkAccount({ cfg, accountId: id });
      return acc.tokenSource !== "none";
    });
    return {
      channel,
      configured,
      statusLines: [`DingTalk: ${configured ? "configured" : "needs app credentials"}`],
      selectionHint: configured ? "configured" : "requires app credentials",
      quickstartScore: configured ? 1 : 10,
    };
  },
  configure: async ({ cfg, prompter, accountOverrides, shouldPromptAccountIds }) => {
    let next = cfg;
    const override = accountOverrides.dingtalk?.trim();
    const defaultId = resolveDefaultDingTalkAccountId(next);
    let accountId = override ? normalizeAccountId(override) : defaultId;

    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg: next,
        prompter,
        label: "DingTalk",
        currentId: accountId,
        listAccountIds: listDingTalkAccountIds,
        defaultAccountId: defaultId,
      });
    }

    await noteDingTalkSetup(prompter);

    const resolved = resolveDingTalkAccount({ cfg: next, accountId });
    const clientId = String(
      await prompter.text({
        message: "DingTalk App Key (clientId)",
        placeholder: "dingabc123",
        initialValue: resolved.config.clientId || undefined,
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
      }),
    ).trim();

    const clientSecret = String(
      await prompter.text({
        message: "DingTalk App Secret (clientSecret)",
        placeholder: "secret",
        initialValue: resolved.config.clientSecret || undefined,
        validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
      }),
    ).trim();

    next = updateDingTalkConfig(next, accountId, {
      clientId,
      clientSecret,
      enabled: true,
    });

    return { cfg: next, accountId };
  },
};
