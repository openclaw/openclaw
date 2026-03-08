/**
 * 钉钉日程命令处理
 *
 * 拦截 /cal 开头的聊天命令，调用日程管理 API 并回复结果。
 *
 * 支持的命令:
 * - /cal create <标题> <开始时间> <结束时间> [参与者userId1,userId2,...]
 * - /cal list [today|week]
 * - /cal info <eventId>
 * - /cal delete <eventId>
 * - /cal help
 */

import {
  createCalendarEvent,
  listCalendarEvents,
  getCalendarEvent,
  deleteCalendarEvent,
} from "./calendar-management.js";
import { getUserInfoByStaffId } from "./contact-management.js";
import { dingtalkLogger } from "./logger.js";
import { sendMessageDingtalk } from "./send.js";
import type { DingtalkConfig, DingtalkMessageContext } from "./types.js";

/** 日程命令前缀 */
const CAL_COMMAND_PREFIX = "/cal";

/**
 * 将 senderId（staffId）解析为 unionId
 *
 * 钉钉日程 API 路径参数需要 unionId，而 Stream SDK 推送的 senderId 是 staffId。
 * 通过通讯录 API 查询转换，失败时回退到原始 senderId。
 */
async function resolveUnionId(cfg: DingtalkConfig, senderId: string): Promise<string> {
  try {
    const userDetail = await getUserInfoByStaffId(cfg, senderId);
    return userDetail.unionid ?? senderId;
  } catch (error) {
    dingtalkLogger.warn(
      `[cal-cmd] failed to resolve unionId for ${senderId}, falling back to senderId: ${String(error)}`,
    );
    return senderId;
  }
}

/**
 * 检查消息是否为日程命令
 */
export function isCalendarCommand(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  return trimmed === CAL_COMMAND_PREFIX || trimmed.startsWith(`${CAL_COMMAND_PREFIX} `);
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
 * 格式化 ISO 时间为可读字符串
 */
function formatDateTime(isoString: string | undefined): string {
  if (!isoString) return "未设置";
  try {
    return new Date(isoString).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
  } catch {
    return isoString;
  }
}

/**
 * 将 Date 对象格式化为带本地时区偏移的 ISO 8601 字符串
 *
 * 输出格式: "2024-01-15T14:00:00+08:00"（保留本地时间，不转 UTC）
 */
function formatLocalIso(date: Date): string {
  const offsetMinutes = date.getTimezoneOffset();
  const absOffset = Math.abs(offsetMinutes);
  const offsetSign = offsetMinutes <= 0 ? "+" : "-";
  const offsetHours = String(Math.floor(absOffset / 60)).padStart(2, "0");
  const offsetMins = String(absOffset % 60).padStart(2, "0");

  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  const seconds = String(date.getSeconds()).padStart(2, "0");

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${offsetSign}${offsetHours}:${offsetMins}`;
}

/**
 * 解析用户输入的时间字符串为带本地时区偏移的 ISO 格式
 *
 * 支持的格式:
 * - "14:00" → 今天 14:00
 * - "2024-01-15 14:00" → 指定日期时间
 * - "tomorrow 14:00" → 明天 14:00
 * - "+2h" → 2小时后
 * - "+30m" → 30分钟后
 */
function parseTimeInput(input: string): string {
  const now = new Date();

  // 相对时间: +2h, +30m
  const relativeMatch = input.match(/^\+(\d+)([hm])$/);
  if (relativeMatch) {
    const amount = parseInt(relativeMatch[1], 10);
    const unit = relativeMatch[2];
    const offsetMs = unit === "h" ? amount * 3_600_000 : amount * 60_000;
    return formatLocalIso(new Date(now.getTime() + offsetMs));
  }

  // 仅时间: "14:00"
  const timeOnlyMatch = input.match(/^(\d{1,2}):(\d{2})$/);
  if (timeOnlyMatch) {
    const hours = parseInt(timeOnlyMatch[1], 10);
    const minutes = parseInt(timeOnlyMatch[2], 10);
    const result = new Date(now);
    result.setHours(hours, minutes, 0, 0);
    // 如果时间已过，设为明天
    if (result.getTime() < now.getTime()) {
      result.setDate(result.getDate() + 1);
    }
    return formatLocalIso(result);
  }

  // "tomorrow 14:00"
  const tomorrowMatch = input.match(/^tomorrow\s+(\d{1,2}):(\d{2})$/i);
  if (tomorrowMatch) {
    const hours = parseInt(tomorrowMatch[1], 10);
    const minutes = parseInt(tomorrowMatch[2], 10);
    const result = new Date(now);
    result.setDate(result.getDate() + 1);
    result.setHours(hours, minutes, 0, 0);
    return formatLocalIso(result);
  }

  // 完整日期时间: "2024-01-15 14:00"
  const fullMatch = input.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{1,2}):(\d{2})$/);
  if (fullMatch) {
    const dateStr = fullMatch[1];
    const hours = parseInt(fullMatch[2], 10);
    const minutes = parseInt(fullMatch[3], 10);
    const result = new Date(
      `${dateStr}T${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:00`,
    );
    return formatLocalIso(result);
  }

  // 尝试直接解析
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return formatLocalIso(parsed);
  }

  throw new Error(
    `无法解析时间格式: "${input}"。支持: 14:00, tomorrow 14:00, 2024-01-15 14:00, +2h, +30m`,
  );
}

/**
 * 处理日程命令
 *
 * @param cfg 钉钉配置
 * @param ctx 消息上下文
 * @returns true 表示命令已处理，false 表示不是日程命令
 */
export async function handleCalendarCommand(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
): Promise<boolean> {
  if (!isCalendarCommand(ctx.content)) {
    return false;
  }

  const parts = ctx.content.trim().split(/\s+/);
  const subCommand = parts[1]?.toLowerCase() ?? "help";

  dingtalkLogger.info(`[cal-cmd] ${ctx.senderId} invoked: ${subCommand}`);

  try {
    switch (subCommand) {
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
    dingtalkLogger.error(`[cal-cmd] ${subCommand} failed: ${errorMessage}`);
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
  if (args.length < 3) {
    await replyToUser(
      cfg,
      ctx,
      [
        "⚠️ 用法: `/cal create <标题> <开始时间> <结束时间> [参与者]`",
        "",
        "时间格式示例:",
        "- `14:00` - 今天 14:00",
        "- `tomorrow 14:00` - 明天 14:00",
        "- `2024-01-15 14:00` - 指定日期",
        "- `+2h` - 2小时后",
        "- `+30m` - 30分钟后",
        "",
        "示例: `/cal create 项目周会 14:00 15:00 user1,user2`",
      ].join("\n"),
    );
    return;
  }

  const summary = args[0];

  // 解析开始和结束时间（可能包含空格，如 "tomorrow 14:00"）
  let startTimeInput: string;
  let endTimeInput: string;
  let attendeeArg: string | undefined;

  // 检测 "tomorrow" 关键词来正确分割参数
  if (args[1].toLowerCase() === "tomorrow") {
    startTimeInput = `${args[1]} ${args[2]}`;
    if (args[3]?.toLowerCase() === "tomorrow") {
      endTimeInput = `${args[3]} ${args[4]}`;
      attendeeArg = args[5];
    } else {
      endTimeInput = args[3] ?? "";
      attendeeArg = args[4];
    }
  } else {
    startTimeInput = args[1];
    endTimeInput = args[2];
    attendeeArg = args[3];
  }

  const startDateTime = parseTimeInput(startTimeInput);
  const endDateTime = parseTimeInput(endTimeInput);

  const attendees = attendeeArg
    ? attendeeArg
        .split(",")
        .map((id) => ({ id: id.trim() }))
        .filter((a) => a.id.length > 0)
    : undefined;

  const userId = await resolveUnionId(cfg, ctx.senderId);
  const event = await createCalendarEvent(cfg, userId, {
    summary,
    start: { dateTime: startDateTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    end: { dateTime: endDateTime, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
    attendees,
    reminders: [{ method: "dingtalk", minutes: 15 }],
  });

  const lines = [
    "📅 日程创建成功",
    `- **标题**: ${summary}`,
    `- **开始**: ${formatDateTime(startDateTime)}`,
    `- **结束**: ${formatDateTime(endDateTime)}`,
    `- **日程ID**: ${event.id}`,
  ];
  if (attendees?.length) {
    lines.push(`- **参与者**: ${attendees.map((a) => a.id).join(", ")}`);
  }

  await replyToUser(cfg, ctx, lines.join("\n"));
}

async function handleList(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  const rangeArg = args[0]?.toLowerCase();
  const now = new Date();

  let timeMin: string;
  let timeMax: string;
  let rangeLabel: string;

  if (rangeArg === "week") {
    // 本周
    const startOfWeek = new Date(now);
    startOfWeek.setDate(now.getDate() - now.getDay() + 1);
    startOfWeek.setHours(0, 0, 0, 0);
    const endOfWeek = new Date(startOfWeek);
    endOfWeek.setDate(startOfWeek.getDate() + 7);
    timeMin = startOfWeek.toISOString();
    timeMax = endOfWeek.toISOString();
    rangeLabel = "本周";
  } else {
    // 默认今天
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);
    timeMin = startOfDay.toISOString();
    timeMax = endOfDay.toISOString();
    rangeLabel = "今天";
  }

  const userId = await resolveUnionId(cfg, ctx.senderId);
  const result = await listCalendarEvents(cfg, userId, {
    timeMin,
    timeMax,
    maxResults: 20,
  });

  if (!result.events?.length) {
    await replyToUser(cfg, ctx, `📅 ${rangeLabel}暂无日程`);
    return;
  }

  const lines = [`📅 **${rangeLabel}的日程** (共 ${result.events.length} 项)`];

  for (const event of result.events) {
    const startTime = event.start?.dateTime ? formatDateTime(event.start.dateTime) : "全天";
    const endTime = event.end?.dateTime ? formatDateTime(event.end.dateTime) : "";
    const timeRange = endTime ? `${startTime} - ${endTime}` : startTime;
    lines.push(`- 📌 **${event.summary ?? "无标题"}** | ${timeRange} (ID: ${event.id})`);
  }

  await replyToUser(cfg, ctx, lines.join("\n"));
}

async function handleInfo(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  if (args.length < 1) {
    await replyToUser(cfg, ctx, "⚠️ 用法: `/cal info <eventId>`");
    return;
  }

  const eventId = args[0];
  const userId = await resolveUnionId(cfg, ctx.senderId);
  const event = await getCalendarEvent(cfg, userId, eventId);

  const lines = [
    "📅 **日程详情**",
    `- **标题**: ${event.summary ?? "无标题"}`,
    `- **开始**: ${formatDateTime(event.start?.dateTime)}`,
    `- **结束**: ${formatDateTime(event.end?.dateTime)}`,
  ];
  if (event.description) lines.push(`- **描述**: ${event.description}`);
  if (event.location?.displayName) lines.push(`- **地点**: ${event.location.displayName}`);
  if (event.attendees?.length) {
    const attendeeList = event.attendees.map((a) => a.displayName ?? a.id).join(", ");
    lines.push(`- **参与者**: ${attendeeList}`);
  }
  lines.push(`- **日程ID**: ${eventId}`);

  await replyToUser(cfg, ctx, lines.join("\n"));
}

async function handleDelete(
  cfg: DingtalkConfig,
  ctx: DingtalkMessageContext,
  args: string[],
): Promise<void> {
  if (args.length < 1) {
    await replyToUser(cfg, ctx, "⚠️ 用法: `/cal delete <eventId>`");
    return;
  }

  const eventId = args[0];
  const userId = await resolveUnionId(cfg, ctx.senderId);
  await deleteCalendarEvent(cfg, userId, eventId);
  await replyToUser(cfg, ctx, `🗑️ 日程已删除 (ID: ${eventId})`);
}

async function handleHelp(cfg: DingtalkConfig, ctx: DingtalkMessageContext): Promise<void> {
  await replyToUser(
    cfg,
    ctx,
    [
      "📅 **日程命令帮助**",
      "",
      "- `/cal create <标题> <开始时间> <结束时间> [参与者]` - 创建日程",
      "  - 时间格式: `14:00`, `tomorrow 14:00`, `2024-01-15 14:00`, `+2h`, `+30m`",
      "  - 参与者: 逗号分隔的 userId 列表",
      "- `/cal list [today|week]` - 查看日程列表（默认今天）",
      "- `/cal info <eventId>` - 查看日程详情",
      "- `/cal delete <eventId>` - 删除日程",
      "- `/cal help` - 显示此帮助",
    ].join("\n"),
  );
}
