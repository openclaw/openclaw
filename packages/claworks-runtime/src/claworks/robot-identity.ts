/**
 * Robot Identity — 机器人自身的身份、记忆、规则与 RBAC 守卫。
 *
 * 设计原则：
 * - 机器人有自己的 robot.md（角色宣言 + 规则），不依赖聊天会话记忆
 * - RBAC 规则作为 ObjectType "RbacPolicy" 存入 ObjectStore（可靠数据，不是硬编码）
 * - 权限校验发布 `rbac.denied` 事件，可被 Playbook 响应（智能化，而非硬拒绝后沉默）
 * - 机器人记忆（声明性事实）存储为 ObjectType "RobotMemory"
 */

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type RobotOwner = {
  ownerId: string;
  channelId?: string;
  shiftSchedule?: string;
};

export type RobotIdentity = {
  name: string;
  role: string;
  domain: string;
  description: string;
  /** 运行时规则摘要（来自 robot.md + pack 规则） */
  rules: string[];
  /** 机器人守则 Markdown 全文 */
  agentMd: string;
  /** 唯一主人（来自 robot.md Owner 段） */
  owner?: RobotOwner;
};

export type RbacPolicy = {
  id: string;
  /** 操作类型：event.publish | playbook.trigger | rest.write | a2a.delegate | hitl.resolve */
  action: string;
  /** 资源通配符：alarm.* | playbook:diagnose_on_alarm | * */
  resource: string;
  /** 主体类型：agent | peer | apikey | channel_user */
  subjectType: "agent" | "peer" | "apikey" | "channel_user" | "system";
  /** 主体标识（* 表示所有同类） */
  subjectId: string;
  effect: "allow" | "deny";
  /** 可选条件（可引用 payload 字段） */
  condition?: string;
};

export type RbacCheckInput = {
  action: string;
  resource: string;
  subjectType: RbacPolicy["subjectType"];
  subjectId: string;
  /** 可选上下文（payload / event 内容） */
  context?: Record<string, unknown>;
};

export type RbacCheckResult =
  | { allowed: true }
  | { allowed: false; reason: string; policy?: RbacPolicy };

/**
 * 加载 robot.md —— 按以下优先级查找：
 * 1. packDir/robot.md（Pack 内置角色宣言）
 * 2. stateDir/robot.md（运营方定制）
 * 3. 内置默认（从 robot name + description 生成）
 */
export function loadRobotMd(opts: {
  robotName: string;
  robotRole: string;
  domain?: string;
  packDirs?: string[];
  stateDir?: string;
}): string {
  const stateDir = opts.stateDir ?? join(homedir(), ".claworks");

  // 1. 运营方定制优先
  const custom = join(stateDir, "robot.md");
  if (existsSync(custom)) {
    return readFileSync(custom, "utf-8");
  }

  // 2. Pack 内置角色宣言
  for (const dir of opts.packDirs ?? []) {
    const packMd = join(dir, "robot.md");
    if (existsSync(packMd)) {
      return readFileSync(packMd, "utf-8");
    }
  }

  // 3. 内置默认
  return buildDefaultRobotMd(opts);
}

function buildDefaultRobotMd(opts: {
  robotName: string;
  robotRole: string;
  domain?: string;
}): string {
  return `# Robot Identity: ${opts.robotName}

## 角色
- **名称**：${opts.robotName}
- **职能**：${opts.robotRole}
- **业务域**：${opts.domain ?? "通用"}

## 核心规则
1. 只响应在本业务域中有意义的事件；跨域决策通过 A2A 委托给邻域机器人。
2. 高置信度（>85%）的例行操作自动执行；低置信度的操作必须 HITL。
3. 所有写操作（创建工单、MES 下发、发送通知）需满足 RBAC 策略。
4. 系统保密：不向未授权主体透露内部本体结构或运行日志。
5. 首选确定性规则；只在不确定段使用 LLM。
6. 错误和异常触发 \`system.anomaly\` 事件；不静默失败。
7. 能量守恒：避免无意义的循环触发；相同事件 60 秒内同源不重复触发相同 Playbook。

## 可信主体
- **系统（system）**：内置 Connector、Scheduler、系统 Playbook —— 始终信任。
- **API Key（apikey）**：配置的 Bearer Token —— 信任 REST 写操作。
- **A2A Peer（peer）**：白名单内的对等机器人 —— 信任委托；不信任写操作。
- **IM 用户（channel_user）**：通过 HITL 确认后信任；默认只读。

## HITL 升级条件
- 置信度 < 85%
- 影响金额 / 物料价值 > 阈值（Pack 定义）
- 新型故障（KB 无匹配历史案例）
- 多域协作（需要其他机器人确认）
`;
}

/**
 * 提取 robot.md 中「核心规则」段落作为 rules[] 列表。
 */
/**
 * 从 robot.md 解析 Owner 段（支持 YAML 风格键或 Markdown 列表）。
 */
export function extractOwnerFromMd(md: string): RobotOwner | undefined {
  const lines = md.split("\n");
  let inOwner = false;
  const fields: Record<string, string> = {};

  for (const line of lines) {
    if (/^## Owner\b/i.test(line) || /^## 主人/.test(line)) {
      inOwner = true;
      continue;
    }
    if (inOwner && /^## /.test(line)) {
      break;
    }
    if (!inOwner) {
      continue;
    }
    const kv = line.match(/^\s*([a-zA-Z_]+)\s*:\s*(.+)\s*$/);
    if (kv) {
      fields[kv[1]!.toLowerCase()] = kv[2]!.trim();
    }
    const bullet = line.match(/^\s*[-*]\s*\*\*?([^:*]+)\*\*?\s*[:：]\s*(.+)\s*$/);
    if (bullet) {
      fields[bullet[1]!.trim().toLowerCase().replace(/\s+/g, "_")] = bullet[2]!.trim();
    }
  }

  const ownerId = fields.owner_id ?? fields.ownerid ?? fields.id;
  if (!ownerId) {
    return undefined;
  }
  return {
    ownerId,
    channelId: fields.channel_id ?? fields.channel,
    shiftSchedule: fields.shift_schedule ?? fields.shift,
  };
}

export function extractRulesFromMd(md: string): string[] {
  const lines = md.split("\n");
  const rules: string[] = [];
  let inRulesSection = false;

  for (const line of lines) {
    if (/^## 核心规则/.test(line) || /^## Core Rules/i.test(line)) {
      inRulesSection = true;
      continue;
    }
    if (inRulesSection && /^## /.test(line)) {
      break;
    }
    if (inRulesSection && /^\d+\./.test(line.trim())) {
      rules.push(line.trim().replace(/^\d+\.\s*/, ""));
    }
  }
  return rules;
}

/**
 * 构建机器人身份对象（从 robot.md 派生）。
 */
export function buildRobotIdentity(opts: {
  robotName: string;
  robotRole: string;
  domain?: string;
  packDirs?: string[];
  stateDir?: string;
}): RobotIdentity {
  const agentMd = loadRobotMd(opts);
  const rules = extractRulesFromMd(agentMd);
  const owner = extractOwnerFromMd(agentMd);
  return {
    name: opts.robotName,
    role: opts.robotRole,
    domain: opts.domain ?? "general",
    description: `ClaWorks robot: ${opts.robotName}`,
    rules,
    agentMd,
    owner,
  };
}

/**
 * RBAC 守卫 —— 从 ObjectStore RbacPolicy 对象评估权限。
 *
 * 策略评估顺序：
 * 1. 精确匹配（action + resource + subject）的 deny → 立即拒绝
 * 2. 精确匹配的 allow → 通过
 * 3. 通配符匹配（同顺序）
 * 4. 默认 deny（如无任何策略匹配）
 *
 * 可靠性原则：RBAC 守卫本身是纯函数，策略来自 ObjectStore（可审计、可热更新）。
 */
export function createRbacGuard(policies: RbacPolicy[]) {
  return {
    check(input: RbacCheckInput): RbacCheckResult {
      const matches = policies.filter(
        (p) =>
          matchesPattern(p.action, input.action) &&
          matchesPattern(p.resource, input.resource) &&
          (p.subjectType === input.subjectType || p.subjectType === "system") &&
          (p.subjectId === "*" || p.subjectId === input.subjectId),
      );

      // deny 优先（先精确，再通配）
      for (const p of matches) {
        if (
          p.effect === "deny" &&
          p.action === input.action &&
          p.resource === input.resource &&
          p.subjectId === input.subjectId
        ) {
          return { allowed: false, reason: `Denied by policy ${p.id}`, policy: p };
        }
      }
      for (const p of matches) {
        if (p.effect === "deny") {
          return { allowed: false, reason: `Denied by policy ${p.id}`, policy: p };
        }
      }

      // allow
      for (const p of matches) {
        if (p.effect === "allow") {
          return { allowed: true };
        }
      }

      // system 主体始终允许（内置可信）
      if (input.subjectType === "system") {
        return { allowed: true };
      }

      return {
        allowed: false,
        reason: "No matching allow policy (default deny)",
      };
    },

    /** 加载新策略列表（Pack 热重载后调用） */
    reload(newPolicies: RbacPolicy[]): void {
      policies.length = 0;
      policies.push(...newPolicies);
    },
  };
}

function matchesPattern(pattern: string, value: string): boolean {
  if (pattern === "*") {
    return true;
  }
  if (pattern.endsWith(".*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  if (pattern.endsWith(":*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return pattern === value;
}

/**
 * 内置默认策略（开机可用，不依赖 Pack）。
 * 运营方可通过 ObjectStore 的 RbacPolicy 对象覆盖或扩展。
 */
export const DEFAULT_RBAC_POLICIES: RbacPolicy[] = [
  // system 触发器（Connector/Scheduler）始终可以发事件
  {
    id: "sys-event-publish",
    action: "event.publish",
    resource: "*",
    subjectType: "system",
    subjectId: "*",
    effect: "allow",
  },
  // API Key 可写
  {
    id: "apikey-write",
    action: "*",
    resource: "*",
    subjectType: "apikey",
    subjectId: "*",
    effect: "allow",
  },
  // A2A peer 只能委托 a2a.delegate，不能直接写业务对象
  {
    id: "peer-a2a-allow",
    action: "a2a.delegate",
    resource: "*",
    subjectType: "peer",
    subjectId: "*",
    effect: "allow",
  },
  {
    id: "peer-event-allow",
    action: "event.publish",
    resource: "*",
    subjectType: "peer",
    subjectId: "*",
    effect: "allow",
  },
  // IM 用户只读（HITL resolve 除外）
  {
    id: "channel-user-read",
    action: "rest.read",
    resource: "*",
    subjectType: "channel_user",
    subjectId: "*",
    effect: "allow",
  },
  {
    id: "channel-user-hitl",
    action: "hitl.resolve",
    resource: "*",
    subjectType: "channel_user",
    subjectId: "*",
    effect: "allow",
  },
  {
    id: "channel-user-im-classify",
    action: "playbook.trigger",
    resource: "playbook:classify_im_to_business_event",
    subjectType: "channel_user",
    subjectId: "*",
    effect: "allow",
  },
  {
    id: "channel-user-webhook-classify",
    action: "playbook.trigger",
    resource: "playbook:classify_webhook_to_business_event",
    subjectType: "channel_user",
    subjectId: "*",
    effect: "allow",
  },
  {
    id: "channel-user-webhook-publish",
    action: "event.publish",
    resource: "webhook.*",
    subjectType: "channel_user",
    subjectId: "*",
    effect: "allow",
  },
  {
    id: "channel-user-im-publish",
    action: "event.publish",
    resource: "im.*",
    subjectType: "channel_user",
    subjectId: "*",
    effect: "allow",
  },
  // Owner：管理员级 + pack/rbac 热更新
  {
    id: "owner-admin",
    action: "*",
    resource: "*",
    subjectType: "channel_user",
    subjectId: "owner:*",
    effect: "allow",
  },
  {
    id: "owner-reload-packs",
    action: "playbook.reload",
    resource: "*",
    subjectType: "channel_user",
    subjectId: "owner:*",
    effect: "allow",
  },
  {
    id: "owner-modify-rbac",
    action: "rbac.reload",
    resource: "*",
    subjectType: "channel_user",
    subjectId: "owner:*",
    effect: "allow",
  },

  // ── 企业角色：role:approver — 审批人 ───────────────────────────────
  // 审批人可查询审批单、确认 HITL（hitl.resolve 已由 channel-user-hitl 覆盖）
  // 可写审批决策事件
  {
    id: "role-approver-approval-events",
    action: "event.publish",
    resource: "approval.*",
    subjectType: "channel_user",
    subjectId: "role:approver:*",
    effect: "allow",
  },
  {
    id: "role-approver-read",
    action: "rest.read",
    resource: "object:ApprovalRequest:*",
    subjectType: "channel_user",
    subjectId: "role:approver:*",
    effect: "allow",
  },

  // ── 企业角色：role:manager — 部门经理 ──────────────────────────────
  // 可触发报告生成、查看所有业务对象、触发特定 Playbook
  {
    id: "role-manager-read-all",
    action: "rest.read",
    resource: "*",
    subjectType: "channel_user",
    subjectId: "role:manager:*",
    effect: "allow",
  },
  {
    id: "role-manager-trigger-report",
    action: "playbook.trigger",
    resource: "playbook:daily_report_generate",
    subjectType: "channel_user",
    subjectId: "role:manager:*",
    effect: "allow",
  },
  {
    id: "role-manager-trigger-quote",
    action: "playbook.trigger",
    resource: "playbook:quote_generate",
    subjectType: "channel_user",
    subjectId: "role:manager:*",
    effect: "allow",
  },
  {
    id: "role-manager-trigger-bid",
    action: "playbook.trigger",
    resource: "playbook:bid_document_generate",
    subjectType: "channel_user",
    subjectId: "role:manager:*",
    effect: "allow",
  },
  {
    id: "role-manager-business-events",
    action: "event.publish",
    resource: "quote.*",
    subjectType: "channel_user",
    subjectId: "role:manager:*",
    effect: "allow",
  },
  {
    id: "role-manager-bid-events",
    action: "event.publish",
    resource: "bid.*",
    subjectType: "channel_user",
    subjectId: "role:manager:*",
    effect: "allow",
  },

  // ── 企业角色：role:admin — 系统管理员 ──────────────────────────────
  // 可管理 pack、RBAC、KB 入库、Playbook 写入
  {
    id: "role-admin-all",
    action: "*",
    resource: "*",
    subjectType: "channel_user",
    subjectId: "role:admin:*",
    effect: "allow",
  },

  // ── IM 用户可触发商务业务意图（通过 classify_im 路由，不直接写对象）──
  {
    id: "channel-user-business-events",
    action: "event.publish",
    resource: "task.*",
    subjectType: "channel_user",
    subjectId: "*",
    effect: "allow",
  },
  {
    id: "channel-user-incident-events",
    action: "event.publish",
    resource: "incident.*",
    subjectType: "channel_user",
    subjectId: "*",
    effect: "allow",
  },
  {
    id: "channel-user-kb-events",
    action: "event.publish",
    resource: "kb.*",
    subjectType: "channel_user",
    subjectId: "*",
    effect: "allow",
  },
];
