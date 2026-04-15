import type { ReplyPayload } from "openclaw/plugin-sdk/core";
import type {
  OpenClawPluginCommandDefinition,
  PluginCommandContext,
} from "openclaw/plugin-sdk/core";
import { performUpgrade } from "./upgrade.js";

/**
 * All command names that trigger the upgrade flow.
 */
export const UPGRADE_COMMAND_NAMES = ["/yuanbao-upgrade", "/yuanbaobot-upgrade"] as const;

/**
 * Parse upgrade command: supports both bare command name and command with version parameter.
 *
 * Decouple "command matching" from "upgrade execution":
 * The upper layer only needs to check whether a match occurred and whether a target version is provided; subsequent flows can reuse the same upgrade entry.
 *
 * @param rawBody - 用户输入的完整Message body
 * @returns 命令解析结果；`matched=true` 表示命中升级命令，`version` 表示解析出的目标版本（可选）
 */
export function parseUpgradeCommand(rawBody: string): { matched: boolean; version?: string } {
  const body = rawBody.trim();
  for (const name of UPGRADE_COMMAND_NAMES) {
    if (body === name) {
      return { matched: true };
    }
    if (body.startsWith(`${name} `)) {
      const version = body.slice(name.length + 1).trim() || undefined;
      return { matched: true, version };
    }
  }
  return { matched: false };
}

/** 创建升级命令 */
function makeUpgradeCommand(name: string, description: string): OpenClawPluginCommandDefinition {
  return {
    name,
    description,
    requireAuth: false,
    acceptsArgs: true,
    handler: async (ctx: PluginCommandContext): Promise<ReplyPayload> => {
      const requested = ctx.args?.trim() || undefined;
      const text = await performUpgrade(ctx.config, ctx.accountId, undefined, requested);
      return { text };
    },
  };
}

export const yuanbaoUpgradeCommand = makeUpgradeCommand(
  UPGRADE_COMMAND_NAMES[0].slice(1),
  "升级 yuanbao 插件到最新正式版本",
);

export const yuanbaobotUpgradeCommand = makeUpgradeCommand(
  UPGRADE_COMMAND_NAMES[1].slice(1),
  "升级 yuanbao 插件到最新正式版本（别名）",
);
