/**
 * 钉钉日历事件卡片渲染
 *
 * 将日历 API 返回的数据渲染为结构化 Markdown，
 * 让 AI 回复时以富文本卡片形式展示日程信息，
 * 并附带钉钉深链接方便用户快速跳转操作。
 *
 * 这是酷应用的核心价值体现：不只是返回 JSON 数据，
 * 而是提供可直接展示给用户的结构化内容。
 */

import type { CalendarEvent, ListCalendarEventsResult } from "./types.js";

// ============================================================================
// 时间格式化工具
// ============================================================================

/** 将 ISO 8601 或钉钉时间格式化为人类可读的中文时间 */
function formatDateTime(dateTime?: { dateTime?: string; date?: string }): string {
  if (!dateTime) return "未知时间";

  const raw = dateTime.dateTime ?? dateTime.date;
  if (!raw) return "未知时间";

  try {
    const date = new Date(raw);
    if (isNaN(date.getTime())) return raw;

    const year = date.getFullYear();
    const month = date.getMonth() + 1;
    const day = date.getDate();
    const hours = date.getHours();
    const minutes = date.getMinutes();

    const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
    const weekday = weekdays[date.getDay()];

    // 全天日程只显示日期
    if (dateTime.date && !dateTime.dateTime) {
      return `${year}年${month}月${day}日 ${weekday}`;
    }

    const timeStr = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
    return `${year}年${month}月${day}日 ${weekday} ${timeStr}`;
  } catch {
    return raw;
  }
}

/** 计算日程时长的人类可读描述 */
function formatDuration(
  start?: { dateTime?: string; date?: string },
  end?: { dateTime?: string; date?: string },
): string {
  if (!start || !end) return "";

  const startRaw = start.dateTime ?? start.date;
  const endRaw = end.dateTime ?? end.date;
  if (!startRaw || !endRaw) return "";

  try {
    const startDate = new Date(startRaw);
    const endDate = new Date(endRaw);
    const diffMs = endDate.getTime() - startDate.getTime();

    if (diffMs <= 0) return "";

    const diffMinutes = Math.round(diffMs / 60_000);
    if (diffMinutes < 60) return `${diffMinutes}分钟`;

    const hours = Math.floor(diffMinutes / 60);
    const remainingMinutes = diffMinutes % 60;
    if (remainingMinutes === 0) return `${hours}小时`;
    return `${hours}小时${remainingMinutes}分钟`;
  } catch {
    return "";
  }
}

/** 获取日程状态的 emoji 标识 */
function statusEmoji(status?: string): string {
  switch (status?.toLowerCase()) {
    case "confirmed":
      return "✅";
    case "tentative":
      return "❓";
    case "cancelled":
      return "❌";
    default:
      return "📅";
  }
}

// ============================================================================
// 单个日程卡片渲染
// ============================================================================

/**
 * 渲染单个日程事件为结构化 Markdown 卡片
 *
 * 输出示例:
 * ```
 * 📅 **项目评审会**
 * ⏰ 2024年12月31日 周二 14:00 → 15:00（1小时）
 * 📍 3号会议室
 * 👥 参与者: 张三、李四、王五
 * 📝 讨论Q1产品规划
 * 🔗 [在钉钉中查看](dingtalk://dingtalkclient/page/calendar)
 * ```
 */
export function renderEventCard(event: CalendarEvent): string {
  const lines: string[] = [];

  // 标题行
  const emoji = statusEmoji(event.status);
  const title = event.summary ?? "无标题日程";
  lines.push(`${emoji} **${title}**`);

  // 时间行
  const startStr = formatDateTime(event.start);
  const endTimeOnly = event.end?.dateTime
    ? new Date(event.end.dateTime).toLocaleTimeString("zh-CN", {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "";
  const duration = formatDuration(event.start, event.end);
  const durationSuffix = duration ? `（${duration}）` : "";

  if (event.isAllDay) {
    lines.push(`⏰ ${startStr}（全天）`);
  } else if (endTimeOnly) {
    lines.push(`⏰ ${startStr} → ${endTimeOnly}${durationSuffix}`);
  } else {
    lines.push(`⏰ ${startStr}${durationSuffix}`);
  }

  // 地点行
  const locationName = event.location?.displayName;
  if (locationName) {
    lines.push(`📍 ${locationName}`);
  }

  // 参与者行
  if (event.attendees?.length) {
    const attendeeNames = event.attendees
      .map((attendee) => {
        const name = attendee.displayName ?? attendee.id ?? "unknown";
        const statusIcon =
          attendee.responseStatus === "accepted"
            ? "✓"
            : attendee.responseStatus === "declined"
              ? "✗"
              : "";
        return statusIcon ? `${name}${statusIcon}` : name;
      })
      .join("、");
    lines.push(`👥 参与者: ${attendeeNames}`);
  }

  // 组织者行
  if (event.organizer?.displayName) {
    lines.push(`👤 组织者: ${event.organizer.displayName}`);
  }

  // 描述行（截断过长内容）
  if (event.description) {
    const maxDescriptionLength = 100;
    const truncatedDescription =
      event.description.length > maxDescriptionLength
        ? `${event.description.slice(0, maxDescriptionLength)}...`
        : event.description;
    lines.push(`📝 ${truncatedDescription}`);
  }

  // 钉钉深链接
  lines.push(`🔗 [在钉钉日历中查看](dingtalk://dingtalkclient/page/calendar)`);

  return lines.join("\n");
}

// ============================================================================
// 日程列表卡片渲染
// ============================================================================

/**
 * 渲染日程列表为结构化 Markdown
 *
 * 将多个日程按时间分组展示，提供清晰的日程概览。
 */
export function renderEventListCard(result: ListCalendarEventsResult): string {
  const events = result.events;
  if (!events?.length) {
    return "📅 **暂无日程**\n\n当前没有查询到日程事件。\n\n🔗 [打开钉钉日历](dingtalk://dingtalkclient/page/calendar)";
  }

  const lines: string[] = [];
  lines.push(`📅 **日程列表**（共 ${events.length} 个）`);
  lines.push("---");

  for (const event of events) {
    lines.push(renderEventCard(event));
    lines.push("---");
  }

  // 分页提示
  if (result.nextToken) {
    lines.push("📄 *还有更多日程，可以继续查询*");
  }

  return lines.join("\n");
}

// ============================================================================
// 日程操作结果卡片
// ============================================================================

/** 渲染日程创建成功的卡片 */
export function renderEventCreatedCard(event: CalendarEvent): string {
  const lines: string[] = [];
  lines.push("✅ **日程创建成功**");
  lines.push("");
  lines.push(renderEventCard(event));
  return lines.join("\n");
}

/** 渲染日程更新成功的卡片 */
export function renderEventUpdatedCard(event: CalendarEvent): string {
  const lines: string[] = [];
  lines.push("✅ **日程已更新**");
  lines.push("");
  lines.push(renderEventCard(event));
  return lines.join("\n");
}

/** 渲染日程删除成功的卡片 */
export function renderEventDeletedCard(): string {
  return "✅ **日程已删除**\n\n🔗 [打开钉钉日历](dingtalk://dingtalkclient/page/calendar)";
}
