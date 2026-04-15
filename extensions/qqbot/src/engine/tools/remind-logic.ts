/**
 * QQBot 提醒工具核心逻辑。
 *
 * Pure functions for time parsing, cron detection, job building,
 * and remind execution. The framework registration shell
 * (old tools/remind.ts) delegates all business logic here.
 */

/** 提醒工具的输入参数。 */
export interface RemindParams {
  action: "add" | "list" | "remove";
  content?: string;
  to?: string;
  time?: string;
  timezone?: string;
  name?: string;
  jobId?: string;
}

/** AI Tool 参数的 JSON Schema 定义（供框架注册使用）。 */
export const RemindSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description:
        "Action type. add=create a reminder, list=show reminders, remove=delete a reminder.",
      enum: ["add", "list", "remove"],
    },
    content: {
      type: "string",
      description:
        'Reminder content, for example "drink water" or "join the meeting". Required when action=add.',
    },
    to: {
      type: "string",
      description:
        "Delivery target from the `[QQBot] to=` context value. " +
        "Direct-message format: qqbot:c2c:user_openid. Group format: qqbot:group:group_openid. Required when action=add.",
    },
    time: {
      type: "string",
      description:
        "Time description. Supported formats:\n" +
        '1. Relative time, for example "5m", "1h", "1h30m", or "2d"\n' +
        '2. Cron expression, for example "0 8 * * *" or "0 9 * * 1-5"\n' +
        "Values containing spaces are treated as cron expressions; everything else is treated as a one-shot relative delay.\n" +
        "Required when action=add.",
    },
    timezone: {
      type: "string",
      description: 'Timezone used for cron reminders. Defaults to "Asia/Shanghai".',
    },
    name: {
      type: "string",
      description: "Optional reminder job name. Defaults to the first 20 characters of content.",
    },
    jobId: {
      type: "string",
      description: "Job ID to remove. Required when action=remove; fetch it with list first.",
    },
  },
  required: ["action"],
} as const;

/**
 * 解析相对时间字符串为毫秒数。
 *
 * Supports: "5m", "1h", "1h30m", "2d", "45s", plain number (as minutes).
 *
 * @returns Milliseconds or null if unparseable.
 */
export function parseRelativeTime(timeStr: string): number | null {
  const s = timeStr.toLowerCase();
  if (/^\d+$/.test(s)) {
    return parseInt(s, 10) * 60_000;
  }

  let totalMs = 0;
  let matched = false;
  const regex = /(\d+(?:\.\d+)?)\s*(d|h|m|s)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(s)) !== null) {
    matched = true;
    const value = parseFloat(match[1]);
    const unit = match[2];
    switch (unit) {
      case "d":
        totalMs += value * 86_400_000;
        break;
      case "h":
        totalMs += value * 3_600_000;
        break;
      case "m":
        totalMs += value * 60_000;
        break;
      case "s":
        totalMs += value * 1_000;
        break;
    }
  }
  return matched ? Math.round(totalMs) : null;
}

/** 判断时间字符串是否为 cron 表达式（3~6 个空格分隔的字段）。 */
export function isCronExpression(timeStr: string): boolean {
  const parts = timeStr.trim().split(/\s+/);
  if (parts.length < 3 || parts.length > 6) {
    return false;
  }
  return parts.every((p) => /^[0-9*?/,LW#-]/.test(p));
}

/** 根据提醒内容生成 cron job 名称（截取前 20 字符）。 */
export function generateJobName(content: string): string {
  const trimmed = content.trim();
  const short = trimmed.length > 20 ? `${trimmed.slice(0, 20)}…` : trimmed;
  return `Reminder: ${short}`;
}

/** 构建发送给 AI 的提醒 system prompt。 */
export function buildReminderPrompt(content: string): string {
  return (
    `You are a warm reminder assistant. Please remind the user about: ${content}. ` +
    `Requirements: (1) do not reply with HEARTBEAT_OK (2) do not explain who you are ` +
    `(3) output a direct and caring reminder message (4) you may add a short encouraging line ` +
    `(5) keep it within 2-3 sentences (6) use a small amount of emoji.`
  );
}

/** 构建一次性定时提醒的 cron job 参数。 */
export function buildOnceJob(params: RemindParams, delayMs: number) {
  const atMs = Date.now() + delayMs;
  const to = params.to!;
  const content = params.content!;
  const name = params.name || generateJobName(content);
  return {
    action: "add",
    job: {
      name,
      schedule: { kind: "at", atMs },
      sessionTarget: "isolated",
      wakeMode: "now",
      deleteAfterRun: true,
      payload: {
        kind: "agentTurn",
        message: buildReminderPrompt(content),
        deliver: true,
        channel: "qqbot",
        to,
      },
    },
  };
}

/** 构建周期性 cron 提醒的 job 参数。 */
export function buildCronJob(params: RemindParams) {
  const to = params.to!;
  const content = params.content!;
  const name = params.name || generateJobName(content);
  const tz = params.timezone || "Asia/Shanghai";
  return {
    action: "add",
    job: {
      name,
      schedule: { kind: "cron", expr: params.time!.trim(), tz },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: {
        kind: "agentTurn",
        message: buildReminderPrompt(content),
        deliver: true,
        channel: "qqbot",
        to,
      },
    },
  };
}

/** 将延迟毫秒数格式化为简短字符串（如 "5m"、"1h30m"）。 */
export function formatDelay(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h${minutes}m`;
}

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/**
 * 执行提醒工具逻辑。
 *
 * Validates params, parses time, and returns a structured result
 * containing cron job params that the framework shell passes back
 * as the tool output.
 */
export function executeRemind(params: RemindParams) {
  if (params.action === "list") {
    return json({
      _instruction: "Use the cron tool immediately with the following parameters.",
      cronParams: { action: "list" },
    });
  }

  if (params.action === "remove") {
    if (!params.jobId) {
      return json({
        error: "jobId is required when action=remove. Use action=list first.",
      });
    }
    return json({
      _instruction: "Use the cron tool immediately with the following parameters.",
      cronParams: { action: "remove", jobId: params.jobId },
    });
  }

  if (!params.content) {
    return json({ error: "content is required when action=add" });
  }
  if (!params.to) {
    return json({ error: "to is required when action=add" });
  }
  if (!params.time) {
    return json({ error: "time is required when action=add" });
  }

  if (isCronExpression(params.time)) {
    return json({
      _instruction:
        "Use the cron tool immediately with the following parameters, then tell the user the reminder has been scheduled.",
      cronParams: buildCronJob(params),
      summary: `⏰ Recurring reminder: "${params.content}" (${params.time}, tz=${params.timezone || "Asia/Shanghai"})`,
    });
  }

  const delayMs = parseRelativeTime(params.time);
  if (delayMs == null) {
    return json({
      error: `Could not parse time format: ${params.time}. Use values like 5m, 1h, 1h30m, or a cron expression.`,
    });
  }
  if (delayMs < 30_000) {
    return json({ error: "Reminder delay must be at least 30 seconds" });
  }

  return json({
    _instruction:
      "Use the cron tool immediately with the following parameters, then tell the user the reminder has been scheduled.",
    cronParams: buildOnceJob(params, delayMs),
    summary: `⏰ Reminder in ${formatDelay(delayMs)}: "${params.content}"`,
  });
}
