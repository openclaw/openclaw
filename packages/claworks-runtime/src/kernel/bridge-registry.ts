/**
 * BridgeRegistry — 外部接口桥接注册表
 *
 * 替代 PlaybookEngineDeps 里平铺的函数指针 (llmComplete, notify, subagentRun...)
 * 与 OpenClaw PluginRegistry 中各类 Registration 数组同构：
 *   插件通过 registry.registerXxx() 注入实现；核心代码只调 registry.getBridge("llm")。
 *
 * 设计原则：
 *   - 核心代码对任何外部实现都是可选+可替换的（测试/生产/stub）
 *   - 每类桥接有唯一 well-known key，防止拼写错误
 *   - 桥接本身是版本化的接口，添加新方法时核心不感知
 */

// ── Well-known bridge keys（类似 OpenClaw 的 plugin capability names）─────

export const BRIDGE_LLM = "llm" as const;
export const BRIDGE_NOTIFY = "notify" as const;
export const BRIDGE_SUBAGENT = "subagent" as const;
export const BRIDGE_SKILL = "skill" as const;

// ── Bridge 接口定义 ───────────────────────────────────────────────────────

export type LlmBridge = {
  complete(params: { prompt: string; model?: string }): Promise<{ text: string }>;
};

export type NotifyBridge = {
  send(params: {
    message: string;
    channels?: string[];
    /** 渠道原生富格式卡片 map（key=渠道ID, value=原生卡片 JSON） */
    cards?: Record<string, unknown>;
  }): Promise<void>;
};

export type SubagentBridge = {
  run(params: { prompt: string; model?: string }): Promise<{ text: string }>;
};

export type SkillBridge = {
  run(params: {
    skillId: string;
    input?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  /** 可选：列出 harness 侧所有可用 skill（OpenClaw ClawHub）*/
  list?(): Promise<Array<{ id: string; name?: string; description?: string }>>;
};

export type BridgeTypeMap = {
  [BRIDGE_LLM]: LlmBridge;
  [BRIDGE_NOTIFY]: NotifyBridge;
  [BRIDGE_SUBAGENT]: SubagentBridge;
  [BRIDGE_SKILL]: SkillBridge;
};

// ── 注册表接口 ────────────────────────────────────────────────────────────

export type BridgeRegistry = {
  register<K extends keyof BridgeTypeMap>(key: K, impl: BridgeTypeMap[K]): void;
  get<K extends keyof BridgeTypeMap>(key: K): BridgeTypeMap[K] | undefined;
  has(key: string): boolean;
};

export function createBridgeRegistry(): BridgeRegistry {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new Map<string, any>();
  return {
    register(key, impl) {
      store.set(key, impl);
    },
    get(key) {
      return store.get(key);
    },
    has(key) {
      return store.has(key);
    },
  };
}
