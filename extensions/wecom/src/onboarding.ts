/**
 * WeCom 配置向导 (Onboarding)
 * 支持 Bot、Agent 和双模式同时启动的交互式配置流程
 */

import type {
    ChannelOnboardingAdapter,
    ChannelOnboardingDmPolicy,
    OpenClawConfig,
    WizardPrompter,
} from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk";
import type { WecomConfig, WecomBotConfig, WecomAgentConfig, WecomDmConfig } from "./types/index.js";

const channel = "wecom" as const;

type WecomMode = "bot" | "agent" | "both";

// ============================================================
// 辅助函数
// ============================================================

function getWecomConfig(cfg: OpenClawConfig): WecomConfig | undefined {
    return cfg.channels?.wecom as WecomConfig | undefined;
}

function setWecomEnabled(cfg: OpenClawConfig, enabled: boolean): OpenClawConfig {
    return {
        ...cfg,
        channels: {
            ...cfg.channels,
            wecom: {
                ...(cfg.channels?.wecom ?? {}),
                enabled,
            },
        },
    } as OpenClawConfig;
}

function setWecomBotConfig(cfg: OpenClawConfig, bot: WecomBotConfig): OpenClawConfig {
    return {
        ...cfg,
        channels: {
            ...cfg.channels,
            wecom: {
                ...(cfg.channels?.wecom ?? {}),
                enabled: true,
                bot,
            },
        },
    } as OpenClawConfig;
}

function setWecomAgentConfig(cfg: OpenClawConfig, agent: WecomAgentConfig): OpenClawConfig {
    return {
        ...cfg,
        channels: {
            ...cfg.channels,
            wecom: {
                ...(cfg.channels?.wecom ?? {}),
                enabled: true,
                agent,
            },
        },
    } as OpenClawConfig;
}

function setWecomDmPolicy(
    cfg: OpenClawConfig,
    mode: "bot" | "agent",
    dm: WecomDmConfig,
): OpenClawConfig {
    const wecom = getWecomConfig(cfg) ?? {};
    if (mode === "bot") {
        return {
            ...cfg,
            channels: {
                ...cfg.channels,
                wecom: {
                    ...wecom,
                    bot: {
                        ...wecom.bot,
                        dm,
                    },
                },
            },
        } as OpenClawConfig;
    }
    return {
        ...cfg,
        channels: {
            ...cfg.channels,
            wecom: {
                ...wecom,
                agent: {
                    ...wecom.agent,
                    dm,
                },
            },
        },
    } as OpenClawConfig;
}

// ============================================================
// 欢迎与引导
// ============================================================

async function showWelcome(prompter: WizardPrompter): Promise<void> {
    await prompter.note(
        [
            "🚀 欢迎使用企业微信（WeCom）接入向导",
            "本插件支持「智能体 Bot」与「自建应用 Agent」双模式并行。",
            "--------------------------------------------------",
            "👨‍💻 作者: YanHaidao (微信: YanHaidao)",
            "💬 交流: 有任何问题或建议，欢迎添加微信进入交流群。",
            "--------------------------------------------------",
        ].join("\n"),
        "WeCom 配置向导",
    );
}

// ============================================================
// 模式选择
// ============================================================

async function promptMode(prompter: WizardPrompter): Promise<WecomMode> {
    const choice = await prompter.select({
        message: "请选择您要配置的接入模式:",
        options: [
            {
                value: "bot",
                label: "Bot 模式 (智能机器人)",
                hint: "回调速度快，支持流式占位符，适合日常对话",
            },
            {
                value: "agent",
                label: "Agent 模式 (自建应用)",
                hint: "功能最全，支持 API 主动推送、发送文件/视频、交互卡片",
            },
            {
                value: "both",
                label: "双模式 (Bot + Agent 同时启用)",
                hint: "推荐：Bot 用于快速对话，Agent 用于主动推送和媒体发送",
            },
        ],
        initialValue: "both",
    });
    return choice as WecomMode;
}

// ============================================================
// Bot 模式配置
// ============================================================

async function configureBotMode(
    cfg: OpenClawConfig,
    prompter: WizardPrompter,
): Promise<OpenClawConfig> {
    await prompter.note(
        [
            "正在配置 Bot 模式...",
            "",
            "💡 操作指南: 请在企微后台【管理工具 -> 智能机器人】开启 API 模式。",
            "🔗 回调 URL: https://您的域名/wecom/bot",
            "",
            "请先在后台填入回调 URL，然后获取以下信息。",
        ].join("\n"),
        "Bot 模式配置",
    );

    const token = String(
        await prompter.text({
            message: "请输入 Token:",
            validate: (value: string | undefined) => (value?.trim() ? undefined : "Token 不能为空"),
        }),
    ).trim();

    const encodingAESKey = String(
        await prompter.text({
            message: "请输入 EncodingAESKey:",
            validate: (value: string | undefined) => {
                const v = value?.trim() ?? "";
                if (!v) return "EncodingAESKey 不能为空";
                if (v.length !== 43) return "EncodingAESKey 应为 43 个字符";
                return undefined;
            },
        }),
    ).trim();

    const streamPlaceholder = await prompter.text({
        message: "流式占位符 (可选):",
        placeholder: "正在思考...",
        initialValue: "正在思考...",
    });

    const welcomeText = await prompter.text({
        message: "欢迎语 (可选):",
        placeholder: "你好！我是 AI 助手",
        initialValue: "你好！我是 AI 助手",
    });

    const botConfig: WecomBotConfig = {
        token,
        encodingAESKey,
        streamPlaceholderContent: streamPlaceholder?.trim() || undefined,
        welcomeText: welcomeText?.trim() || undefined,
    };

    return setWecomBotConfig(cfg, botConfig);
}

// ============================================================
// Agent 模式配置
// ============================================================

async function configureAgentMode(
    cfg: OpenClawConfig,
    prompter: WizardPrompter,
): Promise<OpenClawConfig> {
    await prompter.note(
        [
            "正在配置 Agent 模式...",
            "",
            "💡 操作指南: 请在企微后台【应用管理 -> 自建应用】创建应用。",
        ].join("\n"),
        "Agent 模式配置",
    );

    const corpId = String(
        await prompter.text({
            message: "请输入 CorpID (企业ID):",
            validate: (value: string | undefined) => (value?.trim() ? undefined : "CorpID 不能为空"),
        }),
    ).trim();

    const agentIdStr = String(
        await prompter.text({
            message: "请输入 AgentID (应用ID):",
            validate: (value: string | undefined) => {
                const v = value?.trim() ?? "";
                if (!v) return "AgentID 不能为空";
                if (!/^\d+$/.test(v)) return "AgentID 应为数字";
                return undefined;
            },
        }),
    ).trim();
    const agentId = Number(agentIdStr);

    const corpSecret = String(
        await prompter.text({
            message: "请输入 Secret (应用密钥):",
            validate: (value: string | undefined) => (value?.trim() ? undefined : "Secret 不能为空"),
        }),
    ).trim();

    await prompter.note(
        [
            "💡 操作指南: 请在自建应用详情页进入【接收消息 -> 设置API接收】。",
            "🔗 回调 URL: https://您的域名/wecom/agent",
            "",
            "请先在后台填入回调 URL，然后获取以下信息。",
        ].join("\n"),
        "回调配置",
    );

    const token = String(
        await prompter.text({
            message: "请输入 Token (回调令牌):",
            validate: (value: string | undefined) => (value?.trim() ? undefined : "Token 不能为空"),
        }),
    ).trim();

    const encodingAESKey = String(
        await prompter.text({
            message: "请输入 EncodingAESKey (回调加密密钥):",
            validate: (value: string | undefined) => {
                const v = value?.trim() ?? "";
                if (!v) return "EncodingAESKey 不能为空";
                if (v.length !== 43) return "EncodingAESKey 应为 43 个字符";
                return undefined;
            },
        }),
    ).trim();

    const welcomeText = await prompter.text({
        message: "欢迎语 (可选):",
        placeholder: "欢迎使用智能助手",
        initialValue: "欢迎使用智能助手",
    });

    const agentConfig: WecomAgentConfig = {
        corpId,
        corpSecret,
        agentId,
        token,
        encodingAESKey,
        welcomeText: welcomeText?.trim() || undefined,
    };

    return setWecomAgentConfig(cfg, agentConfig);
}

// ============================================================
// DM 策略配置
// ============================================================

async function promptDmPolicy(
    cfg: OpenClawConfig,
    prompter: WizardPrompter,
    modes: ("bot" | "agent")[],
): Promise<OpenClawConfig> {
    const policyChoice = await prompter.select({
        message: "请选择私聊 (DM) 访问策略:",
        options: [
            { value: "pairing", label: "配对模式", hint: "推荐：安全，未知用户需授权" },
            { value: "allowlist", label: "白名单模式", hint: "仅允许特定 UserID" },
            { value: "open", label: "开放模式", hint: "任何人可发起" },
            { value: "disabled", label: "禁用私聊", hint: "不接受私聊消息" },
        ],
        initialValue: "pairing",
    });

    const policy = policyChoice as "pairing" | "allowlist" | "open" | "disabled";
    let allowFrom: string[] | undefined;

    if (policy === "allowlist") {
        const allowFromStr = String(
            await prompter.text({
                message: "请输入白名单 UserID (多个用逗号分隔):",
                placeholder: "user1,user2",
                validate: (value: string | undefined) => (value?.trim() ? undefined : "请输入至少一个 UserID"),
            }),
        ).trim();
        allowFrom = allowFromStr.split(",").map((s) => s.trim()).filter(Boolean);
    }

    const dm: WecomDmConfig = { policy, allowFrom };

    let result = cfg;
    for (const mode of modes) {
        result = setWecomDmPolicy(result, mode, dm);
    }
    return result;
}

// ============================================================
// 配置汇总
// ============================================================

async function showSummary(cfg: OpenClawConfig, prompter: WizardPrompter): Promise<void> {
    const wecom = getWecomConfig(cfg);
    const lines: string[] = ["✅ 配置已保存！", ""];

    if (wecom?.bot?.token) {
        lines.push("📱 Bot 模式: 已配置");
        lines.push(`   回调 URL: https://您的域名/wecom/bot`);
    }

    if (wecom?.agent?.corpId) {
        lines.push("🏢 Agent 模式: 已配置");
        lines.push(`   回调 URL: https://您的域名/wecom/agent`);
    }

    lines.push("");
    lines.push("⚠️ 请确保您已在企微后台填写了正确的回调 URL，");
    lines.push("   并点击了后台的『保存』按钮完成验证。");

    await prompter.note(lines.join("\n"), "配置完成");
}

// ============================================================
// DM Policy Adapter
// ============================================================

const dmPolicy: ChannelOnboardingDmPolicy = {
    label: "WeCom",
    channel,
    policyKey: "channels.wecom.bot.dm.policy",
    allowFromKey: "channels.wecom.bot.dm.allowFrom",
    getCurrent: (cfg: OpenClawConfig) => {
        const wecom = getWecomConfig(cfg);
        return (wecom?.bot?.dm?.policy ?? "pairing") as "pairing";
    },
    setPolicy: (cfg: OpenClawConfig, policy: "pairing" | "allowlist" | "open" | "disabled") => {
        return setWecomDmPolicy(cfg, "bot", { policy });
    },
    promptAllowFrom: async ({ cfg, prompter }: { cfg: OpenClawConfig; prompter: WizardPrompter }) => {
        const allowFromStr = String(
            await prompter.text({
                message: "请输入白名单 UserID:",
                validate: (value: string | undefined) => (value?.trim() ? undefined : "请输入 UserID"),
            }),
        ).trim();
        const allowFrom = allowFromStr.split(",").map((s) => s.trim()).filter(Boolean);
        return setWecomDmPolicy(cfg, "bot", { policy: "allowlist", allowFrom });
    },
};

// ============================================================
// Onboarding Adapter
// ============================================================

export const wecomOnboardingAdapter: ChannelOnboardingAdapter = {
    channel,
    dmPolicy,
    getStatus: async ({ cfg }: { cfg: OpenClawConfig }) => {
        const wecom = getWecomConfig(cfg);
        const botConfigured = Boolean(wecom?.bot?.token && wecom?.bot?.encodingAESKey);
        const agentConfigured = Boolean(
            wecom?.agent?.corpId && wecom?.agent?.corpSecret && wecom?.agent?.agentId,
        );
        const configured = botConfigured || agentConfigured;

        const statusParts: string[] = [];
        if (botConfigured) statusParts.push("Bot ✓");
        if (agentConfigured) statusParts.push("Agent ✓");

        return {
            channel,
            configured,
            statusLines: [
                `WeCom: ${configured ? statusParts.join(" + ") : "需要配置"}`,
            ],
            selectionHint: configured
                ? `configured · ${statusParts.join(" + ")}`
                : "enterprise-ready · dual-mode",
            quickstartScore: configured ? 1 : 8,
        };
    },
    configure: async ({ cfg, prompter }: { cfg: OpenClawConfig; prompter: WizardPrompter }) => {
        // 1. 欢迎
        await showWelcome(prompter);

        // 2. 模式选择
        const mode = await promptMode(prompter);

        let next = cfg;
        const configuredModes: ("bot" | "agent")[] = [];

        // 3. 配置 Bot
        if (mode === "bot" || mode === "both") {
            next = await configureBotMode(next, prompter);
            configuredModes.push("bot");
        }

        // 4. 配置 Agent
        if (mode === "agent" || mode === "both") {
            next = await configureAgentMode(next, prompter);
            configuredModes.push("agent");
        }

        // 5. DM 策略
        next = await promptDmPolicy(next, prompter, configuredModes);

        // 6. 启用通道
        next = setWecomEnabled(next, true);

        // 7. 汇总
        await showSummary(next, prompter);

        return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
    },
};
