/**
 * 成员相关 Tools
 *
 * Contains:
 * - query_session_members：查询会话成员（按昵称查找、@mention、列举全部等）
 *
 * 查询策略：优先通过 GroupMember（WS 接口层）获取 → 降级到 SessionMember（会话缓存层）。
 * 群主信息请使用 query_group_info 工具查询。
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getMember } from "../../infra/cache/member.js";
import { extractGroupCode, type OpenClawPluginToolContext, json } from "../utils/utils.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** @mention 提示文案（作为 JSON 字段值） */
const MENTION_HINT_TEXT =
  'To @mention a user, you MUST use the format: space + @ + nickname + space (e.g. " @Alice ").';

/** 用户角色类型映射（0=未定义，1=用户，2=元宝，3=bot） */
const USER_TYPE_LABEL: Record<number, string> = {
  0: "undefined",
  1: "user",
  2: "yuanbao",
  3: "bot",
};

// ---------------------------------------------------------------------------
// 成员记录类型 & 映射工具
// ---------------------------------------------------------------------------

/** queryMembers 返回的单条成员记录 */
type MemberRecord = { nickName: string; userId: string; userType?: number };

/** 将用户记录映射为精简格式 */
function toMembers(records: MemberRecord[]) {
  return records.map((u) => ({
    nickname: u.nickName,
    userId: u.userId,
    ...(u.userType !== undefined
      ? { role: USER_TYPE_LABEL[u.userType] ?? `type_${u.userType}` }
      : {}),
  }));
}

// ---------------------------------------------------------------------------
// action 处理函数
// ---------------------------------------------------------------------------

/** 列举群内 bot（包含元宝 AI 助手和其他 bot） */
function handleListBots(allMembers: MemberRecord[], mention: boolean) {
  const bots = allMembers.filter((u) => u.userType === 2 || u.userType === 3);
  if (bots.length === 0) {
    return json({ success: false, msg: "No bot info available. Role data requires API fetch." });
  }
  return json({
    success: true,
    msg: `Found ${bots.length} bot(s) in this group.`,
    members: toMembers(bots),
    ...(mention ? { mentionHint: MENTION_HINT_TEXT } : {}),
  });
}

/**
 * Fuzzy search group members by nickname.
 *
 * Lookup strategy (by priority):
 * 1. 有 nameFilter → 大小写不敏感模糊匹配，命中则返回匹配结果
 * 2. 有 nameFilter 但无匹配 → 返回全部成员列表，让模型自行分析最接近的用户
 * 3. 无 nameFilter → 降级为 list_all 行为，返回全部成员
 *
 * @param allMembers - 当前群的完整成员列表
 * @param nameFilter - 用户输入的昵称关键词（支持部分匹配），为空时返回全部成员
 * @param mention - 是否需要 @mention 目标用户；为 true 时响应中附带 mentionHint 提示格式
 * @returns JSON 格式的查询结果，包含 success 状态、提示信息、匹配的成员列表及可选的 mention 提示
 */
function handleFind(allMembers: MemberRecord[], nameFilter: string, mention: boolean) {
  const hint = mention ? { mentionHint: MENTION_HINT_TEXT } : {};

  if (nameFilter) {
    const filter = nameFilter.toLowerCase();
    const matched = allMembers.filter((u) => u.nickName.toLowerCase().includes(filter));

    if (matched.length > 0) {
      return json({
        success: true,
        msg: `Found ${matched.length} member(s) matching "${nameFilter}".`,
        members: toMembers(matched),
        ...hint,
      });
    }

    // 按昵称未查到，返回全部成员供模型分析
    return json({
      success: false,
      msg: `No exact match for "${nameFilter}". Please find the target user from the members list below.`,
      members: toMembers(allMembers),
      ...hint,
    });
  }

  // find 但未提供 nameFilter，降级返回全部成员
  return json({
    success: true,
    msg: `Found ${allMembers.length} member(s) in this group.`,
    members: toMembers(allMembers),
    ...hint,
  });
}

/** 列举全部成员 */
function handleListAll(allMembers: MemberRecord[], mention: boolean) {
  return json({
    success: true,
    msg: `Found ${allMembers.length} member(s) in this group.`,
    members: toMembers(allMembers),
    ...(mention ? { mentionHint: MENTION_HINT_TEXT } : {}),
  });
}

// ---------------------------------------------------------------------------
// query_session_members
// ---------------------------------------------------------------------------

/**
 * 创建 query_session_members 工具定义。
 *
 * 合并了原 lookup_session_members 与 query_group_members，统一为一个工具。
 * 优先通过接口拉取完整群成员列表，session 缓存作为兜底。
 *
 * @param ctx - 工具上下文
 * @returns 工具定义对象，含 name / description / parameters / execute
 */
function createQuerySessionMembersTool(ctx: OpenClawPluginToolContext) {
  const sessionKey: string = ctx.sessionKey ?? "";
  const accountId: string = ctx.agentAccountId ?? "";

  return {
    name: "query_session_members",
    label: "Query Session Members",
    description:
      'Query session members in the current group (called "派/Pai" in the app): ' +
      "find a user by name, @mention someone, list bots (including Yuanbao AI assistants), or list all members.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["find", "list_bots", "list_all"],
          description:
            "Interaction type. " +
            "find — search a user by name; " +
            "list_bots — list bots (including Yuanbao AI assistants) in the group; " +
            "list_all — list all recorded members.",
        },
        name: {
          type: "string",
          description:
            "User name to search (partial match, case-insensitive). " +
            'Required for "find", ignored for other actions.',
        },
        mention: {
          type: "boolean",
          description: "Set to true when you need to @mention the user(s) in the reply. ",
        },
      },
      required: ["action", "mention"],
    },
    /**
     * Execute session member query.
     *
     * Query logic:
     * 1. 无 groupCode → 告知模型无群上下文
     * 2. 通过 Member 门面查询：优先 GroupMember（WS 接口）→ 降级 SessionMember（会话缓存）
     * 3. 按 action 分发到各处理函数
     *
     * @param _toolCallId - 工具调用 ID（框架传入，当前未使用）
     * @param params - 工具参数，包含 action、可选的 name 和 mention
     * @returns 包含查询结果的 JSON 响应
     */
    async execute(_toolCallId: string, params: Record<string, unknown>) {
      const action = typeof params.action === "string" ? params.action : "list_all";
      const nameFilter = typeof params.name === "string" ? params.name.trim() : "";
      const mention = params.mention === true || params.mention === "true";

      // 从 sessionKey 中Extract groupCode（即元宝后台的 groupCode）
      const groupCode = extractGroupCode(sessionKey);

      if (!groupCode) {
        return json({
          success: false,
          msg: "No group context available, unable to query members.",
        });
      }

      const allMembers = await getMember(accountId).queryMembers(groupCode);

      if (allMembers.length === 0) {
        return json({ success: false, msg: "No members recorded in this group yet." });
      }

      switch (action) {
        case "list_bots":
          return handleListBots(allMembers, mention);
        case "find":
          return handleFind(allMembers, nameFilter, mention);
        case "list_all":
          return handleListAll(allMembers, mention);
        default:
          return json({
            success: false,
            msg: `Unsupported action "${action}". Valid actions: find, list_bots, list_all.`,
          });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// 注册入口
// ---------------------------------------------------------------------------

/**
 * Register all tools under the "member" category.
 *
 * 当前Contains:
 * - query_session_members：查询会话成员（始终可用）
 *
 * @param api - OpenClaw 插件 API
 */
export function registerMemberTools(api: OpenClawPluginApi): void {
  api.registerTool(createQuerySessionMembersTool, { optional: false });
}
