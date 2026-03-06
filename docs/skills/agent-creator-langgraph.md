---
name: agent-creator-langgraph
description: "Review & guide building production-grade LangGraph / DeepAgent agents. Use when: user designs/reviews/debugs LangGraph StateGraph agents, multi-agent orchestration (Supervisor/Swarm/Hierarchical), state management, checkpointing, human-in-the-loop. NOT for: Claude agents (use agent-creator-claude), OpenAI agents (use agent-creator-openai), vanilla LangChain chains without graph structure."
metadata: { "openclaw": { "emoji": "🕸️", "requires": { "extensions": [] } } }
---

# LangGraph / DeepAgent — Agent Creator & Reviewer

Review, design, and guide the construction of production-grade agents using **LangGraph** (`langgraph`) and the **DeepAgent** pattern (`deepagents`). This skill acts as a senior agent architect: it evaluates graph-based agent designs against best practices, identifies anti-patterns, and produces actionable improvement plans.

## When to Use

- "Review my LangGraph agent architecture" / "帮我审查 LangGraph agent 设计"
- "Design a multi-agent supervisor system" / "设计多 agent supervisor 系统"
- "How to set up state and checkpointing?" / "怎么设计 state 和 checkpointing"
- "My graph keeps looping infinitely" / "graph 无限循环了"
- "Should I use supervisor or swarm pattern?" / "该用 supervisor 还是 swarm 模式"
- "Add human-in-the-loop approval to my graph" / "加入人工审批节点"
- "Set up DeepAgent with subagent spawning" / "用 DeepAgent 搭建子 agent"
- "How to manage cross-thread memory?" / "跨线程记忆怎么管理"

## When NOT to Use

- Claude Agent SDK (MCP/hooks/subagent) → use `/agent-creator-claude`
- OpenAI Agent SDK (handoff/guardrail/Runner) → use `/agent-creator-openai`
- 纯 LangChain chain（无 graph 结构）→ 参考 LangChain 文档
- 非 Python agent（LangGraph 以 Python 为主，JS 版本有差异）

---

## Architecture Reference

### LangGraph Core Abstractions

```
LangGraph
├── StateGraph                     # 核心图类（参数化为 State schema）
│   ├── State schema               # TypedDict | Pydantic BaseModel
│   │   ├── channels              # 每个字段 = 一个 channel
│   │   └── reducers              # 定义 state 更新逻辑（append / replace / custom）
│   ├── Nodes                      # 函数：接收 State → 返回 partial State 更新
│   │   ├── add_node(name, func)  # 注册节点
│   │   └── ToolNode              # 内置：自动执行 LLM tool calls
│   ├── Edges                      # 节点间连接
│   │   ├── add_edge(a, b)        # 固定边
│   │   └── add_conditional_edges # 条件路由（基于 state）
│   ├── START / END               # 特殊节点
│   └── compile()                  # 编译为可执行 CompiledGraph
│       ├── checkpointer          # 持久化（MemorySaver/PostgresSaver）
│       ├── interrupt_before      # HITL 中断点
│       └── interrupt_after       # HITL 中断点
│
├── Checkpointer                   # 状态持久化
│   ├── MemorySaver               # 内存（开发/测试）
│   ├── SqliteSaver               # SQLite（本地）
│   ├── PostgresSaver             # PostgreSQL（生产）
│   └── RedisSaver                # Redis（高并发）
│
├── Store                          # 跨线程长期记忆
│   └── InMemoryStore / BaseStore # 用户偏好、知识库等
│
├── Command                        # HITL 恢复指令
│   ├── resume                    # 继续执行 + 注入值
│   └── goto                      # 跳转到指定节点
│
└── Subgraph                       # 子图嵌入
    └── compiled_graph 作为 node  # 独立 state + 边界映射
```

### DeepAgent Architecture (langchain-ai/deepagents)

```
DeepAgent = 预装工具的 LangGraph Agent Harness
├── create_deep_agent()            # 返回 compiled LangGraph graph
├── Built-in Tools
│   ├── write_todos                # 任务分解与进度追踪
│   ├── read_file / write_file / edit_file  # 文件系统操作
│   ├── ls / glob / grep           # 搜索
│   ├── execute                    # Shell 执行（带沙箱）
│   └── task                       # 子 agent 委派（独立 context）
├── Auto-summarization             # 对话历史过长时自动摘要
├── Provider agnostic              # Claude / OpenAI / Google / 任意 LangChain 模型
└── CLI                            # 终端编码 agent
```

### Four Multi-Agent Patterns

| Pattern          | Topology                                       | Control  | Best For             |
| ---------------- | ---------------------------------------------- | -------- | -------------------- |
| **Supervisor**   | 星型（supervisor → workers）                   | 集中式   | 结构化流程、一致性高 |
| **Swarm**        | 网状（agent 间 handoff）                       | 去中心化 | 动态路由、灵活性高   |
| **Hierarchical** | 树型（supervisor → sub-supervisors → workers） | 多层级   | 复杂组织、大规模     |
| **Network**      | 任意拓扑                                       | 混合     | 自定义复杂流程       |

---

## Agent Design Review Pattern

Review any LangGraph agent design by walking through these 10 dimensions in order.

### 1. Pattern Selection

**先问：用哪种多 agent 模式？**

```
Decision Tree:
├── 任务有明确的阶段/步骤？（如 research → draft → review → publish）
│   └── YES → Supervisor pattern（supervisor 按顺序分派）
│
├── Agent 需要自主决定下一步？（如客服路由）
│   └── YES → Swarm pattern（agent 间 handoff）
│
├── 子任务可递归分解？（如 deep research）
│   └── YES → Hierarchical / DeepAgent（子 agent spawning）
│
├── 需要并行处理 + 汇总？
│   └── YES → Supervisor + parallel fan-out nodes
│
└── 单一任务？
    └── 单 agent + ToolNode（不需要多 agent）
```

### 2. State Schema Design

**这是 LangGraph 最关键的设计决策 — State 设计错误，一切都错。**

**检查清单：**

- [ ] 用 TypedDict（简单场景）或 Pydantic BaseModel（需验证）
- [ ] 每个字段有明确的 reducer（默认 = replace last write）
- [ ] `messages` 字段用 `Annotated[list, add_messages]`（自动追加+去重）
- [ ] State 不包含大型数据对象（应存文件/DB，State 只存引用）
- [ ] State 字段数 < 15（过多 → 设计问题）
- [ ] 敏感数据不在 State 中（会被 checkpoint 持久化）

**正确示例：**

```python
from typing import Annotated, TypedDict
from langgraph.graph.message import add_messages

class AgentState(TypedDict):
    messages: Annotated[list, add_messages]  # 对话历史（自动追加）
    current_task: str                         # 当前任务描述
    research_results: list[str]               # 研究结果（append reducer）
    plan: list[str]                           # 执行计划
    final_output: str | None                  # 最终输出
```

**反模式：State 膨胀**

```python
# BAD: State 中存储大量原始数据
class BadState(TypedDict):
    messages: list
    full_document_text: str          # 100KB+ 文本 → checkpoint 爆炸
    all_search_results: list[dict]   # 可能有 MB 级数据
    intermediate_analysis: dict      # 嵌套复杂对象

# GOOD: State 存引用，数据存外部
class GoodState(TypedDict):
    messages: Annotated[list, add_messages]
    document_path: str               # 文件路径引用
    search_summary: str              # 摘要而非原始结果
    analysis_ref: str                # 引用 ID
```

### 3. Node Design

**检查清单：**

- [ ] 每个 node 职责单一（1 个 node = 1 个步骤）
- [ ] Node 函数接收 State 返回 partial State update（不返回完整 State）
- [ ] Side effects（API 调用、DB 写入）有错误处理
- [ ] LLM 调用节点用 `bind_tools()` 绑定工具
- [ ] ToolNode 用于自动执行工具调用（不要手动 dispatch）

**正确示例：**

```python
from langgraph.prebuilt import ToolNode, tools_condition

def research_node(state: AgentState) -> dict:
    """Research node: call LLM with research tools."""
    model = ChatOpenAI(model="gpt-4o").bind_tools(research_tools)
    response = model.invoke(state["messages"])
    return {"messages": [response]}  # partial update

def synthesize_node(state: AgentState) -> dict:
    """Synthesize research results into final output."""
    results = state["research_results"]
    model = ChatOpenAI(model="gpt-4o")
    summary = model.invoke(f"Synthesize: {results}")
    return {"final_output": summary.content}

# 工具执行节点（自动处理 tool_calls）
tool_node = ToolNode(research_tools)
```

### 4. Edge & Routing Design

**检查清单：**

- [ ] 条件边返回有限的节点名集合（不返回动态字符串）
- [ ] `tools_condition` 用于标准 "有 tool_call → ToolNode, 否则 → 下一步"
- [ ] 循环边有明确的终止条件（max iterations / state flag）
- [ ] 无孤立节点（每个节点至少有入边和出边）

**正确示例：**

```python
from langgraph.graph import StateGraph, START, END
from langgraph.prebuilt import tools_condition

graph = StateGraph(AgentState)
graph.add_node("research", research_node)
graph.add_node("tools", tool_node)
graph.add_node("synthesize", synthesize_node)

graph.add_edge(START, "research")
graph.add_conditional_edges("research", tools_condition)  # has tool_call → tools, else → synthesize
graph.add_edge("tools", "research")  # tool 结果回到 research 继续
graph.add_edge("synthesize", END)
```

**反模式：无限循环**

```python
# BAD: research ↔ tools 无终止条件
graph.add_conditional_edges("research", tools_condition)
graph.add_edge("tools", "research")  # 如果 LLM 一直调用 tools → 死循环

# FIX 1: 加 max iterations 检查
def route_after_research(state):
    last_msg = state["messages"][-1]
    if hasattr(last_msg, "tool_calls") and last_msg.tool_calls:
        if len(state["messages"]) > 20:  # 安全阀
            return "synthesize"  # 强制终止
        return "tools"
    return "synthesize"

# FIX 2: 用 RemainingSteps 感知剩余步数
from langgraph.managed import RemainingSteps

class State(TypedDict):
    messages: Annotated[list, add_messages]
    remaining_steps: RemainingSteps

def agent_node(state: State):
    if state["remaining_steps"] <= 2:
        return {"messages": [AIMessage(content="Approaching limit, wrapping up.")]}
    response = llm.invoke(state["messages"])
    return {"messages": [response]}
```

**动态扇出（Send API）：并行处理多个子任务**

```python
from langgraph.types import Send

def fan_out_analysis(state: State):
    """为每个股票创建独立的分析节点实例"""
    return [
        Send("analyze_stock", {"symbol": s, "messages": state["messages"]})
        for s in state["stock_list"]
    ]

builder.add_conditional_edges("planner", fan_out_analysis)
```

### 5. Human-in-the-Loop (HITL)

**检查清单：**

- [ ] 危险操作节点设置 `interrupt_before`
- [ ] interrupt 返回的值有明确的 schema
- [ ] 用 `Command(resume=value)` 恢复，不是重新执行
- [ ] interrupt 与 checkpointer 配合（必须有 checkpointer 才能 interrupt）
- [ ] UI/API 层处理 `GraphInterrupt` 异常

**正确示例：**

```python
from langgraph.types import interrupt, Command

def execute_trade(state: AgentState) -> dict:
    """Execute trade with human approval."""
    trade = state["proposed_trade"]

    # 暂停，等待人工审批
    approval = interrupt({
        "question": f"Approve trade: {trade}?",
        "options": ["approve", "reject", "modify"],
    })

    if approval["action"] == "approve":
        result = execute(trade)
        return {"messages": [AIMessage(content=f"Trade executed: {result}")]}
    elif approval["action"] == "reject":
        return {"messages": [AIMessage(content="Trade cancelled by user.")]}
    else:
        return {"proposed_trade": approval["modified_trade"]}

# 编译时启用 checkpointer（interrupt 必须）
graph = graph_builder.compile(
    checkpointer=MemorySaver(),
    interrupt_before=["execute_trade"],  # 或用 interrupt() 函数内联
)

# 恢复执行
graph.invoke(Command(resume={"action": "approve"}), config={"thread_id": "t1"})
```

### 6. Checkpointing & Memory

| Layer            | Scope         | Implementation                        | Use Case           |
| ---------------- | ------------- | ------------------------------------- | ------------------ |
| **Short-term**   | Thread-scoped | Checkpointer（自动存每个 super-step） | 单次对话内         |
| **Cross-thread** | User-scoped   | Store interface                       | 用户偏好、历史摘要 |
| **Long-term**    | Global        | External DB + Store                   | 知识库、学习记忆   |

**检查清单：**

- [ ] 开发用 MemorySaver，生产用 PostgresSaver/RedisSaver
- [ ] 跨会话记忆用 Store（不是把旧 thread 的 state 手动复制）
- [ ] Checkpoint 数据量可控（State 不存大对象）
- [ ] 清理策略：旧 thread checkpoint 有 TTL/清理机制

**正确示例：**

```python
from langgraph.checkpoint.memory import MemorySaver
from langgraph.store.memory import InMemoryStore

# Short-term: checkpointer
checkpointer = MemorySaver()  # 生产换 PostgresSaver

# Long-term: store
store = InMemoryStore()  # 生产换持久化 Store

graph = graph_builder.compile(
    checkpointer=checkpointer,
    store=store,
)

# 同 thread 恢复（短期记忆）
result = graph.invoke(input, config={"thread_id": "user-123-session-1"})

# 跨 thread 读写（长期记忆）
store.put(("user", "123"), "preferences", {"risk_tolerance": "high"})
prefs = store.get(("user", "123"), "preferences")
```

### 7. Subgraph Design

**检查清单：**

- [ ] 子图有独立的 State schema（不共享父图全部字段）
- [ ] 父图 ↔ 子图的 State 映射明确（input/output transformation）
- [ ] 子图可独立测试（compile + invoke）
- [ ] 子图 checkpointing 与父图一致

**正确示例：**

```python
# 子图：独立的 research agent
class ResearchState(TypedDict):
    messages: Annotated[list, add_messages]
    findings: list[str]

research_graph = StateGraph(ResearchState)
research_graph.add_node("search", search_node)
research_graph.add_node("analyze", analyze_node)
# ... edges ...
compiled_research = research_graph.compile()

# 父图：嵌入子图
class MainState(TypedDict):
    messages: Annotated[list, add_messages]
    research_results: list[str]
    final_report: str

main_graph = StateGraph(MainState)
main_graph.add_node("research", compiled_research)  # 子图作为节点
main_graph.add_node("write_report", write_report_node)
main_graph.add_edge(START, "research")
main_graph.add_edge("research", "write_report")
main_graph.add_edge("write_report", END)
```

### 8. Streaming

**检查清单：**

- [ ] 生产环境用 `stream_mode="events"`（最细粒度）
- [ ] 自定义事件用 `dispatch_custom_event()` 发送
- [ ] 流式输出处理 LLM token-by-token + tool 调用事件
- [ ] 子图事件可通过 parent namespace 过滤

**5 种 stream_mode：**

| Mode       | 内容                | 场景       |
| ---------- | ------------------- | ---------- |
| `values`   | 每步完整 state 快照 | 调试       |
| `updates`  | 仅 delta 变更       | 仪表盘     |
| `messages` | LLM 逐 token        | 聊天 UI    |
| `custom`   | 节点主动 emit 事件  | 长任务进度 |
| `debug`    | 完整 trace          | 开发       |

**正确示例：**

```python
# 基础流式
for chunk in graph.stream(input, stream_mode="updates"):
    print(chunk)

# 组合模式
for chunk in graph.stream(input, stream_mode=["messages", "updates"]):
    print(chunk)

# 自定义事件（StreamWriter）
from langgraph.types import StreamWriter

def long_analysis(state: State, writer: StreamWriter):
    for i, stock in enumerate(state["stocks"]):
        writer.write({"type": "progress", "stock": stock, "pct": (i+1)/len(state["stocks"])*100})
        analyze(stock)
    return {"result": "done"}

# astream_events（最细粒度）
async for event in graph.astream_events(input, config, version="v2"):
    kind = event["event"]
    if kind == "on_chat_model_stream":
        print(event["data"]["chunk"].content, end="")
    elif kind == "on_tool_start":
        print(f"\n[Tool: {event['name']}]")
    elif kind == "on_custom_event":
        print(f"[Custom: {event['data']}]")
```

### 9. Supervisor Pattern (Most Common)

**使用 `langgraph-supervisor` 库简化：**

```python
from langgraph_supervisor import create_supervisor

# 定义 worker agents（各自是独立的 compiled graph 或 function）
research_agent = create_react_agent(model, research_tools, name="researcher")
writer_agent = create_react_agent(model, writing_tools, name="writer")

# 创建 supervisor
supervisor = create_supervisor(
    agents=[research_agent, writer_agent],
    model=ChatOpenAI(model="gpt-4o"),
    prompt="You coordinate research and writing tasks. Delegate appropriately.",
)

compiled = supervisor.compile(checkpointer=MemorySaver())
result = compiled.invoke({"messages": [HumanMessage("Write a report on AI trends")]})
```

### 10. DeepAgent Pattern

**检查清单（使用 deepagents 库时）：**

- [ ] 用 `create_deep_agent()` 而非手写全部 graph
- [ ] 利用内置 `write_todos` 做任务分解
- [ ] 子 agent 用 `task` tool 委派（独立 context window）
- [ ] 启用 auto-summarization（长对话自动摘要）
- [ ] Provider 选择合理（Claude for complex, GPT for speed）

**正确示例：**

```python
from deepagents import create_deep_agent

agent = create_deep_agent(
    model="claude-sonnet-4-6",     # 或 "gpt-4o"
    tools=[custom_tool_1, custom_tool_2],  # 追加自定义工具
    system_prompt="You are a financial analyst...",
    checkpointer=PostgresSaver(...),
)

# 流式执行
async for event in agent.astream(
    {"messages": [HumanMessage("Analyze AAPL earnings")]},
    config={"thread_id": "analysis-001"},
):
    print(event)
```

---

## Anti-Pattern Catalog

### AP-1: State Explosion

```
WRONG: State 有 30+ 字段，含嵌套 dict 和大型 list
RIGHT: State < 15 字段，大数据存外部（文件/DB），State 存引用
```

### AP-2: Infinite Loop

```
WRONG: Node A → Node B → Node A 无终止条件
RIGHT: 条件边 + max iteration counter in state
       或 使用 recursion_limit=N 编译参数
```

### AP-3: Missing Checkpointer

```
WRONG: graph.compile() 无 checkpointer → interrupt 不可用、无法恢复
RIGHT: 开发用 MemorySaver()，生产用 PostgresSaver()
```

### AP-4: Monolithic Node

```
WRONG: 单个 node 做 LLM 调用 + 工具执行 + 结果处理
RIGHT: LLM node → ToolNode → result processing node（职责分离）
```

### AP-5: Ignoring Reducers

```
WRONG: messages 字段无 reducer → 每次写入覆盖全部历史
RIGHT: Annotated[list, add_messages] — 自动追加 + 去重

WRONG: research_results 用默认 reducer → 只保留最后一次结果
RIGHT: Annotated[list[str], operator.add] — 累积追加
```

### AP-6: Checkpoint Without Cleanup

```
WRONG: PostgresSaver 运行 6 个月，checkpoint 表 100GB+
RIGHT: 定期清理旧 thread 的 checkpoint（TTL 或 cron job）
```

### AP-7: Subgraph State Leak

```
WRONG: 子图直接共享父图 State（子图修改污染父图）
RIGHT: 子图有独立 State schema，通过 input/output mapping 交互
```

### AP-8: No recursion_limit

```
WRONG: graph.compile() 无 recursion_limit → 复杂图可能递归到栈溢出
RIGHT: graph.compile(checkpointer=..., recursion_limit=50)
```

### AP-9: Sync in Async Context

```
WRONG: 在 async graph 中用 graph.invoke()（blocking）
RIGHT: 用 await graph.ainvoke() 或 async for event in graph.astream()
```

### AP-10: State Messages Unbounded Growth

```
WRONG: add_messages reducer append-only，循环 agent 消息列表无限膨胀 → OOM
RIGHT: 定期用 trim_messages 截断，或每 N 步做 summary 压缩

from langchain_core.messages import trim_messages, RemoveMessage

def agent(state):
    trimmed = trim_messages(state["messages"], max_tokens=4000)
    response = llm.invoke(trimmed)
    return {"messages": [response]}
```

---

## Output Template

When reviewing a LangGraph agent design, produce this structured report:

```markdown
## Agent Design Review — [Agent Name]

### Summary

[1-2 sentences: what the agent does, overall assessment]

### Architecture Score: X/10

| Dimension         | Score    | Notes |
| ----------------- | -------- | ----- |
| Pattern Selection | ✅/⚠️/❌ | ...   |
| State Schema      | ✅/⚠️/❌ | ...   |
| Node Design       | ✅/⚠️/❌ | ...   |
| Edge & Routing    | ✅/⚠️/❌ | ...   |
| HITL              | ✅/⚠️/❌ | ...   |
| Checkpointing     | ✅/⚠️/❌ | ...   |
| Subgraph          | ✅/⚠️/❌ | ...   |
| Streaming         | ✅/⚠️/❌ | ...   |
| Supervisor/Swarm  | ✅/⚠️/❌ | ...   |
| DeepAgent Usage   | ✅/⚠️/❌ | ...   |

### Graph Topology

[Text diagram: START → node_a → [condition] → node_b / node_c → END]

### Critical Issues (must fix)

1. [Issue + specific fix with code]

### Improvements (should fix)

1. [Issue + specific fix with code]

### Recommended State Schema

[Code: TypedDict with proper reducers]

### Recommended Graph

[Code: complete graph definition]
```

---

## Data Notes

- **LangGraph**: Python-first (`langgraph`), JS 版本 (`@langchain/langgraph`) 功能略滞后
- **DeepAgent**: `deepagents` 库，MIT 开源，基于 LangGraph 运行时
- **Checkpointer**: 生产必须用持久化（Postgres/Redis），MemorySaver 仅限开发
- **LangSmith**: 官方 observability 平台，LangGraph 原生集成
- **recursion_limit**: 默认 25（太低可能截断复杂图）
- **State 大小**: 直接影响 checkpoint 存储和恢复速度，务必控制
- **成本**: LangGraph 本身免费，LangGraph Cloud 按调用计费

## Response Guidelines

### Review 输出格式

- 用上述 Output Template 结构化输出
- 必须包含 **Graph Topology** 文字图
- 必须包含 **State Schema** 代码建议
- 反模式用 `AP-N` 编号引用

### 代码示例

- Python 为主（LangGraph 的 primary target）
- 包含完整 import（`from langgraph.graph import StateGraph, START, END`）
- State 用 TypedDict + Annotated reducers

### 必须包含

- 架构评分（X/10）
- Graph topology diagram
- State schema review
- 至少 1 个 Critical Issue 或明确 "No critical issues"
- Checkpointer 选型建议
