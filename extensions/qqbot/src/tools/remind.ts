import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";

// ========== 类型定义 ==========

interface RemindParams {
  action: "add" | "list" | "remove";
  /** 提醒内容（action=add 时必填） */
  content?: string;
  /** 目标地址，格式为上下文中的 to= 值（action=add 时必填） */
  to?: string;
  /**
   * 时间描述（action=add 时必填）
   * - 一次性：相对时间如 "5m"、"1h30m"、"2h"，或绝对毫秒时间戳
   * - 周期性：cron 表达式如 "0 8 * * *"
   */
  time?: string;
  /** 时区（周期提醒时使用，默认 Asia/Shanghai） */
  timezone?: string;
  /** 提醒名称（可选，默认自动生成） */
  name?: string;
  /** jobId（action=remove 时必填） */
  jobId?: string;
}

// ========== JSON Schema ==========

const RemindSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      description: "操作类型。add=创建提醒, list=查看已有提醒, remove=删除提醒",
      enum: ["add", "list", "remove"],
    },
    content: {
      type: "string",
      description: '提醒内容，如"喝水"、"开会"。action=add 时必填。',
    },
    to: {
      type: "string",
      description:
        "投递目标地址，取自上下文中 [QQBot] to= 的值。" +
        "私聊格式：user_openid，群聊格式：group:group_openid。action=add 时必填。",
    },
    time: {
      type: "string",
      description:
        "时间描述。支持两种格式：\n" +
        '1. 相对时间：如 "5m"(5分钟后)、"1h"(1小时后)、"1h30m"(1.5小时后)、"2d"(2天后)\n' +
        '2. cron 表达式：如 "0 8 * * *"(每天8点)、"0 9 * * 1-5"(工作日9点)\n' +
        "系统会自动判断：包含空格的视为 cron 表达式（周期提醒），否则视为相对时间（一次性提醒）。\n" +
        "action=add 时必填。",
    },
    timezone: {
      type: "string",
      description: '时区，仅周期提醒(cron)时需要。默认 "Asia/Shanghai"。',
    },
    name: {
      type: "string",
      description: "提醒任务名称（可选）。默认自动从 content 截取前 20 字。",
    },
    jobId: {
      type: "string",
      description: "要删除的任务 ID。action=remove 时必填，先用 list 获取。",
    },
  },
  required: ["action"],
} as const;

// ========== 工具函数 ==========

function json(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: data,
  };
}

/**
 * 解析相对时间字符串为毫秒数
 * 支持格式：5m, 1h, 1h30m, 2d, 30s, 1d2h30m 等
 */
function parseRelativeTime(timeStr: string): number | null {
  const s = timeStr.trim().toLowerCase();

  // 纯数字 → 视为分钟
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

/**
 * 判断是否为 cron 表达式（包含空格且有 3~6 段）
 */
function isCronExpression(timeStr: string): boolean {
  const parts = timeStr.trim().split(/\s+/);
  return parts.length >= 3 && parts.length <= 6;
}

/**
 * 自动生成任务名称
 */
function generateJobName(content: string): string {
  const trimmed = content.trim();
  const short = trimmed.length > 20 ? trimmed.slice(0, 20) + "…" : trimmed;
  return `提醒: ${short}`;
}

/**
 * 构建一次性提醒的 cron 工具参数
 */
function buildOnceJob(params: RemindParams, delayMs: number) {
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

/**
 * 构建周期提醒的 cron 工具参数
 */
function buildCronJob(params: RemindParams) {
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

/**
 * 构建提醒 payload 中的 AI prompt
 */
function buildReminderPrompt(content: string): string {
  return (
    `你是一个暖心的提醒助手。请用温暖、有趣的方式提醒用户：${content}。` +
    `要求：(1) 不要回复HEARTBEAT_OK (2) 不要解释你是谁 ` +
    `(3) 直接输出一条暖心的提醒消息 (4) 可以加一句简短的鸡汤或关怀的话 ` +
    `(5) 控制在2-3句话以内 (6) 用emoji点缀`
  );
}

/**
 * 格式化延迟时间为人类可读文本
 */
function formatDelay(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const totalMinutes = Math.round(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}分钟`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return `${hours}小时`;
  return `${hours}小时${minutes}分钟`;
}

// ========== 注册入口 ==========

export function registerRemindTool(api: OpenClawPluginApi): void {
  api.registerTool(
    {
      name: "qqbot_remind",
      label: "QQBot 定时提醒",
      description:
        "创建、查询、删除 QQ 定时提醒。" +
        "使用简单参数即可，无需手动构造 cron JSON。\n" +
        "创建提醒：action=add, content=提醒内容, to=目标地址, time=时间\n" +
        "查看提醒：action=list\n" +
        "删除提醒：action=remove, jobId=任务ID（先 list 获取）\n" +
        '时间格式示例："5m"(5分钟后) "1h"(1小时后) "0 8 * * *"(每天8点)',
      parameters: RemindSchema,
      async execute(_toolCallId, params) {
        const p = params as RemindParams;

        // ===== list =====
        if (p.action === "list") {
          return json({
            _instruction: "请立即使用 cron 工具执行以下参数",
            cronParams: { action: "list" },
          });
        }

        // ===== remove =====
        if (p.action === "remove") {
          if (!p.jobId) {
            return json({
              error: "action=remove 时 jobId 为必填参数。请先用 action=list 获取 jobId。",
            });
          }
          return json({
            _instruction: "请立即使用 cron 工具执行以下参数",
            cronParams: { action: "remove", jobId: p.jobId },
          });
        }

        // ===== add =====
        if (!p.content) {
          return json({ error: "action=add 时 content（提醒内容）为必填参数" });
        }
        if (!p.to) {
          return json({
            error: "action=add 时 to（目标地址）为必填参数，取自上下文 [QQBot] to= 的值",
          });
        }
        if (!p.time) {
          return json({
            error: 'action=add 时 time（时间）为必填参数。示例："5m"、"1h30m"、"0 8 * * *"',
          });
        }

        // 判断是 cron 表达式还是相对时间
        if (isCronExpression(p.time)) {
          // 周期提醒
          const cronJob = buildCronJob(p);
          return json({
            _instruction: "请立即使用 cron 工具执行以下参数，然后回复用户提醒已设置",
            cronParams: cronJob,
            summary: `⏰ 周期提醒: "${p.content}" (${p.time}, tz=${p.timezone || "Asia/Shanghai"})`,
          });
        }

        // 一次性提醒
        const delayMs = parseRelativeTime(p.time);
        if (!delayMs || delayMs <= 0) {
          return json({
            error:
              `无法解析时间 "${p.time}"。支持格式：` +
              `相对时间如 "5m"、"1h"、"1h30m"、"2d"；` +
              `cron 表达式如 "0 8 * * *"（每天8点）`,
          });
        }

        if (delayMs < 30_000) {
          return json({ error: "提醒时间不能少于 30 秒" });
        }

        const onceJob = buildOnceJob(p, delayMs);
        return json({
          _instruction: "请立即使用 cron 工具执行以下参数，然后回复用户提醒已设置",
          cronParams: onceJob,
          summary: `⏰ ${formatDelay(delayMs)}后提醒: "${p.content}"`,
        });
      },
    },
    { name: "qqbot_remind" },
  );
}
