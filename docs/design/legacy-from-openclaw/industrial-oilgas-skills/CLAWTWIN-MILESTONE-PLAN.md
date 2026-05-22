# ClawTwin 里程碑规划（v2.6）

> **版本**：v2.6 · 2026-05-14（M4：`conflict_resolver` 脚手架；**Phase C** 增量启动）
> **依据**：`CLAWTWIN-REVIEW-2026-05-13.md` 综合审视结论
> **性质**：可执行的交付计划，而非愿景罗列

---

## 战略定位（一句话）

> ClawTwin 是 **工业运营 AI 协作层**：介于 OT 控制系统（L1-L2）与企业管理系统（L3-L4）之间，将现场语义化、将决策 AI 化、将干预闭环化。Studio 对齐 Palantir Gotham，Platform 对齐 Foundry+AIP+Apollo，OpenClaw 是外部 AI 智能体（对齐 AIP Assist）。

---

## 里程碑总览

```
Phase A（已完成）── M0 → M1 → M1.5 → M1.6 → M1.7：工业级骨架 + 运营闭环（`platform-api` 交付认定）
Phase B（代码侧 M2–M3 已由 `platform-api` 门禁覆盖）── M2 → M3：真实数据接入 + 智能飞轮；合并门禁：`platform-api/scripts/phase_b_acceptance.sh`
Phase C（长期）    ── M4 → M5 → M6：企业集成 + Studio UI + 多站点

时间轴：
M0   ✅ 已完成 ──── 核心平台基础设施
M1   ✅ 已完成 ──── 运营卓越基础（Doctor / Health / Outbox / Hook / CLI）
M1.5 ✅ 已完成 ──── 运营卓越增强（去重 / 用量 / 限流 / ReloadPlan / Pack 贡献点 / OPC-UA Worker）
M1.6 ✅ 已完成 ──── 用户体验完善（Feishu 交互卡片 / LLM 缓存 / model_preference / MCP 平台工具）
M1.7 ✅ 已完成 ──── 技术债清零（create_work_order / heartbeat / cancel 统一 / outbox Feishu / MCP ORM / 文档）
M2   🎯 Phase B ─── 真实数据接入（OPC-UA 端到端加压验收；Modbus / CMMS / Connector Manager 等）；**pytest 子集**：`platform-api/scripts/m2_acceptance.sh`
M3   🎯 Phase B 代码路径 ── 智能飞轮（诊断/CBR/pgvector/ KB revision / MCP×5 / 置信度门 / 飞轮草案）；**pytest 子集**：`platform-api/scripts/m3_smoke.sh`（人工验收：**60 天**周期内的准确率/时延 KPI 仍环境依赖）
M4   ⏳ 90 天 ───── 企业集成（双向 ERP/MES）
M5   ⏳ 120 天 ──── Studio UI + 自主驾驶升级
M6   ⏳ 长期 ─────── 多站点 / 边缘 / 基础模型对接
```

---

## Phase A 目标（重校）

**Phase A（M0–M1.7 + 验收所需的运营闭环）已在本仓库 `platform-api` 代码侧闭环**：工业级骨架、Feishu HITL 卡片路径、Outbox 可靠投递、Doctor/Health、MCP 运营查询、`clawtwin start`、可选 DB 镜像 **`worker_heartbeats`**、**`POST /v1/webhooks/dispatch`** 真实入队等均已落地。

**下一阶段 Phase B** 以 **M2** 为起点：OPC-UA/Modbus 等连接器深化、Connector Manager、全链路加压验收（见下方 M2 表）。

Phase A 结束时，可以宣称：

- ✅ IndustryPack 作者可在不修改平台核心的情况下扩展系统
- ✅ 运维团队有足够可观测性和可控性工具（Doctor/Health/Outbox）
- ✅ 一个真实站点接上 OPC-UA 模拟器数据后，端到端链路可验证
- ✅ AI 诊断可运行（fast/smart 模型路由 + 缓存）
- ✅ Feishu 内联 HITL 审批：报警 → 飞书交互卡片 → 一键批准 → Playbook 继续
- ✅ Playbook **`notification`** 步骤（Feishu）：`playbook_run.notification` → 与 HITL 相同的 channel Outbox 链（非直连 `get_notifier`）
- ✅ OpenClaw 可通过 MCP 查询运营状态（待审批/报警摘要/站场健康）

**Phase A 不做的事**（以避免范围蔓延）：

- ❌ 生产级 Studio UI（M5 交付）
- ❌ 真实 ERP/CMMS 集成（M4/C）
- ❌ 自动化 AI 标注和向量检索（M3 目标）
- ❌ 多站点部署（M6 目标）
- ❌ ClawTwin 注册为 OpenClaw 官方 Plugin（Phase B）

### Phase A 验收清单（优化版，执行用）

在宣称 Phase A（M0–M1.7）代码侧闭环前，建议逐项勾选：

| #   | 验收项                                                                              | 验证方式 / 真源                                                                       |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 1   | 单列 `dispatch(PlatformEvent)` 进村                                                 | `infra/event_dispatcher.py`；新事件类型先入 `_KNOWN_TYPES`                            |
| 2   | Feishu HITL：卡片 + webhook resume/cancel                                           | `infra/feishu_card.py`、`feishu_webhook`、Playbook `waiting_for_human`                |
| 3   | Feishu Outbox：`target_kind=channel` 入队 + 重试走 `fanout_feishu_channel_delivery` | `infra/feishu_channel_outbox.py`、`workers/outbox_dispatcher.py` 的 `handled_types`   |
| 4   | Playbook `notification`（Feishu）与同链                                             | `playbook_run.notification` → `_FeishuSink` / Outbox；**不**在 executor 内直连 Feishu |
| 5   | Webhook Outbox 写入提交                                                             | `_WebhookOutboxSink` 路径 `session.commit()`                                          |
| 6   | `POST /v1/webhooks/dispatch` 真实入队                                               | 响应体与 DB `webhook_outbox` 一致                                                     |
| 7   | `clawtwin start` 与 worker 生命周期                                                 | `apps/cli`、`apps/http/main.py` lifespan                                              |
| 8   | Doctor / Health / 可选 `worker_heartbeats`                                          | `CLAWTWIN_WORKER_HEARTBEAT_DB`、OPC-UA 门控等                                         |
| 9   | MCP 平台工具（只读运营查询）                                                        | Phase A ≥3；**Phase B / M3：5**（见 `DESIGN-FINAL-LOCK` §1.7 B）                      |
| 10  | 审视稿 P0：create_work_order、无 handler 报错、reject→`cancel_run`                  | `CLAWTWIN-REVIEW-2026-05-13.md` §2.x                                                  |

### Phase A 验收执行记录（启动测试验收时填写）

| 批次 | 日期       | `uv run pytest tests/`    | 记录                                                        |
| ---- | ---------- | ------------------------- | ----------------------------------------------------------- |
| 首签 | 2026-05-13 | **377 passed**, 2 skipped | 见 `CLAWTWIN-PHASE-A-ACCEPTANCE.md` §1–§2                   |
| 可选 | 2026-05-13 | **378 passed**, 1 skipped | `./scripts/phase_a_acceptance.sh --full`（linkml + casbin） |

**权威验收包**：`contrib/industrial-oilgas-skills/CLAWTWIN-PHASE-A-ACCEPTANCE.md` + `clawtwin-platform/platform-api/scripts/phase_a_acceptance.sh`。

---

## M0：核心平台基础设施（✅ 已完成）

**目标**：系统可运行，所有核心抽象已就位

### 完成清单

| 模块                                                    | 实现 | 文件                                             |
| ------------------------------------------------------- | ---- | ------------------------------------------------ |
| Ontology（ObjectType/ActionType/FunctionType/LinkType） | ✅   | `ontology/loader.py` + `ontology/registry.py`    |
| ObjectStore（load/save/query/delete）                   | ✅   | `core/object_store/`                             |
| EventDispatcher（SSE/Webhook/Feishu/Playbook 扇出）     | ✅   | `infra/event_dispatcher.py`                      |
| 事务性 Outbox + Dispatcher Worker                       | ✅   | `infra/outbox/` + `workers/outbox_dispatcher.py` |
| Capability 门控系统                                     | ✅   | `infra/capabilities.py`                          |
| 优雅关闭（SIGTERM/SIGINT）                              | ✅   | `infra/lifecycle.py`                             |
| ModelProvider 抽象（OpenAI/Anthropic/Ollama/Stub）      | ✅   | `infra/ai_provider/`                             |
| AgentRuntime 抽象（OpenClaw/Coze/Dify/HiAgent/Stub）    | ✅   | `aip/agent_runtimes/`                            |
| ActionExecutor（effects pipeline + Hook）               | ✅   | `core/action_executor/`                          |
| FunctionExecutor（python_function + ai_model 路径）     | ✅   | `core/function_executor/`                        |
| Playbook Engine（YAML + HITL + Schedule trigger）       | ✅   | `core/playbook_engine/`                          |
| MCP Server（tools/call 真实执行）                       | ✅   | `aip/mcp_server.py`                              |
| IndustryPack 机制（热重载 + 本体合并）                  | ✅   | `core/pack_loader/`                              |
| Doctor / Health 端点                                    | ✅   | `apps/http/routes/doctor.py`                     |
| Extension Registry（8 类资源 + registryVersion）        | ✅   | `core/extension_registry/`                       |
| CBR 推荐引擎                                            | ✅   | `core/domain_logic/`                             |
| OutcomeEvent 飞轮                                       | ✅   | `workers/outcome_collector.py`                   |

---

## M1：运营卓越基础（✅ 已完成）

**目标**：工业级运维体验，参照 OpenClaw 的 doctor/config-reload/graceful-shutdown 机制

| 模块                                      | 实现 | 说明                                                                                 |
| ----------------------------------------- | ---- | ------------------------------------------------------------------------------------ |
| Hook 系统                                 | ✅   | `infra/hooks.py` — before/after action/function/object/event/playbook                |
| 配置验证 + last-known-good 热重载         | ✅   | `infra/settings.py` — 类型化配置 + reload_settings()                                 |
| 管理 CLI                                  | ✅   | `apps/cli/main.py` — `clawtwin start` / status / doctor / config / packs / playbooks |
| 配置 reload HTTP 端点                     | ✅   | `POST /v1/admin/reload-config`                                                       |
| Hook 诊断端点                             | ✅   | `GET /v1/doctor/hooks`                                                               |
| 私有边界修复（×5 处）                     | ✅   | trigger_sink / pack_loader / playbooks / scheduler / executor                        |
| ObjectStore Protocol 补全（query/delete） | ✅   | InMemory + Postgres 双后端                                                           |
| FunctionExecutor ai_model 路径            | ✅   | 连接 ai_runner 同步包装器                                                            |
| ActionExecutor PlatformEvent 自动发射     | ✅   | effects.py + emit_action_event()                                                     |

---

## M1.5：运营卓越增强（✅ 已完成）

**目标**：完成运营卓越所有遗留项；对标 OpenClaw 深度源码精读的对应实现

| 模块                               | 实现                                                   | 对标 OpenClaw                                 |
| ---------------------------------- | ------------------------------------------------------ | --------------------------------------------- |
| IndustryPack Python 贡献点         | ✅ `core/pack_loader/python_contributions.py`          | PluginRegistry.httpRoutes + runtimeLifecycles |
| Extension Registry 版本化缓存      | ✅ `_Registry.registry_version`                        | registryVersion                               |
| ReloadPlan 外科手术式热重载        | ✅ `infra/settings.ReloadPlan`                         | GatewayReloadPlan                             |
| OPC-UA Collector Worker            | ✅ `workers/opcua_collector.py`                        | connector-manager.ts                          |
| Pack Router 挂载 + OPC-UA 生命周期 | ✅ `apps/http/main.py`                                 | plugin.httpRoutes 挂载                        |
| 入站事件去重（TTL-LRU 50k/24h）    | ✅ `infra/inbound_dedupe.py`                           | 工业增强（OpenClaw 无对应）                   |
| AI Token 用量持久化                | ✅ `infra/ai_usage_persist.py` + `ai_usage_records` 表 | 工业增强                                      |
| AI 函数调用双维限流                | ✅ `infra/rate_limit.AiInvokeRateLimiter`              | gateway rate limits                           |
| Worker 同步 DB Session             | ✅ `infra/db/session.get_sync_session()`               | 工程质量                                      |
| Feishu 凭据热重载接口              | ✅ `infra/feishu_client.reinit_feishu_client()`        | channel credential refresh                    |

---

## M1.6：用户体验完善（✅ 已完成）

**目标**：Feishu 内联 HITL 审批全链路可工作；OpenClaw 可真正代理运营查询；AI 成本可控

| 模块                          | 实现                                         | 对标 / 说明                                                |
| ----------------------------- | -------------------------------------------- | ---------------------------------------------------------- |
| Feishu 交互卡片构建器         | ✅ `infra/feishu_card.py`                    | HMAC-SHA256 签名防伪造，10 分钟有效期                      |
| card.action.trigger 真实处理  | ✅ `feishu_webhook.py` 升级                  | 从 Phase A stub → 真实 HITL 驱动                           |
| PlaybookExecutor.cancel_run() | ✅ `core/playbook_engine/executor.py`        | 飞书拒绝 → Playbook 取消                                   |
| HITL 事件 payload 增强        | ✅ `executor._dispatch_event`                | 携带 display_name + ai_summary + confidence                |
| \_FeishuSink 交互卡片路由     | ✅ `infra/event_dispatcher.py`               | HITL → 卡片，alarm P1/P2 → 富文本卡片                      |
| NotifierProtocol.send_card()  | ✅ `providers/notifier.py`                   | Protocol 升级 + stub 实现                                  |
| LLM 结果短 TTL 缓存           | ✅ `core/function_executor/ai_cache.py`      | LRU 512 条，60s TTL，SHA256 键                             |
| ai_runner 缓存集成            | ✅ `ai_runner.run_completion()`              | 命中缓存时跳过 provider 调用                               |
| FunctionType model_preference | ✅ `ai_runner._resolve_model()`              | fast→gpt-4o-mini，smart→gpt-4o                             |
| MCP 平台查询工具 x3           | ✅ `aip/mcp_server._PLATFORM_QUERY_TOOLS`    | list_pending_hitl / get_alarm_summary / get_station_health |
| MCP HTTP 路由器集成           | ✅ `apps/http/routes/mcp_http._execute_tool` | 平台工具与本体工具统一路由                                 |
| 运营人员操作指南              | ✅ `CLAWTWIN-OPERATOR-GUIDE.md`              | 三入口分工·旅程图·OpenClaw 速查                            |

**用户体验提升**：HITL 审批旅程从 4 分钟/5 步跳转 → 30 秒/飞书一键点击。

---

## M1.7：技术债清零（✅ 已完成）

**目标**：修复全面审视（CLAWTWIN-REVIEW-2026-05-13.md）发现的系统性问题

| 问题                             | 修复项                                                                                                                                                                                                                           | 状态                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 工单 Action 缺失 / stub 静默成功 | `ontology/action_types/create_work_order.yaml` + `handlers/create_work_order.py`；ExtensionRegistry 中 `dispatch_workorder` 已替换为 **`create_work_order`**；无 handler 的 Action **直接报错**                                  | ✅                                                            |
| Outbox 渠道仍纯文本              | `_deliver_channel` 对 HITL/alarm/workorder.created 调用 `fanout_feishu_channel_delivery`                                                                                                                                         | ✅                                                            |
| reject 双路径                    | `playbooks.reject_hitl_run` → 后台 `PlaybookExecutor.cancel_run()`；cancel 时 `_try_fail_waiting_hitl_steps`                                                                                                                     | ✅                                                            |
| heartbeat 缺失                   | `infra/heartbeat.py` + scheduler / outbox_dispatcher `beat()`；Health **outbox_dispatcher** 维度 + Doctor **outbox_dispatcher.alive**                                                                                            | ✅                                                            |
| 飞书卡片 URL / secret 文档       | `platform-api/README.md` §Feishu bot；历史 `DEV-QUICKSTART.md` 说明仍可参考                                                                                                                                                      | ✅                                                            |
| `_FeishuSink` + Outbox 对齐      | HITL/高优告警/高优工单/`playbook_run.notification`：`dispatch()` → **`feishu_channel_outbox`** → **`OutboxDispatcher`**；`fanout_feishu_channel_delivery` → **`deliver_immediately`**（防递归）；**`_WebhookOutboxSink` commit** | ✅                                                            |
| MCP `NOW()` 方言                 | `get_alarm_summary` / `get_station_health` 改 ORM                                                                                                                                                                                | ✅                                                            |
| 孤儿模块                         | 仍属 Phase B/C 预留（未改行为）                                                                                                                                                                                                  | ⏳ 文档已说明                                                 |
| M2：`worker_heartbeats` 表持久化 | 迁移 015 + `beat()` 可选 DB 镜像 + Doctor/Health；与进程内 heartbeat **并存**                                                                                                                                                    | ✅（默认关闭 DB 镜像；`CLAWTWIN_WORKER_HEARTBEAT_DB=1` 启用） |

---

## M2：真实数据接入（🎯 Phase B：连接器与加压验收）

**目标**：真实 OT 数据流入 ClawTwin，完成第一个端到端全链路验收

### 优先交付

| 模块                  | 说明                                                                                                                                                                                                                                                                                                                               | 依赖                                                              |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| OPC-UA 端到端验收     | OPC-UA 模拟器 → `equipment_readings` → EventDispatcher → Alarm → Playbook                                                                                                                                                                                                                                                          | asyncua                                                           |
| Worker 心跳保活       | **M1.7**：进程内 `infra/heartbeat`；**M2 基线**：表 `worker_heartbeats` + `CLAWTWIN_WORKER_HEARTBEAT_DB` + Doctor `worker_heartbeats.fresh`；**OPC-UA 启用**时 `opcua_collector` 每轮 `beat()` 并纳入 DB 检查                                                                                                                      | 已交付表与检查；生产分离部署时置 `CLAWTWIN_WORKER_HEARTBEAT_DB=1` |
| `clawtwin start` CLI  | **`clawtwin start`**：`uvicorn` + `apps.http.main:app`；scheduler / outbox / OPC-UA 由 main 生命周期拉起（同进程线程，与 `uvicorn … apps.http.main:app` 等价）                                                                                                                                                                     | ✅                                                                |
| Modbus TCP Connector  | pymodbus 读寄存器 → EquipmentReading                                                                                                                                                                                                                                                                                               | pymodbus                                                          |
| CMMS Webhook Inbound  | **`POST /v1/integrations/cmms/failures`** + **`CLAWTWIN_CMMS_WEBHOOK_SECRET`** / **`X-ClawTwin-CMMS-Token`** → **`alarms`**（去重码 `CMMS-{source}-{external_id}` 或自定义 `code`）；新建时 **`alarm.created`** 事件                                                                                                               | 无                                                                |
| Connector Manager API | `GET /v1/connectors/runtime`：进程内 OPC-UA / Modbus 采集器状态；声明式 IMS 目录仍为 `GET /v1/connectors`；**运行时切换仍以环境变量 + 进程重启为准**                                                                                                                                                                               | —                                                                 |
| oilgas Pack 更新      | 默认 **`packs/oilgas/opcua_tags.example.json`**；**`CLAWTWIN_OPCUA_TAGS`** 或 **`CLAWTWIN_OPCUA_TAGS_FILE`**；**`packs/oilgas/modbus_registers.example.json`** → **`CLAWTWIN_MODBUS_MAP`** / **`CLAWTWIN_MODBUS_MAP_FILE`**；**仅** **`CLAWTWIN_MODBUS_ENABLED=1`** 时若无 map 则自动加载 pack 示例（需 `uv sync --extra modbus`） | —                                                                 |

### M2 验收标准（升级版）

**基础验收**：

- 真实设备（或 OPC-UA 模拟器）数据写入 `equipment_readings` 表，持续 30 分钟无中断
- 至少 10 条完整的 Event → Alarm → Playbook → WorkOrder 链路，全部可在审计日志追溯

**HITL 全链路验收**（新增，必须通过）：

- Playbook 到达 HITL 步骤 → 飞书用户收到**交互卡片**（含 AI 诊断摘要和置信度）
- 用户点击"批准" → 飞书 POST 到 ClawTwin → Playbook 继续执行 → 工单创建
- 用户点击"拒绝" → Playbook 取消 → 状态记录正确
- 整个流程可在审计日志中完整追溯

**Worker 可靠性验收**：

- `kill -9 scheduler` 后重启，心跳重置，Doctor 检查无 CRITICAL

### M2 启动清单（Phase B 第 1 个迭代建议顺序）

| #   | 动作                                                                                                               | 目的                                                                                                                                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 固定一条 **PostgreSQL**（或团队基线 DB）+ 跑全量 **Alembic**                                                       | 与生产形态一致，避免 SQLite-only 漏问题                                                                                                                                                                                          |
| 2   | 配置 **OPC-UA 模拟器** + `CLAWTWIN_OPCUA_ENABLED=1` + `CLAWTWIN_OPCUA_TAGS`（或 oilgas 示例 JSON）                 | 验证 `equipment_readings` 持续写入                                                                                                                                                                                               |
| 3   | 打开 **`CLAWTWIN_WORKER_HEARTBEAT_DB=1`**（若多进程/分离部署）                                                     | Doctor/Health 对 worker 存活有 DB 证据                                                                                                                                                                                           |
| 4   | 跑通 **告警规则** `persist` → **Playbook** →（可选）**HITL 飞书** → `create_work_order`                            | 对齐 M2「10 条链路」与 HITL 验收段                                                                                                                                                                                               |
| 5   | 记录一次 **加压 Runbook**（30min 读数 + 审计抽查）                                                                 | 满足 M2 基础验收条                                                                                                                                                                                                               |
| 6   | 运行 **`platform-api/scripts/m2_acceptance.sh`**（可选 **`--full`** / **`--live`**）                               | CI/本地自动化：M2 相关 pytest；`--live` 需 API 已启动并可选探测 `/health` 与 `/v1/connectors/runtime`                                                                                                                            |
| 7   | 运行 **`platform-api/scripts/phase_b_acceptance.sh`**（可选 **`--full`** / **`--live`**，`--live` 仅作用于 M2 段） | **Phase B 合并门禁**：M2 + M3 冒烟 pytest 一次跑完；不替代 §M2 手工加压与 HITL Runbook                                                                                                                                           |
| 8   | （可选）**GitHub Actions** 接 **`clawtwin-platform`** 远程                                                         | **`.github/workflows/platform-api-phase-b.yml`**（M2+M3 子集）与 **`platform-api-phase-a-full.yml`**（**`phase_a_acceptance.sh --full`**）在触及 **`platform-api/**`** 的 PR/push 上运行；见 **`.github/workflows/README.md`\*\* |

**入口文档**：本表 + `CLAWTWIN-PHASE-A-ACCEPTANCE.md` §1 / §3（飞书/真环境手工项）；设计对照 `CLAWTWIN-RELIABILITY-ARCHITECTURE.md`。

---

## M3：智能飞轮（AI 诊断 + 知识库）

**目标**：AI 推荐从可用变为可信，飞轮自动运转

**周期**：60 天（M2 完成后开始）

| 模块                              | 说明                                                                                                                                                                                                                                                  |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- |
| `diagnose_equipment` 真实 AI 诊断 | 读数 + 历史 + KB 片段 → 完整提示 → 结构化结论                                                                                                                                                                                                         |
| KB 知识管理 API                   | CRUD + 分级（L0-L3）+ 版本                                                                                                                                                                                                                            |
| 飞轮自动化 Pipeline               | 已关闭 WorkOrder → `extract_pattern` → KB Draft 自动生成                                                                                                                                                                                              |
| CBR 向量检索                      | 历史案例 embedding 相似度（pgvector）                                                                                                                                                                                                                 |
| OutcomeEvent 统计 Dashboard       | **`GET /v1/reports/outcomes`**：`period`=`24h`/`7d`/`30d`/`all`，按 `outcome_type` / `evaluated_by` 聚合；**`outcome_tracking`** 能力门控（与 `/v1/outcome-events` 一致）                                                                             | 无  |
| 置信度门控                        | FunctionType 可选 YAML 字段 **`confidence_threshold`**（0..1）；**`FunctionExecutor`** 在 `result.confidence` 低于阈值时将 HTTP 外层 **`status`** 置为 **`low_confidence`** 并附带 **`confidence_gate`**（**HITL 自动续跑**仍在 Playbook 层逐步接线） | 无  |
| 种子标注工具                      | CLI `clawtwin kb import <yaml>`                                                                                                                                                                                                                       |

### 验收标准

- 50 条标注 OutcomeEvent 后，CBR 推荐 Top-3 准确率 > 60%
- AI 诊断平均响应 < 8 秒（含上下文构建）
- 每个已关闭 WorkOrder 自动生成一条 KB Draft（等待人工审核）

---

## M4：企业集成（双向 ERP/MES）

**目标**：ClawTwin 成为企业 IT 中可信的数据参与者

**周期**：90 天

| 集成方向                | 说明                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ERP WorkOrder 推送      | 关单（`done`）→ `workorder.completed` → **Outbox**（`target_kind=erp_workorder`）→ `outbox_dispatcher` → `post_erp_workorder_webhook`；env **`CLAWTWIN_ERP_WORKORDER_WEBHOOK_URL`**；另：**`/v1/webhooks/subscriptions`** 与 ERP env 路径可并存                                                                                                                                    |
| ERP → ClawTwin 状态回写 | **入站** env **`CLAWTWIN_ERP_CALLBACK_SECRET`**；**`POST /v1/integrations/erp/workorders/{id}/transition`**（body：**`action`**；可选 **Idempotency-Key**，见 **`infra/integration_idempotency.py`**）                                                                                                                                                                             |
| ERP 物料 / 备料申请     | **出站** env **`CLAWTWIN_ERP_MATERIAL_WEBHOOK_URL`**；Outbox 默认（**`erp_material`** / **`material.request`**）；可选 **`CLAWTWIN_ERP_MATERIAL_OUTBOX=0`** 同步 POST                                                                                                                                                                                                              |
| MES 生产指令下发        | **出站** env **`CLAWTWIN_MES_PRODUCTION_WEBHOOK_URL`**；**`POST /v1/integrations/mes/production-dispatch`** 或 Playbook **`action_api_name: mes_production_dispatch`**；示例 Playbook **`dispatch_mes_on_workorder_created`**（`ontology/playbooks/`）；Outbox 默认（**`mes_production`** / **`mes.production_dispatch`**）；可选 **`CLAWTWIN_MES_PRODUCTION_OUTBOX=0`** 同步 POST |
| BI/报表推送             | **`POST /v1/integrations/bi/outcomes`** + 可选 **定时**（`CLAWTWIN_BI_OUTCOMES_PUSH_INTERVAL_SECONDS` → `schedule_bi_outcomes_push`）；显式场站或 `CLAWTWIN_BI_PUSH_GLOBAL`；可选 **OutcomeEvent 驱动**（`CLAWTWIN_BI_PUSH_ON_OUTCOME_EVENT`，按行 `station_id` 出站聚合快照）                                                                                                     |
| 通用 REST Connector     | 声明式 `connector.yaml`（`rest_profile` / `rest_operations`）+ **`POST /v1/connectors/{id}/invoke`**（GET/HEAD 脚手架；`CLAWTWIN_REST_CONNECTOR_INVOKE=1`）；ERP 实体映射/认证仍待站点编排                                                                                                                                                                                         |
| 双向同步冲突解决        | **脚手架**：`platform-api/infra/conflict_resolver.py`（last-write-wins + 固定策略；`tests/test_conflict_resolver.py`）— ERP 适配器侧集成待办                                                                                                                                                                                                                                       |
| 审计日志导出            | `GET /v1/audit?from=...&to=...` CSV/JSON（`CLAWTWIN_AUDIT_DB=1`；`audit_export.py`）                                                                                                                                                                                                                                                                                               |

### 验收标准

- 一次端到端流程：SCADA 告警 → ClawTwin 诊断 → 创建 WorkOrder → 同步 SAP-PM
- SAP-PM 确认后 WorkOrder 状态回写 ClawTwin
- 全程可在审计日志中追溯

---

## M5：Studio UI + 自主驾驶升级

**目标**：人类友好的产品体验；实现 L3-L4 自主级别

**周期**：120 天

### Studio UI 模块

| 模块                    | 说明                                    |
| ----------------------- | --------------------------------------- |
| Playbook 可视化编辑器   | 拖拽节点，条件/HITL 可配置              |
| HITL 审批界面           | 待审批列表 + 诊断上下文 + 一键批准/拒绝 |
| 设备 Object 浏览器      | 类 Palantir Slate 的对象关系图          |
| 告警时间线              | ISA-18.2 对齐的告警面板                 |
| 推荐操作卡片            | CBR 结果 + 置信度 + 历史案例链接        |
| KB 管理界面             | 知识条目浏览/编辑/发布审核              |
| OutcomeEvent 飞轮仪表盘 | 干预效果统计 + 趋势图                   |

### 自主驾驶升级

| 级别                         | 实现                                               |
| ---------------------------- | -------------------------------------------------- |
| L3（Conditional Automation） | 高置信度（> 0.9）自动执行，无需 HITL               |
| L4（High Automation）        | 基于历史证明的操作类型全自动，异常时 fallback HITL |
| L5（Full Automation）        | 规划阶段；需监管合规评估                           |

---

## M6：多站点 / 边缘 / 基础模型对接（长期）

**目标**：规模化部署，连接下一代工业 AI 模型

| 主题                | 说明                                        |
| ------------------- | ------------------------------------------- |
| 多站点租户隔离      | Ontology 命名空间 + 数据行级 RLS            |
| 边缘部署            | SQLite backend + 断网续传队列               |
| 基础模型接入        | IndustryLLM-7B 等工业专属模型 ModelProvider |
| 联邦学习 / 模型合并 | 多站点 KB 知识合并（差分隐私可选）          |
| ClawTwin Cloud Hub  | 中央遥测 + 固件推送 + 跨站比较              |

---

## OpenClaw 对比矩阵（Phase A 完成状态）

| 能力维度         | OpenClaw（参考系）       | ClawTwin Phase A                                  | 状态                         |
| ---------------- | ------------------------ | ------------------------------------------------- | ---------------------------- |
| **扩展资源架构** | 38+ 资源类型，npm 包发布 | 8 类资源轴 + IndustryPack + Python 贡献点         | 架构对齐，资源数量随Pack增长 |
| **配置热重载**   | GatewayReloadPlan        | ReloadPlan（6 个字段手术式）                      | 对齐                         |
| **自检**         | 30+ Doctor check         | 7 内置 + Pack 扩展                                | 机制对齐                     |
| **健康监控**     | 多维 + version           | 多维 + version + Capability感知                   | 对齐并增强                   |
| **可靠投递**     | 文件 + DB                | Postgres Outbox + 退避重试 + 重启恢复             | 对齐                         |
| **AI 限流**      | Gateway 限流             | 双维限流（IP + actor）                            | 对齐                         |
| **AI 用量**      | 内部统计                 | DB 持久化 + 多维查询                              | ClawTwin 更完整              |
| **入站去重**     | N/A                      | TTL-LRU 50k/24h                                   | ClawTwin 增量                |
| **数据接入**     | 渠道消息                 | OPC-UA/Modbus/Webhook Connector                   | 工业垂直增强                 |
| **知识库飞轮**   | N/A                      | OutcomeEvent + CBR + KB                           | ClawTwin 增量                |
| **HITL**         | N/A                      | Playbook HITL approve/reject                      | ClawTwin 增量                |
| **本体系统**     | N/A                      | Ontology + ObjectType + ActionType + FunctionType | ClawTwin 增量                |

---

## 里程碑风险与缓解

| 风险                   | 影响              | 缓解措施                             |
| ---------------------- | ----------------- | ------------------------------------ |
| 第一个真实客户数据延迟 | M2 端到端验收滑期 | OPC-UA 模拟器作为替代验收基准        |
| AI 供应商 API 不稳定   | M3 AI 诊断可用性  | Stub Provider 保底 + Ollama 本地备选 |
| ERP 接口文档不规范     | M4 集成复杂度爆炸 | 声明式 connector.yaml 通用适配层优先 |
| Studio 工作量低估      | M5 UI 交付延期    | 优先 HITL 审批界面（最小可用 UI）    |

---

_本规划应随每次里程碑完成后同步更新。配合 `CLAWTWIN-SYSTEM-AUDIT-V1.md` 使用查看详细完成状态。_
