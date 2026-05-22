# ClaWorks 设计文档索引

**真源优先级**：`IMPLEMENTATION-STATUS.md`（代码对照）> `ARCHITECTURE.md`（架构）> 其余设计文档。

---

## 现行有效（与 TS 实现对齐）

| 文档                                                   | 用途                                                 | 何时读              |
| ------------------------------------------------------ | ---------------------------------------------------- | ------------------- |
| [IMPLEMENTATION-STATUS.md](./IMPLEMENTATION-STATUS.md) | 设计 ↔ 代码对照、Phase 状态、MCP 工具清单            | **改代码前/验收时** |
| [ARCHITECTURE.md](./ARCHITECTURE.md)                   | 分层、Ingress/RBAC、三平面、OpenClaw 共存            | 架构决策            |
| [REPO-STRUCTURE.md](./REPO-STRUCTURE.md)               | 三仓边界、目录约定                                   | 新建模块/包         |
| [API-SPEC.md](./API-SPEC.md)                           | REST `/v1/*` 契约                                    | HTTP 接口           |
| [CONFIG-SCHEMA.md](./CONFIG-SCHEMA.md)                 | `claworks.json` 配置                                 | 部署/运维           |
| [CW-TOOLS-MATRIX.md](./CW-TOOLS-MATRIX.md)             | `cw_*` 工具矩阵                                      | 插件/集成           |
| [RUNTIME-PACKAGE.md](./RUNTIME-PACKAGE.md)             | `@claworks/runtime` 包结构                           | runtime 开发        |
| [EXTERNAL-EXTENSION.md](./EXTERNAL-EXTENSION.md)       | 官方 OpenClaw 桥接外仓                               | extension 仓        |
| [MIGRATION-GUIDE.md](./MIGRATION-GUIDE.md)             | Python → TS 概念映射                                 | 迁 pack/YAML        |
| [UPSTREAM-SYNC.md](./UPSTREAM-SYNC.md)                 | OpenClaw 上游同步                                    | merge upstream      |
| [ROADMAP.md](./ROADMAP.md)                             | 里程碑（历史 □ 清单，以 IMPLEMENTATION-STATUS 为准） | 规划参考            |

## 产品与业务扩展

| 文档                                                       | 用途                    |
| ---------------------------------------------------------- | ----------------------- |
| [BUSINESS-GENERAL-PLAN.md](./BUSINESS-GENERAL-PLAN.md)     | enterprise-general Pack |
| [BUSINESS-CLOSED-LOOP.md](./BUSINESS-CLOSED-LOOP.md)       | 业务闭环叙事            |
| [PERSONAL-ENTERPRISE.md](./PERSONAL-ENTERPRISE.md)         | 个人/企业双模           |
| [PRODUCT-PROFILE.md](./PRODUCT-PROFILE.md)                 | 产品画像                |
| [PHASED-ROLLOUT.md](./PHASED-ROLLOUT.md)                   | 分阶段 rollout          |
| [STANDALONE-RUN.md](./STANDALONE-RUN.md)                   | 独立运行模式            |
| [POSTGRES-MIGRATION-PATH.md](./POSTGRES-MIGRATION-PATH.md) | PG 迁移路径             |
| [VECTOR-KB.md](./VECTOR-KB.md)                             | 向量 KB（未实现）       |
| [NEXUS.md](./NEXUS.md)                                     | Pack Nexus 概念         |
| [TS-INTERFACES.md](./TS-INTERFACES.md)                     | TS 接口草案             |
| [FORK-MODIFICATION-PLAN.md](./FORK-MODIFICATION-PLAN.md)   | Fork 改动计划           |
| [EXTENSION-PRUNE.md](./EXTENSION-PRUNE.md)                 | Extension 裁剪          |
| [REBRAND-TO-CLAWORKS.md](./REBRAND-TO-CLAWORKS.md)         | 品牌迁移                |
| [SYSTEM-AUDIT.md](./SYSTEM-AUDIT.md)                       | 系统审计                |
| [PROJECT-BOUNDARY.md](./PROJECT-BOUNDARY.md)               | 三仓边界（运维）        |

## 远景叙事（只读参考，非代码真源）

从旧 ClawTwin 时代保留、**概念仍有用**的文档（ontology 思想、工业场景、Palantir 对标）：

| 文档                     | 路径                                                                             |
| ------------------------ | -------------------------------------------------------------------------------- |
| 产品定位与 Palantir 映射 | `legacy-from-openclaw/industrial-oilgas-skills/CLAWTWIN-DEFINITIVE-REFERENCE.md` |
| 架构总览（对外叙事）     | `.../CLAWTWIN-ARCHITECTURE-OVERVIEW.md`                                          |
| Ontology/Action 协议思想 | `.../INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`                                         |
| 可靠性设计模式           | `.../CLAWTWIN-RELIABILITY-ARCHITECTURE.md`                                       |
| 运营手册（飞书/HITL）    | `.../CLAWTWIN-OPERATOR-GUIDE.md`                                                 |

## 已废弃（勿作实现依据）

| 类别                    | 位置                                                     | 说明                                  |
| ----------------------- | -------------------------------------------------------- | ------------------------------------- |
| Python 后端时代         | `legacy-from-openclaw/industrial-oilgas-skills/`         | 指向已归档的 `clawtwin-platform`      |
| 架构 V2/V3 迭代稿       | `.../archive/` + 根目录 `CLAWTWIN-ARCHITECTURE-V2/V3.md` | 已被 `ARCHITECTURE.md` 取代           |
| Studio/CLI Python 规划  | `CLAWTWIN-ARCHITECTURE-V4.md` §48–50                     | 目标已改为 TS `@claworks/runtime`     |
| DEV-QUICKSTART 多仓布局 | `DEV-QUICKSTART.md`                                      | 引用 clawtwin-platform/studio，已过时 |
| 演示/白标示例           | `legacy-from-openclaw/contrib/examples/`                 | 配置片段参考，非产品代码              |

完整旧索引（历史）：`legacy-from-openclaw/industrial-oilgas-skills/DESIGN-FINAL-MASTER-INDEX.md`

---

## 文档维护规则

1. **改 API/行为** → 先改代码与测试，再更新 `IMPLEMENTATION-STATUS.md` + `API-SPEC.md`。
2. **不要**在 `legacy-from-openclaw/` 下新增实现级文档。
3. **Pack YAML 真源** → `../claworks-packs/`（含分层 core/comms/… 与 classic base/enterprise-\*）。
