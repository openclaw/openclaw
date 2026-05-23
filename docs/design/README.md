# ClaWorks 设计文档索引

**真源优先级**：`IMPLEMENTATION-STATUS.md`（代码对照）> `CORE-ARCHITECTURE-GUIDE.md`（模块/逻辑）> `ARCHITECTURE.md`（总纲）

---

## 入门（先读）

| 文档                                                           | 读者      | 用途                                   |
| -------------------------------------------------------------- | --------- | -------------------------------------- |
| [PRODUCT-COMPLETION.md](./PRODUCT-COMPLETION.md)               | 所有人    | **核心是否开发完毕**、Phase 8 生态阶段 |
| [ECOSYSTEM-EXTENSION-GUIDE.md](./ECOSYSTEM-EXTENSION-GUIDE.md) | 用户/伙伴 | **如何使用、如何扩展**（含范例）       |
| [CORE-ARCHITECTURE-GUIDE.md](./CORE-ARCHITECTURE-GUIDE.md)     | 架构师    | 模块地图、事件链、业务逻辑             |
| [../../QUICKSTART.md](../../QUICKSTART.md)                     | 运维      | 10 分钟部署                            |

---

## 架构与实现

| 文档                                                   | 用途                              |
| ------------------------------------------------------ | --------------------------------- |
| [IMPLEMENTATION-STATUS.md](./IMPLEMENTATION-STATUS.md) | 设计 ↔ 代码、Phase、验证命令      |
| [ARCHITECTURE.md](./ARCHITECTURE.md)                   | 分层、Ingress/RBAC、OpenClaw 共存 |
| [DIRECTORY-LAYOUT.md](./DIRECTORY-LAYOUT.md)           | **本仓磁盘布局真源**              |
| [REPO-STRUCTURE.md](./REPO-STRUCTURE.md)               | 三仓边界                          |
| [ECOSYSTEM-LAYOUT.md](./ECOSYSTEM-LAYOUT.md)           | 五仓 Projects 布局                |
| [API-SPEC.md](./API-SPEC.md)                           | REST `/v1/*`                      |
| [CW-TOOLS-MATRIX.md](./CW-TOOLS-MATRIX.md)             | cw\_\* 工具（22 远程 / 48 宿主）  |
| [RUNTIME-PACKAGE.md](./RUNTIME-PACKAGE.md)             | `@claworks/runtime` 包            |
| [EXTERNAL-EXTENSION.md](./EXTERNAL-EXTENSION.md)       | openclaw-claworks-extension 仓    |

---

## 生态扩展（当前主线）

| 文档                                                           | 用途                               |
| -------------------------------------------------------------- | ---------------------------------- |
| [ECOSYSTEM-EXTENSION-GUIDE.md](./ECOSYSTEM-EXTENSION-GUIDE.md) | Pack / Connector / 垂直 ISV / REST |
| sibling `claworks-packs/PACK_DEVELOPMENT.md`                   | Pack 开发细节                      |
| [NEXUS.md](./NEXUS.md)                                         | Pack 注册与安装                    |
| [BUSINESS-GENERAL-PLAN.md](./BUSINESS-GENERAL-PLAN.md)         | enterprise-general                 |
| [BUSINESS-CLOSED-LOOP.md](./BUSINESS-CLOSED-LOOP.md)           | 闭环验证                           |

---

## 部署与运维

| 文档                                                 | 用途                   |
| ---------------------------------------------------- | ---------------------- |
| [CONFIG-SCHEMA.md](./CONFIG-SCHEMA.md)               | claworks.json          |
| [PRODUCTION-READINESS.md](./PRODUCTION-READINESS.md) | 生产加固               |
| [../../DEPLOYMENT.md](../../DEPLOYMENT.md)           | 部署说明               |
| [../LOCAL-GIT.md](../LOCAL-GIT.md)                   | 本地 Git / bundle 备份 |

---

## 规划与迁移（参考）

| 文档                                                       | 用途                       |
| ---------------------------------------------------------- | -------------------------- |
| [ROADMAP.md](./ROADMAP.md)                                 | 里程碑（Phase 0–7 已完成） |
| [MIGRATION-GUIDE.md](./MIGRATION-GUIDE.md)                 | Python → TS 概念           |
| [UPSTREAM-SYNC.md](./UPSTREAM-SYNC.md)                     | OpenClaw 上游同步          |
| [REBRAND-TO-CLAWORKS.md](./REBRAND-TO-CLAWORKS.md)         | 品牌迁移（**最后**）       |
| [POSTGRES-MIGRATION-PATH.md](./POSTGRES-MIGRATION-PATH.md) | PG（部分）                 |
| [VECTOR-KB.md](./VECTOR-KB.md)                             | 向量 KB（未实现）          |

---

## 远景叙事（只读，非实现依据）

`legacy-from-openclaw/industrial-oilgas-skills/` — ClawTwin 时代文档，见索引表于旧版 README 或 `DESIGN-FINAL-MASTER-INDEX.md`。

---

## 文档维护规则

1. **改 API/行为** → 代码 + 测试 → `IMPLEMENTATION-STATUS.md` + `API-SPEC.md`
2. **生态新范例** → `ECOSYSTEM-EXTENSION-GUIDE.md`
3. **Pack 真源** → `../claworks-packs/`，不在 `contrib/packs/` 写 YAML
4. **不要**在 `legacy-from-openclaw/` 新增实现级文档
