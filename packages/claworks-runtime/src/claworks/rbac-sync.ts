/**
 * rbac-sync — 从 ObjectStore 中加载 RbacPolicy 对象，刷新 runtime.rbac。
 *
 * 设计：
 * - Pack 热重载后自动调用
 * - 也可通过 REST POST /v1/rbac/reload 手动触发
 * - ObjectStore 中的 RbacPolicy 与 DEFAULT_RBAC_POLICIES 合并（ObjectStore 策略优先）
 * - 这样权限策略本身就是「可靠数据」，不是硬编码
 */

import { DEFAULT_INGRESS_POLICIES, type IngressPolicy } from "../kernel/ingress.js";
import { DEFAULT_RBAC_POLICIES, type RbacPolicy } from "./robot-identity.js";
import type { ClaworksRuntime } from "./runtime-types.js";

export async function syncRbacFromObjectStore(runtime: ClaworksRuntime): Promise<void> {
  try {
    const { items } = await runtime.objectStore.query("RbacPolicy", { limit: 500 });
    if (items.length === 0) {
      // 无自定义策略，回退到默认
      runtime.rbac.reload([...DEFAULT_RBAC_POLICIES]);
      return;
    }

    const customPolicies: RbacPolicy[] = items
      .map((item) => {
        try {
          return {
            id: String(item.id),
            action: String(item.action ?? "*"),
            resource: String(item.resource ?? "*"),
            subjectType: (item.subjectType ??
              item.subject_type ??
              "apikey") as RbacPolicy["subjectType"],
            subjectId: String(item.subjectId ?? item.subject_id ?? "*"),
            effect: (item.effect ?? "allow") as "allow" | "deny",
            condition: item.condition ? String(item.condition) : undefined,
          } satisfies RbacPolicy;
        } catch {
          return null;
        }
      })
      .filter((p): p is RbacPolicy => p !== null);

    // ObjectStore 中的策略优先级比默认策略高（放在前面）
    runtime.rbac.reload([...customPolicies, ...DEFAULT_RBAC_POLICIES]);
    runtime.logger?.(
      `[claworks:rbac] loaded ${customPolicies.length} custom policies from ObjectStore`,
    );
  } catch {
    // ObjectType 未定义时静默（Pack 还未加载 RbacPolicy 类型）
    runtime.logger?.("[claworks:rbac] RbacPolicy type not available yet, using defaults");
    runtime.rbac.reload([...DEFAULT_RBAC_POLICIES]);
  }
}

/**
 * IngressPolicy 同样从 ObjectStore 加载后刷新 runtime.ingress。
 */
export async function syncIngressFromObjectStore(runtime: ClaworksRuntime): Promise<void> {
  try {
    const { items } = await runtime.objectStore.query("IngressPolicy", { limit: 500 });
    if (items.length === 0) {
      runtime.ingress.reload([...DEFAULT_INGRESS_POLICIES]);
      return;
    }
    const customPolicies = items
      .map((item) => {
        try {
          return {
            id: String(item.id),
            source: (item.source ?? "*") as IngressPolicy["source"],
            eventTypePattern: String(item.eventTypePattern ?? item.event_type_pattern ?? "*"),
            subjectId: item.subjectId ? String(item.subjectId) : undefined,
            decision: (item.decision ?? { action: "kernel" }) as IngressPolicy["decision"],
            priority: Number(item.priority ?? 50),
          } satisfies IngressPolicy;
        } catch {
          return null;
        }
      })
      .filter((p): p is IngressPolicy => p !== null);

    runtime.ingress.reload([...customPolicies, ...DEFAULT_INGRESS_POLICIES]);
    runtime.logger?.(
      `[claworks:ingress] loaded ${customPolicies.length} custom policies from ObjectStore`,
    );
  } catch {
    runtime.ingress.reload([...DEFAULT_INGRESS_POLICIES]);
  }
}
