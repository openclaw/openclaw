/**
 * 钉钉待办任务命令处理
 *
 * 拦截 /todo 开头的聊天命令，调用待办管理 API 并回复结果。
 *
 * 支持的命令:
 * - /todo create <标题> [描述]
 * - /todo list [done|undone]
 * - /todo done <taskId>
 * - /todo delete <taskId>
 * - /todo info <taskId>
 * - /todo help
 */

import { dingtalkLogger } from "./logger.js";
import { sendMessageDingtalk } from "./send.js";
import {
  createTodoTask,
  listTodoTasks,
  getTodoTask,
  updateTodoTask,
  deleteTodoTask,
} from "./todo-management.js";
import type { DingtalkConfig, DingtalkMessageContext } from "./types.js";

/** 待办命令前缀 */
const TODO_COMMAND_PREFIX = "/todo";

/**
 * 检查消息是否为待办命令
 */
export function isTodoCommand(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  return trimmed === TODO_COMMAND_PREFIX || trimmed.startsWith(`${TODO_COMMAND_PREFIX} `);
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
 * 格式化时间戳为可读字符串
 */
function formatTimestamp(timestamp: number | undefined): string {
  if (!timestamp) return "未设置";
  return new Date(timestamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

/**
 * 格式化优先级
 */
function formatPriority(priority: number | undefined): string {
  switch (priority) {
    case 10:
      return "🔴 紧急";
    case 20:
      return "🟠 高";
    case 30:
      return "🟡 中";
    case 40:
      return "🟢 低";
    default:
      return "普通";
  }
}

/**
 * 处理待办命令
 *
 * @param cfg 钉钉配置
 * @param ctx 消息上下文
 * @returns true 表示命令已处理，false 表示不是待办命令
 */
export async function handleTodoCommand(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
): Promise<boolean> {
  if (!isTodoCommand(ctx.content)) {
    return false;
  }

  const parts = ctx.content.trim().split(/\s+/);
  const subCommand = parts[1]?.toLowerCase() ?? "help";

  dingtalkLogger.info(`[todo-cmd] ${ctx.senderId} invoked: ${subCommand}`);

  try {
    switch (subCommand) {
      case "create":
        await handleCreate(cfg, ctx, parts.slice(2));
        break;
      case "list":
        await handleList(cfg, ctx, parts.slice(2));
        break;
      case "done":
        await handleDone(cfg, ctx, parts.slice(2));
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
    dingtalkLogger.error(`[todo-cmd] ${subCommand} failed: ${errorMessage}`);
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
  if (args.length < 1) {
    await replyToUser(
      cfg,
      ctx,
      "⚠️ 用法: `/todo create <标题> [描述]`\n示例: `/todo create 完成周报 本周工作总结`",
    );
    return;
  }

  const subject = args[0];
  const description = args.length > 1 ? args.slice(1).join(" ") : undefined;

  // 解析可选的截止时间（如果标题中包含 @tomorrow, @today 等）
  let dueTime: number | undefined;
  const now = Date.now();
  const oneDayMs = 86_400_000;

  if (subject.includes("@tomorrow")) {
    dueTime = now + oneDayMs;
  } else if (subject.includes("@nextweek")) {
    dueTime = now + 7 * oneDayMs;
  }

  const cleanSubject = subject.replace(/@(tomorrow|nextweek|today)/g, "").trim();

  const task = await createTodoTask(cfg, ctx.senderId, {
    subject: cleanSubject || subject,
    description,
    dueTime,
    executorIds: [ctx.senderId],
  });

  const lines = [
    "✅ 待办创建成功",
    `- **标题**: ${task.subject ?? cleanSubject}`,
    `- **任务ID**: ${task.id}`,
  ];
  if (dueTime) lines.push(`- **截止时间**: ${formatTimestamp(dueTime)}`);
  if (description) lines.push(`- **描述**: ${description}`);

  await replyToUser(cfg, ctx, lines.join("\n"));
}

async function handleList(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  const filterArg = args[0]?.toLowerCase();
  let isDone: boolean | undefined;

  if (filterArg === "done") {
    isDone = true;
  } else if (filterArg === "undone") {
    isDone = false;
  }

  const result = await listTodoTasks(cfg, ctx.senderId, { isDone });

  if (!result.todoCards?.length) {
    const statusText = isDone === true ? "已完成" : isDone === false ? "未完成" : "";
    await replyToUser(cfg, ctx, `📋 暂无${statusText}待办任务`);
    return;
  }

  const lines = [`📋 **待办任务列表** (共 ${result.todoCards.length} 项)`];

  for (const task of result.todoCards.slice(0, 20)) {
    const statusIcon = task.isDone ? "✅" : "⬜";
    const dueText = task.dueTime ? ` | 截止: ${formatTimestamp(task.dueTime)}` : "";
    lines.push(
      `${statusIcon} ${task.subject ?? "无标题"} (ID: ${task.taskId ?? "unknown"})${dueText}`,
    );
  }

  if (result.todoCards.length > 20) {
    lines.push(`\n... 还有 ${result.todoCards.length - 20} 项未显示`);
  }

  await replyToUser(cfg, ctx, lines.join("\n"));
}

async function handleDone(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  if (args.length < 1) {
    await replyToUser(cfg, ctx, "⚠️ 用法: `/todo done <taskId>`");
    return;
  }

  const taskId = args[0];
  await updateTodoTask(cfg, ctx.senderId, taskId, { done: true });
  await replyToUser(cfg, ctx, `✅ 待办任务已标记完成 (ID: ${taskId})`);
}

async function handleInfo(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  if (args.length < 1) {
    await replyToUser(cfg, ctx, "⚠️ 用法: `/todo info <taskId>`");
    return;
  }

  const taskId = args[0];
  const task = await getTodoTask(cfg, ctx.senderId, taskId);

  const lines = [
    "📋 **待办详情**",
    `- **标题**: ${task.subject ?? "无标题"}`,
    `- **状态**: ${task.done ? "✅ 已完成" : "⬜ 未完成"}`,
    `- **优先级**: ${formatPriority(task.priority)}`,
    `- **创建时间**: ${formatTimestamp(task.createdTime)}`,
    `- **截止时间**: ${formatTimestamp(task.dueTime)}`,
  ];
  if (task.description) lines.push(`- **描述**: ${task.description}`);
  lines.push(`- **任务ID**: ${taskId}`);

  await replyToUser(cfg, ctx, lines.join("\n"));
}

async function handleDelete(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  if (args.length < 1) {
    await replyToUser(cfg, ctx, "⚠️ 用法: `/todo delete <taskId>`");
    return;
  }

  const taskId = args[0];
  await deleteTodoTask(cfg, ctx.senderId, taskId);
  await replyToUser(cfg, ctx, `🗑️ 待办任务已删除 (ID: ${taskId})`);
}

async function handleHelp(cfg: DingtalkConfig, ctx: DingtalkMessageContext): Promise<void> {
  await replyToUser(
    cfg,
    ctx,
    [
      "📋 **待办任务命令帮助**",
      "",
      "- `/todo create <标题> [描述]` - 创建待办任务",
      "  - 标题中可加 `@tomorrow` 设置明天截止",
      "  - 标题中可加 `@nextweek` 设置下周截止",
      "- `/todo list [done|undone]` - 查看待办列表",
      "- `/todo done <taskId>` - 标记任务完成",
      "- `/todo info <taskId>` - 查看任务详情",
      "- `/todo delete <taskId>` - 删除任务",
      "- `/todo help` - 显示此帮助",
    ].join("\n"),
  );
}
