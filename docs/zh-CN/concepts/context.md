---
read_when:
  - 你想了解 OpenClaw 中"上下文"的含义
  - 你在调试为什么模型"知道"某些内容（或忘记了）
  - 你想减少上下文开销（/context、/status、/compact）
summary: 上下文：模型看到的内容、如何构建以及如何检查
title: 上下文
x-i18n:
  generated_at: "2026-02-03T07:46:15Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b32867b9b93254fdd1077d0d97c203cabfdba3330bb941693c83feba8e5db0cc
  source_path: concepts/context.md
  workflow: 15
---

# 上下文

"上下文"是 **OpenClaw 在一次运行中发送给模型的所有内容**。它受模型的**上下文窗口**（token 限制）约束。

新手心智模型：

- **系统提示词**（OpenClaw 构建）：规则、工具、Skills 列表、时间/运行时，以及注入的工作区文件。
- **对话历史**：你的消息 + 助手在此会话中的消息。
- **工具调用/结果 + 附件**：命令输出、文件读取、图片/音频等。

上下文与"记忆"_不是同一回事_：记忆可以存储在磁盘上并稍后重新加载；上下文是模型当前窗口内的内容。

## 快速开始（检查上下文）

- `/status` → 快速查看"我的窗口有多满？" + 会话设置。
- `/context list` → 注入了什么 + 大致大小（每个文件 + 总计）。
- `/context detail` → 更深入的分解：每个文件、每个工具 schema 大小、每个 Skills 条目大小和系统提示词大小。
- `/usage tokens` → 在正常回复后附加每次回复的使用量页脚。
- `/compact` → 将较旧的历史总结为紧凑条目以释放窗口空间。

另请参阅：[斜杠命令](/tools/slash-commands)、[Token 使用与成本](/token-use)、[压缩](/concepts/compaction)。

## 示例输出

数值因模型、提供商、工具策略和工作区内容而异。

### `/context list`

```
🧠 Context breakdown
Workspace: <workspaceDir>
Bootstrap max/file: 20,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

Injected workspace files:
- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)

Skills list (system prompt text): 2,184 chars (~546 tok) (12 skills)
Tools: read, edit, write, exec, process, browser, message, sessions_send, …
Tool list (system prompt text): 1,032 chars (~258 tok)
Tool schemas (JSON): 31,988 chars (~7,997 tok) (counts toward context; not shown as text)
Tools: (same as above)

Session tokens (cached): 14,250 total / ctx=32,000
```

### `/context detail`

```
🧠 Context breakdown (detailed)
…
Top skills (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
… (+10 more skills)

Top tools (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
… (+N more tools)
```

## 什么计入上下文窗口

模型接收的所有内容都计入，包括：

- 系统提示词（所有部分）。
- 对话历史。
- 工具调用 + 工具结果。
- 附件/转录（图片/音频/文件）。
- 压缩摘要和修剪产物。
- 提供商"包装器"或隐藏头部（不可见，仍然计数）。

## OpenClaw 如何构建系统提示词

系统提示词由 **OpenClaw 拥有**，每次运行时重建。它包括：

- 工具列表 + 简短描述。
- Skills 列表（仅元数据；见下文）。
- 工作区位置。
- 时间（UTC + 如果配置了则转换为用户时间）。
- 运行时元数据（主机/操作系统/模型/思考）。
- 在**项目上下文**下注入的工作区引导文件。

完整分解：[系统提示词](/concepts/system-prompt)。

## 注入的工作区文件（项目上下文）

默认情况下，OpenClaw 注入一组固定的工作区文件（如果存在）：

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（仅首次运行）

大文件按文件使用 `agents.defaults.bootstrapMaxChars`（默认 `20000` 字符）截断。`/context` 显示**原始 vs 注入**大小以及是否发生了截断。

## Skills：注入的内容 vs 按需加载的内容

系统提示词包含一个紧凑的 **Skills 列表**（名称 + 描述 + 位置）。此列表有实际开销。

Skill 指令默认*不*包含。模型应该**仅在需要时**`read` Skill 的 `SKILL.md`。

## 工具：有两种成本

工具以两种方式影响上下文：

1. 系统提示词中的**工具列表文本**（你看到的"Tooling"）。
2. **工具 schema**（JSON）。这些发送给模型以便它可以调用工具。它们计入上下文，即使你看不到它们作为纯文本。

`/context detail` 分解最大的工具 schema，以便你可以看到什么占主导。

## 命令、指令和"内联快捷方式"

斜杠命令由 Gateway 网关处理。有几种不同的行为：

- **独立命令**：仅为 `/...` 的消息作为命令运行。
- **指令**：`/think`、`/verbose`、`/reasoning`、`/elevated`、`/model`、`/queue` 在模型看到消息之前被剥离。
  - 仅指令消息会持久化会话设置。
  - 正常消息中的内联指令作为每条消息的提示。
- **内联快捷方式**（仅允许列表中的发送者）：正常消息中的某些 `/...` token 可以立即运行（例如："hey /status"），并在模型看到剩余文本之前被剥离。

详情：[斜杠命令](/tools/slash-commands)。

## 会话、压缩和修剪（什么会持久化）

什么在消息之间持久化取决于机制：

- **正常历史**在会话记录中持久化，直到被策略压缩/修剪。
- **压缩**将摘要持久化到记录中，并保持最近的消息不变。
- **修剪**从运行的*内存中*提示词中删除旧的工具结果，但不重写记录。

文档：[会话](/concepts/session)、[压缩](/concepts/compaction)、[会话修剪](/concepts/session-pruning)。

## `/context` 实际报告什么

`/context` 在可用时优先使用最新的**运行构建的**系统提示词报告：

- `System prompt (run)` = 从最后一次嵌入式（具有工具能力的）运行中捕获，并持久化在会话存储中。
- `System prompt (estimate)` = 当没有运行报告存在时（或通过不生成报告的 CLI 后端运行时）即时计算。

无论哪种方式，它都报告大小和主要贡献者；它**不会**转储完整的系统提示词或工具 schema。
