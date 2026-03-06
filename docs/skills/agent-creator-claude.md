---
name: agent-creator-claude
description: "Review & guide building production-grade Claude Agent SDK agents. Use when: user designs/reviews/debugs Claude agents, subagent orchestration, MCP tool binding, hook-based control flow. NOT for: OpenAI agents (use agent-creator-openai), LangGraph agents (use agent-creator-langgraph), generic LLM prompting without agent framework."
metadata: { "openclaw": { "emoji": "🏗️", "requires": { "extensions": [] } } }
---

# Claude Agent SDK — Agent Creator & Reviewer

Review, design, and guide the construction of production-grade agents using the **Anthropic Claude Agent SDK** (`claude_agent_sdk`). This skill acts as a senior agent architect: it evaluates agent designs against best practices, identifies anti-patterns, and produces actionable improvement plans.

## When to Use

- "Review my Claude agent architecture" / "帮我审查 Claude agent 设计"
- "Design a multi-agent system with Claude SDK" / "用 Claude SDK 设计多 agent 系统"
- "How should I bind MCP tools to my agent?" / "MCP 工具怎么绑定到 agent"
- "My agent keeps looping / using wrong tools" / "agent 一直循环调用错误工具"
- "Should I use subagents or a single agent?" / "该用子 agent 还是单 agent"
- "Set up hooks for approval workflow" / "怎么设置审批钩子"
- "Optimize my agent's context window usage" / "优化 agent 上下文窗口占用"

## When NOT to Use

- OpenAI Agent SDK (function/handoff/guardrail) → use `/agent-creator-openai`
- LangGraph / DeepAgent (StateGraph/Supervisor/Swarm) → use `/agent-creator-langgraph`
- 纯 Claude API tool_use（无 SDK）→ 直接参考 Anthropic tool_use 文档
- Prompt engineering without agent framework → 不需要此 skill

---

## Architecture Reference

### Core Abstractions

```
Claude Agent SDK
├── query()                    # 单次会话（async generator → SDKMessage stream）
├── ClaudeSDKClient            # 连续对话（多轮 session 管理）
├── ClaudeAgentOptions         # 配置层（模型/权限/hooks/MCP）
│   ├── model                  # claude-sonnet-4-6 | claude-opus-4-6 | claude-haiku-4-5
│   ├── allowed_tools          # 工具白名单（内置 + MCP）
│   ├── agents                 # Subagent 定义（Dict[str, AgentDefinition]）
│   ├── mcp_servers            # MCP server 配置（stdio/HTTP/SSE/in-process）
│   ├── hooks                  # 生命周期钩子（PreToolUse/PostToolUse/Stop）
│   ├── system_prompt          # 自定义系统提示词（追加模式）
│   └── resume                 # Session ID（恢复会话）
├── AgentDefinition            # 子 agent 定义
│   ├── description            # 路由描述（Claude 据此决定何时委派）
│   ├── prompt                 # 子 agent 系统提示
│   ├── tools                  # 子 agent 工具白名单
│   └── model                  # 可覆盖模型
└── SDKMessage                 # 消息流类型
    ├── SystemMessage          # init 消息（工具列表/MCP 状态）
    ├── AssistantMessage       # Claude 回复（含 tool_use blocks）
    ├── ToolResultMessage      # 工具执行结果
    ├── ResultMessage          # 最终结果（success/error）
    └── UserMessage            # 用户输入
```

### Three-Layer Tool System

| Layer                        | Type                                                   | Overhead    | When to Use                         |
| ---------------------------- | ------------------------------------------------------ | ----------- | ----------------------------------- |
| **L1: Built-in**             | Read/Write/Edit/Bash/Grep/Glob/WebSearch/WebFetch/Task | Zero        | 文件操作、搜索、shell 执行          |
| **L2: SDK MCP (in-process)** | `create_sdk_mcp_server()` + `@tool` decorator          | Minimal     | 自定义业务逻辑，无 IPC 开销         |
| **L3: External MCP**         | stdio / HTTP / SSE servers                             | IPC/Network | 第三方服务、跨语言、已有 MCP server |

### Hook System (Control Flow)

| Hook               | Trigger               | Can Do                                   | Use Case                   |
| ------------------ | --------------------- | ---------------------------------------- | -------------------------- |
| `PreToolUse`       | Before tool execution | allow / deny / ask_user / inject_context | 权限控制、参数验证、审批   |
| `PostToolUse`      | After tool execution  | inject_context / modify_result           | 日志、结果增强、链式触发   |
| `Stop`             | Agent wants to stop   | continue / force_stop                    | 防止提前停止、追加验证步骤 |
| `NotificationHook` | Status changes        | log / alert                              | 监控、通知                 |

---

## Agent Design Review Pattern

Review any Claude agent design by walking through these 8 dimensions in order.

### 1. Single vs Multi-Agent Decision

**先问：真的需要多个 agent 吗？**

```
Decision Tree:
├── 任务可用一个 system prompt + tools 完成？
│   └── YES → 单 agent（Claude 推理能力强，避免不必要拆分）
├── 需要不同权限隔离？（如 read-only reviewer vs read-write coder）
│   └── YES → Subagent（通过 tools 白名单隔离）
├── 需要并行处理独立子任务？
│   └── YES → Subagent（parallel Task calls）
└── 需要不同模型处理不同复杂度？
    └── YES → Subagent（Opus for complex, Haiku for simple）
```

- **反模式**: 为每个"职责"创建 subagent → 过度拆分，增加延迟和 token 消耗
- **正确做法**: 单 agent + 精准 system prompt + 工具路由 > 5 个浅 subagent

### 2. System Prompt Quality

**检查清单：**

- [ ] 角色定位清晰（1-2 句，不是一段话）
- [ ] 包含"何时使用哪个工具"的路由指令
- [ ] 包含"不要做什么"的负面约束
- [ ] 包含输出格式要求（结构化/表格/markdown）
- [ ] 避免空洞指令（"be helpful" 无意义）
- [ ] 长度 < 2000 tokens（越短越好，关键指令放前面）

**正确示例：**

```
You are a code security reviewer.
Use Read/Grep to examine code. Report findings as:
| Severity | File:Line | Issue | Fix |
Do NOT modify files. Do NOT run Bash commands.
Focus on OWASP Top 10 + dependency vulnerabilities.
```

**反模式：**

```
You are a helpful AI assistant that reviews code for security.
You should be thorough and careful. You can use various tools...
（太空泛，Claude 不知道优先做什么）
```

### 3. Tool Binding Audit

| Check               | Pass Criteria                                          |
| ------------------- | ------------------------------------------------------ |
| **最小权限**        | agent 只有它需要的工具（不要 `allowed_tools=["*"]`）   |
| **命名一致**        | MCP 工具用 `mcp__<server>__<tool>` 格式                |
| **in-process 优先** | 自定义工具用 SDK MCP（L2），除非需要跨进程             |
| **工具描述**        | 每个 `@tool` 的 description 足够让 Claude 判断何时使用 |
| **参数类型**        | 用 JSON Schema 或 Zod，不要 `Any`                      |
| **工具数量**        | < 20 个直接暴露；> 20 用 tool search 或分 subagent     |
| **幂等性**          | 写操作工具标注是否幂等（Claude 可能重试）              |

**反模式：工具描述不精确**

```python
# BAD: Claude 无法区分两个工具
@tool("get_data", "Get data from database", {...})
@tool("fetch_info", "Fetch information", {...})

# GOOD: 精确描述触发条件
@tool("get_user_profile", "Get user profile by user_id. Use when user asks about account details, settings, or personal info. NOT for transaction history (use get_transactions).", {...})
@tool("get_transactions", "Get transaction history by user_id and date range. Use for payment records, order history, refund status.", {...})
```

### 4. Subagent Architecture (if multi-agent)

**检查清单：**

- [ ] 主 agent 有 `Task` 在 `allowed_tools` 中
- [ ] 每个 subagent 的 `description` 足够精确（Claude 据此路由）
- [ ] subagent 工具严格最小化（read-only agent 不给 Write/Bash）
- [ ] subagent 不包含 `Task`（禁止嵌套）
- [ ] 为轻量任务指定 `model="haiku"`（节省成本）
- [ ] 并行独立任务用并行 Task 调用

**正确架构示例：**

```python
agents={
    "researcher": AgentDefinition(
        description="Research codebase structure, find files, read docs. Use for exploration tasks.",
        prompt="You are a codebase explorer. Read files, search patterns, summarize findings.",
        tools=["Read", "Grep", "Glob"],
        model="haiku"  # 轻量级探索
    ),
    "implementer": AgentDefinition(
        description="Write code, create files, run tests. Use after research is done.",
        prompt="You are a senior developer. Write clean, tested code.",
        tools=["Read", "Write", "Edit", "Bash", "Grep"],
        model="sonnet"  # 需要推理能力
    ),
    "reviewer": AgentDefinition(
        description="Review code changes for bugs, security, style. Use before finalizing.",
        prompt="You are a code reviewer. Check for OWASP Top 10, type safety, test coverage.",
        tools=["Read", "Grep", "Glob"],
        model="sonnet"
    ),
}
```

### 5. Hook Design (Control Flow)

**检查清单：**

- [ ] 危险操作（Bash, Write, 外部 API）有 PreToolUse hook
- [ ] 审批流不阻塞非危险工具（Read/Grep 不需要审批）
- [ ] PostToolUse 用于日志/审计，不用于修改核心逻辑
- [ ] Stop hook 用于防止遗漏验证步骤

**正确示例：**

```python
hooks=[
    # 只拦截危险操作
    HookDefinition(
        matcher=HookMatcher(tool_names=["Bash", "Write"]),
        callback=HookCallback(
            type="pre_tool_use",
            action="ask_user",  # 需要用户确认
            message="Agent wants to execute: {tool_input}"
        )
    ),
    # 审计日志
    HookDefinition(
        matcher=HookMatcher(tool_names=["*"]),
        callback=HookCallback(
            type="post_tool_use",
            action="inject_context",
            context="[AUDIT] Tool {tool_name} executed at {timestamp}"
        )
    ),
]
```

**反模式：**

```python
# BAD: 所有工具都要审批 → 用户疲劳，体验极差
hooks=[HookDefinition(
    matcher=HookMatcher(tool_names=["*"]),
    callback=HookCallback(type="pre_tool_use", action="ask_user", ...)
)]
```

### 6. Context Window Management

| Check             | Criteria                                          |
| ----------------- | ------------------------------------------------- |
| **MCP 工具数量**  | > 20 工具定义占 context 10%+ → 启用 tool search   |
| **Session 恢复**  | 长任务用 `resume=session_id` 而非重发全部历史     |
| **System prompt** | < 2000 tokens；冗长指令拆到 skill.md 或 CLAUDE.md |
| **工具结果**      | 大文件返回摘要而非全文（在 @tool 实现中截断）     |
| **Subagent 隔离** | 重查询任务委派给 subagent（独立 context）         |

### 7. Error Handling & Resilience

- [ ] MCP server 连接失败有 fallback（或清晰错误消息）
- [ ] Bash 工具有 timeout 设置
- [ ] 外部 API 工具有重试逻辑（在 @tool 实现中）
- [ ] ResultMessage 检查 `subtype` 区分 success / error_max_turns / error_budget

**错误处理模式：**

```python
async for message in query(prompt="...", options=options):
    if hasattr(message, 'subtype'):
        if message.subtype == 'error_max_turns':
            # Agent 达到最大迭代 → 可能任务太复杂，需拆分
            pass
        elif message.subtype == 'error_budget':
            # Token 预算耗尽 → 增加 budget 或简化任务
            pass
        elif message.subtype == 'success':
            # 正常完成
            pass
```

### 8. Cost & Performance Optimization

| Strategy                 | Impact                | How                                                                          |
| ------------------------ | --------------------- | ---------------------------------------------------------------------------- |
| **Model routing**        | 3-10x cost reduction  | Haiku for exploration, Sonnet for implementation, Opus for complex reasoning |
| **Tool search**          | 30-50% context saving | Enable for > 20 tools                                                        |
| **Session resume**       | Avoid re-processing   | Use `resume=session_id` for multi-turn                                       |
| **Subagent parallelism** | 2-5x speedup          | Independent tasks via parallel Task calls                                    |
| **Prompt compression**   | 10-20% context saving | Short system prompts, link to external docs                                  |

---

## Anti-Pattern Catalog

### AP-1: Subagent Explosion

```
WRONG: 10 subagents with 2-3 tools each
RIGHT: 2-3 subagents with clear responsibility boundaries
       OR single agent with good system prompt
```

### AP-2: God Agent

```
WRONG: Single agent with 50 tools and 5000-token system prompt
RIGHT: Hierarchical — orchestrator + specialist subagents
```

### AP-3: Hook Hell

```
WRONG: 15 hooks with complex conditional logic
RIGHT: 2-3 hooks for critical gates (dangerous ops + audit)
```

### AP-4: No Permission Isolation

```
WRONG: All agents have Bash + Write access
RIGHT: Research agents → Read/Grep only
       Implementation agents → Read/Write/Edit/Bash
       Review agents → Read/Grep only
```

### AP-5: Ignoring Session Persistence

```
WRONG: Re-sending full conversation history on each turn
RIGHT: Use resume=session_id for multi-turn interactions
```

### AP-6: Vague Tool Descriptions

```
WRONG: @tool("process", "Process data", ...)
RIGHT: @tool("calculate_portfolio_var",
             "Calculate Value-at-Risk for a portfolio. Use when user asks about risk metrics, VaR, portfolio risk. Input: positions array + confidence level. NOT for: individual stock analysis (use analyze_stock).",
             ...)
```

### AP-7: Synchronous Subagents for Independent Tasks

```
WRONG: await task("research") → await task("lint") → await task("test")
       (sequential, slow)
RIGHT: parallel Task calls for independent work
       sequential only when output of one feeds into another
```

---

## Output Template

When reviewing a Claude agent design, produce this structured report:

```markdown
## Agent Design Review — [Agent Name]

### Summary

[1-2 sentences: what the agent does, overall assessment]

### Architecture Score: X/8

| Dimension          | Score    | Notes |
| ------------------ | -------- | ----- |
| Single vs Multi    | ✅/⚠️/❌ | ...   |
| System Prompt      | ✅/⚠️/❌ | ...   |
| Tool Binding       | ✅/⚠️/❌ | ...   |
| Subagent Design    | ✅/⚠️/❌ | ...   |
| Hook Design        | ✅/⚠️/❌ | ...   |
| Context Management | ✅/⚠️/❌ | ...   |
| Error Handling     | ✅/⚠️/❌ | ...   |
| Cost Optimization  | ✅/⚠️/❌ | ...   |

### Critical Issues (must fix)

1. [Issue + specific fix]

### Improvements (should fix)

1. [Issue + specific fix]

### Recommended Architecture

[Code snippet or diagram of the improved design]
```

---

## Data Notes

- **Claude Agent SDK** 基于 Claude Code CLI 运行时，需要 Node.js 22+ 环境
- **Session 存储**: `~/.claude/sessions/`，可持久化但有 disk 开销
- **MCP Tool Search**: 需要 Sonnet 4+ / Opus 4+，Haiku 不支持
- **Subagent 限制**: 不支持嵌套（subagent 不能再创建 subagent）
- **Token Budget**: 默认无限制，生产环境务必设置 `max_tokens` / `max_turns`
- **成本**: Opus ~$15/M input, Sonnet ~$3/M input, Haiku ~$0.25/M input（2026.03）

## Response Guidelines

### Review 输出格式

- 用上述 Output Template 结构化输出
- 每个问题附带具体代码修复建议（不要只说"需要改进"）
- 反模式用 `AP-N` 编号引用

### 代码示例

- Python 和 TypeScript 都展示（SDK 支持两种）
- 包含完整 import 和类型注解
- 注释标注关键决策点

### 必须包含

- 架构评分（X/8）
- 至少 1 个 Critical Issue 或明确 "No critical issues"
- 成本估算提示（模型选择对成本影响）
