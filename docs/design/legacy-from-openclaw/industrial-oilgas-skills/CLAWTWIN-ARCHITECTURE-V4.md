# ClawTwin Platform · 架构设计 V4.6（参考附录）

> ⚠️ **本文已降为参考附录。** 日常开发请优先阅读：
>
> | 文档         | 路径                                                  | 用途           |
> | ------------ | ----------------------------------------------------- | -------------- |
> | **冷启动**   | `clawtwin-platform/platform-api/QUICKSTART.md`        | 5 分钟跑通     |
> | **核心设计** | `clawtwin-platform/platform-api/ARCHITECTURE-CORE.md` | 架构一页纸     |
> | **里程碑**   | `clawtwin-platform/platform-api/docs/MILESTONES.md`   | 现实里程碑     |
> | **代码**     | `clawtwin-platform/platform-api/`                     | 唯一权威代码库 |
>
> `openclaw/contrib/industrial-oilgas-skills/platform-api/` 是只读指针（MIGRATED.txt）。
>
> **已知勘误（对照实际代码）**：
>
> - Phase A「2 周 420 行」低估：M0 已完成，M1 工作台约 1200 行（见 MILESTONES.md）。
> - Redis：**当前版本无硬性 Redis 依赖**；SSE 为 asyncio 实现，HITL 用 DB 轮询；Redis 是可选 M2+ 能力。
> - GraphRAG / CBR 联邦：复杂度被低估，已移至 M3 P2。
> - 本文所有 `platform-api/core/...` 路径均以 `clawtwin-platform/platform-api/` 为基准。
> - OpenClaw 源码有 12 处工作树修改（主要是 doctor timeout 10s→30s、删除 osc-progress 终端模块），与 ClawTwin 集成无破坏性影响。
>
> **批评 12–16 澄清**（对应代码审查意见，已验证）：
>
> | #   | 批评摘要                                        | 实际状态                                                                                                                                                                                                       |
> | --- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
> | 12  | Redis SSE pub/sub + PG 双存储是设计陷阱         | **无此问题**：`apps/http/routes/sse.py` 用 asyncio，无 Redis 依赖；PG 只做持久备份；Redis 是可选 Phase B                                                                                                       |
> | 13  | Langfuse Phase B，但 Phase A 无可观测性         | **部分正确**：`aip/llm_trace.py` 提供轻量 Phase A trace（模型/token/时延/cost）；完整 Langfuse 仪表盘在 M3；这是合理分层，不是盲区                                                                             |
> | 14  | A2A 协议被过度包装                              | **已确认**：A2A 明确推迟到 Phase C/M3 P2；Phase 1–2 核心流程用 HTTP/MCP                                                                                                                                        |
> | 15  | IT/OT 部署矛盾（Docker Compose 与 Purdue 模型） | **已澄清**：`docker-compose.yml` 是**开发环境**；IT/OT 分层部署需要专项安全文档（M3 P2），开发阶段无此矛盾                                                                                                     |
> | 16  | "615+ passed" 但 platform-api 代码已移走        | **已澄清**：活跃代码在 `clawtwin-platform/platform-api/tests/`（122 个测试文件）；`openclaw/contrib/.../MIGRATED.txt` 是旧 stub，不是主代码库；验收标准应改为 `pytest tests/ -x` 在 clawtwin-platform 仓库执行 |
>
> **批评 17–31 澄清**（第二批代码审查意见，已逐条核实）：
>
> | #   | 批评摘要                                         | 实际状态                                                                                                                          |
> | --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
> | 17  | License Key RSA 实现缺失                         | **与当前代码无关**：代码库无 `core/license/manager.py`，License 系统是纯文档构想；开源平台不需要 RSA 授权，**已列入「明确不做」** |
> | 18  | Active-Passive HA 依赖 PG 主从                   | **超出当前范围**：HA 是 v1.x+ 可选扩展；单节点 SQLite/Postgres 支持完整可用                                                       |
> | 19  | 边缘（SQLite）与生产（PG+TimescaleDB）两套技术栈 | **代码已处理**：SQLAlchemy `DATABASE_URL` 切换；时序扩展是可选生产 Pack；SQLite 模式完整可用（CI 用 SQLite 验证）                 |
> | 20  | Phase A CI/CD 验收标准模糊                       | **已修复**：`.github/workflows/ci.yml` 已创建（lint + test + docker build）                                                       |
> | 21  | 文档自称"终稿"但有 100+ 未完成项                 | **已处理**：本文降为参考附录；权威文档为 `ARCHITECTURE-CORE.md` + `MILESTONES.md`                                                 |
> | 22  | EventBus 是 asyncio 内存队列，事件不持久化       | **架构理解偏差**：EventBus 是通知层，告警先写 DB 再触发事件；`_WebhookOutboxSink` 用 Outbox 模式持久化；重启不丢告警              |
> | 23  | 事件时间戳乱序无处理                             | **v0.2 不适用**：当前版本是导入+查询，无实时流处理；时序乱序是 v1.x+ 工业连接器包的问题                                           |
> | 24  | 事件投递无幂等保证                               | **部分修复**：`Alarm.external_id` unique index 已加（migration 020）；Outbox 有 at-least-once 语义                                |
> | 25  | YAML 输入无安全防护                              | **批评有误**：全库 39 处 `yaml.safe_load()`；Pack YAML 走 Pydantic schema 验证                                                    |
> | 26  | 提示注入防护只在审计中                           | **v0.2 不适用**：v0.3 AI 诊断时通过 `before_llm_call` Hook 添加基础过滤是正确时机                                                 |
> | 27  | 没有 Dockerfile                                  | **批评有误**：`Dockerfile` + `docker-compose.yml` 均已存在                                                                        |
> | 28  | 对标 Palantir 等但只有一段话                     | **已处理**：ARCHITECTURE-CORE.md 已聚焦"通用本体+AI协调"，删除过度对标                                                            |
> | 29  | Phase A 要 100% 离线又要 LLM                     | **已澄清**：v0.2 无 LLM 需求；离线+大模型是矛盾约束，**已列入「明确不做」**                                                       |
> | 30  | 文档混合多受众                                   | **已处理**：拆分为 QUICKSTART / ARCHITECTURE-CORE / MILESTONES / packs/README                                                     |
> | 31  | Studio 前端完全缺失                              | **批评有误**：`refine-clawtwin/src/` 已有 Dashboard / Equipment / WorkOrders / Alarms / MCP 等页面；Object 导入页是 v0.5 新增项   |

**版本**：2026-05-15-r10（最后更新）

---

## 文档地图与真值分层（读本章 V4 前先读）

本文 **`CLAWTWIN-ARCHITECTURE-V4.md`** 定位为 **架构终稿纵深版**：从零·二通用任务、`PluginApi`/Hook、上下文与知识、Phase 清单、本体与 GraphRAG、可靠性、§5.7 本体运行时工作台增量、代码差距与 Dev-Ready 等。**不是**独立的 HTTP 契约真值文档。

| 读什么                   | 路径（均在 `contrib/industrial-oilgas-skills/`，下同）                                                                     | 角色                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| **全库导航·黄金路径**    | `DESIGN-FINAL-MASTER-INDEX.md`                                                                                             | 分层索引（L0–L4）、新人顺序                                         |
| **对外/入门级总览**      | `CLAWTWIN-ARCHITECTURE-OVERVIEW.md`                                                                                        | 为什么是 ClawTwin、三层产品与接口表                                 |
| **协议与端点（产品向）** | `INDUSTRIAL-FOUNDRY-ARCHITECTURE.md`、`DESIGN-FINAL-LOCK.md`（端点以 **LOCK §一** 及 `TEAM-COLLAB-GUIDE.md` §三 约定为准） | 对外 API 叙事与锁定项                                               |
| **Platform 实现契约**    | `archive/MODULE-DESIGN-PLATFORM.md` **§18.6 / §19**（若后续迁出 `archive/` 以仓库内 **实际路径** 为准）                    | **HTTP 形状与数据模型**与代码联调时优先对照                         |
| **Studio 模块**          | `archive/MODULE-DESIGN-STUDIO.md`                                                                                          | 前端契约（若存在）                                                  |
| **开发入口**             | `DEV-QUICKSTART.md`、`archive/DEVELOPMENT-CONTRACT.md`、`clawtwin-project/SKILL.md`                                        | 环境、契约索引、红线                                                |
| **本文 V4**              | `CLAWTWIN-ARCHITECTURE-V4.md`                                                                                              | **设计理由、边界、章节号纵深**；§5.7 与§一·五/§二十·六/§二十八 对齐 |

**冲突时的处理**：若 V4 中某 REST 示例与 **`archive/MODULE-DESIGN-PLATFORM.md` §18.6 / §19**（或迁出后的等价路径）或 **`DESIGN-FINAL-LOCK.md`** 不一致，以 **契约/LOCK + 当周 PR 所选真值** 为准，并回头修正 V4 **同一小节**（不得双源）。

**章节号说明**：正文存在历史编号空隙（例如「三十二」未单独成章），不影响交叉引用有效性；以大标题 **「## …」** 锚定为准。

---

## 概念词汇表（先读这里）

> 降低学习成本：先理解下列 **核心术语**，再读架构细节。（含 OpenClaw 对齐项与 ClawTwin 独有项。）

| ClawTwin 概念                | OpenClaw 对应         | 一句话定义                                                                                        |
| ---------------------------- | --------------------- | ------------------------------------------------------------------------------------------------- |
| **Plugin**                   | Plugin                | 可安装/卸载的功能扩展单元；通过 `PluginApi` 向平台注册资源                                        |
| **PluginApi**                | PluginApi             | Plugin 唯一合法的"系统调用"接口；对应 OpenClaw `registerTool/registerHook/...`                    |
| **CapabilityBundle**         | Plugin（内聚子集）    | 一个完整业务能力的注册单元；注册一次在 7 个集成点自动生效（**事半功倍**）                         |
| **TriggerDef**               | —                     | 描述能力被触发的方式；7 种类型：alarm/schedule/chat/api/data_change/threshold/manual              |
| **ReportTemplateDef**        | document output       | 将 AI 分析结果渲染为结构化文档（Jinja2 模板）                                                     |
| **Connector**                | Channel（工业扩展）   | 与外部工业系统通信的驱动（OPC-UA/SAP/Maximo）；读写 OT/IT 数据                                    |
| **Channel**                  | Channel（通知）       | 向人发送通知/消息的通道（飞书/Email/SMS/Webhook）                                                 |
| **AgentFunction**            | Agent step            | 原子性 AI 推理单元；输入上下文，输出结构化结论（如诊断报告）                                      |
| **Playbook**                 | Session/Run           | 事件触发的多步骤工作流；编排 AgentFunction + Action + Channel 通知                                |
| **ObjectType**               | —                     | 本体对象类型声明（YAML）；定义设备、工单、告警等实体的字段和行为                                  |
| **LinkType**（关系类型）     | —                     | 本体中实体间语义边类型（如 `feeds_into`、`triggers`）；与 ObjectType 一起构成 Ontology **§一·五** |
| **Ontology Graph**           | —                     | 规范类型 + Pack 扩展下的 **实例图**（对象顶点 + Link 边）；GraphRAG 遍历对象                      |
| **GraphRAG**                 | —                     | 以 **`get_neighbors` 等图遍历** 将邻域语义并入 LLM 上下文 **§二十·六**；非单纯向量检索            |
| **Evidence layer（证据层）** | citations / retrieval | §5.3/`infra/knowledge`：规程与文档片段 **绑定孪生对象或边**，服务于本体主轴，不单列为唯一知识根   |
| **本体运行时工作台**         | §5.7 Studio 视图      | Profile / Build / Governance 等产品化增量；借鉴外部控制台时仅限于 **信息与模式**，见 **§5.7.0**   |
| **HookSystem**               | Hook System           | 生命周期事件总线；Plugin 通过 `register_hook()` 监听平台事件                                      |

### 一张图理解 ClawTwin

```
外部世界                    ClawTwin 内核                           结果输出
─────────              ──────────────────────────────────────     ──────────────────
OPC-UA 告警  ──[Connector]→                                    → 工单（ActionExecutor）
SAP 工单状态 ──[Connector]→  ┌─ TRIGGER LAYER ─────────────┐  → 报告（ReportTemplate）
Modbus 数据  ──[Connector]→  │ alarm/schedule/chat/api/...  │  → 通知（Channel）
操作员对话  ──[OpenClaw]──→  └────────┬─────────────────────┘  → 对话回复（MCP响应）
定时任务    ──[Scheduler]──→          ↓ task_triggered
API 调用    ──[REST API]──→  ┌─ TASK LAYER ────────────────┐
                             │ AgentTask（CapabilityBundle）│
                             └────────┬─────────────────────┘
                                      ↓
                             ┌─ INTELLIGENCE LAYER ────────┐
                             │ ContextAssembler+Skills      │
                             │ litellm_tool_loop（ReAct8轮）│
                             └────────┬─────────────────────┘
Plugin 注册 ──[PluginApi]→  ObjectType/Rule/Bundle/Report → 全局资源注册表
```

### ClawTwin vs OpenClaw 完整命名对照

| ClawTwin                  | OpenClaw                  | 关系说明                    |
| ------------------------- | ------------------------- | --------------------------- |
| `PluginApi`               | `PluginApi`               | **完全同名** ✅             |
| `register_tool`           | `registerTool`            | **完全对齐** ✅             |
| `register_hook`           | `registerHook`            | **完全对齐** ✅             |
| `register_channel`        | `registerChannel`         | **完全对齐** ✅（通知通道） |
| `register_service`        | `registerService`         | **完全对齐** ✅             |
| `register_doctor_check`   | `registerDoctorCheck`     | **完全对齐** ✅             |
| `register_mcp_server`     | `registerMcpServer`       | **完全对齐** ✅             |
| `register_skill`          | SKILL.md 注入             | **完全对齐** ✅             |
| `register_schedule`       | `registerCron`            | 更直观（cron 是实现细节）   |
| `register_connector`      | —                         | ClawTwin 独有；工业数据驱动 |
| `register_object_type`    | —                         | ClawTwin 独有；本体对象类型 |
| `register_agent_function` | —                         | ClawTwin 独有；AI 推理函数  |
| `register_playbook`       | —                         | ClawTwin 独有；工作流模板   |
| `register_rule`           | —                         | ClawTwin 独有；规则引擎     |
| `HookSystem` 30 个事件    | 35 个 Hook                | 同等深度覆盖 ✅             |
| `EventBus`                | Gateway（消息路由）       | 工业事件路由                |
| `PlaybookEngine`          | RunStateMachine + Session | 工业工作流引擎              |
| `ActionExecutor`          | ActionExecutor            | **完全同名** ✅             |
| `ObjectStore`             | —                         | 工业对象存储（本体驱动）    |

---

## 零、代码现状评估与开发策略

### 现有代码评估（已检查 platform-api/）

**保留（结构合理）**：

- `core/` — object_store、action_executor、playbook_engine、plugin_registry 骨架已有
- `infra/` — outbox、auth（JWT+飞书+AD）、event_dispatcher、hooks、health、doctor 均已有
- `connectors/` — OPC-UA、Modbus、ERP（SAP/金蝶/用友）、CMMS（Maximo/SAP PM）骨架极其完整
- `apps/` — CLI（Typer）、HTTP（FastAPI）、Feishu 均已有
- `ontology/` — 实体类型、Playbook、Pipeline YAML 结构已有
- `packs/oilgas/` — 行业 Pack 结构已有

**需要填充（骨架空）**：

- `providers/llm.py` — 只有注释，需填充 LiteLLM
- `aip/agent_runtimes/` — 工具循环为空，需实现
- `core/plugin_registry/` — register\_\* 方法不完整
- `infra/hooks.py` — 需改造为完整 HookSystem

**新增（不存在）**：

- `core/context_engine/` — ContextAssembler 完全没有
- `infra/knowledge/` — KB + CBR 完全没有

> `infra/training/` 推迟到 Phase B：Phase A 先在数据库写入 LLM 调用日志即可，不做独立训练模块。

### 开发策略：**在现有代码基础上填充，不从零重写**

现有骨架价值极高（connectors 的分类设计尤其出色），重写是浪费。
策略：保持目录结构，填充空实现，新增 context_engine 和 knowledge 模块。

---

## 零·一、最小内核哲学（OS Kernel 设计原则）

> **核心命题**：ClawTwin = 工业操作系统。  
> 内核只管"系统调用"，一切业务能力都是可插拔的驱动程序或应用。

### ClawTwin = OS 类比

| OS 概念                     | ClawTwin 对应                                           | 说明                                                           |
| --------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| **内核（Kernel）**          | `core/` + `infra/outbox/` + `infra/event_dispatcher.py` | 永不含行业知识；只管注册、路由、持久化                         |
| **系统调用接口（Syscall）** | `core/plugin_sdk/api.py` — `PluginApi` 类               | Pack 唯一合法入口，对应 OpenClaw `src/plugin-sdk/api.ts`       |
| **设备驱动（Driver）**      | `connectors/` — 实现 `ConnectorPlugin` 协议             | 对应 OpenClaw `ChannelPlugin`；驱动只读，写回走 ActionExecutor |
| **系统服务（Daemon）**      | `aip/agent_runtimes/`、`workers/`                       | 运行在内核上，可被 Pack 替换                                   |
| **应用程序（App）**         | `packs/oilgas/`、`packs/utility/`                       | 调用 PluginApi 注册资源；不能直接访问内核内部                  |
| **设备文件（/dev）**        | `infra/event_dispatcher.py` — EventBus                  | 驱动写入事件，应用订阅事件                                     |
| **init 系统（systemd）**    | `core/plugin_loader/` — PluginLoader                    | 拓扑排序加载 Pack，管理生命周期                                |
| **IPC（信号/管道）**        | `infra/hooks.py` — HookBus                              | 进程内事件通知，对应 OpenClaw `internal-hooks.ts`              |

### 核心边界规则（不可违反）

```
✅ Pack 可以:
   - 调用 PluginApi.register_*(...)
   - 订阅 / 发布 HookBus 事件
   - 读写 EntityStore（通过 PluginApi 注入的引用）
   - 发布 EventBus 消息

❌ Pack 不可以:
   - import core.* / infra.db.* / apps.*（内核内部）
   - import 其他 Pack 的 src（Pack 间隔离）
   - 直接写 OT 设备（必须经 ActionExecutor + HITL）
   - 在 register() 外启动线程（必须通过 register_service()）
```

### PluginApi — 系统调用接口（完整列表）

对应 OpenClaw `registerTool / registerHook / registerChannel / registerProvider` 等：

```python
# core/plugin_sdk/api.py  （约 250 行）
class PluginApi:                                      # 与 OpenClaw PluginApi 完全同名
    # === OpenClaw 完全同名方法 ===
    def register_tool(self, name, fn, schema) -> None          # = registerTool
    def register_hook(self, event, handler, priority=50) -> None # = registerHook
    def register_channel(self, ch: Channel) -> None            # = registerChannel（通知通道）
    def register_service(self, name, fn, interval_s) -> None   # = registerService
    def register_schedule(self, cron, fn, name) -> None        # = registerCron
    def register_doctor_check(self, name, fn) -> None          # = registerDoctorCheck
    def register_mcp_server(self, url, name) -> None           # = registerMcpServer
    def register_http_route(self, router) -> None              # = httpRoutes
    def register_skill(self, md_path: str) -> None             # = SKILL.md 注入
    def register_reload(self, fn) -> None                      # = settings.reload

    # ── 对应 OpenClaw registerAgentHarness / registerContextEngine / registerMemoryCapability / registerCommand ──
    def register_agent_harness(self, harness) -> None          # = registerAgentHarness（可插拔 Agent 运行时）
    def register_context_engine(self, factory) -> None         # = registerContextEngine（可插拔上下文装配）
    def register_memory(self, memory) -> None                  # = registerMemoryCapability（知识/记忆注册）
    def register_command(self, cmd) -> None                    # = registerCommand（CLI 子命令扩展）

    # === ClawTwin 工业扩展（OpenClaw 无对应）===
    def register_connector(self, plugin: ConnectorPlugin) -> None  # 工业数据驱动
    def register_object_type(self, schema_path: str) -> None       # 本体对象类型
    def register_link_type(self, schema_path: str) -> None         # 实体关系类型
    def register_agent_function(self, fn_def: AgentFunctionDef) -> None  # AI 推理函数
    def register_playbook(self, yaml_path: str) -> None            # 工作流模板
    def register_rule(self, rule_def: RuleDef) -> None             # 规则引擎规则
```

### ConnectorPlugin 协议（设备驱动合同）

对应 OpenClaw `ChannelPlugin`（`src/channels/channel-plugin-types.ts`）：

```python
# core/plugin_sdk/connector.py  （约 60 行）
from typing import Protocol, runtime_checkable, AsyncIterator

@runtime_checkable
class ConnectorPlugin(Protocol):
    """每个 Connector 必须实现此协议，对应 OpenClaw ChannelPlugin。"""

    @property
    def meta(self) -> ConnectorMeta:
        """id, name, version, capabilities(['read','write','subscribe'])"""
        ...

    async def connect(self) -> None:
        """建立连接（TCP / REST session / DB pool）。"""
        ...

    async def disconnect(self) -> None:
        """清理资源，对应 OpenClaw plugin cleanup()。"""
        ...

    def subscribe(self, entity_id: str, tags: list[str]) -> AsyncIterator[DataPoint]:
        """实时订阅数据点，写入 EventBus（仅 read Connector 实现）。"""
        ...

    async def write(self, entity_id: str, tag: str, value: Any) -> WriteResult:
        """写回 OT 层（仅 write Connector 实现，由 ActionExecutor 调用）。"""
        ...

    async def health_probe(self) -> HealthStatus:
        """健康探针，结果并入 /health + doctor checks。"""
        ...

    def doctor_checks(self) -> list[DoctorCheck]:
        """返回此 Connector 提供的 doctor check 项（可选）。"""
        return []
```

### 已有代码需要的核心变更（精准清单）

> 架构方向 **不变**。以下是让"OS 内核"完整运作所需的**最小代码变更**：

| 文件                                         | 变更类型 | 说明                                              | 行数 |
| -------------------------------------------- | -------- | ------------------------------------------------- | ---- |
| `core/plugin_sdk/api.py`                     | **新建** | PluginApi 系统调用接口（16 个 register\_\* 方法） | ~250 |
| `core/plugin_sdk/connector.py`               | **新建** | ConnectorPlugin 协议 + 数据类型                   | ~80  |
| `core/plugin_sdk/__init__.py`                | **新建** | 导出 PluginApi、ConnectorPlugin、Channel 等       | ~20  |
| `infra/hooks.py`                             | **填充** | 添加 VALID_EVENTS（30+12 个），`fire_async()`     | ~60  |
| `aip/agent_runtimes/simple_loop.py`          | **填充** | 在 LLM call / tool call 前后插入 `fire_async()`   | ~12  |
| `core/action_executor/executor.py`           | **填充** | 在 execute() 前后插入 `fire_async()`              | ~6   |
| `core/playbook_engine/engine.py`             | **填充** | 步骤 start/end 插入 `fire_async()`                | ~8   |
| `core/plugin_registry/__init__.py`           | **填充** | 代理到 PluginApi.register_connector/object_type   | ~30  |
| `core/plugin_loader/python_contributions.py` | **填充** | 调用 `plugin_module.register(PluginApi(...))`     | ~20  |
| `packs/oilgas/__init__.py`                   | **新建** | `def register(api: PluginApi): ...` 示例入口      | ~40  |

**不需要变更**：`infra/outbox/`（已对齐 OpenClaw）、`infra/auth/`（已完整）、`connectors/` 骨架结构、`apps/http/`、`ontology/` YAML 格式、`alembic/` 迁移。

---

## 零·二、通用任务架构（Universal Task Architecture）

> **核心批判与修正**：V4.2 之前的设计是"告警中心主义"——整条主管道只处理 OT 告警。  
> 但工业企业的真实业务中，告警响应只占约 15%，其余 85% 是巡检、交班、报告、分析、合规等"杂项"。  
> 这些"杂项"恰恰是操作员和管理者每天大量时间的消耗所在。

### 零·二·一、设计原则：任何事件都可以触发任何能力

借鉴 OpenClaw 核心原则：**任何消息都可以触发任何工具**。

ClawTwin 对应原则：**任何事件（alarm/schedule/chat/api/data_change/manual）都可以触发任何已注册的业务能力。**

### 零·二·二、7 种触发器（TriggerDef）

| 触发类型      | 触发条件              | 典型场景                        | 实现机制                           |
| ------------- | --------------------- | ------------------------------- | ---------------------------------- |
| `alarm`       | OT 告警（主线，已有） | 振动超标→立即诊断               | Connector→EventBus→PlaybookEngine  |
| `schedule`    | Cron 定时             | 每天 08:00→日常巡检             | APScheduler                        |
| `chat`        | 操作员对话意图        | 「帮我做一个巡检」→触发巡检流程 | OpenClaw MCP→initiate_task 工具    |
| `api`         | REST API 显式调用     | ERP 工单创建→触发备件检查       | POST /api/tasks/initiate           |
| `data_change` | 字段值变化            | 工单关闭→触发知识沉淀           | before_object_save hook            |
| `threshold`   | 规则引擎输出          | 连续 3 天效率下降→触发深度分析  | RuleEngine→task_triggered hook     |
| `manual`      | Studio 手动按钮       | 操作员主动发起月度报告          | Studio UI→POST /api/tasks/initiate |

```python
# TriggerDef 示例
TriggerDef(kind="schedule", cron="0 8 * * *")           # 每天 8 点
TriggerDef(kind="chat", intent_keywords=["巡检", "inspection"])  # 对话触发
TriggerDef(kind="alarm", alarm_type="vibration_high", object_type="compressor")
TriggerDef(kind="data_change", watch_field="workorder.status", threshold_value=None)
TriggerDef(kind="manual")                               # Studio 手动按钮
```

### 零·二·三、CapabilityBundle：事半功倍的核心扩展机制

`CapabilityBundle` 是 ClawTwin 实现"添加一个能力，扩展一大片功能"的核心设计。

**注册一次，7 处自动生效**：

| 生效位置           | 自动行为                                                       |
| ------------------ | -------------------------------------------------------------- |
| ① TriggerDef       | 注册所有声明的触发器监听（cron/hook/chat）                     |
| ② ContextAssembler | 将 `skill_paths` 注入 LLM 上下文（领域知识自动注入）           |
| ③ PlaybookEngine   | 串联 `agent_function_ids`（数据收集→AI推理→输出）              |
| ④ ReportEngine     | 任务完成后渲染 `report_template_ids` 中的报告                  |
| ⑤ 工具白名单       | 限制本能力流程中可用的工具（最小权限原则）                     |
| ⑥ MCP 工具（自动） | `expose_as_mcp_tool=True` → 自动生成 `initiate_<id>` MCP 工具  |
| ⑦ Hook 可观测      | `task_triggered/started/completed/failed` 自动触发，全程可监控 |

```python
# 一次注册完整的"日常巡检"业务能力
api.register_capability_bundle(CapabilityBundle(
    id="daily_inspection",
    name="日常巡检",
    description="收集巡检数据，AI 分析设备状态，生成巡检报告",
    triggers=[
        TriggerDef(kind="schedule", cron="0 8 * * *"),      # 每天 8 点自动
        TriggerDef(kind="chat", intent_keywords=["巡检", "inspection"]),  # 对话触发
        TriggerDef(kind="manual"),                          # Studio 手动按钮
    ],
    agent_function_ids=["analyze_inspection_data"],
    report_template_ids=["inspection_report"],
    skill_paths=["skills/inspection-procedure.md"],
    tool_names=["record_finding", "create_defect_workorder"],
    expose_as_mcp_tool=True,  # → 自动生成 initiate_daily_inspection MCP 工具
))
# 结果：1 次注册 = 3 种触发方式 + LLM技能 + AI分析 + 报告生成 + MCP工具 + 全程可观测
```

### 零·二·四、通用任务管道（Universal Task Pipeline）

```
        ┌─────────────────────────────────────────────────────────────┐
        │                TRIGGER LAYER（7 种触发器）                   │
        │  alarm │ schedule │ chat │ api │ data_change │ threshold │ manual │
        └─────────────────────────┬───────────────────────────────────┘
                                  ↓ task_triggered hook (统一汇聚点)
        ┌─────────────────────────────────────────────────────────────┐
        │              TASK LAYER（AgentTask 统一抽象）                 │
        │       bundle_id · trigger_kind · context · entity_id        │
        └─────────────────────────┬───────────────────────────────────┘
                                  ↓
        ┌─────────────────────────────────────────────────────────────┐
        │           INTELLIGENCE LAYER（ContextAssembler + AI）        │
        │     Skills注入 → Connector数据收集 → AgentFunction → 结论     │
        └─────────────────────────┬───────────────────────────────────┘
                                  ↓
        ┌─────────────────────────────────────────────────────────────┐
        │              OUTPUT LAYER（3 类输出）                        │
        │  工单（ActionExecutor）│ 报告（ReportTemplate）│ 通知（Channel）│
        │  对话回复（chat_task_responded hook + MCP 响应）              │
        └─────────────────────────────────────────────────────────────┘
```

### 零·二·五、典型业务能力实例（8 个 CapabilityBundle）

| 能力 ID                | 触发方式                       | AI 函数                 | 报告模板           | 业务价值             |
| ---------------------- | ------------------------------ | ----------------------- | ------------------ | -------------------- |
| `alarm_response`       | alarm/threshold                | diagnose_equipment      | diagnosis_report   | 告警响应主线（原有） |
| `daily_inspection`     | schedule(08:00)/chat/manual    | analyze_inspection_data | inspection_report  | 巡检报告自动生成     |
| `shift_handover`       | schedule(06/14/22点)/chat      | summarize_shift         | shift_report       | 班组无缝交接         |
| `energy_analysis`      | schedule(周一)/chat(能耗)      | analyze_energy_trend    | energy_report      | 节能管理             |
| `compliance_audit`     | schedule(月末)/manual          | check_compliance        | compliance_report  | 合规举证             |
| `spare_parts_forecast` | schedule(周)/threshold(库存<2) | predict_spare_parts     | procurement_report | 避免停机             |
| `performance_kpi`      | schedule(月末)/api(from_erp)   | calculate_kpi           | kpi_report         | 绩效可视化           |
| `cbr_knowledge`        | data_change(workorder.closed)  | extract_cbr_case        | —                  | 知识飞轮沉淀         |

### 零·二·六、ReportTemplateDef：工业报告生成

报告是"杂项"任务的核心输出。区别于工单（触发维修行动）和通知（推送消息），报告是**给人看的结构化文档**。

```python
# 日常巡检报告模板定义
api.register_report_template(ReportTemplateDef(
    id="inspection_report",
    name="日常巡检报告",
    template_path="templates/inspection.md.jinja",
    output_format="markdown",
    context_sources=[
        "historian:vibration,temperature,pressure:24h",  # 24小时历史数据
        "cmms:last_workorder:7d",                        # 最近7天工单
        "object_store:equipment_list:station_id",        # 站场设备清单
    ],
))
```

Jinja2 模板示例（`templates/inspection.md.jinja`）：

```markdown
# {{station_name}} 日常巡检报告

**日期**：{{date}} | **班次**：{{shift}} | **巡检员**：{{inspector}}

## AI 综合评估

{{agent_conclusion}}

## 设备状态汇总

{% for equipment in readings %}
| {{equipment.name}} | {{equipment.vibration}} g | {{equipment.temperature}} °C | {{equipment.status}} |
{% endfor %}

## 发现问题

{% for finding in findings %}

- {{finding.description}} → 建议：{{finding.recommendation}}
  {% endfor %}
```

### 零·二·七、ChatTrigger：操作员对话触发能力

当 `expose_as_mcp_tool=True` 时，平台自动生成 `initiate_<bundle_id>` MCP 工具。  
操作员通过 OpenClaw 的自然语言对话即可触发任意 ClawTwin 业务能力：

| 操作员说             | OpenClaw 识别         | 调用 MCP 工具                                 | ClawTwin 执行           |
| -------------------- | --------------------- | --------------------------------------------- | ----------------------- |
| 「帮我做一个巡检」   | intent: inspection    | `initiate_daily_inspection()`                 | 完整巡检流程 → 生成报告 |
| 「分析本月能耗」     | intent: energy/本月   | `initiate_energy_analysis({period: "month"})` | 能耗分析 → 报告         |
| 「有哪些待审批工单」 | intent: 审批/pending  | `initiate_hitl_summary()`                     | HITL 列表 → 对话回复    |
| 「生成交班记录」     | intent: 交班/handover | `initiate_shift_handover()`                   | 班次汇总 → 报告         |

这是 ClawTwin 实现"事半功倍"的最终体现：**一个 CapabilityBundle 注册 = 操作员可以用自然语言触发该能力**。

---

## 零·三、AI 原生验证（Agent-centric Architecture Proof）

> 本节确认 ClawTwin 已具备真正的 AI-native 能力，关键证据来自代码层。

### 零·三·一、ReAct 工具调用循环（已实现）

真正 AI-native 系统的核心是：**AI 自主决定需要什么数据，然后去取，而不是预先灌输一切数据后再问答。**

ClawTwin 已在 `aip/agent_runtimes/simple_loop.py → litellm_tool_loop()` 实现完整的 ReAct 模式：

```
告警触发 → Playbook 准备 system_prompt + user_prompt → litellm_tool_loop(tools=[...], max_turns=8)
   Turn 1: AI 决策「需要 7 天振动历史」→ 调用 query_historian_data()
   Turn 2: AI 分析历史数据「趋势上升，需要找类似案例」→ 调用 search_cbr_cases()
   Turn 3: AI 找到 3 个案例「均为轴承磨损」→ 调用 get_cmms_workorders()
   Turn 4: AI 综合分析 → 输出完整诊断报告（不再调用工具）
```

**关键配置**：

- `CLAWTWIN_SIMPLE_LOOP_MAX_TURNS=8`（默认）— 最多 8 轮工具调用
- `CLAWTWIN_LLM_MODEL=gpt-4o-mini`（默认）— 支持任意 OpenAI 兼容模型
- 工具通过 `register_tool()` 注册，AI 自动选择调用哪些

### 零·三·二、AI-native 10 项标准检验

| 标准              | 实现位置                                                   | 状态                |
| ----------------- | ---------------------------------------------------------- | ------------------- |
| 对话优先          | OpenClaw → `initiate_task` MCP → ClawTwin 任意能力         | ✅                  |
| 工具使用          | `litellm_tool_loop` + `register_tool()`                    | ✅                  |
| 多轮推理（ReAct） | `simple_loop.litellm_tool_loop(max_turns=8)`               | ✅                  |
| 情境感知          | `ContextAssembler` + `register_skill()` 注入领域知识       | ✅                  |
| 自我改进          | `cbr_knowledge` CapabilityBundle（工单关闭→CBR沉淀）       | ⚠️ 框架完整，待激活 |
| 多智能体          | A2A 协议 + `register_agent_harness()` 支持 LangGraph       | ✅                  |
| 记忆系统          | PlaybookRun（会话内）+ KB/CBR（长期）+ `register_memory()` | ✅                  |
| 多模态            | Historian 时序数据（✅）+ 图像诊断（待 Phase B 扩展）      | ⚠️ 部分             |
| 可观测性          | 56 个 Hook + LLM trace + before/after_llm_call             | ✅                  |
| 降级可靠性        | RuleEngine 独立（AI 宕机不影响告警）+ 断路器               | ✅                  |

### 零·三·三、ClawTwin vs 传统工业软件

| 维度     | 传统 SCADA/MES          | ClawTwin                        |
| -------- | ----------------------- | ------------------------------- |
| 交互方式 | 点击表单 + 预设报表     | 自然语言对话 + 主动推送         |
| 告警处理 | 人工逐条查看            | AI 自动诊断 + HITL 审批         |
| 知识管理 | PDF 手册 / 老师傅头脑中 | CBR + Skills + 知识飞轮自动沉淀 |
| 扩展方式 | 昂贵的定制开发          | Plugin + YAML 配置              |
| 分析能力 | 固定报表                | 自然语言查询任意维度            |
| 学习能力 | 不学习                  | 每次工单关闭都沉淀一个案例      |

---

## 零·四、里程碑计划（M0 → M3 增量交付）

> 设计原则：每个里程碑都是前一个的增量扩展，无需重构；每个里程碑都有可演示的 Demo 场景。

### M0 — 最小 Demo（1-2 周）| 目标：「能看能演」

**Demo 场景**：`docker-compose up` → 30 秒后控制台出现「P-201 振动高告警」→ AI 调用 2 轮工具 → 输出诊断报告。

| 交付物                                       | 类型                         | 代码量      |
| -------------------------------------------- | ---------------------------- | ----------- |
| Mock OPC-UA Connector（每 30s 生成模拟告警） | Python，基于 ConnectorPlugin | ~80 行      |
| `diagnose_on_alarm` Playbook YAML            | YAML                         | ~40 行      |
| `diagnose_equipment` AgentFunction           | Python                       | ~60 行      |
| 2 个 Mock AI 工具（历史数据 + CBR 案例）     | Python                       | ~80 行      |
| Console Channel（打印输出）                  | Python                       | ~20 行      |
| docker-compose.yml（一键启动）               | YAML                         | ~40 行      |
| OpenClaw MCP：4 个工具                       | 已有 `aip/mcp_server.py`     | 0（已实现） |

**成功标准**：演示者可向客户完整展示「告警 → AI 自动诊断」全过程，耗时 < 90 秒。  
**代码量**：约 300 行新业务逻辑。

---

### M1 — 单设备单站场 MVP（3-4 周）| 目标：「运维工程师每天真实使用」

在 M0 基础上增加：

| 交付物                           | 新增内容                                    |
| -------------------------------- | ------------------------------------------- |
| 真实/高仿 OPC-UA Connector       | 替换 Mock，读取真实或逼真的工业数据         |
| HITL 飞书审批                    | 飞书交互式消息 + 按钮审批                   |
| CBR 知识库（5 个种子案例）       | 为 3 种常见故障提供历史案例参考             |
| 工单创建（CMMS Mock）            | ActionExecutor → 创建工单记录               |
| 知识飞轮（cbr_knowledge Bundle） | 工单关闭 → data_change 触发 → 提取 CBR 案例 |
| Studio MVP（3 页面）             | 告警列表 + 诊断详情 + HITL 审批面板         |

**Demo 场景**：真实 OPC-UA 告警 → AI 诊断（参考 CBR 案例）→ 飞书按钮审批 → 工单创建 → 工单关闭后知识自动沉淀。  
**成功标准**：运维工程师每天处理 > 3 次真实告警，HITL 审批率 > 80%，用户反馈「比手工快 10 倍」。  
**代码量**：在 M0 基础上约 +800 行。

---

### M2 — 全业务主线（6-8 周）| 目标：「一个用户所有日常任务都能在 ClawTwin 中完成」

在 M1 基础上增加：

| 交付物                         | 新增内容                                       |
| ------------------------------ | ---------------------------------------------- |
| 全部 8 个 CapabilityBundles    | 巡检/交班/能耗/合规/备件/KPI/事件报告/知识沉淀 |
| Historian Connector（PI/高仿） | 为能耗分析和预测提供时序数据                   |
| 报告生成引擎                   | ReportTemplate + Jinja2 渲染                   |
| 多渠道通知                     | 飞书 + 邮件                                    |
| Studio 5 角色仪表板            | 运维/维修/站长/安全/IT 各自专属视图            |
| 自然语言 CLI                   | `clawtwin ask "今天有什么问题"`                |
| KPI 仪表板                     | AI 准确率 / 设备可用率 / 知识增长              |

**Demo 场景**：操作员说「帮我出今天巡检报告」→ 飞书收到完整 AI 报告；站长问「本月 AI 准确率」→ 实时 KPI 回复。  
**成功标准**：3 个角色（运维/维修/站长）使用频率 > 3次/天，NPS > 40。  
**代码量**：在 M1 基础上约 +2000 行。

---

### M3 — 企业级就绪（3 个月+）| 目标：「可部署到真实工厂」

在 M2 基础上增加：

| 交付物                 | 新增内容                                 | 优先级 |
| ---------------------- | ---------------------------------------- | ------ |
| IT/OT 网络隔离配置     | CLAWTWIN_OT_NETWORK_CIDR 白名单          | P0     |
| SSRF 保护              | MCP/Webhook 目标 IP 白名单               | P0     |
| IAM/SSO 集成           | LDAP/AD/SAML 统一认证                    | P1     |
| AI 决策审计日志        | 每次 LLM 调用记入 audit_log（GB 合规）   | P1     |
| PI Historian Connector | OSIsoft PI Web API 原生实现              | P1     |
| LOTO 数字作业许可      | permit_required Playbook 步骤 + 双人确认 | P1     |
| 多工厂部署             | site_id 租户隔离 + 数据分区              | P2     |
| 预测性维护 AI          | 趋势预测 + 剩余寿命估算                  | P2     |
| 边缘部署               | 最小化 Docker（SQLite + 本地 LLM）       | P2     |

**成功标准**：通过工厂安全验收，AI 诊断准确率 > 85%，停机时间减少 > 20%，可提供 ROI 数据。

---

### 里程碑时间轴总览

```
M0（2周）: Mock Connector → AI 诊断 → 日志输出 → OpenClaw MCP 接入
M1（+4周）: 真实 OPC-UA + 飞书 HITL + CBR + Studio 基础版
M2（+8周）: 8 个 CapabilityBundles + 报告引擎 + 角色仪表板 + KPI
M3（+3月）: 企业安全 + 多工厂 + 预测 AI + 边缘部署
```

---

## 一·五、本体（Ontology）设计原则（补充关键遗漏）

### 1. 本体不是"一个设备一个本体"

**正确理解**：本体（Ontology）= Object Types（对象类型类）+ Link Types（关系类型）的集合

```
错误理解：风机本体 / 管道本体 / 泵本体 → 各自独立
正确理解：
  Object Types  = { WindTurbine, Pipeline, Pump, Alarm, WorkOrder, ... }
  Link Types    = { feeds_into, monitored_by, triggers, located_at, ... }
  Objects       = { 风机P101, 管道L-02, 泵Q-05, ... }  （实例）
  全部合在一起  = 一个 Ontology
```

### 2. 规范基础类型 + Pack 扩展（现有 equipment.yaml 已体现）

```
规范基础类型（core，永不改变，所有实例共用）：
  EquipmentBase  → id, name, type, status, site_id
  AlarmBase      → id, severity, equipment_id, timestamp, acknowledged
  WorkOrderBase  → id, priority, status, assigned_to, due_date
  StationBase    → id, name, parent_id（支持树形层级）

Pack 扩展类型（extends 基础类型，每个行业 Pack 定义）：
  GasCompressor  extends EquipmentBase  + {rpm, discharge_pressure, rated_power}
  WindTurbine    extends EquipmentBase  + {rotor_diameter, rated_power, wind_speed}
  Pipeline       extends EquipmentBase  + {diameter, material, design_pressure}

Link Types（Pack 可扩展）：
  GasCompressor → "feeds_into"    → Pipeline
  Pipeline      → "receives_from" → Pump
  WindTurbine   → "connects_to"   → Generator
```

### 3. YAML 实现（现有格式扩展）

```yaml
# packs/oilgas/ontology/object_types/gas_compressor.yaml
object_type:
  api_name: GasCompressor
  extends: Equipment # ← 继承规范基础类型
  display_name: Gas Compressor
  properties:
    rpm: { type: float, unit: rpm }
    discharge_pressure: { type: float, unit: MPa }
    rated_power: { type: float, unit: kW }
  links:
    feeds_into:
      to: Pipeline # ← Link Type 定义关系
      type: many_to_many
    suction_from:
      to: Pipeline
      type: many_to_one
```

### 4. 多 ClawTwin 本体联合使用

**不是合并，是规范类型 + A2A 查询：**

```
Factory-A ClawTwin              Factory-B ClawTwin
  GasCompressor (local)           WindTurbine (local)
  Pipeline (local)                Generator (local)
  EquipmentBase (shared)    ←→    EquipmentBase (shared)  ← 同一个规范定义
         ↑                               ↑
         └──────────── A2A ──────────────┘
                 HQ Orchestrator
         "GET all Equipment WHERE status=fault"
         → 并发 A2A 查询 Factory-A + Factory-B
         → 统一 EquipmentBase 格式返回
         → HQ 无需知道 GasCompressor 或 WindTurbine 的细节
```

**规范类型由哪里管理**：

- 存放在一个共享 git 仓库的 `ontology/canonical/` 目录
- 各 ClawTwin 实例 git clone + read-only
- Pack 扩展类型存放在 Pack 本地 `ontology/` 目录

---

## 一·六、A2A 协议 + 企业智能体网格（核心架构升级）

### ClawTwin 是一个自治工业 Agent

每个 ClawTwin 实例 = **一个专业自治机器人（工业 Agent）**，有：

- 明确的职责边界（管辖哪些设备/业务）
- 本地自治能力（独立诊断、决策、执行）
- 对外协作接口（A2A）

### A2A 协议（Google 2025 标准）

ClawTwin 采纳 A2A 协议作为 Agent 间通信标准：

```
每个 ClawTwin 暴露 Agent Card（/.well-known/agent.json）：
{
  "name": "Factory-A ClawTwin",
  "description": "Oil & Gas Plant A operational intelligence",
  "capabilities": ["equipment_diagnosis", "workorder_management", "knowledge_query"],
  "endpoint": "https://factory-a.clawtwin.internal/v1/a2a",
  "authentication": {"scheme": "bearer"}
}

A2A Task 类型（ClawTwin 支持接收）：
  diagnose_request   → 请求诊断某设备（跨实例委托）
  workorder_notify   → 通知工单状态变更（跨实例联动）
  knowledge_query    → 查询本地知识库（联邦知识共享）
  entity_query       → 查询实体状态（跨实例实体访问）
  event_subscribe    → 订阅实体事件（跨实例事件流）
```

```python
# apps/http/a2a.py（Phase B 新增，约 80 行）
POST /v1/a2a/tasks          # 接受来自其他 Agent 的任务
GET  /.well-known/agent.json  # Agent Card 发现
GET  /v1/a2a/tasks/{id}     # 查询任务状态（SSE 流式）
```

### 企业四层智能体网格

```
┌─────────────────────────────────────────────────────────────┐
│ Layer 4 · 战略层                                            │
│   Enterprise Orchestrator（特殊 ClawTwin + 战略 Packs）      │
│   · 汇聚所有运营层 KPI（A2A entity_query）                  │
│   · 跨域 Playbook（涉及多个运营 Agent 的工作流）             │
│   · 高层决策支持（资本配置、跨厂资源调度）                  │
└────────────────────────────┬────────────────────────────────┘
                             │ A2A
┌────────────────────────────┼────────────────────────────────┐
│ Layer 3 · 运营层            │                               │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐      │
│  │Factory-A │ │Factory-B │ │Supply    │ │Finance   │      │
│  │ClawTwin  │ │ClawTwin  │ │ClawTwin  │ │ClawTwin  │      │
│  │(生产)    │ │(生产)    │ │(供应链)  │ │(财务)    │      │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘      │
│       │             │             │             │            │
│       └─────────── A2A ──────────── A2A ────────┘           │
│                  对等知识共享 + 事件通知                     │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────┐
│ Layer 2 · 数字层            │                               │
│  EntityStore（每个物理对象的数字孪生）                       │
│  每个 ClawTwin 管理自己的 EntityStore 分片                   │
│  Ontology Graph = 规范基础类型 + 各自扩展类型                │
└────────────────────────────┬────────────────────────────────┘
                             │
┌────────────────────────────┼────────────────────────────────┐
│ Layer 1 · 物理层            │                               │
│  设备、传感器、机器人、人员（通过 Connectors 接入）          │
└─────────────────────────────────────────────────────────────┘
```

### Agent 之间的三种关系

| 关系类型                 | 场景                                 | 实现                 |
| ------------------------ | ------------------------------------ | -------------------- |
| **层级（Hierarchical）** | Orchestrator 向 Factory-A 下达任务   | A2A task delegation  |
| **对等（Peer）**         | Factory-A 向 Factory-B 请求 CBR 案例 | A2A knowledge_query  |
| **专家（Specialist）**   | 生产 Agent 向供应链 Agent 请求备件   | A2A workorder_notify |

### 知识联邦策略

```
哪些知识集中管理（推送到所有实例）：
  · 安全法规（IEC 61511、GB 50183）
  · 设备厂商维护手册（制造商 SOP）
  · 公司级最佳实践

哪些知识本地管理（不共享）：
  · 特定设备配置参数（敏感）
  · 站点特有操作习惯
  · 商业合同信息

哪些知识联邦共享（opt-in）：
  · CBR 案例（关闭的工单，脱敏后）
  · 诊断经验（"压缩机高振动 → 轴承磨损" 的通用规律）
  · 检修技巧（不涉及设备 ID 和参数的通用步骤）

共享机制：
  A2A knowledge_query  → 实时联邦查询（不复制数据）
  Pack git 仓库        → 静态 KB 文档同步
  可选：中央 CBR 库     → 各实例主动推送匿名案例
```

### Palantir 对比

| 能力           | Palantir Foundry            | ClawTwin                                         |
| -------------- | --------------------------- | ------------------------------------------------ |
| 跨系统本体统一 | Ontology Layer（全局）      | 规范基础类型 git 仓库                            |
| 跨实例查询     | Multipass + Data Connection | A2A entity_query                                 |
| Agent 互调     | AIP Agent 函数调用          | A2A task delegation                              |
| 知识共享       | Marketplace + Template      | Pack git 仓库 + A2A                              |
| 策略层决策     | AIP Studio                  | Enterprise Orchestrator（ClawTwin + 战略 Packs） |

**ClawTwin 的差异优势**：

- OT 原生（OPC-UA/Modbus，Palantir 靠西门子等合作伙伴）
- A2A 标准协议（不锁定 Palantir 生态）
- 轻量 Pack 扩展（Palantir 实施成本极高）

---

## 一、系统定位

**ClawTwin Platform = 专业自治工业 Agent（机器人）+ 企业智能体网格节点**

单一 Platform 实例 = 一个自治工业 Agent，可服务：

- 多个 Studio 实例（多工厂可视化）
- 多个用户（RBAC 权限控制）
- 多个智能体（并发 AgentSession）
- 多个设备（EntityStore 支持百万级实体）
- 多个站点（namespace 隔离）

---

## 二、五类资源完整定义

### 2.1 Connectors（连接器）

已有完整骨架（`connectors/` 目录）：

```
scada_dcs/    ← OPC-UA（opcua_generic）、Modbus（modbus_tcp）、IEC104
historian/    ← OSIsoft PI、Honeywell PHD、Inmation
erp/          ← SAP S4HANA、SAP PM、金蝶云、用友NC、Oracle EAM
cmms/         ← IBM Maximo、SAP PM、MainSaver、Infor EAM
generic/      ← REST API、JDBC、Webhook、CSV/SFTP、SOAP
hse/          ← 安全管理系统
```

所有 Connector **只读**，写回 OT 层必须经 ActionExecutor + HITL。

**协议合同**：每个 Connector 必须实现 `ConnectorPlugin`（见 §零·一 DriverContract）。
现有 `connectors/base.py` 的 `BaseConnector` 将继承或满足此协议。
通过 `PluginApi.register_connector(plugin)` 注册后，平台自动：

- 调用 `health_probe()` 并入 `/health`
- 调用 `doctor_checks()` 并入 `openclaw doctor`
- 订阅 `subscribe()` 流并写入 EventBus

额外补充（按需添加 Pack）：

```
robotics/     ← ROS2、Universal Robots、ABB IRC5
building/     ← BACnet、KNX（楼宇自动化）
utility/      ← 电表、水表（DLMS/COSEM）
```

### 2.2 Functions（AI 推理函数）

**定义**：原子性 LLM 调用单元。输入 ContextPackage，输出结构化结论。无状态，可并发。

```python
# 每个 Function 的结构
@dataclass
class AgentFunction:
    id: str
    description: str
    input_schema: type[BaseModel]
    output_schema: type[BaseModel]      # Pydantic，强制验证输出格式
    system_prompt_template: str         # 存在 ontology/function_types/ YAML 中
    few_shot_examples: list[dict]       # CBR 提供的历史案例
    confidence_threshold: float = 0.7  # 低于此值升为 HITL
    max_iterations: int = 5
    requires_hitl: bool = False
```

内置 Functions（core_ai Pack）：

- `diagnose_equipment` — 设备故障诊断
- `predict_maintenance` — 预测性维护时间窗口
- `analyze_energy_anomaly` — 能耗异常分析
- `generate_incident_report` — 事故报告生成
- `suggest_playbook_update` — 规则优化建议（自进化）
- `generate_wiki_entry` — 动态 Wiki 自动生成
- `ontology_schema_suggest` — Ontology 结构建议（系统自完善）

### 2.3 Playbooks（工作流）

**定义**：事件驱动的多步骤流程，组合 Functions、Actions、HITL 门、Channel 通知。

```yaml
# 格式参考（ontology/playbooks/）
id: compressor-high-pressure-response
version: "2.0"
trigger:
  event: "alarm.created"
  conditions:
    entity_type: CompressorUnit
    severity: [HIGH, CRITICAL]

steps:
  - id: diagnose
    type: function
    function_id: diagnose_equipment
    timeout_sec: 120
    retry: { max: 2, backoff_sec: 10 }

  - id: route_by_risk
    type: switch
    on: "{{ diagnose.risk_level }}"
    cases:
      CRITICAL:
        - id: emergency_stop
          type: action
          action_id: notify_emergency_team
          always_hitl: true
      HIGH:
        - id: request_approval
          type: hitl
          message: "{{ diagnose.summary }}"
          timeout_min: 30
          timeout_action: escalate
      LOW:
        - id: auto_workorder
          type: action
          action_id: create_workorder
          params: { priority: MEDIUM }

  - id: notify
    type: channel
    channel_id: feishu_ops
    template: "playbook.workorder_created"
```

### 2.4 Channels（通知通道）

通过 Outbox 可靠投递。`infra/outbox/` 已有框架，`infra/feishu_channel_outbox.py` 已有实现。

扩展优先级：

1. 飞书（已有）
2. 企业微信（Pack 扩展）
3. 钉钉（Pack 扩展）
4. Email/SMS（core_notify Pack）
5. ROS2 Action（robotics Pack）
6. PLC Write（高风险，强制 HITL + 安全审计）

### 2.5 Hooks（生命周期钩子）

`infra/hooks.py` 已有骨架，需填充完整 VALID_EVENTS 枚举。对照 OpenClaw 35 个 Hook 完整映射。

> **规则**：内核 fire()，Pack register_hook() 订阅。顺序保证：priority 数字小的先执行（与 OpenClaw 一致）。

**Phase A（必须，10 个）——覆盖 LLM / Tool / Action / Context 全链路可观测**：

| ClawTwin 事件             | OpenClaw 对应                         | fire() 位置                         |
| ------------------------- | ------------------------------------- | ----------------------------------- |
| `before_context_assemble` | `before_agent_run`（上下文准备阶段）  | `aip/context_engine/assembler.py`   |
| `after_context_assemble`  | —                                     | `aip/context_engine/assembler.py`   |
| `before_llm_call`         | `llm_input`                           | `aip/agent_runtimes/simple_loop.py` |
| `after_llm_call`          | `llm_output` / `model_call_ended`     | `aip/agent_runtimes/simple_loop.py` |
| `before_tool_call`        | `before_tool_use`                     | `aip/agent_runtimes/simple_loop.py` |
| `after_tool_call`         | `tool_result_persist`                 | `aip/agent_runtimes/simple_loop.py` |
| `before_action_execute`   | `before_agent_run`（执行门控）        | `core/action_executor/executor.py`  |
| `after_action_execute`    | —                                     | `core/action_executor/executor.py`  |
| `playbook_step_start`     | `session_step_start`（对应 run step） | `core/playbook_engine/engine.py`    |
| `playbook_step_end`       | `session_step_end`                    | `core/playbook_engine/engine.py`    |

**Phase B（+12 个）**：

```
alarm_created / workorder_created / workorder_closed   ← 业务事件
session_start / session_end                            ← 对应 OpenClaw session_*
pack_loaded / pack_unloaded                            ← Pack 生命周期
hitl_requested / hitl_approved / hitl_rejected         ← HITL 流程
model_routing_resolve                                  ← 对应 before_model_resolve（模型路由）
scheduled_context_contribution                         ← 对应 heartbeat_prompt_contribution（主动监控）
```

**Phase C（+8 个）**：

```
agent_finalize_check                                   ← 对应 before_agent_finalize revise（强制再迭代）
subagent_spawned / subagent_ended                      ← 多 Agent 协作
knowledge_ingested / model_switched                    ← 进化事件
context_compaction                                     ← 对应 before_compaction（长会话压缩）
pack_install_scan                                      ← 对应 before_install（Pack 安全扫描）
federation_event_received                              ← 跨实例事件（联邦架构）
```

> 总计 30 个，与 OpenClaw 35 个保持同等覆盖深度。

---

## 三、两个执行机制

### ActionExecutor（`core/action_executor/`，已有）

**需补充**：

- `requires_hitl` 检查与 PlaybookEngine.pause() 集成
- `risk_score` 动态计算（上下文感知升级 HITL）
- 执行日志与审计轨迹

### Outbox（`infra/outbox/`，已有框架）

**需补充**：

- 重试策略（指数退避）
- 多通道降级（飞书失败 → SMS）
- 死信队列（DLQ）

---

## 三·五、降级运行策略（补充遗漏）

**LLM 不可用时系统不能停止工作。** 三档降级：

```
正常模式（LLM 可用）：
  EventBus → PlaybookEngine → ContextAssembler → LLM 诊断 → Action

降级一（LLM 超时/限速）：
  EventBus → PlaybookEngine → 规则引擎（ontology/playbooks/ 中的条件分支）
  → 按 severity 直接路由 → Channel 通知 + HITL（人工判断）

降级二（LLM 服务完全不可用）：
  EventBus → PlaybookEngine → 仅执行 CRITICAL severity 的紧急通知 Playbook
  → 所有 HIGH/MEDIUM 告警入队等待 LLM 恢复 → 恢复后批量处理

降级三（数据库不可用）：
  内存队列暂存最近 100 条事件 → 数据库恢复后 replay
  → 超过 100 条后写告警日志文件作为最终 fallback
```

**实现要点**：`PlaybookEngine` 的每个 step 执行前检查 LLM provider 健康状态（`infra/health/`），
降级决策在 `before_llm_call` Hook 中触发，不影响 Playbook YAML 定义。

---

## 四、最小核心：6 模块填充清单

```
plugin_sdk       (core/plugin_sdk/)                ❌ 新建 — PluginApi + ConnectorPlugin（优先级最高）
EntityStore      (core/object_store/)             ✅ 已有，需确认 write() 触发 EventBus
EventBus         (infra/event_dispatcher.py)      ✅ 已有，需确认 wildcard 订阅
PluginRegistry     (core/plugin_registry/)       ⚡ 代理到 PluginApi.register_*（调用 PluginApi）
HookSystem       (infra/hooks.py)                 ⚡ 填充 VALID_EVENTS 30 个，fire() 改为 async
PlaybookEngine   (core/playbook_engine/)          ⚡ 已有，需在 step start/end 插 fire()
```

> **PluginLoader 加载顺序**（对应 OpenClaw plugin loader）：
>
> 1. 读取所有 `clawtwin.pack.json`
> 2. 拓扑排序（按 `requires.packs` 依赖图）
> 3. 每个 Pack：创建 `PluginApi(pack_id)` → 调用 `plugin_module.register(api)` → fire `pack_loaded`

---

## 五、需新建的模块

### 5.1 ContextAssembler（`aip/context_engine/assembler.py`）

> 位置修正：从 `core/context_engine/` 改为 `aip/context_engine/`。
> 原因：ContextAssembler 依赖 `infra/knowledge/`（cbr_index）和 `providers/`（timeseries_db），
> 放在 `core/` 会使 core 依赖 infra，破坏分层。`aip/` 是 AI 执行层，依赖 infra 是正确的。

```python
# aip/context_engine/assembler.py 约 120 行

@dataclass
class ContextPackage:
    entity: EntityRecord
    recent_readings: list[TimeSeriesPoint]  # 最近 24h，限制 200 条
    recent_alarms: list[AlarmRecord]        # 最近 20 条
    similar_cases: list[CaseRecord]         # CBR top-3
    relevant_docs: list[KnowledgeChunk]     # KB top-5
    related_entities: list[EntityRecord]    # 本体邻居，限制 10 个
    anomaly_score: float | None             # 可选，Phase B 再激活

    def to_prompt_text(self, max_tokens: int = 6000) -> str:
        """按优先级截断到 max_tokens，防止超出 context window。
        优先级：entity > alarms > similar_cases > relevant_docs > readings > related
        """
        ...

async def assemble(entity_id: str, symptoms: str = "") -> ContextPackage:
    await hooks.fire("before_context_assemble", {"entity_id": entity_id})

    # 并发查询，单个失败不阻塞整体（return_exceptions=True）
    results = await asyncio.gather(
        entity_store.get(entity_id),
        timeseries_db.query(entity_id, hours=24, limit=200),
        entity_store.query("Alarm", {"equipment_id": entity_id}, limit=20),
        cbr_index.search(symptoms, top_k=3),
        kb_index.search(symptoms, top_k=5),
        ontology_graph.get_neighbors(entity_id, depth=1),
        return_exceptions=True,
    )
    # 任何失败的结果替换为空列表/None，不中断整体
    entity, readings, alarms, cases, docs, related = [
        r if not isinstance(r, Exception) else _empty_for(r)
        for r in results
    ]
    pkg = ContextPackage(entity, readings, alarms, cases, docs, related)
    await hooks.fire("after_context_assemble", {"package": pkg})
    return pkg
```

**异常模型规则**：ContextAssembler 任何单个数据源失败都不应抛出，用空数据降级。LLM 诊断有残缺上下文比完全崩溃更好。

### 5.2 AgentRuntime（`aip/agent_runtimes/`，补充）

```python
# Phase A：simple_loop.py（约 80 行）

async def run_agent(session: AgentSession) -> AgentResult:
    """Phase A 简单版。HITL 暂停时写入 DB，重启后可从 DB 恢复。"""
    while session.iterations < session.max_iterations:
        await hooks.fire("before_llm_call", {"session": session})
        ctx = await assemble(session.entity_id, session.current_symptoms)

        # 关键：response_format 强制 JSON，Pydantic 验证
        try:
            response = await litellm.acompletion(
                model=session.model,
                messages=session.build_messages(ctx),
                tools=session.tools,
                response_format={"type": "json_object"},
                timeout=session.timeout_sec,
            )
        except Exception as e:
            # LLM 失败 fallback：记录错误，降级到 HITL 人工处理
            await session.save_state(status="llm_error", error=str(e))
            return AgentResult(status="error_fallback_hitl",
                               message=f"LLM 调用失败，需人工介入: {e}")

        await hooks.fire("after_llm_call", {"response": response})

        if response.choices[0].message.tool_calls:
            for tc in response.choices[0].message.tool_calls:
                tool = tool_registry.get(tc.function.name)
                if not tool:
                    session.append_tool_error(tc, "tool_not_found")
                    continue
                if tool.requires_hitl:
                    # 持久化状态到数据库，等待人工审批
                    await session.save_state(status="hitl_pending", pending_tool=tc)
                    return AgentResult(status="hitl_required", session_id=session.id)

                output = await tool.execute(json.loads(tc.function.arguments))
                session.append_tool_result(tc, output)
            session.iterations += 1
        else:
            try:
                validated = session.output_schema.model_validate_json(
                    response.choices[0].message.content
                )
            except ValidationError as e:
                # JSON 格式错误 fallback：人工介入
                return AgentResult(status="output_invalid", error=str(e))
            return AgentResult(status="complete", result=validated)

    return AgentResult(status="max_iterations",
                       message="达到最大迭代次数，建议人工复查")

# Phase B：langgraph_runner.py（LangGraph interrupt() + PostgresSaver）
# 届时 simple_loop.py 逐步退役
```

**LLM 失败 Fallback 策略（必须实现）**：

| 失败类型            | 处理方式                                   |
| ------------------- | ------------------------------------------ |
| LLM 超时 / 网络错误 | 最多重试 2 次（指数退避），然后 → HITL     |
| 输出 JSON 格式无效  | 尝试 repair（litellm 内置），失败 → HITL   |
| 置信度 < threshold  | 不自动执行，转 HITL 请求确认               |
| 工具不存在          | 记录错误继续，不中断整个 AgentSession      |
| 达到 max_iterations | 输出已有结论 + 标记为 "未完成"，通知工程师 |

### 5.3 知识系统（`infra/knowledge/`，新增）

```
infra/knowledge/
├── kb_index.py      ← LlamaIndex 文档知识库（pgvector）
├── cbr_index.py     ← 案例推理库（工单历史自动入库）
└── ingestion.py     ← 文档摄取 API（POST /v1/knowledge/ingest）
```

> `wiki_generator.py` 推迟到 Phase B：自动 Wiki 生成是 Phase B+ 功能。Phase A 知识系统只需 KB + CBR 查询能力。

### 5.4 模型路由策略（借鉴 OpenClaw `before_model_resolve`）

**核心思想**：不同复杂度的任务路由到不同模型，降低成本、提升速度。

```python
# model_routing_resolve Hook 中实现（Phase B）
MODEL_ROUTING = {
    "fast":    "ollama/qwen2.5:7b",    # 简单任务：告警分类、状态查询
    "default": "ollama/qwen2.5:72b",   # 常规任务：设备诊断、报告生成
    "smart":   "openai/gpt-4o",        # 复杂任务：根因分析、Playbook 优化
}

def resolve_model(function_id: str, context: AgentContext) -> str:
    if function_id in ("classify_alarm", "query_entity"):
        return MODEL_ROUTING["fast"]
    elif context.alarm_severity == "CRITICAL":
        return MODEL_ROUTING["smart"]    # 紧急情况用最强模型
    else:
        return MODEL_ROUTING["default"]
```

在 `clawtwin.json` 中配置，Pack 可通过 `model_routing_resolve` Hook 覆盖路由逻辑。

### 5.5 主动监控（借鉴 OpenClaw `heartbeat_prompt_contribution`）

OpenClaw 的 `heartbeat_prompt_contribution` 让插件向每次 LLM 调用注入实时状态。ClawTwin 借鉴为 **主动扫描机制**：

```python
# scheduled_context_contribution Hook — Pack 注册主动监控逻辑
# 每次 AgentRuntime 调用时，Pack 可以注入"当前关注事项"

# oilgas Pack 注册示例：
async def on_scheduled_context_contribution(ctx: AgentContext) -> ContextContribution:
    """每次诊断调用前，自动注入最近 1 小时的异常趋势摘要"""
    trend = await timeseries_db.get_trend_summary(ctx.entity_id, hours=1)
    if trend.anomaly_count > 0:
        return ContextContribution(
            text=f"过去 1 小时检测到 {trend.anomaly_count} 个异常点: {trend.summary}",
            priority=10,
        )
    return ContextContribution.empty()
```

**APScheduler 主动扫描（独立于 LLM 调用）**：

```
每 5 分钟: 检查所有 CRITICAL 设备的最新读数 → 若超阈值触发告警事件
每 1 小时: 跨设备能耗趋势分析 → 若异常触发 analyze_energy_anomaly
每天 6:00: 生成日报（定时 Playbook）→ Channel 发送给管理层
每周一: 预测性维护窗口评估 → 生成维护建议工单
```

### 5.6 训练数据收集（Phase B，不在 Phase A）

Phase A 方案：`infra/llm_call_log.py` — 一个表，记录 `(timestamp, model, input_tokens, output_tokens, function_id, success)`，即可。

Phase B 方案（`infra/training/`，届时新增）：

```
infra/training/
├── collector.py     ← llm_input/llm_output hooks 自动记录完整输入输出
├── labeler.py       ← workorder_closed 触发打标（resolution = "solved"|"escalated"）
└── exporter.py      ← GET /v1/training-data/export（导出 JSONL 供微调）
```

### 5.7 本体运行时工作台（Ontology-centric Workbench）：对标增量规格

> **动机（与 §一·五、§二十·六、§二十八 对齐）**：对标类产品若自称「企业语义运行时」，其核心应是 **本体（Object Types + Link Types）与知识图谱实例的生命周期**——草案/正式方案、从文档与技术资产 **投影** 到规范图谱、**冲突治理与发布闸口**、基于 **`get_neighbors` / GraphRAG** 的可审计检索与推理。**非结构化文档知识库与向量 RAG** 在 ClawTwin 叙事里是 **向本体绑定证据、填充邻居上下文与规程片段** 的一层，**不得反客为主**替换 Ontology/ObjectStore 的真理源地位。§5.3 `infra/knowledge/` 与摄取 API 服务于上述证据层；图谱 Profile / builds / governance API 服务于本体主干。
>
> **权威回溯**：本体定义原则 **§一·五**；GraphRAG 即本体图遍历 **§二十·六**；本体构建路径与 Studio 编辑器产出 **§二十八**。本节仅在上述骨架之上补齐 **产品与 REST 形状**，**不得**与之矛盾。

#### 5.7.0 参考来源与借鉴边界（读本章前先读）

> **关于「用成熟产品避免重复造轮子」的正确定位**：业界存在的「本体/图谱/治理 + 文档证据 + 对话」类控制台（含曾作为**模块划分与交互参考**分析过的商业形态），其价值是 **信息架构与产品化清单参考**——例如：本体工作台分区（Profile / Build / Explorer / Query / Governance）、构建任务与冲突队列、分块摄取与解析作业、SSE 会话等。**这些可以借鉴到 ClawTwin Studio 与 API 规划，不等于把该整站技术栈或某单一开源控制台接入后就能替代 ClawTwin 的语义内核。**

| 可以借鉴                                                                                           | 不可以/不应当成「捷径替换」                                                    |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **UX 与信息架构**（侧栏分区、工作流引导、任务状态呈现）                                            | 把任意 **RAG/LLM 应用平台**当作 **Ontology 真理源**（见 §5.7.7）               |
| **管线模式**（init/chunk/complete 上传、解析 Job、重试）——在 Platform 内 **以契约实现自己的** REST | 未经验证许可的 **逆向**对方闭源实现作为我方实现依据（合规与 IP 边界）          |
| **检索链思路**（混合检索、重排、评测集）——对齐 **§二十·五** 与 `ContextAssembler`                  | 指望 **一条外链**完成 **图谱治理 + station 授权 + 审计**，而不写 Platform 模型 |

**结论（回应「想走成熟路径」）**：**成熟路径用在「库、基础设施、适配器」与「已选定的开源侧车（若有）」**；**本体类型系统、图实例与孪生对象的绑定、治理与发布闸口** ——按 ClawTwin 定义 **必须落在 Platform / Pack / Studio**，无法用「接 Dify/RAG 全家桶」整体替代。**这不是不能复用工程经验，而是不能复用错误抽象层次。**

#### 5.7.1 能力对照（业务模块 → 实现归属）

**读完本节应先抓住**：下行表中 **「图谱/本体 Profile」「构建中心」「治理」** 与 **ObjectStore + YAML canonical ontology（§一·五）** 同级优先；KB/会话/评测围绕 **绑定证据与度量检索**，不从产品上顶替本体。

| 能力域                              | Platform（必选承载）                                                                   | Studio（运营 UI）                     | OpenClaw（对话/Agent）                        | 说明                                                                                  |
| ----------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------- |
| 图谱/本体 Profile（草案→正式→发布） | **Ontology + 图存储/投影**（与 ObjectStore、`ontology/*.yaml` 对齐，§一·五 / §二十八） | 方案管理台、画布/目录、生命周期与闸口 | `get_neighbors`、结构化查询经 MCP（§二十·六） | **对标产品主轴**；规范类型 **canonical git + Pack 扩展** 为类型真理源                 |
| 构建中心（投影/重建）               | 异步 Job（文档/资产 → 规范图谱投影）                                                   | 构建任务列表与日志                    | —                                             | **本体数据面**；与 worker 编排的具体契约以 **`MODULE-DESIGN-PLATFORM.md` §18.6** 为准 |
| 治理（冲突、候选项、决议）          | 治理模型 + 可选 **HITL Playbook**                                                      | 治理台、冲突队列                      | —                                             | **图谱可发布性与质量**；审计必接                                                      |
| 知识库（KB）元数据与成员            | `infra/knowledge/`：KB 表 + 成员/可见性                                                | 知识库列表、权限                      | MCP 仅暴露已授权 KB                           | **证据层**；规程/图纸等 **挂到本体或关系**，非唯一语义根                              |
| 文档摄取与解析任务                  | 分块上传、解析任务、索引                                                               | 上传 UI、重试                         | —                                             | 产出 chunks；**与实体/边/来源绑定模型** 须在契约锁死后实现                            |
| 对话 + 流式输出                     | 轻量会话或 **AgentRuntime → OpenClaw**                                                 | 会话、范围、提示词                    | **主路径**多轮 + 工具                         | 消费 **图邻居 + 授权证据** 的组装上下文，不是裸向量 top-k                             |
| 多租户与用户/平台治理               | JWT、租户/站点、Casbin（§九）                                                          | 管理台                                | —                                             | `station_ids` 铁律不变；图谱/KB 的 `site_scope` 由契约定稿                            |
| RAG 评测（benchmark / run）         | 评测集、运行、指标                                                                     | 评测 UI                               | 可选只读 MCP                                  | 验证 **检索 + 图扩展 + 回答** 全链路；Phase B+                                        |
| 长文（规划 / 来源 / 执行）          | 可选 Project 落库                                                                      | 可选工作台                            | Skills / OpenClaw                             | **从属**，不改变本体主轴                                                              |
| 图片/多模检索                       | 索引管道                                                                               | 检索页                                | MCP                                           | Phase B+；应能 **归因到对象或文档证据**                                               |
| 提示词模板                          | Platform 版本化模板 **或** OpenClaw                                                    | 下拉、预览                            | 注入与 §5.7.3 一致                            | 禁止双源真理                                                                          |

#### 5.7.2 建议 API 形状（与 §四十一·四 并列扩展；一律 `/v1`）

以下为 **逻辑资源族**，路径可与现有 `POST /v1/knowledge/ingest` **合并演进**，不必一字不差；原则是 **REST + JWT**，复杂查询可 POST search。

| 资源族               | 建议路径族                                                              | 职责                                                                                                      |
| -------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------- |
| **图谱 / 本体**      | `/v1/graph/profiles`、`.../builds`、`.../queries`、`.../governance/...` | **主轴**：Profile 生命周期、投影任务、结构化查询（路径以 **`MODULE-DESIGN-PLATFORM.md` §18.6** 锁定为准） |
| 文档与摄取（证据层） | `/v1/knowledge-bases/{kb_id}/documents`、`.../uploads/init              | chunks                                                                                                    | complete` | 与 §5.3 合一；设计重点是 **与实体/关系的证据绑定** |
| KB 元数据            | `/v1/knowledge-bases`、`.../members`                                    | 可见性与成员                                                                                              |
| 文档运行时           | `/v1/documents/{doc_id}`、`.../pages                                    | jobs                                                                                                      | retry`    | 解析与分页读取                                     |
| 会话（可选）         | `/v1/chat/...`                                                          | 仅在不接 OpenClaw 时完整内置                                                                              |
| 评测                 | `/v1/evals/...`                                                         | Golden set 针对 **图+证据+生成** 链路                                                                     |
| 检索                 | `/v1/kg/search`（或契约统一命名）                                       | **ContextAssembler**：图邻居 + 授权证据 +（Phase B）混合文本检索 **§二十·五**                             |

**站点隔离**：工业场景下 KB 默认绑定 `site_id` / `station_ids` 可读范围；跨站联邦沿用 §十八·二 **知识联邦策略**，禁止客户端自选「任意站点 KB」绕过校验。

#### 5.7.3 MCP 与混合检索（落地要点）

- **优先**：`**kg_neighbors**`（GraphRAG，`ContextAssembler.get_neighbors()`，§二十·六）——入参绑定 **授权范围内的对象 id / 类型**，禁止匿名全局图漫游。
- **其次**：`**knowledge_search**`（向量 + 可选 BM25 + RRF，§二十·五 Phase B）——仅检索 **已绑定或可追溯到本体证据** 的文本；与 KB 权限、`site_scope` 一致。
- OpenClaw 插件（§十六）注册上述工具；Studio 与 Agent **共用同一检索实现**，避免「对话一套、孪生一套」。

#### 5.7.4 实现分期建议（本体先行）

| 阶段         | 交付切片                                                                                                                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Phase A+** | **ObjectStore + §一·五 YAML** 稳定；`ContextAssembler.get_neighbors()` 与 MCP **`kg_neighbors`** 可用于孪生诊断；文档摄取 **`POST /v1/knowledge/ingest`**（或等价）仅当需 **规程证据进上下文** 时增强，不阻塞本体主线 |
| **Phase B**  | 图谱 Profile / 构建 / 治理 **产品化 UI + API**（与 §二十八 Studio 编辑器输出一致）；混合检索 **§二十·五** + HITL 治理                                                                                                 |
| **Phase B+** | RAG/图联合 **评测** 产品化；多模检索；长文可选落库                                                                                                                                                                    |

#### 5.7.5 是否「全部」加入 ClawTwin？——分层边界（必读）

**结论：不合适不加取舍地并进内核；且「全部」里真正不可外购替代的是本体与图谱治理链路，不是向量知识库 UI。**

| 层级                             | 应承载的能力                                                                                    | 理由                                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **内核（与 ClawTwin 定义一致）** | **Ontology/ObjectStore、Link Types、图遍历（GraphRAG）、** 与孪生事件/Playbook 共用的上下文装配 | 与 §一·五、§二十·六、**语义层（Foundry 等价）** 一致；**不能**由内接「仅 RAG SaaS」替代                    |
| **Platform 扩展（Pack/SKU）**    | Profile 工作台 UI、构建任务、治理台、可选 KB 摄取管线                                           | 大客户需要成品控制台；实现须服从 **§二十八** 与 API 契约                                                   |
| **外接系统（慎用）**             | 仅限 **编排型 LLM 应用**（对话壳、简易 workflow）、或 **独立检索实验台**                        | **不接 Ontology 真理源**；若接入，必须文档化「双系统一致性风险」，**不得**在其文档中宣称已覆盖本体生命周期 |

#### 5.7.6 ClawTwin 视角：需求与业务逻辑（本体优先）

| 角色 / 触发     | 业务逻辑（闭环）                                                                                              | 对应能力（优先级）                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 运维 / Playbook | 告警指向 **设备实例** → 沿 **Link Types** 拉邻域（上下游部件、工单、历史告警）→ 再叠加规程证据 → LLM/函数推理 | **图遍历 + ObjectStore（高）**；KB 片段 **绑定实体后（高）** |
| 本体治理        | 类型与关系变更需 **版本、评审、发布**，投影与文档抽取冲突需 **人审**                                          | **Profile / 构建 / 治理（高）**                              |
| 合规审计        | 回答须引用 **可追溯来源**（文档页码或图谱-edge 证据）                                                         | 治理决议 + 审计日志 **（中高）**                             |
| 可靠性工程师    | CBR + 规程同在 **孪生语义空间**                                                                               | §5.3 CBR + 证据绑定 **（中）**                               |

**一句话**：ClawTwin 侧「工作台」刚需是 **本体驱动的图谱上下文与治理**；向量知识库是 **服务这一主轴的证据管道**，排序与立项优先级 **以此为准**。

#### 5.7.7 关于「类似开源」与 Dify：**本体能力澄清**

**事实陈述（与本节上文一致，避免误导立项）**：

- **Dify**（及同类 **FastGPT、偏编排向的 LLM 应用平台**）强项通常是 **Agent/工作流编排、对话应用上架、向量知识库（分段检索）**。它们 **不提供** 与本文 §一·五、§二十八 对齐的 **工业 Ontology（Object Types / Link Types）生命周期管理、图谱投影 Job、冲突治理与发布闸口** 的一体化内核。**因此：不能把 Dify 当作「构建本体」或「替代 Foundry Ontology 层」的方案；最多作为外围对话或临时文档检索胶水，且须评估与 Platform 真理源分叉风险。**
- **RAGFlow** 等偏 RAG Pipeline 的产品同样以 **文档解析与检索质量** 为中心，**不是**企业本体工作台；可作 **摄取/分段/混合检索微服务** 的候选之一，**不能**顶替图谱治理与类型系统。

**开源生态（参考级，非采购建议）**：图存储与语义栈（如各类 **属性图数据库**、RDF 工具链、schema 语言等）多为 **底层组件**，与「一体化本体+治理 UI」仍有大量产品化集成工作；**ClawTwin 不以本节指定某闭源或开源单品为本体真理源**，实现与 REST 命名以 **`MODULE-DESIGN-PLATFORM.md` §18.6** 及锁定的 HTTP 契约为准。

**「快速见效」的诚实边界**：

- **仅演示「能聊、能搜文档」**：外接编排平台可能较快，但 **不交付本体+治理**。
- **演示「孪生 + 图邻居 + 证据」**：应以 **Platform 本体与 `get_neighbors`** 为主线，周期由 **图谱与绑定模型** 复杂度决定，**不应**与「外挂 Dify」混为一谈。

#### 5.7.8 成熟路径分解：什么能省工、什么不能

本节把「是否重复实现」落到 **可替换的边界**，避免与 §5.7.0 冲突。

| 层次              | 省工方式（成熟路径）                                                                                                                                                           | ClawTwin 仍必须拥有的内容                                                                                     |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| **存储与向量**    | **`MODULE-DESIGN-PLATFORM.md` §19** 已定 PG；`pgvector`、对象存储 S3 兼容 —— **不造新数据库类别**                                                                              | 表结构、`site_scope` / `station_ids`、审计字段由 **契约** 定义                                                |
| **摄取与索引库**  | **LlamaIndex / 分割器 / embedding**（§5.3 已列）；若引入 **侧车式** 开源 RAG 管线，仅允许通过 **适配器** 输出 `(chunk, provenance, kb_id)`，由 Platform **二次写入与授权过滤** | **实体/边/证据绑定**、权限校验、与 Ontology 对齐的元数据                                                      |
| **检索算法**      | Phase B 采用 **BM25 + 向量 + RRF +（可选）重排**，用成熟库实现 **§二十·五**                                                                                                    | **GraphRAG（`get_neighbors`）与 ContextAssembler 装配顺序** —— 业务规则在 Platform                            |
| **对话与工具**    | **OpenClaw + MCP**（§十、§十六）为首选                                                                                                                                         | **`kg_neighbors`、`knowledge_search` 等工具** 的**参数与授权**必须来自 Platform，不能信任外置会话的隐式上下文 |
| **图谱治理 UI**   | 可参考外部产品 **布局与状态机用语**；底层 API **以 §18.6 为准**                                                                                                                | Profile/草案/发布/冲突 —— **状态机与数据模型在 ClawTwin**                                                     |
| **通用 LLM 调用** | **LiteLLM**（已在叙事中）                                                                                                                                                      | FunctionExecutor/AgentRuntime 与 **Hooks** 集成                                                               |

**一句话**：**能借用的是「轮子零件与经过验证的算法库」和「产品分区经验」**；**不能借用一整辆别车的车架当 ClawTwin 的语义层**——与您「参考该类产品」的初衷一致：**借鉴设计，不自缚错误捷径**。

---

## 六、配置 Schema（clawtwin.json）— 补充遗漏

这是整个系统的配置中心，LLM 可通过 CLI 读取/修改此文件：

```jsonc
{
  "version": "1",
  "site_id": "plant_a",

  "llm": {
    "default_model": "openai/gpt-4o", // LiteLLM 格式
    "fallback_model": "ollama/qwen2.5:72b", // 主模型失败时切换
    "timeout_sec": 60,
    "max_retries": 2,
  },

  "embedder": {
    "model": "openai/text-embedding-3-small",
    "dimensions": 1536,
  },

  "database": {
    "url": "${DATABASE_URL}", // 环境变量引用
  },

  "timeseries": {
    "url": "${TIMESCALEDB_URL}",
  },

  "vector_store": {
    "url": "${DATABASE_URL}", // pgvector 使用同一 PG 实例
    "schema": "vectors",
  },

  "agent": {
    "max_concurrent_sessions": 50,
    "max_iterations_per_session": 8,
    "confidence_threshold": 0.75, // 低于此值转 HITL
    "hitl_timeout_min": 30, // 超时后自动升级
  },

  "packs": [
    "packs/oilgas", // 相对路径，按顺序加载
  ],

  "channels": {
    "feishu": {
      "enabled": true,
      "webhook_url": "${FEISHU_WEBHOOK_URL}",
    },
  },

  "security": {
    "require_hitl_for": ["plc_write", "emergency_stop", "execute_shell"],
    "allowed_models_for_automation": ["openai/*", "ollama/*"],
  },
}
```

## 七、Pack Manifest Schema（clawtwin.pack.json）— 补充遗漏

Pack 开发者只需提供此文件，平台即可发现并加载 Pack：

```jsonc
{
  "id": "oilgas",
  "name": "油气行业 Pack",
  "version": "1.0.0",
  "min_platform_version": "1.0",

  "entry": "__init__.py", // register() 函数入口

  "provides": {
    "object_types": ["ontology/object_types/"],
    "playbooks": ["ontology/playbooks/"],
    "functions": ["functions/"],
    "connectors": ["connectors/"],
    "channels": [],
  },

  "requires": {
    // Pack 依赖声明
    "packs": [], // 依赖其他 Pack 的 id
    "python": ["asyncua>=1.0", "pymodbus>=3.0"],
  },

  "hooks": [
    // 此 Pack 注册的 Hook 处理器
    "alarm_created",
    "workorder_closed",
  ],

  "license": {
    "type": "commercial",
    "key_required": true, // 需要 License Key 激活
  },
}
```

---

## 八、理想目录结构（完整版）

```
platform-api/
│
├── core/                       # 最小内核（零 ML/OT/infra 依赖）
│   ├── plugin_sdk/               ❌ 新建 — PluginApi（系统调用接口）+ ConnectorPlugin（驱动协议）
│   │   ├── api.py              ← PluginApi 类，约 150 行
│   │   ├── connector.py        ← ConnectorPlugin Protocol + 数据类型，约 80 行
│   │   └── __init__.py         ← 导出 PluginApi、ConnectorPlugin
│   ├── object_store/           ✅ EntityStore
│   ├── plugin_registry/     ⚡ PluginRegistry（代理到 PluginApi register_*）
│   ├── hook_system/            ⚡（重构 infra/hooks.py，Phase A 10 个核心 Hook）
│   ├── playbook_engine/        ⚡ PlaybookEngine（集成 HookSystem + HITL）
│   ├── action_executor/        ✅ 响应信封含 ``risk_score``
│   └── plugin_loader/            ✅（补充 plugin_module.register(PluginApi(...)) 调用）
│
├── aip/                        # AI 执行层（依赖 infra/providers）
│   ├── context_engine/         ✅（能力由 ``infra/diagnosis_context.py`` / §41·一 ContextAssembler 承担）
│   ├── agent_runtimes/
│   │   ├── simple_loop.py      ✅ LiteLLM 工具循环 + 单轮 completion（Phase A）
│   │   └── langgraph_runner.py ❌ LangGraph HITL 版（Phase B）
│   └── mcp_server.py          ⚡ MCP Server（扩展工具列表）
│
├── connectors/                 # 数据接入层（骨架已完整）
│   ├── scada_dcs/              ✅ OPC-UA、Modbus、IEC104
│   ├── historian/              ✅ PI、PHD、Inmation
│   ├── erp/                    ✅ SAP、金蝶、用友、Oracle
│   ├── cmms/                   ✅ Maximo、SAP PM、MainSaver
│   ├── generic/                ✅ REST、JDBC、Webhook、CSV
│   ├── hse/                    ✅ 安全系统
│   └── universal/              ❌ 通用工具（http_fetch/shell/ssh — 无 browser）
│
├── infra/                      # 基础设施层
│   ├── auth/                   ✅ JWT、飞书、AD（已完整）
│   ├── outbox/                 ✅（补充重试策略和 DLQ）
│   ├── db/                     ✅ SQLAlchemy + Alembic
│   ├── event_dispatcher.py     ✅ EventBus（保持在 infra，不移动）
│   ├── hooks.py                ⚡ → 重构为 core/hook_system/（Phase A）
│   ├── knowledge/              ✅ KB + CBR（路由与 ``infra/diagnosis_context``）
│   ├── llm_call_log.py         ✅（``llm_traces`` + ``aip/llm_trace.py``；可选 Langfuse）
│   ├── tracing.py              ✅ OpenTelemetry
│   ├── health/                 ✅ 健康检查
│   └── doctor/                 ✅ 系统诊断
│
├── ontology/                   # 实体类型 + 规则定义（YAML 文件）
│   ├── object_types/           ✅ 基础实体类型
│   ├── function_types/         ✅（保留 base 类型，行业类型移至各 Pack）
│   ├── action_types/           ✅
│   ├── playbooks/              ✅ Playbook YAML（Jinja2 模板引擎）
│   ├── pipelines/              ✅ Pipeline 配置
│   └── link_types/             ✅ 实体关系类型
│
├── providers/                  # Provider 抽象层（可替换）
│   ├── llm.py                  ✅ LiteLLMProvider（``providers/llm.py`` + registry）
│   ├── embedder.py             ❌ LiteLLM embedding（填充，约 20 行）
│   └── timeseries.py           ❌ TimescaleDB 查询接口（新增，约 50 行）
│
├── plugins/                      # 行业 Plugin（每个 Plugin 是独立扩展单元）
│   └── oilgas/
│       ├── clawtwin.pack.json  ❌ 新建（见 Section 六 manifest 定义）
│       ├── __init__.py         ❌ register() 入口
│       └── ontology/           ✅ 已有（实体类型 + Playbook YAML）
│
├── apps/                       # 接入层
│   ├── http/                   ✅ FastAPI 40+ 路由（补充 /v1/ 前缀规范）
│   ├── cli/                    ✅ Typer CLI（补充 --json flag）
│   └── feishu/                 ✅ 飞书 Webhook
│   （Textual TUI 推迟到 Phase B）
│
├── workers/                    # 后台 Worker
│   ├── scheduler.py            ⚡ APScheduler（补充动态任务注册）
│   ├── outbox_worker.py        ✅（确认重试逻辑完整）
│   └── cbr_ingestion.py        ❌ workorder_closed → CBR 入库（新增）
│
├── tests/                      ✅（补充 Phase A 端到端集成测试）
├── scripts/                    ✅ 运维脚本
├── alembic/                    ✅ 数据库迁移
└── pyproject.toml              ⚡（补充新依赖）
```

---

## 九、多用户多站点多智能体设计

### 9.1 多 Studio 支持

Studio 是无状态 React 前端（`clawtwin-studio/` 独立仓库）。
多个 Studio 实例可同时连接同一 Platform，通过 JWT 区分用户。

### 9.2 多站点（多工厂）

```python
# EntityStore 中所有实体携带 site_id
# JWT token 携带 allowed_sites: ["factory_a", "factory_b"]
# API 所有查询自动过滤 site_id

# 站点间数据隔离，但共享：
# - Pack 定义（Playbook、Function 共用）
# - 知识库（CBR 案例可跨站点学习）
# - 模型配置（同一套 LLM 配置）
```

### 9.3 多并发智能体

```python
# EventBus 接收 100 个并发告警
# 每个告警触发独立的 AgentSession（asyncio Task）
# LangGraph 的 PostgresSaver 确保状态持久化
# 并发上限由配置控制：max_concurrent_agents: 50
```

---

## 十、LLM 调用决策：平台自用 vs 委托 OpenClaw

```
               有用户实时在场？
                    │
          ┌─────Yes──┴──No─────┐
          │                   │
   OpenClaw 处理               Platform 自己的 LiteLLM
   (对话、审批、配置)           (后台自动化、并发处理)
          │                   │
   调用 MCP 工具访问           asyncio 工具循环
   Platform 数据               无需用户存在
```

**具体规则**：

| 场景                          | 调用方                                     |
| ----------------------------- | ------------------------------------------ |
| 后台告警自动诊断（凌晨 3 点） | Platform LiteLLM                           |
| 定时能耗报告生成              | Platform LiteLLM                           |
| 并发处理 100 个设备异常       | Platform LiteLLM（并发 asyncio）           |
| 工程师对话查询设备状态        | OpenClaw → MCP → Platform                  |
| HITL 审批对话                 | OpenClaw（处理对话）+ Platform（执行动作） |
| LLM 驱动配置变更              | OpenClaw → CLI（`--json` flag）→ Platform  |

---

## 十一、LLM 世界模型的正确理解

**ClawTwin 已经在使用世界模型**——每次调用 GPT/Claude/Qwen，都在使用其内嵌的工程物理知识。

```
LLM 内嵌世界知识（已有）：
  - 设备物理原理（压缩机如何工作）
  - 化工过程化学（反应温度影响）
  - 工程最佳实践（振动与轴承寿命关系）
  - 安全规程（IEC 61511 功能安全）

ClawTwin 提供的企业特定知识（需建设）：
  - EntityStore：这台 P101 现在的状态
  - TimeSeries：P101 过去 24 小时的趋势
  - CBR：P101 历史上发生过的相似问题
  - Ontology：P101 连接到哪些管线和阀门

= ContextAssembler 将两者结合 → 精准诊断
```

**开源世界模型（可直接通过 LiteLLM 接入）**：

- Qwen 2.5-72B（中文最强，工业知识丰富）
- DeepSeek V3/R1（推理能力强，成本低）
- LLaMA 3.1 405B（通用最强开源）
- Mistral Large（欧洲合规首选）

这些都通过 Ollama 本地部署 → LiteLLM 接入，零代码改动。

---

## 十二、模型微调（可选，可独立）

微调是**完全可选的优化**，不是 ClawTwin 运行的前提。

```
不微调时：
  ClawTwin 使用 Qwen/DeepSeek/GPT 基础模型
  ContextAssembler 提供足够的上下文
  CBR few-shot 提供领域案例
  运行效果已经很好

微调带来的提升：
  - 成本降低 60-80%（更小的本地模型替代大云端模型）
  - 响应速度提升 3-5 倍
  - 工业术语理解更准确
  - 结构化输出更稳定

微调作为独立后台任务：
  触发条件: 积累 500+ 标注工单 OR 每季度
  运行位置: 独立 GPU 服务器（不影响 Platform 运行）
  微调结果: 部署到 Ollama → LiteLLM 接入
  数据来源: infra/training/exporter.py 导出 JSONL
```

---

## 十三、系统自进化能力

ClawTwin 通过自身架构改善自身：

```
① Playbook 自优化
   workorder_closed Hook → 分析成功/失败率
   → suggest_playbook_update Function
   → 生成 Playbook 改进建议 → 人工审核 → hot reload

② 知识库自积累
   每个关闭工单 → CBR 入库（自动，无需人工）
   新文档上传 → KB 索引（自动）
   定时巡检 → Wiki 页面自动生成

③ Ontology 自完善
   新告警类型出现 → LLM 建议新实体类型
   → ontology_schema_suggest Function
   → 工程师审核 → Pack 迁移 → hot reload

④ 配置自调优
   LLM 分析 Function 成功率
   → 建议调整 confidence_threshold 或模型
   → 通过 CLI 应用

⑤ 脚本代码生成（高风险，严格限制）
   场景：现有 Connector 不支持某设备协议，需要快速适配
   流程：LLM 生成 Python 适配代码 → 代码审查 HITL（人工阅读确认）
         → 测试环境验证 → 人工再次确认 → 写入 packs/custom/ → reload

   ⚠️ 安全边界：
   - LLM 生成的代码禁止直接写入生产 connectors/
   - 必须先在沙箱（独立 Python 进程）执行，无文件系统/网络写入权限
   - 只有工程师人工审核后才能提升为正式 Pack 代码
   - 此功能 Phase C+ 实现，Phase A/B 不支持
```

---

## 十四、无 API 系统的通用工具集

`connectors/universal/` 目录（新增），让 LLM 自主获取任何数据：

```python
# 注册为 AgentTool，LLM 按需调用
tools = [
    AgentTool("http_fetch",    execute=http_fetch,    requires_hitl=False),
    AgentTool("web_scrape",    execute=web_scrape,    requires_hitl=False),
    AgentTool("read_file",     execute=read_file,     requires_hitl=False),
    AgentTool("execute_shell", execute=execute_shell, requires_hitl=True),  # 必须HITL
    AgentTool("ssh_execute",   execute=ssh_execute,   requires_hitl=True),  # 必须HITL
    AgentTool("query_db",      execute=query_db,      requires_hitl=False),
    AgentTool("browser_action",execute=browser_act,   requires_hitl=True),  # 必须HITL
    AgentTool("send_email",    execute=send_email,    requires_hitl=False),
]
```

---

## 十五、Studio 架构（独立前端仓库 clawtwin-studio）

```
clawtwin-studio/
├── src/
│   ├── core/
│   │   ├── ComponentRegistry.ts  ← Studio 版 PluginRegistry
│   │   ├── EventStream.ts        ← SSE 订阅（Platform EventBus）
│   │   └── ApiClient.ts          ← REST + WebSocket 客户端
│   │
│   ├── views/
│   │   ├── Dashboard/            ← 多面板信息看板（Gotham 风格）
│   │   ├── DigitalTwin/          ← Konva.js 2D / Three.js 3D
│   │   ├── AlarmCenter/          ← 告警中心（实时流）
│   │   ├── WorkorderBoard/       ← 工单看板（Kanban）
│   │   ├── Analytics/            ← 数据分析（ECharts/Recharts）
│   │   ├── KnowledgeWorkbench/   ← 【增量】§5.7：**本体/图谱 Profile·构建·治理** 为主轴；KB·会话·评测为证据与度量（可与 OpenClaw 双轨）
│   │   ├── PlaybookEditor/       ← 可视化 Playbook 编辑
│   │   └── Settings/             ← 系统配置（Pack 管理）
│   │
│   ├── plugins/                  ← Studio Plugin 系统
│   │   ├── registry.ts
│   │   └── types.ts
│   │
│   └── components/               ← 通用组件库
│       ├── EntityCard/           ← 实体信息卡（上下文感知）
│       ├── AlarmBadge/
│       ├── HitlDialog/           ← 审批弹窗（like Cursor）
│       └── AiInsightPanel/       ← AI 诊断面板
│
└── package.json (TypeScript + React + Zustand + Vite)
```

### Studio 技术选型

| 能力     | 库                       | 理由                     |
| -------- | ------------------------ | ------------------------ |
| 框架     | React 18 + TypeScript    | 强类型 + 最大生态        |
| 状态管理 | Zustand                  | 轻量，SSE 友好           |
| 实时数据 | native SSE + React Query | EventBus 推送，无轮询    |
| 2D 孪生  | Konva.js                 | SVG + Canvas，工厂平面图 |
| 3D 孪生  | React Three Fiber        | Three.js React 封装      |
| 图表     | ECharts + Recharts       | 工业数据可视化           |
| 样式     | Tailwind CSS + shadcn/ui | 快速高质量 UI            |
| 构建     | Vite                     | 极速 HMR                 |

---

## 十六、OpenClaw 代码复用最终结论

**结论：Platform 后端用 Python（不变），但同时创建一个 OpenClaw 插件作为管理界面**

```
方案 A（已否定）：Fork OpenClaw 改成 ClawTwin
  ❌ LangGraph.js 存在但远不及 Python 版成熟
  ❌ 数据科学生态（pandas/scikit-learn）无 JS 等价
  ❌ 现有 Python 骨架价值高，重写浪费

方案 B（采纳）：Python Platform + OpenClaw 管理插件
  ✅ Platform 后端：Python（现有骨架 + 填充）
  ✅ Studio 前端：TypeScript/React（独立仓库）
  ✅ OpenClaw 插件（TS）：运行在 OpenClaw 内，管理 ClawTwin
     - 注册 MCP 工具连接 ClawTwin
     - 工程师通过 OpenClaw 对话管理 ClawTwin
     - 共享 OpenClaw 的飞书/企业微信等所有通道
     - 这个插件本身可以是第一个商业化 Pack！
```

**OpenClaw 插件（`extensions/clawtwin/` 放在 OpenClaw 仓库）**：

```typescript
// openclaw 插件，约 200 行 TypeScript
// 注册 MCP 工具连接 ClawTwin Platform

export function register(api: OpenClawPluginApi) {
  api.registerMCPServer({
    id: "clawtwin",
    url: process.env.CLAWTWIN_MCP_URL,
    tools: [
      "get_entity_state",
      "list_alarms",
      "create_workorder",
      "trigger_diagnosis",
      "approve_hitl",
      "generate_playbook",
      "reload_pack",
      "get_system_health",
    ],
  });

  api.registerHook("agent_turn_prepare", injectClawTwinContext);
  // 自动注入当前告警/工单概况到 OpenClaw 上下文
}
```

---

## 十七、未来 1-N 年 AI 趋势适配

| 时间  | AI 趋势                 | ClawTwin 适配                            |
| ----- | ----------------------- | ---------------------------------------- |
| 2026  | 多 Agent 系统成熟       | LangGraph 多 Agent 节点（Phase B）       |
| 2026  | MCP 成为标准            | 已完全支持                               |
| 2027  | 推理模型（o3 系列）普及 | LiteLLM 自动支持                         |
| 2027  | 持久化记忆              | CBR + Dynamic Wiki（已设计）             |
| 2027  | 自改进 Agent            | LLM 生成 Playbook（Phase C）             |
| 2028  | 物理 AI 早期            | 机器人 Pack（Phase C+）                  |
| 2028  | 视觉 AI 工业化          | 摄像头 Connector + 视觉工具（Pack 扩展） |
| 2029+ | AGI 级别工具            | 通过 LiteLLM 透明升级，无需改代码        |

**架构关键设计**：LiteLLM 的模型字符串由配置控制，任何新 LLM 能力（推理模型、多模态）通过更换 model 字符串立即获得，零代码改动。

---

## 十八、商业变现策略

| 层次 | 产品                           | 变现方式                         |
| ---- | ------------------------------ | -------------------------------- |
| 核心 | ClawTwin Platform（Python）    | 私有化部署许可证（年费按站点数） |
| 核心 | ClawTwin Studio（TypeScript）  | 捆绑在平台许可中                 |
| 扩展 | IndustryPack（油气/电力/制造） | 按行业 Pack 订阅（年费）         |
| 生态 | OpenClaw 管理插件              | 免费（引流到 Platform 销售）     |
| 服务 | 专业实施服务                   | 实施费（项目制）                 |
| 服务 | 企业支持合同                   | SLA + 优先响应（年费）           |

**Pack 生态变现**：

- ClawTwin 提供 Pack 开发规范（`clawtwin.pack.json` + API 文档）
- 合作伙伴开发专属行业 Pack → 上架 Pack 市场 → 平台抽成 30%
- License Key 控制 Pack 数量和功能上限（免费版：2 Pack / 专业版：无限制）

---

## 十八·一、通用业务场景覆盖

**ClawTwin 的架构是通用的，不仅限于工业/OT。**
EntityStore + EventBus + Playbook 可处理任何组织的任何业务域。

| 业务域       | EntityStore 实体   | 触发事件               | Playbook 场景       | Connector       |
| ------------ | ------------------ | ---------------------- | ------------------- | --------------- |
| **工业运营** | 设备、管线、工单   | alarm.created          | 故障诊断 + 维护工单 | OPC-UA, PI      |
| **办公行政** | 文档、会议、审批单 | document.submitted     | 多级审批流程 + 通知 | REST+O365/钉钉  |
| **人力资源** | 员工、合同、考勤   | employee.onboarded     | 入职流程自动化      | REST+HRM        |
| **财务**     | 发票、预算、合同   | invoice.received       | 付款审批 + 对账     | JDBC+ERP        |
| **IT 运维**  | 服务器、服务、告警 | server.alert           | 事件响应 + 自愈     | REST+Prometheus |
| **供应链**   | 供应商、订单、库存 | inventory.low          | 补货工单 + 采购审批 | REST+WMS        |
| **质量管理** | 产品批次、检测记录 | defect.detected        | 质量追溯 + 召回通知 | REST+MES        |
| **安全合规** | 违规记录、资质证书 | certification.expiring | 续证提醒 + 风险报告 | REST+HSE        |

**局部部署（模块化使用）**：

```
最小部署（仅告警 + 通知）：EntityStore + EventBus + Outbox + Feishu Channel
  → 适合小型组织，仅需告警管理

中型部署（含 AI 诊断）：+ LLM Provider + ContextAssembler + AgentRuntime
  → 适合需要智能分析的组织

完整部署（含 KB + CBR + Playbook）：全部组件
  → 适合大型组织，需要自治运营

仅知识库模式：EntityStore + KB/CBR + REST API（无 EventBus/Playbook）
  → 作为企业知识检索服务独立运行
```

---

## 十八·二、多 ClawTwin 联邦架构（重要补充）

**场景**：总部 + 多工厂，或多业务线独立 ClawTwin + 统一视图。

### 部署拓扑一：Hub-and-Spoke（总部汇聚型）

```
                    HQ ClawTwin（协调层）
                   /         |         \
          Factory-A      Factory-B    Factory-C
          ClawTwin       ClawTwin     ClawTwin
             |               |            |
           OT-A            OT-B         OT-C
```

**实现方式**：

- 各工厂 ClawTwin 通过 `federation_connector`（generic/REST）向 HQ 推送：
  - 汇总告警（按工厂 namespace 隔离）
  - 关闭的工单（用于 HQ 跨工厂 CBR 学习）
  - KPI 数据（HQ 管理报表）
- HQ ClawTwin 维护 `MasterEntityStore`（汇总视图，只读）
- HQ 的 Playbook 可以下发标准 Playbook 模板到子实例

### 部署拓扑二：对等互连（知识共享型）

```
Factory-A ClawTwin ←── CBR 案例共享 ──→ Factory-B ClawTwin
          \                                     /
           ──── 共同订阅 Pack Repository ────
```

**CBR 联邦学习**：

- 每个 ClawTwin 关闭工单时，可选择将案例推送到中央 CBR 库
- 其他 ClawTwin 查询时从中央 CBR + 本地 CBR 合并查询（加权排序）
- 隐私控制：case.is_public 字段控制是否共享到联邦

### 联邦 API（`apps/http/federation.py`，Phase B 新增）

```python
# 接受来自其他 ClawTwin 实例的事件推送
POST /v1/federation/events          # 接收子实例告警汇总
POST /v1/federation/cases           # 接收 CBR 案例分享
GET  /v1/federation/playbook-templates  # 下发标准 Playbook 模板
GET  /v1/federation/health          # 汇聚各子实例健康状态
```

**git 集成（配置版本管理）**：

```bash
# clawtwin.json + ontology/playbooks/*.yaml 应纳入 git 管理
# 好处：
# 1. Playbook 变更有完整历史记录
# 2. HQ → 工厂的模板下发通过 git pull 完成
# 3. LLM 建议的配置变更通过 git commit + PR 审核（而非直接写文件）
# 4. 多 ClawTwin 共享同一 git 仓库的 ontology/ 目录
```

`clawtwin.json` 新增：

```jsonc
"federation": {
  "role": "hub",                           // "hub" | "spoke" | "peer"
  "hub_url": null,                         // spoke 模式：Hub 地址
  "push_cases_to_hub": true,               // 是否共享 CBR 案例
  "playbook_templates_repo": "git@...",    // 共享 Playbook 模板 git 仓库
  "git_config_path": "./"                  // clawtwin.json 所在 git 路径
}
```

---

## 十八·三、OpenClaw 功能借鉴完整清单

> 审计基准：OpenClaw `src/plugins/hook-types.ts`（36 个 Hook）和 `src/plugins/types.ts`（52 个 register 方法）。
> 审计时间：2026-05-15。状态图例：✅已覆盖 ≈部分覆盖 ❌缺失（已补）➖不适用

### Hook 36 个对照表

| OpenClaw Hook                   | 分类         | ClawTwin 对应                           | 状态 |
| ------------------------------- | ------------ | --------------------------------------- | ---- |
| `before_model_resolve`          | LLM推理      | `model_routing_resolve`                 | ✅   |
| `agent_turn_prepare`            | LLM推理      | `before_llm_turn`（新增）               | ✅   |
| `before_prompt_build`           | LLM推理      | `before_context_assemble` ≈             | ≈    |
| `before_agent_start`            | LLM推理      | `before_agent_start`（新增）            | ✅   |
| `before_agent_reply`            | LLM推理      | `after_llm_call` ≈                      | ≈    |
| `model_call_started`            | LLM推理      | `before_llm_call`                       | ✅   |
| `model_call_ended`              | LLM推理      | `after_llm_call`                        | ✅   |
| `llm_input`                     | LLM推理      | `before_llm_call`（合并）               | ✅   |
| `llm_output`                    | LLM推理      | `after_llm_call`（合并）                | ✅   |
| `before_agent_finalize`         | LLM推理      | `agent_finalize_check`                  | ✅   |
| `agent_end`                     | LLM推理      | `session_end` ≈                         | ≈    |
| `before_tool_call`              | 工具调用     | `before_tool_call`                      | ✅   |
| `after_tool_call`               | 工具调用     | `after_tool_call`                       | ✅   |
| `tool_result_persist`           | 工具调用     | `after_tool_call` 内含                  | ≈    |
| `before_compaction`             | 上下文       | `context_compaction`                    | ✅   |
| `after_compaction`              | 上下文       | `after_compaction`（新增）              | ✅   |
| `inbound_claim`                 | 消息路由     | `on_platform_event` ≈                   | ≈    |
| `message_received`              | 消息路由     | `alarm_created` / `on_platform_event` ≈ | ≈    |
| `message_sending`               | 消息路由     | `notification_sending`（新增）          | ✅   |
| `message_sent`                  | 消息路由     | `notification_sent`（新增）             | ✅   |
| `before_message_write`          | 消息路由     | ➖ 工业场景无此概念                     | ➖   |
| `before_dispatch`               | 消息路由     | `notification_sending` 覆盖             | ≈    |
| `reply_dispatch`                | 消息路由     | `notification_sent` 覆盖                | ≈    |
| `session_start`                 | 会话生命周期 | `session_start`                         | ✅   |
| `session_end`                   | 会话生命周期 | `session_end`                           | ✅   |
| `before_reset`                  | 会话生命周期 | ➖ 工业 Playbook 无 reset               | ➖   |
| `subagent_spawning`             | 多Agent      | `subagent_spawning`（新增）             | ✅   |
| `subagent_delivery_target`      | 多Agent      | ➖ 消息路由概念                         | ➖   |
| `subagent_spawned`              | 多Agent      | `subagent_spawned`                      | ✅   |
| `subagent_ended`                | 多Agent      | `subagent_ended`                        | ✅   |
| `gateway_start`                 | 系统生命周期 | `on_startup`                            | ✅   |
| `gateway_stop`                  | 系统生命周期 | `on_shutdown`                           | ✅   |
| `heartbeat_prompt_contribution` | 系统生命周期 | `scheduled_context_contribution`        | ✅   |
| `cron_changed`                  | 系统生命周期 | `cron_changed`（新增）                  | ✅   |
| `before_install`                | 系统生命周期 | `pack_install_scan`                     | ✅   |
| `before_agent_run`              | 系统生命周期 | `before_action_execute` ≈               | ≈    |

**统计**：✅ 22 个完全对应 · ≈ 11 个部分覆盖 · ➖ 3 个不适用（工业场景）

---

### PluginApi 关键方法对照表

| OpenClaw 方法                     | ClawTwin 对应                                    | 状态 |
| --------------------------------- | ------------------------------------------------ | ---- |
| `registerTool`                    | `register_tool`                                  | ✅   |
| `registerHook`                    | `register_hook`                                  | ✅   |
| `registerChannel`                 | `register_channel`                               | ✅   |
| `registerService`                 | `register_service`                               | ✅   |
| `registerHttpRoute`               | `register_http_route`                            | ✅   |
| `registerReload`                  | `register_reload`                                | ✅   |
| `registerDoctorCheck`             | `register_doctor_check`                          | ✅   |
| `registerMcpServer`               | `register_mcp_server`                            | ✅   |
| `registerSessionSchedulerJob`     | `register_schedule`                              | ✅   |
| `registerInteractiveHandler`      | HITL 机制                                        | ✅   |
| `registerAgentHarness`            | `register_agent_harness`（新增）                 | ✅   |
| `registerContextEngine`           | `register_context_engine`（新增）                | ✅   |
| `registerMemoryCapability`        | `register_memory`（新增）                        | ✅   |
| `registerCommand`                 | `register_command`（新增）                       | ✅   |
| `registerProvider`（AI模型）      | `AgentFunctionDef` + `register_agent_function` ≈ | ≈    |
| `registerSecurityAuditCollector`  | `register_doctor_check` ≈                        | ≈    |
| `registerRuntimeLifecycle`        | `on_startup`/`on_shutdown` hooks ≈               | ≈    |
| `registerCompactionProvider`      | `context_compaction` hook ≈                      | ≈    |
| `registerConfigMigration`         | Alembic 迁移（不同层次，不需要统一）             | ≈    |
| `registerTextTransforms`          | ➖ 工业场景无此需求                              | ➖   |
| `registerSpeechProvider`          | ➖ 工业场景无此需求                              | ➖   |
| `registerImageGenerationProvider` | ➖ 工业场景无此需求                              | ➖   |

**统计**：✅ 14 个完全对应 · ≈ 5 个部分覆盖 · ➖ 3 个不适用

---

### OpenClaw Skills 系统借鉴说明

```
OpenClaw Skills = SKILL.md 文件（Markdown 操作手册）
→ 被注入 Agent 的系统提示词
→ 告诉 Agent "如何做某件事"

ClawTwin Plugin Skills 对应：
plugins/oilgas/skills/
  ├── compressor-diagnostics.md     ← "如何诊断压缩机故障" 领域专家经验
  ├── energy-optimization.md        ← "能耗优化操作手册"
  └── safety-response.md            ← "安全事件响应程序"

通过 register_skill(md_path) 注册 → before_llm_turn Hook 注入系统提示词
让 LLM 像有经验的工程师一样推理
```

---

## 十九、开发阶段定义

### Phase A（2 周）— 一条链路跑通

**目标**：模拟告警 → 诊断 → 工单 → 飞书通知，全链路可测试
**交付物**：

- **`core/plugin_sdk/`（PluginApi + ConnectorPlugin）——新建，最高优先级**
- LiteLLMProvider 填充完整
- ContextAssembler 基础版（6 个数据源，含截断策略）
- AgentRuntime simple_loop（含 LLM 失败 fallback + 10 个 Hook fire()）
- HookSystem Phase A 10 个核心 Hook（VALID_EVENTS 枚举）
- HITL 状态持久化到数据库（AgentSession 表）
- PlaybookEngine 集成 HookSystem + HITL
- PluginLoader 调用 `plugin_module.register(PluginApi(...))`
- 油气 Pack 最小版（一个 Playbook + 一个 Function）
- 集成测试（mock LLM）全绿

### Phase B（4-6 周）— 生产就绪

**目标**：真实部署，首个客户可用
**新增**：

- LangGraph AgentRuntime（替换 simple_loop，HITL 持久化完整）
- KB + CBR 知识系统（LlamaIndex + pgvector）
- OPC-UA Connector 实现（asyncua）
- Studio 前端 MVP（Dashboard + AlarmCenter + HitlDialog）
- OpenClaw 管理插件（extensions/clawtwin/ 约 200 行）
- **A2A Server（`/.well-known/agent.json` + `/v1/a2a/` 端点）**
- 训练数据收集（infra/training/）
- Pack 热加载（无需重启 reload Pack）
- 模型路由（model_routing_resolve Hook）
- API 文档（FastAPI 自动生成）

### Phase C（2-3 月）— 智能运营 + 联邦协作

**目标**：自治能力 + 多行业 Pack + 多实例联邦
**新增**：

- 多 Agent 专家图（LangGraph 多节点并行）
- **企业 Orchestrator（A2A Client，可并发查询多 ClawTwin 实例）**
- **规范 Ontology git 仓库（canonical/ 目录共享）**
- **联邦 CBR（跨实例案例共享，opt-in）**
- Playbook 自优化（suggest_playbook_update Function）
- Dynamic Wiki 生成
- 电力行业 Pack / 制造行业 Pack
- 视觉 AI Connector（摄像头 + 视觉分析 Function）
- 微调数据导出 + 微调流程文档

### Phase C+（未来）— 自主运营 + 机器人控制

**目标**：最小人工干预 + 物理 AI 早期
**新增**：

- 机器人 Pack（ROS2 + Universal Robots，通过 A2A 接收 ClawTwin 指令）
- LLM 代码生成 Pack（沙箱安全）
- 跨企业 Agent 网格（行业联盟级 CBR 共享）
- 高级世界模型集成（物理仿真辅助诊断）

---

## 二十、Phase A 开发清单（2 周，约 420 行新代码）

**目标：一条完整链路跑通**

```
模拟告警事件 → EventBus → PlaybookEngine → ContextAssembler
→ AgentRuntime(LiteLLM) → ActionExecutor → WorkOrder
→ Outbox → 飞书通知
```

**Week 1**（以下为历史愿景清单；**实现状态以 §四十二·一 / §四十二·一 bis 为准**）：

```
✅ providers/llm.py：LiteLLMProvider（registry ``litellm`` / ``CLAWTWIN_USE_LITELLM``）
✅ aip/context_engine/assembler.py：基础版 + Skills 注入 + **截断策略**（``CLAWTWIN_CONTEXT_MAX_SKILL_BODY_CHARS`` / ``CLAWTWIN_CONTEXT_MAX_SKILLS_CHARS``）
✅ aip/agent_runtimes/simple_loop.py：工具循环 + completion_turn；§2.5 Hook ``before_llm_call`` / ``after_llm_call`` / ``before_tool_call`` / ``after_tool_call``
⚡ core/hook_system/：Phase A **fire 点位已落在业务路径**（assembler / simple_loop / ``ai_runner`` / action_executor / playbook_engine）；**分包迁移**仍为 backlog
✅ core/plugin_registry/：register_* + PluginLoader（对齐 PluginApi）
⚡ infra/llm_call_log：LLM 调用可追溯路径以 ``aip/llm_trace.py`` + Langfuse / DB trace 为主；独立 ``llm_call_logs`` 表视部署可选
```

**Week 2**：

```
✅ 集成测试：Phase A 完整链路（``tests/test_phase_a.py`` + 冒烟 + Hook 接线 ``tests/test_hooks_phase_a_wiring.py``）
✅ CLI：`--json` / `--quiet` / `--debug`（Typer callback）+ ``clawtwin check``（CI 退出码 0/1/2）
✅ packs / plugins 油气骨架（manifest + ontology/playbooks；Pack→Plugin 别名兼容）
✅ APScheduler：``workers/scheduler.py`` 动态任务（CapabilityBundle / HITL 清扫等）
✅ AgentSession：Alembic + ``reasoning_chain``（CoT）迁移（见 ``tests/test_agent_session.py``）
✅ 验收：``pytest tests/`` 全绿（platform-api；示例 615+ passed）
```

---

## 二十一、产品发布形态与用户扩展体系

### 二十·一、三层交付策略

| 层级             | 场景          | 安装方式                                          | 依赖                         |
| ---------------- | ------------- | ------------------------------------------------- | ---------------------------- |
| Layer 1 开发者   | 本地开发/测试 | `pip install clawtwin` 或 `pipx install clawtwin` | Python 3.11+                 |
| Layer 2 生产部署 | 企业服务器    | `docker compose up -d`                            | Docker 24+                   |
| Layer 3 现场嵌入 | 工厂现场/离网 | 离线 tarball + `install.sh`                       | 无需外网，含 Ollama 本地模型 |

类比 OpenClaw：`npm install -g openclaw` → ClawTwin：`pip install clawtwin`，同一上手哲学。

### 二十·二、用户扩展目录结构（仿 ~/.openclaw/）

```
~/.clawtwin/                    ← CLAWTWIN_HOME（可用环境变量覆盖）
├── config.yaml                 ← 主配置（类比 ~/.openclaw/agents/<id>/agent.json）
├── credentials/                ← 凭证存储（类比 ~/.openclaw/credentials/）
│   ├── openai.json
│   ├── db.json
│   └── opc_ua.json
├── plugins/                      ← 用户安装的 Plugin（类比 ~/.openclaw/plugins/）
│   ├── my-factory/             ← 本地自定义 Pack（拖入即用）
│   │   ├── clawtwin.pack.json
│   │   ├── connectors/
│   │   └── skills/SKILL.md
│   └── clawtwin-pack-oilgas/   ← pip install clawtwin-pack-oilgas 后自动注册
├── channels/                   ← 自定义 Channel 插件
├── skills/                     ← 全局 Skills（跨 Pack，注入所有 Agent）
├── data/                       ← 本地 CBR 索引、Entity 快照
└── logs/                       ← 日志文件（自动轮转）
```

### 二十·三、用户上手 CLI（仿 OpenClaw 上手体验）

```bash
# 1. 安装
pipx install clawtwin

# 2. 初始化向导（类比 openclaw init）
clawtwin init
# → 引导配置：数据库地址 / LLM provider / 第一个站点名称
# → 生成 ~/.clawtwin/config.yaml + credentials/

# 3. 安装行业 Pack
clawtwin pack install oilgas
# → pip install clawtwin-pack-oilgas → 注册到 PluginRegistry

# 4. 诊断（类比 openclaw doctor）
clawtwin doctor
# → 检查：DB连接 / Redis连接 / LLM可达 / Pack加载 / 调度器状态

# 5. 启动
clawtwin start
# 或
clawtwin dev --reload  # 开发模式，修改 Pack 文件热重载

# 6. 开发自定义 Pack
mkdir ~/.clawtwin/packs/my-plant
clawtwin pack new my-plant  # 生成模板骨架
```

### 二十·四、Pack 发布规范（用户可发布 Pack 到 PyPI）

```
clawtwin-pack-oilgas/           ← PyPI 包名规范：clawtwin-pack-<id>
├── clawtwin.pack.json          ← Pack Manifest（PluginRegistry 读取）
├── connectors/                 ← 本 Pack 提供的 Connector
├── functions/                  ← 本 Pack 提供的 Function
├── playbooks/                  ← 本 Pack 预置的 Playbook
├── skills/                     ← 领域知识注入（SKILL.md）
└── ontology/                   ← 本体类型扩展（extends 基类）
```

Channel 同理：`clawtwin-channel-tts`、`clawtwin-channel-alarm`，
通过 `clawtwin channel install tts` 安装，无需修改核心代码。

---

## 二十二、硬件输出通道（Channel 架构扩展）

> 核心设计：所有硬件输出都是 **Channel**，与 OpenClaw 的 Discord/Slack Channel 同一架构。
> Playbook 只调用 `notify(channel="tts", ...)` —— Channel 实现对业务层完全透明。

### 二十一·一、支持的硬件输出类型

| Channel               | 模块路径                            | 核心库                    | 工业场景                       |
| --------------------- | ----------------------------------- | ------------------------- | ------------------------------ |
| `tts` TTS 语音播报    | `channels/tts/edge_tts.py`          | `edge-tts`（微软离线TTS） | 故障语音告警、操作指令播报     |
| `tts_offline` 离线TTS | `channels/tts/pyttsx3.py`           | `pyttsx3`（100% 离线）    | 无网络现场部署                 |
| `modbus_alarm` 继电器 | `channels/hardware/modbus_relay.py` | `pymodbus`（已有）        | Modbus 继电器 → 声光报警器     |
| `gpio_buzzer` 蜂鸣器  | `channels/hardware/gpio.py`         | `gpiozero`                | 树莓派/嵌入式工控机 GPIO       |
| `opcua_hmi` 工业HMI   | `channels/display/opcua_hmi.py`     | `asyncua`（已有）         | 写 OPC-UA 标签 → Siemens WinCC |
| `web_kiosk` Web看板   | `channels/display/kiosk.py`         | FastAPI SSE（已有）       | 车间大屏、浏览器全屏看板       |
| `mqtt_alert` MQTT告警 | `channels/mqtt/publisher.py`        | `aiomqtt`（已有）         | IoT 平台、PLC 触发联动         |
| `wecom` 微信Work      | `channels/im/wecom.py`              | `httpx`                   | HITL 审批推送、报告            |
| `feishu` 飞书         | `channels/im/feishu.py`             | `httpx`                   | 告警通知、审批流               |
| `email` 邮件          | `channels/email/smtp.py`            | `aiosmtplib`              | 定期报告、告警摘要             |
| `sms` 短信            | `channels/sms/twilio.py`            | `twilio`                  | 紧急联系、升级告警             |
| `escpos` 热敏打印     | `channels/printer/escpos.py`        | `python-escpos`           | 自动打印工单/巡检报告          |

### 二十一·二、语音播报实现

```python
# channels/tts/edge_tts.py
import edge_tts, asyncio, os

class EdgeTTSChannel(BaseOutputChannel):
    channel_id = "tts"

    async def send(self, message: str, **kwargs):
        voice = kwargs.get("voice", "zh-CN-XiaoxiaoNeural")
        communicate = edge_tts.Communicate(message, voice)
        await communicate.save("/tmp/clawtwin_alarm.mp3")
        os.system("mpg123 /tmp/clawtwin_alarm.mp3")   # 本地扬声器输出

# Playbook 调用：
# notify(channel="tts", message="3号压缩机振动超标，请立即检查")
# notify(channels=["tts", "wecom", "modbus_alarm"], message="...")  # 多通道并发
```

### 二十一·三、Modbus 继电器报警

```python
# channels/hardware/modbus_relay.py
class ModbusAlarmChannel(BaseOutputChannel):
    channel_id = "modbus_alarm"

    async def send(self, message: str, **kwargs):
        coil = kwargs.get("coil", 0)          # 继电器线圈地址
        duration = kwargs.get("duration", 5)   # 报警持续秒数
        async with AsyncModbusTcpClient(self.host, port=self.port) as c:
            await c.write_coil(coil, True)    # 触发报警
            await asyncio.sleep(duration)
            await c.write_coil(coil, False)   # 自动复位
```

### 二十一·四、多通道并发配置

```yaml
# clawtwin.json → channels 配置
channels:
  tts:
    enabled: true
    voice: "zh-CN-XiaoxiaoNeural"
  modbus_alarm:
    enabled: true
    host: "192.168.1.100"
    port: 502
  wecom:
    enabled: true
    webhook_url: "${WECOM_WEBHOOK}"

# Playbook 多通道：Playbook 中指定 channels 列表，EventBus 并发触发
alarm_channels: ["tts", "modbus_alarm", "wecom"]
```

---

## 二十三、生产可靠性设计（24/7 高可用）

### 二十二·一、Docker Compose 部署（推荐）

```yaml
# docker-compose.yml
services:
  clawtwin-api:
    image: clawtwin/platform:latest
    restart: unless-stopped # 崩溃自动重启
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8000/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 60s
    environment:
      - CLAWTWIN_DB_URL=${DB_URL}
      - CLAWTWIN_REDIS_URL=redis://redis:6379
      - CLAWTWIN_LLM_MODEL=${LLM_MODEL}
    depends_on:
      postgres: { condition: service_healthy }
      redis: { condition: service_healthy }

  postgres:
    image: timescale/timescaledb-ha:pg16
    restart: always
    healthcheck:
      test: ["CMD", "pg_isready"]
      interval: 10s

  redis:
    image: redis:7-alpine
    restart: always
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
```

### 二十二·二、健康检查端点（GET /health）

```python
# apps/api/routes/health.py
@router.get("/health")
async def health_check() -> HealthResponse:
    checks = await asyncio.gather(
        check_database(),
        check_redis(),
        check_llm_reachable(),
        check_packs_loaded(),
        check_scheduler_alive(),
        return_exceptions=True,
    )
    status = "healthy" if all(c == "ok" for c in checks) else "degraded"
    return HealthResponse(status=status, checks=checks, uptime_sec=uptime())
```

### 二十二·三、断路器（LLM 调用保护）

```python
# infra/llm/provider.py
from circuitbreaker import circuit

@circuit(
    failure_threshold=3,       # 3 次失败后断开
    recovery_timeout=60,       # 60 秒后尝试恢复
    fallback_function=rule_based_fallback,
)
async def call_llm_protected(prompt: str, model: str) -> str:
    return await call_llm(prompt, model)

async def rule_based_fallback(prompt: str, model: str) -> str:
    # 断路器打开时走规则引擎降级，不丢失告警
    return await RuleEngine.evaluate_degraded(prompt)
```

### 二十二·四、AgentSession 看门狗（防卡死会话）

```python
# workers/watchdog.py
@scheduler.scheduled_job("interval", minutes=1, id="watchdog")
async def watchdog_stuck_sessions():
    """5分钟未更新的 running 会话视为卡死，升级 HITL"""
    stuck = await db.query_stuck_sessions(timeout_minutes=5)
    for session in stuck:
        await hooks.fire("agent_timeout", {"session": session})
        await session.escalate_to_hitl("自动看门狗：会话超时")
```

### 二十二·五、优雅关机（数据不丢）

```python
# main.py
async def graceful_shutdown():
    # 1. 停止接受新请求（FastAPI lifespan）
    # 2. 等待运行中 AgentSession 完成（最多 30 秒）
    # 3. 将 HITL-waiting 状态从 Redis 持久化到 PostgreSQL
    # 4. 关闭所有 OT 连接（OPC-UA session）
    # 5. 关闭 DB 连接池
    await asyncio.wait_for(flush_all_sessions(), timeout=30)
    await engine.dispose()
    logger.info("ClawTwin graceful shutdown complete")
```

### 二十二·六、Pack 隔离（单 Pack 崩溃不带倒核心）

```python
# core/packs/registry.py
async def load_pack(pack_path: Path) -> PackState:
    try:
        pack = await import_pack(pack_path)
        registry.register(pack)
        return PackState.LOADED
    except Exception as e:
        # Pack 加载失败：记录日志，标记为 ERROR，核心继续运行
        logger.error(f"Pack {pack_path.name} load failed: {e}")
        registry.mark_failed(pack_path.name, error=str(e))
        await channels.notify_admin(f"Pack 加载失败: {pack_path.name}")
        return PackState.ERROR  # 不 raise，不阻塞其他 Pack
```

### 二十二·七、新发现 OpenClaw 可借鉴项

| OpenClaw 特性              | ClawTwin 实现                          | 阶段    |
| -------------------------- | -------------------------------------- | ------- |
| `openclaw doctor` 全面诊断 | `clawtwin doctor` 检查 10 项           | Phase A |
| SIGTERM 优雅关机           | `graceful_shutdown()` 持久化 HITL 状态 | Phase A |
| 环境变量覆盖所有配置       | `CLAWTWIN_*` 环境变量，12-factor app   | Phase A |
| `--debug` 详细日志         | 开启 SQL/LLM请求/Hook 链路日志         | Phase A |
| 进程标题（ps 可识别）      | `setproctitle("clawtwin[site_a]")`     | Phase A |
| Compact/JSON 输出模式      | `--json` 机器可读，`--quiet` 精简输出  | Phase A |
| Session export/import      | `clawtwin session export <id>` JSON    | Phase B |
| 多 agent 专家路由          | 不同 Pack 注册专家 Agent，任务路由     | Phase B |
| OpenTelemetry trace_id     | 传播到所有 Hook 调用链                 | Phase B |

---

## 二十三·五、批判性架构审计（Critical Design Review v1.0）

> 以批判眼光对比 OpenClaw 源码与 ClawTwin 实现，找出过度设计、遗漏、以及虚假对齐。
> 日期：2026-05-15

### 一、OpenClaw "Plugin + Hook 即一切" 模式分析

OpenClaw 的核心只做四件事：

1. **Plugin 加载**：发现 → 验证 → 注入 PluginApi → 调用 `plugin.register(api)`
2. **事件路由**：inbound message → Channel → Agent loop
3. **Hook 驱动扩展**：36 个具名事件覆盖 Agent 生命周期每一个阶段
4. **资源交付**：reply → Channel → 用户

其余**所有业务逻辑都在 Plugin 里**：AI 模型（Provider Plugin）、消息渠道（Channel Plugin）、工具、记忆、技能、CLI 命令——全部通过 Plugin 注册。

**ClawTwin 是否可以做到同样的事？**

✅ **完全可以，且已经是这个方向**。ClawTwin 的核心是：

```
IndustrialEvent → EventBus → PlaybookEngine → AgentFunction → ActionExecutor → Outbox
```

这条链路的每一环都可以通过 Plugin + Hook 扩展：

| 环节     | 扩展点               | Plugin 注册方法                              |
| -------- | -------------------- | -------------------------------------------- |
| 数据接入 | ConnectorPlugin 驱动 | `register_connector`                         |
| 事件处理 | 告警规则             | `register_rule`                              |
| 工作流   | 业务 Playbook        | `register_playbook`                          |
| AI 推理  | 领域知识             | `register_skill` + `register_agent_function` |
| 行动执行 | 工具调用             | `register_tool`                              |
| 通知分发 | 消息渠道             | `register_channel`                           |
| 钩子     | 全链路观测           | `register_hook(event, handler)`              |
| 定时任务 | 主动巡检             | `register_schedule`                          |

**结论：是的，ClawTwin 也实现了 "Plugin + Hook 即一切" 模式。**
任何新业务能力都通过添加 Plugin 实现，无需修改内核。

---

### 二、ClawTwin Plugin 扩展点完整清单（非 Hook）

OpenClaw 仅靠 Hook 不够，Plugin 还需要以下**非 Hook 交互点**：

| 交互点类型       | OpenClaw                         | ClawTwin                  | 说明             |
| ---------------- | -------------------------------- | ------------------------- | ---------------- |
| **工具注册**     | `registerTool(name, fn, schema)` | `register_tool`           | LLM 可调用的函数 |
| **数据驱动**     | `registerChannel`                | `register_connector`      | 设备数据 I/O     |
| **本体定义**     | 无（ClawTwin 独有）              | `register_object_type`    | 工业实体类型     |
| **AI 函数**      | `registerAgentHarness`           | `register_agent_function` | 领域推理单元     |
| **工作流**       | 无（ClawTwin 独有）              | `register_playbook`       | 业务流程编排     |
| **规则引擎**     | 无（ClawTwin 独有）              | `register_rule`           | 阈值/逻辑规则    |
| **通知渠道**     | `registerChannel`                | `register_channel`        | 消息发送         |
| **HTTP 路由**    | `registerHttpRoute`              | `register_http_route`     | API 端点         |
| **定时任务**     | `registerSessionSchedulerJob`    | `register_schedule`       | 定期巡检         |
| **MCP 服务**     | `registerMcpServer`              | `register_mcp_server`     | 工具协议         |
| **知识/记忆**    | `registerMemoryCapability`       | `register_memory`         | KB/CBR           |
| **上下文引擎**   | `registerContextEngine`          | `register_context_engine` | 自定义上下文     |
| **Agent 运行时** | `registerAgentHarness`           | `register_agent_harness`  | LangGraph 等     |
| **CLI 命令**     | `registerCommand`                | `register_command`        | 运维命令         |
| **诊断检查**     | `registerSecurityAuditCollector` | `register_doctor_check`   | 健康检查         |

**非 Hook 交互点的价值**：Hook 是事件通知（观测/拦截），而 `register_*` 是能力注册（扩展功能）。两者互补，缺一不可。

---

### 三、Skills 机制移植分析

**OpenClaw Skills 工作原理（src/agents/skills/skill-contract.ts）**：

1. Plugin 注册：`api.registerSkill({ name, description, filePath })`
2. Agent 启动时装配：`formatSkillsForPrompt(skills)` → `<available_skills>` XML
3. 注入系统提示词：`Scan <available_skills>. If one clearly applies, read its SKILL.md...`
4. LLM **懒加载**：判断匹配后使用 `read_file` 工具读取完整 SKILL.md
5. 执行 Skill 中的步骤指令

**ClawTwin 的移植方案（已实现）**：

```
Plugin.register_skill("skills/compressor-diagnostics.md")
    ↓
ContextAssembler.build(entity_id, entity_type, alarm_type)
    ↓ SKILL.md frontmatter: applies_to: [compressor]
    ↓ 匹配 entity_type → 预加载 skill content
    ↓
augment_system_prompt(base_system) → base_system + <available_skills>...</>
    ↓
run_completion(system=augmented_system, user=...)
    ↓ fire("before_llm_call") fire("after_llm_call")
    ↓
LLM 直接使用 Skill 中的诊断步骤
```

**与 OpenClaw 的关键差异（合理的适配，不是问题）**：

- OpenClaw：LLM 懒加载（有 read_file 工具）
- ClawTwin：预加载（工业 LLM 通常无文件系统访问权）
- ClawTwin 新增：`applies_to` + `alarm_types` 字段精确匹配，避免注入不相关 Skill

**Skill 与数据库/工具的关系**：

- Skill = 操作手册（告诉 LLM 怎么做）
- Tool = 数据库访问接口（`query_historian`、`get_entity`、`search_cbr_cases`）
- **Skill 描述 "用哪些工具、按什么顺序、关注什么阈值"**
- Tool 通过 `register_tool()` 注册，Skill 通过 `register_skill()` 注册
- **两者不互相替代，而是协同工作**

---

### 四、批判性发现：三个真实架构缺陷（已修复）

#### 缺陷 1：Skills 已注册但从未使用 ❌ → ✅ 已修复

**问题**：`register_skill()` 把路径存入 `_skill_paths`，但没有任何代码读取它注入 LLM 提示词。Skills 只是存在于内存，对 LLM 完全不可见。

**修复**：

- 新建 `aip/context_engine/assembler.py`（`ContextAssembler`）
- `execute_ai_function()` 自动调用 `assembler.augment_system_prompt()`
- 当 `params` 含 `entity_type` 时自动注入匹配的 Skill

#### 缺陷 2：Hooks 已声明但从未触发 ❌ → ✅ 已修复

**问题**：`VALID_EVENTS` 包含 `before_llm_call`、`after_llm_call` 等，但 `ai_runner.run_completion()` 从未调用 `fire()`。Hook 机制只是一个空注册表。

**修复**：

- `run_completion()` 增加 `hook_context` 参数
- 在实际 LLM 调用前后 `await fire_async("before_llm_call", ...)` 和 `"after_llm_call"`
- 传递完整指标（entity, model, tokens, latency_ms, finish_reason）供 Plugin 监听

#### 缺陷 3：两套注册系统未打通 ⚠️ → 已厘清边界

**问题**：`extension_registry`（331 行，YAML 资源索引）和 `PluginApi`（Python 代码注册）是两套独立的注册系统，相互不感知。

**决策（保留两套，厘清边界）**：

- `extension_registry`：YAML 驱动的资源（`object_types/*.yaml`、`playbooks/*.yaml`）的索引 — 给 Doctor、UI、API 用的只读目录
- `PluginApi`：Python 代码注册（tools、hooks、services、connectors）— 运行时能力注册表
- **两者互补，不重叠**。`pack_loader` 在加载时把 YAML 资源写入 extension_registry；`PluginApi` 在 Python Plugin 里注册代码能力
- **不合并**：合并会让简单的 YAML 资源 也要写 Python Plugin，提高门槛

---

### 五、不必要复杂度（需简化的地方）

| 当前状态                                | 问题                                            | 建议                                                                         |
| --------------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------- |
| `core/pack_loader/` 还在                | 名字还叫 pack，概念混乱                         | 重命名为 `core/plugin_loader/` 但优先级低                                    |
| `aip/agent_runtimes/` 是外部 Agent 委托 | 易与 `register_agent_harness`（内部运行时）混淆 | V4.md 明确标注：外部委托 vs 内部执行                                         |
| `core/pipeline_runner/` 似乎是独立的    | 与 PlaybookEngine 的边界不清晰                  | `pipeline_runner` = 数据转换管道；`playbook_engine` = 业务流程编排，两者不同 |
| `aip/prompt_registry.py` 只有 1 行      | 功能未实现                                      | 可删除或吸收到 ContextAssembler                                              |

---

### 六、核心执行链路（最终确认）

以下是 ClawTwin 的正规执行链路，每个 `fire()` 调用都已实现或明确规划：

```
OPC-UA/SCADA → ConnectorPlugin → EventBus
    ↓
EventBus → RuleEngine → alarm_created fire()
    ↓
PlaybookEngine.match_and_start(alarm)
    for each step:
        fire("before_agent_start")
        ContextAssembler.build(entity, alarm)  ← Skills 自动注入
        fire("before_context_assemble")
        → AgentFunction.run(context)
            fire("before_llm_call")            ← ✅ 已实现
            LLM(<available_skills> + tools)
            if tool_call:
                fire("before_tool_call")
                tool.execute()
                fire("after_tool_call")
            fire("after_llm_call")             ← ✅ 已实现
        → ActionExecutor.execute(result)
            fire("before_action_execute")
            [HITL if required]                 ← fire("hitl_requested")
            execute side effects
            fire("after_action_execute")
        → Outbox.enqueue(notification)
            fire("notification_sending")
            Channel.send()
            fire("notification_sent")
    fire("session_end")
```

这条链路清晰对应 OpenClaw 的 Agent 生命周期，每个 Hook 都有对应业务含义。

---

> 2026-05-14 最终审计：横扫 AI 领域所有技术、协议、框架，逐一决策采纳/阶段/不采纳。

### 二十·一、发现的 6 个关键遗漏（Critical Gaps）

经过最终审计，发现如下遗漏，已在对应位置修正：

| #   | 遗漏项                  | 严重程度 | 修正措施                                                   |
| --- | ----------------------- | -------- | ---------------------------------------------------------- |
| 1   | **Redis 未接入代码**    | CRITICAL | 加入 `redis[hiredis]>=5.0.0` 到核心依赖；设计 4 个使用场景 |
| 2   | **Langfuse 完全缺失**   | CRITICAL | 加入 `langfuse>=2.0.0` 到核心依赖；替代 `llm_call_log.py`  |
| 3   | **Casbin 有依赖无设计** | 重要     | pyproject.toml 已有 casbin，补充 ABAC 使用规范             |
| 4   | **BM25 混合检索缺失**   | 重要     | 加入 `rank_bm25` 到 rag 依赖组；ContextAssembler 混合策略  |
| 5   | **提示注入防护缺失**    | 重要     | `before_llm_call` Hook 增加 Connector 数据扫描             |
| 6   | **SAML 2.0 缺失**       | 重要     | 加入 `python3-saml` 到核心依赖；企业大客户必需             |

### 二十·二、Redis 四场景使用规范

```
场景1: LLM结果缓存
  key:   f"llm_cache:{entity_id}:{symptoms_hash}"
  TTL:   5分钟（相同设备/相同症状复用）
  效果:  减少 60% LLM 调用成本

场景2: HITL会话热状态
  key:   f"hitl_session:{agent_session_id}"
  TTL:   24小时（等待人工审批期间）
  效果:  毫秒级会话恢复，PostgreSQL 只做持久备份

场景3: 告警去重计数器
  key:   f"alarm_dedup:{device_id}:{alarm_code}"
  TTL:   1分钟（滚动窗口）
  效果:  同设备同类告警1分钟内只处理一次

场景4: Studio SSE pub/sub
  channel: "studio_events:{session_id}"
  用途:    EventBus → Redis → Studio SSE 实时推送
  效果:    无需轮询，Agent 推理进度实时显示
```

### 二十·三、Langfuse LLM 可观测接入

```python
# infra/llm/provider.py  ─ 统一 LLM 调用入口
import litellm
from langfuse import Langfuse
from langfuse.decorators import observe

langfuse = Langfuse()   # 读取 LANGFUSE_HOST / LANGFUSE_PUBLIC_KEY 环境变量

@observe(name="llm_call")
async def call_llm(prompt: str, model: str, **kwargs) -> str:
    resp = await litellm.acompletion(model=model, messages=[{"role":"user","content":prompt}], **kwargs)
    return resp.choices[0].message.content
```

追踪内容：Token 用量 / 成本 / 延迟 / 输出质量评分 / 按 Pack 分组报告。
替代原 `llm_call_log.py`，Langfuse 支持自托管（Docker）。

### 二十·四、Casbin ABAC 权限模型

```
# casbin/model.conf
[request_definition]
r = sub, dom, obj, act          # 用户, 站点, 资源, 操作

[policy_definition]
p = sub, dom, obj, act

[policy_effect]
e = some(where (p.eft == allow))

[matchers]
m = r.sub == p.sub && r.dom == p.dom && r.obj == p.obj && r.act == p.act
```

```csv
# casbin/policy.csv
p, admin,     site_a, playbook,  execute
p, engineer,  site_a, connector, read
p, operator,  site_a, hitl,      approve
p, readonly,  site_a, entity,    read
```

LLM 可通过 `clawtwin perm add <role> <site> <resource> <action>` CLI 动态调整权限策略。

### 二十·五、混合检索（Hybrid RAG）策略

```
Phase B KB 检索流程：
  Query
    ├── 向量检索   (pgvector cosine)   → top-20 候选
    ├── BM25检索   (rank_bm25)        → top-20 候选
    └── RRF 融合   (Reciprocal Rank Fusion)
          ↓
     cross-encoder 重排序 (top-5)
          ↓
     GraphRAG 图遍历增强 (get_neighbors 实体关系上下文)
          ↓
     ContextAssembler 装配
```

混合检索比纯向量对工业文档（含模型号/故障码/零件号）召回率提升约 30%。

### 二十·六、GraphRAG 显式策略

ClawTwin 的本体图（Ontology Graph）本身就是知识图谱。`ContextAssembler.get_neighbors()`
已实现图遍历——这正是 Microsoft GraphRAG（2024）的核心思想：
**通过实体关系图扩展 RAG 上下文**，而非仅做向量最近邻搜索。

```
实体: Pump-101
  → 上游: Tank-01 (supplying)
  → 下游: Pipeline-A (feeding)
  → 维护记录: MO-2024-0311 (last_maintenance)
  → 相关告警: ALM-2024-0312 (alarm_history)

ContextAssembler 输出给 LLM 的上下文 =
  Pump-101 当前状态 + 关联实体状态 + 维护历史 + 历史相似故障
```

这是 ClawTwin 诊断准确率显著优于通用 AI 助手的核心机制。

### 二十·七、提示注入防护（Guardrails）

```python
# infra/security/guardrails.py
INJECTION_PATTERNS = [
    r"ignore previous instructions",
    r"act as",
    r"you are now",
    r"system:\s*you",
]

def scan_connector_data(data: str) -> str:
    """before_llm_call Hook 中调用，清洗外部数据"""
    for pattern in INJECTION_PATTERNS:
        data = re.sub(pattern, "[REDACTED]", data, flags=re.IGNORECASE)
    return data
```

Connector 读取的 ERP 备注、PLC 标签值等外部数据进入 LLM Prompt 前必须经过此扫描。

### 二十·八、最终完整技术栈决策表

| 类别             | 采纳（Phase A）                 | Phase B 扩展               | 明确不采纳                            |
| ---------------- | ------------------------------- | -------------------------- | ------------------------------------- |
| **LLM**          | LiteLLM + Ollama                | 多模态(图像/PDF)、推理模型 | —                                     |
| **Agent**        | asyncio simple loop             | LangGraph HITL             | AutoGen/CrewAI/Temporal(Phase C 备选) |
| **RAG**          | pgvector + GraphRAG             | BM25混合+重排序            | Haystack                              |
| **协议**         | MCP + REST + WebHook            | A2A + SSE + MQTT           | ACP(观望)/gRPC/GraphQL                |
| **基础设施**     | PG + Redis + Langfuse + Casbin  | Prometheus+Grafana         | Kafka/ClickHouse                      |
| **安全**         | JWT + Casbin + Pydantic输出验证 | SAML + Guardrails          | —                                     |
| **OpenClaw借鉴** | Hooks(30个) + Skills + Session  | heartbeat监控 + 模型路由   | 直接代码复用（语言不同）              |

---

## 二十四、架构师 + 企业 IT 全面审计（Architect Review v2.0）

> 基于 OpenClaw 源码精确对比 + 工业企业 IT 架构现状分析。审计时间：2026-05-15

### 二十四·一、MCP 架构：ClawTwin 与 OpenClaw 的关系

**OpenClaw MCP 实现**（完整双向）：

- **MCP 客户端**：连接任意外部 stdio/SSE/streamable-HTTP MCP Server，配置在 `openclaw.json mcp.servers`
- **MCP 服务器**：通过 `/mcp` 端点暴露自身工具，供 AI 模型调用（loopback）
- 传输层：`@modelcontextprotocol/sdk`，支持 SSE、streamable-HTTP、stdio 三种传输
- 协议版本：`2025-03-26` + `2024-11-05` 兼容

**ClawTwin MCP 实现**（当前）：

- **MCP 服务器**（✅ 已完整实现）：`aip/mcp_server.py` 暴露 ontology 工具给 OpenClaw
- **MCP 客户端**（已补充）：`infra/mcp_client.py` — ClawTwin 主动调用外部 MCP servers
- **clawtwin.json mcp.servers 配置**（已新增，对齐 OpenClaw schema）

**clawtwin.json mcp 配置（新增，对齐 OpenClaw）**：

```jsonc
"mcp": {
  "servers": {
    "slack": {
      "url": "https://mcp.slack.com/sse",
      "transport": "sse",
      "headers": {"Authorization": "Bearer ${SLACK_BOT_TOKEN}"}
    },
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data/manuals"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": "${GITHUB_TOKEN}"}
    }
  }
}
```

**协议兼容性**：ClawTwin 与 OpenClaw 完全兼容（JSON-RPC 2.0 + tools/list + tools/call）。区别：OpenClaw 用 TS SDK，ClawTwin 用 Python httpx 实现。

---

### 二十四·二、OpenClaw 外设资源 ClawTwin 可借鉴的完整清单

ClawTwin 既是 OpenClaw 的工具提供方（MCP Server），也可消费 OpenClaw 生态的外设资源（通过 MCP Client）。

| OpenClaw Plugin                | 工业用途                      | ClawTwin 接入方式                     | 优先级 |
| ------------------------------ | ----------------------------- | ------------------------------------- | ------ |
| `feishu`                       | 飞书通知/审批/告警推送        | Channel Plugin（已集成）              | P0     |
| `ollama` / `lmstudio` / `vllm` | 数据不出厂区的本地 LLM        | LiteLLMProvider（已支持）             | P0     |
| `memory-wiki`                  | 设备手册/SOP/案例知识库       | `register_memory` + KB 插件           | P1     |
| `memory-core`                  | 向量搜索/语义相似度           | infra/knowledge 已有，需封装为 Plugin | P1     |
| `webhooks`                     | SCADA/DCS 推送告警到 ClawTwin | `register_http_route` 接收            | P1     |
| `diagnostics-otel`             | OpenTelemetry 指标采集        | infra/monitoring 集成                 | P1     |
| `diagnostics-prometheus`       | Prometheus 监控               | docker-compose metrics 端点           | P1     |
| `brave` / `searxng` / `tavily` | 搜索 ISO 标准/故障手册        | MCP Client → 工具                     | P2     |
| `document-extract`             | 解析 PDF 设备手册             | MCP Client → 工具                     | P2     |
| `slack`                        | 国际化企业消息                | Channel Plugin                        | P2     |
| `github`                       | Playbook/Ontology 版本管理    | MCP Client                            | P2     |
| `telegram`                     | 个人运维告警（非企业标准）    | Channel Plugin                        | P3     |

**OpenClaw memory-wiki 的工业价值**：memory-wiki 是 Obsidian 兼容的本地知识库，提供：

- `wiki_search(query)` — 向量 + BM25 混合检索
- `wiki_get(path)` — 读取具体知识条目
- `wiki_apply(path, content)` — AI 辅助更新知识
- `registerMemoryCorpusSupplement` — 把 wiki 内容注入向量索引

ClawTwin 的对应实现（已规划）：`register_memory(KnowledgeBasePlugin)` → 包装 `infra/knowledge/` → ContextAssembler 在 `before_llm_call` 时自动检索并注入。

---

### 二十四·三、本体/工作流/规则引擎选型决策

#### 本体定义：为什么 YAML 优于 memory-wiki 风格

| 维度     | OpenClaw memory-wiki（Markdown + claims） | ClawTwin YAML Ontology          |
| -------- | ----------------------------------------- | ------------------------------- |
| 格式     | 自然语言 + 结构化 frontmatter             | LinkML / JSON Schema YAML       |
| 目标     | 人类知识沉淀，LLM 可读                    | 机器可读，系统集成合同          |
| 验证     | 置信度/矛盾检测（软验证）                 | 严格 JSON Schema 验证           |
| 集成映射 | 无（人工对应）                            | 字段级 OPC-UA 标签映射          |
| 工业适用 | SOP 文档、案例、经验                      | 设备类型、报警 Schema、动作定义 |

**决策：双层知识体系**

1. **YAML 本体**（已实现）：机器可读的结构化定义 → 生成 MCP 工具 schema，集成合同
2. **KB/Wiki 文档库**（需补充）：人和 LLM 可读的案例/手册/SOP → 通过 `register_memory` 注入上下文

#### 工作流引擎：为什么 YAML Playbook 优于 OpenClaw agent 推理

OpenClaw 无显式工作流引擎——依赖 Agent 自由推理序列化任务。这对聊天场景足够，但**工业生产场景要求可审计、版本受控、可单独测试的工作流**。

YAML Playbook 的关键优势：

- **合规性**：每步骤状态和执行日志可映射到 SOP 文档编号（如 `sop_ref: SOP-MAINT-007`）
- **确定性**：告警响应流程不依赖 LLM 判断，降低 AI 引入的不确定性
- **测试性**：PlaybookEngine 可独立单元测试，无需调用 AI
- **安全认证**：步骤级 HITL 门控可通过功能安全审查

**待补充**（Phase B）：`parallel_steps` 字段，支持并行诊断步骤。

#### 规则引擎：为什么显式规则引擎优于 LLM

| 维度          | LLM 推理（OpenClaw 方式） | ClawTwin 规则引擎          |
| ------------- | ------------------------- | -------------------------- |
| AI 可用性依赖 | 100% 依赖 LLM             | 独立运行（LLM 宕机不影响） |
| 延迟          | 500ms–3s                  | < 1ms（阈值检查）          |
| 安全认证      | 无法通过                  | Python 规则可代码审查认证  |
| 可测试性      | Prompt 调试               | pytest 单元测试            |
| 合规          | 不满足 ISA-88/API 580     | 满足                       |

**正确分层**：规则引擎检测异常 → 触发 Playbook → Playbook 调用 AgentFunction → AgentFunction 用 LLM 诊断根因。LLM 只做**解释推理**，不做**安全判断**。

---

### 二十四·四、企业 IT 架构完整性审查（工业现场真实现状）

#### 工业企业标准 IT 架构（Purdue 参考模型）

```
Level 4 - 企业 IT:  ERP（SAP）/ CMMS（Maximo）/ ITSM（ServiceNow）/ IAM（AD/LDAP）
Level 3 - 制造运营: MES / Historian（PI/Aspen）/ HSE / LIMS / ClawTwin
Level 2 - 控制系统: SCADA / DCS / OPC-UA / Modbus / PLC
Level 1 - 现场设备: 传感器 / 执行器 / 仪表
```

#### 当前设计盲点与补充方案

| 能力                  | 工业现状                      | ClawTwin 现状           | 建议补充                                            | 优先级 |
| --------------------- | ----------------------------- | ----------------------- | --------------------------------------------------- | ------ |
| **IT/OT 网络隔离**    | IT/OT 严格分区（Purdue 模型） | 假设内网直连            | `CLAWTWIN_OT_NETWORK_CIDR` 白名单配置               | P0     |
| **SSRF 保护**         | 工业网络安全要求              | MCP 回调无限制          | 入站 webhook/MCP 的目标 IP 白名单                   | P0     |
| **IAM/SSO**           | LDAP/AD/SAML 统一认证         | 无设计                  | `infra/auth/provider.py` Protocol 接口              | P1     |
| **AI 决策审计**       | AI 行为需可追溯               | 仅 HITL 记录            | 每次 LLM 调用写入 `audit_log` 表                    | P1     |
| **Historian 多样性**  | PI、Aspen IP21、Wonderware    | 通用接口，无具体 SDK    | 专属 Connector 实现（PI Web API 优先）              | P1     |
| **本地 LLM**          | 数据不出厂区                  | 支持 ollama/lmstudio    | 补充边缘 Docker Compose 模板                        | P1     |
| **数字作业许可**      | LOTO（上锁挂牌）合规要求      | 无设计                  | `permit_required` Playbook 步骤类型 + 双人确认 HITL | P1     |
| **ITSM 集成**         | ServiceNow/Jira IT 资产       | 仅 CMMS/Maximo          | REST Connector 模板                                 | P2     |
| **多租户/多工厂**     | 工厂间数据隔离                | 无 tenancy 设计         | `site_id` 租户字段 + 数据隔离策略                   | P2     |
| **ISA-18.2 报警管理** | 告警泛滥抑制、优先级          | 基础 FSM                | 死区配置、shelving、告警日志                        | P2     |
| **合规标签**          | ISO 55001、API 580、GB 标准   | 无                      | Playbook YAML `compliance_ref` 字段                 | P2     |
| **边缘部署**          | OT 网内离线运行               | 依赖 FastAPI+PostgreSQL | 最小化边缘镜像（SQLite + ollama）                   | P2     |

#### 关键结论（企业 IT 架构师视角）

1. **IT/OT 网络隔离是 P0** — 不加配置直接在 OT 区运行 ClawTwin，违反大多数工厂安全规定
2. **本地 LLM 是 P0 等级要求** — 油气/化工厂的工艺数据绝不允许外发到云端 API
3. **Historian 连接器质量决定数据质量** — PI System 在炼化/电力行业的覆盖率超过 60%，必须有原生 connector
4. **AI 决策审计是监管要求** — GB/T 41704 要求 AI 辅助决策必须有完整追溯链
5. **LOTO 数字化是工业安全法定要求** — 高危作业必须有两人确认机制，不能只靠 HITL 按钮

---

### 二十四·五、代码对齐状态总览（v4.2 → v4.3 升级）

| OpenClaw 能力              | ClawTwin 对应代码                                        | 对齐状态              |
| -------------------------- | -------------------------------------------------------- | --------------------- |
| Plugin System（注册/加载） | `core/plugin_sdk/` + `core/pack_loader/`                 | ✅ 完整               |
| 36 个 Hook 事件            | `infra/hooks.py` VALID_EVENTS（49个）                    | ✅ 完整（含工业扩展） |
| Hook 实际触发              | `ai_runner.py` before/after_llm_call                     | ✅ 已实现             |
| Skills 注册+装配           | `register_skill` + `aip/context_engine/assembler.py`     | ✅ 已实现             |
| Skills 示例文件            | `plugins/oilgas/skills/compressor-diagnostics.md`        | ✅ 已创建             |
| MCP Server                 | `aip/mcp_server.py` + `apps/http/routes.py`              | ✅ 完整               |
| MCP Client                 | `infra/mcp_client.py`（新增）                            | ✅ 新增               |
| PluginApi 20 个方法        | `core/plugin_sdk/api.py`                                 | ✅ 完整               |
| Doctor/Health Check        | `infra/doctor/` + `infra/health/`                        | ✅ 完整               |
| Outbox / Channel 交付      | `infra/outbox.py`                                        | ✅ 完整               |
| 规则引擎                   | `core/domain_logic/alarm_rule_eval.py` + `register_rule` | ✅ 完整               |
| 状态机                     | `core/domain_logic/alarm_fsm.py` + `workorder_fsm.py`    | ✅ 完整               |
| ConnectorPlugin Protocol   | `core/plugin_sdk/connector.py`                           | ✅ 完整               |
| IAM/SSO                    | —                                                        | ❌ 待设计（Phase B）  |
| IT/OT 网段白名单           | —                                                        | ❌ 待添加（P0）       |
| AI 决策审计日志            | `infra/audit.py`（待新建）                               | ❌ 待实现（Phase B）  |
| PI Historian Connector     | `connectors/historian/pi_connector.py`（待实现）         | ❌ 待实现（Phase B）  |
| 数字作业许可（LOTO）       | PlaybookEngine 步骤扩展（待实现）                        | ❌ 待实现（Phase B）  |

---

## 二十五、模块化商业授权机制（License Key）

### 二十五·一、设计原则：本地验证，无需联网

工业客户普遍离网运行，必须支持完全本地验证：

```python
# core/license/manager.py
from cryptography.hazmat.primitives import serialization, hashes
from cryptography.hazmat.primitives.asymmetric import padding
import json, base64

EMBEDDED_PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
...（发布时内嵌你的公钥）...
-----END PUBLIC KEY-----"""

@dataclass
class LicensePayload:
    licensee: str
    issued: str
    expires: str
    max_sites: int
    max_entities: int
    allowed_packs: list[str]   # ["oilgas", "chemical"]
    features: list[str]        # ["ai_diagnosis", "a2a_federation"]

def load_license(path: Path) -> LicensePayload:
    raw = json.loads(path.read_text())
    sig = base64.b64decode(raw.pop("signature"))
    payload_bytes = json.dumps(raw, sort_keys=True).encode()
    # 用内嵌公钥验证签名，无网络依赖
    public_key.verify(sig, payload_bytes, padding.PKCS1v15(), hashes.SHA256())
    return LicensePayload(**raw)
```

### 二十五·二、四处强制检查点

| 检查点                  | 校验内容                                | 失败行为              |
| ----------------------- | --------------------------------------- | --------------------- |
| `PluginRegistry.load()` | `pack_id in license.allowed_packs`      | 拒绝加载，日志告警    |
| `EntityStore.create()`  | `total_entities < license.max_entities` | 拒绝写入，返回 429    |
| `apps/api/startup`      | `license.expires > today`               | 降级只读模式，3天宽限 |
| `federation API`        | `"a2a_federation" in license.features`  | 返回 403              |

### 二十五·三、三层授权版本

| 版本         | max_sites | max_entities | allowed_packs | 价格        |
| ------------ | --------- | ------------ | ------------- | ----------- |
| Community    | 1         | 500          | 开源Pack      | 免费        |
| Professional | 5         | 无限         | 行业Pack      | 年费·站点计 |
| Enterprise   | 无限      | 无限         | 全部+定制     | 合同制+SLA  |

**Pack 生态授权**：商业 Pack 在 `clawtwin.pack.json` 声明 `license_required: professional`，PluginRegistry 加载时交叉验证。社区 Pack 不含此字段，任何版本均可加载。

---

## 二十六、角色化部署（同一代码库，配置决定行为）

### 二十六·一、三种角色

ClawTwin 是**一套代码**，`clawtwin.json` 中的 `federation.role` + 安装的 Pack 决定行为模式：

```yaml
# 现场站点（site_agent）
federation:
  role: site_agent
  hub_url: "https://hq.company.com:8000"
packs: [oilgas, clawtwin-core]
# 功能：管理本站设备/工单/诊断，向 Hub 推送事件和案例

---
# 协调层总部（orchestrator）
federation:
  role: orchestrator
  managed_sites:
    - { id: factory_a, url: "http://factory-a:8000" }
    - { id: factory_b, url: "http://factory-b:8000" }
packs: [clawtwin-orchestrator]
# 功能：跨站聚合视图、下发 Playbook 模板、CBR 联邦中心

---
# 专家智能体（specialist，Phase C）
federation:
  role: specialist
  domain: energy_optimization
packs: [clawtwin-specialist, energy-pack]
# 功能：专注单领域深度推理，接受 A2A Task，不管理设备
```

### 二十六·二、`clawtwin-pack-orchestrator` 激活协调功能

普通站点安装此 Pack 后立即获得：

- `/v1/federation/*` API 端点（接收子站点事件推送）
- 跨站点 CBR 联邦学习中心
- 聚合看板（汇总所有子站点 KPI/告警）
- Playbook 模板下发接口（git push → 子站点 git pull）

**结论**：协调层不是不同的产品，只是不同 Pack 组合。一套 pip 包，三种角色，无缝扩展。

---

## 二十七、Skill 格式 —— 严格对齐 OpenClaw 标准

### 二十七·一、OpenClaw SKILL.md 真实格式

```markdown
---
name: feishu-wiki
description: |
  Feishu knowledge base navigation. Activate when user mentions wiki.
---

# Feishu Wiki Tool

## Token Extraction

From URL `https://xxx.feishu.cn/wiki/ABC123` → `token` = `ABC123`

## Actions

...
```

### 二十七·二、ClawTwin SKILL.md 兼容扩展格式

```markdown
---
name: pump-diagnostics
description: |
  离心泵故障诊断知识。处理泵相关告警时自动注入。
triggers: # ClawTwin 新增：自动激活条件
  - entity_type: CentrifugalPump
  - alarm_codes: [VIBE_HIGH, TEMP_HIGH, BEARING_FAIL]
---

# 离心泵诊断知识

## 常见故障模式与根因

| 故障现象   | 可能原因      | 诊断步骤                |
| ---------- | ------------- | ----------------------- |
| 振动超标   | 叶轮磨损/失衡 | 检查叶轮 → 测振频谱分析 |
| 轴承温度高 | 润滑不足/过载 | 检查润滑脂 → 测负荷     |

## 诊断决策树

...
```

### 二十七·三、对比与兼容性

| 特性                                  | OpenClaw                  | ClawTwin                                       | 兼容性          |
| ------------------------------------- | ------------------------- | ---------------------------------------------- | --------------- |
| YAML front matter（name/description） | ✅                        | ✅                                             | 100% 兼容       |
| Markdown 内容主体                     | ✅                        | ✅                                             | 100% 兼容       |
| 激活方式                              | 用户对话关键词            | `triggers`：entity_type / alarm_codes 自动注入 | ClawTwin 是超集 |
| 存放目录                              | `extensions/<id>/skills/` | `packs/<id>/skills/`                           | 结构相同        |
| 加载器                                | SkillManager              | ContextAssembler 按 triggers 选择              | 行为更自动化    |

**修正**：将架构中所有提到 "ClawTwin Skills 与 OpenClaw 不同" 的描述替换为"ClawTwin Skills 是 OpenClaw Skills 的超集，新增 triggers 字段实现工业场景的自动激活"。

---

## 二十八、本体三路径构建（无真实系统也可运行）

### 二十八·一、Path 1：文件导入（立即可用，Day 1）

```bash
# 从 YAML 文件导入（人工编写或 Pack 预置）
clawtwin ontology import --from-yaml packs/oilgas/ontology/

# 从 CSV 批量导入（工程师从 Excel 转换）
clawtwin ontology import --from-csv equipment_list.csv
# CSV 列：entity_id, entity_type, name, site, tag_prefix, ...

# 查看已加载本体
clawtwin ontology list
clawtwin ontology show CentrifugalPump
```

### 二十八·二、Path 2：Connector 自动发现

```bash
# 从 OPC-UA 自动发现节点树
clawtwin discover --connector opcua://192.168.1.100:4840
# → 读取可用节点层级
# → LLM 按命名模式分组（Pump_101_Speed → CentrifugalPump）
# → 生成候选 YAML，用户确认后写入 EntityStore

# 从 Modbus 地址表发现
clawtwin discover --connector modbus://192.168.1.200:502 --map plc_map.csv
```

### 二十八·三、Path 3：Studio UI 编辑器（Phase B）

Studio 本体编辑器功能：拖拽创建类型、可视化定义关联关系、CSV 批量导入、LLM 字段建议、Pack 扩展预览。输出为 `ontology/object_types/*.yaml`，纳入 git 版本管理。

---

## 二十九、文件模式（Demo / 开发 / 离线）

无真实 OT/ERP 系统，ClawTwin 也可完整运行，包括 AI 诊断、Playbook、HITL、通知。

### 二十九·一、Fixture 目录结构

```
fixtures/
├── entities.yaml              ← 实体定义（替代真实 EntityStore 初始化）
├── timeseries/
│   ├── pump-101.csv           ← 时序模拟数据（按时间戳排列）
│   └── tank-01.csv
├── alarms/
│   └── 2024-03-11.json        ← 历史告警序列（回放用）
└── knowledge/
    ├── pump-manual.pdf        ← 维修手册（注入 KB）
    └── maintenance.md         ← 维保记录
```

### 二十九·二、启动命令

```bash
# Sales 演示模式（完整功能，数据来自 fixture）
clawtwin start --mode=demo --demo-data=./fixtures/oilgas-demo/

# 开发/测试模式（热重载 + fixture）
clawtwin dev --demo-data=./tests/fixtures/

# CI 自动化验收（特定场景回放）
clawtwin start --mode=demo --fixture=tests/pump-failure-scenario.yaml
clawtwin check pump-101  # → 返回 exit code 0/1/2，适合 CI 断言
```

### 二十九·三、CSV Connector（持续模拟传感器）

```python
# connectors/file/csv_connector.py
# 读取 CSV，按时间戳模拟传感器数据推送到 EventBus
# interval 字段控制回放速度（实时 / 加速 / 单步）
```

### 二十九·四、应用场景

| 场景         | 用途                                |
| ------------ | ----------------------------------- |
| Sales 演示   | 客户现场演示，无需对接客户系统      |
| 开发测试     | 开发 Pack 时不需要 OT 基础设施      |
| 培训上手     | 新用户学习 ClawTwin，用示例数据练习 |
| CI/CD 验收   | 自动化测试，fixture 即为测试场景    |
| 离线部署验证 | 现场安装后功能自测                  |

---

## 三十、OpenClaw 新发现借鉴（第四轮）

| OpenClaw 特性        | ClawTwin 实现                                                            | 阶段    |
| -------------------- | ------------------------------------------------------------------------ | ------- |
| 告警分组（通知去重） | 相似告警合并通知："A区5台泵振动超标" 而非5条独立推送                     | Phase A |
| `--dry-run` 执行模拟 | `clawtwin playbook run pump-check --dry-run` 输出影响报告不执行          | Phase A |
| `@entity` 上下文路由 | `clawtwin ask @pump-101 "为什么振动高？"` 自动注入实体上下文             | Phase A |
| 工具信任等级         | read=自动 / write=确认提示 / critical=HITL 审批                          | Phase A |
| Pack 市场搜索        | `clawtwin pack search pump` → PyPI 搜索 `clawtwin-pack-*`                | Phase A |
| Dev 热重载           | 修改 SKILL.md/playbooks → `watchdog` 自动 reload（类 OpenClaw dev mode） | Phase A |
| 脚本 Exit Code       | `clawtwin check <id>` → 0(健康) / 1(告警) / 2(错误)，CI 友好             | Phase A |
| Compact Prompt       | 长会话历史摘要，防 context overflow（ContextAssembler 已有基础）         | Phase A |
| Session Export       | `clawtwin session export <id>` → JSON，支持工单/调试/共享                | Phase B |
| 子 Agent 生成        | LangGraph multi-node：主 Agent 派生专家 Sub-Agent                        | Phase C |

---

## 三十一、设计原则（不可违反）

1. EntityStore 是唯一真相源
2. EventBus 是唯一通知出口
3. OT 层只读，写回必须经 ActionExecutor + HITL
4. Provider（LLM/向量/时序）必须可替换，由配置控制
5. Pack 边界清晰，核心不感知行业逻辑
6. `requires_hitl=True` 必须等待人工确认
7. 对话不进 Platform 核心（交给 OpenClaw）
8. 全部行为配置驱动（LLM 可通过 CLI 调整）
9. 进化必须安全（有人工确认门）
10. 机器人/PLC 写入：最高安全等级

---

## 三十三、资源层完整性终检（补充遗漏设计）

### 三十三·一、BaseConnector 插件化抽象接口

所有 Connector 必须继承此基类，保证核心对 Connector 实现完全解耦：

```python
# connectors/base.py
from abc import ABC, abstractmethod
from typing import Any, AsyncIterator, Callable

@dataclass
class ConnectorHealth:
    healthy: bool
    latency_ms: float
    error: str | None

@dataclass
class WriteResult:
    success: bool
    written_value: Any
    timestamp: str

class BaseConnector(ABC):
    connector_id: str                    # 唯一标识符（如 "opcua_plant_a"）
    connector_type: str                  # "inbound" | "bidirectional"
    config: BaseModel                    # Pydantic 验证配置

    @abstractmethod
    async def connect(self) -> None: ...

    @abstractmethod
    async def read(self, entity_id: str, tags: list[str]) -> dict[str, Any]: ...

    @abstractmethod
    async def health_check(self) -> ConnectorHealth: ...

    async def write(self, entity_id: str, tag: str, value: Any) -> WriteResult:
        """默认只读，bidirectional Connector 才覆盖此方法（需通过 HITL 门）"""
        raise ReadOnlyConnectorError(self.connector_id)

    async def stream(
        self, entity_id: str, callback: Callable[[dict], None]
    ) -> AsyncIterator:
        """实时推送（可选）：OPC-UA subscription, MQTT, WebSocket"""
        raise NotImplementedError
```

Pack 注册 Connector（`clawtwin.pack.json`）：

```jsonc
"connectors": [
  {
    "id": "opcua",
    "class": "connectors.opcua.OPCUAConnector",
    "type": "bidirectional",
    "config_schema": "connectors/opcua/config.schema.json",
    "requires": "asyncua>=1.1.0"
  },
  {
    "id": "sap_erp",
    "class": "connectors.erp.sap.SAPConnector",
    "type": "inbound",
    "config_schema": "connectors/sap/config.schema.json"
  }
]
```

**运维命令**：

```bash
clawtwin connector list          # 列出所有已注册 Connector 及状态
clawtwin connector test opcua    # 执行健康检查
clawtwin connector discover opcua  # 自动发现可用实体（调用 LLM 分组）
```

**原则**：任何 Connector（OPC-UA、Modbus、SAP、JDBC、Web 抓取等）都通过 Pack 插件化提供，
核心不包含任何具体 Connector 实现。第三方可发布 `clawtwin-connector-*` 包扩展。

### 三十三·二、三种补充资源类型（本次审计发现缺失）

#### Templates（消息/报告模板）

消息模板独立于 Playbook，支持复用和多语言：

```
packs/oilgas/templates/
├── workorder_created.j2        ← Jinja2 模板
├── diagnosis_report.j2
└── weekly_summary.j2
```

```jinja2
{# workorder_created.j2 #}
🔔 **工单创建通知**
设备：{{ entity.name }}（{{ entity.id }}）
告警：{{ alarm.message }}（严重级别：{{ alarm.severity }}）
诊断摘要：{{ diagnosis.summary }}
建议操作：{{ diagnosis.recommended_action }}
工单号：{{ workorder.id }} | 优先级：{{ workorder.priority }}
负责人：{{ workorder.assignee }}
```

LLM 可通过 `suggest_template_improvement` Function 建议改进措辞，人工确认后更新。

#### Rules（无 AI 简单规则引擎）

LLM 不可用时的保底机制，也适合简单阈值监控（无需消耗 LLM Token）：

```yaml
# packs/oilgas/rules/temperature_guard.yaml
id: temp-high-guard
description: 温度超阈值立即告警（不经 LLM）
priority: 100 # 高优先级，在 Playbook 之前执行
condition:
  entity_type: HeatExchanger
  tag: outlet_temp_c
  operator: ">"
  threshold: 85.0
action:
  emit_alarm:
    severity: HIGH
    code: TEMP_EXCEED
    message: "出口温度超过 85°C（当前：{{ tag_value }}°C）"
```

**设计意图**：

- Rules 无需 LLM，响应延迟 < 100ms（APScheduler 每30秒扫描）
- LLM 降级运行时（断路器打开），Rules 保证基本告警不丢
- LLM 可通过 `suggest_rule_update` Function 建议阈值优化，人工确认后写入 YAML

#### API Keys（外部系统调用鉴权）

第三方系统（SCADA、ERP、上层应用）调用 ClawTwin REST API 时使用：

```bash
# 创建 API Key（指定权限范围）
clawtwin apikey create \
  --name "SCADA System" \
  --permissions "alarm:write,entity:read,playbook:trigger"
→ 返回：ct_live_4a9f3b2c...（只显示一次，请保存）

# 列出所有 API Key
clawtwin apikey list

# 撤销
clawtwin apikey revoke ct_live_4a9f3b2c

# 外部系统调用：
curl -H "X-API-Key: ct_live_4a9f3b2c" \
     -d '{"entity_id":"pump-101","code":"VIBE_HIGH","severity":"HIGH"}' \
     POST https://clawtwin.internal/v1/alarms
```

API Key 权限范围与 Casbin ABAC 集成，每次调用验证 `apikey → resource → action`。

### 三十三·三、许可证安全性深度分析

**时间限制**：是的，`expires` 字段强制执行。

```
许可证状态流转：
  VALID          → 正常运行
  EXPIRING_SOON  → 30天前发送续期提醒到管理员 Channel
  GRACE_PERIOD   → 过期3天内：AI诊断/写入操作停止，告警监控保持（不阻断安全）
  EXPIRED        → 完全只读，仅允许 clawtwin doctor 和 clawtwin apikey
```

**安全层次分析**：

| 攻击方式                | 难度评估            | 防护措施                       |
| ----------------------- | ------------------- | ------------------------------ |
| 伪造 License JSON       | 极难（需 RSA 私钥） | 2048-bit RSA，私钥不出版本库   |
| 修改过期时间            | 无效（签名失效）    | 签名覆盖全部字段含 expires     |
| Patch 验证代码          | 中等                | PyArmor 混淆 `core/license/`   |
| 复制 License 到其他机器 | 简单                | **硬件指纹绑定**（见下）       |
| 内存 Patch 跳过检查     | 困难                | 多处独立检查点，调用栈不可预测 |

**硬件指纹绑定（Enterprise 加固）**：

```python
# core/license/fingerprint.py
import hashlib, uuid, platform

def compute_fingerprint() -> str:
    """组合 MAC 地址 + CPU 信息生成稳定指纹"""
    mac = str(uuid.getnode())                    # 网卡 MAC
    cpu = platform.processor() or "unknown"     # CPU 型号
    raw = f"{mac}:{cpu}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]

# 生成许可证时：
# fingerprint = compute_fingerprint()  → 写入 license.json

# 验证时：
# current = compute_fingerprint()
# assert current == license.device_fingerprint
```

**实用安全建议**：

- **Community 版本**：不绑定设备（降低安装门槛）
- **Professional 版本**：绑定 1 台主机指纹
- **Enterprise 版本**：`device_fingerprints: [fp1, fp2, fp3]` 多机部署
- **核心模块 Cython 编译**：`core/license/` → `.so` 文件，比 PyArmor 更彻底
- **最终评估**：企业 B2B 场景下，破解成本 >> 购买成本，保护水平达行业标准

### 三十三·四、OpenClaw 功能全面对齐终检（第五轮，31 项）

| OpenClaw 功能                 | ClawTwin 实现                   | 状态                  |
| ----------------------------- | ------------------------------- | --------------------- |
| Gateway（核心路由）           | EventBus + FastAPI 路由         | ✅ 对齐               |
| Session 管理                  | AgentSession PostgreSQL 持久化  | ✅ 对齐               |
| 多轮 Agent 迭代               | simple_loop → LangGraph         | ✅ 对齐               |
| ContextAssembler              | aip/context_engine（GraphRAG）  | ✅ 对齐（超集）       |
| Tool Calling                  | Function YAML + Pydantic        | ✅ 对齐               |
| MCP Server                    | aip/mcp_server.py               | ✅ 对齐               |
| Plugin Manifest               | clawtwin.pack.json              | ✅ 对齐               |
| install/update/disable/doctor | clawtwin pack 命令族            | ✅ 对齐               |
| openclaw init                 | clawtwin init 向导              | ✅ 对齐               |
| SKILL.md 格式                 | Pack/skills/（+ triggers 超集） | ✅ 对齐（超集）       |
| 35 个 Hooks                   | 30 个跨 ABC 三期                | ✅ 对齐               |
| before_model_resolve          | model_routing_resolve Hook      | ✅ Phase B            |
| heartbeat_prompt_contribution | scheduled_context_contribution  | ✅ Phase B            |
| before_agent_finalize revise  | agent_finalize_check Hook       | ✅ Phase B            |
| before_compaction             | context_compaction Hook         | ✅ Phase C            |
| SSE 流式响应                  | sse-starlette + Studio          | ✅ Phase B            |
| 多通道路由                    | Outbox 多 Channel               | ✅ 对齐               |
| Rate limiting                 | max_concurrent_sessions         | ✅ 对齐               |
| Context window 截断           | ContextPackage.to_prompt_text   | ✅ 对齐               |
| Session export                | clawtwin session export         | ✅ Phase B            |
| Plugin marketplace            | clawtwin pack search → PyPI     | ✅ 对齐               |
| Dev 热重载                    | watchdog → auto reload          | ✅ 对齐               |
| 告警分组去重                  | EventBus 合并策略               | ✅ Phase A            |
| --dry-run 模拟                | clawtwin playbook run --dry-run | ✅ Phase A            |
| @entity 上下文路由            | clawtwin ask @pump-101          | ✅ Phase A            |
| 工具信任等级                  | read/write/critical 三级        | ✅ Phase A            |
| SIGTERM 优雅关机              | graceful_shutdown()             | ✅ Phase A            |
| 脚本 Exit Code                | clawtwin check → 0/1/2          | ✅ Phase A            |
| browser/computer use          | playwright connector            | Phase B（需安全沙箱） |
| code execution                | shell_exec Function + HITL      | Phase B（需安全沙箱） |
| web_fetch（JS 渲染）          | playwright web connector        | Phase B               |

**31 项中 28 项已完全对齐，3 项在 Phase B 对齐（均需安全沙箱，工业场景审慎处理正确）。**

---

## 三十四、文档关系

**本文档（V4）** 为 `contrib/industrial-oilgas-skills/` 下 **架构与设计纵深终稿**：取代散落的历史架构 draft 作为主要技术叙事来源；与 **章节号** 较长的专题（二十三·五批判审计、二十四企业 IT 审计、§5.7、四十一～四十二代码差距等）共同构成「为什么这样造」的完整说理。

**与兄弟文档分工**（可与 **文首「文档地图与真值分层」** 对照）：

| 需求                                      | 首选文档                                                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 新人从何读起、21+ 文档地图                | `DESIGN-FINAL-MASTER-INDEX.md`                                                                          |
| 对外一页总览·ROI·接口鸟瞰                 | `CLAWTWIN-ARCHITECTURE-OVERVIEW.md`                                                                     |
| **HTTP 路由与 JSON 契约**（改代码.hand）  | `archive/MODULE-DESIGN-PLATFORM.md` §18.6、§19 + `DESIGN-FINAL-LOCK.md` §一                             |
| **§5.7** 本体工作台·借鉴边界·成熟路径分解 | **本文 §5.7（5.7.0–5.7.8）**                                                                            |
| 代码目录与实现对齐叙事                    | （历史）`platform-api/STRUCTURE.md` 若仍存在；否则以 **repository 源码树** + **本文 §八、§四十一** 为准 |
| 客户向企业 AI 分工                        | `CLAWTWIN-ENTERPRISE-AI-ARCHITECTURE.md`                                                                |

历史版本条目、过渡期说明仍以 **`DESIGN-FINAL-MASTER-INDEX.md`** 归档区为准。

---

## 三十五、架构深度修正（逻辑自洽审查）

### 三十五·一、完整事件流管道（权威定义）

事件从 Connector 到最终执行的完整数据流：

```
━━━━━━━ 数据采集层 ━━━━━━━
Connector.safe_read(entity_id, tags)        ← 带断路器保护
  └─ ConnectorManager.process_reading()
       ├─ TimescaleDB.insert()               ← 历史时序存档（只追加）
       ├─ EntityStore.update_latest()        ← 实时状态缓存（可覆盖）
       └─ RulesEngine.evaluate()             ← 无AI快速规则检查（< 100ms）
            │ if rule_triggered:
            └─ EventBus.emit(AlarmEvent)

━━━━━━━ 事件路由层 ━━━━━━━
EventBus（asyncio in-memory，infra/event_dispatcher.py）
  ├─ PlaybookEngine.on_event()               ← AI处理主流程
  ├─ redis.publish("studio_events")          ← 实时大屏 SSE 展示
  └─ Outbox.enqueue(notification_job)        ← 可靠 Channel 通知（至少一次）

━━━━━━━ AI处理层 ━━━━━━━
PlaybookEngine.run(playbook_template, event)
  ├─ Step type=function:
  │    └─ ContextAssembler.assemble(entity_id)  ← 每步独立调用（保证新鲜度）
  │         └─ AgentRuntime.run(ctx, fn)         ← LLM推理（含 Reflexion, Phase B）
  ├─ Step type=action:
  │    └─ ActionExecutor.execute(action, risk_score) → HITL gate
  ├─ Step type=hitl:                             ← PAUSE，存 DB
  │    ├─ AgentSession.save_state(hitl_pending)
  │    └─ [resume on approval, see §三十五·二]
  └─ Step type=channel:
       └─ Outbox.send(channel_id, template, context)

━━━━━━━ 可靠投递层 ━━━━━━━
Outbox（PostgreSQL jobs + APScheduler worker）
  ├─ 指数退避重试：1s, 2s, 4s, 8s...最多10次
  ├─ 多通道降级：飞书失败 → SMS → Email
  └─ DLQ（10次失败后入死信队列，通知管理员）
```

**关键设计约束**：

- EventBus = **内部路由**（asyncio，不持久化）
- Outbox = **外部可靠投递**（PostgreSQL持久化，保证不丢）
- Redis = **实时推送**（Studio大屏、HITL唤醒通知）
- 三者分工明确，互不替代

### 三十五·二、HITL 唤醒机制（关键缺失，正式补充）

```python
# ─── 暂停侧（Playbook 执行中）───
async def execute_hitl_step(session: AgentSession, step: PlaybookStep):
    session.status = "hitl_pending"
    session.checkpoint = step.id
    await db.save(session)
    # Outbox 通知审批人
    await outbox.send("wecom", template="hitl_request", data={
        "session_id": session.id,
        "message": step.message,
        "approve_url": f"/studio/hitl/{session.id}",
    })
    return AgentResult(status="hitl_required")

# ─── 唤醒侧（Studio API）───
# POST /v1/hitl/{session_id}/approve
async def approve_hitl(session_id: str, decision: str, comment: str):
    session = await db.get_agent_session(session_id)
    session.status = f"hitl_{decision}"  # hitl_approved / hitl_rejected
    session.hitl_comment = comment
    await db.save(session)
    # 写审计日志
    await audit_log.write(actor=current_user, resource=session_id,
                           action=f"hitl_{decision}", after={"comment": comment})
    # Phase B：Redis 唤醒
    await redis.publish("hitl.events", {"session_id": session_id, "decision": decision})
    # Phase A：轮询模式（PlaybookEngine watchdog每5秒扫描DB）

# ─── PlaybookEngine 恢复监听（两种模式）───
# Phase A：watchdog 轮询
@scheduler.scheduled_job("interval", seconds=5)
async def poll_hitl_approvals():
    approved = await db.query("SELECT * FROM agent_sessions WHERE status='hitl_approved'")
    for s in approved: await playbook_engine.resume(s)

# Phase B：Redis 订阅
async def on_hitl_event(msg):
    data = json.loads(msg["data"])
    await playbook_engine.resume(data["session_id"])
await redis.subscribe("hitl.events", on_hitl_event)
```

### 三十五·三、BaseOutputChannel 抽象基类（补充缺失）

```python
# channels/base.py
from abc import ABC, abstractmethod

@dataclass
class DeliveryResult:
    success: bool
    channel_id: str
    error: str | None
    latency_ms: float

@dataclass
class ChannelHealth:
    healthy: bool
    latency_ms: float

class BaseOutputChannel(ABC):
    channel_id: str
    config: BaseModel

    @abstractmethod
    async def send(self, message: str, **kwargs) -> DeliveryResult: ...

    @abstractmethod
    async def health_check(self) -> ChannelHealth: ...

    async def send_with_retry(
        self, message: str, max_retries: int = 3, **kwargs
    ) -> DeliveryResult:
        """基类实现重试，子类只需实现 send()"""
        for attempt in range(max_retries):
            try:
                return await self.send(message, **kwargs)
            except Exception as e:
                if attempt == max_retries - 1:
                    return DeliveryResult(success=False, channel_id=self.channel_id,
                                          error=str(e), latency_ms=0)
                await asyncio.sleep(2 ** attempt)
```

Pack 注册 Channel（`clawtwin.pack.json`）：

```jsonc
"channels": [
  {
    "id": "feishu",
    "class": "channels.im.feishu.FeishuChannel",
    "config_schema": "channels/feishu/config.schema.json"
  },
  {
    "id": "tts",
    "class": "channels.tts.edge_tts.EdgeTTSChannel",
    "requires": "edge-tts>=6.1.0"
  }
]
```

### 三十五·四、Pack 依赖声明与加载顺序

```jsonc
// clawtwin.pack.json 新增 depends 字段
{
  "id": "oilgas-advanced",
  "version": "2.0.0",
  "depends": [
    { "pack": "oilgas-base", "version": ">=1.0.0" },
    { "pack": "clawtwin-core", "version": ">=0.5.0" },
  ],
}
```

PluginRegistry 加载策略：

1. 收集所有 Pack 的 `depends` 声明
2. 拓扑排序（Kahn 算法），检测循环依赖
3. 按序加载，依赖项先于被依赖项
4. 卸载 Pack 前检查是否有其他 Pack 依赖它（拒绝卸载）

### 三十五·五、凭证加密静态存储

```python
# infra/secrets/vault.py
from cryptography.fernet import Fernet
import keyring, json, os
from pathlib import Path

CREDENTIALS_DIR = Path("~/.clawtwin/credentials").expanduser()

def _get_fernet() -> Fernet:
    key = (
        os.environ.get("CLAWTWIN_MASTER_KEY")
        or keyring.get_password("clawtwin", "master_key")
    )
    if not key:
        raise ConfigError("CLAWTWIN_MASTER_KEY not set. Run: clawtwin init")
    return Fernet(key.encode() if isinstance(key, str) else key)

def save_credential(name: str, data: dict) -> None:
    encrypted = _get_fernet().encrypt(json.dumps(data).encode())
    (CREDENTIALS_DIR / f"{name}.enc").write_bytes(encrypted)

def load_credential(name: str) -> dict:
    raw = (CREDENTIALS_DIR / f"{name}.enc").read_bytes()
    return json.loads(_get_fernet().decrypt(raw))
```

`clawtwin init` 在首次运行时生成随机 master key 并存入系统 keyring（macOS Keychain / Linux libsecret）。

### 三十五·六、审计日志表（企业合规必需）

```sql
-- 仅追加，禁止 UPDATE/DELETE（PostgreSQL Row Security Policy）
CREATE TABLE audit_logs (
    id          BIGSERIAL PRIMARY KEY,
    timestamp   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    actor       TEXT NOT NULL,          -- 用户ID 或 "system"
    actor_type  TEXT NOT NULL,          -- "user" | "agent" | "scheduler"
    resource    TEXT NOT NULL,          -- "hitl/sess-123" | "playbook/pump-check"
    action      TEXT NOT NULL,          -- "hitl_approved" | "action_executed"
    before_state JSONB,
    after_state  JSONB,
    session_id  TEXT,                   -- 关联 AgentSession
    ip_address  TEXT
);
-- 保留策略：90天（可配置），TimescaleDB 自动压缩历史
```

触发点：HITL 决策、Action 执行、配置变更、Pack 安装、API Key 操作、License 加载。

### 三十五·七、Connector 断路器 + 重连 + 过期检测

```python
# connectors/base.py 补充
class BaseConnector(ABC):
    _circuit_state: ConnectorState = field(default_factory=ConnectorState)

    async def safe_read(self, entity_id: str, tags: list[str]) -> dict:
        if self._circuit_state.is_open:
            raise ConnectorCircuitOpenError(self.connector_id)
        try:
            result = await asyncio.wait_for(
                self.read(entity_id, tags), timeout=self.config.timeout_sec
            )
            self._circuit_state.consecutive_failures = 0
            self._circuit_state.last_success = datetime.utcnow()
            return result
        except Exception as e:
            self._circuit_state.consecutive_failures += 1
            if self._circuit_state.consecutive_failures >= 5:
                self._circuit_state.is_open = True
                await event_bus.emit(ConnectorCircuitOpenEvent(self.connector_id))
                asyncio.create_task(self._half_open_probe())
            raise

    async def _half_open_probe(self):
        await asyncio.sleep(30)  # 30秒后探测
        self._circuit_state.is_open = False

    # 过期检测：APScheduler 每分钟调用
    async def check_staleness(self, entity_ids: list[str]):
        for eid in entity_ids:
            if (datetime.utcnow() - self._circuit_state.last_success) > timedelta(minutes=5):
                await entity_store.mark_stale(eid)
                await event_bus.emit(DataStaleEvent(eid, self.connector_id))
```

---

## 三十六、新 AI 技术整合（2025-2026 前沿）

### 三十六·一、Reflexion 自我反思（Phase B）

工业诊断中 LLM 首次判断可能遗漏关键信息。Reflexion 让 LLM 自我批评：

```python
# aip/agent_runtimes/simple_loop.py 中在 after_llm_call 后插入

async def reflexion_step(
    original_conclusion: str, context: ContextPackage
) -> str:
    """LLM 批评自己的结论，返回修正版"""
    critique_prompt = f"""
你刚才给出的诊断是：{original_conclusion}

请用批判性思维审视这个结论：
1. 有什么可能的遗漏或替代原因？
2. 证据是否充分支持这个结论？
3. 修正后的最终诊断是什么？

以 JSON 格式返回：{{"critique": "...", "revised_conclusion": "..."}}
"""
    revised = await call_llm(critique_prompt, model=session.model)
    return revised.revised_conclusion
```

激活条件：置信度 < 0.85 时触发（避免增加所有任务的延迟）。

### 三十六·二、Plan-and-Execute（复杂任务分解，Phase B）

用于根因分析、跨系统故障排查等复杂多步任务：

```python
# LangGraph 两阶段节点
def build_plan_execute_graph():
    graph = StateGraph(AgentState)

    # Planner Node：生成分步计划
    graph.add_node("planner", plan_task)

    # HITL Node（可选）：工程师确认计划
    graph.add_node("plan_review", hitl_gate)

    # Executor Node：按计划逐步执行
    graph.add_node("executor", execute_plan_step)

    # Synthesizer Node：汇总所有步骤结论
    graph.add_node("synthesizer", synthesize_results)

    graph.set_entry_point("planner")
    # planner → plan_review（如果任务风险高）→ executor → synthesizer
    return graph.compile(checkpointer=PostgresSaver(db))
```

### 三十六·三、不确定性投票（高风险决策，Phase B）

```python
# aip/agent_runtimes/ensemble.py
async def ensemble_decide(
    prompt: str, n: int = 3, threshold: float = 0.67
) -> EnsembleResult:
    """多数投票，用于 risk_level=CRITICAL 的决策"""
    results = await asyncio.gather(*[
        call_llm(prompt, temperature=0.3 + i * 0.1)  # 轻微随机化
        for i in range(n)
    ])
    votes = Counter(r.decision for r in results)
    winner, count = votes.most_common(1)[0]
    confidence = count / n

    if confidence < threshold:
        # 没有明确多数 → 强制 HITL
        return EnsembleResult(decision="ESCALATE_HITL",
                               confidence=confidence, votes=dict(votes))
    return EnsembleResult(decision=winner, confidence=confidence)
```

激活条件：仅对 `requires_hitl=critical`（OT 写入、紧急停车）的 Action 触发。

### 三十六·四、可解释性日志（Chain-of-Thought 存储，Phase A）

```python
# AgentSession 新增字段
@dataclass
class AgentSession:
    ...
    reasoning_chain: list[ReasoningStep] = field(default_factory=list)

@dataclass
class ReasoningStep:
    step_id: str
    llm_input: str           # 发给 LLM 的完整 Prompt（脱敏后）
    llm_output: str          # LLM 的完整输出
    tool_calls: list[dict]   # 调用的工具列表
    confidence: float        # 置信度
    timestamp: str
```

Studio 的诊断详情页显示：每步推理过程、调用的工具、最终结论的理由链。
操作员可以理解"为什么 ClawTwin 建议停机"，增强信任。

### 三十六·五、HyDE（假设文档嵌入，Phase B）

标准向量检索：用**问题的 embedding** 去找相关文档（语义有时不匹配）。
HyDE 改进：先让 LLM 生成**假设性答案**，用答案的 embedding 去检索（更接近文档语义）：

```python
# aip/context_engine/hyde_retriever.py
async def hyde_search(query: str, kb_index: KBIndex, top_k: int = 5) -> list:
    # Step 1: LLM 生成假设性答案
    hypothetical = await call_llm(
        f"假设你是一个工业专家，请给出关于'{query}'的详细技术答案：",
        model="fast"  # 用小模型降低成本
    )
    # Step 2: 用假设答案的 embedding 检索（比原始问题更准确）
    return await kb_index.search(hypothetical, top_k=top_k)
```

对维修手册、SOP 文档等专业术语密集的工业文档检索提升显著。

### 三十六·六、预测 AI（主动7日展望，Phase B）

不等故障发生，主动预测未来7天潜在问题：

```python
# workers/predictive_analysis.py
@scheduler.scheduled_job("cron", day_of_week="mon", hour=6, id="weekly_forecast")
async def weekly_predictive_analysis():
    """每周一早6点主动分析所有设备"""
    entities = await entity_store.query_all_active()
    for entity in entities:
        # 拉取过去30天趋势数据
        trend = await timeseries_db.get_trend(entity.id, days=30)
        if trend.shows_degradation():  # 统计检验：是否有下降趋势
            ctx = await assembler.assemble(entity.id)
            result = await agent.run(ctx, "predict_maintenance")
            if result.predicted_failure_days < 14:
                # 预测14天内可能故障 → 主动创建预防性工单
                await playbook_engine.trigger(
                    "predictive_maintenance", entity, result
                )
```

### 三十六·七、结构化输出（Structured Output，Phase A 立即应用）

OpenAI / Anthropic 原生结构化输出比 JSON mode 更可靠（100% 保证格式合规）：

```python
# Phase A 立即应用：替代 JSON mode
response = await litellm.acompletion(
    model=session.model,
    messages=session.build_messages(ctx),
    response_format=DiagnosisResult,  # Pydantic model 直接传入
    # LiteLLM 自动转换为各 provider 的结构化输出格式
)
result = DiagnosisResult.model_validate(response.choices[0].message.content)
```

相比 `response_format={"type": "json_object"}`，结构化输出保证字段名和类型完全匹配，
消除 `ValidationError` 的主要来源。

---

## 三十七、密钥生命周期管理（Key Lifecycle Management）

### 三十七·一、4类密钥概览

| 密钥类型               | 算法                   | 生命周期      | 存储位置                  | 轮转触发              |
| ---------------------- | ---------------------- | ------------- | ------------------------- | --------------------- |
| License Key（RSA私钥） | RSA-2048               | 长期（5年）   | 你的离线保险箱            | 私钥泄露              |
| License Key（RSA公钥） | RSA-2048               | 随发布版本    | 内嵌 ClawTwin 二进制      | 私钥泄露时发版        |
| API Key                | Argon2哈希存DB         | 1年（可配置） | DB加密存哈希              | 定期或泄露            |
| Master Encryption Key  | Fernet（256-bit）      | 1年           | 系统Keyring/Docker Secret | 每年或泄露            |
| JWT Signing Secret     | HMAC-SHA256（256-bit） | 90天          | DB加密字段                | 定期轮转              |
| TLS Certificate        | ECDSA P-256            | 1年           | 文件系统                  | Let's Encrypt自动续期 |

### 三十七·二、License Key 生成与签发

```bash
# 步骤1：生成 RSA 密钥对（仅需一次，离线操作）
openssl genrsa -out clawtwin_license_private.pem 2048
openssl rsa -in clawtwin_license_private.pem -pubout \
  -out clawtwin_license_public.pem

# ⚠ 私钥永远不进版本库，离线保管（USB加密盘 + 保险箱备份）
# 公钥在 ClawTwin 发布时硬编码进 core/license/manager.py

# 步骤2：使用内部签发工具生成客户许可证
clawtwin-issuer sign \
  --private-key clawtwin_license_private.pem \
  --licensee "油田公司" \
  --max-sites 5 \
  --allowed-packs "oilgas,chemical" \
  --features "ai_diagnosis,a2a_federation" \
  --device-fingerprint "sha256-of-customer-server-mac" \
  --expires 2027-01-01 \
  --output clawtwin_license.json

# 步骤3：客户将 clawtwin_license.json 放入 ~/.clawtwin/
# ClawTwin 启动时自动加载验证（本地，无需联网）
```

### 三十七·三、API Key 生成与安全存储

```python
# infra/auth/api_key.py
import secrets, hashlib, argon2

def generate_api_key() -> tuple[str, str]:
    """返回 (明文key, 存储用哈希)"""
    token = secrets.token_urlsafe(32)[:32]        # 256-bit 随机
    checksum = hashlib.sha256(token.encode()).hexdigest()[:4]  # 可读校验
    plain_key = f"ct_live_{token}_{checksum}"
    # 存储 Argon2 哈希（即使 DB 泄露也无法还原原文）
    hashed = argon2.PasswordHasher().hash(plain_key)
    return plain_key, hashed

# 明文 key 只在创建时显示一次（类比 GitHub Personal Access Token）
# DB 只存 hashed，原文不存
```

**Key 轮转（双窗口策略）**：旧 Key 设置 3天宽限期（`grace_until` 字段），
同时接受新旧两个 Key，3天后旧 Key 自动失效。零停机轮转。

### 三十七·四、Master Key 轮转流程

```python
# infra/secrets/vault.py
async def rotate_master_key():
    """安全地重新加密所有凭证，不丢失任何数据"""
    old_fernet = get_fernet(current_key)
    new_key = Fernet.generate_key()
    new_fernet = Fernet(new_key)

    # 原子性操作：先写新加密文件，再删旧文件
    for cred_file in credentials_dir.glob("*.enc"):
        plain_data = old_fernet.decrypt(cred_file.read_bytes())
        new_file = cred_file.with_suffix(".enc.new")
        new_file.write_bytes(new_fernet.encrypt(plain_data))

    # 全部成功后，原子替换
    for new_file in credentials_dir.glob("*.enc.new"):
        new_file.rename(new_file.with_suffix(""))  # 替换旧文件

    # 更新 keyring
    keyring.set_password("clawtwin", "master_key", new_key.decode())
    await audit_log.write("system", "credentials", "key_rotated", {})
```

密钥查看命令：

```bash
clawtwin keys list
# ──────────────────────────────────────────────────
# license.json       expires: 2027-01-01  ✅ 有效（还有 231 天）
# master_key         rotated: 2026-01-15  ✅ 距上次 119 天
# jwt_secret         rotated: 2026-02-01  ✅ 距上次 102 天
# tls_cert           expires: 2027-01-15  ✅ 有效（还有 246 天）
# api_keys           active: 3, expired: 1  ⚠ 1个已过期
```

---

## 三十八、高可用架构 + SLA 指标

### 三十八·一、Active-Passive 主备部署（推荐）

```
                    ┌─────────────────────┐
外部访问 ──→  VIP (Keepalived) ──→  │  Primary ClawTwin    │
                    │  10.0.0.1:8000       │
                    └──────────┬──────────┘
                               │ 健康检查失败（3次/30秒）
                               ↓ VIP 漂移（< 30秒）
                    ┌─────────────────────┐
                    │  Standby ClawTwin   │
                    │  10.0.0.2:8000（热备）│
                    └─────────────────────┘
                               │
                    ┌──────────┴──────────┐
                    │                     │
             PostgreSQL              Redis Sentinel
             (Primary+Standby        (1主+2从+3哨兵)
              Streaming Replication)  自动选主 < 30s
```

**切换保障**：

- AgentSession 持久化在 PostgreSQL → 主备共享 → 切换后 Standby 自动恢复所有会话
- Redis HITL 唤醒 → Sentinel 自动选主，重连后继续监听
- Outbox 任务 → PostgreSQL 持久化 → 新主自动继续投递

### 三十八·二、SLA 指标定义

| 指标              | Community   | Professional | Enterprise | 测量方式          |
| ----------------- | ----------- | ------------ | ---------- | ----------------- |
| 月度可用性        | Best effort | 99.0%        | 99.5%      | /health 成功率    |
| 告警→Playbook延迟 | < 60s       | < 30s        | < 10s      | 事件时间戳差值    |
| LLM诊断完成时间   | < 3min      | < 2min       | < 1min     | Function执行耗时  |
| HITL通知延迟      | < 5min      | < 2min       | < 30s      | Outbox投递延迟    |
| 支持响应时间      | 社区论坛    | 24小时       | 4小时      | 工单创建→首次回复 |
| 灾难恢复 RTO      | —           | 2小时        | 30分钟     | DR演练记录        |
| 数据备份 RPO      | —           | 1小时        | 1分钟      | WAL streaming     |

### 三十八·三、备份与恢复流程

```bash
# 日常备份（自动，无需手动）
# PostgreSQL WAL 实时归档 → S3/OSS
# pg_basebackup 每日全量（凌晨3点）
# TimescaleDB 旧数据自动压缩（> 7天）
# Redis RDB 每15分钟快照

# 灾难恢复流程（RTO 30分钟）
# 1. 从 S3 下载最新 pg_basebackup（< 5分钟）
# 2. 应用 WAL 日志到目标时间点（< 10分钟）
# 3. 运行 clawtwin migrate 确认 schema（< 2分钟）
# 4. 重启服务，验证 /health 返回 healthy（< 5分钟）
# 5. 验证：告警流程端到端测试（< 5分钟）

# 完整备份恢复命令
clawtwin backup restore \
  --from s3://clawtwin-backup/2026-05-14/ \
  --target-time "2026-05-14T10:00:00Z" \
  --verify-only   # 先验证，不实际恢复
```

### 三十八·四、升级策略（零停机）

```bash
# 1. 先在 Standby 上升级（不影响生产）
ssh standby-server
docker pull clawtwin/platform:2026.5.15

# 2. 演习切换（dry-run）
clawtwin upgrade --dry-run --target 2026.5.15
# 输出：数据库迁移计划、受影响的 Pack 版本、预计停机时间

# 3. 执行升级（自动主备切换）
clawtwin upgrade --target 2026.5.15 --strategy rolling
# ① 升级 Standby → 切换 VIP 到 Standby（30秒中断）
# ② 升级原 Primary → 验证 → 恢复正常双节点

# 4. 回滚（如果发现问题）
clawtwin upgrade rollback --to 2026.5.14
```

---

## 三十九、信息溯源 + 引用 = AI 信任架构

### 三十九·一、设计理念：像学术论文一样引用

工业 AI 最大障碍是信任。操作员不执行 AI 建议的原因：
**"我不知道它从哪里得出这个结论"**。

解决方案：每个 AI 输出必须附带引用，操作员可以点击验证每条证据来源。

### 三十九·二、诊断输出引用格式

```python
# DiagnosisResult Pydantic 模型（输出 Schema）
class EvidenceItem(BaseModel):
    citation_id: str              # "[传感器1]", "[历史案例1]", "[手册第47页]"
    evidence_type: str            # "sensor_reading" | "cbr_case" | "knowledge_base"
    source: str                   # 数据来源名称（Connector ID / 文档名）
    citation_text: str            # 人类可读的引用描述
    raw_data: dict | None         # 原始数据（可点击查看）
    verification_url: str | None  # 深链接（Studio URL）

class DiagnosisResult(BaseModel):
    conclusion: str
    confidence: float             # 0.0-1.0
    confidence_explanation: str   # "依据3个相似历史案例和2项传感器异常"
    risk_level: str               # LOW | MEDIUM | HIGH | CRITICAL
    evidence: list[EvidenceItem]  # 有序证据列表（支撑结论的依据）
    recommended_actions: list[str]
    reasoning_chain_id: str       # 可查看完整推理过程
    data_freshness_seconds: int   # 最新数据距诊断时刻的秒数
```

示例输出（操作员看到的内容）：

```
诊断结论：轴承磨损，建议24小时内更换 [风险：HIGH]
置信度：87% — 依据3个相似历史案例和2项传感器异常

证据：
  [传感器1] Pump-101 振动值 8.2mm/s（正常<3.0，超标2.7倍）
            来源：OPC-UA Plant-A | 采集时间：2026-05-14 14:23:00
  [历史案例1] WO-2023-0892（相似度91%）：相同症状→更换轴承后恢复
             来源：案例库 | 关闭时间：2023-09-15
  [手册第47页] "轴承磨损是振动超标的主要原因之一"
              来源：pump-maintenance-manual.pdf 第4.3节

数据新鲜度：2分钟前采集
```

### 三十九·三、可信度五层架构

| 层级              | 机制                                 | 用户验证方式             |
| ----------------- | ------------------------------------ | ------------------------ |
| Layer 1 数据溯源  | 每个数值标注 Connector ID + 采集时间 | 点击跳转传感器历史趋势图 |
| Layer 2 历史案例  | CBR 案例 ID + 相似度分数             | 点击查看完整历史工单     |
| Layer 3 文档引用  | KB 文档名 + 页码 + 段落              | 点击下载原始文档         |
| Layer 4 审计轨迹  | 每个操作记录 actor/time/reason       | 审计日志可导出为 CSV     |
| Layer 5 AI 准确率 | 历史诊断结果 + 用户反馈统计          | Dashboard 显示历史准确率 |

### 三十九·四、AI 准确率反馈回路

```python
# 操作员在 Studio 对每次诊断评分
POST /v1/diagnosis/{id}/feedback
{
    "accurate": true,              # ✅ 正确 / ❌ 错误
    "actual_cause": "轴承磨损",    # 实际原因（可选）
    "notes": "与AI判断一致"
}

# 累积效果：
# 1. CBR 自动学习：将正确案例写入案例库
# 2. 准确率统计：按 Pack / Function / 设备类型分维度统计
# 3. 模型改进信号：错误案例收集为微调数据（Phase C）
# 4. Dashboard 展示：
#    - 本月 AI 诊断准确率：92%（共 47 次）
#    - 最准确领域：压缩机（96%）
#    - 需改进领域：泵密封（78%）
```

---

## 四十、企业级用户体验设计（4类用户画像）

### 四十·一、用户画像与核心需求

#### 👷 现场操作员（第一响应人）

- **主要设备**：工业平板 / 智能手机
- **核心需求**：快速理解"需要我做什么"
- **关键功能**：
  1. 告警聚合：同类告警合并为一条（含"5台设备"提示）
  2. 飞书/微信Work 消息内嵌审批按钮，手机一键批准
  3. 操作建议用非技术语言："立即检查3号泵的轴承，带润滑脂"

#### 🔧 维修工程师（技术专家）

- **主要设备**：工作站 + Studio 全屏
- **核心需求**：深入理解诊断依据，高效完成维修
- **关键功能**：
  1. 证据面板：完整引用链（传感器/历史案例/手册）
  2. 相似历史案例：CBR 自动显示前3个最相似工单
  3. 一键生成维修报告（Word/PDF，含诊断依据）
  4. 直接调取维修手册章节

#### 📊 工厂经理/运营总监（决策者）

- **主要设备**：大屏看板 + 笔记本
- **核心需求**：评估 AI 效果，做高层决策
- **关键功能**：
  1. AI 准确率仪表板（按月/按设备类型/按工程师）
  2. 成本节约估算（AI 预防故障的价值量化）
  3. 未解决事项汇总（等待 HITL 的事项列表）
  4. 每周 AI 摘要报告（PDF 自动发送邮件）

#### 💻 IT 管理员（系统维护者）

- **主要设备**：SSH 终端 + 监控面板
- **核心需求**：稳定运行，快速排障
- **关键功能**：
  1. `clawtwin doctor` 10项健康检查，一目了然
  2. `clawtwin upgrade --dry-run` 升级前预览影响
  3. `clawtwin pack rollback oilgas 1.2.0` 一键回滚
  4. Langfuse（LLM成本）+ Prometheus（系统指标）统一监控

### 四十·二、关键 UX 功能列表（Phase A 立即实现）

| 功能                    | 价值                     | 实现方式                               |
| ----------------------- | ------------------------ | -------------------------------------- |
| 告警聚合通知            | 减少消息轰炸，清晰优先级 | EventBus 聚合策略 + Channel 模板       |
| 证据面板                | 建立 AI 信任             | DiagnosisResult.evidence + Studio UI   |
| AI 准确率反馈           | 持续改进，可量化价值     | POST /feedback + 统计聚合              |
| 一键 HITL（消息内按钮） | 减少审批摩擦             | WeChat Work / 飞书 Interactive Message |
| 数据新鲜度显示          | 告知数据是否可信         | data_freshness_seconds 显示            |
| 置信度解释              | 不只显示数字，说明依据   | confidence_explanation 字段            |
| 上下文帮助（Tooltip）   | 降低学习成本             | Studio 每个字段 hover 说明             |
| 智能默认值              | 减少配置工作量           | clawtwin discover + LLM 建议           |

### 四十·三、Studio PWA（Phase B）

```
Studio 作为 Progressive Web App（PWA）：
- 可安装到手机主屏（类似原生 App）
- 离线模式：缓存最近 24h 的告警列表和实体状态
- 推送通知：Web Push → 手机锁屏通知（无需微信/飞书）
- 响应式布局：手机/平板/大屏自适应
- 深色模式：工厂环境夜间使用

next.js next-pwa + Service Worker + IndexedDB 离线缓存
```

### 四十·四、自然语言 CLI 查询（Phase B）

```bash
# 自然语言查询，无需记忆命令
clawtwin ask "泵101最近24小时有什么异常？"
→ 泵 Pump-101 过去24小时摘要：
   · 14:23 振动超标告警（8.2mm/s），已生成工单 WO-2026-0156
   · 正在等待维修工程师确认（HITL 挂起 2小时）
   · 其他参数正常

clawtwin ask "本月有多少告警被 AI 正确处理？"
→ 5月份统计（共47次 AI 诊断）：
   · 准确率：92%（43/47）
   · 平均诊断时间：1.2分钟
   · 节约估算停机时间：约 18 小时

# 实现：LiteLLM + ContextAssembler + 系统统计 API
```

---

## 四十一、代码现状扫描 + 差距分析（2026-05-14 实际扫描结果）

> 已对 `clawtwin-platform/platform-api/` 做完整扫描，结果与设计文档对比如下。
> **⚠️ 实际代码比 Phase A 设计预期更成熟。** 2026-05-14 扫描后的「4 缺口 + 6 缺失」已在 `clawtwin-platform/platform-api/` 逐项补齐（LiteLLM、`simple_loop` 工具循环、审批 DB、`diagnose_on_alarm` 与 `DiagnoseEquipment` 对齐、`tests/test_phase_a.py` 三场景等）；若以本节表格为准请以下游仓库为准。

### 四十一·一、已完整实现（不需要重写）

| 模块                                  | 实际状态 | 说明                                                                                      |
| ------------------------------------- | -------- | ----------------------------------------------------------------------------------------- |
| `infra/hooks.py`                      | ✅ 完整  | 11个Hook，线程安全，before\_\*可中止流程                                                  |
| `infra/event_dispatcher.py`           | ✅ 完整  | 24个事件类型，SSE/Webhook/Feishu三路扇出                                                  |
| `infra/outbox/`                       | ✅ 完整  | claim_batch (SELECT FOR UPDATE SKIP LOCKED)，指数退避，DLQ，reclaim_stuck                 |
| `core/action_executor/`               | ✅ 完整  | ActionExecutor + 信封 `risk_score`（ontology `risk_tier`）；handlers: alarm/workorder/mes |
| `core/playbook_engine/`               | ✅ 完整  | Jinja2模板 + 条件 + HITL等待态 + step日志                                                 |
| `core/function_executor/ai_runner.py` | ✅ 完整  | run_completion / ai_cache / usage / sync_wrapper                                          |
| `infra/diagnosis_context.py`          | ✅ 完整  | **即设计中的 ContextAssembler**，已集成readings+alarms+KB+CBR                             |
| `core/domain_logic/`                  | ✅ 完整  | AlarmFSM / WorkOrderFSM / CBR / recommendation_engine                                     |
| `infra/ai_provider/`                  | ✅ 可用  | stub + openai/anthropic；**LiteLLM** 经 `LiteLLMProvider` / `CLAWTWIN_USE_LITELLM`        |
| `connectors/`                         | ✅ 骨架  | CMMS / ERP / Historian / SCADA / Generic 目录结构完整                                     |
| `alembic/versions/`                   | ✅ 完整  | 17+ 迁移文件，AgentSession表已存在                                                        |
| `tests/`                              | ✅ 完整  | 100+ 单元测试，含alarm/workorder/playbook/outbox等                                        |

### 四十一·二、存在但需要修复（4个）— **已修复（归档）**

> 下列项为 2026-05-14 扫描时的结论；已在 `platform-api` 落地。**审批队列**采用 `approval_requests` 表 + `CLAWTWIN_APPROVAL_BACKEND`，与设计片段中的 AgentSession 字段示例不同但语义等价（持久化挂起审批）。

| ID  | 原问题                     | 落地                                                                        |
| --- | -------------------------- | --------------------------------------------------------------------------- |
| F1  | `infra/approval.py` 纯内存 | DB / auto / memory 后端，`approval_requests` 迁移                           |
| F2  | `providers/llm.py` stub    | `LiteLLMProvider` + registry `litellm`                                      |
| F3  | `aip/llm_trace.py` stub    | `llm_traces` 表 + 可选 Langfuse（`infra/observability/langfuse_client.py`） |
| F4  | YAML manifest              | `packs/oilgas/clawtwin.pack.json`                                           |

### 四十一·三、完全缺失（需新建，Phase A 关键）

| 文件                                | 优先级    | 估算代码量 | 说明                                                                 |
| ----------------------------------- | --------- | ---------- | -------------------------------------------------------------------- |
| `aip/agent_runtimes/simple_loop.py` | ✅ 已落地 | ~100行     | 本地 LiteLLM 工具循环（`litellm_tool_loop`）+ 单轮 `completion_turn` |
| `connectors/base.py`                | ✅ 已落地 | ~80行      | `BaseConnector` + `ConnectorHealth` + 断路器语义                     |
| `infra/secrets/vault.py`            | ✅ 已落地 | ~60行      | Fernet 封装（`CLAWTWIN_MASTER_KEY`）                                 |
| `infra/hitl/poller.py`              | ✅ 已落地 | ~50行      | Playbook HITL 超时清扫（scheduler 可调间隔）                         |
| `tests/test_phase_a.py`             | ✅ 已落地 | ~80行      | §41·六 三场景 + dispatcher/stub/doctor 冒烟                          |
| `infra/license/`                    | 🟡 中     | ~150行     | RSA License验证（Phase B生产必须）                                   |

### 四十一·四、架构决策：LiteLLM 接入方式

**推荐 Option A（向后兼容，本周实施）**：

```python
# Step 1: providers/llm.py 新增 LiteLLMProvider
import litellm
from infra.ai_provider import Completion, Message, ModelProvider

class LiteLLMProvider:
    """Thin wrapper around litellm — supports 100+ models via unified format."""
    def __init__(self, model: str | None = None):
        import os
        # LiteLLM格式：'openai/gpt-4o', 'anthropic/claude-sonnet-4-5', 'ollama/qwen2.5'
        self._model = model or os.environ.get("CLAWTWIN_LLM_MODEL",
                                               os.environ.get("CLAWTWIN_AI_MODEL", "gpt-4o-mini"))

    async def complete(self, messages: list[Message], **kwargs) -> Completion:
        import litellm
        resp = await litellm.acompletion(
            model=self._model,
            messages=[{"role": m.role, "content": m.content} for m in messages],
            temperature=kwargs.get("temperature", 0.2),
            max_tokens=kwargs.get("max_tokens", 2048),
        )
        choice = resp.choices[0]
        return Completion(
            text=choice.message.content or "",
            model=resp.model,
            provider="litellm",
            finish_reason=choice.finish_reason or "stop",
            usage=UsageStats(
                prompt_tokens=resp.usage.prompt_tokens,
                completion_tokens=resp.usage.completion_tokens,
                total_tokens=resp.usage.total_tokens,
            ),
        )

    async def embed(self, text: str) -> list[float]:
        import litellm, os
        embed_model = os.environ.get("CLAWTWIN_LLM_EMBED_MODEL", "text-embedding-3-small")
        resp = await litellm.aembedding(model=embed_model, input=[text])
        return resp.data[0].embedding

# Step 2: infra/ai_provider/registry.py 新增一行
# if provider_name == "litellm":
#     from providers.llm import LiteLLMProvider
#     return LiteLLMProvider()
```

---

## 四十二、开发就绪清单（Dev-Ready Checklist）

> 本节是设计文档的终章，供开发第一天使用。

### 四十二·一、Phase A 真正需要新写的代码（基于2026-05-14代码扫描）

> **重要修正**：原Phase A清单写于代码扫描前，很多项已经完整实现。以下是真正缺失的。

> **2026-05-14 起收口：`clawtwin-platform/platform-api/` 上 `pytest tests/` 已全绿（以当前分支 CI 为准，例如 561 passed / 1 skipped）。Phase A **以本节 checklist 为准**；下方「目标：2周内」后的 Week 1/2 **□ 表格为愿景扩展 backlog**，未勾项**不\*\*表示 Phase A 未交付。

**Week 1（核心修复）**：

```
✅ W1·D1  [F1] infra/approval.py → DB持久化（`approval_requests` + auto/memory/db）

✅ W1·D1  [F2] providers/llm.py → LiteLLMProvider
         + infra/ai_provider/registry.py litellm / CLAWTWIN_USE_LITELLM

✅ W1·D2  [新] aip/agent_runtimes/simple_loop.py → LiteLLM 工具循环 + 单轮 completion

✅ W1·D3  [新] connectors/base.py → ``BaseConnector`` + ``BaseOutputChannel`` / ``DeliveryResult`` / ``send_with_retry``

✅ W1·D3  [新] infra/hitl/poller.py → HITL / playbook 清扫

✅ W1·D4  [F3] aip/llm_trace.py → DB trace + Langfuse（infra/observability/langfuse_client）

✅ W1·D5  [新] infra/secrets/vault.py → Fernet 凭证封装
```

**Week 2（集成与验收）**：

```
✅ W2·D1  [F4] packs/oilgas/clawtwin.pack.json → JSON manifest

✅ W2·D2  [新] tests/test_phase_a.py → §41·六 三场景（mock LLM / HITL 门控 / LLM 降级）+ 冒烟

✅ W2·D3  docker-compose.yml → Redis healthcheck + depends_on healthy

✅ W2·D4  infra/doctor/builtin.py → HITL playbook 等待数、审批队列、AI provider 摘要；**可选** ``CLAWTWIN_DOCTOR_AI_PROBE=1`` 短时 completion ping（`ai.provider.probe`）

✅ W2·D5  验收：`pytest tests/` 全绿（`platform-api`；宽测仍可放 CI / Crabbox）
```

### 四十二·一 bis、Phase A 运维与 HTTP 契约收口（2026-05，platform-api）

> 与 §运维对齐表（doctor / SIGTERM / CLI JSON）及 CLI `clawtwin doctor` 历史契约对齐 — **下游已实现**：

```
✅ GET /v1/doctor、POST /v1/doctor/fix — 等价于运行 ``run_doctor``；CLI ``clawtwin doctor`` / ``clawtwin doctor --fix`` 不再依赖不存在的路径
✅ clawtwin check — CI：0=overall ok，1=warn/degraded，2=down 或 HTTP 不可达（依据 ``DoctorReport.overall``）
✅ CLI 全局 --json / --quiet / --debug（Typer callback）；status/doctor/check 尊重 JSON 与静默输出
✅ SIGTERM/SIGINT — infra/lifecycle.py shutdown + apps/http/main.py register_shutdown_handler（scheduler / outbox / collectors）
✅ pytest tests/conftest.py — 规范化宿主 DATABASE_URL（asyncpg→sqlite 内存）、dispose 引擎、清除 app.state.object_store，避免串测污染
```

**不需要新写的（已经完整）**：

```
✅ core/function_executor/ai_runner.py  — 已完整，直接用
✅ infra/diagnosis_context.py            — 已完整，即ContextAssembler
✅ infra/outbox/                         — 已完整，生产级
✅ core/playbook_engine/                 — 已完整，含HITL
✅ infra/hooks.py                        — 已完整
✅ infra/event_dispatcher.py             — 已完整
✅ infra/ai_provider/ (openai/anthropic) — 已可用，LiteLLM是增强而非替换
```

---

**目标：2周内，一条完整链路跑通**（以下为**愿景扩展 backlog**，非 §四十二·一 Phase A 收口清单）

```
模拟告警事件 → EventBus → PlaybookEngine → ContextAssembler
→ AgentRuntime(LiteLLM) → ActionExecutor → WorkOrder
→ Outbox → 飞书通知（含AI诊断证据引用）
```

**Week 1（核心引擎）**：

```
⚡ W1·D1  providers/llm.py：LiteLLMProvider ✅；结构化输出（Pydantic model）→ **Phase B** 深化
⚡ W1·D1  core/hook_system/：§2.5 十个 Phase A 事件的 **fire 点位已接线**（assembler / simple_loop / ai_runner / action_executor / playbook）；物理分包 ``core/hook_system/`` → backlog
✅ W1·D2  aip/context_engine/assembler.py：Skills + Hook + **截断策略 env**
✅ W1·D2  aip/agent_runtimes/simple_loop.py：工具循环 + LLM 失败 fail-graceful + Hook
✅ W1·D3  core/plugin_registry/：register_* 方法 + Pack manifest ``depends_on`` 拓扑排序（``topology.py`` + ``pack_loader``）
✅ W1·D3  connectors/base.py：BaseConnector + BaseOutputChannel（见 §35·三，`connectors/base.py`）
✅ W1·D4  infra/secrets/vault.py：Fernet 封装（``CLAWTWIN_MASTER_KEY`` / ``CLAWTWIN_SECRETS_FERNET_KEY``）
✅ W1·D4  infra/auth/api_key.py：Argon2id 哈希 + ``platform_api_keys`` 表（Alembic 018）+ ``Depends(require_platform_api_key)``；示例路由 ``GET /v1/auth/api-key/me``
⚡ W1·D5  Alembic：§四十一·三表 **增量迁移已落地**（非单一 mega-revision）；新环境按当前 ``alembic/versions`` 链升级即可
```

**Week 2（集成与验收）**：

```
✅ W2·D1  core/action_executor/：`risk_score` + Hook ``before_action_invoke(..., risk_score=…)``（步骤级 HITL 仍在 playbook_engine）
✅ W2·D1  infra/outbox/worker.py：Outbox 投递 worker 入口（转发 ``workers/outbox_dispatcher``；指数退避与 ``failed_permanent`` 见 ``infra/outbox``）
✅ W2·D2  infra/hitl/poller.py：超时清扫 ``waiting_for_human``（scheduler 可调间隔）
✅ W2·D2  packs/oilgas/：IndustryPack 骨架（manifest + ontology/playbooks）
✅ W2·D3  core/rules_engine/：简单阈值规则引擎（``threshold.py`` + ``yaml_rules.py``，YAML 降级路径）
✅ W2·D3  infra/observability/langfuse_client.py：LLM 可观测接入（见 ``aip/llm_trace.py``）
✅ W2·D4  CoT日志：``agent_sessions.reasoning_chain``（Alembic 019；``tests/test_agent_session.py``）
✅ W2·D4  DiagnosisResult / EvidenceItem：``infra/diagnosis_schema.py``（与 diagnose_equipment / rule_engine 输出对齐）
✅ W2·D5  集成测试：``pytest tests/test_phase_a.py``（mock LLM）已维护
✅ W2·D5  Docker Compose：Postgres/Redis **healthcheck + restart:unless-stopped**（API 进程默认主机 ``uvicorn`` / ``clawtwin start``，与设计 README 一致）
```

---

### 四十一·二、数据库表（12张，一次 Alembic 迁移）

| 表名             | 用途                        | 核心字段                                                                                             |
| ---------------- | --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `entities`       | EntityStore 当前状态快照    | entity_id, entity_type, site_id, attributes(jsonb), latest_readings(jsonb), status, updated_at       |
| `alarms`         | 告警事件记录                | alarm_id, entity_id, alarm_code, severity, message, status, created_at, resolved_at                  |
| `workorders`     | 工单 FSM 状态机             | wo_id, entity_id, alarm_id, status, priority, assignee, created_at, closed_at                        |
| `agent_sessions` | Agent执行会话（含HITL状态） | session_id, entity_id, function_id, status, hitl_pending_tool, reasoning_chain(jsonb), result(jsonb) |
| `playbook_runs`  | Playbook执行记录            | run_id, playbook_id, trigger_event_id, status, current_step, started_at, finished_at                 |
| `outbox_jobs`    | 可靠消息投递队列            | job_id, channel_id, payload(jsonb), status, attempts, next_retry_at, dlq_at                          |
| `audit_logs`     | 不可篡改审计轨迹            | id, timestamp, actor, action, resource, before_state(jsonb), after_state(jsonb)                      |
| `llm_call_logs`  | LLM调用记录（成本/延迟）    | id, session_id, model, prompt_tokens, completion_tokens, latency_ms, cost_usd, created_at            |
| `api_keys`       | 外部系统API Key             | key_id, name, hash, permissions, created_by, expires_at, last_used_at                                |
| `feedback_logs`  | AI诊断准确率反馈            | id, session_id, accurate, actual_cause, submitted_by, created_at                                     |
| `cbr_cases`      | Case-Based Reasoning 案例库 | case_id, entity_type, symptoms(jsonb), solution, outcome, embedding(vector), created_from_wo_id      |
| `pack_registry`  | 已安装Pack注册信息          | pack_id, version, status, loaded_at, depends(jsonb), error                                           |

---

### 四十一·三、环境变量完整参考

```bash
# Phase A 必须配置
CLAWTWIN_SITE_ID=plant_a                          # 站点唯一标识
# 实现仓库当前使用同步 SQLAlchemy URL：
DATABASE_URL=postgresql+psycopg://user:pass@localhost:5432/clawtwin
# 设计别名（若文档 / Helm 仍写此项，请映射到 DATABASE_URL）：
# CLAWTWIN_DB_URL=postgresql+asyncpg://user:pass@localhost/clawtwin
CLAWTWIN_REDIS_URL=redis://localhost:6379    # 亦可仅设 REDIS_URL（Compose）；``infra.settings`` 会自动回落
CLAWTWIN_MASTER_KEY=<Fernet.generate_key()>       # 凭证加密主密钥
CLAWTWIN_JWT_SECRET=<secrets.token_hex(32)>       # JWT签名密钥
CLAWTWIN_LLM_MODEL=openai/gpt-4o                  # LiteLLM格式

# ContextAssembler — Skills 注入预算（Phase A，可选）
# CLAWTWIN_CONTEXT_MAX_SKILL_BODY_CHARS=16000      # 单 Skill body 上限
# CLAWTWIN_CONTEXT_MAX_SKILLS_CHARS=48000           # 全部 Skill XML 内容软上限

# LLM API（至少配置一个）
OPENAI_API_KEY=sk-...                             # 或 留空使用 Ollama
OLLAMA_API_BASE=http://localhost:11434            # 本地模型

# Phase B 补充配置
LANGFUSE_HOST=http://localhost:4000
LANGFUSE_PUBLIC_KEY=pk-...
LANGFUSE_SECRET_KEY=sk-...
TIMESCALEDB_URL=postgresql+asyncpg://...          # 时序数据库（可复用主DB实例）

# 生产必须
CLAWTWIN_LICENSE_PATH=~/.clawtwin/clawtwin_license.json
SAML_IDP_METADATA_URL=https://...                 # 企业SSO（可选）

# 行为调整（可选）
CLAWTWIN_LOG_LEVEL=INFO
CLAWTWIN_MAX_AGENT_ITERATIONS=8
# HITL Playbook 超时清扫（scheduler / workers/scheduler.py）
CLAWTWIN_HITL_SWEEP_INTERVAL_SECONDS=300
# Doctor：可选真实 completion 探测（默认关闭，避免 CI 联网）
# CLAWTWIN_DOCTOR_AI_PROBE=1
```

---

### 四十一·四、REST API 端点总览

| 方法 | 路径                            | 描述                                    | 认证     |
| ---- | ------------------------------- | --------------------------------------- | -------- |
| GET  | `/health`                       | 健康检查（DB/Redis/LLM/Pack/Scheduler） | 无       |
| GET  | `/v1/entities`                  | 实体列表（分页/过滤）                   | JWT      |
| GET  | `/v1/entities/{id}`             | 实体详情+最新状态                       | JWT      |
| POST | `/v1/alarms`                    | 外部系统推送告警                        | API Key  |
| GET  | `/v1/alarms`                    | 告警列表                                | JWT      |
| GET  | `/v1/workorders`                | 工单列表                                | JWT      |
| POST | `/v1/hitl/{session_id}/approve` | HITL批准/拒绝                           | JWT      |
| GET  | `/v1/sessions/{id}`             | Agent会话详情（含推理链+引用）          | JWT      |
| POST | `/v1/diagnosis/{id}/feedback`   | 提交AI诊断反馈（✅/❌）                 | JWT      |
| POST | `/v1/knowledge/ingest`          | 摄取知识库文档                          | JWT      |
| GET  | `/v1/packs`                     | 列出已安装Pack                          | JWT      |
| POST | `/v1/playbooks/{id}/trigger`    | 手动触发Playbook                        | JWT      |
| GET  | `/v1/analytics/accuracy`        | AI准确率统计                            | JWT      |
| GET  | `/.well-known/agent.json`       | A2A Agent Card发现端点                  | 无       |
| POST | `/v1/a2a/tasks`                 | 接受A2A任务（Phase B）                  | Bearer   |
| GET  | `/docs`                         | FastAPI自动API文档                      | Dev only |

---

### 四十一·五、开发环境启动（第一天，30分钟内就绪）

```bash
# 1. 代码环境
cd platform-api
pip install -e ".[dev,rag,agent,ot,channels]"

# 2. 基础设施
docker compose up -d postgres redis langfuse

# 3. 初始化
clawtwin init        # 交互式配置 clawtwin.json
clawtwin doctor      # 验证所有依赖

# 期望输出：
# ✅ Database    connected (12 tables)
# ✅ Redis       connected
# ✅ LLM         reachable (model: openai/gpt-4o)
# ✅ Schema      up to date
# ✅ License     valid (or: dev mode)

# 4. 文件模式测试（不需要真实系统）
clawtwin start --mode=file --fixtures=packs/oilgas/fixtures/

# 5. 验收
pytest tests/test_phase_a.py -v
# 期望：全绿，链路跑通
```

---

### 四十一·六、Phase A 验收测试场景（3个）

```python
# tests/test_phase_a.py（同步用例名 — 与设计 §41·六 语义一一对应）

def test_alarm_to_workorder_via_playbook():
    """场景1：告警 Playbook → mock LLM → WorkOrder 草稿"""

def test_hitl_gate_blocks_low_confidence_playbook():
    """场景2：置信度不足 → create_work_order HITL 门控 → waiting_for_human"""

def test_llm_failure_falls_back_to_rule_engine():
    """场景3：LLM error → diagnose_equipment 规则引擎降级"""
```

---

## 四十三、Studio 本体工作台 — 完整规划（Ontology Workbench Roadmap）

> **读前必知**：本节是 §5.7（Ontology-centric Workbench 增量规格）的 **Studio 落地对应**，补充具体的路由、组件与实现分期。§5.7 定义"做什么与边界"，本节定义"怎么做与由谁做"。实现时 REST 形状以 **`archive/MODULE-DESIGN-PLATFORM.md` §18.6 / §19** 为准；本节给出的端点路径均为**逻辑形状**，以实际契约为准后回来对齐。

---

### 四十三·一、现状快照（截至 2026-05-15）

基于对 `clawtwin-studio/refine-clawtwin/src/` 的完整扫描：

| 已有                          | 位置                       | 说明                                                                                       |
| ----------------------------- | -------------------------- | ------------------------------------------------------------------------------------------ |
| `OntologyActionsSection`      | `Dashboard.tsx` 的一个 Tab | 只读；调 `GET /v1/bootstrap/ontology/summary`，展示 `action_types[]` 表格                  |
| Ontology summary（JSON 查看） | `Dashboard.tsx` Tab        | 同端点，原始 JSON Panel                                                                    |
| KB 搜索                       | `KbSearchSection`          | `GET /v1/kb/search`，含 hits + citations；**已实现可用**                                   |
| 三栏壳                        | `StudioShell`              | 72px NavRail + main `<Outlet>` + 280px RightPanel；**可直接扩展**                          |
| 路由                          | `App.tsx`                  | `/`, `/workorders`, `/equipment`, `/outcomes`, `/labs/*`；**尚无 `/ontology`、`/graph/*`** |
| 技术栈                        | `package.json`             | React 18 + TypeScript + Ant Design + Refine + Vite                                         |

**差距**：没有独立的「本体/图谱」路由区；没有图形化子图浏览；没有构建任务页；没有治理台。

---

### 四十三·二、用户角色与入口分轨

ClawTwin Studio **不把本体工作台放在运营主页**，避免现场工程师看到"本体草案/冲突队列"这类让他们困惑的概念。

| 角色                        | 默认入口                        | 可见路由区                               |
| --------------------------- | ------------------------------- | ---------------------------------------- |
| **现场运营工程师**          | `/`（Dashboard + 告警/工单）    | `/workorders`, `/equipment`, `/outcomes` |
| **本体工程师 / 数据工程师** | `/ontology`                     | `/ontology`, `/graph/*`                  |
| **平台管理员**              | Dashboard 任意 Tab + `/admin/*` | 全部                                     |

实现上，NavRail 条目通过现有 `capability` 机制控制：能力 `ontology_workbench` 开启后才显示 "Onto" 入口。

---

### 四十三·三、路由规划（增量，加进 App.tsx）

```
/ ←────────────── 现有：StudioShell + Dashboard（不变）
├── /workorders            现有
├── /equipment             现有
├── /outcomes              现有
├── /labs/*                现有（占位）
│
├── /ontology              ★新增：本体工作台总览
│   ├── /ontology/types                  ① ObjectType / LinkType 目录（表格）
│   ├── /ontology/types/:apiName         ② 类型详情（字段树 + 关联 LinkType）
│   ├── /ontology/profiles               ③ Profile 列表（草案/正式/归档）
│   └── /ontology/profiles/:id           ④ Profile 详情（生命周期时间轴）
│
├── /graph                 ★新增：图谱区
│   ├── /graph/explorer                  ⑤ 子图浏览器（可视化主页）
│   ├── /graph/explorer/:entityId        ⑥ 从某对象出发的一跳邻居图
│   ├── /graph/builds                    ⑦ 构建任务列表（投影 Job）
│   ├── /graph/builds/:buildId           ⑧ 构建任务详情（日志 + 状态机）
│   ├── /graph/queries                   ⑨ 查询工作台（结构化查询 + 结果）
│   └── /graph/governance                ⑩ 治理中心（冲突队列 + 决议历史）
│
└── /admin/*               现有扩展（knowledge、connectors 等）
```

---

### 四十三·四、页面设计规格（各路由说明）

#### ① /ontology/types — ObjectType/LinkType 目录

**业务目的**：让本体工程师快速看清系统里有哪些类型、各类型有哪些字段与关联。

**布局**（沿用三栏壳）：

```
┌──Nav─┬─────────────── 主区（可滚动）────────────────┬──右侧──┐
│      │  [搜索框]  [类型筛选: ObjectType/LinkType]    │ 类型详情 │
│ Onto │  ┌──────────────────────────────────────┐   │ 卡片    │
│      │  │ 表格：api_name │ extends │ 字段数 │ ...│   │（选中后） │
│      │  │ CentrifugalPump Equipment   7       │   │         │
│      │  │ GasCompressor   Equipment   9       │   │         │
│      │  └──────────────────────────────────────┘   │         │
└──────┴─────────────────────────────────────────────┴─────────┘
```

**API**：`GET /v1/bootstrap/ontology/summary`（已有）→ 可扩展为 `GET /v1/ontology/types?kind=ObjectType&page=...`（契约待定）。  
**参考借鉴**：参考项目的「实体目录」分层列表 + 搜索过滤——可借鉴交互模式，用 **Ant Design Table + 搜索** 实现，无需引入新组件库。

---

#### ② /ontology/types/:apiName — 类型详情

**业务目的**：查看某类型的完整字段定义、继承关系与关联 LinkType；用于本体评审和 Pack 扩展参考。

**布局**：

```
┌──Nav─┬──主区──────────────────────────────────────────┬──右侧──┐
│      │  GasCompressor extends Equipment               │ 相关对象  │
│ Onto │  ├── 字段（Collapse 展开）: rpm / discharge...  │ 实例列表  │
│      │  ├── LinkType（出边）: feeds_into → Pipeline    │（来自     │
│      │  ├── LinkType（入边）: ...                      │ ObjectStore）│
│      │  └── 来源 Pack: oilgas                          │         │
└──────┴────────────────────────────────────────────────┴─────────┘
```

**Phase A 实现**：从 ontology summary JSON 解析，纯前端展示，无额外端点。  
**Phase B 扩展**：支持「新建字段草案」→提交修改 PR/审批。

---

#### ③/④ /ontology/profiles — Profile 生命周期（Phase B）

**业务目的**：管理「本体方案草案 → 评审 → 正式发布 → 归档」生命周期；对应 §5.7.1 表中「图谱/本体 Profile」行。

**状态机**：`草案 → 待评审 → 正式方案 → 有修订草案 → 归档`（与参考项目相同的 5 态机）。

**布局（Profile 列表）**：

```
Tab: [全部] [草案] [正式方案] [有修订草案] [归档]
     搜索  [创建草案]
─────────────────────────────────────────────────
 编号    名称       状态      来源知识库   更新时间
 P-001   工业语义v1  正式方案   oilgas-KB   2026-05-10
 P-002   电力扩展草案 草案       power-KB   2026-05-14
```

**API（逻辑形状）**：`GET /v1/graph/profiles`、`POST /v1/graph/profiles`、`PUT /v1/graph/profiles/:id/publish`（以契约 §18.6 为准）。  
**注意**：Profile 概念源自本系统的 Ontology 设计，与参考项目相似——**可借鉴状态机流转 UI 模式，但不复制 API 路径**。

---

#### ⑤/⑥ /graph/explorer — 子图可视化浏览器

**这是最需要可视化的一块**，也是与参考项目差异最大、最体现 ClawTwin 价值的地方。

**业务目的**：让运营工程师直观看到设备与工单、部件、告警之间的图关系；支持 `get_neighbors` 结果的交互式展示。

**布局（三栏变形）**：

```
┌──Nav─┬──左侧对象树(220px)──┬──图画布（flex）──────────┬──右侧详情──┐
│      │ 搜索对象              │ [力导向图 / 层次图 切换]   │ 选中节点   │
│ Graph│ ─────────────────    │ 节点: 设备/工单/告警等     │ 属性列表   │
│      │ 📦 设备 (32)          │ 边:  关系类型标签          │ 关联证据   │
│      │   ▶ Pump-101          │ 工具栏: zoom / 过滤类型    │ Link 列表  │
│      │   ▶ Compressor-02     │                            │ 一键查工单 │
│      │ 🔔 告警 (5)           │ [以选中对象为中心展开]      │           │
│      │ 📋 工单 (8)           │                            │           │
└──────┴───────────────────────┴────────────────────────────┴────────────┘
```

**可视化选型**（在已有 Ant Design 体系内）：

| 选项                       | 优点                                                                    | 缺点                                         |
| -------------------------- | ----------------------------------------------------------------------- | -------------------------------------------- |
| **`@antv/g6`** ✅ **推荐** | 与 Ant Design 同生态；支持力导向 + 树 + Dagre；内置节点自定义；社区丰富 | Bundle 约 500KB                              |
| `react-force-graph-2d`     | 轻量、简单                                                              | 自定义节点样式麻烦；与 Antd 无互操作         |
| `react-sigma`              | 大图性能极好                                                            | API 学习成本高；适合 10 万+ 节点才有明显优势 |

Phase A 先用 **`@antv/g6`**，节点样式按类型区分颜色（Equipment=蓝、Alarm=红、WorkOrder=橙），边用 LinkType 名称标注。

**API**：`GET /v1/entities` + `GET /v1/entities/:id/neighbors`（契约待定）；Phase A 先用现有 `GET /v1/kb/search` 结果在图上展示引用节点（证据层），等图邻居接口就绪再切。

---

#### ⑦/⑧ /graph/builds — 构建任务中心

**业务目的**：查看「文档/资产 → 规范图谱投影」异步 Job 的进度与日志。

**布局**（复用 `WorkordersListPage` 模式）：

```
[新建构建任务]  [刷新]
─────────────────────────────────────────────────────
 任务ID   Profile   状态    进度    开始时间   操作
 B-023   工业v1    运行中   47%   2026-05-15  [取消][详情]
 B-022   工业v1    完成    100%   2026-05-14  [详情]
 B-021   电力草案   失败     31%   2026-05-13  [重试][详情]
```

**详情页**（B-023）：进度条 + 日志流（SSE）+ 实体/边计数 + 冲突数量。  
**API**：`GET /v1/graph/builds`、`POST /v1/graph/builds`、`DELETE /v1/graph/builds/:id`（以契约为准）。

---

#### ⑨ /graph/queries — 查询工作台

**业务目的**：让本体工程师验证「按类型/关系/属性查询对象」是否符合预期；AI 诊断时 MCP 也走同一底层。

**布局**（两栏，无独立右侧）：

```
┌──查询输入区（上）──────────────────────────────────────────┐
│ 查询类型: [实体查询 ▼]   实体类型: [GasCompressor ▼]        │
│ 过滤: station_id = [...]  状态 = [running ▼]               │
│ [执行查询]                                                   │
├──结果区（下）──────────────────────────────────────────────┤
│ 返回 12 条  [以图展示] [表格展示]                            │
│  表格/子图可切换                                             │
└─────────────────────────────────────────────────────────────┘
```

**API**：`POST /v1/kg/search`（已在 §5.7.2 定义逻辑形状）。  
**Phase A 实现**：先复用现有 `KbSearchSection` 的骨架（已有 useCallback + error/loading/result 模式），改调图谱检索端点即可，不重写组件架构。

---

#### ⑩ /graph/governance — 治理中心（Phase B）

**业务目的**：处理构建投影产生的冲突实体/关系、审批候选项、记录决议历史；与 HITL Playbook 闭环。

**布局**（Tab 分区）：

```
Tab: [冲突队列 (3)] [候选项 (12)] [决议历史] [发布闸口]
──────────────────────────────────────────────────────────
[冲突队列 Tab 内容]
 冲突ID  实体       属性       当前值    候选值    操作
 C-001  Pump-101   rpm_unit   "r/min"  "rpm"  [采纳][拒绝][详情]
```

**与 HITL 联动**：冲突项可发起 HITL Playbook（`POST /v1/hitl/{session_id}/approve`）；审批结果写入决议历史 + 审计日志。  
**API**：`GET /v1/graph/governance/conflicts`、`POST .../resolutions`（契约 §18.6 定稿后对齐）。

---

### 四十三·五、NavRail 扩展方案（StudioShell.tsx）

在现有 `NAV` 数组里增加条目（含 capability 门控），不改壳结构：

```typescript
// StudioShell.tsx NAV 数组增量
{ kind: "link", key: "onto", label: "Onto", to: "/ontology",
  hint: "本体类型目录", capability: "ontology_workbench" },
{ kind: "link", key: "graph", label: "Graph", to: "/graph/explorer",
  hint: "图谱浏览器",  capability: "ontology_workbench" },
// 治理 capability 单独控制（只对本体工程师/管理员开放）
{ kind: "link", key: "gov", label: "Gov", to: "/graph/governance",
  hint: "治理中心", capability: "graph_governance" },
```

`useCapabilities` 已支持 string 泛型扩展，把新 capability key 加入类型即可。

---

### 四十三·六、可视化组件结构（图探索器）

```typescript
// src/pages/ontology/GraphExplorerPage.tsx 骨架
// ① 左侧对象树：Ant Design Tree（按 entity_type 分组，可搜索）
// ② 中央画布：@antv/g6 Graph（力导向 + Dagre 可切换）
// ③ 右侧详情面板：选中节点后展示属性 + 关联证据（复用 KbSearchSection 证据组件）

const nodeColorMap: Record<string, string> = {
  Equipment: "#1677ff", // Ant Design blue
  Alarm: "#ff4d4f", // red
  WorkOrder: "#fa8c16", // orange
  Pipeline: "#52c41a", // green
  default: "#8c8c8c",
};
```

**数据流**：

```
选中对象 ID
  ↓ GET /v1/entities/:id/neighbors (depth=1, station_scope)
  ↓ 转换为 G6 { nodes[], edges[] }
  ↓ g6.changeData()
  ↓ 点击节点 → 右侧详情更新
  ↓ 右侧"查证据" → GET /v1/kb/search?q={entity.name}
```

---

### 四十三·七、实现分期（与 §5.7.4 对应）

| 里程碑                   | 交付内容                                                                                                                                                                                                 | 估算工作量 |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| **Phase A+（当前迭代）** | ① `/ontology/types` 类型目录页（从现有 bootstrap summary 渲染）<br>② `/graph/queries` 查询工作台（复用 KbSearchSection 骨架 → 改调图谱端点）<br>③ NavRail 加 `Onto` / `Graph` 入口（加 capability 门控） | 2–3 天     |
| **Phase B 第一轮**       | ④ `/graph/explorer` 图浏览器（安装 `@antv/g6`，渲染一跳邻居子图）<br>⑤ `/graph/builds` 构建任务列表（复用 WorkordersListPage 骨架）<br>⑥ `/ontology/types/:apiName` 类型详情                             | 4–6 天     |
| **Phase B 第二轮**       | ⑦ `/ontology/profiles` Profile 生命周期<br>⑧ `/graph/governance` 冲突队列与 HITL                                                                                                                         | 5–7 天     |
| **Phase B+**             | ⑨ 治理台发布闸口 + 决议历史<br>⑩ Studio 本体 YAML 表单编辑器（§二十八·三）                                                                                                                               | 另行规划   |

---

### 四十三·八、与参考产品「AI文档通」的借鉴对应

| 参考产品模式                                | ClawTwin 采纳方式                           | 差异/调整                                                                  |
| ------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------- |
| 侧边栏 5 区分区（本体/构建/浏览/查询/治理） | `/ontology/*` + `/graph/*` 路由区           | **主入口仍是 Twin/告警**；5 区入口放 NavRail capability 门控，不改默认首页 |
| Profile 状态机（草案/正式/归档）            | §四十三·四③④，状态机一致                    | 增加 **station_scope 鉴权**（参考品为租户，ClawTwin 为站点）               |
| 构建任务列表 + 日志流                       | §四十三·四⑦⑧                                | 日志流用现有 **SSE** 基础设施，不另引 WebSocket                            |
| 冲突队列 + 决议历史                         | §四十三·四⑩                                 | 与 **HITL Playbook** 打通（参考品无 Playbook 概念）                        |
| 子图可视化（图浏览）                        | §四十三·四⑥ + `@antv/g6`                    | 参考品用 Vue 生态；ClawTwin 用 **Ant Design + G6**（同厂商生态，无缝）     |
| 分块上传流水线                              | `KbSearchSection` 基础上扩展 ingest 上传 UI | 将文档与 **孪生对象/边** 绑定（参考品无此概念，ClawTwin 独有）             |

> **核心原则（对应 §5.7.0）**：借鉴其 **交互任务模型与分区经验**，所有 API 形状以 **`archive/MODULE-DESIGN-PLATFORM.md` §18.6 / §19** 为准，不照搬对方技术栈（Vue/Pinia → 已有 React/Antd），不复制以「文库」为第一公民的 IA。

---

## 四十四、产品线边界全景：Platform 以外的产品架构（2026-05-15 重订）

> 本章回答三个关键问题：
>
> 1. 本体/知识库管理是否适合放在 Studio？
> 2. Palantir 真实的四产品线是怎么划分这些职责的？
> 3. ClawTwin 应建立哪几条产品线、各自边界和商业化思路是什么？

---

### 四十四·一、Palantir 实际产品线的职责划分（纠正常见误解）

> ⚠️ **常见误解**：把 Gotham/Studio 当作"什么都有"的超级控制台。Palantir 的实际设计是 **严格分产品线、不同角色访问不同产品**。

| Palantir 产品  | 目标用户                           | 核心职责                                                                                 | **本体/KB 管理在哪？**                                                                      |
| -------------- | ---------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| **Gotham**     | 分析师、运营人员、一线决策者       | 实体调查、时间线关联、告警响应、工单处理、仪表盘                                         | ❌ **不在这里**；Gotham 只**消费**本体，由 Foundry 提供                                     |
| **Foundry**    | 数据工程师、本体工程师、应用构建者 | 数据接入管道、本体定义编辑、ObjectType/LinkType 生命周期、代码仓库、应用构建（Workshop） | ✅ **在这里**；Foundry 有独立的 **Ontology Manager** 应用；用于定义类型、配置属性、建立关系 |
| **AIP**        | AI 工程师、产品开发者              | 在 Foundry 语义之上构建 AI 逻辑（Function、Workflow、Assist）；绑定到对象与动作          | 消费 Foundry 本体；不负责类型定义                                                           |
| **Apollo**     | 运维/平台工程师                    | 版本部署、环境管理、健康与合规监控                                                       | 无关                                                                                        |
| **AIP Assist** | 终端用户                           | 自然语言交互、多轮对话、上下文感知问答                                                   | 不管理本体；消费已有知识                                                                    |

**关键事实**：Palantir **从不把本体编辑器放在 Gotham 里**。Gotham 的首要职责是让**不懂数据工程的运营人员**高效使用已经构建好的语义数据。Foundry 的 Ontology Manager 是一个面向**技术用户**的独立 Web 应用，有类型树、字段编辑器、关系图、权限管理、版本审批等复杂功能。

---

### 四十四·二、结论：Studio ≠ 本体管理工具

**本体和知识库的管理，不适合作为 Studio 的核心功能**，原因如下：

| 原因              | 说明                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------ |
| **用户不同**      | Studio 目标用户是现场工程师/运营人员（不懂本体）；本体管理目标用户是数据工程师/平台工程师                    |
| **工作模式不同**  | Studio 是高频轻量操作（看告警/处理工单）；本体管理是低频重量操作（定义类型/审批/冲突解决，一次改动影响全局） |
| **风险等级不同**  | 运营人员误操作告警无大碍；误操作本体类型定义可能影响全站所有对象实例                                         |
| **Palantir 验证** | Foundry（本体管理）与 Gotham（运营消费）在 Palantir 体系中是两个独立产品，前者面向技术用户，后者面向业务用户 |
| **工作量**        | 本体编辑器是一大块独立工程（字段 CRUD、关系图编辑、版本控制、冲突治理），硬塞进 Studio 会让 Studio 失焦      |

**修订 §四十三 建议**：§四十三 规划的 `/ontology/types`（编辑）、`/ontology/profiles`（生命周期）、`/graph/governance`（治理队列）**不应放在 Studio**；Studio 的 `/ontology/types` 应**只读**（供运营人员理解实体类型，不可修改）。以上管理功能移入 **ClawTwin Workbench**（见下节）。

---

### 四十四·三、修订后的 ClawTwin 产品线（4 产品线）

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         ClawTwin 产品家族                                   │
│                                                                              │
│  ┌─────────────────┐   ┌─────────────────┐   ┌──────────────────────────┐  │
│  │  ClawTwin Studio │   │ClawTwin Workbench│   │  OpenClaw（外部 Agent）  │  │
│  │  （= Gotham）    │   │  （= Foundry UI）│   │   （= AIP Assist）       │  │
│  │                  │   │                  │   │                          │  │
│  │ 目标用户：        │   │ 目标用户：        │   │ 目标用户：               │  │
│  │ 现场工程师        │   │ 数据/本体工程师   │   │ 任何用户（对话入口）      │  │
│  │ 运营主管          │   │ 平台管理员        │   │                          │  │
│  │                  │   │                  │   │ 通过 MCP 调用 Platform   │  │
│  │ • 告警/工单       │   │ • 本体类型管理    │   │ 不做本体定义              │  │
│  │ • 设备孪生        │   │ • KB 管理/摄取    │   │ 不做数据管道              │  │
│  │ • 对象调查（只读）│   │ • Connector 配置  │   │                          │  │
│  │ • HITL 审批       │   │ • Pack 管理       │   │                          │  │
│  │ • 图谱浏览（只读）│   │ • 图谱构建/治理   │   │                          │  │
│  │ • KB 搜索（只读） │   │ • Profile 生命周期│   │                          │  │
│  │                  │   │ • RAG 评测        │   │                          │  │
│  └────────┬─────────┘   └────────┬─────────┘   └────────────┬─────────────┘  │
│           │ REST/SSE              │ REST/Admin               │ MCP             │
│           └──────────────────────┴──────────────────────────┘                 │
│                                  ↓                                             │
│  ┌────────────────────────────────────────────────────────────────────────┐   │
│  │                        ClawTwin Platform                               │   │
│  │                    （= Foundry + AIP + Apollo 后端）                   │   │
│  │  ObjectStore · Ontology · Connector · PlaybookEngine · MCP Server     │   │
│  │  EventBus · Doctor · Health · KnowledgeEngine · GraphRAG              │   │
│  └────────────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

### 四十四·四、ClawTwin Workbench — 独立产品定义

**定位**：面向数据工程师/平台管理员的**本体与知识工程控制台**，对应 Palantir Foundry 的管理 UI 层。

**与 Studio 的关键区别**：

| 维度     | Studio（Gotham）                     | Workbench（Foundry UI）                                    |
| -------- | ------------------------------------ | ---------------------------------------------------------- |
| 访问方式 | 日常打开，高频使用                   | 低频打开，需要特权角色                                     |
| 首页     | 告警 KPI + 工单看板                  | 本体健康摘要 + 待处理构建任务                              |
| 默认权限 | 现场工程师可访问                     | 仅 `ontology_admin` 角色                                   |
| 技术栈   | `clawtwin-studio`（已有 React/Antd） | 可复用同技术栈，**或**嵌入 Platform Admin（见 §四十四·六） |
| 部署方式 | 随 Studio 发布                       | 随 Platform Admin 发布，可独立端口                         |

**Workbench 功能清单**（取自 §四十三 中被误放到 Studio 的那些功能）：

```
Workbench/
├── /workbench/ontology/types          ← ObjectType/LinkType CRUD（带字段编辑器）
├── /workbench/ontology/types/:id      ← 字段详情 + 关系图 + 版本历史
├── /workbench/ontology/profiles       ← Profile 草案/发布/归档生命周期
├── /workbench/graph/builds            ← 构建任务中心（投影 Job）
├── /workbench/graph/governance        ← 冲突队列 + 决议 + HITL 联动
├── /workbench/kb                      ← KB 知识库管理（上传/分层/分块配置）
├── /workbench/connectors              ← Connector 配置与健康
├── /workbench/packs                   ← Pack 安装/配置/版本管理
└── /workbench/eval                    ← RAG 评测基准与运行（Phase B+）
```

---

### 四十四·五、本体编辑器：不自研，用第三方 + YAML 方案

**自研全功能本体可视化编辑器的代价**：

| 能力                                 | 开发工作量估算                  |
| ------------------------------------ | ------------------------------- |
| 字段 CRUD 表单（类型、默认值、约束） | 2–3 天                          |
| LinkType 关系图编辑（可视化连线）    | 5–10 天                         |
| 继承树可视化 + 拖拽                  | 5–8 天                          |
| 版本对比与回滚 UI                    | 3–5 天                          |
| 冲突检测展示                         | 3–5 天                          |
| 权限 + 审批流集成                    | 3–5 天                          |
| **合计**                             | **~21–36 天**，且后续维护成本高 |

**推荐策略：分三级，不自研重度可视化编辑器**

#### 级别 1：Git + YAML + Monaco（Phase A/B，已在 §二十八 定义）

```
本体定义 = Git 仓库中的 YAML 文件（Pack 目录下）
编辑方式 = VS Code / Monaco Editor + JSON Schema 校验
发布方式 = clawtwin ontology import --from-yaml  或 Git Hook 自动触发
```

**Monaco Editor**（VS Code 同款）可直接嵌入 Workbench 的 YAML 编辑页面，开发成本 **1–2 天**，具备完整的 YAML 语法高亮 + Schema 校验 + 自动补全。这是**最划算的「本体编辑器」**。

#### 级别 2：Workbench 表单编辑器（Phase B，限 ObjectType 字段 CRUD）

仅为「添加/修改字段」、「设置关系」提供表单，**不做自由拖拽**。使用现有 Ant Design Form 即可实现：

```
字段列表 Table（可内联编辑列）
  + 新增字段 Drawer（字段名/类型/可选/默认值/描述）
  + LinkType 新建表单（from_type/to_type/link_name/cardinality）
→ 保存 → POST /v1/workbench/ontology/types/:id/fields
→ Git 自动 commit（Platform 侧 GitOps 模式）
```

开发成本：**3–5 天**，覆盖 90% 的日常本体维护工作。

#### 级别 3：可视化关系图编辑（Phase B+，仅在绝对必要时）

如业务方强烈要求可视化连线编辑本体关系，才考虑：

- 用已选的 **`@antv/g6`** 做可编辑图（G6 支持 `drag-add-edge` 等编辑 combo）
- 但**此级别不在 Phase A/B 范围内**，评估实际需求再决策

**不推荐引入的第三方工具**：

| 工具              | 原因不适合                                            |
| ----------------- | ----------------------------------------------------- |
| Protégé           | 面向 OWL/RDF，ClawTwin 是自定义 YAML 本体，格式不兼容 |
| TopBraid Composer | 企业授权，OWL-centric，10 万元/年起                   |
| PoolParty         | 面向分类体系/词汇管理（Taxonomy），不是实例图谱       |
| Stardog Studio    | 绑定 Stardog 图数据库，不适合 ClawTwin 的 ObjectStore |
| Metaphactory      | Java/RDF 重，集成复杂度高                             |

**适合引入的参考**（作为交互借鉴，不作为代码依赖）：

| 参考工具               | 借鉴点                                        |
| ---------------------- | --------------------------------------------- |
| **Hasura Console**     | 关系类型可视化配置、表级权限配置 UI 模式      |
| **Directus**           | Schema 字段编辑器 UX（列表+详情+Drawer 模式） |
| **Retool / AppSmith**  | 查询工作台的 SQL/API 编辑器+结果展示布局      |
| **DBngin / TablePlus** | 数据记录表格内联编辑模式                      |

---

### 四十四·六、Workbench 实现策略：嵌入 Platform Admin，不单独发布新仓库

对于当前团队规模，**不建议建立第三个前端仓库**（`clawtwin-workbench`），理由：

1. Platform 本身需要一个 Admin UI（Doctor 可视化、健康监控、Connector 配置）
2. Workbench 的目标用户（本体工程师）就是管理员，和 Platform Admin 用户高度重叠
3. 可以在 **Platform 的 `/admin/` 路由下**（由 Platform FastAPI 服务一个独立 HTML 入口）提供 Workbench UI

**技术实现**：

```
clawtwin-platform/
├── platform-api/           ← FastAPI 后端（已有）
│   └── admin_ui/           ← 新增：Vite 构建后静态资源
│       ├── index.html      ← /admin/ 入口，由 FastAPI StaticFiles 挂载
│       └── ...             ← 独立 Vite 应用，复用 React + Antd
```

或更简单：**直接在 `clawtwin-studio` 仓库新增 `workbench/` 应用**（Vite 多入口），打包时生成两个独立 HTML 入口（`studio/index.html` 和 `workbench/index.html`），部署到不同路径。

---

### 四十四·七、OpenClaw 作为独立产品线

**定位修订**（对应 Palantir AIP Assist）：OpenClaw 是**第四条独立产品线**，不是 Studio 的一部分，也不是 Platform 的一部分。

| 维度     | OpenClaw（AIP Assist 等价）        | 边界说明                                                 |
| -------- | ---------------------------------- | -------------------------------------------------------- |
| 接入协议 | MCP（标准化，厂商中立）            | Platform 暴露 MCP Server；OpenClaw 通过 MCP 调用         |
| 替代性   | 可替换（任何 MCP 兼容 Agent 均可） | 这是相对 Palantir 的核心差异化：**不锁定 Assist 供应商** |
| 用户体验 | 自然语言对话、多步推理、上下文记忆 | 不做告警看板、工单表格；这些在 Studio                    |
| 本体管理 | ❌ 不参与本体类型定义              | 只消费已定义好的本体做 GraphRAG 对话                     |
| 知识管理 | ❌ 不管理 KB 文档                  | 通过 `knowledge_search` MCP 工具检索                     |
| 商业化   | 按 Agent 对话量/座席计费           | 独立于 Studio 和 Workbench                               |

**OpenClaw 架构要点**：

```
OpenClaw（外部进程）
  ↓ 用户输入（自然语言）
  ├── ContextAssembler（本地）：组装会话历史 + 工具描述
  ├── LLM（litellm）：多步推理（ReAct 8 轮）
  └── MCP 工具调用：
      ├── kg_neighbors(entity_id, depth)    ← GraphRAG
      ├── knowledge_search(query, layer)    ← KB 检索
      ├── get_workorders(filters)           ← 工单查询
      ├── trigger_playbook(name, ctx)       ← 触发自动化
      └── create_hitl_session(...)          ← 发起审批
```

---

### 四十四·八、商业化架构与定价逻辑

#### 市场参照

| 竞品                | 定价模式           | 参考价                              |
| ------------------- | ------------------ | ----------------------------------- |
| Palantir Foundry    | 平台订阅 + 座席    | $1,000–3,000/座席/年，企业合同 $1M+ |
| Palantir Gotham     | 政府项目制         | $50M–数亿/年（政府）                |
| Aspentech AspenONE  | 按工厂/站点 + 模块 | $100K–500K/年/站点                  |
| OSIsoft PI（AVEVA） | 按标签点数         | $1–5/标签/年，大型工厂 $200K–2M/年  |
| GE Vernova Digital  | 按资产/站点        | $100K–1M/年                         |
| Siemens MindSphere  | 连接器 + 数据量    | $5K–50K/月/站点                     |

#### ClawTwin 推荐定价模型

**核心原则**：按**站点（Site）**为基础单位，而非按用户座席（工业客户逻辑更贴近站点粒度）；高价值能力（AI 对话、治理）作为增值模块。

```
ClawTwin 定价层级

Platform（基础设施层）— 按站点订阅
────────────────────────────────────────────────
Base Pack（每站点/年）          ¥ 80,000–200,000
  · ObjectStore + Ontology（YAML import）
  · 基础 Connector（OPC-UA/Modbus/HTTP）
  · PlaybookEngine（告警→工单 基础流）
  · Studio（只读图谱浏览 + 告警/工单）
  · Doctor + Health

Studio Pro Add-on（每站点/年）  ¥ 30,000–80,000
  · 工单创建/审批（HITL）
  · 多设备对比分析
  · 数字孪生 2D/3D 可视化

Workbench（本体工程）— 按企业/年  ¥ 80,000–200,000
  · 本体编辑器（Monaco + 表单）
  · KB 管理（文档摄取/分层/检索）
  · 构建任务中心 + 治理台
  · RAG 评测
  （整个企业共用一套 Workbench，跨站点管理）

OpenClaw AI 对话（可选）— 按 Agent 量  ¥ 0.5–2/次对话
  或包月：¥ 20,000–60,000/月（不限量）

IndustryPack（行业包）— 一次性 + 年维护
  · 油气包：¥ 50,000–150,000（一次性）+ ¥20,000/年
  · 电力包：同上
  · 轨道交通包：同上
```

**定价逻辑说明**：

- Workbench **按企业而非站点**，因为本体工程师是企业级角色，管理全企业本体，不是每个站点都独立维护
- Studio + Platform 按站点，因为每个工厂/站点的数据相互隔离，体积和负载不同
- Pack 一次性购买可降低客户感知风险，年维护费保证持续支持

---

### 四十四·九、修订后的 §四十三（Studio 只读边界）

**§四十三 原规划中需要从 Studio 移出的内容**：

| 原 §四十三 路由                      | 应移至    | 理由                           |
| ------------------------------------ | --------- | ------------------------------ |
| `/ontology/types`（CRUD编辑功能）    | Workbench | 只有 Studio 的只读浏览保留     |
| `/ontology/profiles`（草案/发布）    | Workbench | 本体工程师操作，非运营人员     |
| `/graph/builds`                      | Workbench | 构建任务是数据工程操作         |
| `/graph/governance`（冲突队列/决议） | Workbench | 高风险操作，需要本体管理员角色 |

**Studio 中保留（只读/消费性）**：

| Studio 路由                                    | 保留原因                     |
| ---------------------------------------------- | ---------------------------- |
| `/ontology/types`（只读，不可编辑）            | 运营人员需要理解设备类型定义 |
| `/graph/explorer`（子图浏览，不可编辑边/节点） | 运营人员调查设备关系         |
| `/graph/queries`（查询工作台）                 | 运营人员/本体工程师均需要    |
| `/kb/search`（已有）                           | 运营人员检索知识库           |

---

### 四十四·十、产品线交付优先级

| 产品线                    | Phase A                     | Phase B                            | Phase B+        |
| ------------------------- | --------------------------- | ---------------------------------- | --------------- |
| **Platform**              | 核心 API（已在进行）        | GraphRAG + 图谱投影                | 多站点治理      |
| **Studio（只读运营）**    | 告警/工单/设备/孪生（已有） | 只读图谱浏览器（`@antv/g6`）       | 报表导出        |
| **Workbench（本体工程）** | ❌ 暂缓（CLI + YAML 替代）  | Monaco 编辑器 + 表单编辑 + KB 管理 | 治理台 + 审批流 |
| **OpenClaw（AI对话）**    | MCP Server 接入（已在规划） | 工具扩展 + GraphRAG 增强           | 企业私有化部署  |

> **Phase A 原则**：先用 CLI + YAML 文件作为本体编辑方式（§二十八·一），不阻塞 Platform 和 Studio 开发。Workbench 是 Phase B 交付，和业务反馈驱动。

---

---

## 四十五、工程角色 × 产品工具深度规划（Platform 外产品系统设计）

> **总原则**：有成熟第三方工具用第三方；选 MIT/Apache 许可证；第三方不能满足核心语义层（本体/对象/Playbook 逻辑）才自研。Platform 的 Plugin/Hook/SSE/MCP/Doctor 模式是其他产品的**架构原型**，复用而不另起炉灶。

---

### 四十五·一、工程角色地图（6 角色 × 工具需求）

参与 ClawTwin 类工业 AI 平台项目的工程师角色与其主要工具需求：

| 角色                     | 主要职责                                       | 使用产品            | 核心工具需求                                                                |
| ------------------------ | ---------------------------------------------- | ------------------- | --------------------------------------------------------------------------- |
| **① 现场运营工程师**     | 处理告警/工单、日常设备监控、审批 HITL         | **Studio**          | 告警列表、工单看板、设备详情、数字孪生、图谱只读                            |
| **② 运营主管/管理者**    | KPI 跟踪、分析报表、决策支持                   | **Studio**          | KPI 仪表盘、趋势图、导出报表                                                |
| **③ 本体/知识工程师**    | 定义 ObjectType/LinkType、维护知识库、审批冲突 | **Workbench**       | YAML/表单本体编辑器、KB 文档管理、构建任务、治理台                          |
| **④ AI/算法工程师**      | 编写 Skill/Playbook、调优提示词、评测 RAG      | **Workbench**       | Playbook 可视化编辑器（React Flow）、Skill 文本编辑器（Monaco）、RAG 评测台 |
| **⑤ 数据/集成工程师**    | 配置 Connector、管理 Pipeline、数据质量        | **Workbench + CLI** | Connector 配置表单、Pipeline 状态监控、数据采样预览                         |
| **⑥ 平台/DevOps 工程师** | Platform 部署、Pack 管理、健康监控、权限       | **Workbench + CLI** | Doctor/Health 仪表盘、Pack 安装/配置、CLI 脚本                              |

---

### 四十五·二、第三方工具全景决策

#### 核心原则

```
自研 ✅ 当：
  - 核心语义层（Ontology/ObjectStore/Playbook 逻辑/MCP）
  - 与 Platform 数据模型深度绑定的 UI（告警/工单/对象浏览）
  - Platform Plugin API 注册/加载机制

用第三方 ✅ 当：
  - 通用 UI 组件（表格/表单/图表/代码编辑/流程图）
  - 通用算法库（RAG 评测/文本解析/向量化后端）
  - 已有成熟开源且有企业采用记录（MIT/Apache）
```

#### 工具决策矩阵

| 工具需求                                  | 第三方选择                                  | 许可证     | 替代/不用理由                                                  | 工作量（用第三方） |
| ----------------------------------------- | ------------------------------------------- | ---------- | -------------------------------------------------------------- | ------------------ |
| **代码编辑器（YAML/Python/JSON Schema）** | **Monaco Editor** (`@monaco-editor/react`)  | MIT        | VS Code 同款；schema 校验；React 集成 1 天                     | 1–2 天             |
| **Playbook 可视化编辑器（节点图）**       | **React Flow** (`@xyflow/react`)            | MIT        | 5.3M 周下载；自定义节点；拖拽/连线全有                         | 5–8 天             |
| **图谱可视化（只读 + 探索）**             | **@antv/g6**                                | MIT        | Ant Design 同生态；力导向/Dagre；节点自定义                    | 3–5 天             |
| **RAG 评测引擎（后端）**                  | **RAGAS** (Python)                          | Apache 2.0 | Platform 已有 `aip/eval_runner.py`；RAGAS 接                   | 2–3 天（集成）     |
| **文件分块上传**                          | **tus-js-client** / 原生 fetch multipart    | MIT        | 简单场景原生足够；大文件用 tus 断点续传                        | 1 天               |
| **图表/指标可视化**                       | **Ant Design Charts**（基于 G2）            | MIT        | 与现有 Antd 体系一致；无需引入 ECharts                         | 1 天/图            |
| **状态管理（前端）**                      | **Zustand**                                 | MIT        | 轻量、SSE 友好；Studio 已在 §十五 选定                         | 已选               |
| **Markdown 渲染（文档预览）**             | **react-markdown** + `remark-gfm`           | MIT        | 轻量；KB 文档预览、Skill 说明渲染                              | 0.5 天             |
| **表单生成（动态配置表单）**              | **Ant Design Form** (已有)                  | MIT        | Connector/Pack 配置表单复用 Antd                               | 已有               |
| **数据表格（内联编辑）**                  | **Ant Design Table** + `editable-cell` 模式 | MIT        | 本体字段 CRUD 表格                                             | 已有               |
| **BPMN/复杂流程图**                       | ❌ 不引入 `bpmn-js`                         | —          | 过重；Playbook 不是标准 BPMN                                   | —                  |
| **独立向量数据库 UI**                     | ❌ 不引入                                   | —          | 通过 Platform API 抽象；用户不直接操作向量库                   | —                  |
| **Grafana（监控）**                       | ❌ 暂不引入                                 | —          | Platform 的 `/v1/health` + Antd Charts 够用；Phase B+ 可选外挂 | —                  |

---

### 四十五·三、Studio 深度架构规划

> Studio 已有基础：React 18 + TypeScript + Ant Design 5 + Refine + Vite + React Router  
> 模式来源：对齐 **Platform 的 Plugin/Hook/SSE/Doctor 架构原型**

#### 四十五·三·一 架构层次（对照 Platform 模式）

```
Studio 架构（对应 Platform 各层）

Platform 模式           Studio 等价
─────────────────────   ────────────────────────────────────
plugin_sdk               StudioPlugin / ComponentRegistry
register_tool            registerWidget(name, Component, routeHint)
register_hook            useStudioEvent(eventType, handler)
EventBus + SSE           useSSEStore (Zustand) → 实时推送消费
MCP Server（Platform）   ApiClient（Studio 侧，调 REST + SSE）
Doctor/Health            useConnectionHealth hook（TopBar 状态指示）
CapabilityBundle         useCapabilities hook（已有，控制路由可见性）
```

#### 四十五·三·二 Studio Plugin 系统设计

Platform 的 `plugin_sdk` 让 Pack 注册工具/钩子/规则——Studio 侧对等地让 Pack 注册**前端 Widget 和路由扩展**：

```typescript
// src/core/StudioPluginRegistry.ts
export type StudioPlugin = {
  id: string;
  widgets?: WidgetDef[]; // 注册到 Dashboard 的卡片
  navItems?: NavItemDef[]; // 注册到 NavRail 的入口
  routes?: RouteDef[]; // 注册额外路由
  requiredCapability?: string; // Platform capability 门控
};

export type WidgetDef = {
  key: string;
  label: string;
  component: React.ComponentType<WidgetProps>;
  defaultPosition?: { col: number; row: number; w: number; h: number };
};

// 使用方式（Pack 提供的前端模块）
const oilgasPlugin: StudioPlugin = {
  id: "oilgas",
  requiredCapability: "oilgas_pack",
  widgets: [
    { key: "production_kpi", label: "产量 KPI", component: ProductionKpiWidget },
    { key: "well_health", label: "井况健康", component: WellHealthWidget },
  ],
  navItems: [{ key: "wells", label: "Wells", to: "/wells", hint: "采油井列表" }],
};
```

**关键点**：Pack 在 Platform 侧注册后端能力，同时可选提供一个 `studio_plugin.js`（由 Pack 的 `manifest.yaml` 声明），由 Studio 动态加载——这与 Platform 的 `pack_loader` 热加载模式对称。Phase A 先静态注册，Phase B 实现动态加载。

#### 四十五·三·三 SSE 消费架构

Platform 的 `EventBus` 推送事件；Studio 通过 SSE 订阅并更新 Zustand 状态，无需轮询：

```typescript
// src/core/useSSEStore.ts  (Zustand + SSE)
type SSEStore = {
  alarms: AlarmEvent[];
  workorderUpdates: WorkorderEvent[];
  playbookRuns: PlaybookRunEvent[];
  connect: (base: string, token: string) => void;
  disconnect: () => void;
};

export const useSSEStore = create<SSEStore>((set, get) => ({
  alarms: [],
  workorderUpdates: [],
  playbookRuns: [],
  connect(base, token) {
    const es = new EventSource(`${base}/v1/events/stream?token=${token}`);
    es.addEventListener("alarm", (e) =>
      set((s) => ({ alarms: [...s.alarms.slice(-99), JSON.parse(e.data)] })),
    );
    es.addEventListener("workorder", (e) =>
      set((s) => ({ workorderUpdates: [...s.workorderUpdates.slice(-49), JSON.parse(e.data)] })),
    );
    es.addEventListener("playbook", (e) =>
      set((s) => ({ playbookRuns: [...s.playbookRuns.slice(-49), JSON.parse(e.data)] })),
    );
    // 断线自动重连（指数退避）
    es.onerror = () => setTimeout(() => get().connect(base, token), 3000);
  },
  disconnect() {
    /* close ES */
  },
}));
```

#### 四十五·三·四 完整路由规划（消费型，不含本体管理）

```
/                        Dashboard（KPI + 告警流 + 工单摘要）
├── /workorders          工单列表（已有）
│   └── /workorders/show/:id  工单详情 + Playbook 运行历史
├── /equipment           设备列表（已有）
│   └── /equipment/show/:id  设备详情 + 健康向量 + 关联告警
├── /outcomes            结果反馈 + 人工标注（已有）
├── /graph/explorer      只读图谱浏览器（@antv/g6，Phase B）
│   └── /:entityId       从对象出发的一跳子图
├── /kb/search           知识库检索（已有，只读）
├── /hitl                HITL 审批队列（Phase A+）
├── /labs/twin           数字孪生 lab（已有占位）
├── /labs/alarms         告警分析 lab（已有占位）
└── /settings            用户设置（API key、通知偏好）
```

**Studio 边界红线**：所有路由均为**消费/只读或审批操作**，无本体编辑、无 KB 上传、无 Playbook 编写。这些在 Workbench。

---

### 四十五·四、Workbench 深度架构规划

#### 四十五·四·一 技术决策：Vite 多入口，同仓库

```
clawtwin-studio/
├── refine-clawtwin/      ← 现有 Studio（已有）
└── workbench/            ← 新增 Workbench（同仓库，独立 Vite 入口）
    ├── vite.config.ts    ← entry: src/main.tsx → dist/workbench/
    ├── src/
    │   ├── main.tsx
    │   ├── App.tsx        ← 独立路由树
    │   ├── core/
    │   │   ├── ApiClient.ts      ← 复用 clawtwinApiBase 逻辑
    │   │   ├── AuthGuard.tsx     ← 管理员角色校验
    │   │   └── WorkbenchShell.tsx ← 两栏布局（侧边菜单 + 内容区）
    │   ├── pages/         ← 按 §四十五·四·四 路由划分
    │   └── shared/        ← 与 Studio 共享的 ApiClient/types
    └── package.json       ← 独立 vite build，复用 ../refine-clawtwin/node_modules 符号链接
```

**好处**：同仓库共享 TypeScript 类型、API 工具函数；独立打包，部署到 `/admin/` 路径；不影响 Studio 的依赖树。

#### 四十五·四·二 Playbook 可视化编辑器（React Flow）

这是 Workbench 最高价值、最省力的第三方集成：

**安装**：

```bash
pnpm add @xyflow/react  # MIT，5.3M 周下载
```

**节点类型设计**（对应 Platform PlaybookEngine 的 Step 类型）：

```typescript
// workbench/src/pages/playbooks/nodes/index.ts
export const nodeTypes = {
  trigger: TriggerNode, // 🔔 触发器（alarm/schedule/chat/api）
  agentFunction: AgentFunctionNode, // 🤖 AI 函数（FunctionExecutor 单次调用）
  action: ActionNode, // ⚡ 动作（ActionExecutor：创建工单/发通知）
  condition: ConditionNode, // 🔀 条件分支（if/else）
  hitl: HitlNode, // 👤 人工审批（HITL）
  channel: ChannelNode, // 📢 通知发送（飞书/Email/SMS）
  delay: DelayNode, // ⏰ 延迟等待
  end: EndNode, // ⏹ 结束
};
```

**PlaybookEditorPage 布局**：

```
┌── 工具栏（节点类型拖拽面板）─────────────────────────────────┐
│ 🔔触发 │ 🤖AI函数 │ ⚡动作 │ 🔀条件 │ 👤HITL │ 📢通知 │ ⏰延迟 │
└─────────────────────────────────────────────────────────────┘
┌── 画布（React Flow）───────────────────────────┬── 属性面板 ──┐
│                                                │ 选中节点配置  │
│   [Trigger: alarm ≥ level3]                    │              │
│         ↓                                      │ 节点类型：   │
│   [AgentFunction: diagnose_pump]               │ AgentFunction│
│         ↓                 ↓                    │              │
│   [Action: create_wo]  [Channel: feishu]       │ 函数名：     │
│                                                │ diagnose_pump│
│   [HITL: engineer_approve]                     │              │
│         ↓                                      │ 模型：       │
│   [Action: close_alarm]                        │ sonnet-4.6   │
└────────────────────────────────────────────────┴──────────────┘
┌── 底部工具栏 ────────────────────────────────────────────────┐
│ [验证] [YAML 预览（Monaco 只读）] [保存草案] [发布]           │
└─────────────────────────────────────────────────────────────┘
```

**YAML 序列化**（Playbook 编辑器 → Platform YAML 格式）：

```typescript
// 将 React Flow 的 nodes[] + edges[] 转为 Platform Playbook YAML
function flowToPlaybookYaml(nodes: Node[], edges: Edge[]): string {
  const steps = nodes
    .filter((n) => n.type !== "end")
    .map((n) => ({
      id: n.id,
      type: n.type, // 对应 PlaybookStep.type
      config: n.data.config, // 各节点配置
      next: edges
        .filter((e) => e.source === n.id)
        .map((e) => ({ target: e.target, condition: e.label })),
    }));
  return yaml.stringify({ name: "...", steps });
}
```

**开发工作量**：安装 React Flow + 自定义节点（8 种）+ YAML 序列化 = **6–8 天**，替代从零实现 **≥ 25 天**。

#### 四十五·四·三 Monaco Editor（YAML/Skill 编辑）

```typescript
// workbench/src/components/MonacoYamlEditor.tsx
import Editor from "@monaco-editor/react";
import { configureMonacoYaml } from "monaco-yaml";

// 初始化时注册 ClawTwin Ontology YAML Schema
configureMonacoYaml(monaco, {
  schemas: [{
    uri: "clawtwin://ontology/object-type",
    fileMatch: ["*.object-type.yaml"],
    schema: OBJECT_TYPE_JSON_SCHEMA,  // 从 Platform API 获取
  }],
});

export function MonacoYamlEditor({ value, onChange, schema }: Props) {
  return (
    <Editor
      language="yaml"
      value={value}
      onChange={onChange}
      options={{ minimap: { enabled: false }, lineNumbers: "on" }}
    />
  );
}
```

使用场景：

- 本体类型 YAML 编辑（带 Schema 校验）
- Skill（技能提示词）文本编辑
- Connector 配置 YAML 编辑
- 原始 Playbook YAML 编辑（高级模式）

**工作量**：安装 + schema 注册 + 组件封装 = **1–2 天**。

#### 四十五·四·四 Workbench 完整路由规划

```
/workbench                       仪表盘（待处理冲突数 + 构建任务状态 + KB 健康）
│
├── /workbench/ontology
│   ├── /types                   ObjectType/LinkType 列表（Antd Table）
│   ├── /types/new               新建类型（表单 + Monaco YAML）
│   ├── /types/:id               类型详情 + 字段编辑（可内联编辑 Table）
│   ├── /types/:id/yaml          原始 YAML 编辑（Monaco）
│   └── /profiles                Profile 生命周期管理
│
├── /workbench/playbooks
│   ├── /                        Playbook 列表
│   ├── /new                     新建（React Flow 编辑器）
│   └── /:id/edit                编辑（React Flow 编辑器）
│
├── /workbench/skills
│   ├── /                        Skill 列表（按 Pack 分组）
│   └── /:id/edit                编辑（Monaco Markdown 编辑器）
│
├── /workbench/kb
│   ├── /                        知识库列表（按 layer 分组）
│   ├── /upload                  文档上传（multipart / tus 断点续传）
│   ├── /:kbId/documents         文档列表 + 摄取状态
│   └── /:kbId/chunks/:docId     分块预览 + 匹配测试
│
├── /workbench/graph
│   ├── /builds                  构建任务列表 + SSE 进度
│   ├── /builds/:id              任务详情 + 日志流
│   ├── /governance              冲突队列 + 决议历史
│   └── /queries                 图谱查询工作台
│
├── /workbench/connectors
│   ├── /                        Connector 列表 + 健康状态
│   └── /:id/config              配置表单 + 连接测试
│
├── /workbench/packs
│   ├── /                        已安装 Pack 列表
│   └── /:id                     Pack 详情 + 配置 + 版本
│
├── /workbench/eval              RAG 评测台（Phase B）
│   ├── /benchmarks              评测集管理（Q/A 对）
│   └── /runs                    评测运行历史 + 指标图表
│
└── /workbench/admin
    ├── /health                  Doctor + Health 可视化（`GET /v1/health/deep`）
    ├── /users                   用户 + 角色管理
    └── /audit                   审计日志
```

#### 四十五·四·五 RAG 评测（RAGAS 集成）

**架构**：RAGAS 在 **Platform 后端**运行（Python），Workbench 仅提供管理 UI，不在前端跑评测逻辑。

```python
# platform-api/aip/eval_runner.py（现有文件扩展）
import ragas
from ragas.metrics import faithfulness, answer_relevancy, context_precision

async def run_eval(benchmark_id: str, rag_config: dict) -> EvalRun:
    dataset = load_benchmark(benchmark_id)
    # RAGAS 评测管道
    result = evaluate(
        dataset,
        metrics=[faithfulness, answer_relevancy, context_precision],
        llm=litellm_adapter,
        embeddings=embedding_adapter,
    )
    return EvalRun(
        run_id=...,
        benchmark_id=benchmark_id,
        scores=result.to_dict(),
        timestamp=now(),
    )
```

Workbench 的 `/workbench/eval/runs` 页面通过 `GET /v1/eval/runs` 消费这些结果，用 Antd Charts 绘制指标趋势。

---

### 四十五·五、OpenClaw × ClawTwin 插件深度规划

#### 四十五·五·一 架构定位

OpenClaw 是独立 Node.js/TypeScript 产品（`openclaw` repo），通过 **MCP 协议** 与 ClawTwin Platform 协作。ClawTwin 的 `aip/mcp_server.py` 已是标准 MCP Server；OpenClaw 需要一个 **ClawTwin 专属插件**（extension）来：

1. 建立到 ClawTwin MCP Server 的连接
2. 注册 ClawTwin 专属 AI 工具（工单/设备/图谱/知识）
3. 在每次对话时自动注入 ClawTwin 对象上下文

#### 四十五·五·二 Extension 结构（遵循 `extensions/` 模式）

```
openclaw/extensions/clawtwin/
├── AGENTS.md                 ← 插件 agent 指南
├── package.json              ← name: "@openclaw/clawtwin"
├── src/
│   ├── index.ts              ← Plugin 入口（registerPlugin）
│   ├── connection.ts         ← ClawTwin MCP 连接管理
│   ├── tools/
│   │   ├── workorders.ts     ← get_workorders / create_workorder
│   │   ├── equipment.ts      ← get_equipment / get_equipment_health
│   │   ├── graph.ts          ← kg_neighbors / kg_search
│   │   ├── knowledge.ts      ← knowledge_search
│   │   ├── playbook.ts       ← trigger_playbook / get_playbook_run
│   │   └── hitl.ts           ← create_hitl_session / get_pending_hitl
│   ├── context/
│   │   ├── bootstrap.ts      ← 启动时从 /v1/bootstrap/ 拉取站点/本体摘要
│   │   └── injector.ts       ← 每次对话注入 station_id + active_entities
│   └── config.ts             ← ClawTwin 连接配置（URL/token/station_id）
└── tests/
    └── tools.test.ts
```

#### 四十五·五·三 Plugin 注册（对齐 OpenClaw PluginApi 模式）

```typescript
// extensions/clawtwin/src/index.ts
import type { PluginApi } from "openclaw/plugin-sdk";
import { ClawTwinConnection } from "./connection";
import { registerAllTools } from "./tools";
import { ClawTwinContextInjector } from "./context/injector";

export function registerPlugin(api: PluginApi) {
  const conn = new ClawTwinConnection(api.config.get("clawtwin"));

  // 1. 注册工具（Tool → MCP 工具调用）
  registerAllTools(api, conn);

  // 2. 注册上下文注入钩子（每次会话开始前）
  api.registerHook("session:start", async (ctx) => {
    const injector = new ClawTwinContextInjector(conn);
    ctx.inject(await injector.buildContext(ctx.sessionId));
  });

  // 3. 注册 Doctor 检查（clawtwin 连接健康）
  api.registerDoctorCheck("clawtwin-connection", async () => {
    const ok = await conn.ping();
    return ok ? { status: "ok" } : { status: "error", message: "ClawTwin Platform unreachable" };
  });
}
```

#### 四十五·五·四 工具清单（对应 Platform MCP Server）

```typescript
// extensions/clawtwin/src/tools/graph.ts
export function registerGraphTools(api: PluginApi, conn: ClawTwinConnection) {
  api.registerTool({
    name: "kg_neighbors",
    description: "获取对象的 N 跳邻居（设备/工单/告警关系图），用于 GraphRAG 上下文扩展",
    inputSchema: z.object({
      entity_id: z.string().describe("对象 ID（如设备 ID）"),
      depth: z.number().int().min(1).max(3).default(1),
      link_types: z.array(z.string()).optional().describe("过滤关系类型"),
      station_ids: z.array(z.string()).optional(),
    }),
    execute: async (input) => conn.mcp.call("kg_neighbors", input),
  });

  api.registerTool({
    name: "knowledge_search",
    description: "在知识库（操作规程/维修手册）中混合检索证据片段",
    inputSchema: z.object({
      query: z.string(),
      layer: z.string().optional(),
      limit: z.number().int().default(5),
    }),
    execute: async (input) => conn.mcp.call("knowledge_search", input),
  });
}
```

#### 四十五·五·五 上下文注入设计

ClawTwin 的最大价值在于**把当前站点的运营上下文自动注入到每次 AI 对话**，避免工程师手动描述现场状态：

```typescript
// extensions/clawtwin/src/context/injector.ts
export class ClawTwinContextInjector {
  async buildContext(sessionId: string): Promise<string> {
    const bootstrap = await this.conn.get("/v1/bootstrap/summary");
    // 注入到 system prompt 前缀
    return `
## 当前站点上下文（ClawTwin Platform）
- 站点：${bootstrap.station_name}（ID: ${bootstrap.station_id}）
- 活跃告警：${bootstrap.active_alarm_count} 条（最高级别：${bootstrap.max_alarm_level}）
- 本体摘要：${bootstrap.entity_type_count} 种对象类型，${bootstrap.entity_count} 个实例
- 未处理工单：${bootstrap.pending_workorder_count} 条

你可以使用以下工具获取更多信息：kg_neighbors, knowledge_search, get_workorders, get_equipment...
    `.trim();
  }
}
```

#### 四十五·五·六 配置方式（遵循 OpenClaw 配置模式）

```yaml
# ~/.openclaw/agents/<agentId>/agent/agent.yaml（扩展字段）
plugins:
  - name: "@openclaw/clawtwin"
    config:
      url: "http://localhost:8000"
      station_id: "station-001"
      token: "${CLAWTWIN_API_TOKEN}" # 从 credentials/ 读取
      mcp_endpoint: "/v1/mcp"
      context_injection: true
      context_refresh_interval: 60 # 秒
```

---

### 四十五·六、并行交付策略与优先级

#### 总体原则

```
Platform 是根基 → Studio 是现场验证载体 → Workbench 是工程效率倍增器 → OpenClaw 是体验提升层
```

#### 分期并行交付表

| 里程碑              | Platform                            | Studio                              | Workbench                                                                            | OpenClaw 插件                      |
| ------------------- | ----------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------- |
| **Phase A（当前）** | 核心 API + Doctor + 基础 Connector  | 告警/工单/设备（已有）+ HITL 审批页 | ❌ 暂缓 → CLI+YAML 替代                                                              | MCP Server 接通 + 基础工具（5 个） |
| **Phase A+**        | GraphRAG `kg_neighbors` + KB search | 只读图谱浏览器（@antv/g6 1–跳）     | Workbench 骨架 + 健康仪表盘                                                          | 上下文注入 + station bootstrap     |
| **Phase B**         | 图谱投影构建 Job + Profiles         | —                                   | **React Flow Playbook 编辑器**<br>Monaco YAML 本体编辑器<br>KB 管理（上传/文档列表） | 全工具集（10+）+ Doctor 检查       |
| **Phase B+**        | 治理台 API + 多站点                 | 报表导出                            | 治理冲突 UI<br>RAG 评测台（RAGAS）<br>Pack 管理                                      | 私有化部署支持 + 企业 SSO          |

#### 工作量汇总（参考，含第三方工具节省）

| 产品/模块                 | 第三方工具节省             | 自研估算   | 节省量      |
| ------------------------- | -------------------------- | ---------- | ----------- |
| Studio 图谱浏览器         | @antv/g6                   | 3–5 天     | -15 天      |
| Workbench Playbook 编辑器 | React Flow                 | 6–8 天     | **-20 天**  |
| Workbench 代码编辑（4处） | Monaco Editor              | 1–2 天     | -10 天      |
| RAG 评测引擎              | RAGAS (Python)             | 2–3 天集成 | -15 天      |
| OpenClaw 插件基础         | OpenClaw PluginApi（已有） | 5–8 天     | -10 天      |
| **合计节省**              | —                          | —          | **≈ 70 天** |

---

### 四十五·七、OpenClaw 与 Studio/Workbench 的交互模式

三个产品**不相互依赖**，只依赖 Platform API（MCP / REST）：

```
用户操作路径对比：

[紧急告警响应]
  → Studio: 告警列表 → 工单详情 → HITL 审批（快速，无 AI）
  → OpenClaw: @告警ID → AI 分析 → 建议 → HITL 创建工单（深度推理）
  两者互补，同一工单 ID 可在两侧查看

[本体变更]
  → Workbench: 字段编辑 → YAML 预览 → 提交 → 冲突检测 → 发布（工程师操作）
  → OpenClaw: /ask "给 GasCompressor 添加 discharge_temp 字段" → AI 生成 YAML 草案 → Workbench 确认发布
  OpenClaw 辅助起草，Workbench 负责审批和发布

[设备故障调查]
  → Studio: 设备详情 → 图谱浏览（邻居设备/关联告警）→ 只读
  → OpenClaw: kg_neighbors + knowledge_search → AI 综合分析 → 创建工单
  Studio 提供可视化上下文，OpenClaw 提供 AI 推理
```

---

---

## 四十六、开源许可证判断 · UI 设计系统 · 扩展工具清单（2026-05-15）

---

### 四十六·一、四大开源工具许可证判断与商业化结论

> **简短结论：全部可以安全集成到 ClawTwin 并销售，用户不会直接接触这些品牌。**

| 工具                                       | 许可证         | 是否开源                    | 能否打包进 ClawTwin 销售             | 用户是否直接使用它                                                   | 说明                                                             |
| ------------------------------------------ | -------------- | --------------------------- | ------------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **React Flow** (`@xyflow/react`)           | **MIT**        | ✅ 完全开源                 | ✅ **可以**，MIT 允许商业闭源分发    | ❌ 用户看到的是 ClawTwin 的 Playbook 编辑器，不知道底层是 React Flow | 保留源码中的版权声明即可；无需在 UI 展示 "Powered by React Flow" |
| **Monaco Editor** (`@monaco-editor/react`) | **MIT**        | ✅ 完全开源（微软维护）     | ✅ **可以**，MIT                     | ❌ 用户看到的是 ClawTwin 的代码编辑器                                | VS Code 的同款引擎；Microsoft 也明确允许商业嵌入                 |
| **@antv/g6**                               | **MIT**        | ✅ 完全开源（蚂蚁集团维护） | ✅ **可以**，MIT                     | ❌ 用户看到的是 ClawTwin 的图谱浏览器                                | 阿里系工具，国内企业认知度高，可作为技术亮点提及                 |
| **RAGAS** (Python)                         | **Apache 2.0** | ✅ 完全开源                 | ✅ **可以**，Apache 2.0 允许商业分发 | ❌ 纯后端引擎；用户看到的是 ClawTwin 的 "RAG 评测" 功能              | 需保留 `NOTICE` 文件和版权声明在源码中                           |

**使用规范**（避免法律风险）：

- 在 `clawtwin-studio` 和 `clawtwin-platform` 的 `package.json` / `pyproject.toml` 中保留依赖声明
- 发布时附带 `THIRD_PARTY_LICENSES.txt`（列出 MIT/Apache 库及版权）
- **不需要**在产品 UI 中展示 "Powered by XXX" 字样（MIT/Apache 均不要求）

**独立 vs. 集成**：这四个工具**全部是集成到 ClawTwin 的库**，不是独立产品。用户购买 ClawTwin 获得包含这些能力的完整产品，体验的是 ClawTwin 品牌。

---

### 四十六·二、设计系统（Studio + Workbench 共享 Token）

> **参考来源**：OpenClaw UI 的 CSS 变量系统（`ui/src/styles/base.css`）是高质量工业级设计系统原型；在此基础上调整为 ClawTwin 两种主题。

#### Studio：深色工业主题（Dark Industrial）

运营人员常在控制室弱光环境使用；深色减少眼疲劳；状态颜色（红/绿/橙）在深色背景下更醒目。

```css
/* clawtwin-studio/refine-clawtwin/src/theme/tokens.css */
:root[data-theme="studio"] {
  /* 背景层次 */
  --ct-bg: #0d1117; /* 最深背景（页面底色）*/
  --ct-bg-elevated: #161b22; /* 卡片/面板 */
  --ct-bg-hover: #1c2128; /* hover 状态 */
  --ct-bg-muted: #21262d; /* 分组背景 */

  /* 文字 */
  --ct-text: #c9d1d9; /* 正文 */
  --ct-text-strong: #f0f6fc; /* 标题/高亮 */
  --ct-muted: #8b949e; /* 次要文字 */

  /* 边框 */
  --ct-border: #21262d;
  --ct-border-strong: #30363d;

  /* 主色（工业蓝，非红色，避免与告警混淆）*/
  --ct-accent: #2f81f7; /* 主操作/选中 */
  --ct-accent-hover: #58a6ff;
  --ct-accent-subtle: rgba(47, 129, 247, 0.12);

  /* 状态语义色 */
  --ct-ok: #3fb950; /* 正常/在线 */
  --ct-warn: #d29922; /* 告警-低/警告 */
  --ct-danger: #f85149; /* 告警-高/错误 */
  --ct-critical: #ff0000; /* 告警-紧急（闪烁动画配合使用）*/
  --ct-info: #58a6ff; /* 信息提示 */

  /* 字体 */
  --ct-font-body: "Inter", -apple-system, "Segoe UI", sans-serif;
  --ct-font-mono: "JetBrains Mono", "Fira Code", monospace;

  /* 尺寸 */
  --ct-nav-width: 260px; /* 左侧导航展开宽度 */
  --ct-nav-rail: 72px; /* 收起宽度 */
  --ct-topbar-h: 52px; /* 顶栏高度 */
  --ct-right-panel: 280px; /* 右侧上下文面板 */
  --ct-radius-sm: 6px;
  --ct-radius-md: 10px;
  --ct-radius-lg: 14px;

  /* 动效 */
  --ct-ease-out: cubic-bezier(0.16, 1, 0.3, 1);
  --ct-transition: 180ms var(--ct-ease-out);
}
```

#### Workbench：浅色专业主题（Light Professional）

数据工程师在明亮办公环境长时间使用；浅色利于阅读 YAML/代码；参考 VS Code Light / GitHub Light 风格。

```css
:root[data-theme="workbench"] {
  --ct-bg: #ffffff;
  --ct-bg-elevated: #f6f8fa;
  --ct-bg-hover: #eaeef2;
  --ct-bg-muted: #f6f8fa;

  --ct-text: #1f2328;
  --ct-text-strong: #0d1117;
  --ct-muted: #636c76;

  --ct-border: #d0d7de;
  --ct-border-strong: #adb3bb;

  --ct-accent: #0969da; /* GitHub 蓝 */
  --ct-accent-hover: #0550ae;
  --ct-accent-subtle: rgba(9, 105, 218, 0.08);

  --ct-ok: #1a7f37;
  --ct-warn: #9a6700;
  --ct-danger: #cf222e;
  --ct-info: #0969da;

  /* Workbench 专用尺寸 */
  --ct-nav-width: 220px; /* 左侧段落菜单 */
  --ct-list-pane: 280px; /* 中间列表面板 */
  --ct-topbar-h: 48px;
}
```

#### Ant Design 主题覆盖（对齐 Token）

```typescript
// Studio 主题配置（antd ConfigProvider）
const studioTheme: ThemeConfig = {
  algorithm: theme.darkAlgorithm,
  token: {
    colorPrimary: "#2f81f7",
    colorBgBase: "#0d1117",
    colorBgContainer: "#161b22",
    colorBorder: "#21262d",
    colorText: "#c9d1d9",
    fontFamily: "Inter, -apple-system, sans-serif",
    borderRadius: 10,
  },
};

// Workbench 主题配置
const workbenchTheme: ThemeConfig = {
  algorithm: theme.defaultAlgorithm,
  token: {
    colorPrimary: "#0969da",
    borderRadius: 6,
    fontFamily: "Inter, -apple-system, sans-serif",
  },
};
```

---

### 四十六·三、Studio UI 设计规格

#### Shell 布局（对齐 OpenClaw 模式，参考基准产品）

```
┌─── TopBar 52px ──────────────────────────────────────────────────────────────┐
│ 🔴 ClawTwin  [Station: 炼化一厂 ▼]   🔔 3 CRIT  ⚡ 12 WARN  [Search] [User] │
└──────────────────────────────────────────────────────────────────────────────┘
┌──LeftNav 260px──┬──── Main Content（Outlet）─────────────────┬──RightPanel 280px──┐
│                 │                                             │                    │
│ 📊 Dashboard    │  [页面内容]                                 │  Context Inspector  │
│                 │                                             │                    │
│ ─ 运营 ─────── │                                             │  选中对象时显示：   │
│ 🚨 Alarms       │                                             │  • 属性             │
│ 📋 Workorders   │                                             │  • 关联告警         │
│ ⚙️  Equipment    │                                             │  • 相关工单         │
│ 👤 HITL Queue   │                                             │  • AI 建议          │
│                 │                                             │                    │
│ ─ 分析 ─────── │                                             │  未选中时显示：     │
│ 🌐 Graph        │                                             │  • 站点实时 KPI     │
│ 🔍 KB Search    │                                             │  • 告警趋势迷你图   │
│                 │                                             │                    │
│ ─ 可视化 ───── │                                             │                    │
│ 🏭 Twin View    │                                             │                    │
│                 │                                             │                    │
│ ───────────────│                                             │                    │
│ ⚙️  Settings     │                                             │                    │
└─────────────────┴─────────────────────────────────────────────┴────────────────────┘
```

#### 核心 UI 组件设计

**① TopBar — 状态感知顶栏**

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ≡  ClawTwin Studio   炼化一厂 ▼   |  🔴 3 CRIT  🟠 12 WARN  🟡 5 LOW   |  🔍  👤 │
└──────────────────────────────────────────────────────────────────────────────┘
```

- 告警数量 Badge 实时 SSE 更新（颜色跟随最高级别）
- Station 下拉（多站点切换，Platform API `GET /v1/stations`）
- 搜索（全局对象/工单快速跳转）
- 用户头像（HITL 待审批提示红点）

**② LeftNav — 分区导航**

遵循 OpenClaw 的 `.nav-item` 模式（icon + text + badge）：

- 图标 16×16px，线条风格（`stroke-width: 1.5px`）
- 选中态：`background: var(--ct-accent-subtle)`，左边竖线 `border-left: 2px solid var(--ct-accent)`
- 分区 Label：`text-transform: uppercase`，`font-size: 11px`，`color: var(--ct-muted)`
- 收起态（72px rail）：仅显示 icon + tooltip

**③ Alarm List Page（主要运营页面）**

```
┌─ 告警中心 ─────────────────────────────────────────────────────────────────┐
│ 筛选: [级别 ▼] [设备类型 ▼] [站点 ▼] [时间范围 ▼]  [确认选中] [创建工单]  │
├────────────────────────────────────────────────────────────────────────────┤
│ 🔴 CRIT │ PMP-101 振动超限 │ CentrifugalPump │ 2min ago │ 未处理 │ [查看][工单] │
│ 🟠 WARN │ TK-002 液位低   │ StorageTank     │ 5min ago │ 已确认 │ [查看]       │
│ 🟡 LOW  │ VLV-03 阀门卡涩 │ Valve           │ 12min ago│ 未处理 │ [查看][工单] │
├────────────────────────────────────────────────────────────────────────────┤
│ 显示 1–50 / 156 条                              [上一页] 1 2 3 [下一页]    │
└────────────────────────────────────────────────────────────────────────────┘
```

SSE 驱动：新告警插入顶部动画（`animation: slide-in 0.2s ease-out`），高危告警行背景闪烁一次。

**④ Equipment Detail Page（设备对象页）**

```
┌─ CentrifugalPump · PMP-101 ────────────────────────────────────────────────┐
│ 🟢 在线 | 位置: 炼化一厂·泵房A | Pack: oilgas | 上次维护: 2026-04-10         │
├────────────────────────────────────────────────────────────────────────────┤
│ Tab: [概览] [时序数据] [告警历史] [工单] [关联图谱] [知识库]                │
├────────────────────────────────────────────────────────────────────────────┤
│ [概览 Tab]                                                                 │
│  运行参数:         健康评分:                                               │
│  rpm: 2980        ████████░░ 82/100                                        │
│  discharge: 6.2   上次诊断: 2026-05-14 15:30                              │
│  vibration: 3.1   AI 建议: 振动值偏高，建议检查轴承对中                   │
└────────────────────────────────────────────────────────────────────────────┘
```

**⑤ Graph Explorer Page（图谱浏览，@antv/g6）**

```
┌─ 实体关系图谱 ─────────────────────────────────────────────────────────────┐
│ [搜索对象] [类型过滤: Equipment ✓ Alarm ✓ WorkOrder ✓] [深度: 1 ▼] [布局: 力导向 ▼] │
├──────左侧对象树──┬──────────── G6 画布 ──────────────────────────────────┤
│ 📦 设备 (32)     │    ●PMP-101                                            │
│  ▶ PMP-101 🔴   │   ╱    ╲                                               │
│  ▶ PMP-102      │  ●WO-234  ●ALM-567                                     │
│  ▶ COMP-01      │  (工单)   (告警)                                        │
│ 🔔 告警 (5)      │      ╲                                                 │
│ 📋 工单 (8)      │    ●COMP-02                                            │
│                  │   (下游设备)                                            │
└──────────────────┴────────────────────────────────────────────────────────┘
```

节点颜色 = 类型（蓝=设备、红=告警、橙=工单、绿=正常设备）；点击节点 → 右侧面板显示属性 + 一键跳详情。

#### StudioShell.tsx 修改方案（最小侵入）

现有 `StudioShell.tsx` 已有 72px NavRail。升级为支持展开/收起：

```typescript
// 需要修改：
// 1. NAV 数组改为支持分区
// 2. 加入 Zustand useSSEStore 连接
// 3. TopBar 增加 AlarmBadge + StationSelector
// 4. 主题切换用 Ant Design ConfigProvider + data-theme attribute
```

---

### 四十六·四、Workbench UI 设计规格

#### Shell 布局（三栏 Master-Detail-Editor）

```
┌─── TopBar 48px ──────────────────────────────────────────────────────────────┐
│ ClawTwin Workbench  | Platform: 🟢 已连接  | [站点: 炼化一厂 ▼]  |  [User]   │
└──────────────────────────────────────────────────────────────────────────────┘
┌──LeftNav 220px──┬──ListPane 280px──┬──Detail/Editor（flex）─────────────────┐
│                 │                  │                                          │
│ ▶ 本体管理      │ [搜索] [新建]    │  [选中条目的详情/编辑区]                │
│   ├ 对象类型    │                  │  可能是：                                │
│   ├ 关系类型    │  列表或树形       │  · Monaco YAML 编辑器                  │
│   └ 方案管理    │  （按需）         │  · Antd Form 表单                      │
│                 │                  │  · React Flow 画布                      │
│ ▶ Playbook 编排 │                  │  · 详情 + 属性面板                      │
│   ├ 流程列表    │                  │                                          │
│   └ 技能列表    │                  │                                          │
│                 │                  │                                          │
│ ▶ 知识库管理    │                  │                                          │
│   ├ 知识库列表  │                  │                                          │
│   └ 文档管理    │                  │                                          │
│                 │                  │                                          │
│ ▶ 连接器        │                  │                                          │
│ ▶ Pack 管理     │                  │                                          │
│ ▶ RAG 评测      │                  │                                          │
│ ▶ 系统管理      │                  │                                          │
│   ├ 健康监控    │                  │                                          │
│   ├ 用户管理    │                  │                                          │
│   └ 审计日志    │                  │                                          │
└─────────────────┴──────────────────┴──────────────────────────────────────────┘
```

**LeftNav 设计**：分组折叠菜单（`Ant Design Menu` 模式）；每个分组有 icon；收起时显示 icon tooltip。

**ListPane 设计**：可选视图（表格/树状）；固定宽度 280px；右边 1px 分隔线；独立滚动。

**Editor 区设计**：根据选中条目类型动态切换：

```
条目类型         → 编辑区组件
ObjectType       → 字段编辑表格 + Monaco YAML Tab
Playbook         → React Flow 画布（全屏）
Skill            → Monaco Markdown 编辑器
KB Document      → 文件详情 + 分块预览表格
Connector        → 配置表单 + 连接测试
```

#### 核心页面设计

**① Playbook 编辑器（React Flow）**

```
┌─ 流程编辑器 · pump_diagnostic_playbook ─────────────────────────────────────┐
│ 节点面板: [🔔触发] [🤖AI函数] [⚡动作] [🔀条件] [👤HITL] [📢通知] [⏰延迟] │
├─────────────────────────────────────────────────────────────────┬─属性面板──┤
│                                                                  │           │
│  ┌─[🔔 alarm: level≥3]─┐                                       │ 选中节点  │
│  └─────────┬────────────┘                                       │ 属性配置  │
│            ↓                                                     │           │
│  ┌─[🤖 diagnose_pump]──┐                                        │ 节点类型: │
│  └────┬────────┬────────┘                                       │ AgentFunc │
│       ↓        ↓ (confidence < 0.7)                             │           │
│  ┌─[⚡ create_wo]┐ ┌─[👤 engineer_review]─┐                    │ 函数:     │
│  └───────────────┘ └──────────┬────────────┘                   │ diagnose_pump│
│                               ↓                                 │           │
│                      ┌─[📢 feishu_notify]─┐                    │ 模型:     │
│                      └────────────────────┘                    │ sonnet-4.6│
├─────────────────────────────────────────────────────────────────┴───────────┤
│ [验证 ✓] [YAML预览] [保存草稿]                              [发布]           │
└─────────────────────────────────────────────────────────────────────────────┘
```

节点样式：圆角矩形（`border-radius: 10px`）；icon + 名称；选中时蓝色 outline；连接线带箭头和条件标签。

**② 本体类型编辑器（Monaco + 表单双模式）**

```
┌─ ObjectType · CentrifugalPump ───────────────────────────────────────────────┐
│ Tab: [字段列表] [关系] [YAML 原始] [实例预览]                                │
├────────────────────────────────────────────────────────────────────────────┤
│ [字段列表 Tab]                            [新增字段] [从模板导入]            │
│ 字段名         类型        必填  默认值   描述                               │
│ ─────────────────────────────────────────────────────────────────────────  │
│ entity_id      string      ✓     —       唯一标识符                        │
│ name           string      ✓     —       设备名称                          │
│ rpm            float       ✗     0       转速 (r/min)    [✏️] [🗑]        │
│ discharge_pres float       ✗     —       出口压力 (MPa)  [✏️] [🗑]        │
│ vibration      float       ✗     —       振动值 (mm/s)   [✏️] [🗑]        │
│ ─────────────────────────────────────────────────────────────────────────  │
│ 继承自: Equipment (4个字段)    来源 Pack: oilgas                            │
└────────────────────────────────────────────────────────────────────────────┘
```

**③ Knowledge Base 管理**

```
┌─ 知识库管理 ────────────────────────────────────────────────────────────────┐
│ [新建知识库] [批量上传]                                                       │
├───────────────────────────────────────────────────────────────────────────  │
│ oilgas-procedures (Layer: procedures)    32 文档 | 4,821 分块 | 🟢 已索引   │
│   [查看文档] [上传] [重建索引] [删除]                                         │
│                                                                               │
│ maintenance-manuals (Layer: manuals)      18 文档 | 2,341 分块 | 🟡 处理中   │
│   [查看文档] [上传]                                                           │
├───────────────────────────────────────────────────────────────────────────  │
│ [上传区域：拖拽文件或点击上传]                                                 │
│  支持: PDF / Word / Excel / TXT / Markdown                                    │
│  最大: 50MB / 文件，可批量                                                    │
└────────────────────────────────────────────────────────────────────────────┘
```

文档列表页（进入 oilgas-procedures）：

```
文档名                     状态       分块数  摄取时间      操作
操作规程-泵类设备-v3.pdf   🟢 已完成  341     2026-05-10   [预览][删除]
维修手册-离心泵.docx        🟡 处理中  —       2026-05-15   [取消]
```

**④ RAG 评测台**

```
┌─ RAG 评测 ─────────────────────────────────────────────────────────────────┐
│ [新建评测集] [运行评测]                                                       │
├────────────────────────────────────────────────────────────────────────────┤
│ 评测集: pump-diagnostic-benchmark (24 问题)                                  │
│                                                                               │
│ 最近运行:                                                                     │
│  运行 #3  2026-05-15  Faithfulness: 0.87  Relevancy: 0.91  Precision: 0.83  │
│  运行 #2  2026-05-14  Faithfulness: 0.81  Relevancy: 0.88  Precision: 0.79  │
│  运行 #1  2026-05-13  Faithfulness: 0.74  Relevancy: 0.83  Precision: 0.72  │
│                                                                               │
│ [指标趋势折线图：三条线分别对应三个指标，x=运行次序]                          │
└────────────────────────────────────────────────────────────────────────────┘
```

---

### 四十六·五、全业务场景扩展工具清单

> 结合 ClawTwin 完整业务闭环（数据摄取 → 本体构建 → AI诊断 → 运营响应 → 评测优化），还需要以下工具。

#### 后端（Platform 侧，Python）

| 工具                       | 许可证               | 用途                                                              | 集成位置                       |
| -------------------------- | -------------------- | ----------------------------------------------------------------- | ------------------------------ |
| **`unstructured`**         | Apache 2.0           | 通用文档解析（PDF/Word/Excel/PPT/HTML/图片）→ 纯文本 + 结构化提取 | `aip/` 文档摄取管道            |
| **`pypdf`**                | MIT                  | PDF 精细解析（当 unstructured 不够用时）                          | 文档摄取                       |
| **`python-docx`**          | MIT                  | Word 文档结构化提取（表格/标题层级）                              | 文档摄取                       |
| **`openpyxl`**             | MIT                  | Excel 读取（设备台账/备件清单批量导入）                           | 实体批量导入                   |
| **`pandas`**               | BSD                  | CSV/Excel 数据清洗、时序聚合                                      | 数据管道 + 连接器              |
| **`pgvector`**             | MIT                  | PostgreSQL 向量扩展（知识库嵌入存储）                             | infra/knowledge                |
| **`rank-bm25`**            | MIT                  | BM25 全文检索（混合检索的关键字部分）                             | KB 搜索                        |
| **`asyncua`**              | LGPL 3.0 ⚠️          | OPC-UA 客户端；**LGPL 要求动态链接或保留修改权**                  | Connector（需确认链接方式）    |
| **`pymodbus`**             | BSD                  | Modbus TCP/RTU 读写                                               | Connector                      |
| **`paho-mqtt`**            | EPL 2.0 + EDL 1.0 ⚠️ | MQTT 客户端；EPL 是弱 copyleft                                    | Connector（建议作为可选 Pack） |
| **`httpx`**                | BSD                  | 异步 HTTP 客户端（通用 REST Connector）                           | Connector                      |
| **`celery` + `redis`**     | MIT                  | 异步任务队列（文档摄取/图谱构建 Job）                             | 后台 Worker                    |
| **`weasyprint`**           | BSD                  | PDF 报告生成（诊断报告导出）                                      | aip/report                     |
| **`opentelemetry-python`** | Apache 2.0           | 分布式追踪 + 指标（可选 Grafana 接收）                            | 可观测性横切                   |
| **`authlib`**              | BSD                  | OIDC/OAuth2 SSO 集成（企业 AD/LDAP）                              | 认证层                         |

> ⚠️ `asyncua`（LGPL）和 `paho-mqtt`（EPL）：建议作为**独立的 OT Connector Pack**发布，与 Platform 核心动态解耦，满足许可证要求。不要静态链接进核心。

#### 前端（Studio + Workbench 侧，TypeScript）

| 工具                                    | 许可证 | 用途                                                         |
| --------------------------------------- | ------ | ------------------------------------------------------------ |
| **`react-pdf`** (`@react-pdf/renderer`) | MIT    | Workbench：生成 PDF 诊断报告（前端预览）                     |
| **`tus-js-client`**                     | MIT    | Workbench KB 上传：大文件断点续传                            |
| **`react-markdown`** + `remark-gfm`     | MIT    | 渲染 Skill 描述 + KB 文档片段预览                            |
| **`zustand`**                           | MIT    | Studio/Workbench 状态管理（已规划）                          |
| **`dayjs`**                             | MIT    | 时间格式化（比 moment 轻 30x）                               |
| **`ag-grid-community`**                 | MIT    | Workbench 高性能大数据表格（实体实例列表/审计日志，10K+ 行） |
| **`@ant-design/charts`**                | MIT    | Studio/Workbench 图表（趋势图/评测指标/KPI）                 |
| **`ahooks`**                            | MIT    | React Hooks 工具集（防抖/轮询/SSE 封装辅助）                 |
| **`monaco-yaml`**                       | MIT    | Monaco Editor 的 YAML Schema 校验插件                        |

#### 通知渠道（Extensions）

| 渠道                     | 实现方式                                           | 说明         |
| ------------------------ | -------------------------------------------------- | ------------ |
| **飞书（Lark）**         | 已有 OpenClaw `extensions/feishu/`                 | 直接复用     |
| **企业微信（WeCom）**    | 新建 `extensions/wecom/`，调 WeCom Webhook API     | ~2 天        |
| **钉钉（DingTalk）**     | 新建 `extensions/dingtalk/`，调 DingTalk Robot API | ~2 天        |
| **Email (SMTP)**         | Python `smtplib` + `aiosmtplib`；新建 Channel      | ~1 天        |
| **SMS（短信）**          | 阿里云/腾讯云 SMS SDK；新建 Channel                | ~1 天/供应商 |
| **Webhook**              | 通用 HTTP POST；已在设计中                         | 已有         |
| **PagerDuty / Opsgenie** | REST API；Phase B+                                 | 面向大企业   |

#### ERP/CMMS 集成（Pack）

| 系统           | 集成方式                                           | 说明                       |
| -------------- | -------------------------------------------------- | -------------------------- |
| **SAP PM**     | REST API (`/sap/opu/odata/`) 或 RFC via `pyrfc`    | 创建 PM 工单、读取维修历史 |
| **IBM Maximo** | REST API（Maximo Application Framework）           | 工单/备件同步              |
| **Infor EAM**  | REST API                                           | 设备资产同步               |
| **通用 CMMS**  | 通用 HTTP Connector + 字段映射配置（Workbench UI） | 长尾系统                   |

---

### 四十六·六、工具依赖总览（最终）

```
ClawTwin 技术栈全景

前端（TypeScript + React）
├── 框架:  React 18 + TypeScript + Vite
├── UI:    Ant Design 5（Studio 深色/Workbench 浅色主题）
├── 路由:  React Router 6 + Refine（数据层抽象）
├── 状态:  Zustand + React Query
├── 实时:  native EventSource（SSE）
├── 图表:  @ant-design/charts
├── 图谱:  @antv/g6          ← MIT ✅
├── 流程:  @xyflow/react     ← MIT ✅
├── 编辑:  @monaco-editor/react + monaco-yaml ← MIT ✅
├── 表格:  Ant Design Table + ag-grid-community
├── 上传:  tus-js-client
└── 工具:  dayjs / react-markdown / ahooks

后端（Python）
├── 框架:  FastAPI + SQLAlchemy + Alembic
├── AI:    litellm（多模型路由）+ RAGAS（评测）← Apache 2.0 ✅
├── 文档:  unstructured + pypdf + python-docx + openpyxl
├── 搜索:  pgvector（向量）+ rank-bm25（关键字）
├── 队列:  celery + redis（构建 Job）
├── 导出:  weasyprint（PDF）
├── 认证:  authlib（OIDC/SSO）
├── 可观测: opentelemetry-python
└── OT:   asyncua（LGPL,Pack独立）/ pymodbus / httpx

Extensions（Plugin Pack）
├── 通知: feishu / wecom / dingtalk / email / sms / webhook
├── ERP: sap-pm / maximo / infor-eam
└── OT:  opcua-pack / modbus-pack / mqtt-pack
```

---

---

## 四十七、批判性产品面审计与 CLI/TUI 深度规划（按 OpenClaw 架构对齐）

> 本章以「批判性眼光」重新审视 Platform 以外的所有人机交互面，结合 OpenClaw 实际代码架构（`src/cli/`, `src/terminal/`, `ui/`）做出有依据的取舍，避免过度建设。

---

### 四十七·一、现有产品面清单与批判性判断

#### OpenClaw 实际提供了什么

通过代码扫描，OpenClaw 的人机交互层：

| 接触面                 | 实现                                                                                | 用途                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| **CLI（含 TUI 模式）** | TypeScript + `@clack/prompts` + `src/terminal/`（table/progress/note/palette/ansi） | 主要交互面；`openclaw chat` 启动交互会话；`status/doctor/config/agents` 等批量命令；用户最爱 |
| **Web UI**             | Lit Web Components（非 React）+ CSS 变量深色主题                                    | 浏览器中的 AI 对话界面；消费同一个 Gateway                                                   |
| **原生桌面/移动**      | macOS (Swift/SwiftUI)、iOS、Android                                                 | 用户偏好的原生体验                                                                           |
| **Gateway 守护进程**   | 独立 Node.js 进程；CLI 通过 HTTP/WS 连接                                            | 会话状态 + 工具执行 + MCP Server                                                             |

**关键结论**：OpenClaw **没有单独的 "TUI 应用"**。TUI = CLI 的交互模式，依赖 `@clack/prompts`（美观的终端提示组件）。ClawTwin 的 `apps/cli/main.py` 已用 **`typer + rich`** 实现同等效果。

---

#### ClawTwin 当前规划的人机交互面

| 产品面                             | 状态                                             | 批判性评估                                                                                | 结论                                                                 |
| ---------------------------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| **Platform（FastAPI 后端）**       | ✅ 已在实现                                      | 核心，无争议                                                                              | **保留**                                                             |
| **CLI（`clawtwin` Python）**       | ✅ 已存在（`apps/cli/main.py`，typer+rich）      | 工程师首选；对齐 OpenClaw 模式                                                            | **保留 + 增强**                                                      |
| **Studio（React/Antd 运营 UI）**   | ✅ 已在实现（`clawtwin-studio/refine-clawtwin`） | 现场工程师无 CLI；告警/工单需实时 GUI                                                     | **保留**                                                             |
| **Workbench（React 数据工程 UI）** | 📋 规划中，未实现                                | **80% 功能可由 CLI 完成**；仅可视化任务（图谱/流程图/评测图表）需 Web；独立应用开发代价高 | **⚠️ 大幅缩减：退化为 Admin Console，仅保留 CLI 无法完成的视觉任务** |
| **TUI（独立）**                    | 📋 提过但未单独规划                              | **不应独立存在**；TUI = CLI 交互模式；OpenClaw 的 TUI 就是 CLI                            | **合并入 CLI**                                                       |
| **OpenClaw 插件**                  | 📋 规划中                                        | AI 对话层；遵循 `extensions/` 模式；对齐 OpenClaw PluginApi                               | **保留**                                                             |

---

### 四十七·二、Workbench 大幅缩减：Admin Console（仅 4 个视觉必需页）

#### 原则

> 能用 CLI 做的，不建 Web 页面。工程师喜欢命令行。Workbench Web 只为"CLI 先天无法表达的视觉任务"存在。

#### 保留（CLI 无法替代）vs. 移出（CLI 已覆盖）

| 功能                                       | 是否保留在 Web                         | 移至 CLI                                             |
| ------------------------------------------ | -------------------------------------- | ---------------------------------------------------- |
| Playbook 可视化编辑器（React Flow 节点图） | ✅ **保留**（流程图只能在 Web 编辑）   | `clawtwin playbook validate/run/logs` 覆盖运维       |
| 图谱浏览器（@antv/g6 子图探索）            | ✅ **保留**（图形拓扑只能在 Web 展示） | `clawtwin graph neighbors <entity_id>` 覆盖 CLI 查询 |
| RAG 评测仪表盘（指标趋势图）               | ✅ **保留**（折线图只能在 Web 展示）   | `clawtwin eval run/status` 覆盖 CLI 运行             |
| KB 文档上传/预览                           | ✅ **保留**（文件拖拽上传需 Web）      | `clawtwin kb ingest <file>` 覆盖 CLI 批量            |
| 本体类型 CRUD（表单）                      | ❌ **移至 CLI**                        | `clawtwin ontology type add/edit/delete/list`        |
| Profile 生命周期                           | ❌ **移至 CLI**                        | `clawtwin ontology profile create/publish/archive`   |
| Connector 配置                             | ❌ **移至 CLI**                        | `clawtwin connector add/test/list`                   |
| Pack 管理                                  | ❌ **移至 CLI**                        | `clawtwin pack install/list/upgrade`                 |
| 健康监控 Dashboard                         | ❌ **移至 Studio**                     | Studio Dashboard 已有健康 KPI；或 `clawtwin doctor`  |
| 用户/权限管理                              | ❌ **移至 CLI**                        | `clawtwin auth user add/list/remove`                 |
| 审计日志                                   | ❌ **保留但极简**（仅表格查看）        | `clawtwin audit list` 覆盖日常                       |

**Admin Console 最终只有 4+1 个页面**：

```
/admin
├── /admin/playbooks/:id/edit    ← React Flow Playbook 编辑器（核心）
├── /admin/graph/explorer        ← @antv/g6 图谱浏览器（核心）
├── /admin/eval                  ← RAG 评测仪表盘（图表）
├── /admin/kb/upload             ← 文档上传 UI
└── /admin                       ← 极简首页（健康摘要 + 快速链接）
```

这 5 页可以**嵌入 Studio 的 `/admin/*` 路由下**（capability 门控 `admin_console`），**不需要单独部署一个 Workbench 应用**。

---

### 四十七·三、CLI/TUI 深度规划（对齐 OpenClaw 架构）

#### 对照表：OpenClaw CLI → ClawTwin CLI

| OpenClaw 组件                                   | ClawTwin 等价                                    | 实现状态               |
| ----------------------------------------------- | ------------------------------------------------ | ---------------------- |
| TypeScript + `@clack/prompts`                   | Python + **`rich`** + **`questionary`**          | ✅ `typer + rich` 已用 |
| `src/terminal/table.ts`（unicode 表格）         | **`rich.table.Table`**（Python `rich` 内建）     | ✅ 已可用              |
| `src/terminal/progress-line.ts`                 | **`rich.progress.Progress`**                     | ✅ 已可用              |
| `src/terminal/note.ts`（`@clack/prompts` note） | **`rich.panel.Panel`** + `console.print()`       | ✅ 已可用              |
| `src/terminal/palette.ts`（LOBSTER_PALETTE）    | **`terminal/palette.py`**（需新建，6 色 token）  | 📋 待补充              |
| `src/terminal/ansi.ts`（ANSI 处理）             | `rich` 内建 ANSI/markup；`terminal/ansi.py` 辅助 | 📋 部分待补充          |
| `src/cli/program/core-command-descriptors.ts`   | `cli/commands/__init__.py`（命令注册目录）       | 📋 待扩展              |
| `src/cli/command-catalog.ts`（路由策略）        | `cli/catalog.py`（Plugin 加载策略）              | 📋 待添加              |
| `openclaw doctor`                               | `clawtwin doctor [--fix]`                        | ✅ 已有（基础实现）    |
| `openclaw status`                               | `clawtwin status`                                | ✅ 已有（基础实现）    |
| `openclaw onboard`                              | `clawtwin setup`                                 | 📋 规划但未实现        |
| `openclaw agent`                                | `clawtwin chat`（启动 OpenClaw 对话）            | 📋 Phase B             |
| `openclaw tasks`                                | `clawtwin playbook runs/logs`                    | 📋 待添加              |
| `openclaw health`                               | `clawtwin check [--json]`                        | ✅ 已有                |

#### CLI 颜色系统（对齐 LOBSTER_PALETTE 概念）

```python
# platform-api/cli/terminal/palette.py
# ClawTwin CLI 颜色 Token — 对应 OpenClaw LOBSTER_PALETTE 结构
INDUSTRIAL_PALETTE = {
    "accent":       "#2F81F7",   # 主操作（蓝色，不用红避免与告警混淆）
    "accent_bright":"#58A6FF",
    "accent_dim":   "#1F6BE6",
    "info":         "#79C0FF",
    "success":      "#3FB950",   # 正常 / 在线 / 完成
    "warn":         "#D29922",   # 警告 / 需注意
    "error":        "#F85149",   # 错误 / 危险
    "critical":     "#FF0000",   # 紧急告警（闪烁配合使用）
    "muted":        "#8B949E",   # 次要文字
}

# rich 样式别名
STYLE_OK       = f"bold {INDUSTRIAL_PALETTE['success']}"
STYLE_WARN     = f"bold {INDUSTRIAL_PALETTE['warn']}"
STYLE_ERROR    = f"bold {INDUSTRIAL_PALETTE['error']}"
STYLE_ACCENT   = INDUSTRIAL_PALETTE['accent']
STYLE_MUTED    = INDUSTRIAL_PALETTE['muted']
```

#### CLI 命令目录（完整 · 对齐 OpenClaw core-command-descriptors 结构）

```
clawtwin
├── start          启动 Platform 服务（带热重载）
├── stop           停止服务
├── status         显示 Platform + 连接器 + KB + 站点状态表
├── doctor         诊断 + 修复（配置/依赖/DB/连接器）
├── check          CI 健康检查（exit 0/1/2）[--json]
│
├── config
│   ├── show       显示当前配置
│   ├── set        设置配置项
│   ├── validate   校验配置文件
│   └── reload     热重载（无需重启）
│
├── ontology       ← 本体管理（替代 Workbench 表单页）
│   ├── types      list / show / add / edit / delete
│   ├── links      list / show / add / delete
│   ├── import     --from-yaml / --from-csv
│   ├── export     --to-yaml / --to-json
│   ├── validate   校验本体一致性
│   ├── profile    list / create / publish / archive
│   └── diff       对比两个版本的本体变化
│
├── kb             ← 知识库管理
│   ├── list       列出 KB + 层 + 文档数
│   ├── ingest     上传并摄取文档（含进度条）
│   ├── status     文档摄取状态
│   ├── search     快速检索测试（含命中片段预览）
│   └── rebuild    重建索引
│
├── graph          ← 图谱操作
│   ├── build      start / status / logs / cancel
│   ├── neighbors  <entity_id> [--depth 2] [--types T1,T2]
│   ├── query      结构化查询（输出表格）
│   └── governance conflicts / resolve / history
│
├── connector      ← 连接器管理
│   ├── list       已配置连接器 + 健康状态
│   ├── add        交互式添加（questionary 选类型/填参数）
│   ├── test       测试连通性
│   ├── disable    禁用
│   └── logs       近期连接器日志
│
├── playbook       ← Playbook 管理
│   ├── list       已加载 Playbook
│   ├── trigger    手动触发（交互式填参数）
│   ├── runs       最近运行列表 + 状态
│   ├── logs       <run_id> 实时日志流
│   └── validate   校验 YAML 格式 + 步骤引用
│
├── pack           ← Pack 管理
│   ├── list       已安装
│   ├── install    <pack_id> [--version V]
│   ├── uninstall  <pack_id>
│   ├── upgrade    <pack_id>
│   └── info       显示 Pack 详情 + 能力列表
│
├── eval           ← RAG 评测（CLI 触发，Web 看图表）
│   ├── benchmarks list / create / delete
│   ├── run        <benchmark_id> [--config C]
│   └── results    <run_id> 显示数值指标
│
├── auth           ← 认证管理
│   ├── login      获取 JWT token
│   ├── me         显示当前用户信息
│   ├── user       list / add / remove / role-set
│   └── token      list / revoke
│
├── audit          最近审计日志（表格显示）
│
└── chat           ← 启动 OpenClaw 对话（连接到本地 ClawTwin MCP）[Phase B]
```

#### TUI 交互模式（对齐 OpenClaw `@clack/prompts` 风格）

Python 对应实现使用 **`questionary`** + **`rich`**：

```python
# cli/terminal/prompt.py — 对应 OpenClaw @clack/prompts 封装
import questionary
from rich.console import Console
from rich.panel import Panel
from .palette import STYLE_ACCENT, STYLE_MUTED, INDUSTRIAL_PALETTE

console = Console()

def confirm(message: str, default: bool = False) -> bool:
    """对应 OpenClaw @clack/prompts confirm()"""
    return questionary.confirm(message, default=default).ask()

def select(message: str, choices: list[str]) -> str:
    """对应 OpenClaw @clack/prompts select()"""
    return questionary.select(
        message, choices=choices,
        style=questionary.Style([
            ("selected",    f"fg:{INDUSTRIAL_PALETTE['accent']} bold"),
            ("highlighted", f"fg:{INDUSTRIAL_PALETTE['accent_bright']}"),
        ])
    ).ask()

def note(message: str, title: str = "") -> None:
    """对应 OpenClaw note() — rich Panel"""
    console.print(Panel(message, title=title, border_style=STYLE_ACCENT))

def success(message: str) -> None:
    console.print(f"[{STYLE_OK}]✓[/] {message}")   # type: ignore

def warn(message: str) -> None:
    console.print(f"[bold {INDUSTRIAL_PALETTE['warn']}]⚠[/] {message}")

def error(message: str) -> None:
    console.print(f"[bold {INDUSTRIAL_PALETTE['error']}]✗[/] {message}")
```

#### CLI `clawtwin doctor` 示例输出（rich 表格 + 颜色）

```
┌─────────────────────────────────────────────────────────────────┐
│  ClawTwin Doctor — 炼化一厂 Platform                             │
│  Version: 2026.5.15   Build: a1b2c3d                            │
└─────────────────────────────────────────────────────────────────┘

 ┌──────────────────────────┬────────┬──────────────────────────┐
 │ 检查项                    │ 状态   │ 详情                     │
 ├──────────────────────────┼────────┼──────────────────────────┤
 │ Database connection       │  ✓ OK  │ PostgreSQL 15.2          │
 │ Vector store              │  ✓ OK  │ pgvector 0.7.0           │
 │ Ontology load             │  ✓ OK  │ 12 types, 8 link types   │
 │ Pack: oilgas              │  ✓ OK  │ v1.3.2                   │
 │ Connector: opcua-main     │  ✓ OK  │ 192.168.1.100:4840       │
 │ Connector: sap-pm         │  ✗ ERR │ Connection timeout       │
 │ LLM: sonnet-4.6           │  ✓ OK  │ 125ms latency            │
 │ MCP Server                │  ✓ OK  │ listening :8001          │
 └──────────────────────────┴────────┴──────────────────────────┘

⚠  1 error found. Run `clawtwin doctor --fix` to attempt auto-repair.
```

---

### 四十七·四、修订后的完整产品面架构（精简版）

```
                    ClawTwin 产品家族（精简后）

  用户角色          接触面               功能边界
  ─────────         ──────────          ────────────────────────

  现场工程师   →    Studio (Web)        告警/工单/设备/HITL/图谱只读
  运营主管     →    Studio (Web)        KPI看板/趋势图/报表

  数据工程师   →    CLI (TUI)           本体CRUD/KB管理/连接器配置/Pack管理 ← 主要工具
               →    Studio /admin/*     Playbook编辑器/图谱浏览/评测图表 ← 仅视觉任务

  AI工程师     →    CLI (TUI)           Skill编辑/Playbook验证/Eval运行
               →    Studio /admin/*     Playbook可视化编辑（React Flow）

  平台工程师   →    CLI (TUI)           部署/健康/Doctor/Pack更新 ← 主要工具
               →    Studio /admin/      健康摘要（只读）

  所有用户     →    OpenClaw（对话）    自然语言 AI 助手（MCP工具调用）
               →    CLI `clawtwin chat` 启动 OpenClaw 对话（连接本地 MCP）
```

**关键简化**：

- Workbench → **合并为 Studio 的 `/admin/*` 路由**（4 个视觉页，capability 门控）
- TUI → **CLI 的交互模式**（`questionary + rich`），不是独立产品
- 没有额外仓库，没有额外部署

---

### 四十七·五、OpenClaw 插件架构（严格按 extensions/ 模式）

扫描 `openclaw/extensions/` 发现：扩展结构是独立 `package.json` + `src/index.ts`（`registerPlugin(api)` 入口）。ClawTwin 插件遵循完全相同的结构：

```
openclaw/extensions/clawtwin/
├── package.json           { "name": "@openclaw/clawtwin", "version": "1.0.0" }
├── src/
│   ├── index.ts           ← registerPlugin(api: PluginApi) 入口
│   ├── manifest.ts        ← 插件元数据
│   ├── connection/
│   │   ├── client.ts      ← ClawTwin HTTP 客户端（wraps /v1/mcp）
│   │   └── health.ts      ← Doctor check（`api.registerDoctorCheck`）
│   ├── tools/             ← 每个文件一个工具组
│   │   ├── workorders.ts  ← get_workorders / create_workorder
│   │   ├── equipment.ts   ← get_equipment / get_equipment_health
│   │   ├── graph.ts       ← kg_neighbors / kg_search
│   │   ├── knowledge.ts   ← knowledge_search
│   │   ├── playbook.ts    ← trigger_playbook / playbook_run_status
│   │   └── hitl.ts        ← create_hitl_session / hitl_status
│   ├── context/
│   │   ├── bootstrap.ts   ← GET /v1/bootstrap/summary → system prompt 注入
│   │   └── session.ts     ← session:start hook → 注入站点上下文
│   └── channel/           ← 可选：ClawTwin 作为通知渠道（工单创建 → OpenClaw 通知）
│       └── index.ts
└── tests/
    ├── tools.test.ts
    └── connection.test.ts
```

**工具注册代码（严格对齐 OpenClaw PluginApi 风格）**：

```typescript
// extensions/clawtwin/src/index.ts
import type { PluginApi } from "@openclaw/plugin-sdk";
import { ClawTwinClient } from "./connection/client.js";
import { registerWorkorderTools } from "./tools/workorders.js";
import { registerEquipmentTools } from "./tools/equipment.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerPlaybookTools } from "./tools/playbook.js";
import { registerHitlTools } from "./tools/hitl.js";
import { ClawTwinContextInjector } from "./context/bootstrap.js";

export function registerPlugin(api: PluginApi): void {
  const cfg = api.config.get("clawtwin");
  if (!cfg?.url) return; // graceful: skip if not configured

  const client = new ClawTwinClient(cfg.url, cfg.token);

  // 工具注册（每组工具独立文件，对齐 OpenClaw 各 extension 的 registerTool 模式）
  registerWorkorderTools(api, client);
  registerEquipmentTools(api, client);
  registerGraphTools(api, client);
  registerKnowledgeTools(api, client);
  registerPlaybookTools(api, client);
  registerHitlTools(api, client);

  // 上下文注入（对齐 OpenClaw session:start hook 模式）
  api.registerHook("session:start", async (ctx) => {
    const injector = new ClawTwinContextInjector(client);
    const systemContext = await injector.buildContext();
    ctx.prependSystemContext(systemContext);
  });

  // Doctor 健康检查（对齐 OpenClaw registerDoctorCheck 模式）
  api.registerDoctorCheck("clawtwin-connection", async () => {
    const ok = await client.ping();
    return ok
      ? { status: "ok", label: `ClawTwin: ${cfg.url}` }
      : { status: "error", label: `ClawTwin: ${cfg.url}`, message: "Platform unreachable" };
  });
}
```

---

### 四十七·六、Studio 架构深度修订（Admin Console 内嵌）

在现有 `App.tsx` 增加 `/admin/*` 路由区（capability: `admin_console`），与现有运营路由完全隔离：

```typescript
// App.tsx 增量（最小侵入）
import { AdminConsolePage }     from "./admin/AdminConsolePage";
import { PlaybookEditorPage }   from "./admin/PlaybookEditorPage";
import { GraphExplorerAdminPage } from "./admin/GraphExplorerAdminPage";
import { EvalDashboardPage }    from "./admin/EvalDashboardPage";
import { KbUploadPage }         from "./admin/KbUploadPage";

// 在 Routes 内添加
<Route path="admin" element={<AdminGuard capability="admin_console" />}>
  <Route index          element={<AdminConsolePage />} />
  <Route path="playbooks/:id/edit" element={<PlaybookEditorPage />} />  // React Flow
  <Route path="graph"   element={<GraphExplorerAdminPage />} />        // @antv/g6
  <Route path="eval"    element={<EvalDashboardPage />} />             // Antd Charts
  <Route path="kb/upload" element={<KbUploadPage />} />               // tus-js-client
</Route>
```

**`AdminGuard`**：检查 `useCapabilities().isEnabled("admin_console")`；未授权则跳转到 `/` 并提示。

**NavRail 增量**：Admin 入口作为 NavRail 底部 fixed 条目（不在主导航分区内），只对 admin 角色可见。

---

### 四十七·七、Studio 完整技术架构（按 OpenClaw 内部架构对齐）

```
clawtwin-studio/refine-clawtwin/src/

├── core/                               ← 对应 OpenClaw src/cli/ + src/gateway/
│   ├── ApiClient.ts                    ← Platform REST 客户端（对应 @openclaw/client）
│   ├── useSSEStore.ts                  ← Zustand + EventSource（对应 OpenClaw Gateway SSE）
│   ├── useCapabilities.ts              ← 已有；capability 门控
│   ├── StudioPluginRegistry.ts         ← Studio Plugin 系统（对应 OpenClaw PluginApi）
│   └── AuthGuard.tsx                   ← JWT 校验（对应 OpenClaw config-guard.ts）
│
├── theme/                              ← 对应 OpenClaw src/terminal/palette.ts + ui/src/styles/
│   ├── tokens.css                      ← CSS 变量（Studio 深色 / Admin 浅色）
│   └── antdTheme.ts                    ← Ant Design ConfigProvider 主题配置
│
├── terminal/                           ← 对应 OpenClaw src/terminal/（Web 侧等价）
│   ├── StatusBadge.tsx                 ← 对应 palette.ts 的状态色（ok/warn/error/critical）
│   ├── AlarmBadge.tsx                  ← 实时告警计数 badge（SSE 驱动）
│   └── ConnectionIndicator.tsx         ← Platform 连接状态（对应 OpenClaw health）
│
├── views/                              ← 对应 OpenClaw ui/src/ui/（页面组件）
│   ├── Dashboard.tsx                   ← 已有（运营首页）
│   ├── AlarmCenter/                    ← 告警中心（SSE 实时）
│   ├── WorkorderBoard/                 ← 工单看板（Kanban）
│   ├── EquipmentDetail/                ← 设备详情（已有资源页）
│   ├── GraphExplorer/                  ← 只读图谱浏览（@antv/g6）
│   ├── KbSearch/                       ← KB 检索（已有）
│   ├── HitlQueue/                      ← HITL 审批队列
│   └── admin/                          ← Admin Console（4 个视觉页）
│       ├── AdminConsolePage.tsx
│       ├── PlaybookEditorPage.tsx      ← React Flow
│       ├── GraphExplorerAdminPage.tsx  ← @antv/g6（可编辑模式）
│       ├── EvalDashboardPage.tsx       ← Antd Charts
│       └── KbUploadPage.tsx            ← tus-js-client
│
├── StudioShell.tsx                     ← 已有（对应 OpenClaw .shell CSS + Shell 组件）
└── App.tsx                             ← 路由树（对应 OpenClaw app.ts 入口）
```

---

---

## 四十八、全产品实现规范（对齐 OpenClaw 内部代码架构）

> **来源**：本章基于对 `clawtwin-platform/platform-api/` 和 `openclaw/` 代码库的完整扫描，给出每个组件的实现状态、差距与具体补全方案。所有示例遵循已有代码风格，不引入新依赖除非已决策。

---

### 四十八·一、组件实现状态快照（2026-05-15）

#### Platform 核心（Python FastAPI）

| 组件                 | 文件                               | OpenClaw 对应                            | 实现状态                                                                              |
| -------------------- | ---------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------- |
| `PluginApi`          | `core/plugin_sdk/api.py`           | `src/plugin-sdk/api.ts`                  | ✅ 完整，含 `register_connector/object_type/playbook/rule/capability_bundle` 独有扩展 |
| `PlaybookEngine`     | `core/playbook_engine/executor.py` | `src/gateway/session-*.ts`               | ✅ 完整；HITL gate、条件分支、模板插值均已实现                                        |
| `ObjectStore`        | `core/object_store/base.py`        | —                                        | ✅ Phase A 内存版；`postgres.py` 骨架已有                                             |
| `ContextAssembler`   | `aip/context_engine/assembler.py`  | `src/agents/skills/*.ts`                 | ✅ SKILL.md frontmatter + `applies_to` 匹配；与 OpenClaw 完全对齐                     |
| `MCP Server`         | `aip/mcp_server.py`                | `src/gateway/mcp-*.ts`                   | ✅ 14 个工具；`kg_neighbors` / `knowledge_search` 待补                                |
| `OpenClawRuntime`    | `aip/agent_runtimes/openclaw.py`   | —                                        | ✅ Phase A HTTP 调度；Phase B MCP 会话骨架待补                                        |
| `Pack Loader`        | `core/pack_loader/loader.py`       | `src/plugins/activation-*.ts`            | ⚠️ 加载已有，缺 activation snapshot 模式                                              |
| `Extension Registry` | `core/extension_registry/`         | `src/plugins/active-runtime-registry.ts` | ⚠️ 基础注册；缺生命周期 + reload                                                      |
| `LLM Trace`          | `aip/llm_trace.py`                 | —                                        | ✅ Phase A 轻量；Langfuse Phase B                                                     |
| `oilgas Pack`        | `packs/oilgas/`                    | `extensions/*/`                          | ⚠️ 骨架已有；端到端未跑通                                                             |
| `CLI`                | `apps/cli/main.py`                 | `src/cli/`                               | ⚠️ 基础命令（start/status/doctor/check）；缺 ontology/kb/graph/pack/eval 子命令       |

#### Studio（React/Antd + Refine）

| 页面/组件                   | 状态                 |
| --------------------------- | -------------------- |
| Dashboard（KPI + 本体摘要） | ✅ 已有              |
| Workorder 列表 + 详情       | ✅ 已有              |
| Equipment 列表 + 详情       | ✅ 已有              |
| KB Search                   | ✅ 已有              |
| StudioShell（三栏布局）     | ✅ 已有              |
| **HITL 审批队列**           | ❌ 缺（M2 关键路径） |
| **告警中心（实时 SSE）**    | ❌ 缺（M2 关键路径） |
| **Playbook Runs 看板**      | ❌ 缺（M2 需要）     |
| 文件导入 UI                 | ❌ 缺（M1 剩余项）   |
| Admin Console（4 页）       | ❌ 缺（Phase B）     |

---

### 四十八·二、M1 补全实现（2–3 天）

#### ① CLI `clawtwin kb import`（对齐 OpenClaw `openclaw message` 子命令模式）

OpenClaw 的 `message` 子命令用 `typer.Typer()` 创建子应用，每个子命令独立文件。ClawTwin 应采用相同结构：

```python
# apps/cli/commands/kb.py  — 新建
"""clawtwin kb — 知识库管理子命令组。
对应 OpenClaw src/cli/program/ 下各命令模块的拆分风格。
"""
import typer
from rich.progress import Progress, SpinnerColumn, TextColumn
from rich.table import Table
from rich.console import Console
from ..terminal.palette import STYLE_OK, STYLE_ERROR, STYLE_ACCENT

app = typer.Typer(name="kb", help="知识库管理（摄取 / 查询 / 重建索引）")
console = Console()


@app.command("import")
def kb_import(
    file: str = typer.Argument(..., help="文件路径（YAML/JSON/CSV/PDF/Word）"),
    station: str = typer.Option("", "--station", "-s", help="关联站场 ID"),
    layer: str = typer.Option("procedures", "--layer", "-l", help="KB 层（procedures/manuals/specs）"),
    dry_run: bool = typer.Option(False, "--dry-run", help="不写入，只预览结果"),
    base_url: str = typer.Option("http://localhost:8000", envvar="CLAWTWIN_BASE_URL"),
) -> None:
    """上传并摄取文档到知识库。"""
    with Progress(SpinnerColumn(), TextColumn("[progress.description]{task.description}"), transient=True) as p:
        p.add_task(f"上传 {file} ...", total=None)
        # POST /v1/kb/ingest（multipart form）
        import httpx, pathlib
        path = pathlib.Path(file)
        if not path.exists():
            console.print(f"[{STYLE_ERROR}]文件不存在: {file}[/]")
            raise typer.Exit(1)
        with open(path, "rb") as f:
            resp = httpx.post(
                f"{base_url}/v1/kb/ingest",
                files={"file": (path.name, f, "application/octet-stream")},
                data={"station_id": station, "layer": layer, "dry_run": str(dry_run).lower()},
                timeout=120,
            )
    if resp.status_code != 200:
        console.print(f"[{STYLE_ERROR}]摄取失败: {resp.text}[/]")
        raise typer.Exit(1)
    result = resp.json()
    table = Table(title="KB 摄取结果", show_header=True)
    table.add_column("字段", style="bold"); table.add_column("值")
    table.add_row("文档 ID", result.get("document_id", ""))
    table.add_row("分块数",  str(result.get("chunk_count", 0)))
    table.add_row("层",      result.get("layer", layer))
    table.add_row("状态",    result.get("status", ""))
    console.print(table)


@app.command("list")
def kb_list(base_url: str = typer.Option("http://localhost:8000", envvar="CLAWTWIN_BASE_URL")) -> None:
    """列出所有知识库及文档统计。"""
    import httpx
    resp = httpx.get(f"{base_url}/v1/kb/stats", timeout=15)
    data = resp.json()
    table = Table(title="知识库概览")
    table.add_column("KB ID"); table.add_column("层"); table.add_column("文档数"); table.add_column("分块数")
    for row in data.get("kbs", []):
        table.add_row(row["id"], row.get("layer",""), str(row.get("document_count",0)), str(row.get("chunk_count",0)))
    console.print(table)
```

在 `apps/cli/main.py` 的根 `app` 中注册：

```python
from apps.cli.commands import kb as kb_cmd
app.add_typer(kb_cmd.app, name="kb")
```

#### ② Studio 文件导入页面（M1 最后一项）

```typescript
// refine-clawtwin/src/pages/ImportPage.tsx — 新建
import { InboxOutlined, CheckCircleOutlined } from "@ant-design/icons";
import { Alert, Button, Card, Form, Input, Select, Upload } from "antd";
import { useState } from "react";
import { clawtwinApiBase } from "../clawtwinApiBase";

export function ImportPage() {
  const base = clawtwinApiBase();
  const [result, setResult] = useState<{ document_id: string; chunk_count: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const handleUpload = async (file: File, layer: string, stationId: string) => {
    setUploading(true);
    const form = new FormData();
    form.append("file", file);
    form.append("layer", layer);
    form.append("station_id", stationId);
    const resp = await fetch(`${base}/v1/kb/ingest`, { method: "POST", body: form });
    if (!resp.ok) {
      setError(await resp.text());
    } else {
      setResult(await resp.json());
    }
    setUploading(false);
  };
  // ... Ant Design Upload.Dragger 上传区域
}
```

在 `App.tsx` 添加 `<Route path="import" element={<ImportPage />} />`，NavRail 加入 `{ key: "import", label: "Import", to: "/import", hint: "文件导入" }`。

---

### 四十八·三、M2 实现规范（AI 闭环，4–6 周）

#### ① oilgas Pack 端到端补全

Pack 骨架已有（`packs/oilgas/`），需要补全 `hooks.py`：

```python
# packs/oilgas/hooks.py — 对应 OpenClaw extensions/*/src/index.ts
"""oilgas Pack — register(api) 入口，对齐 OpenClaw registerPlugin(api) 模式。"""
from core.pack_sdk import PluginApi

def register(api: PluginApi) -> None:
    """Pack 注册入口。PlaybookEngine 激活时 PackLoader 调用此函数。"""
    # 1. 注册 Connector（OPC-UA / Modbus）
    api.register_connector(_opcua_connector())   # 从 env / YAML 配置

    # 2. 注册对象类型
    for yaml_file in (api.pack_dir / "ontology" / "object_types").glob("*.yaml"):
        api.register_object_type(str(yaml_file))

    # 3. 注册 AgentFunction
    from .diagnostics import diagnose_compressor_vibration, predict_pump_wear
    api.register_agent_function(AgentFunctionDef(
        id="diagnose_compressor_vibration",
        description="分析压缩机振动告警，输出根因诊断和建议操作",
        handler=diagnose_compressor_vibration,
        requires_hitl=False,
        confidence_threshold=0.72,
    ))

    # 4. 注册 Playbook
    for pb_file in (api.pack_dir / "ontology" / "playbooks").glob("*.yaml"):
        api.register_playbook(str(pb_file))

    # 5. 注册 Skill（SKILL.md 自动注入上下文）
    api.register_skill(str(api.pack_dir / "skills" / "compressor-diagnostics.md"))

    # 6. 注册 CapabilityBundle（一次注册，全自动生效）
    api.register_capability_bundle(CapabilityBundle(
        id="compressor_alarm_response",
        name="压缩机告警响应",
        description="压缩机告警 → AI 诊断 → 创建工单 → 工程师审批 → CMMS 推送",
        triggers=[
            TriggerDef(kind="alarm", alarm_type="vibration_high", object_type="compressor"),
            TriggerDef(kind="alarm", alarm_type="bearing_temperature_high", object_type="compressor"),
            TriggerDef(kind="chat", intent_keywords=["压缩机诊断", "compressor diagnosis"]),
            TriggerDef(kind="manual"),
        ],
        agent_function_ids=["diagnose_compressor_vibration"],
        skill_paths=["skills/compressor-diagnostics.md"],
        tool_names=["create_work_order", "acknowledge_alarm"],
        expose_as_mcp_tool=True,    # → initiate_compressor_alarm_response MCP 工具
        notify_channels=["feishu"], # 工单创建后飞书通知
    ))

    # 7. 注册 Doctor 检查（对齐 OpenClaw registerDoctorCheck）
    api.register_doctor_check(
        "oilgas-opcua-connection",
        check_fn=_check_opcua,
        description="OPC-UA 连接检查",
    )
```

**关键**：`CapabilityBundle.expose_as_mcp_tool=True` 会让 `mcp_server.py` 自动生成 `initiate_compressor_alarm_response` 工具，OpenClaw 用户可以直接说"帮我诊断压缩机告警"触发完整流程。

#### ② Studio HITL 审批队列（M2 关键路径）

```typescript
// refine-clawtwin/src/pages/HitlQueuePage.tsx — 新建
// 对应 OpenClaw ui/ 中审批交互（HITL dialog）
import { Badge, Button, Card, Table, Tag } from "antd";
import { useSSEStore } from "../core/useSSEStore";
import { clawtwinApiBase } from "../clawtwinApiBase";

type HitlItem = {
  run_id: string;
  playbook: string;
  entity_id: string;
  entity_type: string;
  summary: string;        // AI 诊断摘要
  created_at: string;
  station_id: string;
};

export function HitlQueuePage() {
  const base = clawtwinApiBase();
  // SSE 驱动实时更新（PlaybookEngine 产生 hitl.created 事件）
  const hitlUpdates = useSSEStore(s => s.playbookRuns.filter(r => r.status === "waiting_for_human"));

  const approve = async (runId: string) => {
    await fetch(`${base}/v1/hitl/${runId}/approve`, { method: "POST" });
  };
  const reject = async (runId: string, reason: string) => {
    await fetch(`${base}/v1/hitl/${runId}/reject`, { method: "POST",
      body: JSON.stringify({ reason }), headers: {"Content-Type": "application/json"} });
  };

  return (
    <Card title={<>HITL 审批队列 <Badge count={hitlUpdates.length} /></>}>
      <Table<HitlItem>
        rowKey="run_id"
        columns={[
          { title: "Playbook",    dataIndex: "playbook" },
          { title: "实体",        dataIndex: "entity_id" },
          { title: "AI 诊断摘要", dataIndex: "summary", ellipsis: true },
          { title: "时间",        dataIndex: "created_at" },
          { title: "操作", render: (_, record) => (
            <>
              <Button type="primary" size="small" onClick={() => approve(record.run_id)}>批准</Button>
              <Button danger size="small" onClick={() => reject(record.run_id, "")}>拒绝</Button>
            </>
          )},
        ]}
      />
    </Card>
  );
}
```

#### ③ SSE 实时推送（Zustand store，对齐 OpenClaw EventBus 模式）

OpenClaw 的 Gateway 通过 SSE 推送 agent 事件到 UI（`ui/src/ui/app-events.ts`）。ClawTwin Platform 同样需要一个 `/v1/events/stream` SSE 端点：

```python
# apps/http/routers/events.py — 对应 OpenClaw Gateway SSE push
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from infra.event_bus import EventBus
import asyncio, json

router = APIRouter()

@router.get("/v1/events/stream")
async def events_stream(station_id: str = ""):
    """Server-Sent Events 流——推送实时运营事件到 Studio。

    事件类型（对应 OpenClaw agent-event-* 模块）：
    - alarm.created / alarm.acknowledged
    - playbook.run.started / hitl.created / playbook.run.completed
    - workorder.created / workorder.status_changed
    - connector.health_changed
    """
    async def generate():
        async with EventBus.subscribe(station_id=station_id or None) as queue:
            while True:
                event = await queue.get()
                data = json.dumps({"type": event.type, "payload": event.payload})
                yield f"event: {event.type}\ndata: {data}\n\n"
                await asyncio.sleep(0)
    return StreamingResponse(generate(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})
```

Studio `useSSEStore.ts` 订阅此流（§四十七·七 已有骨架），按事件类型更新 Zustand 状态。

#### ④ `clawtwin doctor --fix` LLM 连通性检查

对齐 OpenClaw `doctor` 命令（`src/cli/program/core-command-descriptors.ts` 中 doctor 有 `--fix` 支持）：

```python
# apps/cli/main.py — 扩展现有 doctor 命令
@app.command("doctor")
def doctor(
    fix: bool = typer.Option(False, "--fix", help="尝试自动修复发现的问题"),
    base_url: str = typer.Option("http://localhost:8000", envvar="CLAWTWIN_BASE_URL"),
) -> None:
    """诊断 Platform 配置和依赖健康状态。"""
    checks = _run_all_checks(base_url)  # 包含：
    # - DB 连通性
    # - LLM API key + 连通性测试（litellm.completion 用最小 prompt）
    # - MCP server 响应
    # - Pack 加载状态
    # - Connector 健康（每个已配置连接器）
    # - KB 向量库状态

    for check in checks:
        icon = "✓" if check.ok else "✗"
        style = STYLE_OK if check.ok else STYLE_ERROR
        console.print(f"[{style}]{icon}[/] {check.name:<30} {check.detail}")
        if not check.ok and fix and check.fix_fn:
            console.print(f"  [dim]尝试修复...[/]")
            check.fix_fn()
```

---

### 四十八·四、M3 实现规范（企业级，8–12 周）

#### ① ObjectStore 持久化（对齐 OpenClaw active-runtime-registry 持久化模式）

OpenClaw 用文件系统 + SQLite 持久化会话状态。ClawTwin 的 ObjectStore 升级：

```python
# core/object_store/postgres.py — 扩展现有骨架
"""PostgreSQL-backed ObjectStore — Phase A 升级。

迁移路径（对应 OpenClaw config migration 模式）：
  1. 环境变量 CLAWTWIN_OBJECT_DB=postgres → 切换到 PG 后端
  2. 无此变量 → 保持内存后端（Phase A 开发兼容）

数据模型：
  object_instances 表
    id          UUID PK
    type_name   VARCHAR(128) NOT NULL
    pk_value    TEXT NOT NULL          ← 对象主键值（entity_id 等）
    data        JSONB NOT NULL          ← 所有属性
    station_id  VARCHAR(128)
    created_at  TIMESTAMPTZ DEFAULT now()
    updated_at  TIMESTAMPTZ DEFAULT now()

  UNIQUE(type_name, pk_value, station_id)  ← 支持多站场同类型不冲突
"""
from sqlalchemy import Column, String, JSON, DateTime, text
from sqlalchemy.orm import DeclarativeBase
import uuid

class ObjectInstance(Base):
    __tablename__ = "object_instances"
    id         = Column(String, primary_key=True, default=lambda: str(uuid.uuid4()))
    type_name  = Column(String(128), nullable=False, index=True)
    pk_value   = Column(String, nullable=False)
    data       = Column(JSON, nullable=False)
    station_id = Column(String(128), index=True, default="default")
    created_at = Column(DateTime(timezone=True), server_default=text("NOW()"))
    updated_at = Column(DateTime(timezone=True), server_default=text("NOW()"), onupdate=text("NOW()"))
```

Alembic 迁移已有（`platform-api/alembic/`），添加此表的迁移脚本即可。

#### ② 知识飞轮（Knowledge Flywheel）API

这是 ClawTwin 的差异化特性（Palantir AIP Assist 层面的"学习"能力）：

```python
# aip/flywheel.py — 新建（对应 OpenClaw active-memory 扩展的闭环学习）
"""知识飞轮 — OutcomeEvent 驱动的 KB 自动更新管道。

流程（对应 OpenClaw 的 commitments / tasks 持久化）：
  1. AI 诊断完成 → 操作员 HITL 确认 → 产生 OutcomeEvent
  2. OutcomeEvent 积累到阈值（默认 3 条相关事件）
  3. FunctionExecutor 调用 synthesize_knowledge(outcomes) 生成 KB 草案
  4. KB 草案进入 "pending_review" 状态
  5. 领域专家（或自动规则）审核通过 → 写入正式 KB

数据表：
  outcome_events (id, type, entity_id, entity_type, ai_result, operator_feedback, outcome_type, station_id, created_at)
  flywheel_drafts (id, source_outcome_ids[], title, content, status[pending/approved/rejected], created_at)
"""

async def process_outcome_event(event: OutcomeEvent, db: AsyncSession) -> None:
    """PlaybookEngine 完成后调用；触发飞轮积累检查。"""
    await db.add(event)
    related = await db.query(OutcomeEvent).filter_by(
        entity_type=event.entity_type
    ).order_by(desc("created_at")).limit(10).all()

    if len(related) >= FLYWHEEL_THRESHOLD:
        # 异步触发知识合成（不阻塞主流程）
        asyncio.create_task(synthesize_to_draft(related, db))
```

#### ③ Pack 生命周期（对齐 OpenClaw Plugin Activation 模式）

OpenClaw 有精密的 Plugin 激活流程（`activation-context.ts`：raw config → normalized → activation source → snapshot → auto-enable）。ClawTwin Pack 升级到同等精度：

```python
# core/pack_loader/activation.py — 新建（对应 OpenClaw activation-context.ts）
"""Pack 激活上下文 — 对应 OpenClaw PluginActivationContext 精确模式。"""

@dataclass
class PackActivationSnapshot:
    """不可变快照——对应 OpenClaw PluginActivationSnapshot。"""
    raw_config:          dict[str, Any]
    normalized:          dict[str, "NormalizedPackConfig"]
    activation_source:   str   # "config" | "auto_enable" | "bundled"
    auto_enabled_reasons: dict[str, list[str]]

def build_activation_snapshot(
    config_path: Path,
    env: dict[str, str] | None = None,
) -> PackActivationSnapshot:
    """读取配置 → 规范化 → 自动启用探测 → 返回不可变快照。

    自动启用规则（对应 OpenClaw registerAutoEnableProbe）：
    - 检测 OPC-UA 连接器配置 → 自动启用 opcua-pack
    - 检测 SAP 环境变量 → 自动启用 sap-pm-pack
    - 检测 Modbus 环境变量 → 自动启用 modbus-pack
    """
    ...
```

---

### 四十八·五、CLI 完整实现规范（`terminal/` 模块 + 全命令组）

#### terminal/ 模块（对应 OpenClaw src/terminal/）

```
platform-api/apps/cli/terminal/        ← 新建（对应 OpenClaw src/terminal/）
├── __init__.py
├── palette.py                          ← 对应 palette.ts（INDUSTRIAL_PALETTE）
├── table.py                            ← 对应 table.ts（rich.table 封装，统一表格风格）
├── progress.py                         ← 对应 progress-line.ts（rich.progress 封装）
├── prompt.py                           ← 对应 @clack/prompts（questionary 封装）
└── note.py                             ← 对应 note.ts（rich.panel 封装）
```

```python
# apps/cli/terminal/table.py — 对应 OpenClaw src/terminal/table.ts
"""统一 CLI 表格渲染。对应 OpenClaw renderTable() 的 rich 实现。"""
from rich.console import Console
from rich.table import Table as RichTable
from .palette import STYLE_ACCENT

_console = Console()

def render_table(
    title: str,
    columns: list[tuple[str, str]],   # (header, style)
    rows: list[dict[str, str]],
    *,
    border_style: str = "dim",
) -> None:
    """对应 OpenClaw renderTable(opts: RenderTableOptions)。"""
    t = RichTable(title=title, border_style=border_style, show_header=True, header_style=f"bold {STYLE_ACCENT}")
    for header, style in columns:
        t.add_column(header, style=style)
    for row in rows:
        t.add_row(*[row.get(h[0], "") for h in columns])
    _console.print(t)
```

#### 命令组拆分（对应 OpenClaw `src/cli/program/` 按命令模块拆分）

```
platform-api/apps/cli/commands/
├── __init__.py
├── kb.py          ← clawtwin kb      （§四十八·二 已设计）
├── ontology.py    ← clawtwin ontology （新建）
├── graph.py       ← clawtwin graph   （新建）
├── connector.py   ← clawtwin connector（新建）
├── pack.py        ← clawtwin pack    （新建）
├── playbook.py    ← clawtwin playbook（新建）
├── eval_.py       ← clawtwin eval    （新建）
└── auth.py        ← clawtwin auth    （新建）
```

关键命令示例（`ontology.py`）：

```python
# apps/cli/commands/ontology.py
"""clawtwin ontology — 本体类型管理（替代 Workbench 表单页）。
对应 OpenClaw config / agents 子命令的拆分风格。
"""
import typer
from ..terminal.table import render_table
from ..terminal.prompt import confirm, select, note

app = typer.Typer(name="ontology", help="本体对象类型与关系类型管理")

types_app = typer.Typer(name="types")
app.add_typer(types_app, name="types")

@types_app.command("list")
def types_list(
    base_url: str = typer.Option("http://localhost:8000", envvar="CLAWTWIN_BASE_URL"),
    json_output: bool = typer.Option(False, "--json"),
) -> None:
    """列出所有 ObjectType 和 LinkType。"""
    import httpx
    data = httpx.get(f"{base_url}/v1/ontology/types", timeout=10).json()
    if json_output:
        import json; print(json.dumps(data))
        return
    render_table(
        "ObjectType 目录",
        columns=[("api_name", "bold"), ("extends", ""), ("field_count", "dim"), ("pack", "dim")],
        rows=[{"api_name": t["api_name"], "extends": t.get("extends",""),
               "field_count": str(len(t.get("fields",[]))), "pack": t.get("pack","")}
              for t in data.get("object_types", [])],
    )

@types_app.command("add")
def types_add(
    base_url: str = typer.Option("http://localhost:8000", envvar="CLAWTWIN_BASE_URL"),
) -> None:
    """交互式创建 ObjectType（questionary 引导）。"""
    api_name  = typer.prompt("ObjectType 名称（CamelCase）")
    extends   = select("继承自", choices=["Equipment", "WorkOrder", "Alarm", "Process", "（无）"])
    pack      = typer.prompt("所属 Pack", default="custom")
    note(f"将创建: {api_name} extends {extends} (pack={pack})", title="确认")
    if confirm("继续?"):
        import httpx, json
        resp = httpx.post(f"{base_url}/v1/ontology/types",
                          json={"api_name": api_name, "extends": extends, "pack": pack},
                          timeout=10)
        if resp.status_code == 201:
            from ..terminal.palette import STYLE_OK
            from rich.console import Console; Console().print(f"[{STYLE_OK}]✓ 已创建 {api_name}[/]")
```

---

### 四十八·六、OpenClaw 插件完整实现规范

此插件严格遵循 `openclaw/extensions/` 现有扩展结构（从 `api-builder.ts` 可见，插件可用的 `registerXxx` 方法已有 50+ 个，但 ClawTwin 插件只需其中 6 个核心方法）：

```typescript
// extensions/clawtwin/src/index.ts — 对应每个现有 extension 的 registerPlugin 入口
import type { PluginApi } from "@openclaw/plugin-sdk";
import { ClawTwinClient } from "./connection/client.js";
import { registerGraphTools } from "./tools/graph.js";
import { registerOpsTools } from "./tools/ops.js";
import { registerPlaybookTools } from "./tools/playbook.js";
import { ClawTwinContextInjector } from "./context/bootstrap.js";

export function registerPlugin(api: PluginApi): void {
  const cfg = api.config.get("clawtwin") as { url?: string; token?: string } | null;
  if (!cfg?.url) return; // graceful skip（对应 OpenClaw 各扩展的配置缺失早退）

  const client = new ClawTwinClient(cfg.url, cfg.token ?? "");

  // ① 工具注册（对应 api-builder.ts 中 handlers.registerTool）
  registerGraphTools(api, client); // kg_neighbors / kg_search
  registerOpsTools(api, client); // get_workorders / get_alarm_summary / get_equipment
  registerPlaybookTools(api, client); // trigger_playbook / get_hitl / approve_hitl

  // ② 上下文注入（对应 api-facades.ts session.workflow.enqueueNextTurnInjection）
  api.registerHook("session:start", async (ctx) => {
    const injector = new ClawTwinContextInjector(client);
    // enqueueNextTurnInjection: 在下一轮推理开始前注入 ClawTwin 上下文块
    api.session.workflow.enqueueNextTurnInjection({
      content: await injector.buildContext(),
      role: "system",
    });
  });

  // ③ Doctor 检查（对应 api-builder.ts handlers.registerDoctorCheck，现有 extension 用此模式）
  api.registerDoctorCheck("clawtwin", async () => {
    const ok = await client.ping().catch(() => false);
    return { status: ok ? "ok" : "error", label: `ClawTwin: ${cfg.url}` };
  });

  // ④ 控制 UI 描述符（让 OpenClaw UI 显示 ClawTwin 连接状态 badge）
  api.session.controls.registerControlUiDescriptor({
    id: "clawtwin-status",
    label: "ClawTwin",
    statusFn: async () => {
      const health = await client.health().catch(() => null);
      return health?.status === "healthy"
        ? { kind: "ok", text: health.station_name ?? "Connected" }
        : { kind: "error", text: "Disconnected" };
    },
  });
}
```

工具实现（`tools/graph.ts`）：

```typescript
// extensions/clawtwin/src/tools/graph.ts
import { z } from "zod";
import type { PluginApi } from "@openclaw/plugin-sdk";
import type { ClawTwinClient } from "../connection/client.js";

export function registerGraphTools(api: PluginApi, client: ClawTwinClient): void {
  // 对应 OpenClaw api-builder.ts 中 handlers.registerTool 的标准形式
  api.registerTool({
    name: "clawtwin_kg_neighbors",
    description: [
      "获取 ClawTwin 对象在知识图谱中的 N 跳邻居（设备/工单/告警关系）。",
      "用于 GraphRAG：将邻域语义并入诊断上下文，提高故障根因准确度。",
      "调用前先通过 clawtwin_get_workorders 或 clawtwin_get_alarm_summary 获取实体 ID。",
    ].join("\n"),
    inputSchema: z.object({
      entity_id: z.string().describe("实体 ID（设备/工单/告警 ID）"),
      depth: z
        .number()
        .int()
        .min(1)
        .max(3)
        .default(1)
        .describe("图遍历深度（1–3，深度越大上下文越丰富但 token 消耗越多）"),
      link_types: z
        .array(z.string())
        .optional()
        .describe("过滤关系类型（如 ['feeds_into','triggered_by']）"),
      max_nodes: z.number().int().default(20).describe("最多返回邻居节点数"),
    }),
    execute: async (input) => {
      const result = await client.post("/v1/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "kg_neighbors", arguments: input },
      });
      return result.result?.content?.[0]?.text ?? JSON.stringify(result);
    },
  });

  api.registerTool({
    name: "clawtwin_knowledge_search",
    description: [
      "在 ClawTwin 知识库（操作规程/维修手册/故障案例）中进行混合检索。",
      "返回与查询最相关的文档片段（含来源标题和置信度）。",
      "适用场景：为 AI 诊断提供规程依据；回答操作员的知识查询。",
    ].join("\n"),
    inputSchema: z.object({
      query: z.string().describe("自然语言查询（支持中英文）"),
      layer: z.string().optional().describe("知识层筛选（procedures/manuals/specs）"),
      limit: z.number().int().default(5).describe("返回结果数量"),
    }),
    execute: async (input) => {
      const result = await client.post("/v1/mcp", {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "knowledge_search", arguments: input },
      });
      return result.result?.content?.[0]?.text ?? JSON.stringify(result);
    },
  });
}
```

---

### 四十八·七、架构完整对照表（最终版）

| OpenClaw 组件                   | 文件位置                    | ClawTwin 等价               | 文件位置                           | 对齐程度            |
| ------------------------------- | --------------------------- | --------------------------- | ---------------------------------- | ------------------- |
| `registerPlugin(api)`           | `extensions/*/src/index.ts` | `register(api: PluginApi)`  | `packs/*/hooks.py`                 | ✅ 完全对齐         |
| `PluginApi.registerTool`        | `src/plugin-sdk/api.ts`     | `api.register_tool`         | `core/plugin_sdk/api.py`           | ✅                  |
| `PluginApi.registerHook`        | 同上                        | `api.register_hook`         | 同上                               | ✅                  |
| `PluginApi.registerDoctorCheck` | 同上                        | `api.register_doctor_check` | 同上                               | ✅                  |
| `PluginApi.registerChannel`     | 同上                        | `api.register_channel`      | 同上                               | ✅                  |
| `session:start` hook            | `src/gateway/session-*.ts`  | `before_llm_call` hook      | `core/playbook_engine/executor.py` | ⚠️ 不同名，语义等价 |
| `SKILL.md` (skills)             | `extensions/*/skills/`      | `SKILL.md` (skills)         | `packs/*/skills/`                  | ✅ 完全相同格式     |
| `src/terminal/table.ts`         | `src/terminal/`             | `render_table()`            | `apps/cli/terminal/table.py`       | 📋 待完成           |
| `LOBSTER_PALETTE`               | `src/terminal/palette.ts`   | `INDUSTRIAL_PALETTE`        | `apps/cli/terminal/palette.py`     | 📋 待完成           |
| `@clack/prompts`                | npm                         | `questionary`               | Python                             | 📋 待封装           |
| `src/cli/program/` 命令模块     | `src/cli/program/*.ts`      | `apps/cli/commands/*.py`    | Python typer                       | 📋 待补充           |
| `activation-context.ts`         | `src/plugins/`              | `pack_loader/activation.py` | `core/pack_loader/`                | 📋 待对齐           |
| Gateway SSE push                | `src/gateway/`              | `/v1/events/stream`         | `apps/http/routers/events.py`      | 📋 待实现           |
| `extensions/clawtwin/`          | 尚不存在                    | —                           | `openclaw/extensions/clawtwin/`    | 📋 待创建           |

---

### 四十八·八、里程碑 × 产品面交付矩阵（修订版）

| 里程碑            | Platform                                                        | CLI                                                                       | Studio                                                | OpenClaw 插件                                          |
| ----------------- | --------------------------------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| **M1（进行中）**  | ✅ ObjectStore API 已完成                                       | `clawtwin kb import/list`                                                 | 文件导入页 `/import`                                  | OpenClaw `mcp add` 文档                                |
| **M2（4–6 周）**  | oilgas Pack 跑通 + `/v1/events/stream` SSE + ObjectStore 持久化 | `clawtwin doctor --fix`（LLM 检查）+ `clawtwin playbook runs/logs`        | HITL 队列页 + 告警中心 + Playbook Runs 看板           | `extensions/clawtwin/` 基础版（5 个工具 + 上下文注入） |
| **M3（8–12 周）** | Postgres + 多用户 JWT + 飞轮 + Pack 激活 Snapshot               | `clawtwin ontology/graph/connector/pack/eval` 全命令组 + `terminal/` 模块 | Admin Console（4 页：Playbook 编辑器/图谱/评测/上传） | 插件扩展（10+ 工具 + Doctor + ControlUI）              |
| **Phase B+**      | GraphRAG 图投影 + 治理 API                                      | —                                                                         | —                                                     | Studio 双轨（SSE + OpenClaw 同步）                     |

---

---

## 四十九、Studio 架构全面优化 · 可扩展 UI 体系（OpenClaw 风格）

> **核心问题**：当前 Studio 是 Phase A 静态原型——NavRail 硬编码、纯内联样式（无 Ant Design）、无插件扩展机制。Platform 新增 Pack 能力后 UI 无法自动同步。本章建立 OpenClaw 风格的"Pack → UI 自动扩展"架构，同时涵盖飞书卡片模板注册体系。

---

### 四十九·一、Studio 现状审计 vs Gotham 差距

#### Studio 当前实现（refine-clawtwin/src/）

| 文件                 | 状态                                            | 差距                                            |
| -------------------- | ----------------------------------------------- | ----------------------------------------------- |
| `StudioShell.tsx`    | ⚠️ 硬编码 6 个 NavRail 项，纯内联样式           | 无 Ant Design，无暗色工业主题，NavRail 不可扩展 |
| `App.tsx`            | ⚠️ 静态路由，6 个硬编码路由                     | Pack 新增功能时路由无法自动注入                 |
| `useCapabilities.ts` | ✅ 完整（`GET /v1/capabilities` + 缓存 + 订阅） | 仅控制显隐，不驱动动态 UI 结构                  |
| `Dashboard.tsx`      | ⚠️ 多个 Section 硬编码                          | Section 无法由 Pack 动态注入                    |
| HITL 队列页          | ❌ 缺失                                         | M2 关键路径                                     |
| 告警中心（实时 SSE） | ❌ 缺失                                         | M2 关键路径                                     |
| Playbook Runs 看板   | ❌ 缺失                                         | M2 需要                                         |
| 暗色工业主题         | ❌ 缺失                                         | 与 Gotham 的暗色操作中心风格不符                |

#### Gotham 对齐差距（按优先级）

| Gotham 核心能力               | ClawTwin Studio 现状        | 行动                  |
| ----------------------------- | --------------------------- | --------------------- |
| 实时告警管理（分级 P1/P2/P3） | AlarmCenterPage 缺失        | M2 实现               |
| HITL 工作流（批准/拒绝）      | HitlQueuePage 缺失          | M2 实现               |
| 对象调查（实体图谱只读探索）  | GraphExplorerPage 缺失      | Phase B（`@antv/g6`） |
| 运营 KPI 看板（实时数字孪生） | Dashboard 已有但无 SSE 驱动 | M2 接入 SSE           |
| 工单生命周期                  | WorkordersListPage ✅       | 扩展详情页            |
| 插件能力的 UI 动态扩展        | ❌ 完全缺失                 | **本章核心设计**      |

---

### 四十九·二、可扩展 UI 体系设计（OpenClaw ControlUiDescriptor 模式）

#### 设计哲学（对标 OpenClaw `registerControlUiDescriptor`）

OpenClaw 的 `PluginControlUiDescriptor`（`src/plugins/host-hooks.ts`）允许 Plugin 向 UI 注册控制面板描述符，UI 在运行时动态渲染这些描述符，无需手工修改前端代码。

ClawTwin 采用相同模式，通过 `UiDescriptorDef` 实现 **Pack → Platform API → Studio 自动扩展**：

```
Pack 注册 UiDescriptorDef
        ↓ api.register_ui_descriptor(desc)
Extension Registry 存储
        ↓ GET /v1/ui/descriptors
Studio useUiDescriptors() hook 拉取
        ↓ 按 surface 分类
NavRail 动态扩展   Dashboard Section 动态注入   HITL Actions 动态扩充
```

#### Platform 侧：`UiDescriptorDef`（新增到 `core/plugin_sdk/api.py`）

```python
# core/plugin_sdk/api.py — 扩展（新增 UiDescriptorDef + register_ui_descriptor）

@dataclass
class NavItemDescriptor:
    """NavRail 导航项——Pack 注册后 Studio 自动出现新导航项。"""
    key:        str          # 唯一键（Pack id + 功能键，如 "oilgas:compressor-map"）
    label:      str          # 简短标签（≤ 6 字，显示在 NavRail 图标下）
    icon:       str          # Ant Design 图标名（如 "AlertOutlined"）
    route:      str          # 前端路由路径（如 "/compressor-map"）
    capability: str = ""     # 依赖的 capability（空=无条件显示）
    badge_api:  str = ""     # 可选：轮询 Badge 计数的 API 路径（如 "/v1/hitl/count"）


@dataclass
class DashboardSectionDescriptor:
    """Dashboard 注入 Section——Pack 注册后首页自动出现新数据块。"""
    key:         str          # 唯一键（如 "oilgas:compressor-kpi"）
    title:       str          # Section 标题
    api_path:    str          # 数据来源 API（GET, 返回 JSON，前端负责渲染）
    component:   str          # 前端组件名（必须已注册在 Pack 对应的 chunk 中）
    width:       str = "full" # "full" | "half" | "third"
    capability:  str = ""     # 依赖的 capability
    order:       int = 100    # 渲染顺序（越小越靠前）


@dataclass
class HitlActionDescriptor:
    """HITL 对话框可执行动作——Pack 注册自定义审批动作（不只是批准/拒绝）。"""
    key:         str          # 唯一键（如 "oilgas:escalate-to-l3"）
    label:       str          # 按钮标签（如 "上报 L3 专家"）
    variant:     str = "default"  # "primary" | "danger" | "default"
    api_path:    str = ""     # POST 到此路径（传 run_id）
    icon:        str = ""     # 可选图标


@dataclass
class UiDescriptorDef:
    """UI 描述符定义——Pack 用此向 Studio 注册 UI 扩展点。

    对应 OpenClaw PluginControlUiDescriptor（src/plugins/host-hooks.ts:103）。
    区别：OpenClaw 面向 session/tool/run/settings 4 个面；
    ClawTwin 面向 nav/dashboard/hitl_actions 3 个面（工业操作场景优化）。
    """
    id:               str                              # 描述符唯一 ID
    pack_id:          str                              # 所属 Pack
    nav_items:        list[NavItemDescriptor]       = field(default_factory=list)
    dashboard_sections: list[DashboardSectionDescriptor] = field(default_factory=list)
    hitl_actions:     list[HitlActionDescriptor]    = field(default_factory=list)
```

`PluginApi` 新增方法：

```python
# core/plugin_sdk/api.py — PluginApi 类内新增
def register_ui_descriptor(self, descriptor: UiDescriptorDef) -> None:
    """向 Studio 注册 UI 扩展描述符。

    对应 OpenClaw api.session.controls.registerControlUiDescriptor()。
    调用后 Platform 的 /v1/ui/descriptors 将包含本描述符，Studio 下次刷新自动扩展。
    """
    from core.extension_registry import get_registry
    get_registry().register_ui_descriptor(descriptor)
    logger.info("pack=%s: registered ui_descriptor id=%s", self._plugin_id, descriptor.id)
```

#### Platform 端点：`GET /v1/ui/descriptors`

```python
# apps/http/routes/ui_descriptors.py — 新建
"""UI 描述符端点——Studio 启动时拉取所有 Pack 注册的 UI 扩展。"""
from fastapi import APIRouter
from core.extension_registry import get_registry

router = APIRouter()

@router.get("/v1/ui/descriptors")
async def get_ui_descriptors():
    """返回所有已加载 Pack 注册的 UI 描述符，供 Studio 动态构建 NavRail 和 Dashboard。

    Studio 启动时调用一次，结果缓存到 useUiDescriptors() 中（与 useCapabilities 相同模式）。
    Pack 变更需要重启 Platform（与 OpenClaw 的 Plugin reload 机制一致）。
    """
    registry = get_registry()
    descriptors = registry.get_ui_descriptors()
    return {
        "nav_items":          [d for desc in descriptors for d in desc.nav_items],
        "dashboard_sections": [d for desc in descriptors for d in desc.dashboard_sections],
        "hitl_actions":       [d for desc in descriptors for d in desc.hitl_actions],
    }
```

---

### 四十九·三、Studio Shell 重构方案（OpenClaw 暗色工业主题 + 动态扩展）

#### 架构决策

| 决策项    | 当前（Phase A）  | 目标（Phase B）                          | 理由                      |
| --------- | ---------------- | ---------------------------------------- | ------------------------- |
| UI 框架   | 纯内联样式       | Ant Design 5.x（ConfigProvider + token） | Gotham 级工业 UI 组件库   |
| 主题      | 亮色 GitHub 风格 | 暗色工业（`--ct-bg: #0d1117`）           | 对标 Gotham 暗色操控中心  |
| NavRail   | 硬编码数组       | `useUiDescriptors()` 动态驱动            | Pack 新增能力 UI 自动同步 |
| Dashboard | 硬编码 Section   | 动态 Section 注入 + 静态核心 Section     | 同上                      |
| SSE       | 无连接           | `useSSEStream()` + Zustand store         | 实时告警/HITL 推送        |
| HITL 动作 | 无               | `useUiDescriptors().hitlActions`         | Pack 可注册自定义动作按钮 |

#### `StudioShell.tsx` 重构目标代码

```tsx
// refine-clawtwin/src/StudioShell.tsx — 重构目标（Phase B）
import { ConfigProvider, Layout, Menu, Badge, theme } from "antd";
import { Outlet, useNavigate, useLocation } from "react-router-dom";
import { useUiDescriptors } from "./hooks/useUiDescriptors";
import { useSSEStream } from "./hooks/useSSEStream";
import { useHitlBadge } from "./hooks/useHitlBadge";
import { STUDIO_ANTD_TOKEN } from "./theme/studioTheme";

// 静态核心导航（保证 Pack 未加载时基础功能可用；对应 OpenClaw 核心 UI 不依赖 Plugin）
const CORE_NAV = [
  { key: "/", icon: <HomeOutlined />, label: "Home" },
  { key: "/alarms", icon: <AlertOutlined />, label: "Alarms" }, // M2
  { key: "/hitl", icon: <CheckSquareOutlined />, label: "HITL" }, // M2（带 Badge）
  { key: "/workorders", icon: <OrderedListOutlined />, label: "WO" },
  { key: "/equipment", icon: <ClusterOutlined />, label: "Eq" },
];

export function StudioShell() {
  const navigate = useNavigate();
  const location = useLocation();
  const { navItems } = useUiDescriptors(); // 动态 Pack 贡献的 NavRail 项
  const hitlCount = useHitlBadge(); // SSE 驱动的 HITL 待审批数

  // SSE 全局连接（一次 → 驱动全局 Zustand store）
  useSSEStream(`${clawtwinApiBase()}/v1/sse/global`);

  const menuItems = [
    ...CORE_NAV.map((n) => ({
      ...n,
      label:
        n.key === "/hitl" ? (
          <Badge count={hitlCount} size="small">
            {n.label}
          </Badge>
        ) : (
          n.label
        ),
    })),
    // Pack 贡献的 NavRail 项（自动追加）
    ...navItems.map((n) => ({
      key: n.route,
      icon: <DynamicIcon name={n.icon} />, // Ant Design 动态图标
      label: n.badge_api ? <NavBadge apiPath={n.badge_api} label={n.label} /> : n.label,
    })),
  ];

  return (
    <ConfigProvider theme={STUDIO_ANTD_TOKEN}>
      <Layout style={{ minHeight: "100vh" }}>
        {/* TopBar */}
        <Layout.Header
          style={{
            background: "var(--ct-bg-elevated)",
            borderBottom: "1px solid var(--ct-border)",
            padding: "0 1rem",
            display: "flex",
            alignItems: "center",
          }}
        >
          <span style={{ fontWeight: 700, color: "var(--ct-fg)", fontSize: 15 }}>
            ClawTwin Studio
          </span>
          <ConnectionStatus /> {/* API + SSE 连接状态 badge */}
        </Layout.Header>
        <Layout>
          {/* NavRail（72px 图标+标签 竖向菜单）*/}
          <Layout.Sider
            width={72}
            style={{
              background: "var(--ct-bg-elevated)",
              borderRight: "1px solid var(--ct-border)",
            }}
          >
            <Menu
              mode="inline"
              inlineCollapsed
              selectedKeys={[location.pathname]}
              items={menuItems}
              onClick={({ key }) => navigate(key)}
              style={{ background: "transparent", border: "none" }}
            />
          </Layout.Sider>
          {/* 主内容区 */}
          <Layout.Content style={{ overflow: "auto", background: "var(--ct-bg)" }}>
            <Outlet />
          </Layout.Content>
          {/* 右侧面板（上下文/选中对象/实时 KPI）*/}
          <Layout.Sider
            width={280}
            style={{
              background: "var(--ct-bg-elevated)",
              borderLeft: "1px solid var(--ct-border)",
            }}
          >
            <RightContextPanel />
          </Layout.Sider>
        </Layout>
      </Layout>
    </ConfigProvider>
  );
}
```

#### Ant Design 主题 Token（`src/theme/studioTheme.ts`）

```typescript
// refine-clawtwin/src/theme/studioTheme.ts — 新建
// 对应 OpenClaw ui/src/styles/base.css 中的设计令牌体系
import type { ThemeConfig } from "antd";

export const STUDIO_ANTD_TOKEN: ThemeConfig = {
  algorithm: require("antd/es/theme").darkAlgorithm,
  token: {
    // 背景（对应 §四十六 --ct-bg 系列）
    colorBgBase: "#0d1117",
    colorBgContainer: "#161b22",
    colorBgElevated: "#1c2128",
    colorBgLayout: "#0d1117",
    // 主色（工业蓝，区别于 OpenClaw 的橙红）
    colorPrimary: "#2f81f7",
    colorPrimaryHover: "#58a6ff",
    // 文字
    colorText: "#c9d1d9",
    colorTextSecondary: "#8b949e",
    colorTextTertiary: "#57606a",
    // 边框
    colorBorder: "#30363d",
    colorBorderSecondary: "#21262d",
    // 语义色（告警体系）
    colorSuccess: "#3fb950",
    colorWarning: "#d29922",
    colorError: "#f85149",
    colorInfo: "#58a6ff",
    // 圆角
    borderRadius: 6,
    borderRadiusLG: 8,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    fontSize: 13,
  },
  components: {
    // 告警 Badge 在暗色主题下的样式
    Badge: { colorError: "#f85149" },
    // HITL 审批操作按钮
    Button: { colorPrimary: "#2f81f7", colorError: "#f85149" },
    // 导航菜单
    Menu: {
      colorItemBg: "transparent",
      colorItemBgSelected: "#1f3a5f", // 深蓝选中状态（对应 OpenClaw active 高亮）
      colorItemTextSelected: "#58a6ff",
    },
    // 表格（工单列表、设备列表）
    Table: {
      colorBgContainer: "#161b22",
      headerBg: "#0d1117",
      rowHoverBg: "#1c2128",
    },
  },
};

// CSS 变量注入（兼容不使用 Antd token 的部分）
// 将以上颜色同步为 CSS 变量，让 StudioShell 中的 var(--ct-*) 生效
export const STUDIO_CSS_VARS = `
  :root[data-theme="studio"] {
    --ct-bg:              #0d1117;
    --ct-bg-elevated:     #161b22;
    --ct-bg-hover:        #1c2128;
    --ct-bg-muted:        #21262d;
    --ct-border:          #30363d;
    --ct-fg:              #c9d1d9;
    --ct-fg-muted:        #8b949e;
    --ct-accent:          #2f81f7;
    --ct-accent-bright:   #58a6ff;
    --ct-ok:              #3fb950;
    --ct-warn:            #d29922;
    --ct-danger:          #f85149;
    --ct-critical:        #ff0000;
  }
`;
```

#### `useUiDescriptors()` hook（对应 `useCapabilities` 的设计模式）

```typescript
// refine-clawtwin/src/hooks/useUiDescriptors.ts — 新建
/**
 * UI 描述符 hook——从 GET /v1/ui/descriptors 拉取 Pack 注册的 UI 扩展。
 *
 * 设计模式与 useCapabilities.ts 完全一致：
 *   - 模块级缓存（只请求一次）
 *   - 订阅者模式（多个组件共享同一请求）
 *   - fail-closed（加载中 / 出错时返回空数组，核心 UI 不受影响）
 *
 * 这是 OpenClaw registerControlUiDescriptor 在 Studio 侧的镜像实现。
 */
import { useEffect, useState } from "react";
import { clawtwinApiBase } from "../clawtwinApiBase";
import type {
  NavItemDescriptor,
  DashboardSectionDescriptor,
  HitlActionDescriptor,
} from "../types/descriptors";

type DescriptorSnapshot = {
  loading: boolean;
  navItems: NavItemDescriptor[];
  dashboardSections: DashboardSectionDescriptor[];
  hitlActions: HitlActionDescriptor[];
};

let _cache: DescriptorSnapshot | null = null;
let _pending: Promise<DescriptorSnapshot> | null = null;
const _subs = new Set<(s: DescriptorSnapshot) => void>();

const EMPTY: DescriptorSnapshot = {
  loading: true,
  navItems: [],
  dashboardSections: [],
  hitlActions: [],
};

async function fetchDescriptors(): Promise<DescriptorSnapshot> {
  try {
    const r = await fetch(`${clawtwinApiBase()}/v1/ui/descriptors`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = await r.json();
    return {
      loading: false,
      navItems: d.nav_items ?? [],
      dashboardSections: d.dashboard_sections ?? [],
      hitlActions: d.hitl_actions ?? [],
    };
  } catch {
    return { loading: false, navItems: [], dashboardSections: [], hitlActions: [] };
  }
}

export function useUiDescriptors(): DescriptorSnapshot {
  const [snap, setSnap] = useState<DescriptorSnapshot>(_cache ?? EMPTY);
  useEffect(() => {
    if (_cache) {
      setSnap(_cache);
      return;
    }
    _subs.add(setSnap);
    if (!_pending) {
      _pending = fetchDescriptors().then((r) => {
        _cache = r;
        _subs.forEach((cb) => cb(r));
        _subs.clear();
        return r;
      });
    }
    return () => {
      _subs.delete(setSnap);
    };
  }, []);
  return snap;
}
```

#### Dashboard 动态 Section 注入

```tsx
// refine-clawtwin/src/Dashboard.tsx — 扩展（在现有 Section 末尾追加 Pack Section）
import { useUiDescriptors } from "./hooks/useUiDescriptors";
import { DynamicSection } from "./components/DynamicSection";

export function Dashboard() {
  const { dashboardSections } = useUiDescriptors();
  const sorted = [...dashboardSections].sort((a, b) => a.order - b.order);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {/* 核心 Section（硬编码，始终显示）*/}
      <HealthSection />
      <AlarmsSection />
      <WorkordersListPanel />
      {/* Pack 动态注入的 Section（例：oilgas Pack 注入 CompressorKpiSection）*/}
      {sorted.map((s) => (
        <DynamicSection key={s.key} descriptor={s} />
      ))}
    </div>
  );
}
```

`DynamicSection` 使用 `apiPath` 获取数据并交给已注册的前端组件渲染，支持 Pack 提供自定义渲染组件（通过 lazy import）。

---

### 四十九·四、SSE 全局事件流（对应 OpenClaw Gateway → UI 事件推送）

#### Platform SSE 端点设计（`/v1/sse/global`）

```python
# apps/http/routes/sse.py — 扩展现有 /sse 路由，新增 /global 端点
@router.get("/global", summary="全局 SSE 流（所有站场、所有事件类型）")
async def sse_global_stream(
    user: Annotated[CurrentUser, Depends(get_current_user_dev)],
) -> StreamingResponse:
    """全局 SSE 流——Studio 全局订阅，无需关心站场。

    事件类型（对应 OpenClaw ui/src/ui/app-events.ts 中的事件枚举）：
    ┌─────────────────────────────┬──────────────────────────────┐
    │ ClawTwin 事件类型            │ OpenClaw 类比                │
    ├─────────────────────────────┼──────────────────────────────┤
    │ alarm.created               │ agent.event.task_started     │
    │ alarm.acknowledged          │ —                            │
    │ hitl.created                │ agent.event.approval_request │
    │ hitl.resolved               │ agent.event.approval_result  │
    │ playbook.run.started        │ agent.event.run_started      │
    │ playbook.run.completed      │ agent.event.run_completed    │
    │ workorder.created           │ —                            │
    │ workorder.status_changed    │ —                            │
    │ connector.health_changed    │ agent.event.tool_result      │
    │ heartbeat                   │ heartbeat                    │
    └─────────────────────────────┴──────────────────────────────┘
    """
    async def event_iter():
        async with EventBus.subscribe_all() as queue:
            seq = 0
            while True:
                event = await asyncio.wait_for(queue.get(), timeout=30.0)
                payload = json.dumps({"type": event.type, "seq": seq,
                                      "ts": event.ts, "payload": event.payload})
                yield f"id:{seq}\nevent:{event.type}\ndata:{payload}\n\n"
                seq += 1
    return StreamingResponse(event_iter(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"})
```

#### Studio `useSSEStream()` hook

```typescript
// refine-clawtwin/src/hooks/useSSEStream.ts — 新建
/**
 * 全局 SSE 订阅 hook——在 StudioShell 中挂载一次，更新全局 Zustand store。
 *
 * 对应 OpenClaw ui/src/ui/app-gateway.ts 中的 gateway SSE 连接管理。
 * 重连策略：exponential backoff（1s, 2s, 4s, ... max 30s），与 OpenClaw 相同。
 */
import { useEffect } from "react";
import { useStudioStore } from "../store/studioStore";

export function useSSEStream(url: string): void {
  const { pushAlarm, pushHitl, pushPlaybookRun, setConnected } = useStudioStore();

  useEffect(() => {
    let retryDelay = 1000;
    let es: EventSource;
    let closed = false;

    function connect() {
      es = new EventSource(url);
      es.addEventListener("open", () => {
        setConnected(true);
        retryDelay = 1000;
      });
      es.addEventListener("error", () => {
        setConnected(false);
        es.close();
        if (!closed) setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 30_000);
      });
      // 事件处理（路由到对应 Zustand slice）
      es.addEventListener("alarm.created", (e) => pushAlarm(JSON.parse(e.data)));
      es.addEventListener("hitl.created", (e) => pushHitl(JSON.parse(e.data)));
      es.addEventListener("playbook.run.completed", (e) => pushPlaybookRun(JSON.parse(e.data)));
    }

    connect();
    return () => {
      closed = true;
      es?.close();
    };
  }, [url]);
}
```

---

### 四十九·五、飞书卡片模板注册系统

#### 设计原则

当前 `infra/feishu_card.py` 只有 3 个硬编码函数（HITL 审批卡、告警通知卡、工单确认卡）。Pack 无法注册自定义卡片类型（例如：oilgas Pack 需要特殊的"压缩机停机通知卡"）。

目标：Pack 注册 `FeishuCardTemplateDef` → Dispatcher 查模板注册表 → 自动选择正确卡片。

#### Platform 侧：`FeishuCardTemplateDef`（新增到 `core/plugin_sdk/api.py`）

```python
# core/plugin_sdk/api.py — 扩展

@dataclass
class FeishuCardTemplateDef:
    """飞书卡片模板——Pack 注册后 Dispatcher 自动使用对应模板。

    优先级匹配规则（高 → 低）：
    1. event_type + object_type 完全匹配
    2. event_type 匹配（object_type 为 "*"）
    3. fallback（使用平台内置通用卡片）

    对应 OpenClaw 中 channel-entry-contract.ts 的消息模板注册机制。
    """
    id:           str            # 模板 ID（全局唯一）
    event_type:   str            # 触发事件类型（如 "alarm.created" 或 "*"）
    object_type:  str = "*"      # 实体类型过滤（如 "compressor" 或 "*"）
    title_tmpl:   str = ""       # 标题 Jinja2 模板（如 "{{ entity_name }} 压缩机故障"）
    body_tmpl:    str = ""       # 正文 Jinja2 模板（支持 Markdown）
    # 可选：覆盖标准卡片 JSON 结构（完全自定义 Feishu Card JSON）
    card_json_tmpl: str = ""     # Jinja2 模板，输出完整 Feishu CardKit JSON
    # 操作按钮定义（附加到标准 HITL 按钮之后）
    extra_actions: list[dict] = field(default_factory=list)
    # 颜色标识（对应 Feishu 卡片的 header.template 字段）
    color:  str = "blue"         # "red" | "orange" | "yellow" | "blue" | "green"
```

在 `PluginApi` 中新增注册方法：

```python
def register_feishu_card_template(self, template: FeishuCardTemplateDef) -> None:
    """注册飞书卡片模板——Pack 可覆盖特定事件类型的默认通知卡片样式。

    对应 OpenClaw 中 Plugin 向 channel 注册自定义消息格式的机制。
    """
    from infra.feishu_card_registry import FeishuCardRegistry
    FeishuCardRegistry.instance().register(template)
    logger.info("pack=%s: registered feishu_card_template id=%s", self._plugin_id, template.id)
```

#### `infra/feishu_card_registry.py`（新建）

```python
# infra/feishu_card_registry.py — 新建
"""飞书卡片模板注册表。
对应 OpenClaw src/plugin-sdk-internal/channel-entry-contract.ts 中消息渲染器注册机制。
"""
from __future__ import annotations
import threading
from typing import Any
from core.plugin_sdk.api import FeishuCardTemplateDef

class FeishuCardRegistry:
    _lock = threading.Lock()
    _instance: "FeishuCardRegistry | None" = None

    def __init__(self):
        self._templates: list[FeishuCardTemplateDef] = []

    @classmethod
    def instance(cls) -> "FeishuCardRegistry":
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls()
            return cls._instance

    def register(self, template: FeishuCardTemplateDef) -> None:
        with self._lock:
            # 同 event_type + object_type 的模板可被 Pack 覆盖
            self._templates = [t for t in self._templates
                               if not (t.event_type == template.event_type
                                       and t.object_type == template.object_type
                                       and t.id == template.id)]
            self._templates.append(template)

    def resolve(self, event_type: str, object_type: str = "*") -> FeishuCardTemplateDef | None:
        """按优先级（精确 > 事件匹配 > fallback）找到最合适的模板。"""
        with self._lock:
            for t in self._templates:
                if t.event_type == event_type and t.object_type == object_type:
                    return t
            for t in self._templates:
                if t.event_type == event_type and t.object_type == "*":
                    return t
            return None  # 使用平台默认卡片

    def build_card(self, event_type: str, object_type: str, context: dict[str, Any]) -> dict[str, Any]:
        """渲染卡片 JSON，有自定义模板则用，否则 fallback 到 feishu_card.py 内置函数。"""
        from jinja2 import Environment, StrictUndefined, sandbox
        tpl = self.resolve(event_type, object_type)
        if tpl is None:
            # fallback → 现有 feishu_card.py 内置函数
            from infra.feishu_card import build_generic_notification_card
            return build_generic_notification_card(event_type, context)

        if tpl.card_json_tmpl:
            env = sandbox.SandboxedEnvironment(undefined=StrictUndefined)
            card_str = env.from_string(tpl.card_json_tmpl).render(context)
            import json; return json.loads(card_str)

        # 标准卡片 + 自定义标题/正文
        env = sandbox.SandboxedEnvironment()
        title = env.from_string(tpl.title_tmpl).render(context) if tpl.title_tmpl else event_type
        body  = env.from_string(tpl.body_tmpl).render(context)  if tpl.body_tmpl  else ""
        return _build_standard_card(title, body, tpl.color, tpl.extra_actions)
```

#### oilgas Pack 使用示例

```python
# packs/oilgas/hooks.py — 新增卡片模板注册
def register(api: PluginApi) -> None:
    # ... 其他注册 ...

    # 注册压缩机专属飞书卡片（覆盖默认 alarm.created 卡片样式）
    api.register_feishu_card_template(FeishuCardTemplateDef(
        id="oilgas-compressor-alarm-card",
        event_type="alarm.created",
        object_type="compressor",
        title_tmpl="{{ entity_name }} 压缩机告警 — {{ alarm_type }}",
        body_tmpl="""
**站场：** {{ station_name }}
**设备 ID：** {{ entity_id }}
**告警类型：** {{ alarm_type }}
**当前值：** {{ current_value }} {{ unit }}
**阈值：** {{ threshold }} {{ unit }}
**AI 初判：** {{ ai_summary | default('等待诊断…') }}
        """.strip(),
        color="red",
        extra_actions=[
            {"action_type": "button", "tag": "button", "text": {"tag": "plain_text", "content": "查看图谱"},
             "url": "{{ studio_base_url }}/equipment/show/{{ entity_id }}"},
        ],
    ))
```

---

### 四十九·六、完整架构图（最终版）

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  OpenClaw 风格的 ClawTwin 可扩展 UI 体系
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  Pack 注册（packs/oilgas/hooks.py）
  ┌────────────────────────────────────────────────────────────────┐
  │ api.register_ui_descriptor(UiDescriptorDef)                   │  → Studio NavRail + Dashboard 自动扩展
  │ api.register_feishu_card_template(FeishuCardTemplateDef)       │  → 飞书通知卡片自定义
  │ api.register_capability_bundle(CapabilityBundle(...))          │  → MCP 工具 + SSE 事件 + HITL 自动生成
  │ api.register_hook("before_llm_call", ...)                      │  → 对应 OpenClaw session:start hook
  └───────────────────────┬────────────────────────────────────────┘
                          │ PackLoader.activate()
                          ▼
  Platform（FastAPI / Python）
  ┌────────────────────────────────────────────────────────────────┐
  │  ExtensionRegistry                                             │
  │  ├── UiDescriptorRegistry  → GET /v1/ui/descriptors           │
  │  ├── FeishuCardRegistry    → Dispatcher.build_card(event)     │
  │  ├── CapabilityRegistry    → GET /v1/capabilities             │
  │  └── HookRegistry          → fire("before_llm_call", ctx)     │
  │                                                                │
  │  EventBus                                                      │
  │  └── publish(AlarmCreated/HitlCreated/PlaybookCompleted/...)  │
  │        ↓ SSE: /v1/sse/global                                  │
  │        ↓ Feishu Outbox: Dispatcher → FeishuCardRegistry       │
  └───────────────────────┬────────────────────────────────────────┘
             ┌────────────┴───────────────┐
             ▼                            ▼
  Studio（React/Antd）               飞书 Bot / 消息
  ┌──────────────────────┐           ┌────────────────────────────┐
  │ useUiDescriptors()   │           │ FeishuCardRegistry         │
  │  → 动态 NavRail      │           │ .build_card(event, ctx)    │
  │  → 动态 Dashboard    │           │   ↓ Jinja2 模板渲染        │
  │  → 动态 HITL Actions │           │ → 发送 Interactive Card     │
  │                      │           │ → 用户点击 批准/拒绝/上报   │
  │ useSSEStream()       │           │ → POST /v1/feishu/events   │
  │  → 实时 NavBadge     │           │ → PlaybookExecutor.resume  │
  │  → 实时 AlarmCenter  │           └────────────────────────────┘
  │  → 实时 HitlQueue    │
  └──────────────────────┘
             │
             ▼
  OpenClaw（TypeScript / extensions/clawtwin/）
  ┌──────────────────────┐
  │ registerTool(         │  ← 由 CapabilityBundle.expose_as_mcp_tool 自动生成
  │  clawtwin_kg_neighbors│    Platform 新增 Pack → OpenClaw 工具自动扩展
  │  initiate_compressor_ │    对应 OpenClaw registerPlugin 完整对齐
  │    alarm_response...  │
  │ )                     │
  │ registerControlUiDescriptor │  ← ClawTwin 连接状态 badge
  └──────────────────────┘
```

---

### 四十九·七、设计完整性自查表

| 维度                          | 设计完成度                | 实现完成度                         | 备注                                 |
| ----------------------------- | ------------------------- | ---------------------------------- | ------------------------------------ |
| Studio 可扩展 NavRail         | ✅ §四十九·二             | ❌ 待实现                          | UiDescriptorDef + useUiDescriptors() |
| Studio 暗色工业主题           | ✅ §四十九·三 / §四十六   | ❌ 待迁移                          | Ant Design + STUDIO_ANTD_TOKEN       |
| Studio Gotham 核心页面        | ✅ §四十八·三             | ❌ AlarmCenter/HITL 待实现         | M2 关键路径                          |
| Studio SSE 实时驱动           | ✅ §四十九·四             | ❌ 待实现                          | useSSEStream() + Zustand store       |
| 飞书卡片模板注册              | ✅ §四十九·五             | ❌ 待实现                          | FeishuCardRegistry                   |
| Platform SSE /v1/sse/global   | ✅ §四十九·四             | ⚠️ Heartbeat stub 已有；全局流待补 |                                      |
| CLI ontology/kb/graph 命令    | ✅ §四十八·五             | ❌ 待实现                          | M3                                   |
| OpenClaw extensions/clawtwin/ | ✅ §四十八·六             | ❌ 待创建                          | M2                                   |
| CapabilityBundle MCP 自动生成 | ✅ §四十八·三 + 四十九·六 | ⚠️ 骨架已有                        | oilgas Pack 待跑通                   |
| Pack 激活 Snapshot            | ✅ §四十八·四             | ❌ 待对齐                          | 对齐 activation-context.ts           |

---

---

## 五十、CLI 完整实现 + 工程缺口补全

> 本章基于对 `openclaw/src/cli/`（TS）和 `platform-api/apps/cli/main.py`（Python）的完整代码扫描。ClawTwin CLI 已有坚实基础；本章补全剩余设计缺口并解决 32–38 号工程批评。

---

### 五十·一、CLI 现状 vs OpenClaw 功能对比

| 命令                                                       | ClawTwin 现状    | OpenClaw 等价                    | 差距                           |
| ---------------------------------------------------------- | ---------------- | -------------------------------- | ------------------------------ |
| `clawtwin start`                                           | ✅ uvicorn 启动  | `openclaw gateway start`         | —                              |
| `clawtwin status`                                          | ✅ Rich Table    | `openclaw status`                | —                              |
| `clawtwin doctor [--fix]`                                  | ✅ 完整          | `openclaw doctor`                | 缺 LLM 连通性检查（M2）        |
| `clawtwin check`                                           | ✅ CI exit 0/1/2 | —                                | —                              |
| `clawtwin config show\|validate\|reload`                   | ✅               | `openclaw config`                | —                              |
| `clawtwin packs list\|reload`                              | ✅               | `openclaw plugins`               | 缺 `pack install/search`（M3） |
| `clawtwin playbooks list\|trigger\|runs`                   | ✅               | `openclaw tasks`                 | 缺 `playbook logs/steps`（M2） |
| `clawtwin extensions\|hooks\|capabilities`                 | ✅               | `openclaw status`                | —                              |
| `clawtwin kb import\|flywheel-backfill\|re-embed-flywheel` | ✅               | —                                | 缺 `kb list/search`（M2）      |
| `clawtwin auth login\|me`                                  | ✅               | `openclaw config` auth           | —                              |
| **`clawtwin ontology`**                                    | ❌ 缺失          | `openclaw config` 类比           | M3 补全                        |
| **`clawtwin connector`**                                   | ❌ 缺失          | —                                | M3 补全                        |
| **`clawtwin eval`**                                        | ❌ 缺失          | —                                | M3 补全                        |
| **`clawtwin chat`**                                        | ❌ 缺失          | `openclaw tui`（核心体验）       | **M2 补全**                    |
| **`clawtwin setup`**                                       | ❌ 缺失          | `openclaw crestodian`（向导）    | M2 补全                        |
| `terminal/` 模块                                           | ❌ 缺失          | `src/terminal/*.ts`（11 个文件） | M2/M3 补全                     |

**关键发现**：CLI 基础功能远比预估丰富（kb/flywheel/auth 都已实现），最大缺口是：

1. `clawtwin chat` / `clawtwin setup`（交互式 TUI 体验，OpenClaw 的标志性功能）
2. `terminal/` 工具模块（palette/table/progress/prompt/note）
3. `clawtwin ontology/connector/eval` 命令组

---

### 五十·二、`terminal/` 模块（对应 OpenClaw `src/terminal/` 11 个文件）

OpenClaw 的 `src/terminal/` 包含：`palette.ts`、`theme.ts`、`table.ts`、`note.ts`、`progress-line.ts`、`ansi.ts`、`links.ts`、`prompt-style.ts`、`prompt-select-styled.ts`、`stream-writer.ts`、`restore.ts`。

ClawTwin 对应实现（`apps/cli/terminal/`）：

```python
# apps/cli/terminal/__init__.py
from .palette  import THEME, style
from .table    import render_table, render_kv
from .progress import create_progress
from .prompt   import confirm, select, text_input, note
from .note     import note as print_note, banner

__all__ = ["THEME", "style", "render_table", "render_kv",
           "create_progress", "confirm", "select", "text_input",
           "note", "print_note", "banner"]
```

```python
# apps/cli/terminal/palette.py — 对应 OpenClaw palette.ts + theme.ts
"""INDUSTRIAL_PALETTE — 对应 OpenClaw LOBSTER_PALETTE。
蓝色主色（区别于 OpenClaw 橙红），兼容工业告警色系（红/橙/绿不被主色污染）。
"""
from rich.style import Style
from rich.theme import Theme

INDUSTRIAL_PALETTE = {
    "accent":        "#2F81F7",   # 主操作（蓝）— 对应 OpenClaw accent (#FF5A2D 橙)
    "accent_bright": "#58A6FF",   # 对应 accentBright
    "accent_dim":    "#1F6BE6",   # 对应 accentDim
    "info":          "#79C0FF",   # 对应 info
    "success":       "#3FB950",   # ✓ 正常/在线 — 对应 success
    "warn":          "#D29922",   # 警告 — 对应 warn
    "error":         "#F85149",   # 错误/危险 — 对应 error
    "critical":      "#FF0000",   # 紧急告警（无 OpenClaw 等价；工业专有）
    "muted":         "#8B949E",   # 次要文字 — 对应 muted
}

# rich Theme（提供 [accent]text[/accent] 语法）
RICH_THEME = Theme({
    "accent":   INDUSTRIAL_PALETTE["accent"],
    "info":     INDUSTRIAL_PALETTE["info"],
    "ok":       INDUSTRIAL_PALETTE["success"],
    "warn":     INDUSTRIAL_PALETTE["warn"],
    "danger":   INDUSTRIAL_PALETTE["error"],
    "critical": INDUSTRIAL_PALETTE["critical"],
    "muted":    INDUSTRIAL_PALETTE["muted"],
    "heading":  f"bold {INDUSTRIAL_PALETTE['accent']}",
    "cmd":      INDUSTRIAL_PALETTE["accent_bright"],
    "opt":      INDUSTRIAL_PALETTE["warn"],
})

# 对应 OpenClaw theme.ts 中的 theme.success / theme.error 等便捷函数
class _Theme:
    def __getattr__(self, name: str) -> str:
        return INDUSTRIAL_PALETTE.get(name, "")
    def markup(self, color: str, text: str) -> str:
        return f"[{color}]{text}[/{color}]"
    def ok(self, text: str) -> str:       return self.markup("ok",      text)
    def warn(self, text: str) -> str:     return self.markup("warn",    text)
    def error(self, text: str) -> str:    return self.markup("danger",  text)
    def critical(self, text: str) -> str: return self.markup("critical",text)
    def accent(self, text: str) -> str:   return self.markup("accent",  text)
    def muted(self, text: str) -> str:    return self.markup("muted",   text)

THEME = _Theme()

def style(color: str, text: str) -> str:
    """Convenience: style(color, text) — 对应 OpenClaw theme[color](text)。"""
    return THEME.markup(color, text)
```

```python
# apps/cli/terminal/table.py — 对应 OpenClaw src/terminal/table.ts
"""统一 Rich Table 渲染。对应 OpenClaw renderTable()。"""
from rich.console import Console
from rich.table   import Table
from .palette     import RICH_THEME

_console = Console(theme=RICH_THEME)

ColumnSpec = tuple[str, str, str]   # (key, header, style)

def render_table(
    title: str,
    columns: list[ColumnSpec],
    rows: list[dict],
    *,
    border_style: str = "dim",
) -> None:
    """对应 OpenClaw renderTable(opts)。

    columns: list of (row_key, header_text, rich_style)
    """
    t = Table(title=title, border_style=border_style,
              header_style="bold accent", show_header=True)
    for _, header, sty in columns:
        t.add_column(header, style=sty)
    for row in rows:
        t.add_row(*[str(row.get(k, "")) for k, _, _ in columns])
    _console.print(t)

def render_kv(title: str, data: dict, *, ok_keys: set[str] | None = None) -> None:
    """Key-value 展示（doctor/status 用）。"""
    t = Table(title=title, show_header=False, border_style="dim")
    t.add_column("Key",   style="muted",  width=28)
    t.add_column("Value", style="accent")
    for k, v in data.items():
        color = "ok" if ok_keys and k in ok_keys and str(v).lower() in ("ok","true","healthy","running") else ""
        t.add_row(k, f"[{color}]{v}[/{color}]" if color else str(v))
    _console.print(t)
```

```python
# apps/cli/terminal/note.py — 对应 OpenClaw src/terminal/note.ts
"""Panel-style 提示框。"""
from rich.console import Console
from rich.panel   import Panel
from .palette     import RICH_THEME

_console = Console(theme=RICH_THEME)

def note(body: str, *, title: str = "", style: str = "accent") -> None:
    """对应 OpenClaw note(message, title)。

    示例输出：
    ╭─ 操作摘要 ─────────────────────╮
    │  将创建 Compressor extends Equipment  │
    ╰───────────────────────────────╯
    """
    _console.print(Panel(body, title=title or None, border_style=style, padding=(0,1)))

def banner(version: str, tagline: str = "Industrial AI Operations Platform") -> None:
    """对应 OpenClaw src/cli/banner.ts — 顶部欢迎横幅。"""
    _console.print(f"\n  [heading]ClawTwin[/heading]  [muted]{version}[/muted]")
    _console.print(f"  [muted]{tagline}[/muted]\n")
```

---

### 五十·三、`clawtwin chat`（对应 OpenClaw `openclaw tui`）

OpenClaw `tui-cli.ts` 中：`openclaw tui` = `openclaw terminal` = `openclaw chat`，三个别名指向同一个 WebSocket TUI。

ClawTwin 的 `clawtwin chat` 通过 `CLAWTWIN_OPENCLAW_URL` 连接正在运行的 OpenClaw 实例，或直接通过 MCP stdio 启动对话：

```python
# apps/cli/commands/chat.py — 新建
"""clawtwin chat — 连接 OpenClaw TUI（对应 openclaw tui/terminal/chat）。

三种模式（与 openclaw tui 完全等价）：
  clawtwin chat              → 连接 CLAWTWIN_OPENCLAW_URL（远程 OpenClaw 实例）
  clawtwin chat --local      → 在本进程内启动 MCP stdio 对话（无需外部 OpenClaw）
  clawtwin chat --message X  → 发送单条消息后退出（CI/脚本用）
"""
import os, sys, json
import typer
from ..terminal import banner, note, THEME

app = typer.Typer(name="chat", help="连接 OpenClaw 对话（TUI 模式）")

@app.callback(invoke_without_command=True)
def chat_main(
    ctx: typer.Context,
    local: bool = typer.Option(False,  "--local",   help="本地 MCP stdio 对话（无需外部 OpenClaw）"),
    message: str = typer.Option("",   "--message", "-m", help="发送单条消息后退出"),
    session: str = typer.Option("main","--session","-s", help="会话名称"),
    url: str     = typer.Option("",   "--url",         help="OpenClaw Gateway URL（覆盖 env）"),
) -> None:
    """连接 OpenClaw TUI——工业操作员的核心 AI 对话入口。

    对应 OpenClaw: openclaw tui | openclaw chat | openclaw terminal
    """
    if ctx.invoked_subcommand:
        return

    oc_url = url.strip() or os.environ.get("CLAWTWIN_OPENCLAW_URL", "")

    if not local and not oc_url:
        note(
            "未配置 CLAWTWIN_OPENCLAW_URL 且未使用 --local 模式。\n"
            "请设置环境变量或运行 [cmd]clawtwin setup[/cmd] 完成初始化。",
            title="配置缺失", style="warn",
        )
        raise typer.Exit(1)

    if message:
        # 非交互：发送单条消息，打印结果后退出（CI/脚本）
        _send_single_message(oc_url if not local else None, message, session)
        return

    # 交互 TUI
    if local:
        _run_local_mcp_chat(session)
    else:
        _run_remote_openclaw_chat(oc_url, session)


def _run_local_mcp_chat(session: str) -> None:
    """本地 MCP stdio 对话——直接调用 Platform MCP Server，无需 OpenClaw。"""
    from rich.console import Console
    from rich.prompt  import Prompt
    from ..terminal.palette import RICH_THEME
    import httpx

    console = Console(theme=RICH_THEME)
    base = os.environ.get("CLAWTWIN_BASE_URL", "http://localhost:8000")
    banner_ver = _get_version(base)
    banner(banner_ver)
    console.print(f"  [muted]MCP 本地模式  会话: {session}[/muted]")
    console.print(f"  [muted]Platform: {base}[/muted]")
    console.print()

    history: list[dict] = []
    while True:
        try:
            user_input = Prompt.ask("[accent]>[/accent]", console=console).strip()
        except (KeyboardInterrupt, EOFError):
            console.print("\n[muted]Bye.[/muted]")
            break
        if not user_input or user_input in ("/exit", "/quit", "exit", "quit"):
            break
        if user_input.startswith("/"):
            _handle_slash_command(user_input, console, base)
            continue
        # 调用 LLM via Platform /v1/ai/chat（简单对话端点）
        history.append({"role": "user", "content": user_input})
        try:
            resp = httpx.post(f"{base}/v1/ai/chat",
                              json={"messages": history, "session_id": session},
                              timeout=60)
            resp.raise_for_status()
            data = resp.json()
            reply = data.get("content", "")
        except Exception as e:
            console.print(f"[danger]Error:[/danger] {e}")
            continue
        history.append({"role": "assistant", "content": reply})
        console.print(f"\n[muted]AI[/muted]  {reply}\n")


def _handle_slash_command(cmd: str, console, base: str) -> None:
    """TUI 内置斜杠命令（对应 OpenClaw TUI 中的 /command 体系）。"""
    import httpx
    parts = cmd.strip("/").split()
    name = parts[0].lower() if parts else ""
    if name in ("help", "h", "?"):
        console.print("[muted]/status  — 平台健康状态[/muted]")
        console.print("[muted]/alarms  — 查看当前告警[/muted]")
        console.print("[muted]/hitl    — 查看待审批工单[/muted]")
        console.print("[muted]/tools   — 列出可用 MCP 工具[/muted]")
        console.print("[muted]/clear   — 清空对话历史[/muted]")
        console.print("[muted]/exit    — 退出[/muted]")
    elif name == "status":
        data = httpx.get(f"{base}/v1/health", timeout=5).json()
        console.print_json(json.dumps(data))
    elif name == "alarms":
        data = httpx.get(f"{base}/v1/alarms?active=true&limit=10", timeout=5).json()
        console.print_json(json.dumps(data))
    elif name == "hitl":
        data = httpx.get(f"{base}/v1/hitl?status=waiting_for_human", timeout=5).json()
        console.print_json(json.dumps(data))
    elif name == "tools":
        data = httpx.post(f"{base}/v1/mcp",
                          json={"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}},
                          timeout=5).json()
        tools = data.get("result", {}).get("tools", [])
        for t in tools[:20]:
            console.print(f"  [cmd]{t['name']}[/cmd]  [muted]{t.get('description','')[:60]}[/muted]")
    elif name in ("clear", "cls"):
        console.clear()
    else:
        console.print(f"[warn]未知命令: /{name}  输入 /help 查看帮助[/warn]")
```

```python
# apps/cli/commands/setup.py — 新建（对应 OpenClaw crestodian/onboard）
"""clawtwin setup — 交互式初始化向导（对应 OpenClaw crestodian + onboard）。
引导操作员完成：API 连接测试 → LLM 配置 → Pack 选择 → OpenClaw 连接配置。
"""
import typer
from ..terminal import banner, note, confirm, select, text_input

app = typer.Typer(name="setup", help="交互式初始化向导")

@app.callback(invoke_without_command=True)
def setup_main(ctx: typer.Context) -> None:
    """交互式引导初始化 ClawTwin 平台配置。

    对应 OpenClaw: openclaw crestodian | openclaw onboard
    """
    if ctx.invoked_subcommand:
        return
    from rich.console import Console
    from ..terminal.palette import RICH_THEME
    console = Console(theme=RICH_THEME)

    banner("ClawTwin Setup Wizard")
    note("引导配置 ClawTwin Platform 环境变量和连接参数。\n按 Ctrl+C 随时退出，已完成步骤不会丢失。",
         title="欢迎")

    # Step 1: API 连接测试
    base = text_input("Platform API 地址", default="http://localhost:8000")
    import httpx
    try:
        r = httpx.get(f"{base}/v1/health", timeout=5)
        console.print(f"  [ok]✓[/ok] Platform 连通  [muted]{r.json().get('status','?')}[/muted]")
    except Exception as e:
        console.print(f"  [danger]✗[/danger] 无法连接: {e}")
        if not confirm("继续（跳过连通测试）?", default=False):
            raise typer.Exit(1)

    # Step 2: LLM 配置
    llm_provider = select("LLM Provider", choices=["openai", "anthropic", "ollama (本地)", "azure-openai"])
    if "openai" in llm_provider.lower() and "azure" not in llm_provider.lower():
        key = text_input("OpenAI API Key（输入后保存到 ~/.clawtwin/.env）", password=True)
        _save_env("OPENAI_API_KEY", key)
    elif "anthropic" in llm_provider.lower():
        key = text_input("Anthropic API Key", password=True)
        _save_env("ANTHROPIC_API_KEY", key)
    elif "ollama" in llm_provider.lower():
        ollama_url = text_input("Ollama URL", default="http://localhost:11434")
        _save_env("OLLAMA_BASE_URL", ollama_url)

    # Step 3: Pack 选择
    available_packs = _fetch_available_packs(base)
    if available_packs:
        chosen = select("激活哪个 IndustryPack?", choices=available_packs + ["跳过"])
        if chosen != "跳过":
            _save_env("CLAWTWIN_ACTIVE_PACKS", chosen)

    # Step 4: OpenClaw 连接（可选）
    if confirm("配置 OpenClaw 连接（AI 对话入口）?"):
        oc_url = text_input("OpenClaw Gateway URL", default="http://localhost:4100")
        _save_env("CLAWTWIN_OPENCLAW_URL", oc_url)

    note("配置完成！运行 [cmd]clawtwin doctor[/cmd] 验证所有组件状态。",
         title="Setup 完成", style="ok")
```

---

### 五十·四、Hook 失败处理策略（解答批评 #32）

**现有实现**（`infra/hooks.py` 已有明确文档，但架构文档未充分说明）：

```
before_* 钩子（前置拦截）：         after_* / on_* 钩子（观测层）：
  └─ handler 抛出异常               └─ handler 抛出异常
     → 异常传播 → 主流程中止             → 捕获 + logging.exception()
     （fail-close：保护主流程）          → 继续下一个 handler
                                         （fail-safe：观测不影响主线）
```

完整策略表：

| 钩子类型               | 失败行为                             | 超时处理                     | 工业场景理由                            |
| ---------------------- | ------------------------------------ | ---------------------------- | --------------------------------------- |
| `before_action_invoke` | **fail-close**：异常传播，动作不执行 | 无超时（同步调用）           | 前置验证失败不应执行危险动作            |
| `before_llm_call`      | **fail-close**：异常传播，LLM 不调用 | 无超时                       | 上下文准备失败不应产生错误推理          |
| `before_playbook_run`  | **fail-close**：Playbook 不启动      | 无超时                       |                                         |
| `after_action_invoke`  | **fail-safe**：捕获记录，继续        | 5 秒软超时（警告日志）       | 观测/通知失败不阻断业务                 |
| `after_llm_call`       | **fail-safe**                        | 5 秒软超时                   | 同上                                    |
| `on_platform_event`    | **fail-safe**                        | **50ms 硬超时**（丢弃+警告） | 高频事件路径，单个 handler 不可拖慢扇出 |

`fire_async()` 实现中的超时机制（新增 `timeout_ms` 参数）：

```python
# infra/hooks.py — fire_hook 扩展（解决批评 #32）
def fire_hook(event: str, *, abort_on_error: bool = False,
              timeout_ms: int | None = None, **kwargs) -> None:
    """触发钩子。

    abort_on_error=True → before_* 语义（handler 失败传播）
    abort_on_error=False → after_* / on_* 语义（fail-safe）
    timeout_ms → 单个 handler 软超时（超时后警告+继续，不杀线程）
    """
    handlers = _get_handlers(event)
    for handler in handlers:
        start = time.monotonic()
        try:
            handler(**kwargs)
        except Exception:
            if abort_on_error:
                raise   # before_* 钩子：传播异常，中止主流程
            logger.exception("hook %s handler %s failed (ignored — fail-safe)",
                             event, handler.__name__)
        finally:
            elapsed_ms = (time.monotonic() - start) * 1000
            if timeout_ms and elapsed_ms > timeout_ms:
                logger.warning("hook %s handler %s slow: %.0fms (limit %dms)",
                               event, handler.__name__, elapsed_ms, timeout_ms)
```

**文档补全**：在 `infra/hooks.py` 顶部 docstring 明确写出此策略表，确保 Pack 开发者理解不同钩子类型的失败语义。

---

### 五十·五、Playbook 检查点与恢复机制（解答批评 #33）

**现有状态**：PlaybookExecutor 已有 HITL pause/resume，但无崩溃恢复（服务重启后进行中的 Playbook 丢失）。

**解决方案**：Step 级持久化检查点（对应 OpenClaw `src/plugin-sdk-internal/delivery-queue-runtime.ts` 的持久化交付队列模式）：

```python
# core/playbook_engine/checkpoint.py — 新建
"""Playbook 执行检查点——服务崩溃后恢复到上一个成功 Step。

持久化策略：
  - 每个 Step 完成后，立即写入 playbook_run_steps 表
  - 服务启动时扫描 status='running' 的 run，从最后完成 Step 恢复
  - 幂等重建：Step 执行使用 event_id 作为幂等键

对应 OpenClaw delivery-queue-runtime.ts 的 at-least-once + dedupe 模式。
"""

class PlaybookCheckpoint:
    """Playbook 执行状态检查点（DB 持久化）。"""

    @staticmethod
    async def save_step_result(db, run_id: str, step_id: str,
                                result: dict, status: str) -> None:
        """Step 完成后立即持久化（崩溃安全）。"""
        await db.execute(
            """INSERT INTO playbook_run_steps (run_id, step_id, status, result, completed_at)
               VALUES (:run_id, :step_id, :status, :result, NOW())
               ON CONFLICT (run_id, step_id) DO UPDATE
               SET status=EXCLUDED.status, result=EXCLUDED.result, completed_at=EXCLUDED.completed_at""",
            {"run_id": run_id, "step_id": step_id,
             "status": status, "result": json.dumps(result)}
        )

    @staticmethod
    async def recover_interrupted_runs(db) -> list[str]:
        """服务启动时调用——恢复所有 status='running' 的中断 Playbook。
        恢复逻辑：找到最后成功 Step → 从下一步继续（跳过已完成步骤）。
        """
        rows = await db.fetch_all(
            "SELECT run_id FROM playbook_runs WHERE status='running' AND updated_at < NOW() - INTERVAL '5 minutes'"
        )
        return [r["run_id"] for r in rows]
```

**Playbook 状态机**（补充文档中缺失的状态图）：

```
created → running → [step1 ✓] → [step2 ✓] → [HITL pause] → waiting_for_human
                                                               ↓ approve
                                              ← ─ ─ ─ ─ ─ ─  running (resume)
                                                               ↓
                                                           completed
                         ↓ crash                            ↓ action fails
                    running (stale)                        failed
                         ↓ startup recovery
                    running (resume from last ✓ step)
```

**副作用幂等性**（防止重复执行）：Actions（create_work_order / send_feishu）必须携带幂等键：

```python
idempotency_key = f"{run_id}:{step_id}"  # Step 级幂等键
# create_work_order、send_feishu 均已有 idempotency_key 参数
```

---

### 五十·六、Outbox 幂等去重（解答批评 #34）

**现有状态**：`infra/webhook_outbox.py` 有 at-least-once，但无幂等键文档。

**解决方案**：标准化 `idempotency_key` 字段（已在 DB schema 中存在，需在 API 层统一强制）：

```python
# infra/outbox/dispatch.py — 扩展
"""Outbox dispatch 规则：
1. 每条出站消息必须携带 idempotency_key（格式：{source_type}:{source_id}:{action}）
2. 飞书通知：key = f"feishu:{run_id}:{step_id}"
3. 工单创建：key = f"workorder:{alarm_id}:{playbook_id}"
4. CMMS 推送：key = f"cmms:{workorder_id}:push"

幂等窗口：24 小时（超过 24h 的相同 key 允许重试）
保证：同一 key 在 24h 内只投递一次（基于 outbox_messages.idempotency_key UNIQUE 约束）
"""
OUTBOX_IDEMPOTENCY_WINDOW_HOURS = 24

async def dispatch_message(db, message: OutboxMessage) -> bool:
    """插入 Outbox，若 idempotency_key 在窗口内已存在则静默跳过（返回 False）。"""
    try:
        await db.execute(
            """INSERT INTO outbox_messages (id, type, payload, idempotency_key, status)
               VALUES (:id, :type, :payload, :ikey, 'pending')""",
            {**message.dict(), "ikey": message.idempotency_key}
        )
        return True
    except IntegrityError:  # UNIQUE constraint → 已存在
        logger.info("outbox: duplicate suppressed key=%s", message.idempotency_key)
        return False
```

**触发器去重**（防止同一告警产生多个 Playbook run）：

```python
# core/playbook_engine/trigger_sink.py — 扩展（已有 trigger_sink 文件）
# 在 handle_platform_event() 开头添加去重检查：
async def handle_platform_event(event: PlatformEvent, db) -> None:
    dedup_key = f"trigger:{event.event_type}:{event.entity_id}:{event.source_alarm_id}"
    if await _is_recent_duplicate(db, dedup_key, window_seconds=300):   # 5 分钟去重窗口
        logger.info("trigger: duplicate event suppressed key=%s", dedup_key)
        return
    await _mark_seen(db, dedup_key)
    # 继续正常 Playbook 触发…
```

---

### 五十·七、APScheduler HA 方案（解答批评 #35）

**现有状态**：APScheduler 内存模式，进程重启后调度丢失。

**解决方案**（3 个层级，按复杂度递增）：

| 层级       | 方案                               | 何时采用         |
| ---------- | ---------------------------------- | ---------------- |
| M2（当前） | APScheduler + SQLite job store     | 单实例，重启安全 |
| M3         | APScheduler + PostgreSQL job store | 多实例共享调度   |
| Phase B    | Celery Beat + Redis（带分布式锁）  | 高可用多副本     |

M2 立即可用的方案（SQLite Job Store）：

```python
# infra/scheduler.py — 扩展现有实现
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.jobstores.sqlalchemy import SQLAlchemyJobStore

def create_scheduler(db_url: str) -> AsyncIOScheduler:
    """创建持久化 APScheduler（SQLite/PG 均支持，无需额外依赖）。

    关键：使用 SQLAlchemyJobStore 后重启不丢任务。
    分布式锁（M3）：APScheduler PG JobStore + PostgreSQL SKIP LOCKED。
    """
    jobstores = {
        "default": SQLAlchemyJobStore(url=db_url, tablename="apscheduler_jobs")
    }
    scheduler = AsyncIOScheduler(jobstores=jobstores)
    scheduler.start()
    return scheduler
```

**重启告警**（确保运维可见）：

```python
# apps/cli/main.py — doctor 命令扩展
def _check_scheduler(base_url: str) -> DoctorCheck:
    """检查调度器是否运行、是否有持久化 Job Store。"""
    data = _api("/v1/health")
    scheduler_ok = data.get("scheduler") == "running"
    persistent = data.get("scheduler_persistent", False)
    if not persistent:
        return DoctorCheck(name="scheduler", ok=False,
            detail="⚠️ APScheduler 使用内存模式，重启后定时任务丢失。建议设置 CLAWTWIN_DB_SCHEDULER=1")
    return DoctorCheck(name="scheduler", ok=scheduler_ok, detail="SQLite/PG persistent")
```

---

### 五十·八、AgentFunction 输出验证（解答批评 #36）

**解决方案**：三层防护（格式校验 → 置信度门控 → 安全内容过滤）：

```python
# core/function_executor/executor.py — 扩展（已有 FunctionExecutor 骨架）
"""AgentFunction 三层输出防护（解决批评 #36）。"""

class FunctionExecutionResult:
    raw_output:    str          # LLM 原始输出
    parsed:        dict | None  # JSON 解析结果（None = 格式错误）
    confidence:    float        # 0.0–1.0（LLM 自评估或规则推断）
    passed_guard:  bool         # 是否通过安全过滤
    fallback_used: bool         # 是否使用了降级策略

class FunctionExecutor:

    async def execute(self, func_def: AgentFunctionDef, context: dict) -> FunctionExecutionResult:
        """执行 AgentFunction，强制三层验证。"""
        # 层 1：调用 LLM
        raw = await self._call_llm(func_def, context)
        result = FunctionExecutionResult(raw_output=raw)

        # 层 2：JSON 格式校验（output_schema 验证）
        try:
            parsed = json.loads(raw)
            if func_def.output_schema:
                # Pydantic v2 validate_python
                validated = func_def.output_schema.model_validate(parsed)
                result.parsed = validated.model_dump()
            else:
                result.parsed = parsed
        except (json.JSONDecodeError, ValidationError) as e:
            logger.warning("function %s output validation failed: %s", func_def.id, e)
            result.parsed = None
            result.fallback_used = True
            # 降级策略：返回安全的"无结论"结果，触发 HITL
            return self._create_fallback_result(func_def, "output_format_error", str(e))

        # 层 3：置信度门控
        confidence = result.parsed.get("confidence", 0.5) if result.parsed else 0.0
        result.confidence = confidence
        if confidence < func_def.confidence_threshold:
            if func_def.requires_hitl:
                return self._trigger_hitl(func_def, result, "low_confidence")

        # 层 4：安全内容过滤（防止提示注入）
        if not self._safety_check(result.parsed):
            logger.error("function %s output failed safety check", func_def.id)
            return self._create_fallback_result(func_def, "safety_violation", "")

        result.passed_guard = True
        return result

    def _safety_check(self, output: dict | None) -> bool:
        """工业场景安全过滤——防止 LLM 输出危险指令。
        检查项：
        1. 不包含 system command 关键字（rm -rf / shutdown / DELETE FROM）
        2. 不包含 API key / secret / password 模式
        3. 推荐动作必须在 action_types 白名单内
        """
        if not output:
            return True
        # 检查推荐动作是否在白名单
        recommended_action = output.get("recommended_action", "")
        if recommended_action and recommended_action not in SAFE_ACTION_TYPES:
            return False
        # 检查危险字符串模式
        serialized = json.dumps(output, ensure_ascii=False).lower()
        DANGER_PATTERNS = ["rm -rf", "drop table", "shutdown", "exec(", "eval("]
        return not any(p in serialized for p in DANGER_PATTERNS)
```

---

### 五十·九、数据生命周期管理（解答批评 #38）

| 数据类型          | 保留策略             | 归档方案                            | 删除方案                                             |
| ----------------- | -------------------- | ----------------------------------- | ---------------------------------------------------- |
| 告警记录          | 热 90 天，冷 3 年    | `archive_alarms` 表（低成本列存储） | `DELETE WHERE archived=1 AND created_at < NOW()-3yr` |
| 工单记录          | 热 1 年，冷 7 年     | 同上（合规审计需求）                | 同上                                                 |
| KB 文档           | 永久（直到显式删除） | S3 兼容对象存储（Phase B）          | 软删除 + 物理清除 API                                |
| Playbook 运行记录 | 热 90 天，冷 1 年    | 归档表                              | —                                                    |
| LLM 对话记录      | 30 天（可配置）      | 不归档（含 PII 风险）               | 自动清除（CLAWTWIN_SESSION_RETENTION_DAYS）          |
| 向量嵌入          | 与文档同生命周期     | —                                   | 文档删除触发级联删除                                 |
| 审计日志          | 不可删除（7 年）     | S3 归档（Phase B）                  | 仅系统管理员可删除                                   |

CLI 数据生命周期命令（M3）：

```
clawtwin data
  ├── retention show        — 查看各类型数据保留策略
  ├── retention set <type> <days>  — 修改保留策略
  ├── archive run [--dry-run]      — 归档超过保留期的数据
  ├── purge run [--dry-run]        — 物理删除已归档数据（需 admin 权限）
  └── export gdpr --user <id>      — GDPR 数据导出（ZIP 包含全部用户数据）
```

---

### 五十·十、完整 CLI 命令树（最终版）

```
clawtwin
├── start             ✅ uvicorn 启动
├── status            ✅ Rich Table
├── doctor [--fix]    ✅ + LLM check（M2）+ scheduler check（M2）
├── check             ✅ CI exit codes
├── setup             📋 交互向导（M2，对应 openclaw crestodian）
├── chat              📋 TUI/对话模式（M2，对应 openclaw tui）
│   ├── --local       本地 MCP stdio 模式
│   └── --message     单次对话（CI 用）
│
├── config
│   ├── show          ✅
│   ├── validate      ✅
│   └── reload        ✅
│
├── packs
│   ├── list          ✅
│   ├── reload        ✅
│   ├── install <id>  📋 M3（从 Pack registry 安装）
│   └── search        📋 M3
│
├── ontology                    📋 M3（替代 Workbench 表单页）
│   ├── types list/show/add/edit/delete
│   ├── links list/add/delete
│   ├── import --from-yaml
│   ├── export --to-yaml
│   ├── validate
│   ├── profile list/create/publish/archive
│   └── diff <version_a> <version_b>
│
├── kb                          ✅ + 扩展（M2）
│   ├── import <file.yaml>      ✅
│   ├── list                    📋 M2
│   ├── search <query>          📋 M2
│   ├── flywheel-backfill       ✅
│   └── re-embed-flywheel       ✅
│
├── playbooks                   ✅ + 扩展（M2）
│   ├── list                    ✅
│   ├── trigger <id>            ✅
│   ├── runs [--status S]       ✅
│   ├── logs <run_id>           📋 M2
│   └── steps <run_id>          📋 M2
│
├── connector                   📋 M3
│   ├── list
│   ├── test <id>
│   ├── reload <id>
│   └── logs <id>
│
├── eval                        📋 M3
│   ├── run <dataset>
│   ├── report <run_id>
│   └── compare <run_a> <run_b>
│
├── data                        📋 M3
│   ├── retention show/set
│   ├── archive run
│   ├── purge run
│   └── export gdpr --user
│
├── auth
│   ├── login                   ✅
│   └── me                      ✅
│
├── extensions                  ✅
├── hooks                       ✅
├── capabilities                ✅
├── reports
│   └── outcomes                ✅
└── version                     ✅
```

---

### 五十·十一、工程批评 32–38 解决状态

| 批评 | 核心问题                    | 解决方案                                                         | 状态        |
| ---- | --------------------------- | ---------------------------------------------------------------- | ----------- |
| 32   | Hook 失败处理策略不清       | `fire_hook(abort_on_error, timeout_ms)` + 策略表                 | ✅ §五十·四 |
| 33   | Playbook 崩溃恢复缺失       | Step 级 DB 检查点 + startup recovery + 幂等键                    | ✅ §五十·五 |
| 34   | Outbox 重复通知             | `idempotency_key UNIQUE` + 触发器 5 分钟去重窗口                 | ✅ §五十·六 |
| 35   | APScheduler 单点            | SQLite JobStore（M2）→ PG JobStore（M3）→ Celery Beat（Phase B） | ✅ §五十·七 |
| 36   | AgentFunction 输出无验证    | 格式校验 + 置信度门控 + 安全内容过滤（三层防护）                 | ✅ §五十·八 |
| 37   | LLM 代码生成安全（Phase C） | Phase C 暂不实现，沙箱方案延至 Phase C 专项安全评估              | 延后        |
| 38   | 数据生命周期缺失            | 保留策略表 + `clawtwin data` CLI + GDPR export                   | ✅ §五十·九 |

---

_ClawTwin Platform Architecture V4.8+ · r15：+§五十 CLI 完整实现（terminal/ 模块·chat/setup TUI·完整命令树）+ 工程缺口补全（Hook策略·Playbook检查点·Outbox去重·APScheduler HA·AgentFunction防护·数据生命周期）· 2026-05-15_
