# ClawTwin 架构剪枝评审（OpenClaw / Claude Code 风格对标）

> **版本**：v1.1 · 2026-05-11  
> **立场**：高级架构师视角，专门看是否过度工程化  
> **结论**：**之前的 CORE-ARCHITECTURE-AUDIT-2026 走偏了——Action 框架过重，违背 AI 时代极简精神。**

> ⚠️ **2026-05-11 范式纠正（最高权威：INDUSTRIAL-FOUNDRY-ARCHITECTURE.md）**：
> 本文档的 @tool 装饰器/Provider/Channel/Stream/Industry Pack **仍然有效**，但服从更高层的 **Industrial Foundry 范式**：
>
> - ClawTwin 不是 Agent 系统，而是 Palantir Foundry 风格的**工业本体平台**
> - **Object Type / Action Type / Function Type 是一等公民**（声明式 YAML），@tool 装饰器现在是 Action 实现的**语法糖**
> - 入口（HTTP/MCP/CLI）由框架**从 Ontology 自动生成**，不再手工注册
> - "Channel" 改称 "App"（Foundry 术语）
> - 5 层目录扩展为 7 层：`ontology / core / apps / aip / providers / infra / workers`
>   详见 INDUSTRIAL-FOUNDRY-ARCHITECTURE.md §九（与本文档的对应关系）。

---

## 一、核心洞察：先看业界最先进 Agent 系统的真实架构

### 1.1 OpenClaw 注册一个 Tool 的真实代码

```typescript
// extensions/feishu/src/chat.ts（真实生产代码）
api.registerTool(
  (ctx) => ({                                    // ★ 工厂函数，接收运行时上下文
    name: "feishu_chat",                         // ★ 字符串名字
    label: "Feishu Chat",                        // ★ UI 友好标签
    description: "Feishu chat operations...",    // ★ LLM 看的描述
    parameters: FeishuChatSchema,                // ★ TypeBox/zod schema
    async execute(_toolCallId, params) {         // ★ 业务逻辑（直接是函数）
      const client = getClient();
      switch (p.action) { ... }
      return json(result);
    }
  })
);
```

**全部抽象就这 5 个字段：name / label / description / parameters / execute。**

### 1.2 Claude Code SDK 的 Tool（同样极简）

```typescript
import { tool } from "@anthropic-ai/claude-agent-sdk";

const acknowledgeAlarm = tool({
  name: "acknowledge_alarm",
  description: "Acknowledge an alarm (ISA-18.2)",
  input_schema: z.object({
    alarm_id: z.string(),
    reason: z.string().optional(),
  }),
  handler: async ({ alarm_id, reason }, ctx) => {
    const alarm = await alarmRepo.get(alarm_id);
    alarm.acknowledge({ by: ctx.user, reason });
    return { ok: true, alarm_id };
  },
});
```

**3 个字段：name / description / input_schema / handler。**

### 1.3 而我之前给 ClawTwin 设计的 Action 框架（CORE-ARCHITECTURE-AUDIT-2026 §3）

```python
# 重型抽象（5+ 个独立概念）
class SafetyContract(BaseModel): ...                # 概念 1
class Action(Generic[InputT, OutputT], ABC):        # 概念 2（带泛型）
    name: str
    description: str
    safety: SafetyContract                          # 概念 3
    input_model: type[InputT]                       # 概念 4
    output_model: type[OutputT]                     # 概念 5
    @abstractmethod
    async def execute(self, input, actor, ctx) -> OutputT: ...

class ActionContext(BaseModel): ...                 # 概念 6
class Actor(BaseModel): ...                         # 概念 7
class ApprovalGrantedActor(Actor): ...              # 概念 8
class ActionRegistry: ...                           # 概念 9

async def invoke(action, input, actor, transport): ...  # 概念 10

def mount_action(app, mcp, cli, action): ...        # 概念 11
```

**11 个概念。"Java 化"严重，违背 OpenClaw / Claude Code 风格。**

---

## 二、剪枝原则（高级架构师视角）

> "完美不是没有什么可以再加，而是没有什么可以再减。" —— Antoine de Saint-Exupéry

### 2.1 三条剪枝铁律

```
1. 任何抽象必须有 ≥3 个具体实现来支撑它的存在。
   只有 1 个实现的抽象 = 过度工程化。

2. 任何分层必须为团队解决"找不到代码"的问题。
   分层超过团队人数 = 错误的分层。

3. 任何框架必须使开发者写更少的代码。
   框架增加样板代码 = 反向框架。
```

### 2.2 用三铁律审视当前设计

| 设计                      | 实现数                        | 团队规模 | 是否减少代码                       | 判断     |
| ------------------------- | ----------------------------- | -------- | ---------------------------------- | -------- |
| Action 抽象类 + Generic   | ~30 个 Action                 | 2 人     | ❌ 增加（每个 Action 多 6 行样板） | **过度** |
| SafetyContract 单独类     | 1 处使用                      | —        | ❌ 字典即可                        | **过度** |
| ApprovalGrantedActor 子类 | 仅在 invoke 内部用            | —        | ❌ 增加分支                        | **过度** |
| Clean Architecture 5 层   | 5 层划分                      | 2 人     | ❌ 增加 import 路径长度            | **过度** |
| Channel 抽象              | 4 个（Studio/Feishu/MCP/CLI） | —        | ✅ 让 4 处入口共享                 | **保留** |
| Provider 抽象             | 2-3 个（vLLM/通义/文心）      | —        | ✅ 模型可替换                      | **保留** |
| LLM Trace 表              | 1 个表 + N 个写入点           | —        | ✅ 唯一来源                        | **保留** |
| ApprovalQueue             | 6+ 个高风险 Action            | —        | ✅ 统一审批                        | **保留** |

---

## 三、修正版核心架构：OpenClaw 风格的简化设计

### 3.1 项目结构（5 个目录就够，不再 7 层）

```
platform-api/
├── core/                  # 业务核心（不依赖框架代码）
│   ├── tools/             # ★ 所有 LLM/HTTP/CLI 工具（OpenClaw 风格函数）
│   │   ├── alarms.py      # acknowledge_alarm / shelve_alarm / list_active_alarms
│   │   ├── workorders.py  # create_workorder / approve_workorder / list_workorders
│   │   ├── equipment.py   # get_equipment_context / get_decision_package
│   │   ├── knowledge.py   # search_kb / ingest_doc
│   │   └── production.py  # record_production / get_production_kpi
│   ├── domain/            # 实体 + FSM（业务规则的家）
│   │   ├── alarm.py       # Alarm + AlarmFSM (transitions 库)
│   │   ├── workorder.py   # WorkOrder + WorkOrderFSM
│   │   └── equipment.py
│   └── repos/             # 数据访问（直接 SQLAlchemy，不要 Port）
│       ├── alarm_repo.py
│       └── workorder_repo.py
├── channels/              # ★ 用户接入层（OpenClaw 概念）
│   ├── http.py            # FastAPI 路由（自动从 tool 注册）
│   ├── mcp.py             # FastMCP 服务（自动从 tool 注册）
│   ├── cli.py             # Typer 命令（自动从 tool 注册）
│   └── feishu.py          # 飞书 webhook（卡片回调专用）
├── providers/             # ★ LLM/Embedding/Notification 可插拔
│   ├── llm.py             # vLLM / 阿里云通义 / 文心一言（统一接口）
│   ├── embedder.py        # bge-m3 / OpenAI 兼容
│   └── notifier.py        # Feishu / 邮件 / 钉钉
├── infra/                 # 横切基础设施
│   ├── tracing.py         # llm_traces 表写入
│   ├── approval.py        # ApprovalQueue
│   ├── audit.py           # audit_logs 表写入
│   ├── auth.py            # JWT + ABAC
│   └── settings.py        # pydantic-settings
└── workers/               # 后台
    ├── scheduler.py       # APScheduler
    └── streams.py         # Redis Streams 消费

# 共 5 个一级目录，符合 2 人团队的认知容量
```

**与 CORE-ARCHITECTURE-AUDIT-2026 §3.3 的对比**：

```
之前（过度）：core / adapters / ports / interfaces / workers / infra / domain
现在（简化）：core / channels / providers / infra / workers
                ▲ 减少 2 个一级目录，删除 ports/adapters 这种 Java 风格
```

### 3.2 修正的 Tool 定义（去掉 Action 抽象类）

```python
# core/tools/_framework.py — 全部框架代码 < 80 行
from typing import Any, Callable, TypeVar
from pydantic import BaseModel
from functools import wraps
from infra.auth import enforce_role, enforce_station
from infra.tracing import trace
from infra.approval import maybe_request_approval
from infra.audit import audit_log

ToolFunc = TypeVar("ToolFunc", bound=Callable)

# 全局工具注册表
TOOLS: dict[str, "ToolDef"] = {}

class ToolDef(BaseModel):
    name: str
    label: str
    description: str
    input_schema: type[BaseModel]
    output_schema: type[BaseModel] | None = None
    handler: Callable
    risk: str = "low"                          # low | medium | high
    requires_role: list[str] = []
    requires_station_match: bool = True
    requires_approval: bool = False            # high 默认 True
    rate_limit_per_min: int = 60
    idempotent: bool = True

def tool(
    name: str,
    description: str,
    input_schema: type[BaseModel],
    output_schema: type[BaseModel] | None = None,
    *,
    label: str | None = None,
    risk: str = "low",
    requires_role: list[str] = [],
    requires_station_match: bool = True,
    requires_approval: bool | None = None,
    rate_limit_per_min: int = 60,
    idempotent: bool = True,
):
    """
    OpenClaw 风格的 Tool 装饰器。
    HTTP / MCP / CLI 三处入口自动从注册表生成。
    框架自动处理：权限 / 限流 / 审批 / Trace / Audit。
    """
    def decorator(fn: ToolFunc) -> ToolFunc:
        td = ToolDef(
            name=name,
            label=label or name,
            description=description,
            input_schema=input_schema,
            output_schema=output_schema,
            handler=fn,
            risk=risk,
            requires_role=requires_role,
            requires_station_match=requires_station_match,
            requires_approval=requires_approval if requires_approval is not None else (risk == "high"),
            rate_limit_per_min=rate_limit_per_min,
            idempotent=idempotent,
        )
        TOOLS[name] = td
        return fn
    return decorator

async def invoke(name: str, raw_input: dict, actor, transport: str):
    """统一调用入口（HTTP / MCP / CLI / Scheduler 共用）"""
    td = TOOLS[name]
    input = td.input_schema(**raw_input)

    enforce_role(actor, td.requires_role)
    if td.requires_station_match:
        enforce_station(actor, input)

    if td.requires_approval:
        approval = await maybe_request_approval(td, input, actor)
        if approval and approval.status != "approved":
            return {"approval_id": approval.id, "status": "pending"}

    async with trace(td.name, input, actor, transport) as tr:
        result = await td.handler(input, actor)
        await audit_log(td.name, input.model_dump(), result, actor, transport)
        tr.set_result(result)
        return result
```

### 3.3 写一个新 Tool（最小代码量）

```python
# core/tools/alarms.py
from pydantic import BaseModel, Field
from datetime import datetime
from core.tools._framework import tool
from core.repos.alarm_repo import AlarmRepo

class AckAlarmIn(BaseModel):
    alarm_id: str = Field(..., description="告警 ID")
    reason: str | None = Field(None, description="确认原因（可选）")

class AckAlarmOut(BaseModel):
    alarm_id: str
    acknowledged_at: datetime
    acknowledged_by: str

@tool(
    name="acknowledge_alarm",
    description="确认告警（ISA-18.2）。仅标记操作员已知晓，不抑制告警本身。",
    input_schema=AckAlarmIn,
    output_schema=AckAlarmOut,
    risk="low",
    requires_role=["operator", "supervisor", "engineer"],
)
async def acknowledge_alarm(input: AckAlarmIn, actor) -> AckAlarmOut:
    alarm = await AlarmRepo.get(input.alarm_id)
    alarm.acknowledge(by=actor.user_id, reason=input.reason)
    await AlarmRepo.save(alarm)
    return AckAlarmOut(
        alarm_id=alarm.id,
        acknowledged_at=alarm.acknowledged_at,
        acknowledged_by=actor.user_id,
    )
```

**对比之前的 Action 类**：减少了 `class XxxAction(Action[...])` / `name = / description = / safety = / input_model = / output_model = / async def execute(self, ...)` 共约 8 行样板代码。30 个 Tool 就是 **240 行样板差异**。

### 3.4 三处入口自动从注册表生成

```python
# channels/http.py — 8 行代码自动暴露所有工具为 HTTP 端点
from fastapi import FastAPI, Depends
from core.tools._framework import TOOLS, invoke
from infra.auth import get_actor

def mount_http(app: FastAPI):
    for td in TOOLS.values():
        path = f"/v1/tools/{td.name}"
        async def endpoint(input: td.input_schema, actor=Depends(get_actor), _td=td):
            return await invoke(_td.name, input.model_dump(), actor, "http")
        app.post(path, summary=td.label, response_model=td.output_schema)(endpoint)

# channels/mcp.py — 8 行代码暴露所有工具到 MCP
from fastmcp import FastMCP
from core.tools._framework import TOOLS, invoke

def build_mcp(get_mcp_actor) -> FastMCP:
    mcp = FastMCP("clawtwin-nexus")
    for td in TOOLS.values():
        @mcp.tool(name=td.name, description=td.description)
        async def _tool(_td=td, **kwargs):
            actor = get_mcp_actor()
            return await invoke(_td.name, kwargs, actor, "mcp")
    return mcp

# channels/cli.py — 同样 8 行
import typer
from core.tools._framework import TOOLS, invoke

def build_cli() -> typer.Typer:
    app = typer.Typer()
    for td in TOOLS.values():
        @app.command(name=td.name, help=td.description)
        def _cmd(_td=td, **kwargs):
            actor = get_cli_actor()
            asyncio.run(invoke(_td.name, kwargs, actor, "cli"))
    return app
```

**所有工具一次注册，三处入口自动暴露。这就是 OpenClaw / Claude Code 哲学。**

---

## 四、新增的核心抽象：Channel + Provider

### 4.1 Channel 抽象（OpenClaw 风格）

当前 ClawTwin 的"Studio + Feishu Bot + MCP + CLI"是散落的入口分类。**用户接入点应该统一为 Channel 概念**：

```python
# channels/_base.py
class Channel(Protocol):
    """所有用户接入点的统一接口"""
    name: str
    async def authenticate(self, request) -> Actor: ...
    async def deliver(self, message: ChannelMessage, target: ChannelTarget) -> None: ...
    async def receive(self) -> AsyncIterator[ChannelEvent]: ...

# 实现
- channels/http.py    → HTTPChannel（Studio Web 通过它）
- channels/mcp.py     → MCPChannel（OpenClaw Agent 通过它）
- channels/cli.py     → CLIChannel（运维通过它）
- channels/feishu.py  → FeishuChannel（飞书卡片回调通过它）
```

**未来工业场景的 Channel 自然延伸**：

- `channels/kiosk.py` → 场站大屏（KioskChannel）
- `channels/handheld.py` → 手持终端（HandheldChannel）
- `channels/voice.py` → 无线对讲（VoiceChannel，Phase D）

**Studio 不是"独立产品"，是 HTTPChannel 的一种界面表现。**

### 4.2 Provider 抽象（让 LLM 模型可热切换）

当前 vLLM 锁死 Qwen，但国央企客户经常要求：

- 国资委：必须用 GLM-4 / 文心一言（信创）
- 中石油：可能要求私有化部署的通义千问 Max
- 海外项目：要用 Anthropic Claude 或 GPT-5

```python
# providers/llm.py
class LLMProvider(Protocol):
    name: str
    async def chat(self, messages, *, model: str, **kwargs) -> str: ...
    async def stream(self, messages, *, model: str, **kwargs) -> AsyncIterator[str]: ...

# providers/embedder.py
class EmbedProvider(Protocol):
    name: str
    dim: int
    async def embed(self, texts: list[str]) -> list[list[float]]: ...

# 通过 settings 切换
LLM_PROVIDER = "vllm"      # vllm | tongyi | wenxin | claude | gpt
EMBED_PROVIDER = "bge-m3"  # bge-m3 | openai | tongyi-embed
```

> ⚠️ 注意：Nexus **依然不直接调 chat**（铁律 19）。Provider 抽象只是 OpenClaw 的依赖项，让 OpenClaw 可以接入不同后端。Nexus 自己只用 `EmbedProvider`。

---

## 五、Stream-by-default：实时数据是工业第一公民

### 5.1 当前问题

当前 API 都是 request/response：

- 设备状态查询 = `GET /v1/equipment/X-001`（轮询）
- AI 推理 = `POST /v1/ai/jobs` + 轮询 status
- 工单状态变化 = 不通知，前端需要手动刷新

### 5.2 OpenClaw / Claude Code 的做法：默认流式

```python
# channels/http.py — 加 SSE 端点
@app.get("/v1/streams/equipment/{eq_id}")
async def stream_equipment(eq_id: str, actor=Depends(get_actor)):
    async def gen():
        async for event in equipment_event_stream(eq_id, actor):
            yield {"event": event.type, "data": event.json()}
    return EventSourceResponse(gen())

# 客户端（Studio）
const sse = new EventSource(`/v1/streams/equipment/X-001`);
sse.addEventListener("reading", e => updateChart(JSON.parse(e.data)));
sse.addEventListener("alarm", e => showAlarm(JSON.parse(e.data)));
sse.addEventListener("ai_insight", e => showInsight(JSON.parse(e.data)));
```

**收益**：

- 实时性：< 100ms 延迟（轮询无法做到）
- 带宽：增量推送，不重复全量
- 体验：操作员看到"活的"系统

### 5.3 实现复杂度

```
[ ] 新增 SSE 端点：/v1/streams/equipment/{id} / /v1/streams/alarms / /v1/streams/workorders
[ ] Studio 用 EventSource API（标准 Web API，无依赖）
[ ] Phase A 用轮询 fallback；Phase B 全量切 SSE
预计：1.5 工程师天
```

---

## 六、Skill 升级为可发布包（Industry Pack 概念）

### 6.1 当前问题

`industrial-twin/SKILL.md`、`industrial-analytics/SKILL.md` 等是散落的 markdown 文件。

### 6.2 借鉴 npm / Cursor Skill / Claude Code Skill：Industry Pack

```
industry-pack-oilgas-cng/      # 一个完整可发布的"中石油 CNG 站包"
├── pack.json                   # 元数据：name, version, vendor, license, deps
├── README.md
├── skills/                     # OpenClaw Skills（每个 SKILL.md）
│   ├── industrial-assistant/
│   │   ├── SKILL.md
│   │   └── examples/
│   ├── industrial-analytics/
│   └── industrial-admin/
├── ontology/                   # 设备本体定义
│   ├── equipment_types.json    # 设备类型 + 标准指标
│   ├── alarm_priorities.json   # ISA-18.2 优先级表
│   └── workorder_workflow.json
├── knowledge/                  # 预置知识文档（PDF / md）
│   ├── L0/                     # 行业标准（GB/SY-T）
│   └── L1/                     # 设备手册
├── prompts/                    # System prompts 模板
│   ├── morning_briefing.j2
│   └── shift_handover.j2
├── dashboards/                 # 预置 Grafana Dashboard JSON
└── tests/                      # Pack 自检（用 ClawTwin Pack SDK）

# 安装
clawtwin pack install industry-pack-oilgas-cng@1.2.0

# 升级
clawtwin pack upgrade industry-pack-oilgas-cng

# 发布到 ClawHub
clawtwin pack publish .
```

**收益**：

- 行业知识可版本化（中石油 v1.2 可升级到 v1.3）
- 不同行业可独立打包：`oilgas-cng` / `chemical-pe` / `power-thermal`
- 第三方合作伙伴可发布自己的 Pack（生态构建）
- 客户私有化部署：选定 Pack → 一键安装

### 6.3 Pack SDK 简单到极致

```python
# clawtwin pack install 实现
class IndustryPack(BaseModel):
    name: str
    version: str
    vendor: str
    skills: list[str]
    ontology_files: list[str]
    knowledge_dirs: list[str]
    prompts: dict[str, str]
    dashboards: list[str]

async def install_pack(pack_dir: Path):
    pack = IndustryPack.parse_file(pack_dir / "pack.json")
    # 1. 注册 OpenClaw Skills
    for skill in pack.skills:
        await openclaw_register_skill(pack_dir / "skills" / skill)
    # 2. 加载 ontology 到 PostgreSQL
    for ont in pack.ontology_files:
        await load_ontology(pack_dir / "ontology" / ont)
    # 3. 摄入 knowledge 到 pgvector（LlamaIndex）
    for kdir in pack.knowledge_dirs:
        await ingest_documents_dir(pack_dir / kdir)
    # 4. 注册 prompts
    for name, path in pack.prompts.items():
        await register_prompt(name, pack_dir / path)
    # 5. 导入 Grafana dashboards
    for dash in pack.dashboards:
        await grafana_import(pack_dir / dash)
```

**Phase A 不需要做完整 Pack 系统**，但 ontology / knowledge / prompts 应该按 Pack 风格组织目录，未来 Phase C 可以一行命令打包发布。

---

## 七、CORE-ARCHITECTURE-AUDIT-2026 的具体修正

> ⚠️ **CORE-ARCHITECTURE-AUDIT-2026 文档需要做以下修正**：

| 原章节                           | 修正方向                                                               |
| -------------------------------- | ---------------------------------------------------------------------- |
| §3.2 Action 抽象类               | **删除**，改为 §3.3 装饰器风格                                         |
| §3.3 Clean Architecture 7 层目录 | **简化**为本文档 §3.1 的 5 层（core/channels/providers/infra/workers） |
| §6 完整重写                      | 用本文档 §3.1 替换                                                     |
| §10 架构图                       | **简化**：去掉 ports/adapters，明示 Channel + Provider                 |
| 新增 §11                         | Channel 抽象（本文档 §4.1）                                            |
| 新增 §12                         | Provider 抽象（本文档 §4.2）                                           |
| 新增 §13                         | Stream-by-default（本文档 §5）                                         |
| 新增 §14                         | Industry Pack（本文档 §6）                                             |

**保留 CORE-ARCHITECTURE-AUDIT-2026 的精华**：

- ✅ §4 LLM Trace（不变，必须做）
- ✅ §5 ApprovalQueue（不变，必须做）
- ✅ §11 业界对标表（不变）

---

## 八、对开发的具体影响

### 8.1 减少的代码量

```
原方案：30 个 Action × ~30 行样板 = 900 行样板代码
新方案：30 个 tool() 装饰器 × ~6 行 = 180 行样板代码
节省：720 行（80%）
```

### 8.2 减少的概念数

```
原方案：Action / SafetyContract / ActionContext / Actor /
        ApprovalGrantedActor / ActionRegistry / invoke /
        mount_action / Generic / port / adapter = 11 个概念
新方案：tool 装饰器 / TOOLS 注册表 / invoke / Channel /
        Provider = 5 个概念
节省：6 个概念（55%）
```

### 8.3 更新的开发任务

修正 [T2.5] 任务的实现方式（用本文档 §3 的装饰器风格，而不是 Action 类）：

```
[T2.5] Tool 框架 + invoke + Trace + Approval（替代之前的 "Action 框架"）

实现内容：
1. core/tools/_framework.py（< 100 行：tool 装饰器 + TOOLS 注册表 + invoke）
2. infra/tracing.py（async with trace() 上下文管理器）
3. infra/approval.py（ApprovalQueue + maybe_request_approval）
4. infra/audit.py（audit_log 函数）
5. channels/http.py（mount_http(app) 自动暴露所有 tool）
6. channels/mcp.py（build_mcp() 自动暴露所有 tool）
7. channels/cli.py（build_cli() 自动暴露所有 tool）
8. tests/test_tool_framework.py（测试装饰器/注册/invoke/trace/approval）

⚠️ 不要写 Action 抽象类。装饰器 + 函数即可。
⚠️ 不要使用 Generic。Pydantic BaseModel 即可。
⚠️ 不要分 ports/adapters/interfaces 多层。直接 SQLAlchemy 仓库。
```

---

## 九、对照 OpenClaw / Claude Code / Anthropic 风格的总评

| 设计哲学      | OpenClaw                   | Claude Code        | ClawTwin（剪枝后）                                |
| ------------- | -------------------------- | ------------------ | ------------------------------------------------- |
| Tool 注册     | 工厂函数 + 单一对象        | 装饰器 + 函数      | **装饰器 + 函数** ✅                              |
| 入口抽象      | Channel（统一接口）        | IDE/CLI/SDK 三入口 | **Channel** ✅                                    |
| Provider 解耦 | Provider 接口              | 模型可换           | **Provider** ✅                                   |
| 默认流式      | 是                         | 是                 | **是**（SSE） ✅                                  |
| 包系统        | Plugin npm 包              | Skill 包           | **Industry Pack** ✅                              |
| 横切关注      | hooks                      | middleware         | **trace/approval/audit** ✅                       |
| 分层数        | 3 层（plugin/sdk/runtime） | 3 层               | **5 层**（core/channels/providers/infra/workers） |
| 复杂度评级    | ★★ 极简                    | ★★ 极简            | **★★ 极简（剪枝后）**                             |

---

## 十、最终核心架构图（剪枝后）

```
┌────────────────────────────────────────────────────────────────┐
│                       用户/智能体                                │
│  Studio Web   Feishu App   OpenClaw Agent   clawtwin CLI       │
│  场站大屏(B+)  手持终端(B+)                                       │
└──────┬──────────┬───────────┬──────────────────┬───────────────┘
       │          │           │                  │
       ▼          ▼           ▼                  ▼
┌────────────────────────────────────────────────────────────────┐
│                    channels/（统一接入层）                       │
│  HTTPChannel  FeishuChannel  MCPChannel  CLIChannel ...         │
│              │                                                  │
│              ▼                                                  │
│         invoke(tool_name, input, actor, transport)              │
│              │                                                  │
│              ▼                                                  │
│  AuthZ → RateLimit → Approval? → Trace start → handler()        │
│                                  ↓                              │
│                                Audit + Trace finish             │
└──────────────────────────────────────┬─────────────────────────┘
                                       │
                                       ▼
┌────────────────────────────────────────────────────────────────┐
│                      core/（业务核心）                           │
│                                                                 │
│  tools/        @tool 装饰函数（30+ 个工具，纯业务）              │
│  domain/       Equipment / Alarm / WorkOrder + FSM             │
│  repos/        SQLAlchemy 仓库（直接，不抽象 Port）              │
└─────────────────────────────────────┬──────────────────────────┘
                                      │
                                      ▼
┌────────────────────────────────────────────────────────────────┐
│                  providers/（可插拔基础能力）                     │
│                                                                 │
│  LLMProvider (vLLM / 通义 / 文心 / Claude)                       │
│  EmbedProvider (bge-m3 / OpenAI 兼容 / 通义嵌入)                  │
│  NotifierProvider (lark-oapi / 邮件 / 钉钉)                      │
└─────────────────────────────────────┬──────────────────────────┘
                                      │
                                      ▼
┌────────────────────────────────────────────────────────────────┐
│              infra/（横切基础设施）                              │
│  tracing  approval  audit  auth  settings                       │
└─────────────────────────────────────┬──────────────────────────┘
                                      │
                                      ▼
┌────────────────────────────────────────────────────────────────┐
│             外部依赖（Phase A：4 服务）                          │
│   PostgreSQL(TS+pgvector)   Redis   vLLM   OpenClaw            │
└────────────────────────────────────────────────────────────────┘

★ workers/ 后台任务：APScheduler + Redis Streams（同样调 invoke）
★ Industry Pack：声明式打包 skills + ontology + knowledge + prompts
```

---

## 十一、立即行动清单

### P0（影响 Phase A T2.5 任务实现方式）

```
[ ] 1. 修正 CORE-ARCHITECTURE-AUDIT-2026.md
       - §3 重写为本文档 §3 的装饰器风格
       - §6 重写为 5 层目录结构
       - 新增 Channel / Provider / Stream / Pack 章节

[ ] 2. 修正 CURSOR-MULTITASK-GUIDE.md [T2.5] 任务提示词
       - 明确"装饰器风格，不是 Action 抽象类"
       - 明确"5 层目录，不是 7 层"

[ ] 3. 修正 SKILL.md 铁律 21
       - 强调"装饰器 + 函数"，不是"Action 类"
```

### P1（Phase A 实现）

```
[ ] 4. core/tools/_framework.py（< 100 行）
[ ] 5. channels/http.py + mcp.py + cli.py（每个 < 30 行）
[ ] 6. providers/ 目录的 LLMProvider / EmbedProvider 接口
[ ] 7. /v1/streams/* SSE 端点设计
```

### P2（Phase B/C）

```
[ ] 8. Industry Pack SDK + clawtwin pack install
[ ] 9. KioskChannel / HandheldChannel
[ ] 10. 多 Provider 切换实测（vLLM / 通义 / 文心）
```

---

## 十二、决议

> **从今天起，ClawTwin 的核心架构哲学是：**
>
> 1. **OpenClaw 风格的 Tool**：装饰器 + 函数，不要类继承
> 2. **5 层目录**：core / channels / providers / infra / workers
> 3. **Channel 抽象**：所有用户接入点平等
> 4. **Provider 抽象**：LLM / Embed / Notifier 可插拔
> 5. **Stream-by-default**：实时是工业第一公民
> 6. **Industry Pack**：声明式知识包，行业可独立打包
>
> **以下设计被废弃（不再用）：**
>
> - ❌ `Action[InputT, OutputT]` 抽象类 + Generic
> - ❌ `SafetyContract` / `ActionContext` / `ApprovalGrantedActor` 单独类
> - ❌ Clean Architecture 7 层目录（ports/adapters/interfaces）
> - ❌ "Studio = 独立产品"（应该是 HTTPChannel 一种表现）
>
> **保留的核心约束（不变）：**
>
> - ✅ 铁律 19：Platform 不直调 vLLM chat
> - ✅ 铁律 20：RAG 用 LlamaIndex
> - ✅ 铁律 22：所有 Tool 调用必写 trace
> - ✅ 4 服务 Phase A 技术栈

---

_本次评审是对 CORE-ARCHITECTURE-AUDIT-2026 的纠偏。_  
_核心教训：高级架构师的本能是"剪枝"，不是"加枝"。任何抽象需通过"3 实现 / 团队规模 / 减少代码"三铁律检验。_  
_OpenClaw 和 Claude Code 用 100k 行代码做出业界顶级 Agent 系统的核心能力——他们的简洁不是偷懒，是高超。_
