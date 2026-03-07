/**
 * 钉钉 Onboarding 适配器
 *
 * 实现 ChannelOnboardingAdapter 接口，提供:
 * - getStatus: 获取渠道配置状态
 * - configure: 交互式配置向导
 * - dmPolicy: DM 策略配置
 * - disable: 禁用渠道
 */

import type {
  ChannelOnboardingAdapter,
  ChannelOnboardingDmPolicy,
  ChannelOnboardingStatusContext,
  DmPolicy,
  OpenClawConfig,
  WizardPrompter,
} from "openclaw/plugin-sdk/dingtalk";
import { DEFAULT_ACCOUNT_ID } from "./channel.js";
import { isConfigured, resolveDingtalkCredentials, type DingtalkConfig } from "./config.js";

/**
 * 设置钉钉 DM 策略
 */
function setDingtalkDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: {
        ...(cfg.channels?.dingtalk as DingtalkConfig | undefined),
        dmPolicy,
      },
    },
  } as OpenClawConfig;
}

/**
 * 设置钉钉白名单
 */
function setDingtalkAllowFrom(cfg: OpenClawConfig, allowFrom: string[]): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: {
        ...(cfg.channels?.dingtalk as DingtalkConfig | undefined),
        allowFrom,
      },
    },
  } as OpenClawConfig;
}

/**
 * 解析白名单输入
 */
function parseAllowFromInput(raw: string): string[] {
  return raw
    .split(/[\n,;]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

/**
 * 提示输入钉钉白名单
 */
async function promptDingtalkAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const existing = (params.cfg.channels?.dingtalk as DingtalkConfig | undefined)?.allowFrom ?? [];
  await params.prompter.note(
    [
      "通过 staffId 或 unionId 设置钉钉私聊白名单。",
      "你可以在钉钉开放平台或通过 API 获取用户 ID。",
      "示例:",
      "- manager1234",
      "- 0123456789012345678",
    ].join("\n"),
    "钉钉白名单",
  );

  while (true) {
    const entry = await params.prompter.text({
      message: "钉钉白名单 (用户 ID)",
      placeholder: "user1, user2",
      initialValue: existing[0] ? String(existing[0]) : undefined,
      validate: (value) => (String(value ?? "").trim() ? undefined : "必填"),
    });

    if (typeof entry === "symbol") {
      return params.cfg;
    }

    const parts = parseAllowFromInput(String(entry));
    if (parts.length === 0) {
      await params.prompter.note("请至少输入一个用户 ID。", "钉钉白名单");
      continue;
    }

    const unique = [
      ...new Set([...existing.map((v) => String(v).trim()).filter(Boolean), ...parts]),
    ];
    return setDingtalkAllowFrom(params.cfg, unique);
  }
}

/**
 * 显示钉钉凭证帮助信息
 */
async function noteDingtalkCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) 访问钉钉开放平台 (open.dingtalk.com)",
      "2) 创建企业内部应用",
      "3) 在「凭证与基础信息」页面获取 AppKey 和 AppSecret",
      "4) 在「机器人与消息推送」中启用机器人能力",
      "5) 选择「Stream 模式」接收消息",
      "6) 发布应用或添加到测试群",
      "",
      "提示: 也可以设置环境变量 DINGTALK_CLIENT_ID / DINGTALK_CLIENT_SECRET",
    ].join("\n"),
    "钉钉凭证配置",
  );
}

function setDingtalkGroupPolicy(
  cfg: OpenClawConfig,
  groupPolicy: "open" | "allowlist" | "disabled",
): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: {
        ...(cfg.channels?.dingtalk as DingtalkConfig | undefined),
        enabled: true,
        groupPolicy,
      },
    },
  } as OpenClawConfig;
}

/**
 * 设置钉钉群聊白名单
 */
function setDingtalkGroupAllowFrom(cfg: OpenClawConfig, groupAllowFrom: string[]): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      dingtalk: {
        ...(cfg.channels?.dingtalk as DingtalkConfig | undefined),
        groupAllowFrom,
      },
    },
  } as OpenClawConfig;
}

/**
 * DM 策略配置
 */
const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "DingTalk",
  channel: "dingtalk" as const,
  policyKey: "channels.dingtalk.dmPolicy",
  allowFromKey: "channels.dingtalk.allowFrom",
  getCurrent: (cfg: OpenClawConfig) =>
    (cfg.channels?.dingtalk as DingtalkConfig | undefined)?.dmPolicy ?? "open",
  setPolicy: (cfg: OpenClawConfig, policy: DmPolicy) => setDingtalkDmPolicy(cfg, policy),
  promptAllowFrom: promptDingtalkAllowFrom,
};

/**
 * 钉钉 Onboarding 适配器
 */
export const dingtalkOnboardingAdapter: ChannelOnboardingAdapter = {
  channel: "dingtalk" as const,

  /**
   * 获取渠道配置状态
   */
  getStatus: async ({ cfg }: ChannelOnboardingStatusContext) => {
    const dingtalkCfg = cfg.channels?.dingtalk as DingtalkConfig | undefined;
    const configured = isConfigured(dingtalkCfg);

    const statusLines: string[] = [];
    if (!configured) {
      statusLines.push("钉钉: 需要配置应用凭证");
    } else {
      statusLines.push("钉钉: 已配置");
    }

    return {
      channel: "dingtalk" as const,
      configured,
      statusLines,
      selectionHint: configured ? "已配置" : "需要应用凭证",
      quickstartScore: configured ? 2 : 0,
    };
  },

  /**
   * 交互式配置向导
   */
  configure: async ({ cfg, prompter }) => {
    const dingtalkCfg = cfg.channels?.dingtalk as DingtalkConfig | undefined;
    const resolved = resolveDingtalkCredentials(dingtalkCfg);
    const hasConfigCreds = Boolean(
      dingtalkCfg?.clientId?.trim() && dingtalkCfg?.clientSecret?.trim(),
    );
    const canUseEnv = Boolean(
      !hasConfigCreds &&
      process.env.DINGTALK_CLIENT_ID?.trim() &&
      process.env.DINGTALK_CLIENT_SECRET?.trim(),
    );

    let next = cfg;
    let clientId: string | null = null;
    let clientSecret: string | null = null;

    if (!resolved) {
      await noteDingtalkCredentialHelp(prompter);
    }

    if (canUseEnv) {
      const keepEnv = await prompter.confirm({
        message: "检测到 DINGTALK_CLIENT_ID + DINGTALK_CLIENT_SECRET 环境变量，是否使用？",
        initialValue: true,
      });
      if (keepEnv) {
        next = {
          ...next,
          channels: {
            ...next.channels,
            dingtalk: { ...next.channels?.dingtalk, enabled: true },
          },
        };
      } else {
        const idResult = await prompter.text({
          message: "请输入钉钉 AppKey (clientId)",
          validate: (value) => (value?.trim() ? undefined : "必填"),
        });
        if (typeof idResult === "symbol") return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
        clientId = String(idResult).trim();

        const secretResult = await prompter.text({
          message: "请输入钉钉 AppSecret (clientSecret)",
          validate: (value) => (value?.trim() ? undefined : "必填"),
        });
        if (typeof secretResult === "symbol") return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
        clientSecret = String(secretResult).trim();
      }
    } else if (hasConfigCreds) {
      const keep = await prompter.confirm({
        message: "钉钉凭证已配置，是否保留？",
        initialValue: true,
      });
      if (!keep) {
        const idResult = await prompter.text({
          message: "请输入钉钉 AppKey (clientId)",
          validate: (value) => (value?.trim() ? undefined : "必填"),
        });
        if (typeof idResult === "symbol") return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
        clientId = String(idResult).trim();

        const secretResult = await prompter.text({
          message: "请输入钉钉 AppSecret (clientSecret)",
          validate: (value) => (value?.trim() ? undefined : "必填"),
        });
        if (typeof secretResult === "symbol") return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
        clientSecret = String(secretResult).trim();
      }
    } else {
      const idResult = await prompter.text({
        message: "请输入钉钉 AppKey (clientId)",
        validate: (value) => (value?.trim() ? undefined : "必填"),
      });
      if (typeof idResult === "symbol") return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
      clientId = String(idResult).trim();

      const secretResult = await prompter.text({
        message: "请输入钉钉 AppSecret (clientSecret)",
        validate: (value) => (value?.trim() ? undefined : "必填"),
      });
      if (typeof secretResult === "symbol") return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
      clientSecret = String(secretResult).trim();
    }

    if (clientId && clientSecret) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          dingtalk: {
            ...next.channels?.dingtalk,
            enabled: true,
            clientId,
            clientSecret,
          },
        },
      };
    }

    // AI Card 配置
    const enableAICard = await prompter.confirm({
      message: "是否启用 AI Card 流式响应？（直接回车使用推荐值）",
      initialValue: true,
    });
    next = {
      ...next,
      channels: {
        ...next.channels,
        dingtalk: {
          ...next.channels?.dingtalk,
          enableAICard,
        },
      },
    };

    // 群聊策略
    const groupPolicyResult = await prompter.select({
      message: "群聊策略（直接回车使用默认值「开放」）",
      options: [
        { value: "open", label: "开放 - 响应所有群聊（需要 @机器人）【推荐】" },
        { value: "allowlist", label: "白名单 - 仅响应指定群聊" },
        { value: "disabled", label: "禁用 - 不响应群聊" },
      ],
      initialValue: (next.channels?.dingtalk as DingtalkConfig | undefined)?.groupPolicy ?? "open",
    });

    if (typeof groupPolicyResult !== "symbol") {
      next = setDingtalkGroupPolicy(next, groupPolicyResult as "open" | "allowlist" | "disabled");
    }

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },

  dmPolicy,

  /**
   * 禁用渠道
   */
  disable: (cfg: OpenClawConfig): OpenClawConfig =>
    ({
      ...cfg,
      channels: {
        ...cfg.channels,
        dingtalk: {
          ...(cfg.channels?.dingtalk as DingtalkConfig | undefined),
          enabled: false,
        },
      },
    }) as OpenClawConfig,
};
