# ClawTwin 文档总索引

> **版本**: v2.2.18 · 2026-05-15（M4 **conflict_resolver**；`DESIGN-FINAL-LOCK` v1.5；MILESTONE v2.6；V4 §四十三 Studio 本体工作台规划）
> **核心文档**: 21 份（已归档历史过渡文档 84 份至 `archive/`）
> **代码真源**: `clawtwin-platform/platform-api/`
> **UI 工作台**: `clawtwin-studio/`

---

## ⭐ 黄金阅读路径（新人必读，按序）

| #   | 文档                                       | 内容                                                                                | 时间   |
| --- | ------------------------------------------ | ----------------------------------------------------------------------------------- | ------ |
| ★   | **`CLAWTWIN-ARCHITECTURE-OVERVIEW.md`**    | **架构总览主文档**：为什么建/是什么/三层 Platform/全接口表/飞轮/ROI（对外对内通用） | 40 min |
| 1   | **`CLAWTWIN-DEFINITIVE-REFERENCE.md`**     | 产品定位·Palantir 4 产品精确映射·三方协作边界·模块拆分论证                          | 15 min |
| 2   | **`CLAWTWIN-SYSTEM-FRAMEWORK.md`**         | 三层架构关系·完整事件流·接口矩阵·Studio设计·扩展机制                                | 20 min |
| 3   | **`CLAWTWIN-INTEGRATION-ARCHITECTURE.md`** | Tesla视角·用户旅程·性能优化蓝图·OpenClaw生态复用                                    | 25 min |
| —   | **`CLAWTWIN-ARCHITECTURE-SYSTEMATIC.md`**  | **系统化关系（纯文字）**：多产品定位·组合·依赖公理·`platform-api` 模块全集          | 25 min |
| 4   | **`INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`**   | API 协议最高权威                                                                    | 30 min |
| 5   | **`CLAWTWIN-RELIABILITY-ARCHITECTURE.md`** | 工业级可靠性七件套                                                                  | 20 min |
| 6   | **`CLAWTWIN-OPERATOR-GUIDE.md`**           | 运营人员完整使用手册（飞书卡片/OpenClaw 速查）                                      | 15 min |
| —   | **`CLAWTWIN-PALANTIR-POSITIONING.md`**     | **对外口径**：按 Palantir Gotham/Foundry/AIP/Apollo 叙述对齐 ClawTwin（售前/高管）  | 12 min |
| —   | **`CLAWTWIN-MULTI-AUDIENCE-NARRATIVE.md`** | **多受众叙事**：高管/用户/技术分层讲解顺序 + Mermaid 层次图（演讲纲领）             | 15 min |

---

## 文档全目录（4 层结构）

### L0 — 产品层（定义是什么、卖给谁）

| 文档                                       | 定位                                                                           | 版本 |
| ------------------------------------------ | ------------------------------------------------------------------------------ | ---- |
| `CLAWTWIN-PRODUCT-VISION.md`               | 产品愿景：三产品家族（Studio=Gotham，Platform=Foundry+AIP+Apollo）             | v2.0 |
| **`CLAWTWIN-ARCHITECTURE-OVERVIEW.md`**    | **架构总览主文档**：方法论·产品定位·Platform 三层·全接口·飞轮·ROI              | v1.0 |
| `CLAWTWIN-PRODUCT-PACKAGING.md`            | 产品包装与销售：4 SKU、能力对照表、销售路径                                    | v1.0 |
| `CLAWTWIN-ENTERPRISE-AI-ARCHITECTURE.md`   | 企业 AI 架构（客户向）：分工图、集成层次、5步交付                              | v1.0 |
| **`CLAWTWIN-PALANTIR-POSITIONING.md`**     | **Palantir 四产品线对外叙事 ↔ ClawTwin**（Gotham/Foundry/AIP/Apollo + Assist） | v1.0 |
| **`CLAWTWIN-MULTI-AUDIENCE-NARRATIVE.md`** | **多受众讲解逻辑**：高管/企业用户/技术的变焦叙事 + 层次结构图（Mermaid）       | v1.0 |
| `CLAWTWIN-OPERATOR-GUIDE.md`               | 运营人员操作指南：三入口·飞书卡片·OpenClaw 速查·L0-L5 体验                     | v1.0 |

### L1 — 架构层（定义怎么造）

| 文档                                      | 定位                                                                            | 版本 |
| ----------------------------------------- | ------------------------------------------------------------------------------- | ---- |
| `CLAWTWIN-DEFINITIVE-REFERENCE.md`        | **决策性参考**：通用平台定位、Palantir 精确映射、资源边界                       | v3.0 |
| **`CLAWTWIN-ARCHITECTURE-SYSTEMATIC.md`** | **系统化架构关系（纯文字）**：多产品定位与组合·依赖公理·`platform-api` 模块全集 | v1.0 |
| `CLAWTWIN-SYSTEM-FRAMEWORK.md`            | **系统框架全景**：三层关系·事件流·接口矩阵·Studio·扩展机制                      | v1.0 |
| `CLAWTWIN-INTEGRATION-ARCHITECTURE.md`    | **深度集成架构**：Tesla视角·三方分工·用户旅程·飞轮·性能蓝图                     | v1.0 |
| `CLAWTWIN-RESOURCE-ARCHITECTURE.md`       | **资源 Registry**：8 类扩展轴·IndustryPack·capability 门控                      | v2.1 |

### L2 — 协议层（定义如何调用）

| 文档                                 | 定位                                                                 | 版本 |
| ------------------------------------ | -------------------------------------------------------------------- | ---- |
| `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md` | **API 协议权威**：Ontology/ObjectType/ActionType/FunctionType/数据流 | v1.0 |
| `DESIGN-FINAL-LOCK.md`               | 端点 + §十六 M4 **conflict_resolver** 脚手架                         | v1.5 |

### L3 — 运营层（定义如何运维和交付）

| 文档                                   | 定位                                                                | 版本 |
| -------------------------------------- | ------------------------------------------------------------------- | ---- |
| `CLAWTWIN-RELIABILITY-ARCHITECTURE.md` | **可靠性全景**：Doctor/Health/Outbox/RateLimit/ReloadPlan/去重/用量 | v2.0 |
| `CLAWTWIN-MILESTONE-PLAN.md`           | 交付计划；M4 **conflict_resolver** 脚手架已落                       | v2.6 |
| **`CLAWTWIN-PHASE-A-ACCEPTANCE.md`**   | **Phase A 测试验收**：自动化命令、清单证据映射、手工项、签收表      | v1.0 |

### L4 — 维护层（定义如何跟踪和开发）

| 文档                                              | 定位                                                                                                                                                                                                                                                                                                                                                                          | 版本    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| `CLAWTWIN-SYSTEM-AUDIT-V1.md`                     | **项目状态审计**：完成度·代码问题清单·优先级待办                                                                                                                                                                                                                                                                                                                              | v2.5    |
| `CLAWTWIN-REVIEW-2026-05-13.md`                   | **全面审视报告**：§1–§3 当日批判语境；**§四 Phase A 封板**与里程碑真源对齐                                                                                                                                                                                                                                                                                                    | v1.1    |
| `DESIGN-FINAL-MASTER-INDEX.md`                    | **本索引**                                                                                                                                                                                                                                                                                                                                                                    | v2.2.18 |
| `DEV-QUICKSTART.md`                               | 开发环境搭建（CI：**A full** 仅 PR base = main/master）                                                                                                                                                                                                                                                                                                                       | v1.6    |
| `README.md`                                       | 项目简介                                                                                                                                                                                                                                                                                                                                                                      | —       |
| **`CLAWTWIN-ARCHITECTURE-V4.md` §四十三–§四十七** | **Studio/Workbench/CLI/OpenClaw 深度规划**：产品线批判性审计·Admin Console 内嵌·CLI TUI架构·OpenClaw extensions/ 插件对齐·许可证判断·UI 设计系统                                                                                                                                                                                                                              | v4.8r12 |
| **`CLAWTWIN-ARCHITECTURE-V4.md` §四十八**         | **全产品实现规范（对齐 OpenClaw 内部代码架构）**：M1–M3 实现计划·terminal/ 模块·全 CLI 命令组·Studio HITL/告警/Runs 页·Pack CapabilityBundle·SSE 事件流·ObjectStore 持久化·知识飞轮·OpenClaw extensions/clawtwin 插件完整实现·架构对照表                                                                                                                                      | v4.8r13 |
| **`CLAWTWIN-ARCHITECTURE-V4.md` §四十九**         | **Studio 可扩展架构全面优化**：UiDescriptorDef+register_ui_descriptor·useUiDescriptors() hook·动态 NavRail/Dashboard/HITL Actions·Ant Design 暗色工业主题·STUDIO_ANTD_TOKEN·useSSEStream()·/v1/sse/global 端点·飞书卡片模板注册系统（FeishuCardRegistry+Jinja2）·oilgas Pack 卡片示例·Gotham 对齐差距自查表·可扩展架构全景图                                                  | v4.8r14 |
| **`CLAWTWIN-ARCHITECTURE-V4.md` §五十**           | **CLI 完整实现 + 工程缺口补全**：terminal/模块（palette/table/note/progress/prompt）对标 OpenClaw src/terminal/·clawtwin chat（openclaw tui等价）·clawtwin setup（crestodian等价）·完整命令树（ontology/connector/eval/data/kb扩展）·批评32-38全部解答（Hook fail-safe策略·Playbook DB检查点·Outbox幂等去重·APScheduler SQLite持久化·AgentFunction三层防护·数据生命周期管理） | v4.8r15 |

### 归档（历史价值，不再参考）

```
archive/ — 84 份（79 份历史过渡文档 + 本次新归档 5 份）
新归档（2026-05-13）：
  CLAWTWIN-AI-NATIVE-ARCHITECTURE.md  → 内容已被 INTEGRATION-ARCHITECTURE 覆盖
  CLAWTWIN-ARCHITECTURE-REVIEW-FINAL.md → 内容已被 SYSTEM-AUDIT 覆盖
  CLAWTWIN-ENTERPRISE-INTEGRATION.md → 内容已被 ENTERPRISE-AI-ARCHITECTURE 覆盖
  CLAWTWIN-EXTENSION-MANIFESTO.md     → 内容已被 RESOURCE-ARCHITECTURE 覆盖
  CLAWTWIN-AI-FIRST-PRINCIPLES.md     → 并入 DEFINITIVE-REFERENCE 附录
```

---

## 当前架构一句话总结

> ClawTwin 是**通用运营 AI 平台（General Operational AI Platform）**：Studio 是运营人员的业务驾驶舱（=Gotham），Platform 是设备世界的语义内核（=Foundry+AIP+Apollo），OpenClaw 是外部 AI 智能体（=AIP Assist）。三者深度集成，用户从飞书卡片到 Studio 调查到 OpenClaw 对话均可无缝处理运营事件。

---

## 扩展资源快速参考

```
ClawTwin 8 类扩展轴 (对标 OpenClaw PluginRegistry):
  ① ObjectType      — ontology/object_types/*.yaml
  ② ActionType      — ontology/action_types/*.yaml  + handlers/
  ③ FunctionType    — ontology/function_types/*.yaml + handlers/ + ai_model
  ④ Connector       — connectors/*.py (OPC-UA / ERP / CMMS)
  ⑤ Pipeline        — ontology/pipelines/*.yaml
  ⑥ Playbook        — ontology/playbooks/*.yaml
  ⑦ Channel/Sink    — infra/event_dispatcher.py (register_default_sinks)
  ⑧ IndustryPack    — packs/<id>/manifest.yaml (打包①-⑦ + python_module)

MCP 工具分类（OpenClaw 可调用）：
  本体工具   — 来自 ontology ActionType + FunctionType，动态加载
  平台查询   — **5** 个硬编码只读工具（`list_pending_hitl` / `get_alarm_summary` / `get_station_health` / `get_flywheel_summary` / `get_kb_document`）；与 `DESIGN-FINAL-LOCK.md` §1.7 一致
```

---

## 热重载端点一览

| 端点                           | 动作                                            | 对标 OpenClaw              |
| ------------------------------ | ----------------------------------------------- | -------------------------- |
| `POST /v1/admin/reload-config` | 从环境变量 / .env 重载配置，返回 **ReloadPlan** | `GatewayReloadPlan`        |
| `POST /v1/packs/reload`        | 热重载所有 IndustryPack                         | `skills.*` 版本 bump       |
| `GET /v1/doctor/settings`      | 非敏感配置摘要                                  | `doctor.*` methods         |
| `GET /v1/doctor/hooks`         | 列出所有注册 Hook                               | `doctor.*` methods         |
| `GET /v1/capabilities`         | Capability 开关状态                             | `listActiveGatewayMethods` |

---

## 可靠性机制一览（M1.6 完成后）

| 机制                                           | 模块                                                                                                                                                                                                                                                   | 状态                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------- |
| 事务性 Outbox（at-least-once delivery）        | `infra/outbox/` + `workers/outbox_dispatcher.py`                                                                                                                                                                                                       | ✅                     |
| Doctor 自检框架 + 7 内置 check                 | `infra/doctor/`                                                                                                                                                                                                                                        | ✅                     |
| 维度化 Health（多维度 + version）              | `infra/health/`                                                                                                                                                                                                                                        | ✅                     |
| Inbound 事件去重（飞书/Webhook 重试幂等）      | `infra/inbound_dedupe.py`                                                                                                                                                                                                                              | ✅                     |
| AI Token 用量持久化                            | `infra/ai_usage_persist.py`                                                                                                                                                                                                                            | ✅                     |
| AI 函数调用双维限流                            | `infra/rate_limit.AiInvokeRateLimiter`                                                                                                                                                                                                                 | ✅                     |
| ReloadPlan 外科手术式热重载                    | `infra/settings.ReloadPlan`                                                                                                                                                                                                                            | ✅                     |
| Extension Registry 版本化缓存失效              | `core/extension_registry._Registry.registry_version`                                                                                                                                                                                                   | ✅                     |
| IndustryPack Python 贡献点                     | `core/pack_loader/python_contributions.py`                                                                                                                                                                                                             | ✅                     |
| OPC-UA Collector Worker                        | `workers/opcua_collector.py`                                                                                                                                                                                                                           | ✅                     |
| 优雅关闭 SIGTERM/SIGINT                        | `infra/lifecycle.py`                                                                                                                                                                                                                                   | ✅                     |
| Hook 系统                                      | `infra/hooks.py`                                                                                                                                                                                                                                       | ✅                     |
| last-known-good 配置回退                       | `infra/settings.reload_settings()`                                                                                                                                                                                                                     | ✅                     |
| Feishu 交互式 HITL 审批卡片                    | `infra/feishu_card.py` + `feishu_webhook.py`                                                                                                                                                                                                           | ✅ 🆕                  |
| LLM 结果短 TTL 缓存                            | `core/function_executor/ai_cache.py`                                                                                                                                                                                                                   | ✅ 🆕                  |
| FunctionType model_preference fast/smart 路由  | `ai_runner._resolve_model()`                                                                                                                                                                                                                           | ✅ 🆕                  |
| Worker 进程内心跳                              | `infra/heartbeat.py` + `scheduler` / `outbox_dispatcher` 打点；Health 维度 **`outbox_dispatcher`**；Doctor **`outbox_dispatcher.alive`**                                                                                                               | ✅ M1.7                |
| DB 表 `worker_heartbeats`（跨进程/重启可观测） | `alembic` 015 + `infra/db/worker_heartbeat_db`（`monitored_worker_components()`：**OPC-UA 开启时纳入 `opcua_collector`**）；`CLAWTWIN_WORKER_HEARTBEAT_DB=1` 时镜像 `beat()`；Doctor **`worker_heartbeats.fresh`** + Health **`worker_heartbeats_db`** | ✅ M2 基线（可选开启） |
| 运维 CLI **`clawtwin start`**                  | `pyproject` **`clawtwin`** 入口 + `uvicorn` 加载 **`apps.http.main:app`**（与直接 uvicorn 等价；内嵌 worker 线程仍由 main 拉起）                                                                                                                       | ✅ M2                  |

**M1.7 已闭环**：`create_work_order` 本体+处理器、HITL reject 与 `cancel_run` 统一、Outbox 渠道 Feishu 卡片路由、MCP 查询 ORM、`DEV-QUICKSTART` 飞书 URL/secret。**`clawtwin start`**（M2）见上表。孤儿模块（lineage/marking 等）仍为 Phase B/C 预留，不阻塞 Phase A。

---

## 架构自洽性约束（不应违反）

1. **单一事件总线**：所有 PlatformEvent 经 `infra/event_dispatcher.dispatch()`，不得自行直接 I/O。
2. **本体优先**：任何新 ObjectType/ActionType 先在 YAML 声明，不直接写硬编码路由。
3. **Capability 门控**：每个可选功能必须有对应 Capability；未开启时路由不挂载。
4. **Pack 隔离**：Pack 代码只通过 `infra.hooks`、注册函数访问平台核心。
5. **Outbox 底盘**：任何需要外部可靠投递的消息必须走 `infra/outbox`，不允许直接 HTTP 投递。
6. **Platform 无 AI 推理**：Platform 只做确定性函数（FunctionType），复杂推理委托给 OpenClaw AgentRuntime。

---

## 文档变更检查表（每次架构改动必选）

| 改了什么          | 必须同步的文档                                                       |
| ----------------- | -------------------------------------------------------------------- |
| 新增 HTTP 端点    | `DESIGN-FINAL-LOCK.md` + 本索引「热重载」表（如适用）                |
| 新增 Capability   | `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md` + `CLAWTWIN-SYSTEM-AUDIT-V1.md` |
| 新增可靠性机制    | `CLAWTWIN-RELIABILITY-ARCHITECTURE.md` + 本索引可靠性表              |
| 新增/完成代码模块 | `CLAWTWIN-SYSTEM-AUDIT-V1.md` + `CLAWTWIN-MILESTONE-PLAN.md`         |
| 里程碑完成/调整   | `CLAWTWIN-MILESTONE-PLAN.md` + `CLAWTWIN-SYSTEM-AUDIT-V1.md`         |
| 架构根本性变更    | `CLAWTWIN-DEFINITIVE-REFERENCE.md` + 本索引自洽性约束                |

---

_本索引每次架构变更同步更新。历史变更见 git log。_
