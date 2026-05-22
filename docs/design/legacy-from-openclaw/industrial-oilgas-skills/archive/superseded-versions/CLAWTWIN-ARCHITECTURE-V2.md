# ClawTwin Platform · 架构设计 V2

**单一权威来源 · 取代此前所有架构文档**

> 版本：2026-05-14 · 状态：设计定稿 · 指导 Phase B 开发

---

## 一、系统定位（一句话）

**ClawTwin Platform = Palantir Foundry（数据语义层）+ Palantir AIP（AI 运营层）的开源工业实现，以 IndustryPack 扩展机制替代 Palantir 的 Workshop，通过 MCP 协议与 OpenClaw 配合构成完整的人机-企业协作体系。**

| Palantir 产品        | ClawTwin 对应模块                         | 实现状态         |
| -------------------- | ----------------------------------------- | ---------------- |
| Foundry Ontology     | `ontology/` YAML + PackRegistry           | ✅ 骨架完成      |
| Foundry Pipeline     | `connectors/` + `workers/pipeline_worker` | ⚡ 骨架          |
| Foundry Object Store | `core/object_store` + PostgreSQL          | ✅ 完成          |
| AIP Function         | `core/function_executor` + LiteLLM        | ❌ Provider 为空 |
| AIP Logic / Workflow | `core/playbook_engine` + LangGraph        | ⚡ 基础完成      |
| AIP Copilot (对话)   | **OpenClaw**（不在 Platform 内）          | ✅ 通过 MCP 连接 |
| Workshop (行业应用)  | `packs/` IndustryPack                     | ⚡ 仅 oilgas     |
| Apollo (部署管理)    | `apps/cli` doctor/health                  | ✅ 基础完成      |

**关键定位边界**：

- Platform **不做**自然语言对话，不做会话管理。那是 OpenClaw 的职责。
- Platform **做**企业实体状态管理、事件检测、AI 推理、工单流转、可靠投递。
- 两者通过 **MCP Protocol** 连接：Platform 暴露 MCP 工具 → OpenClaw 通过 MCP 调用。

---

## 二、最小核心（Minimum Viable Core）

**Core 的设计原则：极小、稳定、不含任何行业逻辑。**

```
最小核心 = 5 个模块，全部已存在（需填充）：

  1. EntityStore      (core/object_store)           ← 实体状态的单一事实源
  2. EventBus         (infra/event_dispatcher)       ← 唯一的状态变更通知通道
  3. PackRegistry     (core/extension_registry)      ← 扩展注册表（设计完成，实现中）
  4. HookSystem       (infra/hooks/ ← 待建)          ← 生命周期切面
  5. PlaybookEngine   (core/playbook_engine)         ← 编排调度（确定性）
```

**最小核心不包含**：LLM 调用、向量检索、OPC-UA 连接器、通知通道、AI 函数——
这些全部通过 PackRegistry 注册，以扩展方式接入。

### 2.1 核心模块职责边界

```python
# EntityStore：所有业务实体的读写入口
# 规则：所有写操作必须触发 EventBus 事件
class EntityStore:
    async def get(entity_type, entity_id) -> Entity
    async def write(entity_type, entity_id, data) -> Entity
    async def query(entity_type, filters) -> List[Entity]
    # write() 内部自动 EventBus.publish(f"{entity_type}.updated", entity)

# EventBus：语义层→行动层的唯一出口
# 规则：任何行动层代码不得绕过 EventBus 直接监听 EntityStore
class EventBus:
    def subscribe(event_pattern: str, handler: Callable) -> None
    async def publish(event_type: str, payload: dict) -> None
    # 支持 wildcard：subscribe("alarm.*") 匹配所有告警事件

# PackRegistry：扩展注册的统一入口
# 规则：所有 register_*() 必须在进程启动时同步完成（不允许运行时动态注册）
class PackRegistry:
    def register_entity_type(manifest: EntityTypeManifest) -> None
    def register_connector(connector: BaseConnector) -> None
    def register_llm_provider(provider: BaseLLMProvider) -> None
    def register_tool(tool: AgentTool) -> None
    def register_playbook(playbook: PlaybookDefinition) -> None
    def register_pipeline(pipeline: PipelineDefinition) -> None
    def register_skill(skill: SkillDefinition) -> None
    def register_hook(point: HookPoint, handler: Callable) -> None
    def register_notification_channel(ch: BaseNotificationChannel) -> None
    def register_memory_provider(p: BaseMemoryProvider) -> None
    def register_cli_command(cmd: CLICommand) -> None
    def register_migration(m: PackMigration) -> None

# HookSystem：生命周期切面（10 个命名切点）
class HookSystem:
    # 调用顺序：顺序执行，可返回 block=True 中断流程
    HOOK_POINTS = [
        "before_context_assemble",  "after_context_assemble",
        "before_ai_call",           "after_ai_call",
        "before_tool_call",         "after_tool_call",       # 可阻断
        "before_action_execute",    "after_action_execute",  # 可阻断
        "workorder_closed",          # 并发触发，用于学习管道
        "hitl_approved",            "hitl_rejected",
    ]
    async def fire(point: str, context: dict) -> HookResult

# PlaybookEngine：确定性流程编排（Phase B 迁移到 LangGraph）
class PlaybookEngine:
    async def trigger(playbook_id, entity_id, context) -> PlaybookRun
    async def resume(run_id, approval_result) -> PlaybookRun  # HITL 恢复
    async def get_run(run_id) -> PlaybookRun
```

---

## 三、库选型决策（不从零构建的清单）

**原则：凡有成熟 Python 库的能力，优先使用库，不造轮子。**

### 3.1 LLM 调用层 → LiteLLM（P0，立刻）

```python
# 不要写 BaseLLMProvider ABC 的实现！
# LiteLLM 就是 Provider 抽象层
import litellm

# 支持 OpenAI / DeepSeek / Qwen / Claude / Ollama 等，统一接口
response = await litellm.acompletion(
    model="deepseek/deepseek-chat",      # 或 "openai/gpt-4o" 或 "anthropic/claude-3-5-sonnet"
    messages=messages,
    tools=tools,                          # function calling，跨厂商统一格式
    stream=True,
)

# providers/llm.py 的实现（从 1 行注释变成真实代码）：
class LiteLLMProvider(BaseLLMProvider):
    def __init__(self, model: str, **kwargs):
        self.model = model

    async def complete(self, messages, tools=None) -> CompletionResult:
        response = await litellm.acompletion(
            model=self.model, messages=messages, tools=tools or []
        )
        return CompletionResult.from_litellm(response)
```

**LiteLLM 提供**：自动重试、fallback 到备用模型、token 计数、成本追踪、统一 tool calling 格式。
**我们不需要写的代码**：provider 工厂、model 路由、重试逻辑、token 统计——全部 LiteLLM。

### 3.2 知识检索层 → LlamaIndex（P1，Phase B）

```python
from llama_index.core import VectorStoreIndex, StorageContext
from llama_index.vector_stores.postgres import PGVectorStore  # 复用现有 pgvector！

# KB（文档知识库）
kb_store = PGVectorStore.from_params(
    database="clawtwin", table_name="kb_vectors",
    embed_dim=1536
)
kb_index = VectorStoreIndex.from_vector_store(kb_store)
kb_engine = kb_index.as_query_engine(
    filters=MetadataFilters(filters=[  # 按设备类型过滤
        MetadataFilter(key="entity_type", value="CompressorUnit")
    ])
)

# CBR（案例库，工单关闭后自动入库）
cbr_store = PGVectorStore.from_params(..., table_name="cbr_vectors")
cbr_index = VectorStoreIndex.from_vector_store(cbr_store)

# ContextAssembler 里的使用：
kb_results = await kb_engine.aquery(f"{entity.type} {symptoms}")
cbr_results = await cbr_engine.aquery(symptoms, similarity_top_k=3)
```

**LlamaIndex 提供**：文档分块、向量化、pgvector 集成、混合检索、元数据过滤。
**我们不需要写的代码**：向量化逻辑、相似度搜索、文档分块——全部 LlamaIndex。

### 3.3 Agent 工具循环 → 简单 async 循环（P0）+ LangGraph HITL（P1）

```python
# Phase A（P0）：30 行 async 循环，不需要 LangGraph
# core/agent_runtime/loop.py

async def run_tool_loop(session: AgentSession) -> AgentResult:
    """工业场景的 AI 推理循环：有界、可审计、支持 HITL 中断。"""
    hooks = get_hook_system()

    while session.iterations < session.max_iterations:
        # 1. 组装上下文
        ctx_pkg = await ContextAssembler.assemble(session.entity_id, session.symptoms)
        await hooks.fire("before_ai_call", {"session": session, "context": ctx_pkg})

        # 2. 调用 LLM（LiteLLM，不区分厂商）
        response = await litellm.acompletion(
            model=session.model,
            messages=session.build_messages(ctx_pkg),
            tools=session.available_tools,
        )
        await hooks.fire("after_ai_call", {"response": response})

        # 3. 工具调用循环
        if response.choices[0].message.tool_calls:
            for tc in response.choices[0].message.tool_calls:
                hook_result = await hooks.fire("before_tool_call", {"tool_call": tc})
                if hook_result.blocked:
                    break

                # HITL 门控：高风险工具等待人工确认
                tool_def = ToolRegistry.get(tc.function.name)
                if tool_def.requires_hitl:
                    session.status = "waiting_hitl"
                    await PlaybookEngine.pause(session.run_id, tc)
                    return AgentResult(status="hitl_required", pending_tool=tc)

                result = await ToolRegistry.execute(tc)
                await hooks.fire("after_tool_call", {"result": result})
                session.append_tool_result(tc, result)
            session.iterations += 1
        else:
            # 无工具调用 = 结论已得出
            return AgentResult(
                status="complete",
                conclusion=response.choices[0].message.content,
                confidence=session.extract_confidence()
            )

    return AgentResult(status="max_iterations_reached", partial=session.last_response)


# Phase B（P1）：迁移到 LangGraph，获得：
# - interrupt() 原生支持 HITL
# - PostgresSaver 持久化（断电恢复）
# - 并行工具执行
# - 复杂条件分支
```

### 3.4 工单状态机 → transitions AsyncMachine

```python
from transitions.extensions.asyncio import AsyncMachine

# core/domain_logic/workorder_fsm.py
class WorkOrderFSM:
    states = ["draft", "pending_approval", "active", "waiting_hitl",
              "escalated", "completed", "rejected", "cancelled"]

    transitions = [
        {"trigger": "submit",    "source": "draft",            "dest": "pending_approval"},
        {"trigger": "approve",   "source": "pending_approval", "dest": "active"},
        {"trigger": "reject",    "source": "pending_approval", "dest": "rejected"},
        {"trigger": "pause",     "source": "active",           "dest": "waiting_hitl"},
        {"trigger": "resume",    "source": "waiting_hitl",     "dest": "active"},
        {"trigger": "complete",  "source": "active",           "dest": "completed"},
        {"trigger": "escalate",  "source": ["active", "waiting_hitl"], "dest": "escalated"},
    ]

    def __init__(self, workorder):
        self.workorder = workorder
        AsyncMachine(model=self, states=self.states,
                     transitions=self.transitions, initial="draft")

    async def on_enter_completed(self):
        # 工单关闭 → 触发 CBR 学习管道
        await HookSystem.fire("workorder_closed", {"workorder": self.workorder})
```

### 3.5 调度器 → APScheduler

```python
from apscheduler.schedulers.asyncio import AsyncIOScheduler

# workers/scheduler.py（更新现有文件）
scheduler = AsyncIOScheduler()

# Pack 注册新的定时任务（PackRegistry.register_scheduler_job）
def register_scheduler_job(func, trigger, **kwargs):
    scheduler.add_job(func, trigger, **kwargs)

# 示例：oilgas pack 注册每5秒采集
# register_scheduler_job(opcua_collector.collect, "interval", seconds=5, id="opcua_collect")
```

### 3.6 库选型汇总

| 能力           | 选用库                   | 版本   | 为什么                                  | 阶段  |
| -------------- | ------------------------ | ------ | --------------------------------------- | ----- |
| LLM 统一调用   | **litellm**              | >=1.50 | 20+ 厂商，统一 tool calling，内置 retry | P0    |
| RAG/知识检索   | **llama-index**          | >=0.10 | pgvector 原生集成，元数据过滤           | P1    |
| OPC-UA 采集    | **asyncua**              | >=1.0  | 异步，生产可用                          | P1    |
| Modbus 采集    | **pymodbus**             | >=3.6  | 已在 deps                               | P1    |
| 工单状态机     | **transitions[asyncio]** | >=0.9  | AsyncMachine，少量代码                  | P0    |
| 定时调度       | **APScheduler**          | >=3.10 | 动态任务，Pack 可注册                   | P0    |
| LangGraph HITL | **langgraph**            | >=0.2  | interrupt() + PostgresSaver             | P1    |
| 向量存储       | **pgvector**（已有）     | -      | 复用现有 PostgreSQL                     | P0/P1 |
| 嵌入模型       | **litellm embedding**    | -      | 统一接口，可切 BGE/OpenAI               | P1    |
| HTTP 框架      | FastAPI（已有）          | -      | 保持                                    | -     |
| ORM            | SQLAlchemy（已有）       | -      | 保持                                    | -     |
| 数据验证       | Pydantic v2（已有）      | -      | 保持                                    | -     |
| CLI            | Typer（已有）            | -      | 补充 --json flag                        | P0    |

---

## 四、ContextAssembler：需要自建，但代码极少

**结论：需要自建，因为工业上下文有特殊结构；但大部分工作由 LlamaIndex 完成，自定义代码 ~100 行。**

```python
# core/context_engine/assembler.py（新增模块，~100 行）

from dataclasses import dataclass
from typing import Optional
import asyncio

@dataclass
class ContextPackage:
    entity_state: dict           # EntityStore 当前状态
    recent_readings: list        # TimescaleDB 时序数据（最近 24h）
    alarm_history: list          # 最近 20 条告警
    similar_cases: list          # CBR 相似案例（LlamaIndex）
    relevant_docs: list          # KB 相关文档（LlamaIndex）
    related_entities: list       # 关联设备（Ontology 图关系）
    anomaly_score: float         # 异常评分（0-1，BaselineModel 计算）

    def to_system_prompt_section(self) -> str:
        """转换为 LLM system prompt 的一个段落。"""
        # 格式化为 markdown，注入到 LLM 上下文
        ...

async def assemble(entity_id: str, symptoms: str = "") -> ContextPackage:
    """并发查询所有上下文来源，组装 ContextPackage。"""

    # 并发执行所有查询（不串行等待）
    (entity_state, readings, alarms, cases, docs, related, score) = await asyncio.gather(
        EntityStore.get("Equipment", entity_id),
        TimeSeriesProvider.query(entity_id, window_hours=24),
        EntityStore.query("Alarm", filters={"equipment_id": entity_id}, limit=20),
        CBRMemory.search(symptoms, entity_type=entity_state.type if entity_state else None),
        KBLibrary.search(f"{entity_state.type} {symptoms}"),
        OntologyRegistry.get_neighbors(entity_id),
        BaselineModel.score(entity_id),
        return_exceptions=True  # 某个来源失败不影响整体
    )

    return ContextPackage(
        entity_state=entity_state or {},
        recent_readings=readings or [],
        alarm_history=alarms or [],
        similar_cases=cases or [],
        relevant_docs=docs or [],
        related_entities=related or [],
        anomaly_score=score or 0.0,
    )
```

**Hook 点**：`before_context_assemble`（Pack 可注入额外来源）和 `after_context_assemble`（Pack 可过滤/增强结果）。

---

## 五、AgentRuntime 与 OpenClaw 的集成模型

**Q：AgentRuntime 是否可以调用 OpenClaw？**

**A：两种模式，互补不互斥：**

### 模式一：OpenClaw 调用 Platform（主流程）

```
用户 → 飞书 → OpenClaw → MCP Client → Platform MCP Server → AgentRuntime → 结果
                                          ↓
                                    工具调用在 Platform 内部执行
                                    （EntityStore / TimeSeries / PlaybookEngine）
```

这是**标准模式**。Platform 的 AgentRuntime 负责工具循环（operational AI），OpenClaw 负责自然语言对话（conversational AI）。Platform 不需要理解自然语言，只需要执行结构化任务。

### 模式二：Platform 触发 OpenClaw（主动通知）

```
Platform → 发现设备异常 → 需要与值班工程师对话 → 触发 OpenClaw Session
                                                      ↓
                                              工程师通过飞书与 AI 对话
                                              AI 通过 MCP 查询 Platform
```

这用于 Platform 主动发起的"需要人工参与决策"场景。实现方式：

- Platform 向 OpenClaw Gateway 发 HTTP/WebSocket 请求，触发一个新 Session
- 或通过飞书 API 直接发消息，用户回复触发 OpenClaw Session

### 模式三：Platform 内嵌简单 AgentRuntime（自治场景）

```
设备告警 → EventBus → Platform 内部 AgentRuntime（LiteLLM 工具循环）
               → 自动诊断 → 自动创建工单 → 通知渠道发送摘要
```

这用于**不需要对话**的全自动场景（低风险告警的自动处置）。Platform 用自己的简单 async 工具循环（LiteLLM），不需要 OpenClaw。

**三种模式的选择规则**：

- 低风险 + 有明确 Playbook → 模式三（Platform 自治）
- 需要与用户自然语言交互 → 模式一（OpenClaw 驱动）
- Platform 主动需要人工介入 → 模式二（Platform 触发 OpenClaw）

---

## 六、IndustryPack 扩展架构

### clawtwin.pack.json 规范

```json
{
  "$schema": "https://clawtwin.ai/schema/pack.v1.json",
  "id": "oilgas",
  "version": "1.2.0",
  "display_name": "油气行业包",
  "requires_platform": ">=0.5.0",
  "python_module": "packs.oilgas",
  "entry_point": "packs.oilgas:register",

  "entity_types": ["CompressorUnit", "PumpTrain", "PipelineSegment"],
  "connectors": ["opcua-compressor", "vibration-sensors"],
  "playbooks": ["compressor-alarm-response", "shutdown-procedure"],
  "skills": ["diagnose-compressor", "predict-bearing-failure"],
  "tools": ["read_vibration_spectrum", "check_lube_oil_pressure"],
  "notification_channels": ["feishu-oilgas-group"],
  "migrations": ["001_add_compressor_table.sql", "002_add_vibration_index.sql"]
}
```

### Pack 入口函数（Python）

```python
# packs/oilgas/__init__.py

def register(registry: PackRegistry) -> None:
    """Pack 注册入口：同步执行，在进程启动时调用。"""

    # 注册实体类型
    registry.register_entity_type(EntityTypeManifest(
        id="CompressorUnit",
        display_name="压缩机单元",
        properties=CompressorUnitSchema,
        parent_type="Equipment",
    ))

    # 注册 AI 工具
    registry.register_tool(AgentTool(
        name="read_vibration_spectrum",
        description="读取设备的振动频谱数据，用于轴承状态分析",
        parameters=VibrationSpectrumParams,
        execute=read_vibration_spectrum,  # 异步函数
        requires_hitl=False,              # 只读，不需要审批
    ))

    # 注册 LLM Provider（可以覆盖默认）
    registry.register_llm_provider(
        LiteLLMProvider(model="deepseek/deepseek-chat", temperature=0.1)
    )

    # 注册 Hook（在 AI 调用前注入 P&ID 上下文）
    registry.register_hook("before_context_assemble", inject_pid_context)

    # 注册 Playbook
    registry.register_playbook(PlaybookDefinition.from_yaml(
        "packs/oilgas/ontology/playbooks/compressor-alarm-response.yaml"
    ))

    # 注册定时任务
    registry.register_scheduler_job(
        opcua_collector.collect_all,
        trigger="interval", seconds=5, id="oilgas_opcua_collect"
    )
```

### PackLoader 实现（简单，~50 行）

```python
# core/pack_loader/__init__.py（更新）

import importlib
from pathlib import Path
import yaml

def load_all_packs(registry: PackRegistry) -> None:
    """发现并加载所有已安装的 Pack。"""
    packs_dir = Path("packs")

    for pack_dir in packs_dir.iterdir():
        if not pack_dir.is_dir():
            continue

        manifest_path = pack_dir / "clawtwin.pack.json"
        if not manifest_path.exists():
            continue

        manifest = PackManifest.parse_file(manifest_path)

        # 执行 Pack 的数据库迁移
        run_pack_migrations(pack_dir, manifest.migrations)

        # 调用 Pack 入口函数
        module = importlib.import_module(manifest.python_module)
        module.register(registry)  # 同步执行

        logger.info(f"Pack loaded: {manifest.id} v{manifest.version}")
```

---

## 七、核心文件结构（目标状态）

```
platform-api/
├── core/
│   ├── object_store/           ✅ 完成
│   ├── extension_registry/     ✅ 设计好，需补全 register_* 方法
│   ├── agent_runtime/          ❌ 需新建
│   │   ├── loop.py             ← 30 行 async 工具循环（LiteLLM）
│   │   ├── session.py          ← AgentSession 数据类
│   │   └── tool_registry.py    ← 工具注册与执行
│   ├── context_engine/         ❌ 需新建
│   │   ├── assembler.py        ← ContextAssembler（~100 行）
│   │   └── package.py          ← ContextPackage 数据类
│   ├── playbook_engine/        ⚡ 已有，Phase B 迁移到 LangGraph
│   ├── function_executor/      ⚡ 骨架，需连接 agent_runtime
│   ├── action_executor/        ✅ 有实现
│   └── pack_loader/            ⚡ 需更新以支持新 manifest
├── infra/
│   ├── hooks/                  ❌ 需新建（~80 行）
│   │   └── __init__.py         ← HookSystem 实现
│   ├── event_dispatcher/       ✅ 完成
│   └── outbox/                 ✅ 完成
├── providers/
│   ├── llm.py                  ❌ 填充：LiteLLMProvider（~30 行）
│   ├── embedder.py             ❌ 填充：LiteLLM embedding（~20 行）
│   └── notifier.py             ❌ 填充：基础通知接口
├── aip/
│   └── mcp_server.py           ⚡ 已有，扩展工具列表
├── packs/
│   └── oilgas/
│       ├── clawtwin.pack.json  ❌ 新建（替代 manifest.yaml）
│       ├── __init__.py         ❌ 新建 register() 入口
│       └── ontology/           ✅ 已有，迁移 diagnose_equipment 到这里
├── ontology/
│   ├── object_types/           ✅ 4 个核心类型
│   ├── function_types/         ❌ 清空（工业类型移到 Pack）
│   └── action_types/           ✅ 有实现
└── apps/
    ├── http/                   ✅ 40+ 端点，补充 /v1/sessions
    └── cli/                    ⚡ 补充 --json flag
```

---

## 八、开发阶段规划（最小核心优先）

### Phase B-0：点火（2 周，让 AI 真正运行）

**目标**：端到端跑通一次完整的 AI 诊断工具调用。

```
Week 1:
  □ providers/llm.py：LiteLLMProvider（30 行）
  □ core/agent_runtime/loop.py：简单 async 工具循环（50 行）
  □ core/agent_runtime/session.py：AgentSession 数据类（30 行）
  □ core/context_engine/assembler.py：基础版，只用 EntityStore + TimeSeries（60 行）
  □ packs/oilgas/ontology/function_types/diagnose_equipment.yaml：填充真实逻辑

Week 2:
  □ infra/hooks/__init__.py：HookSystem（80 行）
  □ core/extension_registry：补全所有 register_*() 方法
  □ 端到端测试：告警 → ContextAssembler → AgentRuntime → WorkOrder
  □ 所有 clawtwin CLI 命令加 --json flag

验收：pytest tests/test_agent_runtime.py 全绿（mock LLM）
```

### Phase B-1：知识飞轮（4 周，让系统越用越聪明）

```
Week 3-4:
  □ pip install llama-index llama-index-vector-stores-postgres
  □ core/context_engine/assembler.py：加入 LlamaIndex KB 检索
  □ infra/memory/：CBR 实现（工单关闭 → LlamaIndex ingest → pgvector）
  □ workorder_closed hook 触发 CBR 入库

Week 5-6:
  □ packs/oilgas/clawtwin.pack.json：完整 Pack manifest
  □ packs/oilgas/__init__.py：register() 入口函数
  □ core/pack_loader：支持新 manifest 格式
  □ POST /v1/packs/reload：热重载（无需重启）

验收：oilgas pack 可独立安装；第二次同类告警的 CBR 命中率 > 0
```

### Phase B-2：工程化（4 周，稳定生产部署）

```
Week 7-8:
  □ pip install langgraph
  □ PlaybookEngine 迁移到 LangGraph（interrupt() 替代现有 HITL 实现）
  □ LangGraph PostgresSaver：PlaybookRun 持久化，支持断电恢复
  □ Gateway WebSocket：Studio 实时订阅

Week 9-10:
  □ pip install asyncua
  □ connectors/opcua/：OPC-UA 真实采集（替换 mock）
  □ packs/oilgas：注册真实 OPC-UA 连接器
  □ BaselineModel：简单统计基线（pandas + numpy，~100 行）

验收：m2_acceptance.sh 全绿；真实设备数据采集 → 告警 → AI 诊断全链路
```

### Phase C+：扩展生态

```
Phase C-0: 第二个 IndustryPack（power/chemical/manufacturing）
Phase C-1: LangGraph 复杂 AgentSession（并行工具、子智能体）
Phase C-2: World Model（因果图、预测性维护）
Phase C-3: 多站点联邦（跨站 CBR 共享）
```

---

## 九、新代码量估算（消除"开发量太大"的担忧）

**核心洞察：Platform 80% 的功能由成熟库承担，我们只写"胶水代码"和"领域逻辑"。**

| 模块                          | 自定义代码行数 | 主要库               |
| ----------------------------- | -------------- | -------------------- |
| LLM Provider 填充             | ~50 行         | LiteLLM              |
| ContextAssembler（基础版）    | ~100 行        | asyncio + SQLAlchemy |
| ContextAssembler（KB+CBR）    | +50 行         | LlamaIndex           |
| AgentRuntime（简单循环）      | ~80 行         | LiteLLM              |
| HookSystem                    | ~100 行        | 纯 Python            |
| PackRegistry 补全             | ~150 行        | 现有骨架扩展         |
| WorkOrder 状态机              | ~80 行         | transitions          |
| CBR 入库 Hook                 | ~60 行         | LlamaIndex           |
| PlaybookEngine LangGraph 迁移 | ~100 行        | LangGraph            |
| OPC-UA 连接器                 | ~200 行        | asyncua              |
| oilgas pack register()        | ~150 行        | 调用 register\_\*    |
| CLI --json flag               | ~50 行         | Typer                |
| **总计（Phase B 新增）**      | **~1200 行**   |                      |

**1200 行新代码，绑定测试估计 2000 行测试代码。这是完全可控的规模。**

---

## 十、重要设计原则（不可违反）

1. **OT 层只读**：Connector 只采集，不写。写回 L1/L2 必须经过 ActionExecutor + HITL 确认。
2. **EventBus 是唯一出口**：语义层的任何变化必须通过 EventBus 通知行动层，禁止直接监听数据库。
3. **Provider 必须可替换**：LiteLLM 的 model 字符串由配置控制，不硬编码。
4. **Pack 边界清晰**：工业专有逻辑（油气/电力）住在 Pack，核心不感知行业。
5. **HITL 门控高风险**：任何工具的 `requires_hitl=True` 必须暂停等待人工确认，绝不自动执行。
6. **对话不进 Platform 核心**：自然语言理解、会话管理、IM 集成 → 全部 OpenClaw。Platform 只做结构化操作。
7. **配置驱动行为**：LLM 模型、向量存储后端、通知渠道 → 全部配置文件控制，不硬编码。

---

## 十一、文档关系说明

本文档（V2）是唯一权威来源，取代：

- `CLAWTWIN-ARCHITECTURE-OVERVIEW.md`
- `CLAWTWIN-SYSTEM-FRAMEWORK.md`
- `CLAWTWIN-DEFINITIVE-REFERENCE.md`
- `CLAWTWIN-RESOURCE-ARCHITECTURE.md`

以下文档继续有效（补充本文档）：

- `CLAWTWIN-MILESTONE-PLAN.md`：里程碑验收标准
- `CLAWTWIN-INTEGRATION-ARCHITECTURE.md`：OpenClaw 深度集成细节
- `CLAWTWIN-ENTERPRISE-AI-ARCHITECTURE.md`：客户对外叙事

代码层面的单一真源：`platform-api/STRUCTURE.md`（目录-职责映射）。
