/**
 * 钉钉文档命令处理
 *
 * 拦截 /doc 开头的聊天命令，调用文档管理 API 并回复结果。
 *
 * 支持的命令:
 * - /doc spaces - 查看知识库列表
 * - /doc create <spaceId> <文档名称> - 在知识库中创建文档
 * - /doc list <spaceId> - 查看知识库中的文档列表
 * - /doc info <spaceId> <nodeId> - 查看文档详情
 * - /doc delete <spaceId> <nodeId> - 删除文档
 * - /doc help
 */

import {
  listDocSpaces,
  createDocument,
  listDocNodes,
  getDocumentInfo,
  deleteDocNode,
} from "./doc-management.js";
import { dingtalkLogger } from "./logger.js";
import { sendMessageDingtalk } from "./send.js";
import type { DingtalkConfig, DingtalkMessageContext } from "./types.js";

/** 文档命令前缀 */
const DOC_COMMAND_PREFIX = "/doc";

/**
 * 检查消息是否为文档命令
 */
export function isDocCommand(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  return trimmed === DOC_COMMAND_PREFIX || trimmed.startsWith(`${DOC_COMMAND_PREFIX} `);
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
 * 格式化文档类型
 */
function formatDocType(docType: string | undefined): string {
  switch (docType) {
    case "alidoc":
      return "📄 文档";
    case "sheet":
      return "📊 表格";
    case "folder":
      return "📁 文件夹";
    case "mindmap":
      return "🧠 脑图";
    default:
      return `📎 ${docType ?? "未知"}`;
  }
}

/**
 * 处理文档命令
 *
 * @param cfg 钉钉配置
 * @param ctx 消息上下文
 * @returns true 表示命令已处理，false 表示不是文档命令
 */
export async function handleDocCommand(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
): Promise<boolean> {
  if (!isDocCommand(ctx.content)) {
    return false;
  }

  const parts = ctx.content.trim().split(/\s+/);
  const subCommand = parts[1]?.toLowerCase() ?? "help";

  dingtalkLogger.info(`[doc-cmd] ${ctx.senderId} invoked: ${subCommand}`);

  try {
    switch (subCommand) {
      case "spaces":
        await handleSpaces(cfg, ctx);
        break;
      case "create":
        await handleCreate(cfg, ctx, parts.slice(2));
        break;
      case "list":
        await handleList(cfg, ctx, parts.slice(2));
        break;
      case "info":
        await handleInfo(cfg, ctx, parts.slice(2));
        break;
      case "delete":
        await handleDelete(cfg, ctx, parts.slice(2));
        break;
      case "help":
      default:
        await handleHelp(cfg, ctx);
        break;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    dingtalkLogger.error(`[doc-cmd] ${subCommand} failed: ${errorMessage}`);
    await replyToUser(cfg, ctx, `❌ 命令执行失败: ${errorMessage}`);
  }

  return true;
}

// ============================================================================
// 子命令处理
// ============================================================================

async function handleSpaces(cfg: DingtalkConfig, ctx: DingtalkMessageContext): Promise<void> {
  const result = await listDocSpaces(cfg, ctx.senderId);

  if (!result.items?.length) {
    await replyToUser(cfg, ctx, "📚 暂无知识库");
    return;
  }

  const lines = [`📚 **知识库列表** (共 ${result.items.length} 个)`];

  for (const space of result.items) {
    lines.push(`- 📖 **${space.name ?? "未命名"}** (ID: ${space.id})`);
  }

  await replyToUser(cfg, ctx, lines.join("\n"));
}

async function handleCreate(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  if (args.length < 2) {
    await replyToUser(
      cfg,
      ctx,
      "⚠️ 用法: `/doc create <spaceId> <文档名称>`\n示例: `/doc create space123 项目周报`",
    );
    return;
  }

  const spaceId = args[0];
  const documentName = args.slice(1).join(" ");

  const node = await createDocument(cfg, ctx.senderId, spaceId, {
    name: documentName,
    docType: "alidoc",
  });

  const lines = [
    "📄 文档创建成功",
    `- **名称**: ${documentName}`,
    `- **知识库ID**: ${spaceId}`,
    `- **节点ID**: ${node.nodeId}`,
  ];
  if (node.url) lines.push(`- **链接**: ${node.url}`);

  await replyToUser(cfg, ctx, lines.join("\n"));
}

async function handleList(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  if (args.length < 1) {
    await replyToUser(cfg, ctx, "⚠️ 用法: `/doc list <spaceId>`");
    return;
  }

  const spaceId = args[0];
  const result = await listDocNodes(cfg, ctx.senderId, spaceId);

  if (!result.items?.length) {
    await replyToUser(cfg, ctx, `📚 知识库 ${spaceId} 中暂无文档`);
    return;
  }

  const lines = [`📚 **文档列表** (共 ${result.items.length} 项)`];

  for (const node of result.items.slice(0, 20)) {
    const typeIcon = formatDocType(node.docType);
    lines.push(`- ${typeIcon} **${node.name ?? "未命名"}** (ID: ${node.nodeId})`);
  }

  if (result.items.length > 20) {
    lines.push(`\n... 还有 ${result.items.length - 20} 项未显示`);
  }

  await replyToUser(cfg, ctx, lines.join("\n"));
}

async function handleInfo(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  if (args.length < 2) {
    await replyToUser(cfg, ctx, "⚠️ 用法: `/doc info <spaceId> <nodeId>`");
    return;
  }

  const spaceId = args[0];
  const nodeId = args[1];
  const node = await getDocumentInfo(cfg, ctx.senderId, spaceId, nodeId);

  const lines = [
    "📄 **文档详情**",
    `- **名称**: ${node.name ?? "未命名"}`,
    `- **类型**: ${formatDocType(node.docType)}`,
    `- **知识库ID**: ${spaceId}`,
    `- **节点ID**: ${nodeId}`,
  ];
  if (node.url) lines.push(`- **链接**: ${node.url}`);
  if (node.creatorId) lines.push(`- **创建者**: ${node.creatorId}`);
  if (node.createdTime) {
    lines.push(
      `- **创建时间**: ${new Date(node.createdTime).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    );
  }
  if (node.updatedTime) {
    lines.push(
      `- **更新时间**: ${new Date(node.updatedTime).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    );
  }

  await replyToUser(cfg, ctx, lines.join("\n"));
}

async function handleDelete(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  if (args.length < 2) {
    await replyToUser(cfg, ctx, "⚠️ 用法: `/doc delete <spaceId> <nodeId>`");
    return;
  }

  const spaceId = args[0];
  const nodeId = args[1];
  await deleteDocNode(cfg, ctx.senderId, spaceId, nodeId);
  await replyToUser(cfg, ctx, `🗑️ 文档已删除 (知识库: ${spaceId}, 节点: ${nodeId})`);
}

async function handleHelp(cfg: DingtalkConfig, ctx: DingtalkMessageContext): Promise<void> {
  await replyToUser(
    cfg,
    ctx,
    [
      "📄 **文档命令帮助**",
      "",
      "- `/doc spaces` - 查看知识库列表",
      "- `/doc create <spaceId> <文档名称>` - 创建文档",
      "- `/doc list <spaceId>` - 查看知识库文档列表",
      "- `/doc info <spaceId> <nodeId>` - 查看文档详情",
      "- `/doc delete <spaceId> <nodeId>` - 删除文档",
      "- `/doc help` - 显示此帮助",
    ].join("\n"),
  );
}
