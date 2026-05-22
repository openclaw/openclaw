/**
 * ActionRegistry — Playbook Action 处理器注册表
 *
 * 与 CapabilityRegistry 并列，专门服务于 Playbook `kind: action` 步骤。
 *
 * 设计原则（对标 OpenClaw plugin-sdk 注册模式）：
 *   - Pack entry.ts 通过 PackContribution.actionHandlers 注册处理器
 *   - step-executor 优先查此注册表，找不到再走通用 CRUD 兜底
 *   - 同一 action 可被后加载的 Pack 覆盖（后注册优先）
 *   - 不知道的 action 不崩溃，返回 { status: "unsupported" }
 *
 * 命名约定：
 *   <pack_id>.<action>  或  <snake_case_action_name>
 *   例：create_task, score_work_item, enterprise-analytics.export_to_bi
 */

import type { PlaybookStepContext } from "../planes/orch/playbook-types.js";

// ── 核心类型 ──────────────────────────────────────────────────────────────

/** Playbook action 处理器签名 */
export type ActionHandler = (
  params: Record<string, unknown>,
  ctx: PlaybookStepContext,
) => Promise<Record<string, unknown>>;

export interface ActionRegistration {
  /** action API 名（与 Playbook YAML 中的 action_api_name 一致） */
  apiName: string;
  handler: ActionHandler;
  /** 注册来源 Pack ID */
  packId: string;
  /** 人类可读描述（用于 /v1/actions 列表端点） */
  description?: string;
}

export interface ActionRegistry {
  /** 注册一个 action 处理器。同名后注册覆盖先注册（Pack 层叠机制）。 */
  register(registration: ActionRegistration): void;
  /** 批量注册（Pack entry 常用） */
  registerAll(packId: string, handlers: Record<string, ActionHandler>): void;
  /** 查找处理器。找不到返回 undefined。 */
  get(apiName: string): ActionRegistration | undefined;
  /** 是否已注册 */
  has(apiName: string): boolean;
  /** 列出所有注册的 action（用于文档/UI） */
  list(): ActionRegistration[];
  /** 删除指定 Pack 注册的所有 action（Pack 卸载时调用） */
  unregisterPack(packId: string): void;
  /** 清空所有注册（热重载前调用） */
  clear(): void;
}

// ── 实现 ─────────────────────────────────────────────────────────────────

export function createActionRegistry(): ActionRegistry {
  const registry = new Map<string, ActionRegistration>();

  return {
    register(reg) {
      registry.set(reg.apiName, reg);
    },

    registerAll(packId, handlers) {
      for (const [apiName, handler] of Object.entries(handlers)) {
        registry.set(apiName, { apiName, handler, packId });
      }
    },

    get(apiName) {
      return registry.get(apiName);
    },

    has(apiName) {
      return registry.has(apiName);
    },

    list() {
      return [...registry.values()];
    },

    unregisterPack(packId) {
      for (const [key, reg] of registry) {
        if (reg.packId === packId) {
          registry.delete(key);
        }
      }
    },

    clear() {
      registry.clear();
    },
  };
}
