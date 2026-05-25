/**
 * robot-identity-manager.ts — 机器人完整身份管理系统
 *
 * 提供：
 * - RobotIdentityProfile：机器人的完整身份信息（组织、角色、能力声明等）
 * - RobotRelation：与其他人/机器人的关系
 * - RobotIdentityManager：身份管理器接口（读/写/持久化）
 *
 * 与 claworks/robot-identity.ts 的关系：
 *   robot-identity.ts   → 从 robot.md 读取静态 RBAC/宪法信息（运行时不可变）
 *   robot-identity-manager.ts → 动态身份、关系、自我介绍（可热更新、可持久化）
 */

import { randomUUID } from "node:crypto";
import type { ClaworksRobotConfig } from "../claworks/config-types.js";

// ── 身份数据结构 ──────────────────────────────────────────────────────────────

export type RobotIdentityProfile = {
  id: string;
  name: string;
  role: string;
  organization: string;
  domain: string;
  version: string;
  language: string;
  timezone: string;

  owner?: {
    userId: string;
    name: string;
    contact?: string;
  };
  admins: string[];
  operators: string[];
  guests: string[];

  capabilities_summary: string;
  introduction: string;

  always_greet: boolean;
  auto_learn: boolean;
  proactive: boolean;
};

export type RobotRelation = {
  userId: string;
  name: string;
  role: "owner" | "admin" | "operator" | "guest" | "peer_robot";
  channels: string[];
  bindingSubjects: string[];
  joinedAt: Date;
  note?: string;
};

// ── 接口定义 ──────────────────────────────────────────────────────────────────

export type RobotIdentityManager = {
  getIdentity(): RobotIdentityProfile;
  updateIdentity(patch: Partial<RobotIdentityProfile>): void;

  addRelation(relation: Omit<RobotRelation, "joinedAt">): RobotRelation;
  removeRelation(userId: string): boolean;
  getRelation(userId: string): RobotRelation | undefined;
  listRelations(): RobotRelation[];

  buildIntroduction(lang?: string): string;

  persist(db: { prepare: (sql: string) => { run: (...args: unknown[]) => void } }): Promise<void>;
  hydrate(db: {
    prepare: (sql: string) => { get: (...args: unknown[]) => unknown };
  }): Promise<void>;
};

// ── 工厂函数 ──────────────────────────────────────────────────────────────────

export function createRobotIdentityManager(
  config: Partial<RobotIdentityProfile> & Pick<ClaworksRobotConfig, never> = {},
): RobotIdentityManager {
  let identity: RobotIdentityProfile = {
    id: config.id ?? randomUUID(),
    name: config.name ?? "ClaWorks 机器人",
    role: config.role ?? "通用工业助手",
    organization: config.organization ?? "未设置",
    domain: config.domain ?? "通用",
    version: config.version ?? "1.0.0",
    language: config.language ?? "zh-CN",
    timezone: config.timezone ?? "Asia/Shanghai",
    owner: config.owner,
    admins: config.admins ?? [],
    operators: config.operators ?? [],
    guests: config.guests ?? [],
    capabilities_summary:
      config.capabilities_summary ?? "工业设备监控、报警处理、工单管理、知识库查询",
    introduction: config.introduction ?? "",
    always_greet: config.always_greet ?? true,
    auto_learn: config?.auto_learn ?? true,
    proactive: config.proactive ?? true,
  };

  // 如果没有自定义介绍，使用模板生成
  if (!identity.introduction) {
    identity.introduction = buildIntroTemplate(identity);
  }

  const relations = new Map<string, RobotRelation>();

  // 如果配置了 owner，自动添加 owner 关系
  if (identity.owner) {
    relations.set(identity.owner.userId, {
      userId: identity.owner.userId,
      name: identity.owner.name,
      role: "owner",
      channels: [],
      bindingSubjects: [],
      joinedAt: new Date(),
    });
  }

  return {
    getIdentity() {
      return { ...identity };
    },

    updateIdentity(patch) {
      identity = { ...identity, ...patch };
      if (!patch.introduction) {
        identity.introduction = buildIntroTemplate(identity);
      }
    },

    addRelation(rel) {
      const full: RobotRelation = { ...rel, joinedAt: new Date() };
      relations.set(rel.userId, full);
      // 同步到 identity 的角色列表
      syncRoleLists(identity, relations);
      return full;
    },

    removeRelation(userId) {
      const removed = relations.delete(userId);
      if (removed) {
        syncRoleLists(identity, relations);
      }
      return removed;
    },

    getRelation(userId) {
      return relations.get(userId);
    },

    listRelations() {
      return Array.from(relations.values());
    },

    buildIntroduction(lang?: string) {
      if (lang && lang !== "zh-CN" && lang !== "zh") {
        return buildIntroTemplateEn(identity);
      }
      return buildIntroTemplate(identity);
    },

    async persist(db) {
      const sql = `
        INSERT OR REPLACE INTO cw_robot_identity (id, data, updated_at)
        VALUES (?, ?, ?)
      `;
      const data = JSON.stringify({
        identity,
        relations: Array.from(relations.values()).map((r) =>
          Object.assign({}, r, { joinedAt: r.joinedAt.toISOString() }),
        ),
      });
      try {
        db.prepare(sql).run("singleton", data, Date.now());
      } catch {
        // 表不存在时静默忽略（bootstrap 前调用）
      }
    },

    async hydrate(db) {
      try {
        const row = db
          .prepare("SELECT data FROM cw_robot_identity WHERE id = ?")
          .get("singleton") as { data: string } | undefined;

        if (!row) {
          return;
        }

        const parsed = JSON.parse(row.data) as {
          identity: RobotIdentityProfile;
          relations: Array<RobotRelation & { joinedAt: string }>;
        };

        identity = { ...identity, ...parsed.identity };
        relations.clear();
        for (const r of parsed.relations ?? []) {
          relations.set(r.userId, { ...r, joinedAt: new Date(r.joinedAt) });
        }
      } catch {
        // 水合失败时使用内存状态（非致命）
      }
    },
  };
}

// ── 内部辅助函数 ──────────────────────────────────────────────────────────────

function buildIntroTemplate(identity: RobotIdentityProfile): string {
  const ownerPart = identity.owner ? `我归属于 **${identity.owner.name}** 管理。` : "";
  return `我是 **${identity.name}**，${identity.organization}的${identity.role}。我能帮您处理${identity.capabilities_summary}。${ownerPart}

**版本**：${identity.version}  
**语言**：${identity.language}  
**时区**：${identity.timezone}`;
}

function buildIntroTemplateEn(identity: RobotIdentityProfile): string {
  return `I am **${identity.name}**, the ${identity.role} of ${identity.organization}. I can help you with ${identity.capabilities_summary}.

**Version**: ${identity.version}  
**Language**: ${identity.language}  
**Timezone**: ${identity.timezone}`;
}

function syncRoleLists(
  identity: RobotIdentityProfile,
  relations: Map<string, RobotRelation>,
): void {
  identity.admins = [];
  identity.operators = [];
  identity.guests = [];

  for (const rel of relations.values()) {
    if (rel.role === "admin") {
      identity.admins.push(rel.userId);
    } else if (rel.role === "operator") {
      identity.operators.push(rel.userId);
    } else if (rel.role === "guest") {
      identity.guests.push(rel.userId);
    }
  }
}

/**
 * 从 ClaworksRobotConfig 构建 RobotIdentityProfile 初始值。
 */
export function robotIdentityFromConfig(
  config: ClaworksRobotConfig,
  version: string,
): Partial<RobotIdentityProfile> {
  const r = config.robot ?? {};
  return {
    name: r.name,
    role: r.role ?? "通用助手",
    organization: r.organization,
    domain: r.domain,
    language: r.language ?? "zh-CN",
    auto_learn: r?.auto_learn ?? true,
    proactive: r.proactive ?? true,
    always_greet: true,
    version,
    owner: r.owner_user_id
      ? { userId: r.owner_user_id, name: r.owner_name ?? r.owner_user_id }
      : undefined,
  };
}
