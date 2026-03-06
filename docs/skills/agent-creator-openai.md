---
name: agent-creator-openai
description: "Review & guide building production-grade OpenAI Agent SDK agents. Use when: user designs/reviews/debugs OpenAI agents, handoff orchestration, guardrails, Runner loops, structured output, voice agents. NOT for: Claude agents (use agent-creator-claude), LangGraph agents (use agent-creator-langgraph), raw OpenAI API chat completions without agent framework."
metadata: { "openclaw": { "emoji": "🤖", "requires": { "extensions": [] } } }
---

# OpenAI Agent SDK — Agent Creator & Reviewer

Review, design, and guide the construction of production-grade agents using the **OpenAI Agent SDK** (`openai-agents`). This skill acts as a senior agent architect: it evaluates agent designs against best practices, identifies anti-patterns, and produces actionable improvement plans.

## When to Use

- "Review my OpenAI agent architecture" / "帮我审查 OpenAI agent 设计"
- "Design a multi-agent handoff system" / "设计多 agent handoff 系统"
- "How to set up guardrails for input/output?" / "怎么设置输入输出 guardrail"
- "My agent keeps handing off in circles" / "agent handoff 死循环了"
- "Should I use handoff or agent-as-tool?" / "该用 handoff 还是 agent-as-tool"
- "Set up tracing for my agent workflow" / "怎么设置 agent 可观测性"
- "Build a voice agent with realtime API" / "用 Realtime API 构建语音 agent"

## When NOT to Use

- Claude Agent SDK (MCP/hooks/subagent) → use `/agent-creator-claude`
- LangGraph / DeepAgent (StateGraph/Supervisor/Swarm) → use `/agent-creator-langgraph`
- 纯 OpenAI Chat Completions（无 SDK）→ 直接参考 OpenAI API 文档
- 非 agent 场景的 prompt engineering → 不需要此 skill

---

## Architecture Reference

### Core Primitives (5 个)

```
OpenAI Agent SDK
├── Agent                          # 核心单元：name + instructions + tools + handoffs
│   ├── name: str                  # 人类可读名称
│   ├── instructions: str|Callable # 系统提示（静态或动态）
│   ├── model: str                 # 模型选择（gpt-4o, gpt-4o-mini, o3-mini 等）
│   ├── tools: list[Tool]          # 工具列表
│   ├── handoffs: list[Handoff]    # 可委派的 agent 列表
│   ├── output_type: Type          # 结构化输出（Pydantic model）
│   ├── input_guardrails: list     # 输入校验
│   ├── output_guardrails: list    # 输出校验
│   └── model_settings: ModelSettings  # temperature, top_p, tool_choice
│
├── Runner                         # 执行引擎
│   ├── run()                      # async 执行
│   ├── run_sync()                 # 同步执行
│   └── run_streamed()             # 流式执行
│
├── Handoff                        # Agent 间委派
│   ├── target: Agent              # 目标 agent
│   ├── tool_name: str             # 自动生成: transfer_to_{name}
│   └── input_filter: Callable     # 可选：过滤传递的上下文
│
├── Guardrail                      # 安全校验
│   ├── InputGuardrail             # 输入检查（首个 agent）
│   ├── OutputGuardrail            # 输出检查（最终 agent）
│   └── tripwire_or_fail           # 触发时中断 or 返回错误
│
└── Tool                           # 工具类型
    ├── FunctionTool               # Python 函数 → 自动 schema
    ├── HostedTool                  # OpenAI 托管（WebSearch/FileSearch/CodeInterpreter）
    ├── HostedMCPTool              # 远程 MCP server（OpenAI 侧调用）
    └── MCPServerTool              # 本地 MCP server（client 侧调用）
```

### Runner Loop (核心执行流)

```
Runner.run(agent, messages) →
  Loop:
  ├── 1. Call LLM (agent.model + agent.instructions + messages)
  ├── 2. Response has final output?
  │   └── YES → Return RunResult (apply output_guardrails first)
  ├── 3. Response has handoff?
  │   └── YES → Switch agent = handoff.target, loop continues
  ├── 4. Response has tool calls?
  │   └── YES → Execute tools, append results, loop continues
  └── 5. Max turns exceeded?
      └── YES → Raise MaxTurnsExceeded
```

### Tool Categories

| Category          | Where Runs     | Example                                                                 | Latency             |
| ----------------- | -------------- | ----------------------------------------------------------------------- | ------------------- |
| **FunctionTool**  | Your process   | Any Python function                                                     | Depends on impl     |
| **HostedTool**    | OpenAI servers | WebSearchTool, FileSearchTool, CodeInterpreterTool, ImageGenerationTool | Low (no round-trip) |
| **HostedMCPTool** | OpenAI servers | Remote MCP server via OpenAI proxy                                      | Medium              |
| **MCPServerTool** | Your process   | Local/remote MCP server (client-side)                                   | Medium-High         |
| **ComputerTool**  | Your process   | Browser/desktop automation                                              | High                |

### Two Multi-Agent Patterns

| Pattern           | Control Flow                       | Best For                 |
| ----------------- | ---------------------------------- | ------------------------ |
| **Handoff**       | Agent A → Agent B (转移控制权)     | 对话式，agent 间自主路由 |
| **Agent-as-Tool** | Agent A calls Agent B (保持控制权) | Pipeline 式，中央协调器  |

---

## Agent Design Review Pattern

Review any OpenAI agent design by walking through these 8 dimensions in order.

### 1. Handoff vs Agent-as-Tool Decision

**先问：用哪种多 agent 模式？**

```
Decision Tree:
├── Agent 间需要自主决定路由？（对话式客服、FAQ）
│   └── YES → Handoff pattern
│   └── 特征：每个 agent 知道其他 agent，自行决定何时转交
│
├── 需要中央协调器控制全局流程？
│   └── YES → Agent-as-Tool pattern
│   └── 特征：主 agent 调用子 agent 如工具，保持单一对话线程
│
├── 混合场景？
│   └── 主 agent 用 agent-as-tool 调用功能性子 agent
│       子 agent 间用 handoff 处理相似领域路由
│
└── 单一任务？
    └── 单 agent + tools（不需要多 agent）
```

- **反模式 (Handoff)**: 超过 5 个 agent 互相 handoff → 路由混乱
- **反模式 (Agent-as-Tool)**: 子 agent 需要看到完整对话历史 → 应该用 handoff

### 2. Agent Instructions Quality

**检查清单：**

- [ ] instructions 精确描述角色和能力边界
- [ ] 包含 "何时 handoff 给谁" 的明确规则
- [ ] 动态 instructions 用 `Callable[[RunContextWrapper], str]` 注入上下文
- [ ] 长度适中（不超过 1500 tokens）
- [ ] 避免与 tool descriptions 重复

**正确示例：**

```python
Agent(
    name="Order Support",
    instructions="""You handle order-related queries: tracking, modifications, cancellations.
For refund requests → handoff to Refund Agent.
For technical issues → handoff to Tech Support.
Always verify order ID before taking action.""",
    handoffs=[refund_agent, tech_agent],
    tools=[lookup_order, modify_order, cancel_order],
)
```

**动态 instructions（注入用户上下文）：**

```python
def dynamic_instructions(ctx: RunContextWrapper[UserContext]) -> str:
    user = ctx.context
    return f"""You are helping {user.name} (tier: {user.tier}).
Premium users get priority handling.
Current order count: {user.order_count}."""

Agent(name="Support", instructions=dynamic_instructions, ...)
```

### 3. Tool Binding Audit

| Check                    | Pass Criteria                                                     |
| ------------------------ | ----------------------------------------------------------------- |
| **Function 自动 schema** | 函数有 type hints + docstring（SDK 自动推断）                     |
| **Pydantic 参数**        | 复杂参数用 Pydantic model（非 dict）                              |
| **Hosted 优先**          | 搜索/代码执行用 HostedTool（免 round-trip）                       |
| **MCP 选择**             | 远程 MCP 优先 HostedMCPTool（OpenAI 侧调用，少一轮网络）          |
| **工具命名**             | 函数名即工具名 — 用清晰动词+名词（`search_orders` 非 `do_stuff`） |
| **Docstring**            | 即 tool description — 必须说清楚 Use when / NOT for               |
| **幂等标注**             | 写操作函数标注是否幂等                                            |

**正确示例（@function_tool 装饰器）：**

```python
from agents import function_tool
from pydantic import BaseModel

class OrderQuery(BaseModel):
    """Query parameters for order lookup."""
    order_id: str
    include_history: bool = False

@function_tool
async def lookup_order(query: OrderQuery) -> str:
    """Look up order details by order ID.
    Use when: user asks about order status, tracking, delivery.
    NOT for: refund processing (handled by refund agent)."""
    order = await db.get_order(query.order_id)
    return order.to_summary()
```

SDK 自动从函数名 → tool name、docstring → description、type hints → JSON Schema。

**反模式：**

```python
# BAD: 无 type hint，无 docstring → SDK 无法生成 schema
def process(data):
    return do_something(data)
```

### 4. Guardrail Design

**三种 Guardrail 类型：**

| Type              | Runs When                 | Scope        |
| ----------------- | ------------------------- | ------------ |
| `InputGuardrail`  | 首个 agent 接收输入时     | 仅首个 agent |
| `OutputGuardrail` | 最终 agent 产出结果时     | 仅最终 agent |
| Tool guardrail    | 每次 function tool 调用时 | 每个工具     |

**检查清单：**

- [ ] 有 InputGuardrail 检查恶意/off-topic 输入
- [ ] 输入 guardrail 用轻量模型（gpt-4o-mini）不拖慢主流程
- [ ] guardrail 与主 agent 并行执行（SDK 自动处理）
- [ ] tripwire 行为明确：`tripwire_or_fail` 选择 tripwire（中断）还是 fail（错误）
- [ ] OutputGuardrail 检查敏感信息泄露 / 格式合规

**正确示例：**

```python
from agents import InputGuardrail, GuardrailFunctionOutput, Agent, Runner

# 用轻量模型做输入检测
guardrail_agent = Agent(
    name="Input Checker",
    model="gpt-4o-mini",
    instructions="Check if input is a legitimate customer support query. Output True/False.",
    output_type=bool,
)

async def check_input(ctx, agent, input_data):
    result = await Runner.run(guardrail_agent, input_data, context=ctx.context)
    return GuardrailFunctionOutput(
        output_info={"is_valid": result.final_output},
        tripwire_triggered=not result.final_output,
    )

main_agent = Agent(
    name="Support",
    model="gpt-4o",
    input_guardrails=[InputGuardrail(guardrail_function=check_input)],
    ...
)
```

### 5. Handoff Architecture (if multi-agent)

**检查清单：**

- [ ] Handoff 目标 agent 的 `name` 清晰（生成 `transfer_to_{name}` 工具名）
- [ ] 不存在 A→B→A 循环 handoff（除非有明确的回退语义）
- [ ] `input_filter` 过滤敏感上下文（handoff 时不传递所有历史）
- [ ] Handoff 数量 < 5 per agent（太多 → LLM 路由困难）
- [ ] 每个 handoff 目标 agent 都有 "何时该把我 handoff 回去" 的 instructions

**正确架构示例：**

```python
triage = Agent(
    name="Triage",
    instructions="Route to the right specialist. Ask clarifying questions if unclear.",
    handoffs=[order_agent, billing_agent, tech_agent],
)

order_agent = Agent(
    name="Order Support",
    instructions="Handle orders. For billing → handoff to Billing. For unknown → handoff to Triage.",
    handoffs=[billing_agent, triage],
    tools=[lookup_order, modify_order],
)

billing_agent = Agent(
    name="Billing",
    instructions="Handle billing. For orders → handoff to Order Support.",
    handoffs=[order_agent, triage],
    tools=[get_invoice, process_refund],
)
```

**反模式：环形 Handoff**

```python
# BAD: A→B→C→A 无终止条件
agent_a = Agent(handoffs=[agent_b])
agent_b = Agent(handoffs=[agent_c])
agent_c = Agent(handoffs=[agent_a])  # 可能无限循环
# FIX: 确保至少一个 agent 能产出 final output 终止
```

### 6. Structured Output

**检查清单：**

- [ ] 最终输出有 `output_type`（Pydantic model / dataclass）
- [ ] 中间 agent 如果不需要结构化 → 不设 output_type（自由文本更灵活）
- [ ] Guardrail agent 用简单 output_type（`bool` / `Literal`）
- [ ] output_type 字段有 description（帮助 LLM 填充）

**正确示例：**

```python
from pydantic import BaseModel, Field

class SupportResponse(BaseModel):
    """Final support response to customer."""
    answer: str = Field(description="Direct answer to customer query")
    action_taken: str | None = Field(description="Action performed, if any")
    follow_up_needed: bool = Field(description="Whether customer needs follow-up")
    confidence: float = Field(ge=0, le=1, description="Confidence in response")

final_agent = Agent(
    name="Response Generator",
    output_type=SupportResponse,
    ...
)
```

### 7. Tracing & Observability

**检查清单：**

- [ ] Tracing 已启用（默认开启，检查未被禁用）
- [ ] 自定义 span 用于关键业务逻辑
- [ ] 敏感数据在 trace 中脱敏
- [ ] 生产环境配置 trace 导出目标（Logfire/Braintrust/custom）

**正确示例：**

```python
from agents import trace, custom_span

# 自动 tracing（默认开启）
result = await Runner.run(agent, messages)

# 自定义 span
with custom_span("order_processing"):
    order = await process_order(order_id)
    # span 自动记录耗时和结果

# 嵌套 trace
with trace("customer_support_flow"):
    result = await Runner.run(triage_agent, user_message)
```

### 8. State & Multi-Turn Management

**检查清单：**

- [ ] 多轮对话用 `result.to_input_list()` 拼接历史（SDK 本身无状态）
- [ ] 共享状态用 `RunContext` 依赖注入（不要塞进 instructions）
- [ ] Tool 函数第一个参数为 `RunContextWrapper[T]` 时自动注入 context

**正确示例（多轮对话）：**

```python
# 第一轮
result1 = await Runner.run(agent, "分析茅台")

# 第二轮 — 拼接前一轮 items 实现连续对话
result2 = await Runner.run(agent, result1.to_input_list() + [
    {"role": "user", "content": "那五粮液呢？"}
])
```

**正确示例（RunContext 依赖注入）：**

```python
from dataclasses import dataclass
from agents import RunContextWrapper, function_tool

@dataclass
class UserContext:
    user_id: str
    risk_level: int = 3

@function_tool
async def check_portfolio(ctx: RunContextWrapper[UserContext], symbol: str) -> str:
    """检查用户持仓。ctx 由 SDK 自动注入。"""
    user = ctx.context  # 类型安全
    return f"User {user.user_id} portfolio for {symbol}"

# 执行时传入 context
result = await Runner.run(agent, "查看持仓", context=UserContext(user_id="u123"))
```

### 9. Cost & Performance Optimization

| Strategy                | Impact                | How                                                       |
| ----------------------- | --------------------- | --------------------------------------------------------- |
| **Model routing**       | 3-10x cost reduction  | gpt-4o-mini for triage/guardrails, gpt-4o for specialists |
| **Hosted tools**        | 50% latency reduction | WebSearchTool > custom search function                    |
| **HostedMCPTool**       | 30% latency reduction | OpenAI-side MCP > client-side MCP                         |
| **input_filter**        | Context saving        | 过滤 handoff 时不必要的历史消息                           |
| **max_turns**           | Cost cap              | Runner.run(max_turns=10) 防止无限循环                     |
| **output_type**         | Token saving          | 结构化输出比自由文本更简洁                                |
| **Parallel guardrails** | Latency hiding        | 输入 guardrail 与 LLM 调用并行                            |

---

## Anti-Pattern Catalog

### AP-1: Handoff Spaghetti

```
WRONG: 8 agents 互相 handoff，每个 agent 有 5+ handoff targets
RIGHT: Triage agent (hub) → 3-4 specialist agents (spokes)
       Specialists 只能 handoff 回 Triage 或相邻 specialist
```

### AP-2: Missing Guardrails

```
WRONG: 直接信任用户输入，无 InputGuardrail
RIGHT: 轻量 gpt-4o-mini guardrail agent 做前置检查
       tripwire 触发时返回标准拒绝消息
```

### AP-3: No output_type on Final Agent

```
WRONG: 最终 agent 返回自由文本 → 下游无法可靠解析
RIGHT: output_type=ResponseModel 强制结构化输出
```

### AP-4: Heavy Model for Guardrails

```
WRONG: guardrail_agent 用 gpt-4o (贵且慢)
RIGHT: guardrail_agent 用 gpt-4o-mini (便宜且快)
       guardrail 与主 agent 并行执行，不增加延迟
```

### AP-5: No max_turns

```
WRONG: Runner.run(agent, messages) — 无限循环风险
RIGHT: Runner.run(agent, messages, max_turns=15)
       + 在 instructions 中告诉 agent "如果 5 轮内无法解决，请总结并结束"
```

### AP-6: Agent-as-Tool When Handoff Needed

```
WRONG: 子 agent 需要对话式交互但被当作 tool 调用（只返回单次结果）
RIGHT: 需要对话式场景 → 用 Handoff（保持对话上下文）
       需要单次计算 → 用 Agent-as-Tool
```

### AP-7: Ignoring input_filter on Handoff

```
WRONG: Handoff 传递完整对话历史（含敏感信息 / 大量 token）
RIGHT: input_filter 只传递相关上下文
```

```python
def filter_for_billing(messages):
    """Only pass billing-relevant messages."""
    return [m for m in messages if "billing" in m.content.lower() or "invoice" in m.content.lower()]

Handoff(target=billing_agent, input_filter=filter_for_billing)
```

---

## Voice Agent Extension

OpenAI Agent SDK 支持 Realtime agents（语音 agent），review 时额外检查：

| Check               | Criteria                                         |
| ------------------- | ------------------------------------------------ |
| **RealtimeSession** | 本地维护对话历史，自动同步 transport             |
| **中断检测**        | 启用自动中断（用户打断时停止输出）               |
| **Guardrail**       | 语音 agent 同样需要 InputGuardrail               |
| **Handoff**         | 语音 agent 可 handoff 到文本 agent（模态切换）   |
| **延迟**            | 语音场景对延迟极敏感 → 用最快模型 + hosted tools |

---

## Output Template

When reviewing an OpenAI agent design, produce this structured report:

```markdown
## Agent Design Review — [Agent Name]

### Summary

[1-2 sentences: what the agent does, overall assessment]

### Architecture Score: X/9

| Dimension         | Score    | Notes |
| ----------------- | -------- | ----- |
| Handoff vs Tool   | ✅/⚠️/❌ | ...   |
| Instructions      | ✅/⚠️/❌ | ...   |
| Tool Binding      | ✅/⚠️/❌ | ...   |
| Guardrails        | ✅/⚠️/❌ | ...   |
| Handoff Design    | ✅/⚠️/❌ | ...   |
| Structured Output | ✅/⚠️/❌ | ...   |
| State Management  | ✅/⚠️/❌ | ...   |
| Tracing           | ✅/⚠️/❌ | ...   |
| Cost Optimization | ✅/⚠️/❌ | ...   |

### Critical Issues (must fix)

1. [Issue + specific fix with code]

### Improvements (should fix)

1. [Issue + specific fix with code]

### Recommended Architecture

[Code snippet showing improved agent definitions]
```

---

## Data Notes

- **OpenAI Agent SDK**: Python (`openai-agents`) + JS/TS (`@openai/agents`)
- **Provider agnostic**: 支持 OpenAI + 100+ LLM providers（通过 Chat Completions 适配）
- **Tracing**: 默认开启，支持 Logfire/AgentOps/Braintrust 等
- **Hosted tools**: 仅 OpenAI models 支持（第三方 provider 不支持）
- **HostedMCPTool**: 需要 Responses API（不是 Chat Completions）
- **Voice agents**: 需要 Realtime API 访问权限
- **成本**: gpt-4o ~$2.5/M input, gpt-4o-mini ~$0.15/M input（2026.03）

## Response Guidelines

### Review 输出格式

- 用上述 Output Template 结构化输出
- 每个问题附带具体代码修复建议（Python 示例优先，JS 备注差异）
- 反模式用 `AP-N` 编号引用

### 代码示例

- Python 为主（SDK 的 primary target）
- 包含完整 import 和 type annotation
- Pydantic model 用于 output_type 和复杂工具参数

### 必须包含

- 架构评分（X/8）
- Handoff 拓扑图（文字描述 agent 间关系）
- 至少 1 个 Critical Issue 或明确 "No critical issues"
- 成本估算提示（模型选择 × agent 数量）
