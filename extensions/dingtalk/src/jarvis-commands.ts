/**
 * Jarvis 快捷指令处理
 *
 * 拦截 /jarvis 开头的聊天命令，提供贾维斯式的快捷操作。
 *
 * 支持的命令:
 * - /jarvis status   - 查看当前任务状态和会话概览
 * - /jarvis history  - 查看最近任务历史
 * - /jarvis clear    - 清除会话上下文和活跃卡片
 * - /jarvis redo     - 重做上一个已完成/失败的任务
 * - /jarvis result   - 查看上一个任务的结果
 * - /jarvis config   - 查看当前 Jarvis 配置
 * - /jarvis help     - 显示帮助信息
 */

import { getGlobalTaskQueue } from "./async-task-queue.js";
import type { DingtalkConfig } from "./config.js";
import { JarvisPersona } from "./jarvis-persona.js";
import { dingtalkLogger } from "./logger.js";
import { sendMessageDingtalk } from "./send.js";
import { getGlobalContextManager } from "./task-context-manager.js";
import type { DingtalkMessageContext } from "./types.js";

/** Jarvis 命令前缀 */
const JARVIS_COMMAND_PREFIX = "/jarvis";

/**
 * 检查消息是否为 Jarvis 命令
 */
export function isJarvisCommand(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  return trimmed === JARVIS_COMMAND_PREFIX || trimmed.startsWith(`${JARVIS_COMMAND_PREFIX} `);
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
 * 格式化时间为相对描述（如"3分钟前"）
 */
function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSeconds = Math.floor(diffMs / 1000);
  const diffMinutes = Math.floor(diffSeconds / 60);
  const diffHours = Math.floor(diffMinutes / 60);

  if (diffSeconds < 60) return `${diffSeconds}秒前`;
  if (diffMinutes < 60) return `${diffMinutes}分钟前`;
  if (diffHours < 24) return `${diffHours}小时前`;
  return `${Math.floor(diffHours / 24)}天前`;
}

/**
 * 格式化任务状态图标
 */
function formatStatusIcon(status: string): string {
  switch (status) {
    case "completed":
      return "✅";
    case "failed":
      return "❌";
    case "running":
      return "🔄";
    case "pending":
      return "⏳";
    case "cancelled":
      return "🚫";
    default:
      return "❓";
  }
}

/**
 * 格式化任务状态文本
 */
function formatStatusText(status: string): string {
  switch (status) {
    case "completed":
      return "已完成";
    case "failed":
      return "失败";
    case "running":
      return "运行中";
    case "pending":
      return "排队中";
    case "cancelled":
      return "已取消";
    default:
      return "未知";
  }
}

/**
 * 处理 Jarvis 命令
 *
 * @param cfg 钉钉配置
 * @param ctx 消息上下文
 * @returns true 表示命令已处理，false 表示不是 Jarvis 命令
 */
export async function handleJarvisCommand(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
): Promise<boolean> {
  if (!isJarvisCommand(ctx.content)) {
    return false;
  }

  const parts = ctx.content.trim().split(/\s+/);
  const subCommand = parts[1]?.toLowerCase() ?? "help";

  dingtalkLogger.info(`[jarvis-cmd] ${ctx.senderId} invoked: ${subCommand}`);

  try {
    switch (subCommand) {
      case "status":
        await handleStatus(cfg, ctx);
        break;
      case "history":
        await handleHistory(cfg, ctx, parts.slice(2));
        break;
      case "clear":
        await handleClear(cfg, ctx);
        break;
      case "redo":
        await handleRedo(cfg, ctx);
        break;
      case "result":
        await handleResult(cfg, ctx);
        break;
      case "config":
        await handleConfig(cfg, ctx);
        break;
      case "help":
      default:
        await handleHelp(cfg, ctx);
        break;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    dingtalkLogger.error(`[jarvis-cmd] ${subCommand} failed: ${errorMessage}`);
    await replyToUser(cfg, ctx, `❌ 命令执行失败: ${errorMessage}`);
  }

  return true;
}

// ============================================================================
// 子命令处理
// ============================================================================

/**
 * /jarvis status - 查看当前任务状态和会话概览
 */
async function handleStatus(cfg: DingtalkConfig, ctx: DingtalkMessageContext): Promise<void> {
  const persona = JarvisPersona.fromDingtalkConfig(cfg);
  const contextManager = getGlobalContextManager();
  const sessionKey = `${ctx.conversationId}:${ctx.senderId}`;

  const activeTasks = contextManager.getActiveTasks(sessionKey);
  const sessionStats = contextManager.getSessionStats();
  const taskQueue = getGlobalTaskQueue(cfg.asyncMode);
  const userTasks = taskQueue.getUserTasks(ctx.senderId);

  const lines: string[] = [];

  // 标题
  if (persona.isEnabled() && persona.getTone() === "jarvis") {
    lines.push(`🤖 **Jarvis 状态报告**，${persona.getHonorific()}。`);
  } else {
    lines.push("📊 **系统状态**");
  }

  lines.push("");

  // 活跃任务
  if (activeTasks.length > 0) {
    lines.push(`**🔄 活跃任务** (${activeTasks.length})`);
    for (const task of activeTasks) {
      const elapsed = formatRelativeTime(task.createdAt);
      lines.push(
        `- ${formatStatusIcon(task.status)} ${task.description.substring(0, 60)} (${elapsed})`,
      );
    }
    lines.push("");
  }

  // 队列中的任务
  const pendingTasks = userTasks.filter((task) => task.status === "pending");
  const runningTasks = userTasks.filter((task) => task.status === "running");

  if (runningTasks.length > 0 || pendingTasks.length > 0) {
    lines.push("**📋 任务队列**");
    lines.push(`- 运行中: ${runningTasks.length}`);
    lines.push(`- 排队中: ${pendingTasks.length}`);
    lines.push("");
  }

  // 活跃卡片状态
  const activeCard = contextManager.getActiveJarvisCard(sessionKey);
  if (activeCard) {
    lines.push("**🃏 活跃卡片**: 有");
  }

  // 会话统计
  lines.push("**📈 会话统计**");
  lines.push(`- 活跃会话: ${sessionStats.active}`);
  lines.push(`- 总会话数: ${sessionStats.total}`);

  // 如果没有任何活跃内容
  if (activeTasks.length === 0 && runningTasks.length === 0 && pendingTasks.length === 0) {
    lines.push("");
    if (persona.isEnabled() && persona.getTone() === "jarvis") {
      lines.push(`当前没有进行中的任务，${persona.getHonorific()}。随时待命。`);
    } else {
      lines.push("当前没有进行中的任务。");
    }
  }

  await replyToUser(cfg, ctx, lines.join("\n"));
}

/**
 * /jarvis history [count] - 查看最近任务历史
 */
async function handleHistory(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  const persona = JarvisPersona.fromDingtalkConfig(cfg);
  const contextManager = getGlobalContextManager();
  const sessionKey = `${ctx.conversationId}:${ctx.senderId}`;

  const requestedCount = args[0] ? parseInt(args[0], 10) : 10;
  const limit = Math.min(Math.max(requestedCount, 1), 20);
  const history = contextManager.getTaskHistory(sessionKey, limit);

  if (history.length === 0) {
    const emptyMessage =
      persona.isEnabled() && persona.getTone() === "jarvis"
        ? `暂无任务记录，${persona.getHonorific()}。`
        : "暂无任务记录。";
    await replyToUser(cfg, ctx, emptyMessage);
    return;
  }

  const lines: string[] = [`📜 **最近 ${history.length} 条任务记录**`, ""];

  for (const task of history) {
    const timeStr = formatRelativeTime(task.createdAt);
    const statusIcon = formatStatusIcon(task.status);
    const statusText = formatStatusText(task.status);
    let line = `${statusIcon} **${task.description.substring(0, 50)}**`;
    line += `\n  └ ${statusText} · ${timeStr}`;

    if (task.result) {
      line += `\n  └ 结果: ${task.result.substring(0, 80)}...`;
    }
    if (task.error) {
      line += `\n  └ 错误: ${task.error.substring(0, 80)}`;
    }

    lines.push(line);
  }

  await replyToUser(cfg, ctx, lines.join("\n"));
}

/**
 * /jarvis clear - 清除会话上下文和活跃卡片
 */
async function handleClear(cfg: DingtalkConfig, ctx: DingtalkMessageContext): Promise<void> {
  const persona = JarvisPersona.fromDingtalkConfig(cfg);
  const contextManager = getGlobalContextManager();
  const sessionKey = `${ctx.conversationId}:${ctx.senderId}`;

  // 清除 JarvisCard 关联
  contextManager.clearJarvisCard(sessionKey);

  // 销毁会话
  contextManager.destroySession(sessionKey);

  const confirmMessage =
    persona.isEnabled() && persona.getTone() === "jarvis"
      ? `会话上下文已清除，${persona.getHonorific()}。一切从头开始。`
      : "会话上下文已清除。";

  await replyToUser(cfg, ctx, `🧹 ${confirmMessage}`);
}

/**
 * /jarvis redo - 重做上一个已完成/失败的任务
 *
 * 返回上一个任务的描述，提示用户确认重新执行。
 * 实际重新执行由用户发送原始消息触发。
 */
async function handleRedo(cfg: DingtalkConfig, ctx: DingtalkMessageContext): Promise<void> {
  const persona = JarvisPersona.fromDingtalkConfig(cfg);
  const contextManager = getGlobalContextManager();
  const sessionKey = `${ctx.conversationId}:${ctx.senderId}`;

  const lastTask = contextManager.getLastCompletedTask(sessionKey);

  if (!lastTask) {
    const noTaskMessage =
      persona.isEnabled() && persona.getTone() === "jarvis"
        ? `没有找到可以重做的任务，${persona.getHonorific()}。`
        : "没有找到可以重做的任务。";
    await replyToUser(cfg, ctx, noTaskMessage);
    return;
  }

  const statusIcon = formatStatusIcon(lastTask.status);
  const statusText = formatStatusText(lastTask.status);
  const timeStr = formatRelativeTime(lastTask.createdAt);

  const lines = [
    "🔄 **上一个任务**",
    "",
    `${statusIcon} ${lastTask.description}`,
    `状态: ${statusText} · ${timeStr}`,
    "",
    "💡 如需重做，请直接重新发送原始指令。",
  ];

  await replyToUser(cfg, ctx, lines.join("\n"));
}

/**
 * /jarvis result - 查看上一个任务的结果
 */
async function handleResult(cfg: DingtalkConfig, ctx: DingtalkMessageContext): Promise<void> {
  const persona = JarvisPersona.fromDingtalkConfig(cfg);
  const contextManager = getGlobalContextManager();
  const sessionKey = `${ctx.conversationId}:${ctx.senderId}`;

  const lastResult = contextManager.getLastTaskResult(sessionKey);

  if (!lastResult) {
    const noResultMessage =
      persona.isEnabled() && persona.getTone() === "jarvis"
        ? `没有找到可查看的任务结果，${persona.getHonorific()}。`
        : "没有找到可查看的任务结果。";
    await replyToUser(cfg, ctx, noResultMessage);
    return;
  }

  const lines = [
    "📋 **上一个任务结果**",
    "",
    `**任务**: ${lastResult.description}`,
    "",
    lastResult.result,
  ];

  await replyToUser(cfg, ctx, lines.join("\n"));
}

/**
 * /jarvis config - 查看当前 Jarvis 配置
 */
async function handleConfig(cfg: DingtalkConfig, ctx: DingtalkMessageContext): Promise<void> {
  const persona = JarvisPersona.fromDingtalkConfig(cfg);
  const asyncConfig = cfg.asyncMode;

  const lines = [
    "⚙️ **Jarvis 配置**",
    "",
    "**人格设置**",
    `- 个性化: ${persona.isEnabled() ? "✅ 启用" : "❌ 禁用"}`,
    `- 称呼: ${persona.getHonorific()}`,
    `- 语气风格: ${persona.getTone()}`,
    "",
    "**异步任务**",
    `- 异步模式: ${asyncConfig?.enabled ? "✅ 启用" : "❌ 禁用"}`,
  ];

  if (asyncConfig?.enabled) {
    lines.push(`- 最大并发: ${asyncConfig.maxConcurrency ?? 3}`);
    lines.push(`- 任务超时: ${(asyncConfig.taskTimeoutMs ?? 300000) / 1000}秒`);
  }

  lines.push("");
  lines.push("**渠道设置**");
  lines.push(`- AI Card: ${cfg.enableAICard ? "✅ 启用" : "❌ 禁用"}`);
  lines.push(`- 历史消息: ${cfg.historyLimit ?? 10} 条`);

  await replyToUser(cfg, ctx, lines.join("\n"));
}

/**
 * /jarvis help - 显示帮助信息
 *
 * 根据 taskHistory 长度区分新老用户：
 * - 新用户（< 5 次任务）：显示基础功能和入门引导
 * - 老用户（>= 5 次任务）：显示进阶技巧和高级功能
 */
async function handleHelp(cfg: DingtalkConfig, ctx: DingtalkMessageContext): Promise<void> {
  const persona = JarvisPersona.fromDingtalkConfig(cfg);
  const contextManager = getGlobalContextManager();
  const sessionKey = `${ctx.conversationId}:${ctx.senderId}`;
  const taskHistory = contextManager.getTaskHistory(sessionKey, 20);
  const isNewUser = taskHistory.length < 5;

  const greeting =
    persona.isEnabled() && persona.getTone() === "jarvis"
      ? `${persona.getHonorific()}，以下是可用的快捷指令：`
      : "以下是可用的快捷指令：";

  const lines: string[] = [`🤖 **Jarvis 快捷指令** - ${greeting}`, ""];

  if (isNewUser) {
    // 新用户：基础功能 + 入门引导
    lines.push(
      "### 🚀 快速入门",
      "",
      "直接发送消息即可，Jarvis 会自动识别并处理您的请求。",
      "",
      "### 📋 基础指令",
      "",
      "- `/jarvis status` - 查看当前任务状态",
      "- `/jarvis history` - 查看最近任务历史",
      "- `/jarvis result` - 查看上一个任务的结果",
      "- `/jarvis clear` - 清除会话，重新开始",
      "- `/jarvis help` - 显示此帮助",
      "",
      "### 💡 小贴士",
      "",
      "- 任务执行中可以说「暂停」来暂停排队任务",
      "- 任务完成后可以说「重做」来重新执行",
      "- 可以直接追加新任务，无需等待当前任务完成",
    );
  } else {
    // 老用户：完整指令 + 进阶技巧
    lines.push(
      "### 📋 快捷指令",
      "",
      "- `/jarvis status` - 查看当前任务状态和会话概览",
      "- `/jarvis history [数量]` - 查看最近任务历史（默认10条）",
      "- `/jarvis result` - 查看上一个任务的结果",
      "- `/jarvis redo` - 查看上一个任务，便于重做",
      "- `/jarvis clear` - 清除会话上下文，重新开始",
      "- `/jarvis config` - 查看当前 Jarvis 配置",
      "- `/jarvis help` - 显示此帮助",
      "",
      "### 🎯 自然语言快捷操作",
      "",
      "- 「暂停」「先停一下」 - 暂停排队中的任务",
      "- 「任务状态」「进度如何」 - 查看任务进度",
      "- 「取消所有任务」 - 取消全部排队任务",
      "- 「上次的结果」 - 引用上一个任务的结果",
      "- 「重做」「再做一遍」 - 重新执行上一个任务",
      "",
      "### ⚡ 进阶技巧",
      "",
      "- 任务运行中直接发送新消息，会自动追加为新任务",
      "- 支持时间引用：「昨天的任务」「上午的结果」",
      "- 支持模糊引用：「那个搜索的任务」「之前翻译的」",
      "- 卡片上的按钮可以直接重试失败任务或暂停排队",
    );
  }

  await replyToUser(cfg, ctx, lines.join("\n"));
}
