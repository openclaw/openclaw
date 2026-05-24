/**
 * CapabilityRegistry — ClaWorks 能力注册表
 *
 * 与 OpenClaw GatewayMethodRegistry 同构：
 *   注册表: Map<capabilityId, CapabilityDescriptor>
 *   分发:   registry.get(id) → handler(ctx, params)
 *   扩展:   pack.registerCapability(descriptor) — 无需改核心代码
 *   未知:   fallbackHandler — 永远不崩溃，机器人会回答"不会但能学"
 *
 * 命名空间约定:
 *   system.*   机器人系统能力（心跳、自描述、学习接口）
 *   kb.*       知识记忆能力
 *   task.*     任务/Playbook 执行能力
 *   object.*   实体 CRUD 能力
 *   event.*    事件发布能力
 *   message.*  通用消息处理能力（含兜底）
 *   <packId>.* Pack 注册的业务能力
 */

import type { PlaybookStepContext } from "../planes/orch/playbook-types.js";

// ── 核心类型 ─────────────────────────────────────────────────────────────

/** 通用能力处理函数 */
export type CapabilityHandler = (
  ctx: CapabilityContext,
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

/** 动词分类（用于分析、路由、遥测） */
export type CapabilityVerb =
  | "query" // 只读查询，无副作用
  | "acquire" // 从外部获取/学习信息
  | "retrieve" // 从内部存储检索
  | "transform" // 变换/计算数据
  | "compose" // 组合多个能力完成复杂任务
  | "deliver" // 发布/发送/推送
  | "observe" // 记录/监控/追踪
  | "control" // 控制系统行为
  | "modify" // 写入/更新（CRUD 写操作）
  | "create" // 创建新对象
  | "delete" // 删除对象
  | "execute"; // 执行/运行（调用外部能力/脚本）

/** 能力归属 */
export type CapabilityOwner =
  | { kind: "core" }
  | { kind: "pack"; packId: string }
  | { kind: "bridge"; bridgeId: string };

/** RBAC 决策 */
export type CapabilityRbacPolicy = {
  /** 允许的 subjectType 列表；省略表示不限 */
  allowedSubjects?: string[];
  /** 默认决策 */
  decision: "allow" | "hitl_required" | "deny";
  reason?: string;
};

/** 能力描述符（与 GatewayMethodDescriptor 同构） */
export type CapabilityDescriptor = {
  /** 唯一 ID，格式 "namespace.verb_noun"，如 "kb.search" */
  id: string;
  verb: CapabilityVerb;
  description: string;
  handler: CapabilityHandler;
  /** JSON Schema（用于自描述、参数校验、自动学习） */
  paramsSchema?: Record<string, unknown>;
  resultSchema?: Record<string, unknown>;
  rbac?: CapabilityRbacPolicy;
  owner: CapabilityOwner;
  /** false = 不出现在 system.describe 列表中 */
  advertise?: boolean;
};

/** describe 时返回的精简视图 */
export type CapabilityView = {
  id: string;
  verb: CapabilityVerb;
  description: string;
  paramsSchema?: Record<string, unknown>;
  owner: CapabilityOwner;
};

/** 能力执行上下文（注入到 handler，不泄漏整个 runtime） */
export type CapabilityContext = {
  /** 调用来源（im / rest / playbook / scheduler / ...） */
  source: string;
  /** 主体标识 */
  subjectId?: string;
  subjectType?: string;
  /** 用户 ID（im 渠道等用户身份场景） */
  userId?: string;
  /** correlationId 用于跟踪链路 */
  correlationId?: string;
  /** Playbook run ID（从 stepCtx 或 HITL 等场景注入） */
  runId?: string;
  /** Playbook ID（从 stepCtx 或 HITL 等场景注入） */
  playbookId?: string;
  /** Playbook step 上下文（从 Playbook 触发时注入） */
  stepCtx?: PlaybookStepContext;
  /** 向下调用其他能力（避免直接访问 registry） */
  invoke: (
    capabilityId: string,
    params: Record<string, unknown>,
  ) => Promise<Record<string, unknown>>;
  /** 日志 */
  logger?: (msg: string) => void;
};

// ── 注册表接口 ───────────────────────────────────────────────────────────

/** 熔断器状态 */
export type CircuitBreakerState = "closed" | "open" | "half-open";

export type CircuitBreakerStatus = {
  capabilityId: string;
  state: CircuitBreakerState;
  failureCount: number;
  lastFailureAt?: number;
  openUntil?: number;
};

export type CapabilityRegistry = {
  /** 注册一个能力（重复 id 报错；pack 注册时 id 必须以 packId 开头） */
  register(descriptor: CapabilityDescriptor): void;
  /** 批量注册 */
  registerAll(descriptors: CapabilityDescriptor[]): void;
  /** 注销 Pack 的所有能力（Pack 卸载/重载时调用） */
  unregisterPack(packId: string): void;
  /** 查找 handler（找不到返回 undefined） */
  get(id: string): CapabilityDescriptor | undefined;
  /** 列出所有可广播的能力（用于 system.describe） */
  list(): CapabilityView[];
  /** 列出所有 id（含隐藏） */
  listAll(): string[];
  /**
   * 经行为准则检查后调用能力。
   * - allow: 直接执行
   * - hitl_required: 抛出 CapabilityHitlRequired 错误（调用者负责发起 HITL 流程）
   * - deny: 抛出 CapabilityDenied 错误
   */
  invoke(
    id: string,
    ctx: CapabilityContext,
    params: Record<string, unknown>,
    opts?: { constitutionCheck?: { source?: string; userId?: string } },
  ): Promise<Record<string, unknown>>;
  /**
   * 注入行为准则（runtime.ts 在 constitution 创建后调用）。
   * 调用后所有 invoke() 均会经过 constitution.check()。
   */
  setConstitution(constitution: {
    check(
      id: string,
      opts?: { source?: string; userId?: string },
    ): {
      action: "allow" | "hitl_required" | "deny";
      tier: 0 | 1 | 2 | 3;
      reason: string;
    };
  }): void;
  /** 列出所有处于 open/half-open 状态的熔断器 */
  listCircuitBreakers(): CircuitBreakerStatus[];
  /** 手动重置某个能力的熔断器（运维用途）*/
  resetCircuitBreaker(capabilityId: string): void;
};

// ── 错误类型 ─────────────────────────────────────────────────────────────

export class CapabilityDenied extends Error {
  readonly capabilityId: string;
  readonly tier: number;
  readonly constitutionReason: string;
  constructor(capabilityId: string, tier: number, reason: string) {
    super(`Capability "${capabilityId}" denied by constitution (tier ${tier}): ${reason}`);
    this.name = "CapabilityDenied";
    this.capabilityId = capabilityId;
    this.tier = tier;
    this.constitutionReason = reason;
  }
}

export class CapabilityHitlRequired extends Error {
  readonly capabilityId: string;
  readonly tier: number;
  readonly constitutionReason: string;
  constructor(capabilityId: string, tier: number, reason: string) {
    super(`Capability "${capabilityId}" requires HITL (tier ${tier}): ${reason}`);
    this.name = "CapabilityHitlRequired";
    this.capabilityId = capabilityId;
    this.tier = tier;
    this.constitutionReason = reason;
  }
}

export class CapabilityNotFound extends Error {
  readonly capabilityId: string;
  constructor(capabilityId: string) {
    super(`Capability "${capabilityId}" not found in registry`);
    this.name = "CapabilityNotFound";
    this.capabilityId = capabilityId;
  }
}

// ── 工厂函数 ─────────────────────────────────────────────────────────────

/** 熔断器配置 */
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 5; // 连续失败 5 次后熔断
const CIRCUIT_BREAKER_OPEN_DURATION_MS = 30_000; // open 状态持续 30 秒
const CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS = 10_000; // half-open 等待超时

export function createCapabilityRegistry(): CapabilityRegistry {
  const map = new Map<string, CapabilityDescriptor>();
  let _constitution:
    | {
        check(
          id: string,
          opts?: { source?: string; userId?: string },
        ): { action: "allow" | "hitl_required" | "deny"; tier: 0 | 1 | 2 | 3; reason: string };
      }
    | undefined;

  // 熔断器状态表
  const circuitBreakers = new Map<
    string,
    {
      failureCount: number;
      state: CircuitBreakerState;
      lastFailureAt: number;
      openUntil: number;
      halfOpenSince: number;
    }
  >();

  function getCb(id: string) {
    if (!circuitBreakers.has(id)) {
      circuitBreakers.set(id, {
        failureCount: 0,
        state: "closed",
        lastFailureAt: 0,
        openUntil: 0,
        halfOpenSince: 0,
      });
    }
    return circuitBreakers.get(id)!;
  }

  function recordSuccess(id: string) {
    const cb = circuitBreakers.get(id);
    if (!cb) return;
    cb.failureCount = 0;
    cb.state = "closed";
    cb.openUntil = 0;
    cb.halfOpenSince = 0;
  }

  function recordFailure(id: string) {
    const cb = getCb(id);
    cb.failureCount += 1;
    cb.lastFailureAt = Date.now();
    if (cb.state === "half-open" || cb.failureCount >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
      cb.state = "open";
      cb.openUntil = Date.now() + CIRCUIT_BREAKER_OPEN_DURATION_MS;
    }
  }

  function checkCircuitBreaker(id: string): "allow" | "open" | "half-open" {
    const cb = circuitBreakers.get(id);
    if (!cb || cb.state === "closed") return "allow";

    const now = Date.now();
    if (cb.state === "open") {
      if (now >= cb.openUntil) {
        cb.state = "half-open";
        cb.halfOpenSince = now;
        return "half-open";
      }
      return "open";
    }

    // half-open: 允许一次试探
    if (cb.state === "half-open") {
      if (now - cb.halfOpenSince > CIRCUIT_BREAKER_HALF_OPEN_TIMEOUT_MS) {
        // 试探超时，重新 open
        cb.state = "open";
        cb.openUntil = now + CIRCUIT_BREAKER_OPEN_DURATION_MS;
        return "open";
      }
      return "half-open";
    }

    return "allow";
  }

  function register(descriptor: CapabilityDescriptor): void {
    if (!descriptor.id.trim()) {
      throw new Error("CapabilityRegistry: id must not be empty");
    }
    if (map.has(descriptor.id)) {
      throw new Error(`CapabilityRegistry: capability already registered: ${descriptor.id}`);
    }
    map.set(descriptor.id, descriptor);
  }

  return {
    register,

    registerAll(descriptors) {
      for (const d of descriptors) register(d);
    },

    unregisterPack(packId) {
      for (const [id, desc] of map.entries()) {
        if (desc.owner.kind === "pack" && desc.owner.packId === packId) {
          map.delete(id);
        }
      }
    },

    get(id) {
      return map.get(id);
    },

    list() {
      return [...map.values()]
        .filter((d) => d.advertise !== false)
        .map((d) => ({
          id: d.id,
          verb: d.verb,
          description: d.description,
          paramsSchema: d.paramsSchema,
          owner: d.owner,
        }));
    },

    listAll() {
      return [...map.keys()];
    },

    setConstitution(constitution) {
      _constitution = constitution;
    },

    listCircuitBreakers() {
      return [...circuitBreakers.entries()].map(([id, cb]) => ({
        capabilityId: id,
        state: cb.state,
        failureCount: cb.failureCount,
        lastFailureAt: cb.lastFailureAt || undefined,
        openUntil: cb.openUntil || undefined,
      }));
    },

    resetCircuitBreaker(capabilityId) {
      circuitBreakers.delete(capabilityId);
    },

    async invoke(id, ctx, params, opts = {}) {
      const descriptor = map.get(id);
      if (!descriptor) {
        throw new CapabilityNotFound(id);
      }

      // 1. 熔断器检查
      const cbStatus = checkCircuitBreaker(id);
      if (cbStatus === "open") {
        const cb = circuitBreakers.get(id)!;
        throw new Error(
          `Capability "${id}" circuit breaker is OPEN (${cb.failureCount} failures). Retry after ${Math.ceil((cb.openUntil - Date.now()) / 1000)}s`,
        );
      }

      // 2. 描述符级 RBAC（Pack 或核心能力定义的 deny/hitl）
      if (descriptor.rbac) {
        if (descriptor.rbac.decision === "deny") {
          throw new CapabilityDenied(
            id,
            1,
            descriptor.rbac.reason ?? "Denied by capability descriptor",
          );
        }
        if (descriptor.rbac.decision === "hitl_required") {
          throw new CapabilityHitlRequired(
            id,
            1,
            descriptor.rbac.reason ?? "HITL required by capability descriptor",
          );
        }
      }

      // 3. 行为准则四层检查
      if (_constitution) {
        const decision = _constitution.check(id, opts.constitutionCheck);
        if (decision.action === "deny") {
          throw new CapabilityDenied(id, decision.tier, decision.reason);
        }
        if (decision.action === "hitl_required") {
          throw new CapabilityHitlRequired(id, decision.tier, decision.reason);
        }
      }

      // 4. 执行 handler，记录熔断器状态
      try {
        const result = await descriptor.handler(ctx, params);
        if (cbStatus === "half-open") {
          recordSuccess(id);
        }
        return result;
      } catch (err) {
        recordFailure(id);
        throw err;
      }
    },
  };
}
