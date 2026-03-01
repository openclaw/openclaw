# S06 Memory & Soul System - 使用指南

## 快速开始

### 1. 基础设置

```bash
# 确保环境变量已设置
export DEEPSEEK_API_KEY="your-key-here"
# 或
export ANTHROPIC_API_KEY="your-key-here"

# 进入项目目录
cd openclaw

# 创建 workspace 目录
mkdir -p workspace
```

### 2. 创建 Agent 的 Soul（人格）

为 Agent `main` 创建 `workspace/main_SOUL.md`：

```markdown
# Soul: Koda

You are Koda, a thoughtful AI assistant.

## Personality
- Warm but not overly enthusiastic
- Prefer concise, clear explanations
- Use analogies from nature and engineering

## Values
- Honesty over comfort
- Depth over breadth
- Action over speculation

## Language Style
- Chinese for casual chat, English for technical terms
- No emoji in serious discussions
- End complex explanations with a one-line summary
```

### 3. 启动 REPL

```bash
python s06_mem.py --repl
```

输出：
```
======================================================================
  Mini-Claw REPL  |  Section 06: Soul & Memory
  Agent: main
  Model: deepseek-chat
  Workspace: /path/to/workspace

  Commands:
    /quit or /exit     - Leave REPL
    /soul              - View current soul
    /memory            - View memory status
======================================================================

Soul loaded from /path/to/workspace/main_SOUL.md
Preview: # Soul: Koda
```

## 交互式使用

### 基本对话

```
You > 我叫小张，最喜欢的编程语言是 Rust
```

Assistant 会：
1. 正常回复你的消息
2. 从 Soul 中表现出 Koda 的个性
3. 自动记忆你提供的信息（如果调用了 memory_write 工具）

### 查看 Soul

```
You > /soul
```

显示当前 Agent 的 SOUL.md 内容，便于调试和确认人格设置。

### 查看记忆

```
You > /memory
```

输出示例：
```
--- Memory Status (main) ---
MEMORY.md: 1250 chars
Recent daily logs: 3 files
  2026-02-28: 12 lines
  2026-02-27: 8 lines
  2026-02-26: 5 lines
--- end ---
```

## Agent 的记忆操作

### Memory Write（Agent 自动调用）

当你问一些需要记忆的信息时，Agent 可能会自动调用 memory_write：

```
You > 我最喜欢的编程语言是 Rust，我在 GitHub 上有一个开源项目叫 openclaw

[Agent: main]
[tool:memory_write] {"content": "User's favorite language: Rust", "category": "preference"}
[tool:memory_write] {"content": "User has GitHub project: openclaw", "category": "fact"}