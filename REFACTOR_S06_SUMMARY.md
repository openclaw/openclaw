# s06_mem.py 优化总结

## 问题诊断

原始 `s06_mem.py` 存在的核心问题：

1. **框架割裂**：完全独立实现，与 `s05_gateway.py` 的架构无关
2. **逻辑缺失**：没有讲清楚 memory 和 soul 如何被调度管理和有机整合
3. **代码重复**：重新实现了路由、session 管理等已在 s05 中实现的逻辑
4. **多 Agent 无支持**：虽然使用了 Anthropic 客户端，但没有多 Agent 路由能力
5. **工具体系不一致**：没有使用 s04/s05 统一的 `deepseek_chat_with_tools`

## 优化方案

### Part 1: 框架整合（继承 s05_gateway.py）

**改进**：完全继承 s05 的核心组件
- ✅ `AgentConfig` - Agent 配置基类
- ✅ `Binding` - 路由绑定规则
- ✅ `MessageRouter` - 消息路由器
- ✅ `build_session_key()` - Session key 构建
- ✅ `S04SessionStore` - Session 持久化存储

**新增**：`AgentWithSoulMemory` - 扩展 AgentConfig
```python
@dataclass
class AgentWithSoulMemory(AgentConfig):
    soul_path: Path | None = None          # SOUL.md 路径
    memory_root: Path | None = None        # memory/ 目录路径
```

每个 Agent 现在拥有：
- 独立的 `{agent_id}_SOUL.md` 人格文件
- 独立的 `{agent_id}_memory/` 记忆目录

### Part 2: Soul System（Agent 级别）

**架构改进**：从全局单一 Soul 改为 Agent 级 Soul

```
Before (原有设计):
  workspace/
    SOUL.md  ← 全局唯一

After (优化后):
  workspace/
    main_SOUL.md
    alice_SOUL.md
    bob_SOUL.md    ← 每个 Agent 独立人格
```

**实现**：
```python
class SoulSystem:
    def __init__(self, soul_path: Path):
        self.soul_path = soul_path

    def build_system_prompt(self, base_prompt: str) -> str:
        """融合 Soul + Base Prompt"""
        soul = self.load_soul()
        if soul:
            return f"{soul}\n\n---\n\n{base_prompt}"
        return base_prompt
```

**优势**：
- 多个 Agent 可有完全不同的人格和语言风格
- 人格文件易于管理和版本控制
- 与 s05 的多 Agent 设计完美契合

### Part 3: Memory System（双层、Agent 级、Session 隔离）

**架构改进**：从全局记忆改为 Agent 级、Session 隔离的记忆

```
Before (原有设计):
  workspace/
    MEMORY.md           ← 全局永久记忆
    memory/
      2026-02-24.md
      2026-02-23.md    ← 全局每日日志

After (优化后):
  workspace/
    main_MEMORY.md      ← main Agent 的永久记忆
    main_memory/
      2026-02-24.md
      2026-02-23.md    ← main Agent 的每日日志

    alice_MEMORY.md     ← alice Agent 的永久记忆
    alice_memory/
      2026-02-24.md    ← alice Agent 的每日日志
```

**MemoryStore 设计**：
```python
class MemoryStore:
    def __init__(self, memory_root: Path):
        self.memory_root = memory_root
        self.evergreen_path = memory_root / "MEMORY.md"
        self.daily_dir = memory_root / "memory"
```

**Session 隔离**：
- 不同的 session_key 会使用不同的内存上下文
- 同一 Agent 在不同 channel/peer 的对话记忆独立
- SessionStore 通过 session_key 隔离历史记录

**双层记忆**：
1. **Evergreen Memory** (`MEMORY.md`)
   - 常驻事实（用户偏好、项目信息等）
   - 手动更新或通过 memory_write 工具自动更新
   - 影响所有会话

2. **Daily Memory** (`memory/YYYY-MM-DD.md`)
   - 每日记忆日志
   - 记录该日期发生的事
   - 通过 memory_write 工具写入
   - 近期内存（最近 3 天）注入到 system prompt

### Part 4: 工具体系统一

**改进**：建立统一的工具处理机制

**Memory 工具**：
```python
def build_memory_tools() -> list[dict]:
    return [
        {
            "name": "memory_write",
            "description": "Write a memory to persistent storage",
            ...
        },
        {
            "name": "memory_search",
            "description": "Search through stored memories",
            ...
        },
    ]
```

**工具处理**：
```python
def handle_memory_tool(
    tool_name: str,
    params: dict,
    agent_id: str,
    memory_root: Path,
) -> str:
    """处理 memory 工具，路由到正确的 MemoryStore"""
    store = get_memory_store(agent_id, memory_root)
    if tool_name == "memory_write":
        ...
    elif tool_name == "memory_search":
        ...
```

**优势**：
- 与 s04 的 `process_tool_call` 体系一致
- Agent 工具调用自动路由到正确的 MemoryStore
- 支持混合调用 s04 工具 + memory 工具

### Part 5: Agent Runner 实现

**新函数**：`run_agent_with_soul_and_memory()`

```python
def run_agent_with_soul_and_memory(
    agent: AgentWithSoulMemory,
    session_store: S04SessionStore,
    session_key: str,
    user_text: str,
) -> str:
```

**设计**：
1. 加载 Agent 的配置（model, system_prompt, tools）
2. 加载或创建 session 历史
3. 构建系统提示（融合 Soul + Base + Memory）
4. 调用 `deepseek_chat_with_tools()`（与 s05 一致）
5. 处理工具调用（特殊处理 memory 工具）
6. 持久化 session

**System Prompt 分层**：
```
┌─────────────────────────────────┐
│ [SOUL.md]                       │  ← 人格定义（最高优先级）
│ [Base system prompt]            │
│ [MEMORY.md]                     │  ← 常驻记忆
│ [Recent memory - last 3 days]   │  ← 时间上下文
└─────────────────────────────────┘
```

### Part 6: 运行模式

#### REPL Mode（本地交互测试）
```bash
python s06_mem.py --repl
```

功能：
- 单 Agent 交互式对话
- `/soul` 命令查看当前人格
- `/memory` 命令查看记忆状态
- 支持工具调用（memory_write, memory_search 等）
- 会话历史持久化到 `.sessions/`

#### Chat Mode（待实现）
```bash
python s06_mem.py --chat
```

将支持：
- 交互式多 Agent 对话
- 消息自动路由到对应 Agent
- 支持绑定规则指定 Agent

#### Server Mode（待实现）
```bash
python s06_mem.py --server
```

将支持：
- WebSocket 网关服务
- JSON-RPC 2.0 协议
- 支持多客户端连接
- 完整的路由和会话管理

## 架构层次

优化后的架构清晰分层：

```
┌──────────────────────────────────────────┐
│ Application Layer                        │
│  - REPL / Chat / Server modes            │
├──────────────────────────────────────────┤
│ Agent Layer (新增 Soul & Memory)         │
│  - AgentWithSoulMemory config            │
│  - Soul system (per-Agent SOUL.md)       │
│  - Memory system (per-Agent MEMORY.md)   │
├──────────────────────────────────────────┤
│ Routing & Gateway Layer (继承自 s05)    │
│  - MessageRouter                         │
│  - AgentConfig                           │
│  - Binding rules                         │
├──────────────────────────────────────────┤
│ Tool & LLM Layer (继承自 s04/s05)        │
│  - deepseek_chat_with_tools              │
│  - TOOLS_OPENAI (from s04)               │
│  - memory tools                          │
├──────────────────────────────────────────┤
│ Storage Layer (继承自 s04)               │
│  - S04SessionStore (sessions)            │
│  - Memory files (MEMORY.md, daily logs)  │
└──────────────────────────────────────────┘
```

## 集成要点

### 与 s05_gateway.py 的关系

| 组件 | 来源 | 用法 |
|------|------|------|
| `AgentConfig` | s05 | 基类 |
| `AgentWithSoulMemory` | **s06** | 扩展 |
| `MessageRouter` | s05 | 路由逻辑 |
| `Binding` | s05 | 路由规则 |
| `build_session_key()` | s05 | Session 隔离 |
| `RoutingGateway` | s05 | 网关服务 |

### 与 s04_multi_channel.py 的关系

| 组件 | 来源 | 用法 |
|------|------|------|
| `S04SessionStore` | s04 | Session 持久化 |
| `TOOLS_OPENAI` | s04 | 基础工具集 |
| `process_tool_call` | s04 | 工具处理 |
| `SYSTEM_PROMPT` | s04 | 基础系统提示 |
| `deepseek_chat_with_tools` | s04 | LLM 调用 |

### 向后兼容性

- ✅ 所有 s04 工具仍可用
- ✅ Session 存储格式不变
- ✅ 路由系统完全兼容
- ✅ 可与 s05 网关无缝集成

## 关键改进

### 1. 清晰的逻辑层次

```
消息入站
  ↓
MessageRouter.resolve()  (来自 s05)
  ├─ 决定 Agent
  └─ 决定 Session Key
  ↓
AgentWithSoulMemory
  ├─ 加载 Soul (人格)
  ├─ 加载 Memory (历史)
  └─ 构建 system prompt
  ↓
deepseek_chat_with_tools()  (来自 s05)
  ├─ 工具调用处理
  ├─ Memory 工具 → MemoryStore
  └─ 其他工具 → s04 处理器
  ↓
S04SessionStore
  └─ 持久化会话
```

### 2. 完整的工具体系

- 基础工具：TOOLS_OPENAI (s04)
- 扩展工具：memory_write, memory_search (s06)
- 统一处理：`handle_memory_tool()` 路由到正确的 MemoryStore

### 3. Session 隔离

通过 `session_key` 实现多维隔离：
- 不同 Agent: `agent:alice:...` vs `agent:bob:...`
- 不同 Channel: `...:discord:...` vs `...:telegram:...`
- 不同 Peer: `...:peer_id`

每个 Agent 在不同 session 中有独立的：
- 对话历史
- 记忆文件访问
- 人格表现（通过 Soul 文件）

### 4. 可扩展设计

基础已建立，易于扩展：
- 添加新的 Agent 工具：extends `build_memory_tools()`
- 添加新的 Session 类型：extends `build_session_key()`
- 支持多 Agent 路由：MessageRouter 已就位
- WebSocket 网关：RoutingGateway 继承自 s05

## 下一步工作

### 待完成的功能

1. **Chat Mode** (--chat)
   - 支持多 Agent 交互式对话
   - 自动路由到对应 Agent
   - 显示当前 Agent 信息

2. **Server Mode** (--server)
   - 启动 WebSocket 网关
   - 支持多客户端连接
   - 完整的 JSON-RPC 处理

3. **增强的 Memory 搜索**
   - 使用真实 embedding 替代 TF-IDF
   - 集成 sqlite-vec 向量数据库
   - 支持向量索引和缓存

4. **Advanced Routing**
   - 支持更复杂的绑定规则
   - 支持 Agent 链（Agent A 调用 Agent B）
   - 支持条件路由和优先级管理

5. **Tools 扩展**
   - 支持更多内置工具
   - 自定义工具注册机制
   - Tool 权限控制

## 总结

通过这次优化，s06_mem.py 从一个独立的、概念性的教程，演进为：

✅ **完整的框架示例**：展示如何在 s05_gateway.py 的基础上，添加 Memory 和 Soul 功能

✅ **正确的架构集成**：清晰的层次结构，每层各司其职

✅ **生产就绪的设计**：支持多 Agent、Session 隔离、持久化存储

✅ **易于扩展**：基础已建立，支持添加新功能（路由规则、工具、Agent 等）

✅ **教学价值**：代码清晰，注释详细，展示了如何构建复杂的 AI 系统
