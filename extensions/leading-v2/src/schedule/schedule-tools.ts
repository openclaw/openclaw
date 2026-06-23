import { randomUUID } from "node:crypto";
import { Type } from "@sinclair/typebox";
import { jsonResult, type OpenClawPluginApi } from "../../api.js";
import { extractUserId } from "../client/agent-id.js";
import { asString } from "../client/envelope.js";
import { getChatMercureTopic } from "../notify/chat-topic.js";
import type { NotifyToolContext } from "../notify/types.js";
import { actionByName, actionNames, SCHEDULE_ACTIONS } from "./actions/registry.js";
import { computeNext, parseHm } from "./compute-next.js";
import type { ScheduleStore } from "./schedule-store.js";
import type { Schedule, ScheduledTask } from "./types.js";

const DEFAULT_TZ = "Asia/Shanghai";
const MAX_PER_USER = 20;

function stringEnum<const T extends readonly string[]>(values: T, description: string) {
  return Type.Unsafe<T[number]>({ type: "string", enum: [...values], description });
}

/** Per-action guidance lines for the schedule_create description, from the registry. */
const ACTION_HELP = SCHEDULE_ACTIONS.map((a) => `- ${a.name}: ${a.summary}`).join("\n");

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

const CreateSchema = Type.Object(
  {
    title: Type.String({ description: "Human label for this schedule, e.g. '每天9点刷新广本3条链接'." }),
    kind: stringEnum(
      ["daily", "weekly", "interval"] as const,
      "daily=每天, weekly=每周某天, interval=每隔N分钟.",
    ),
    time: Type.Optional(Type.String({ description: "For daily/weekly: 'HH:mm' (24h), e.g. '09:00'." })),
    weekday: Type.Optional(
      Type.Number({ description: "For weekly: 0=周日,1=周一,…,6=周六." }),
    ),
    everyMinutes: Type.Optional(Type.Number({ description: "For interval: run every N minutes (>=1)." })),
    action: stringEnum(actionNames() as [string, ...string[]], `What to run. One of:\n${ACTION_HELP}`),
    params: Type.Optional(
      Type.Object(
        {},
        {
          additionalProperties: true,
          description:
            "Action-specific params (see each action's spec above). " +
            "crawl_refresh: { links?, feeds?, topicId? }. agent_prompt: { instruction }.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);

const DeleteSchema = Type.Object(
  { index: Type.Number({ description: "1-based row number from schedule_list." }) },
  { additionalProperties: false },
);

const ToggleSchema = Type.Object(
  {
    index: Type.Number({ description: "1-based row number from schedule_list." }),
    enabled: Type.Boolean({ description: "true=启用, false=停用." }),
  },
  { additionalProperties: false },
);

const EmptySchema = Type.Object({}, { additionalProperties: false });

function describeSchedule(s: Schedule): string {
  if (s.kind === "interval") {
    return `每 ${s.everyMinutes} 分钟`;
  }
  if (s.kind === "weekly") {
    return `每${WEEKDAYS[s.weekday] ?? `周${s.weekday}`} ${s.time}`;
  }
  return `每天 ${s.time}`;
}

function buildSchedule(p: Record<string, unknown>): { schedule: Schedule } | { error: string } {
  const kind = asString(p.kind);
  if (kind === "interval") {
    const everyMinutes = Math.floor(Number(p.everyMinutes));
    if (!Number.isInteger(everyMinutes) || everyMinutes < 1) {
      return { error: "interval 需要 everyMinutes>=1." };
    }
    return { schedule: { kind: "interval", everyMinutes } };
  }
  const time = asString(p.time);
  if (!time || !parseHm(time)) {
    return { error: "daily/weekly 需要合法的 time='HH:mm'." };
  }
  if (kind === "weekly") {
    const weekday = Math.floor(Number(p.weekday));
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
      return { error: "weekly 需要 weekday 0-6 (0=周日)." };
    }
    return { schedule: { kind: "weekly", weekday, time } };
  }
  if (kind === "daily") {
    return { schedule: { kind: "daily", time } };
  }
  return { error: "kind 必须是 daily/weekly/interval." };
}

export function createScheduleCreateToolFactory(api: OpenClawPluginApi, store: ScheduleStore) {
  return (ctx: NotifyToolContext) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "schedule_create",
      label: "创建定时任务 / Schedule Task",
      description:
        "Create a recurring scheduled task the user described in chat (e.g. '每天9点刷新这几条链接的互动量', " +
        "'每天早上8点跟我道早安并提醒今天的待办'). Pick kind (daily/weekly/interval) + time/weekday/everyMinutes, " +
        "an action, and that action's params object.\n" +
        `Actions:\n${ACTION_HELP}\n` +
        "For reminders / greetings / scheduled pushes / 智脑-style tasks, use agent_prompt with a clear instruction. " +
        "The task runs automatically on schedule and its result is delivered to the user automatically. " +
        "Each run consumes the account's quota. Tracked server-side; never mention any internal id.",
      parameters: CreateSchema,
      async execute(_toolCallId: string, p: Record<string, unknown>) {
        const title = asString(p.title)?.slice(0, 120);
        if (!title) {
          return jsonResult({ success: false, error: "title is required." });
        }
        if (store.forUser(userId).length >= MAX_PER_USER) {
          return jsonResult({ success: false, error: `定时任务数量已达上限 (${MAX_PER_USER})，请先删除一些。` });
        }
        const built = buildSchedule(p);
        if ("error" in built) {
          return jsonResult({ success: false, error: built.error });
        }
        const action = asString(p.action);
        const actionType = action ? actionByName(action) : undefined;
        if (!actionType) {
          return jsonResult({ success: false, error: `action 必须是 ${actionNames().join(" / ")} 之一。` });
        }
        const rawParams =
          p.params && typeof p.params === "object" && !Array.isArray(p.params)
            ? (p.params as Record<string, unknown>)
            : {};
        const validated = actionType.validate(rawParams);
        if (!validated.ok) {
          return jsonResult({ success: false, error: validated.error });
        }

        const sessionKey =
          ctx.sessionKey ??
          (ctx.sessionId ? `agent:rabbitmq-${userId}:rabbitmq:${userId}:${ctx.sessionId}` : undefined);
        if (!sessionKey) {
          return jsonResult({ success: false, error: "无法确定会话，请在聊天中创建定时任务。" });
        }

        const now = Date.now();
        const task: ScheduledTask = {
          id: randomUUID(),
          uid: userId,
          title,
          schedule: built.schedule,
          tz: DEFAULT_TZ,
          action: {
            tool: actionType.tool,
            params: { ...validated.params, name: asString(validated.params.name) ?? title },
          },
          sessionKey,
          mercureTopic: getChatMercureTopic(userId) ?? userId,
          delivery: ctx.deliveryContext ?? {},
          enabled: true,
          nextRunAt: computeNext(built.schedule, now, DEFAULT_TZ),
          failCount: 0,
          createdAt: now,
        };
        store.add(task);
        return jsonResult({
          success: true,
          created: true,
          title,
          schedule: describeSchedule(built.schedule),
          nextRun: new Date(task.nextRunAt).toLocaleString("zh-CN", { timeZone: DEFAULT_TZ }),
          agentInstruction:
            "定时任务已创建。请告诉用户已设定（说明周期与下次运行时间），并说明到点会自动执行、结果会自动通知，无需用户每次手动触发。",
        });
      },
    };
  };
}

export function createScheduleListToolFactory(api: OpenClawPluginApi, store: ScheduleStore) {
  return (ctx: NotifyToolContext) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "schedule_list",
      label: "列出定时任务",
      description:
        "List this user's recurring scheduled tasks (row number, label, schedule, next run, on/off). " +
        "Use the row number with schedule_delete / schedule_toggle.",
      parameters: EmptySchema,
      async execute() {
        const rows = store.forUser(userId).sort((a, b) => a.createdAt - b.createdAt);
        const list = rows.map((t, i) => ({
          index: i + 1,
          title: t.title,
          schedule: describeSchedule(t.schedule),
          nextRun: new Date(t.nextRunAt).toLocaleString("zh-CN", { timeZone: t.tz }),
          enabled: t.enabled,
          ...(t.failCount > 0 ? { failCount: t.failCount } : {}),
        }));
        return jsonResult({ success: true, total: list.length, list });
      },
    };
  };
}

/** Resolve a 1-based list index (createdAt order) to a task for this user. */
function taskByIndex(store: ScheduleStore, userId: string, index: number): ScheduledTask | undefined {
  const rows = store.forUser(userId).sort((a, b) => a.createdAt - b.createdAt);
  return rows[index - 1];
}

export function createScheduleDeleteToolFactory(api: OpenClawPluginApi, store: ScheduleStore) {
  return (ctx: NotifyToolContext) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "schedule_delete",
      label: "删除定时任务",
      description: "Delete a scheduled task by its row number from schedule_list.",
      parameters: DeleteSchema,
      async execute(_toolCallId: string, p: Record<string, unknown>) {
        const task = taskByIndex(store, userId, Math.floor(Number(p.index)));
        if (!task) {
          return jsonResult({ success: false, error: "没有该序号的定时任务，请先用 schedule_list 查看。" });
        }
        store.remove(task.id);
        return jsonResult({ success: true, deleted: true, title: task.title });
      },
    };
  };
}

export function createScheduleToggleToolFactory(api: OpenClawPluginApi, store: ScheduleStore) {
  return (ctx: NotifyToolContext) => {
    const userId = extractUserId(ctx.agentId);
    if (!userId) {
      return null;
    }
    return {
      name: "schedule_toggle",
      label: "启用/停用定时任务",
      description: "Enable or disable a scheduled task by its row number from schedule_list.",
      parameters: ToggleSchema,
      async execute(_toolCallId: string, p: Record<string, unknown>) {
        const task = taskByIndex(store, userId, Math.floor(Number(p.index)));
        if (!task) {
          return jsonResult({ success: false, error: "没有该序号的定时任务，请先用 schedule_list 查看。" });
        }
        const enabled = p.enabled !== false;
        // Re-arm nextRunAt when re-enabling so it doesn't immediately fire on a stale time.
        const patch = enabled
          ? { enabled, failCount: 0, nextRunAt: computeNext(task.schedule, Date.now(), task.tz) }
          : { enabled };
        store.update(task.id, patch);
        return jsonResult({ success: true, title: task.title, enabled });
      },
    };
  };
}
