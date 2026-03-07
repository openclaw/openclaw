/**
 * 钉钉群管理命令处理
 *
 * 拦截 /group 开头的聊天命令，调用群管理 API 并回复结果。
 *
 * 支持的命令:
 * - /group create <templateId> <title> [userId1,userId2,...]
 * - /group info <openConversationId>
 * - /group update <openConversationId> title=<新名称>
 * - /group addmembers <openConversationId> <userId1,userId2,...>
 * - /group removemembers <openConversationId> <userId1,userId2,...>
 * - /group members <openConversationId>
 * - /group dismiss <openConversationId>
 * - /group help
 */

import {
  createGroup,
  updateGroup,
  addGroupMembers,
  removeGroupMembers,
  listAllGroupMembers,
  getGroupInfo,
  dismissGroup,
} from "./group-management.js";
import { dingtalkLogger } from "./logger.js";
import { sendMessageDingtalk } from "./send.js";
import type { DingtalkConfig } from "./types.js";
import type { DingtalkMessageContext } from "./types.js";

/** 群管理命令前缀 */
const GROUP_COMMAND_PREFIX = "/group";

/**
 * 检查消息是否为群管理命令
 */
export function isGroupCommand(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  return trimmed === GROUP_COMMAND_PREFIX || trimmed.startsWith(`${GROUP_COMMAND_PREFIX} `);
}

/**
 * 向用户发送命令执行结果
 */
async function replyToUser(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  text: string,
): Promise<void> {
  const targetId = ctx.chatType === "group" ? ctx.conversationId : ctx.senderId;
  await sendMessageDingtalk({
    cfg,
    to: targetId,
    text,
    chatType: ctx.chatType === "group" ? "group" : "direct",
  });
}

/**
 * 解析逗号分隔的用户 ID 列表
 */
function parseUserIds(input: string): string[] {
  return input
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/**
 * 处理群管理命令
 *
 * @param cfg 钉钉配置
 * @param ctx 消息上下文
 * @returns true 表示命令已处理，false 表示不是群管理命令
 */
export async function handleGroupCommand(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
): Promise<boolean> {
  if (!isGroupCommand(ctx.content)) {
    return false;
  }

  const parts = ctx.content.trim().split(/\s+/);
  const subCommand = parts[1]?.toLowerCase() ?? "help";

  dingtalkLogger.info(`[group-cmd] ${ctx.senderId} invoked: ${subCommand}`);

  try {
    switch (subCommand) {
      case "create":
        await handleCreate(cfg, ctx, parts.slice(2));
        break;
      case "info":
        await handleInfo(cfg, ctx, parts.slice(2));
        break;
      case "update":
        await handleUpdate(cfg, ctx, parts.slice(2));
        break;
      case "addmembers":
        await handleAddMembers(cfg, ctx, parts.slice(2));
        break;
      case "removemembers":
        await handleRemoveMembers(cfg, ctx, parts.slice(2));
        break;
      case "members":
        await handleListMembers(cfg, ctx, parts.slice(2));
        break;
      case "dismiss":
        await handleDismiss(cfg, ctx, parts.slice(2));
        break;
      case "help":
      default:
        await handleHelp(cfg, ctx);
        break;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    dingtalkLogger.error(`[group-cmd] ${subCommand} failed: ${errorMessage}`);
    await replyToUser(cfg, ctx, `❌ 命令执行失败: ${errorMessage}`);
  }

  return true;
}

// ============================================================================
// 子命令处理
// ============================================================================

async function handleCreate(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  if (args.length < 2) {
    await replyToUser(
      cfg,
      ctx,
      "⚠️ 用法: `/group create <templateId> <群名称> [userId1,userId2,...]`",
    );
    return;
  }

  const templateId = args[0];
  const title = args[1];
  const userIds = args[2] ? parseUserIds(args[2]) : [];

  const result = await createGroup(cfg, {
    templateId,
    ownerUserId: ctx.senderId,
    title,
    userIds,
  });

  await replyToUser(
    cfg,
    ctx,
    [
      "✅ 群创建成功",
      `- **群名称**: ${title}`,
      `- **openConversationId**: ${result.openConversationId}`,
      `- **chatId**: ${result.chatId}`,
    ].join("\n"),
  );
}

async function handleInfo(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  if (args.length < 1) {
    await replyToUser(cfg, ctx, "⚠️ 用法: `/group info <openConversationId>`");
    return;
  }

  const openConversationId = args[0];
  const info = await getGroupInfo(cfg, { openConversationId });

  const lines = ["📋 **群信息**"];
  if (info.title) lines.push(`- **群名称**: ${info.title}`);
  if (info.ownerUserId) lines.push(`- **群主**: ${info.ownerUserId}`);
  if (info.icon) lines.push(`- **头像**: ${info.icon}`);
  if (info.memberCount !== undefined) lines.push(`- **成员数**: ${info.memberCount}`);
  lines.push(`- **openConversationId**: ${openConversationId}`);

  await replyToUser(cfg, ctx, lines.join("\n"));
}

async function handleUpdate(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  if (args.length < 2) {
    await replyToUser(cfg, ctx, "⚠️ 用法: `/group update <openConversationId> title=<新名称>`");
    return;
  }

  const openConversationId = args[0];
  const updateArgs = args.slice(1).join(" ");

  // 解析 key=value 参数
  const titleMatch = updateArgs.match(/title=(.+)/);
  if (!titleMatch) {
    await replyToUser(cfg, ctx, "⚠️ 目前支持的更新参数: `title=<新名称>`");
    return;
  }

  await updateGroup(cfg, {
    openConversationId,
    title: titleMatch[1].trim(),
  });

  await replyToUser(cfg, ctx, `✅ 群信息已更新 (${openConversationId})`);
}

async function handleAddMembers(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  if (args.length < 2) {
    await replyToUser(
      cfg,
      ctx,
      "⚠️ 用法: `/group addmembers <openConversationId> <userId1,userId2,...>`",
    );
    return;
  }

  const openConversationId = args[0];
  const userIds = parseUserIds(args[1]);

  if (userIds.length === 0) {
    await replyToUser(cfg, ctx, "⚠️ 请提供至少一个用户 ID");
    return;
  }

  await addGroupMembers(cfg, { openConversationId, userIds });
  await replyToUser(cfg, ctx, `✅ 已添加 ${userIds.length} 个成员到群 (${openConversationId})`);
}

async function handleRemoveMembers(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  if (args.length < 2) {
    await replyToUser(
      cfg,
      ctx,
      "⚠️ 用法: `/group removemembers <openConversationId> <userId1,userId2,...>`",
    );
    return;
  }

  const openConversationId = args[0];
  const userIds = parseUserIds(args[1]);

  if (userIds.length === 0) {
    await replyToUser(cfg, ctx, "⚠️ 请提供至少一个用户 ID");
    return;
  }

  await removeGroupMembers(cfg, { openConversationId, userIds });
  await replyToUser(cfg, ctx, `✅ 已从群中移除 ${userIds.length} 个成员 (${openConversationId})`);
}

async function handleListMembers(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  if (args.length < 1) {
    await replyToUser(cfg, ctx, "⚠️ 用法: `/group members <openConversationId>`");
    return;
  }

  const openConversationId = args[0];
  const memberIds = await listAllGroupMembers(cfg, openConversationId);

  if (memberIds.length === 0) {
    await replyToUser(cfg, ctx, `📋 群 (${openConversationId}) 暂无成员`);
    return;
  }

  const displayLimit = 50;
  const displayIds = memberIds.slice(0, displayLimit);
  const lines = [`📋 **群成员** (共 ${memberIds.length} 人)`];
  for (const memberId of displayIds) {
    lines.push(`- ${memberId}`);
  }
  if (memberIds.length > displayLimit) {
    lines.push(`- ... 还有 ${memberIds.length - displayLimit} 人`);
  }

  await replyToUser(cfg, ctx, lines.join("\n"));
}

async function handleDismiss(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  if (args.length < 1) {
    await replyToUser(cfg, ctx, "⚠️ 用法: `/group dismiss <openConversationId>`");
    return;
  }

  const openConversationId = args[0];
  await dismissGroup(cfg, openConversationId);
  await replyToUser(cfg, ctx, `✅ 群已解散 (${openConversationId})`);
}

async function handleHelp(cfg: DingtalkConfig, ctx: DingtalkMessageContext): Promise<void> {
  const helpText = [
    "🤖 **群管理命令**",
    "",
    "**创建群**",
    "`/group create <templateId> <群名称> [userId1,userId2,...]`",
    "",
    "**查询群信息**",
    "`/group info <openConversationId>`",
    "",
    "**更新群名称**",
    "`/group update <openConversationId> title=<新名称>`",
    "",
    "**添加成员**",
    "`/group addmembers <openConversationId> <userId1,userId2,...>`",
    "",
    "**移除成员**",
    "`/group removemembers <openConversationId> <userId1,userId2,...>`",
    "",
    "**查询成员列表**",
    "`/group members <openConversationId>`",
    "",
    "**解散群** ⚠️ 不可恢复",
    "`/group dismiss <openConversationId>`",
  ].join("\n");

  await replyToUser(cfg, ctx, helpText);
}
