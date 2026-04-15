import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk/core";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/core";
import { resolveYuanbaoAccount } from "./accounts.js";
import type { YuanbaoConfig } from "./types.js";

const channel = "yuanbao" as const;

// function setYuanbaoDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy): OpenClawConfig {
//   const allowFrom =
//     dmPolicy === "open"
//       ? addWildcardAllowFrom(cfg.channels?.yuanbao?.dm?.allowFrom)?.map((entry: any) => String(entry))
//       : undefined;
//   return {
//     ...cfg,
//     channels: {
//       ...cfg.channels,
//       yuanbao: {
//         ...cfg.channels?.yuanbao,
//         dm: {
//           ...cfg.channels?.yuanbao?.dm,
//           policy: dmPolicy,
//           ...(allowFrom ? { allowFrom } : {}),
//         },
//       },
//     },
//   };
// }

// function setYuanbaoAllowFrom(cfg: OpenClawConfig, allowFrom: string[]): OpenClawConfig {
//   return {
//     ...cfg,
//     channels: {
//       ...cfg.channels,
//       yuanbao: {
//         ...cfg.channels?.yuanbao,
//         dm: {
//           ...cfg.channels?.yuanbao?.dm,
//           allowFrom,
//         },
//       },
//     },
//   };
// }

// function parseAllowFromInput(raw: string): string[] {
//   return raw
//     .split(/[\n,;]+/g)
//     .map((entry) => entry.trim())
//     .filter(Boolean);
// }

/**
 * 交互式引导用户输入 allowFrom 白名单
 *
 * 展示提示信息后循环等待用户输入，支持多 ID 逗号分隔，
 * Automatically merges and deduplicates existing allowlist entries.
 *
 * @param params - 包含当前配置和交互式提示器
 * @param params.cfg - OpenClaw 全局配置
 * @param params.prompter - 交互式提示器
 * @returns 更新 allowFrom 后的Configuration object
 */
// async function promptYuanbaoAllowFrom(params: {
//   cfg: OpenClawConfig;
//   prompter: WizardPrompter;
// }): Promise<OpenClawConfig> {
//   const existing = (params.cfg.channels?.yuanbao as YuanbaoConfig | undefined)?.dm?.allowFrom ?? [];
//   await params.prompter.note(
//     [
//       "Allowlist YuanBao Bot DMs by user account ID.",
//       "You can find user account in the YuanBao Bot console.",
//       "Examples:",
//       "- user_001",
//       "- admin_test",
//     ].join("\n"),
//     "YuanBao Bot allowlist",
//   );

//   while (true) {
//     const entry = await params.prompter.text({
//       message: "YuanBao Bot allowFrom (user account IDs)",
//       placeholder: "user_001, user_002",
//       initialValue: existing[0] ? String(existing[0]) : undefined,
//       validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
//     });
//     const parts = parseAllowFromInput(String(entry));
//     if (parts.length === 0) {
//       await params.prompter.note("Enter at least one user.", "YuanBao Bot allowlist");
//       continue;
//     }

//     const unique = [
//       ...new Set([
//         ...existing.map((v: string | number) => String(v).trim()).filter(Boolean),
//         ...parts,
//       ]),
//     ];
//     return setYuanbaoAllowFrom(params.cfg, unique);
//   }
// }

/**
 * Display Yuanbao credential acquisition guide help info
 * @param prompter - 交互式提示器
 */
async function noteYuanbaoCredentialHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "You'll need values from YuanBao APP:",
      "",
      "• AppID & AppSecret → Create a robot from your Yuanbao APP to obtain.",
    ].join("\n"),
    "YuanBao Bot credentials",
  );
}

// const dmPolicy: ChannelOnboardingDmPolicy = {
//   label: "YuanBao Bot",
//   channel,
//   policyKey: "channels.yuanbao.dm.policy",
//   allowFromKey: "channels.yuanbao.dm.allowFrom",
//   getCurrent: (cfg) =>
//     (cfg.channels?.yuanbao as YuanbaoConfig | undefined)?.dm?.policy ?? "open",
//   setPolicy: (cfg, policy) => setYuanbaoDmPolicy(cfg, policy),
//   promptAllowFrom: promptYuanbaoAllowFrom,
// };

/**
 * 元宝渠道的 Onboarding 适配器
 *
 * Provides channel status check, credential configuration guidance, disable operations, etc.
 * 用于 OpenClaw CLI 的交互式初始化流程。
 */
export const yuanbaoOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }: { cfg: OpenClawConfig }) => {
    const account = resolveYuanbaoAccount({ cfg: cfg });
    const { configured } = account;

    const statusLines: string[] = [];
    if (!configured) {
      statusLines.push("YuanBao Bot: needs AppID + AppSecret");
    } else {
      statusLines.push(`YuanBao Bot: configured (AppID=${account.appKey ?? "?"})`);
    }

    return {
      channel,
      configured,
      statusLines,
      selectionHint: configured ? "configured" : "needs credentials",
      quickstartScore: configured ? 2 : 0,
    };
  },

  configure: async ({ cfg, prompter }: { cfg: OpenClawConfig; prompter: WizardPrompter }) => {
    const yuanbaoCfg = cfg.channels?.yuanbao as YuanbaoConfig | undefined;
    const hasConfigCreated = Boolean(yuanbaoCfg?.appKey?.trim() && yuanbaoCfg?.appSecret?.trim());

    let next = cfg;
    let appKey: string | null = null;
    let appSecret: string | null = null;

    if (!hasConfigCreated) {
      await noteYuanbaoCredentialHelp(prompter);
    }

    if (hasConfigCreated) {
      const keep = await prompter.confirm({
        message: "YuanBao Bot credentials already configured. Keep them?",
        initialValue: true,
      });
      if (!keep) {
        appKey = (
          await prompter.text({
            message: "Enter App ID (from bot application settings)",
            validate: (value: string) => (value?.trim() ? undefined : "Required"),
          })
        ).trim();
        appSecret = (
          await prompter.text({
            message: "Enter App Secret (from bot application settings)",
            validate: (value: string) => (value?.trim() ? undefined : "Required"),
          })
        ).trim();
      }
    } else {
      appKey = (
        await prompter.text({
          message: "Enter App ID (from bot application settings)",
          validate: (value: string) => (value?.trim() ? undefined : "Required"),
        })
      ).trim();
      appSecret = (
        await prompter.text({
          message: "Enter App Secret (from bot application settings)",
          validate: (value: string) => (value?.trim() ? undefined : "Required"),
        })
      ).trim();
    }

    if (appKey && appSecret) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          yuanbao: {
            ...next.channels?.yuanbao,
            enabled: true,
            appKey,
            appSecret,
            // dm: { policy: 'open' as const, allowFrom: ['*'] },
          },
        },
      };
    }

    // 保留已有配置时，确保 enabled 为 true 且Default值存在
    next = {
      ...next,
      channels: {
        ...next.channels,
        yuanbao: {
          // dm: { policy: 'open' as const, allowFrom: ['*'] },
          ...next.channels?.yuanbao,
          enabled: true,
        },
      },
    };

    return { cfg: next, accountId: DEFAULT_ACCOUNT_ID };
  },

  disable: (cfg: OpenClawConfig) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      yuanbao: { ...cfg.channels?.yuanbao, enabled: false },
    },
  }),
};
