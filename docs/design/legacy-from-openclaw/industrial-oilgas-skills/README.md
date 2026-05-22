# ClawTwin — AI 原生工业数字孪生平台

## 石油天然气行业智能化解决方案

> **OpenClaw 接线（权威，本仓库）**：只启用 **`claworks`** 插件与 **`cw_*`** 工具；见 **`contrib/examples/claworks-canonical-guide.zh.md`** 与 **`docs/plugins/claworks-integration.md`**。勿按本文旧 Skills 表单独接 `twin_*` / 自建 MCP 挂载。

> **2026-05-11 导航更新**：实现契约与 **API 终态** 以 **`DESIGN-FINAL-MASTER-INDEX.md`** → **`DESIGN-FINAL-LOCK.md` §一** → **`DEVELOPMENT-CONTRACT.md`** 为准。  
> 历史文档中的 `/v1/objects/*`、`/v1/tools/*`（Studio 用户 JWT）已废弃；OpenClaw **Skills** 使用 Service Token + **`/v1/equipment/*`**、**`GET /v1/kb/search`**、**`POST /v1/workorders/ai-draft`** 等锁定路径。  
> **实现状态（本仓库内）**: `clawtwin-project/IMPLEMENTATION-STATUS.md` · **Platform 脚手架**: `platform-api/README.md`

> **当前状态**：Phase A 开发中（2026-05）
> **架构版本**：V2（定稿，所有早期文档已由 V2 取代）

---

## 核心文档导航（V2 定稿版，以下两个文档优先读）

| 文档                                                 | 内容                                                                  | 读者         |
| ---------------------------------------------------- | --------------------------------------------------------------------- | ------------ |
| **[CLAWTWIN-MASTER-V2.md](./CLAWTWIN-MASTER-V2.md)** | 权威架构定稿：物理部署、组件全图、安全模型、技术栈、集成架构、UI 结构 | 开发、架构师 |
| **[PRODUCT-PLAN-V2.md](./PRODUCT-PLAN-V2.md)**       | 产品规划：三个核心产品、竞争定位、三期执行计划、资源配置、成功标准    | 产品、管理   |

---

## 架构决策记录（ADR，按优先级读）

| ADR                                                                      | 核心决策                                                            |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| [ADR-6](./ADR-6-SECURITY-ARCHITECTURE.md)                                | 安全架构：零信任、ABAC、Webhook 签名、审计日志、防 Prompt 注入      |
| [ADR-7](./ADR-7-IMS-AUTH-AND-OPENCLAW-DEPLOYMENT.md)                     | IMS 集成 + OpenClaw 粒度：Platform 是 IMS 网关，OpenClaw 是团队粒度 |
| [ADR-5](./ADR-5-FEISHU-DEPLOYMENT-AND-GATEWAY.md)                        | 飞书集成：两通道架构，私有化适配，OpenClaw 部署模型纠正             |
| [ADR-4](./ADR-4-SKILL-DESIGN-AND-REVIEW.md)                              | Skills 设计原则：能力/方法导向（4个），不按岗位设计                 |
| [ADR-2](./ADR-2-PLATFORM-BOUNDARY.md)                                    | Platform 边界：我们的代码 vs 外部产品（OpenClaw/vLLM）              |
| [PRODUCTION-ARCHITECTURE-REVIEW.md](./PRODUCTION-ARCHITECTURE-REVIEW.md) | 生产落地：OT/IT 分区、客户交付流程、运维手册                        |

---

## OpenClaw Skills（4 个能力，已完成）

```
industrial-twin/        实时设备状态读取（twin_read 工具）
industrial-kb/          知识检索推理（kb_search 工具，L0-L3 分层）
industrial-workorder/   工单草稿生成（HITL 安全审批流程）
industrial-analytics/   历史趋势分析（MOIRAI 时序 + TimescaleDB）
industrial-simulation/  [Phase C 占位] 物理仿真代理（pandapipes + FNO）
```

---

## 开发参考（模块设计，按功能查）

| 文档                                                         | 用途                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| **[MODULE-DESIGN-PLATFORM.md](./MODULE-DESIGN-PLATFORM.md)** | Platform 模块设计：文件结构、DB Schema、所有 API 接口契约、鉴权实现、main.py、知识摄入 Pipeline、Scheduler 任务 |
| **[MODULE-DESIGN-STUDIO.md](./MODULE-DESIGN-STUDIO.md)**     | Studio 模块设计：组件树、状态管理、useEquipment hook、AI 快捷操作、CommandPage、KnowledgePage、Babylon.js 要点  |
| **[OPCUA-BRIDGE-DESIGN.md](./OPCUA-BRIDGE-DESIGN.md)**       | OPC-UA Bridge 详细设计：DMZ 边界组件、节点映射、Kafka 消息格式、Mock 服务器、生产安全要求                       |
| **[PHASE-A-RUNBOOK.md](./PHASE-A-RUNBOOK.md)**               | Phase A 8 周开发 Runbook：每周任务清单 + 验收命令 + 常见坑解决方法 + 每日 PR 检查清单                           |
| **[OPENCLAW-SETUP-GUIDE.md](./OPENCLAW-SETUP-GUIDE.md)**     | OpenClaw 安装 + Skills 配置 + 飞书接入 + Service Token 生成 + 用户绑定流程                                      |
| **[clawtwin-project/SKILL.md](./clawtwin-project/SKILL.md)** | 开发引导 Skill：架构铁律 10 条、PR 检查清单、历史错误、分歧解决流程                                             |
| [PHASE-A-SCAFFOLD.md](./PHASE-A-SCAFFOLD.md)                 | Phase A 代码脚手架：docker-compose（分 Profile）、飞书 Webhook、Studio 路由                                     |
| [INTEGRATION-AND-GAPS.md](./INTEGRATION-AND-GAPS.md)         | 集成架构详述 + 功能空白清单（含填补方案）                                                                       |

---

## 技术栈速查

```
后端：       Python 3.12 / FastAPI / PostgreSQL+TimescaleDB + **pgvector**（Phase A）
AI 推理：    vLLM + Qwen 系（OpenAI-compatible）/ MOIRAI（深度集成多 Phase B/C）
知识：       **pgvector**（L0–L3，layer 过滤；铁律 20）/ GraphRAG（Phase B+）
孪生：       Phase A 本体+API；**Kafka + Eclipse Ditto** 为 Phase B/C 按需；asyncua（OPC-UA Bridge DMZ）
前端：       React + Babylon.js（3D Phase B+）/ Studio 栈见 MODULE-DESIGN-STUDIO
部署：       Docker Compose + Ansible（单站；多站 Ansible 管理）
安全：       Zero Trust / JWT / ABAC / 审计日志
```

---

## ⚠️ 已废弃文档（请勿参考）

以下文档包含已被纠正的架构决策，仅作历史参考：

```
ARCH_DECISION_RECORD.md      → 已由 ADR-2 至 ADR-7 取代
FINAL_ARCHITECTURE.md        → 已由 CLAWTWIN-MASTER-V2.md 取代
FINAL_DEVELOPMENT_PLAN.md    → 已由 PRODUCT-PLAN-V2.md 取代
FINAL_PRODUCT_PLAN.md        → 已由 PRODUCT-PLAN-V2.md 取代
ENTERPRISE_ARCHITECTURE_COMPLETE.md → 已由 CLAWTWIN-MASTER-V2.md 取代
INDUSTRIAL_BRAIN_MASTER.md   → 已由 CLAWTWIN-MASTER-V2.md 取代
MASTER_PRODUCT_STRATEGY.md   → 已由 PRODUCT-PLAN-V2.md 取代
TECH_DECISIONS.md            → 已由 CLAWTWIN-MASTER-V2.md §3.2 取代
```
