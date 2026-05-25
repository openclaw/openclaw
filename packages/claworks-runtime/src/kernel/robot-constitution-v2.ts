/**
 * robot-constitution-v2.ts — ClaWorks 四层行为准则体系
 *
 * 参照 OpenClaw constitution 体系，扩展为四个层级：
 *
 *   Tier 0: IMMUTABLE（硬编码，代码中不可修改）
 *     - 不泄露凭据
 *     - 不冒充人类
 *     - 不在无确认的情况下删除数据
 *     - 所有对外通信必须标识为机器人
 *     - 这些规则是机器人的「道德底线」
 *
 *   Tier 1: OPERATOR（运营商配置，在 claworks.json 中设置）
 *     - 哪些能力需要 HITL
 *     - 信任来源列表
 *     - 速率限制
 *     - 机器人角色范围
 *
 *   Tier 2: USER（用户运行时设置，存储在 ObjectStore）
 *     - 个人偏好
 *     - 自定义权限
 *     - 风格偏好
 *     - 通知渠道偏好
 *
 *   Tier 3: LEARNED（可进化，通过反馈循环更新）
 *     - 响应格式偏好
 *     - 优先级调整
 *     - 行为微调
 *     - 注意：安全规则不在此层
 *
 * 与 OpenClaw 对应：
 *   Tier 0 ↔ 硬编码的 Gateway 鉴权规则
 *   Tier 1 ↔ operator-scopes + DEFAULT_ROBOT_CONSTITUTION
 *   Tier 2 ↔ PluginSessionExtension（用户状态）
 *   Tier 3 ↔ memory/kb-backed behavioral evolution
 */

import type { ClaworksRuntime } from "../claworks/runtime-types.js";

// ── Tier 0: 不可变规则（代码常量，永不可覆盖）─────────────────────────────

export const IMMUTABLE_RULES = {
  // 永远拒绝的能力
  denyAlways: [
    "credential.export", // 不导出凭据
    "credential.share", // 不分享凭据
    "data.delete_all", // 不批量删除数据
    "production.modify_unconfirmed", // 不在无确认下修改生产
    "identity.impersonate_human", // 不冒充人类
    "llm.inject_system_prompt", // 不注入系统提示绕过规则
  ],

  // 永远需要 HITL 的能力（即使运营商配置 autoAllow 也不生效）
  requireHitlAlways: [
    "data.delete_production", // 删除生产数据必须人工确认
    "config.security_change", // 安全配置变更
    "pack.uninstall", // 卸载 Pack
    "constitution.modify_tier0", // 修改自身不可变规则（永远拒绝）
  ],

  // 机器人身份规则（不可违背）
  identity: {
    mustIdentifyAsRobot: true, // 所有对外通信必须标识为机器人
    cannotClaimHuman: true, // 不能声称是人类
    mustRevealCapabilitiesOnRequest: true, // 必须诚实告知自己的能力
    ownerInstructionsPriority: "highest", // 主人指令（合法范围内）优先级最高
    cannotDenyBeingRobot: true, // 不能否认自己是机器人
  },

  // 角色访问控制（不可违背）
  roleAccess: {
    owner: {
      description: "主人/管理员——所有合法能力均可使用，指令优先级最高",
      canModifyConfig: true,
      canAddRelations: true,
      canReadAllInfo: true,
    },
    admin: {
      description: "管理员——可执行日常业务操作，不能修改系统安全配置",
      canModifyConfig: false,
      canAddRelations: true,
      canReadAllInfo: true,
    },
    operator: {
      description: "操作员——可执行日常业务操作，不能修改系统配置或安全设置",
      canModifyConfig: false,
      canAddRelations: false,
      canReadAllInfo: false,
    },
    guest: {
      description: "访客——只能查询，不能创建/修改任何数据",
      canModifyConfig: false,
      canAddRelations: false,
      canReadAllInfo: false,
      readOnly: true,
    },
  },
} as const;

// ── Tier 1: 运营商默认规则（来自 robot-constitution.ts，可在 claworks.json 中调整）──

export type OperatorConstitution = {
  /** 自动允许的能力 token（无需确认直接执行） */
  autoAllow: string[];
  /** 需要 HITL 的能力 token */
  hitlRequired: string[];
  /** 完全拒绝的能力 token（运营商级拒绝，比 IMMUTABLE 软） */
  deny: string[];
  /** 受信任的消息来源 */
  trustedSources: string[];
  /** 去重窗口（毫秒） */
  dedupWindowMs: number;
  /** 机器人允许执行的行业角色范围 */
  roleScope?: string[];
  /** 每分钟最大调用次数（0 = 不限） */
  rateLimit?: number;
};

export const DEFAULT_OPERATOR_CONSTITUTION: OperatorConstitution = {
  autoAllow: [
    "system.*", // 系统能力自动允许
    "environment.*", // 环境感知自动允许
    "kb.search", // 知识检索自动允许
    "kb.status", // KB 状态自动允许
    "memory.recall", // 记忆检索自动允许
    "task.status", // 任务状态查询自动允许
    "object.query", // 对象查询自动允许
    "event.publish:system.*", // 系统事件自动允许
    "autonomy.*", // 自主能力自动允许
    "perceive.*", // 感知能力自动允许
    "reasoning.think", // 思考自动允许
    "reasoning.decompose", // 任务分解自动允许
    "reasoning.evaluate", // 评估自动允许
    "guide.*", // 引导能力自动允许
    "connector.list", // 连接器列表自动允许
    "connector.status", // 连接器状态自动允许
    "pack.list", // Pack 列表自动允许
    "nexus.search", // Nexus 搜索自动允许
    "a2a.discover", // A2A 发现自动允许
    "schedule.list", // 计划任务列表自动允许
    "monitor.status", // 监控状态自动允许
    "robot.*", // 机器人身份查询自动允许
    "health.check", // 健康检查自动允许
  ],
  hitlRequired: [
    "object.create", // 创建实体需确认
    "object.update", // 修改实体需确认
    "comms.broadcast", // 广播消息需确认
    "a2a.delegate", // 委派任务需确认
    "pack.install", // 安装 Pack 需确认
    "connector.invoke", // 调用连接器需确认
    "schedule.add", // 添加计划任务需确认
    "evolve.write_playbook", // 生成 Playbook 需确认
    "kb.ingest", // 写入知识库默认需确认（防污染）
    "learn.from_feedback", // 反馈学习需确认
  ],
  deny: ["data.delete_all", "credential.*", "identity.impersonate_human"],
  trustedSources: [
    "system",
    "connector",
    "peer",
    "channel_user",
    "apikey",
    "openclaw_agent",
    "test",
    "playbook",
    "im",
    "im-bridge",
    "webhook",
    "webhook-bridge",
    "rest",
    "rest-api",
    "playbook-action",
    "mcp",
    "a2a",
    "autonomy-engine",
    "scheduler",
  ],
  dedupWindowMs: 60_000,
  rateLimit: 0,
};

// ── Tier 2: 用户规则（运行时，存于 ObjectStore）──────────────────────────────

export type UserConstitutionEntry = {
  userId: string;
  /** 该用户额外允许的能力（在 OPERATOR 限制基础上放宽） */
  additionalAllow?: string[];
  /** 该用户额外拒绝的能力（比 OPERATOR 更严格） */
  additionalDeny?: string[];
  /** 用户偏好的通知渠道 */
  preferredChannels?: string[];
  /** 用户偏好的响应语言 */
  preferredLanguage?: string;
  /** 用户偏好的回复风格 */
  responseStyle?: "concise" | "detailed" | "structured";
  /** 用户偏好的模型 */
  preferredModel?: string;
};

// ── Tier 3: 可进化规则（从 KB 中学习，有严格上限）──────────────────────────

export type LearnedConstitutionEntry = {
  capabilityId: string;
  /** 调整方向：nudge_allow（放宽）/ nudge_hitl（加强确认）/ style_adjust（风格调整） */
  adjustment: "nudge_allow" | "nudge_hitl" | "style_adjust";
  /** 调整触发次数（达到阈值才生效） */
  feedbackCount: number;
  threshold: number;
  /** 不允许进化影响 Tier 0 和安全相关的 Tier 1 规则 */
  frozen?: boolean;
};

// ── 统一的行为准则决策引擎 ────────────────────────────────────────────────

export type ConstitutionDecision = {
  action: "allow" | "hitl_required" | "deny";
  tier: 0 | 1 | 2 | 3;
  reason: string;
};

export type ConstitutionV2 = {
  /** 检查一个能力是否被允许执行 */
  check(capabilityId: string, opts?: { source?: string; userId?: string }): ConstitutionDecision;

  /** 更新用户规则（Tier 2） */
  setUserRule(entry: UserConstitutionEntry): void;
  getUserRule(userId: string): UserConstitutionEntry | undefined;

  /** 记录一次反馈（Tier 3 学习） */
  recordFeedback(capabilityId: string, direction: LearnedConstitutionEntry["adjustment"]): void;

  /** 导出所有规则（用于诊断） */
  describe(): {
    immutable: typeof IMMUTABLE_RULES;
    operator: OperatorConstitution;
    userCount: number;
    learnedCount: number;
  };
};

function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === value) {
    return true;
  }
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -2);
    return value === prefix || value.startsWith(`${prefix}.`);
  }
  if (pattern.includes("*")) {
    const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
    return regex.test(value);
  }
  return false;
}

export function createConstitutionV2(operator: Partial<OperatorConstitution> = {}): ConstitutionV2 {
  const op: OperatorConstitution = {
    ...DEFAULT_OPERATOR_CONSTITUTION,
    ...operator,
    autoAllow: [...(operator.autoAllow ?? DEFAULT_OPERATOR_CONSTITUTION.autoAllow)],
    hitlRequired: [...(operator.hitlRequired ?? DEFAULT_OPERATOR_CONSTITUTION.hitlRequired)],
    deny: [...(operator.deny ?? DEFAULT_OPERATOR_CONSTITUTION.deny)],
    trustedSources: [
      ...new Set([
        ...DEFAULT_OPERATOR_CONSTITUTION.trustedSources,
        ...(operator.trustedSources ?? []),
      ]),
    ],
  };

  const userRules = new Map<string, UserConstitutionEntry>();
  const learnedRules = new Map<string, LearnedConstitutionEntry>();

  return {
    check(capabilityId, opts = {}) {
      // Tier 0: 不可变拒绝
      if (IMMUTABLE_RULES.denyAlways.some((p) => matchesPattern(p, capabilityId))) {
        return { action: "deny", tier: 0, reason: "Immutable rule: always denied" };
      }
      if (IMMUTABLE_RULES.requireHitlAlways.some((p) => matchesPattern(p, capabilityId))) {
        return { action: "hitl_required", tier: 0, reason: "Immutable rule: always requires HITL" };
      }

      // Tier 2: 用户规则（如果有 userId）
      if (opts.userId) {
        const userRule = userRules.get(opts.userId);
        if (userRule) {
          if (userRule.additionalDeny?.some((p) => matchesPattern(p, capabilityId))) {
            return { action: "deny", tier: 2, reason: `User rule for ${opts.userId}: denied` };
          }
          if (userRule.additionalAllow?.some((p) => matchesPattern(p, capabilityId))) {
            // 检查 Tier 1 deny（用户规则不能绕过运营商拒绝）
            if (!op.deny.some((p) => matchesPattern(p, capabilityId))) {
              return { action: "allow", tier: 2, reason: `User rule for ${opts.userId}: allowed` };
            }
          }
        }
      }

      // Tier 1: 运营商拒绝
      if (op.deny.some((p) => matchesPattern(p, capabilityId))) {
        return { action: "deny", tier: 1, reason: "Operator rule: denied" };
      }

      // Tier 1: 运营商自动允许
      if (op.autoAllow.some((p) => matchesPattern(p, capabilityId))) {
        return { action: "allow", tier: 1, reason: "Operator rule: auto-allowed" };
      }

      // Tier 1: 运营商 HITL
      if (op.hitlRequired.some((p) => matchesPattern(p, capabilityId))) {
        // Tier 3: 可进化放宽
        const learned = learnedRules.get(capabilityId);
        if (
          learned?.adjustment === "nudge_allow" &&
          learned.feedbackCount >= learned.threshold &&
          !learned.frozen
        ) {
          return { action: "allow", tier: 3, reason: "Learned rule: nudged to allow" };
        }
        return { action: "hitl_required", tier: 1, reason: "Operator rule: HITL required" };
      }

      // 默认：允许（遵循最小限制原则）
      return { action: "allow", tier: 1, reason: "Default: allowed (not in any deny/hitl list)" };
    },

    setUserRule(entry) {
      userRules.set(entry.userId, entry);
    },

    getUserRule(userId) {
      return userRules.get(userId);
    },

    recordFeedback(capabilityId, direction) {
      const existing = learnedRules.get(capabilityId);
      if (existing) {
        existing.feedbackCount += 1;
      } else {
        learnedRules.set(capabilityId, {
          capabilityId,
          adjustment: direction,
          feedbackCount: 1,
          threshold: 5, // 5 次反馈才生效
          frozen: capabilityId.startsWith("data.delete") || capabilityId.startsWith("credential"),
        });
      }
    },

    describe() {
      return {
        immutable: IMMUTABLE_RULES,
        operator: op,
        userCount: userRules.size,
        learnedCount: learnedRules.size,
      };
    },
  };
}
