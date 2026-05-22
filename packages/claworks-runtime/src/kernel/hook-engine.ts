/**
 * hook-engine.ts — ClaWorks 事件主动推送 Hook 系统
 *
 * ClaWorks 事件 → 主动推送到外部系统（飞书/企微/钉钉/Webhook）。
 * EventKernel.publish 后调用 HookEngine.process() 检查并执行匹配的 Hook。
 */

import { randomUUID } from "node:crypto";
import { matchGlob } from "./glob.js";

export type HookTrigger = {
  /** glob 模式，如 "alarm.*" 或 "*.created" */
  eventPattern: string;
  /** 可选过滤条件（简单模板表达式，暂为字符串保留） */
  condition?: string;
};

export type HookAction = {
  kind: "im_notify" | "webhook" | "playbook" | "a2a_delegate";
  /** IM 频道 (feishu | weixin-work | dingtalk) */
  channel?: string;
  /** webhook URL */
  url?: string;
  playbookId?: string;
  /** 消息模板，支持 {{ event.payload.xxx }} */
  template: string;
  headers?: Record<string, string>;
};

export type HookDefinition = {
  id: string;
  name: string;
  trigger: HookTrigger;
  action: HookAction;
  enabled: boolean;
  createdAt: Date;
};

export interface HookEngine {
  register(hook: Omit<HookDefinition, "id" | "createdAt">): HookDefinition;
  unregister(id: string): boolean;
  list(): HookDefinition[];
  enable(id: string): void;
  disable(id: string): void;
  /** EventKernel 发布事件时调用此方法检查并执行匹配的 Hook */
  process(
    eventType: string,
    payload: Record<string, unknown>,
    publishEvent?: (
      type: string,
      source: string,
      payload: Record<string, unknown>,
    ) => Promise<unknown>,
  ): Promise<void>;
}

/** 简单的 {{ event.payload.xxx }} 模板渲染 */
function renderTemplate(
  template: string,
  eventType: string,
  payload: Record<string, unknown>,
): string {
  return template
    .replace(/\{\{\s*event\.payload\.(\w+)\s*\}\}/g, (_, key) => {
      const val = payload[key];
      return val !== undefined ? String(val) : `{{event.payload.${key}}}`;
    })
    .replace(/\{\{\s*event\.type\s*\}\}/g, eventType);
}

export function createHookEngine(): HookEngine {
  const hooks = new Map<string, HookDefinition>();

  return {
    register(hook) {
      const id = randomUUID();
      const def: HookDefinition = {
        ...hook,
        id,
        createdAt: new Date(),
      };
      hooks.set(id, def);
      return def;
    },

    unregister(id) {
      return hooks.delete(id);
    },

    list() {
      return [...hooks.values()];
    },

    enable(id) {
      const h = hooks.get(id);
      if (h) {
        h.enabled = true;
      }
    },

    disable(id) {
      const h = hooks.get(id);
      if (h) {
        h.enabled = false;
      }
    },

    async process(eventType, payload, publishEvent) {
      for (const hook of hooks.values()) {
        if (!hook.enabled) {
          continue;
        }
        if (!matchGlob(hook.trigger.eventPattern, eventType)) {
          continue;
        }

        const message = renderTemplate(hook.action.template, eventType, payload);

        try {
          if (hook.action.kind === "im_notify") {
            // 通过 comms.send_requested 事件发送 IM 通知
            await publishEvent?.("comms.send_requested", "hook-engine", {
              message,
              channel: hook.action.channel ?? "default",
              hook_id: hook.id,
            });
          } else if (hook.action.kind === "webhook") {
            if (hook.action.url) {
              await fetch(hook.action.url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  ...hook.action.headers,
                },
                body: JSON.stringify({ message, event_type: eventType, payload }),
              });
            }
          } else if (hook.action.kind === "playbook") {
            if (hook.action.playbookId) {
              await publishEvent?.("hook.playbook_triggered", "hook-engine", {
                playbook_id: hook.action.playbookId,
                hook_id: hook.id,
                event_type: eventType,
                payload,
              });
            }
          } else if (hook.action.kind === "a2a_delegate") {
            await publishEvent?.("a2a.delegate_requested", "hook-engine", {
              message,
              hook_id: hook.id,
              event_type: eventType,
            });
          }
        } catch {
          // Hook 执行失败不应影响主流程，静默忽略
        }
      }
    },
  };
}
