/**
 * Jarvis 任务面板卡片模板
 *
 * 定义钉钉互动卡片的 JSON 模板结构和按钮配置。
 * 使用钉钉卡片 API 的 cardParamMap 动态数据绑定，
 * 结合 callbackType: "STREAM" 实现按钮回调。
 *
 * 卡片布局（多任务模式）:
 * ┌─────────────────────────────────────┐
 * │  🤖 标题区 + 进度比例    [状态徽章]  │
 * ├─────────────────────────────────────┤
 * │  📊 统计摘要行（带视觉分隔）         │
 * ├─────────────────────────────────────┤
 * │  任务列表（运行中展开，完成折叠）     │
 * ├─────────────────────────────────────┤
 * │  ⏱️ 总耗时 + 效率指标               │
 * ├─────────────────────────────────────┤
 * │  💡 底部提示 / 操作按钮              │
 * └─────────────────────────────────────┘
 *
 * 卡片布局（单任务模式）:
 * ┌─────────────────────────────────────┐
 * │  流式内容（无任务列表头部）           │
 * └─────────────────────────────────────┘
 */

import type { TaskStatus } from "./async-task-queue.js";
import type { CardButton } from "./card.js";

/**
 * 按钮动作 ID 常量
 */
export const JarvisActionId = {
  CANCEL_TASK: "jarvis_cancel_task",
  CANCEL_ALL: "jarvis_cancel_all",
  RETRY_TASK: "jarvis_retry_task",
  VIEW_DETAIL: "jarvis_view_detail",
  CONTINUE_CHAT: "jarvis_continue_chat",
} as const;

export type JarvisActionIdType = (typeof JarvisActionId)[keyof typeof JarvisActionId];

/**
 * 按钮回调参数
 */
export interface JarvisActionParams {
  /** 动作 ID */
  actionId: JarvisActionIdType;
  /** 卡片实例 ID (outTrackId) */
  cardInstanceId: string;
  /** 目标任务 ID（取消/重试/查看详情时使用） */
  taskId?: string;
  /** 触发用户 ID */
  userId?: string;
}

/**
 * 任务行渲染数据
 */
export interface TaskLineData {
  /** 任务 ID */
  taskId: string;
  /** 任务描述 */
  description: string;
  /** 任务状态 */
  status: TaskStatus;
  /** 进度百分比 (0-100)，仅 running 状态有效 */
  progress: number;
  /** 耗时（秒），仅 completed/failed 状态有效 */
  elapsedSeconds?: number;
  /** 结果摘要（completed 状态） */
  resultSummary?: string;
  /** 错误信息（failed 状态） */
  errorMessage?: string;
}

/**
 * 卡片整体渲染数据
 */
export interface JarvisCardData {
  /** 卡片标题 */
  title: string;
  /** 任务列表 */
  tasks: TaskLineData[];
  /** 是否已完成（所有任务都结束） */
  isFinished: boolean;
  /** 底部提示文本 */
  footerText?: string;
  /** 卡片创建时间戳（用于计算总耗时） */
  startedAt?: number;
}

/**
 * 状态图标映射
 */
const STATUS_ICONS: Record<TaskStatus, string> = {
  pending: "⏳",
  running: "🔄",
  completed: "✅",
  failed: "⚠️",
  cancelled: "🚫",
};

/**
 * 状态文本映射
 */
const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "排队中",
  running: "进行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/**
 * 渲染运行中任务的动态时间指示
 * 使用当前时间戳模拟动态效果（每次刷新卡片时更新）
 */
function renderRunningIndicator(elapsedSeconds?: number): string {
  const dots = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  const dotIndex = Math.floor(Date.now() / 200) % dots.length;
  const elapsed = elapsedSeconds != null ? ` ${formatElapsedTime(elapsedSeconds)}` : "";
  return `${dots[dotIndex]}${elapsed}`;
}

/**
 * 格式化耗时为人类可读格式
 */
function formatElapsedTime(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainingSeconds.toFixed(0)}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes}m`;
}

/**
 * 渲染单行任务的 Markdown
 *
 * 运行中任务：展开显示进度条和动态指示
 * 完成任务：折叠结果摘要，仅显示耗时
 * 失败任务：显示错误摘要
 * 排队/取消：简洁显示
 */
function renderTaskLine(task: TaskLineData, index: number): string {
  const icon = STATUS_ICONS[task.status];
  const indexLabel = `**#${index + 1}**`;

  switch (task.status) {
    case "running": {
      const progressBar = renderProgressBar(task.progress);
      const indicator = renderRunningIndicator(task.elapsedSeconds);
      return `${icon} ${indexLabel} ${task.description}\n   ${progressBar} ${indicator}`;
    }
    case "completed": {
      const elapsed =
        task.elapsedSeconds != null ? ` (${formatElapsedTime(task.elapsedSeconds)})` : "";
      const resultLine = task.resultSummary ? `\n   └ ${truncateText(task.resultSummary, 60)}` : "";
      return `${icon} ${indexLabel} ~~${task.description}~~${elapsed}${resultLine}`;
    }
    case "failed": {
      const errorLine = task.errorMessage ? `\n   └ ⚠️ ${truncateText(task.errorMessage, 50)}` : "";
      return `${icon} ${indexLabel} ${task.description}${errorLine}`;
    }
    case "pending": {
      return `${icon} ${indexLabel} ${task.description}`;
    }
    case "cancelled": {
      return `${icon} ${indexLabel} ~~${task.description}~~`;
    }
    default:
      return `${icon} ${indexLabel} ${task.description}`;
  }
}

/**
 * 渲染进度条
 */
function renderProgressBar(progress: number): string {
  const clampedProgress = Math.max(0, Math.min(100, progress));
  const filled = Math.round(clampedProgress / 10);
  const empty = 10 - filled;
  return `[${"▓".repeat(filled)}${"░".repeat(empty)}] ${clampedProgress}%`;
}

/**
 * 截断文本
 */
function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...`;
}

/**
 * 计算任务统计
 */
function calculateTaskStats(tasks: TaskLineData[]): {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  cancelled: number;
} {
  const stats = {
    total: tasks.length,
    pending: 0,
    running: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const task of tasks) {
    stats[task.status]++;
  }
  return stats;
}

/**
 * 渲染统计摘要行
 */
function renderStatsLine(stats: ReturnType<typeof calculateTaskStats>): string {
  const parts: string[] = [];
  if (stats.running > 0) parts.push(`🔄 ${stats.running}个进行中`);
  if (stats.pending > 0) parts.push(`⏳ ${stats.pending}个排队`);
  if (stats.completed > 0) parts.push(`✅ ${stats.completed}个完成`);
  if (stats.failed > 0) parts.push(`⚠️ ${stats.failed}个失败`);
  if (stats.cancelled > 0) parts.push(`🚫 ${stats.cancelled}个取消`);
  return parts.length > 0 ? parts.join(" | ") : "📋 准备就绪";
}

/**
 * 渲染总耗时和效率指标
 */
function renderTimingFooter(
  data: JarvisCardData,
  stats: ReturnType<typeof calculateTaskStats>,
): string {
  const parts: string[] = [];

  // 总耗时
  if (data.startedAt) {
    const totalSeconds = (Date.now() - data.startedAt) / 1000;
    parts.push(`⏱️ 总耗时 ${formatElapsedTime(totalSeconds)}`);
  }

  // 效率指标：平均每个任务耗时
  if (data.isFinished && stats.completed > 0) {
    const completedTasks = data.tasks.filter(
      (task) => task.status === "completed" && task.elapsedSeconds != null,
    );
    if (completedTasks.length > 0) {
      const totalTaskTime = completedTasks.reduce(
        (sum, task) => sum + (task.elapsedSeconds ?? 0),
        0,
      );
      const avgTime = totalTaskTime / completedTasks.length;
      parts.push(`平均 ${formatElapsedTime(avgTime)}/任务`);
    }
  }

  return parts.length > 0 ? parts.join(" · ") : "";
}

/**
 * 生成 Jarvis 卡片的 Markdown 内容
 *
 * 这是卡片的核心渲染函数，将任务数据转换为结构化的 Markdown。
 * 用于 AI Card 的 msgContent 字段。
 */
export function renderJarvisCardMarkdown(data: JarvisCardData): string {
  return renderMultiTaskCard(data);
}

/**
 * 渲染多任务模式卡片
 *
 * 完整的任务面板布局：标题 → 统计 → 任务列表 → 耗时指标 → 底部提示
 */
function renderMultiTaskCard(data: JarvisCardData): string {
  const lines: string[] = [];
  const stats = calculateTaskStats(data.tasks);

  // 标题 + 进度比例 + 状态徽章
  const processedCount = stats.completed + stats.failed + stats.cancelled;
  const completionRatio = `${processedCount}/${stats.total}`;
  const statusBadge = data.isFinished
    ? stats.failed > 0
      ? "⚠️ 部分失败"
      : "✅ 全部完成"
    : stats.running > 0
      ? "🔄 执行中"
      : "⏳ 排队中";
  lines.push(`### ${data.title}  ${completionRatio}  ${statusBadge}`);
  lines.push("");

  // 统计摘要行
  lines.push(renderStatsLine(stats));
  lines.push("");
  lines.push("---");
  lines.push("");

  // 任务列表（按状态优先级排序：running > pending > completed > failed > cancelled）
  const sortedTasks = sortTasksByPriority(data.tasks);
  for (const task of sortedTasks) {
    const originalIndex = data.tasks.indexOf(task);
    lines.push(renderTaskLine(task, originalIndex));
  }

  // 耗时统计（仅在有任务完成或卡片结束时显示）
  if (data.startedAt && (stats.completed > 0 || data.isFinished)) {
    const timingLine = renderTimingFooter(data, stats);
    if (timingLine) {
      lines.push("");
      lines.push("---");
      lines.push(timingLine);
    }
  }

  // 底部提示
  if (data.footerText) {
    lines.push("");
    if (!data.startedAt || stats.completed === 0) {
      lines.push("---");
    }
    lines.push(data.footerText);
  } else if (!data.isFinished) {
    lines.push("");
    if (!data.startedAt || stats.completed === 0) {
      lines.push("---");
    }
    if (stats.running > 0) {
      lines.push("💡 任务执行中，进度将实时更新");
    } else if (stats.pending > 0) {
      lines.push("⏳ 任务正在排队中，请稍候...");
    }
  } else {
    // 完成态底部建议区
    lines.push("");
    lines.push("---");
    if (stats.failed > 0 && stats.completed > 0) {
      lines.push("💡 部分任务未成功，可点击「重试失败」重新执行");
    } else if (stats.failed > 0) {
      lines.push("💡 可点击「重试失败」重新尝试，或发送新消息继续");
    } else {
      lines.push("💡 发送新消息继续对话，或点击「继续对话」开始新话题");
    }
  }

  return lines.join("\n");
}

/**
 * 按优先级排序任务（不修改原数组）
 */
function sortTasksByPriority(tasks: TaskLineData[]): TaskLineData[] {
  const priority: Record<TaskStatus, number> = {
    running: 1,
    pending: 2,
    completed: 3,
    failed: 4,
    cancelled: 5,
  };
  return [...tasks].sort((taskA, taskB) => priority[taskA.status] - priority[taskB.status]);
}

/**
 * 生成按钮动作的 JSON 参数字符串
 *
 * 用于钉钉卡片按钮的 actionUrl 参数编码。
 * 按钮点击后，钉钉会通过 Stream 回调将此参数传回。
 */
export function encodeActionParams(params: JarvisActionParams): string {
  return JSON.stringify(params);
}

/**
 * 解析按钮回调参数
 */
export function decodeActionParams(encoded: string): JarvisActionParams | null {
  try {
    const parsed = JSON.parse(encoded) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (typeof record.actionId !== "string" || typeof record.cardInstanceId !== "string")
      return null;
    return record as unknown as JarvisActionParams;
  } catch {
    return null;
  }
}

/**
 * 生成卡片按钮列表的 Markdown
 *
 * 根据当前任务状态动态生成可用的操作按钮。
 * 钉钉 AI Card 不直接支持按钮，但互动卡片支持。
 * 这里生成的是文本形式的操作提示，实际按钮通过卡片模板实现。
 */
export function renderActionButtons(
  cardInstanceId: string,
  tasks: TaskLineData[],
  isFinished: boolean,
): string[] {
  const buttons: string[] = [];
  const stats = calculateTaskStats(tasks);

  if (!isFinished) {
    // 有活跃任务时显示取消按钮
    if (stats.running + stats.pending > 0) {
      buttons.push("取消全部");
    }
  } else {
    // 有失败任务时显示重试按钮
    if (stats.failed > 0) {
      buttons.push("重试失败");
    }
    // 所有任务完成后显示继续对话
    buttons.push("继续对话");
  }

  return buttons;
}

/**
 * 生成互动卡片的 cardData.cardParamMap
 *
 * 这是传给钉钉 API 的卡片参数映射。
 * 使用 AI Card 的 msgContent 字段承载 Markdown 内容，
 * 同时通过 flowStatus 控制卡片状态。
 */
export function buildCardParamMap(
  data: JarvisCardData,
  flowStatus: string,
): Record<string, string> {
  const markdown = renderJarvisCardMarkdown(data);

  return {
    flowStatus,
    msgContent: markdown,
    staticMsgContent: "",
    sys_full_json_obj: JSON.stringify({ order: ["msgContent"] }),
  };
}

/**
 * 构建卡片完成态的互动按钮列表
 *
 * 根据任务执行结果动态生成按钮：
 * - 全部成功 → "继续对话"（primary）
 * - 有失败任务 → "重试失败"（primary）+ "继续对话"（default）
 */
export function buildFinishButtons(cardInstanceId: string, tasks: TaskLineData[]): CardButton[] {
  const stats = calculateTaskStats(tasks);
  const buttons: CardButton[] = [];

  if (stats.failed > 0) {
    buttons.push({
      text: "重试失败",
      color: "primary",
      actionParams: {
        actionId: JarvisActionId.RETRY_TASK,
        cardInstanceId,
        scope: "failed",
      },
    });
  }

  buttons.push({
    text: "继续对话",
    color: stats.failed > 0 ? "default" : "primary",
    actionParams: {
      actionId: JarvisActionId.CONTINUE_CHAT,
      cardInstanceId,
    },
  });

  return buttons;
}

/**
 * 构建卡片运行态的互动按钮列表
 *
 * 根据当前任务状态动态生成按钮：
 * - 多任务排队时 → "暂停排队"（default）+ "取消全部"（danger）
 * - 仅运行中 → "取消全部"（danger）
 */
export function buildRunningButtons(cardInstanceId: string, tasks: TaskLineData[]): CardButton[] {
  const stats = calculateTaskStats(tasks);
  const buttons: CardButton[] = [];

  if (stats.pending > 0) {
    buttons.push({
      text: "暂停排队",
      color: "default",
      actionParams: {
        actionId: JarvisActionId.CANCEL_ALL,
        cardInstanceId,
        scope: "pending",
      },
    });
  }

  if (stats.running + stats.pending > 0) {
    buttons.push({
      text: "取消全部",
      color: "danger",
      actionParams: {
        actionId: JarvisActionId.CANCEL_ALL,
        cardInstanceId,
        scope: "all",
      },
    });
  }

  return buttons;
}

export { STATUS_ICONS, STATUS_LABELS, calculateTaskStats };
