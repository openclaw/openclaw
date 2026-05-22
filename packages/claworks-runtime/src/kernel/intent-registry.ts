/**
 * IntentRegistry — IM 意图到业务事件的映射注册表
 *
 * 解耦 function-executor.ts 中的硬编码意图映射表：
 *   - 各 Pack 在 entry.ts 通过 PackContribution.intentMappings 声明自己的意图
 *   - function-executor 的 publish_event_from_intent 查此注册表而非硬编码 if-else
 *   - base Pack 只保留系统级 intent（hitl_approve, pack_reload, kb_query）
 *   - 业务 Pack 注册业务级 intent（task_create, alarm_report 等）
 *
 * 优先级：后注册覆盖先注册（业务包可覆盖 base 默认行为）
 */

export interface IntentMapping {
  /** LLM 分类返回的 intent 字符串（snake_case） */
  intent: string;
  /** 要发布的业务事件类型 */
  eventType: string;
  /** 可选：注册来源 Pack ID */
  packId?: string;
  /** 可选：人类可读描述（用于调试/文档） */
  description?: string;
}

export interface IntentRegistry {
  /** 注册单个 intent 映射 */
  register(mapping: IntentMapping): void;
  /** 批量注册（Pack entry 常用） */
  registerAll(packId: string, mappings: Array<Omit<IntentMapping, "packId">>): void;
  /** 根据 intent 字符串查找 eventType。找不到返回 undefined。 */
  resolve(intent: string): IntentMapping | undefined;
  /** 列出所有已注册映射 */
  list(): IntentMapping[];
  /** 删除指定 Pack 注册的所有映射（Pack 卸载时调用） */
  unregisterPack(packId: string): void;
  /** 清空所有注册（热重载前调用） */
  clear(): void;
}

export function createIntentRegistry(): IntentRegistry {
  const registry = new Map<string, IntentMapping>();

  return {
    register(mapping) {
      registry.set(mapping.intent, mapping);
    },

    registerAll(packId, mappings) {
      for (const m of mappings) {
        registry.set(m.intent, { ...m, packId });
      }
    },

    resolve(intent) {
      return registry.get(intent);
    },

    list() {
      return [...registry.values()];
    },

    unregisterPack(packId) {
      for (const [key, m] of registry) {
        if (m.packId === packId) {
          registry.delete(key);
        }
      }
    },

    clear() {
      registry.clear();
    },
  };
}
