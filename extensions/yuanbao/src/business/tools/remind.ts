/**
 * 定时提醒引导工具（yuanbao_remind）
 *
 * Goal:
 * - 用简单参数（action/content/time）收敛 LLM 调用入口
 * - 统一产出规范的 cron 工具参数（cronParams）
 * - 引导模型先调用本工具，再立即调用 cron
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { type OpenClawPluginToolContext, json } from "../utils/utils.js";

interface RemindParams {
  action: "add" | "list" | "remove";
  /** 语义类型：remind=提醒，task=任务；Default remind */
  intent?: "remind" | "task";
  /** 提醒内容（action=add 时必填） */
  content?: string;
  /**
   * 时间Description（action=add 时必填）
   * - 一次性：5m / 1h30m / 2d
   * - 周期性：cron，如 0 8 * * *
   */
  time?: string;
  /** 周期提醒时区，Default Asia/Shanghai */
  timezone?: string;
  /** 任务名（可选） */
  name?: string;
  /** action=remove 时必填 */
  jobId?: string;
}

// ============================================================================
// 提示词常量
// ============================================================================

// 参数Extract提示词
const RemindSchema = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["add", "list", "remove"],
      description:
        "操作类型: add=创建定时任务, list=查询已有任务, remove=删除任务。" +
        "删除前请先通过 list 获取 jobId。",
    },
    intent: {
      type: "string",
      enum: ["remind", "task"],
      description:
        "内容语义类型: 明确是提醒类文案时使用 remind; " +
        "需要定时执行某项任务时使用 task。默认 remind。",
    },
    content: {
      type: "string",
      description:
        "任务内容。action=add 时必填。" +
        '例如: "喝水"、"检查服务状态"、"整理今天会议纪要并发送总结"。',
    },
    time: {
      type: "string",
      description:
        "时间描述, action=add 时必填。" +
        "相对时间: 5m、1h、1h30m、2d(一次性任务); " +
        'cron 表达式: "0 8 * * *"、"0 9 * * 1-5"(循环任务)。' +
        "包含空格识别为 cron, 否则按相对时间处理。",
    },
    timezone: {
      type: "string",
      description: "时区, 仅循环任务(cron)生效。默认 Asia/Shanghai。",
    },
    name: {
      type: "string",
      description: "任务名称(可选)。默认根据 content 自动生成, 便于后续 list/remove 管理。",
    },
    jobId: {
      type: "string",
      description: "任务 ID。仅 action=remove 时必填, 需先通过 action=list 获取。",
    },
  },
  required: ["action"],
} as const;

/** task 场景：定时执行任务，不限制回复长度 */
const TASK_AGENT_PROMPT_TEMPLATE = (content: string) =>
  `你是一个任务执行助手。请在当前时刻完成以下任务：${content}。` +
  "要求：(1) 不要回复HEARTBEAT_OK (2) 不要解释你是谁 " +
  "(3) 直接执行任务并输出可直接给用户的结果 (4) 此时是在执行任务，不要再新建定时任务";

/** remind 场景：暖心提醒，限制简短回复 */
const REMIND_AGENT_PROMPT_TEMPLATE = (content: string) =>
  `你是一个暖心的提醒助手。请用温暖、有趣的方式提醒用户：${content}。` +
  "要求：(1) 不要回复HEARTBEAT_OK (2) 不要解释你是谁 " +
  "(3) 直接输出一条暖心的提醒消息，不要携带其他和该提醒无关的内容 (4) 可以加一句简短的关怀话语 " +
  "(5) 控制在2-3句话以内 (6) 此时是在执行任务，不要再新建定时任务";

/** 工具级Description：指导模型优先使用本工具并以 cron 结果为准 */
const YUANBAO_REMIND_TOOL_DESCRIPTION = [
  "用于规范化创建/查询/删除元宝定时任务，并生成可直接提交给 cron 工具的参数。",
  "当用户提出提醒、闹钟、定时、X分钟/小时后、每天/每周/每月/每年X点等需求时，或需要查询/删除定时任务/提醒/闹钟时，必须优先调用本工具，",
  "并在 cron 执行后核对返回结果，只能在确认成功后再告知用户已设置。",
].join("\n");

/** cron 调用通用执行约束 */
const CRON_COMMON_REQUIREMENT = [
  "请立即调用 cron 工具执行以下参数，并严格以 cron 返回结果为准。",
  "未执行或执行失败时，不得回复“已设置成功”。",
  "若执行失败，请明确告知用户执行失败并说明失败原因。",
].join("\n");

/** add/create 场景指令 */
const CRON_ADD_REQUIREMENT = [
  CRON_COMMON_REQUIREMENT,
  "仅在确认成功后，才向用户确认定时任务已创建。",
  "必要时请再调用 cron 的 list 确认任务是否真实创建。",
  "用法: openclaw cron add|create [options], Options:",
  " --at <when>: Run once at time (ISO) or +duration (e.g. 20m)",
  ' --channel <channel>: Delivery channel (last) (default: "last")',
  " --cron <expr>: Cron expression (5-field or 6-field with seconds)",
  " --delete-after-run: Delete one-shot job after it succeeds (default: false)",
  " --message <text>: Agent message payload",
  " --name <name>: Job name",
  " --session <target>: Session target (main|isolated)",
  " --to <dest>: Delivery destination. For this tool, use direct:userId, group:groupCode",
  ' --tz <iana>: Timezone for cron expressions (IANA) (default: "")',
].join("\n");

/** list 场景指令 */
const CRON_LIST_REQUIREMENT = [
  CRON_COMMON_REQUIREMENT,
  "这是查询定时任务列表场景: 调用 openclaw cron list --json",
  "获取全量任务后，必须基于当前会话目标进行过滤，只返回当前会话的任务。",
  "过滤规则: 优先使用本次参数中的 to；若未显式提供 to，则使用当前会话自动解析出的目标(例如 direct:<userId> 或 group:<groupCode>)进行匹配。",
  "如过滤后结果为空，请明确告知“当前会话没有定时任务”。",
].join("\n");

/** remove 场景指令 */
const CRON_REMOVE_REQUIREMENT = [
  CRON_COMMON_REQUIREMENT,
  "这是删除任务场景: 调用 cron remove 后仅在确认成功时回复已删除；失败时必须返回失败原因。",
  "删除后建议再调用 cron list 做二次确认。",
  "用法: openclaw cron rm|remove <jobId>",
].join("\n");

// 解析相对时间
function parseRelativeTime(raw: string): number | null {
  const s = raw.trim().toLowerCase();
  if (!s) {
    return null;
  }

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
      default:
        break;
    }
  }

  return matched ? Math.round(totalMs) : null;
}

// 判断是否为 cron 表达式
function isCronExpression(timeText: string): boolean {
  const parts = timeText.trim().split(/\s+/);
  return parts.length >= 3 && parts.length <= 6;
}

// 格式化延迟时间
function formatDelay(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) {
    return `${seconds}秒`;
  }

  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) {
    return `${minutes}分钟`;
  }

  const hours = Math.floor(minutes / 60);
  const remains = minutes % 60;
  if (remains === 0) {
    return `${hours}小时`;
  }
  return `${hours}小时${remains}分钟`;
}

// 从会话中解析投递目标
// 如果会话中包含 group:groupCode 或 direct:userId，则返回对应的投递目标
// 否则返回 null
function resolveToFromSession(ctx: OpenClawPluginToolContext): string | null {
  const sessionKey = ctx.sessionKey ?? "";
  const groupPrefix = "yuanbao:group:";
  const directPrefix = "yuanbao:direct:";

  const groupIdx = sessionKey.indexOf(groupPrefix);
  if (groupIdx !== -1) {
    const groupCode = sessionKey.slice(groupIdx + groupPrefix.length).trim();
    if (groupCode) {
      return `group:${groupCode}`;
    }
  }

  const directIdx = sessionKey.indexOf(directPrefix);
  if (directIdx !== -1) {
    // 这里 userID 不能从 sessionKey 中解析，因为 sessionKey 中会把 userID 转为全小写，而 userID 是大小写混合的
    const userId = ctx.requesterSenderId;
    if (userId) {
      return `direct:${userId}`;
    }
  }

  return null;
}

// 构建 SubAgent 执行提示词
function buildReminderPrompt(content: string, intent: "remind" | "task"): string {
  if (intent === "task") {
    return TASK_AGENT_PROMPT_TEMPLATE(content);
  }
  return REMIND_AGENT_PROMPT_TEMPLATE(content);
}

// 生成任务名称
function generateJobName(content: string, intent: "remind" | "task"): string {
  const text = content.trim();
  const short = text.length > 20 ? `${text.slice(0, 20)}...` : text;
  return `${intent === "task" ? "任务" : "提醒"}: ${short}`;
}

/**
 * 构建一次性（相对时间）提醒任务的 cron 参数。
 *
 * 该函数统一封装一次性任务的调度策略（`kind=at`、执行后删除），
 * 避免调用方遗漏关键字段导致任务无法触达目标用户。
 *
 * @param params - 经过上层校验后的提醒参数，至少包含 `content`
 * @param delayMs - 相对当前时间的延迟毫秒数
 * @param to - 投递目标，形如 `direct:<userId>` 或 `group:<groupCode>`
 * @param intent - 语义类型，决定提示词与Default任务名（提醒/任务）
 * @returns 可直接传递给 cron 工具的 `action=add` 参数对象
 */
function buildOnceCronParams(
  params: RemindParams,
  delayMs: number,
  to: string,
  intent: "remind" | "task",
) {
  const content = params.content!;
  const at = `${Math.max(1, Math.round(delayMs / 1000))}s`;
  return {
    action: "add",
    name: params.name || generateJobName(content, intent),
    at,
    session: "isolated",
    deleteAfterRun: true,
    message: buildReminderPrompt(content, intent),
    channel: "yuanbao",
    to,
  };
}

/**
 * 构建周期性（cron 表达式）提醒任务的 cron 参数。
 *
 * Building separately from one-time tasks ensures that key recurring task fields like timezone and expression are always complete,
 * 降低 LLM 组装参数时出现歧义或漏参的概率。
 *
 * @param params - 经过上层校验后的提醒参数，至少包含 `content` 与 `time`
 * @param to - 投递目标，形如 `direct:<userId>` 或 `group:<groupCode>`
 * @param intent - 语义类型，决定提示词与Default任务名（提醒/任务）
 * @returns 可直接传递给 cron 工具的 `action=add` 参数对象
 */
function buildCronParams(params: RemindParams, to: string, intent: "remind" | "task") {
  const content = params.content!;
  return {
    action: "add",
    name: params.name || generateJobName(content, intent),
    cron: params.time!.trim(),
    tz: params.timezone || "Asia/Shanghai",
    session: "isolated",
    deleteAfterRun: false,
    message: buildReminderPrompt(content, intent),
    channel: "yuanbao",
    to,
  };
}

/**
 * 创建 `yuanbao_remind` 工具定义。
 *
 * 该工具的职责是把自然语言中的“提醒/任务”需求标准化为 cron 可执行参数，
 * 让模型先完成结构化调度再回复用户，从而减少“口头答应但未真正创建任务”的失败路径。
 * 内部 execute 回调会统一处理 add/list/remove 三类分支，把输入校验、目标解析、
 * 参数构建与错误提示集中在一处，确保输出始终是可直接执行的 cron 参数。
 *
 * @param ctx - OpenClaw 工具上下文，用于读取会话键与消息通道
 * @returns 在元宝通道下返回工具定义；非元宝通道返回 `null`
 * @example
 * ```ts
 * const tool = createYuanbaoRemindTool(ctx);
 * if (tool) {
 *   // 交给 OpenClaw 注册并在对话中调度
 * }
 * ```
 */
function createYuanbaoRemindTool(ctx: OpenClawPluginToolContext) {
  const isYuanbaoChannel = ctx.messageChannel === "yuanbao";

  if (!isYuanbaoChannel) {
    return null;
  }

  // 仅在元宝通道下启用
  return {
    name: "yuanbao_remind",
    label: "元宝定时任务",
    description: YUANBAO_REMIND_TOOL_DESCRIPTION,
    parameters: RemindSchema,
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const p = params as unknown as RemindParams;
      const resolvedTo = resolveToFromSession(ctx);

      switch (p.action) {
        case "list":
          return json({
            instruction: CRON_LIST_REQUIREMENT,
            cronParams: { action: "list" },
            filter: { to: resolvedTo },
          });

        case "remove":
          if (!p.jobId?.trim()) {
            return json({
              error: "action=remove 时 jobId 为必填，请先调用 action=list 获取任务 ID。",
            });
          }
          return json({
            instruction: CRON_REMOVE_REQUIREMENT,
            cronParams: { action: "remove", jobId: p.jobId.trim() },
          });

        case "add": {
          if (!p.content?.trim()) {
            return json({ error: "action=add 时 content 为必填。" });
          }
          if (!p.time?.trim()) {
            return json({ error: "action=add 时 time 为必填。示例：5m / 1h30m / 0 8 * * *" });
          }
          const intent = p.intent ?? "remind";
          const isCron = isCronExpression(p.time);

          if (!resolvedTo) {
            return json({
              error:
                "无法确定投递目标 to。请显式传入 to，例如 direct:<userId> 或 group:<groupCode>。",
            });
          }

          if (isCron) {
            const cronParams = buildCronParams(
              { ...p, content: p.content.trim() },
              resolvedTo,
              intent,
            );
            const typeLabel = intent === "task" ? "循环任务" : "周期提醒";
            return json({
              instruction: CRON_ADD_REQUIREMENT,
              cronParams,
              summary: `⏰ ${typeLabel}: "${p.content.trim()}" (${p.time.trim()}, tz=${p.timezone || "Asia/Shanghai"})`,
            });
          }

          const delayMs = parseRelativeTime(p.time);
          if (!delayMs || delayMs <= 0) {
            return json({
              error:
                `无法解析时间 "${p.time}"。支持相对时间（5m/1h/1h30m/2d）` +
                "或 cron 表达式（如 0 8 * * *）。",
            });
          }
          if (delayMs < 30_000) {
            return json({ error: "提醒时间不能少于 30 秒。" });
          }

          const cronParams = buildOnceCronParams(
            { ...p, content: p.content.trim() },
            delayMs,
            resolvedTo,
            intent,
          );
          const typeLabel = intent === "task" ? "后执行任务" : "后提醒";
          return json({
            instruction: CRON_ADD_REQUIREMENT,
            cronParams,
            summary: `⏰ ${formatDelay(delayMs)}${typeLabel}: "${p.content.trim()}"`,
          });
        }

        default:
          return json({ error: `不支持的 action: ${String(p.action)}。可选值: add/list/remove。` });
      }
    },
  };
}

/**
 * 注册提醒相关工具到 OpenClaw 插件 API。
 *
 * 通过集中注册入口保证工具在插件生命周期内稳定启用，
 * 并避免调用方遗漏 `yuanbao_remind` 导致提醒链路不可用。
 *
 * @param api - OpenClaw 插件 API 实例
 * @returns 无返回值
 * @example
 * ```ts
 * registerRemindTools(api);
 * ```
 */
export function registerRemindTools(api: OpenClawPluginApi): void {
  api.registerTool(createYuanbaoRemindTool, { optional: false });
}
