import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk";
import {
  addWildcardAllowFrom,
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  promptAccountId,
} from "openclaw/plugin-sdk";
import {
  listTuituiAccountIds,
  resolveDefaultTuituiAccountId,
  resolveTuituiAccount,
} from "./accounts.js";

const channel = "tuitui" as const;

function setTuituiDmPolicy(
  cfg: OpenClawConfig,
  dmPolicy: "pairing" | "allowlist" | "open" | "disabled",
) {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.tuitui?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      tuitui: {
        ...cfg.channels?.tuitui,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  } as OpenClawConfig;
}

async function noteTuituiCredentialsHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) 在 qlink (https://qlink.qihoo.net/apps/home) 申请推推机器人，选择「申请推推机器人」",
      "2) 申请通过后管理员会回填 appid 和 secret",
      "3) 可将 appId/secret 填入下方，或设置环境变量 TUITUI_APPID、TUITUI_SECRET（仅 default 账户）",
      "文档: https://docs.openclaw.ai/channels/tuitui",
    ].join("\n"),
    "推推 appId / secret",
  );
}

async function promptTuituiAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveTuituiAccount({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  const entry = await prompter.text({
    message: "推推 allowFrom（域账号或群 ID）",
    placeholder: "zhangsan 或 76526696480*****",
    initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
    validate: (value) => (value?.trim() ? undefined : "必填"),
  });
  const normalized = String(entry).trim();
  const merged = [
    ...existingAllowFrom.map((item) => String(item).trim()).filter(Boolean),
    normalized,
  ];
  const unique = [...new Set(merged)];

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        tuitui: {
          ...cfg.channels?.tuitui,
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: unique,
        },
      },
    } as OpenClawConfig;
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      tuitui: {
        ...cfg.channels?.tuitui,
        enabled: true,
        accounts: {
          ...cfg.channels?.tuitui?.accounts,
          [accountId]: {
            ...cfg.channels?.tuitui?.accounts?.[accountId],
            enabled: cfg.channels?.tuitui?.accounts?.[accountId]?.enabled ?? true,
            dmPolicy: "allowlist",
            allowFrom: unique,
          },
        },
      },
    },
  } as OpenClawConfig;
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "推推",
  channel,
  policyKey: "channels.tuitui.dmPolicy",
  allowFromKey: "channels.tuitui.allowFrom",
  getCurrent: (cfg) => (cfg.channels?.tuitui?.dmPolicy ?? "pairing") as "pairing",
  setPolicy: (cfg, policy) => setTuituiDmPolicy(cfg, policy),
  promptAllowFrom: async ({ cfg, prompter, accountId }) => {
    const id =
      accountId && normalizeAccountId(accountId)
        ? (normalizeAccountId(accountId) ?? DEFAULT_ACCOUNT_ID)
        : resolveDefaultTuituiAccountId(cfg);
    return promptTuituiAllowFrom({ cfg, prompter, accountId: id });
  },
};

export const tuituiOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  dmPolicy,
  getStatus: async ({ cfg }) => {
    const configured = listTuituiAccountIds(cfg).some((accountId) => {
      const a = resolveTuituiAccount({ cfg, accountId });
      return Boolean(a.appId?.trim() && a.secret?.trim());
    });
    return {
      channel,
      configured,
      statusLines: [`推推: ${configured ? "已配置" : "需配置 appId + secret"}`],
      selectionHint: configured ? "已配置" : "需配置 appId + secret",
      quickstartScore: configured ? 1 : 10,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
  }) => {
    const override = accountOverrides.tuitui?.trim();
    const defaultId = resolveDefaultTuituiAccountId(cfg);
    let accountId = override ? normalizeAccountId(override) : defaultId;
    if (shouldPromptAccountIds && !override) {
      accountId = await promptAccountId({
        cfg,
        prompter,
        label: "推推",
        currentId: accountId,
        listAccountIds: listTuituiAccountIds,
        defaultAccountId: defaultId,
      });
    }

    let next = cfg;
    const resolved = resolveTuituiAccount({ cfg: next, accountId });
    const accountConfigured = Boolean(resolved.appId?.trim() && resolved.secret?.trim());
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const canUseEnv =
      allowEnv &&
      Boolean(process.env.TUITUI_APPID?.trim()) &&
      Boolean(process.env.TUITUI_SECRET?.trim());
    const hasConfigCreds = Boolean(
      (resolved.config.appId || resolved.config.secret || resolved.config.secretFile)?.trim(),
    );

    let appId: string | null = null;
    let secret: string | null = null;

    if (!accountConfigured) {
      await noteTuituiCredentialsHelp(prompter);
    }
    if (canUseEnv && !resolved.config.appId) {
      const keepEnv = await prompter.confirm({
        message: "检测到 TUITUI_APPID 与 TUITUI_SECRET，使用环境变量？",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            tuitui: { ...next.channels?.tuitui, enabled: true },
          },
        } as OpenClawConfig;
      } else {
        appId = String(
          await prompter.text({
            message: "输入推推 appId",
            validate: (value) => (value?.trim() ? undefined : "必填"),
          }),
        ).trim();
        secret = String(
          await prompter.text({
            message: "输入推推 secret",
            validate: (value) => (value?.trim() ? undefined : "必填"),
          }),
        ).trim();
      }
    } else if (hasConfigCreds) {
      const keep = await prompter.confirm({
        message: "推推 appId/secret 已配置，保留？",
        initialValue: true,
      });
      if (!keep) {
        appId = String(
          await prompter.text({
            message: "输入推推 appId",
            validate: (value) => (value?.trim() ? undefined : "必填"),
          }),
        ).trim();
        secret = String(
          await prompter.text({
            message: "输入推推 secret",
            validate: (value) => (value?.trim() ? undefined : "必填"),
          }),
        ).trim();
      }
    } else {
      appId = String(
        await prompter.text({
          message: "输入推推 appId",
          validate: (value) => (value?.trim() ? undefined : "必填"),
        }),
      ).trim();
      secret = String(
        await prompter.text({
          message: "输入推推 secret",
          validate: (value) => (value?.trim() ? undefined : "必填"),
        }),
      ).trim();
    }

    if (appId && secret) {
      if (accountId === DEFAULT_ACCOUNT_ID) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            tuitui: { ...next.channels?.tuitui, enabled: true, appId, secret },
          },
        } as OpenClawConfig;
      } else {
        next = {
          ...next,
          channels: {
            ...next.channels,
            tuitui: {
              ...next.channels?.tuitui,
              enabled: true,
              accounts: {
                ...next.channels?.tuitui?.accounts,
                [accountId]: {
                  ...next.channels?.tuitui?.accounts?.[accountId],
                  enabled: true,
                  appId,
                  secret,
                },
              },
            },
          },
        } as OpenClawConfig;
      }
    }

    if (forceAllowFrom) {
      next = await promptTuituiAllowFrom({ cfg: next, prompter, accountId });
    }

    return { cfg: next, accountId };
  },
};
