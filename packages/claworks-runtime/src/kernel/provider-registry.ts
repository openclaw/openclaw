/**
 * provider-registry.ts — ClaWorks Provider 注册表
 *
 * 统一 Provider 注册和路由，让 ClaWorks 能方便地切换 LLM、KB 后端、通知渠道。
 */

export type ProviderKind = "llm" | "kb" | "notify" | "connector";

export type ProviderDescriptor = {
  id: string;
  kind: ProviderKind;
  name: string;
  /** 数字越小优先级越高 */
  priority: number;
  /** 运行时检查是否可用 */
  available: () => boolean;
  meta?: Record<string, unknown>;
};

export interface ProviderRegistry {
  register(descriptor: ProviderDescriptor): void;
  unregister(id: string): void;
  /** 获取指定类型中优先级最高的可用 Provider */
  getBest(kind: ProviderKind): ProviderDescriptor | undefined;
  list(kind?: ProviderKind): ProviderDescriptor[];
  isAvailable(id: string): boolean;
}

export function createProviderRegistry(): ProviderRegistry {
  const providers = new Map<string, ProviderDescriptor>();

  return {
    register(descriptor) {
      providers.set(descriptor.id, descriptor);
    },

    unregister(id) {
      providers.delete(id);
    },

    getBest(kind) {
      return [...providers.values()]
        .filter((p) => p.kind === kind && p.available())
        .toSorted((a, b) => a.priority - b.priority)[0];
    },

    list(kind) {
      const all = [...providers.values()];
      return kind ? all.filter((p) => p.kind === kind) : all;
    },

    isAvailable(id) {
      return providers.get(id)?.available() ?? false;
    },
  };
}
