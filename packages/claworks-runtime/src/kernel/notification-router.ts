/**
 * notification-router.ts — 三层通知路由系统的 Layer 2
 *
 * 职责：
 *   1. 维护用户通知偏好（channels、subscriptions）
 *   2. 维护 subject → 责任人 映射（设备/部门/角色 → userId[]）
 *   3. dispatch()：将业务意图路由到正确的收件人 + 渠道
 *
 * 设计：内存实现（可由外部持久化层覆盖）。
 */

import type { ClaworksRuntime } from "../claworks/runtime-types.js";
import { BRIDGE_NOTIFY } from "./bridge-registry.js";

export type NotificationRecipient = {
  userId: string;
  name?: string;
  /** 该用户偏好的渠道，按优先级排列，如 ["feishu"]、["weixin-work", "sms"] */
  channels: string[];
  /** 最高优先渠道（channels[0]） */
  preferredChannel?: string;
};

export type NotificationPreference = {
  userId: string;
  /** 用户注册的渠道（优先级由数组顺序决定） */
  channels: string[];
  /** 订阅的事件类型模式，如 ["alarm.*", "work_order.*"] */
  subscriptions: string[];
};

export type SubjectMapping = {
  subjectType: string;
  subjectId: string;
  userIds: string[];
};

export type DispatchOpts = {
  subjectType: string;
  subjectId?: string;
  /** 发给某个角色的所有绑定用户（如 "equipment_operator"） */
  role?: string;
  priority: "low" | "normal" | "high" | "critical";
  title?: string;
  message: string;
  metadata?: Record<string, unknown>;
};

export type DispatchResult = {
  sent: number;
  recipients: string[];
  channels: string[];
};

export interface NotificationRouter {
  resolveRecipients(subjectType: string, subjectId: string): NotificationRecipient[];

  setPreference(userId: string, pref: Partial<NotificationPreference>): void;
  getPreference(userId: string): NotificationPreference | undefined;
  listPreferences(): NotificationPreference[];

  bindSubject(subjectType: string, subjectId: string, userIds: string[]): void;
  unbindSubject(subjectType: string, subjectId: string): void;
  listBindings(): SubjectMapping[];

  dispatch(opts: DispatchOpts): Promise<DispatchResult>;
}

// ── 实现 ──────────────────────────────────────────────────────────────────

/** 构造 subject key，用于 Map 索引 */
function subjectKey(subjectType: string, subjectId: string): string {
  return `${subjectType}::${subjectId}`;
}

/** 根据优先级决定要使用的渠道子集 */
function selectChannels(
  pref: NotificationPreference,
  priority: DispatchOpts["priority"],
): string[] {
  if (priority === "critical" || priority === "high") {
    // 所有注册渠道都发
    return pref.channels.length > 0 ? pref.channels : ["default"];
  }
  // normal / low：只用最优先渠道
  return pref.channels.length > 0 ? [pref.channels[0]] : ["default"];
}

export function createNotificationRouter(runtime: ClaworksRuntime): NotificationRouter {
  const preferences = new Map<string, NotificationPreference>();
  const subjectMappings = new Map<string, SubjectMapping>();

  // ── DB 持久化（可选；runtime.db 不可用时降级为纯内存） ────────────────
  const db = runtime.db as import("../planes/data/db-types.js").CwDatabase | null | undefined;

  const stmts = db
    ? {
        upsertPref: db.prepare(`
          INSERT INTO cw_notify_preferences (user_id, channels, subscriptions, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(user_id) DO UPDATE SET
            channels = excluded.channels,
            subscriptions = excluded.subscriptions,
            updated_at = excluded.updated_at
        `),
        upsertBinding: db.prepare(`
          INSERT INTO cw_notify_bindings (subject_key, subject_type, subject_id, user_ids, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(subject_key) DO UPDATE SET
            user_ids = excluded.user_ids,
            updated_at = excluded.updated_at
        `),
        deleteBinding: db.prepare(`DELETE FROM cw_notify_bindings WHERE subject_key = ?`),
        allPrefs: db.prepare(`SELECT user_id, channels, subscriptions FROM cw_notify_preferences`),
        allBindings: db.prepare(
          `SELECT subject_key, subject_type, subject_id, user_ids FROM cw_notify_bindings`,
        ),
      }
    : null;

  /** Hydrate 从 DB 恢复数据（在 runtime 启动时调用） */
  function hydrate(): void {
    if (!stmts) {
      return;
    }
    try {
      const prefRows = stmts.allPrefs.all() as Array<{
        user_id: string;
        channels: string;
        subscriptions: string;
      }>;
      for (const row of prefRows) {
        preferences.set(row.user_id, {
          userId: row.user_id,
          channels: JSON.parse(row.channels) as string[],
          subscriptions: JSON.parse(row.subscriptions) as string[],
        });
      }
      const bindingRows = stmts.allBindings.all() as Array<{
        subject_key: string;
        subject_type: string;
        subject_id: string;
        user_ids: string;
      }>;
      for (const row of bindingRows) {
        subjectMappings.set(row.subject_key, {
          subjectType: row.subject_type,
          subjectId: row.subject_id,
          userIds: JSON.parse(row.user_ids) as string[],
        });
      }
    } catch (err) {
      runtime.logger?.(
        `[notify-router] hydrate failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 尝试立即恢复（表已存在时）
  hydrate();

  function resolveRecipients(subjectType: string, subjectId: string): NotificationRecipient[] {
    const key = subjectKey(subjectType, subjectId);
    const mapping = subjectMappings.get(key);
    const userIds = mapping?.userIds ?? [];

    if (userIds.length === 0) {
      // fallback：如果 subjectType 是 "user"，直接把 subjectId 当成 userId
      if (subjectType === "user" && subjectId) {
        userIds.push(subjectId);
      }
    }

    return userIds.map((uid) => {
      const pref = preferences.get(uid);
      const channels = pref?.channels ?? [];
      return {
        userId: uid,
        channels,
        preferredChannel: channels[0],
      };
    });
  }

  function resolveByRole(role: string): NotificationRecipient[] {
    // 角色绑定通过 subjectType="role" 来存储
    const key = subjectKey("role", role);
    const mapping = subjectMappings.get(key);
    if (!mapping || mapping.userIds.length === 0) {
      return [];
    }
    return mapping.userIds.map((uid) => {
      const pref = preferences.get(uid);
      const channels = pref?.channels ?? [];
      return {
        userId: uid,
        channels,
        preferredChannel: channels[0],
      };
    });
  }

  async function dispatch(opts: DispatchOpts): Promise<DispatchResult> {
    let recipients: NotificationRecipient[] = [];

    // 1. 先按 role 解析（若提供）
    if (opts.role) {
      recipients = resolveByRole(opts.role);
    }

    // 2. 按 subject 解析（subjectType + subjectId）
    if (recipients.length === 0 && opts.subjectId) {
      recipients = resolveRecipients(opts.subjectType, opts.subjectId);
    }

    // 3. 兜底：发到 default 渠道（无收件人配置时）
    if (recipients.length === 0) {
      const fallbackMsg = opts.title ? `${opts.title}\n${opts.message}` : opts.message;
      const notifyBridge = runtime.bridges?.get(BRIDGE_NOTIFY);
      const robotName = runtime.robot.name;
      const finalMsg = `[${robotName}] ${fallbackMsg}`;
      if (notifyBridge) {
        await notifyBridge.send({ message: finalMsg });
      } else {
        runtime.logger?.(`[notify.dispatch/fallback] ${finalMsg}`);
      }
      return { sent: 1, recipients: ["default"], channels: ["default"] };
    }

    const notifyBridge = runtime.bridges?.get(BRIDGE_NOTIFY);
    const robotName = runtime.robot.name;
    const title = opts.title ? opts.title : undefined;
    const body = title ? `${title}\n${opts.message}` : opts.message;
    const finalMsg = `[${robotName}] ${body}`;

    const sentRecipients: string[] = [];
    const sentChannels = new Set<string>();

    await Promise.allSettled(
      recipients.map(async (r) => {
        const pref = preferences.get(r.userId) ?? {
          userId: r.userId,
          channels: r.channels,
          subscriptions: [],
        };
        const channels = selectChannels(pref, opts.priority);

        if (notifyBridge) {
          await notifyBridge.send({
            message: finalMsg,
            channels: channels.length > 0 ? channels : undefined,
          });
        } else {
          runtime.logger?.(
            `[notify.dispatch → ${r.userId}] channels=${channels.join(",")} msg=${finalMsg.slice(0, 80)}`,
          );
        }

        sentRecipients.push(r.userId);
        for (const ch of channels) {
          sentChannels.add(ch);
        }
      }),
    );

    return {
      sent: sentRecipients.length,
      recipients: sentRecipients,
      channels: [...sentChannels],
    };
  }

  return {
    resolveRecipients,

    setPreference(userId: string, pref: Partial<NotificationPreference>): void {
      const existing = preferences.get(userId) ?? {
        userId,
        channels: [],
        subscriptions: [],
      };
      const updated = { ...existing, ...pref, userId };
      preferences.set(userId, updated);
      if (stmts) {
        try {
          stmts.upsertPref.run(
            userId,
            JSON.stringify(updated.channels),
            JSON.stringify(updated.subscriptions),
            Date.now(),
          );
        } catch (err) {
          runtime.logger?.(
            `[notify-router] setPreference DB write failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },

    getPreference(userId: string): NotificationPreference | undefined {
      return preferences.get(userId);
    },

    listPreferences(): NotificationPreference[] {
      return [...preferences.values()];
    },

    bindSubject(subjectType: string, subjectId: string, userIds: string[]): void {
      const key = subjectKey(subjectType, subjectId);
      subjectMappings.set(key, { subjectType, subjectId, userIds });
      if (stmts) {
        try {
          stmts.upsertBinding.run(key, subjectType, subjectId, JSON.stringify(userIds), Date.now());
        } catch (err) {
          runtime.logger?.(
            `[notify-router] bindSubject DB write failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },

    unbindSubject(subjectType: string, subjectId: string): void {
      const key = subjectKey(subjectType, subjectId);
      subjectMappings.delete(key);
      if (stmts) {
        try {
          stmts.deleteBinding.run(key);
        } catch (err) {
          runtime.logger?.(
            `[notify-router] unbindSubject DB write failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    },

    listBindings(): SubjectMapping[] {
      return [...subjectMappings.values()];
    },

    dispatch,
  };
}
