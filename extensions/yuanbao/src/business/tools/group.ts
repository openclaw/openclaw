/**
 * 群信息相关 Tools
 *
 * Contains:
 * - query_group_info：查询当前群的基本信息（Group name、群主、Group member count）
 *
 * 通过 queryGroupInfo 接口（WS 协议）获取群信息。
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getMember } from "../../infra/cache/member.js";
import { extractGroupCode, type OpenClawPluginToolContext, json } from "../utils/utils.js";

// ---------------------------------------------------------------------------
// query_group_info
// ---------------------------------------------------------------------------

/**
 * 创建 query_group_info 工具定义。
 *
 * 调用 queryGroupInfo 接口获取群的基本信息，包括：
 * - Group name
 * - 群主（userId + 昵称）
 * - Group member count
 *
 * @param ctx - 工具上下文
 * @returns 工具定义对象，含 name / description / parameters / execute
 */
function createQueryGroupInfoTool(ctx: OpenClawPluginToolContext) {
  const sessionKey: string = ctx.sessionKey ?? "";
  const accountId: string = ctx.agentAccountId ?? "";

  return {
    name: "query_group_info",
    label: "Query Group Info",
    description:
      'Query basic info about the current group (called "派/Pai" in the app), ' +
      "including group name, group owner, and member count.",
    parameters: {
      type: "object",
      properties: {},
      required: [],
    },
    /**
     * Execute group info query.
     *
     * Query logic:
     * 1. 无 groupCode → 告知模型无群上下文
     * 2. 调用 queryGroupInfo 接口获取群基本信息
     *
     * @param _toolCallId - 工具调用 ID（框架传入，当前未使用）
     * @param _params - 工具参数（当前无参数）
     * @returns 包含查询结果的 JSON 响应
     */
    async execute(_toolCallId: string, _params: Record<string, unknown>) {
      // 从 sessionKey 中Extract groupCode
      const groupCode = extractGroupCode(sessionKey);

      // 1. 无 groupCode → 无法定位群
      if (!groupCode) {
        return json({
          success: false,
          msg: "No group context available, unable to query group info.",
        });
      }

      // 获取当前账号的 Member 实例
      const memberInst = getMember(accountId);

      // 2. 调用 queryGroupInfo 接口获取群信息
      const groupInfo = await memberInst.queryGroupInfo(groupCode);
      if (!groupInfo) {
        return json({
          success: false,
          msg: "Failed to query group info. The API may be unavailable.",
        });
      }

      return json({
        success: true,
        msg: "Group info retrieved.",
        note: 'The group is called "派 (Pai)" in the app.',
        groupInfo: {
          groupName: groupInfo.groupName,
          groupSize: groupInfo.groupSize,
          owner: {
            nickname: groupInfo.ownerNickName,
            userId: groupInfo.ownerUserId,
          },
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// 注册入口
// ---------------------------------------------------------------------------

/**
 * Register all tools under the "group info" category.
 *
 * 当前Contains:
 * - query_group_info：查询群基本信息（始终可用）
 *
 * @param api - OpenClaw 插件 API
 */
export function registerGroupTools(api: OpenClawPluginApi): void {
  api.registerTool(createQueryGroupInfoTool, { optional: false });
}
