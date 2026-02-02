---
read_when:
  - 你想了解 OpenClaw 中"上下文"的含义
  - 你在调试为什么模型"知道"某些内容（或遗忘了它）
  - 你想减少上下文开销（/context、/status、/compact）
summary: 上下文：模型看到的内容、如何构建以及如何检查
title: 上下文
x-i18n:
  generated_at: "2026-02-01T20:22:35Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b32867b9b93254fdd1077d0d97c203cabfdba3330bb941693c83feba8e5db0cc
  source_path: concepts/context.md
  workflow: 14
---

# 上下文

"上下文"是 **OpenClaw 在一次运行中发送给模型的所有内容**。它受模型的**上下文窗口**（token 限制）约束。

初学者心智模型：

- **系统提示词**（由 OpenClaw 构建）：规则、工具、Skills 列表、时间/运行时信息，以及注入的工作区文件。
- **对话历史**：你的消息 + 助手在本次会话中的消息。
- **工具调用/结果 + 附件**：命令输出、文件读取、图片/音频等。

上下文与"记忆"_不是同一回事_：记忆可以存储在磁盘上并在之后重新加载；上下文是当前模型窗口内的内容。

## 快速开始（检查上下文）

- `/status` → 快速查看"我的窗口还剩多少空间？"以及会话设置。
- `/context list` → 查看注入了哪些内容及大致大小（按文件和总计）。
- `/context detail` → 更深入的分解：按文件、按工具 schema 大小、按 Skills 条目大小，以及系统提示词大小。
- `/usage tokens` → 在正常回复后附加每次回复的用量信息。
- `/compact` → 将较早的历史记录总结为一个压缩条目，以释放窗口空间。

另请参阅：[斜杠命令](/tools/slash-commands)、[Token 用量与费用](/token-use)、[压缩](/concepts/compaction)。

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

## 哪些内容计入上下文窗口

模型接收到的所有内容都会计入，包括：

- 系统提示词（所有部分）。
- 对话历史。
- 工具调用 + 工具结果。
- 附件/转录内容（图片/音频/文件）。
- 压缩摘要和修剪产物。
- 提供商的"包装器"或隐藏头信息（不可见，但仍会计入）。

## OpenClaw 如何构建系统提示词

系统提示词由 **OpenClaw 拥有**，每次运行时重新构建。它包括：

- 工具列表 + 简短描述。
- Skills 列表（仅元数据；见下文）。
- 工作区位置。
- 时间（UTC + 如已配置则转换为用户时间）。
- 运行时元数据（主机/操作系统/模型/思考模式）。
- 在 **Project Context** 下注入的工作区引导文件。

完整分解：[系统提示词](/concepts/system-prompt)。

## 注入的工作区文件（Project Context）

默认情况下，OpenClaw 会注入一组固定的工作区文件（如果存在）：

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（仅首次运行）

大文件会按 `agents.defaults.bootstrapMaxChars`（默认 `20000` 字符）逐文件截断。`/context` 会显示**原始大小与注入大小**的对比，以及是否发生了截断。

## Skills：注入的内容与按需加载的内容

系统提示词中包含一个紧凑的**Skills 列表**（名称 + 描述 + 位置）。此列表会产生实际开销。

Skills 指令默认*不会*包含在内。模型应在**需要时**才 `read` Skills 的 `SKILL.md`。

## 工具：两种开销

工具以两种方式影响上下文：

1. 系统提示词中的**工具列表文本**（即你看到的"Tooling"部分）。
2. **工具 schema**（JSON）。这些会发送给模型以便其调用工具。即使你看不到它们的纯文本形式，它们也会计入上下文。

`/context detail` 会分解最大的工具 schema，让你了解哪些占用最多。

## 命令、指令和"内联快捷方式"

斜杠命令由 Gateway网关处理。有几种不同的行为：

- **独立命令**：仅包含 `/...` 的消息作为命令运行。
- **指令**：`/think`、`/verbose`、`/reasoning`、`/elevated`、`/model`、`/queue` 会在模型看到消息之前被移除。
  - 仅含指令的消息会持久化会话设置。
  - 普通消息中的内联指令作为单次消息提示生效。
- **内联快捷方式**（仅限白名单发送者）：普通消息中的某些 `/...` 标记可以立即执行（例如："hey /status"），并在模型看到剩余文本之前被移除。

详情：[斜杠命令](/tools/slash-commands)。

## 会话、压缩和修剪（哪些内容会持久化）

跨消息持久化的内容取决于机制：

- **普通历史**会持久化在会话转录中，直到被策略压缩/修剪。
- **压缩**会将摘要持久化到转录中，并保留最近的消息不变。
- **修剪**会从运行的*内存中*提示词里移除旧的工具结果，但不会重写转录。

文档：[会话](/concepts/session)、[压缩](/concepts/compaction)、[会话修剪](/concepts/session-pruning)。

## `/context` 实际报告的内容

`/context` 优先使用最新的**运行时构建的**系统提示词报告（如果可用）：

- `System prompt (run)` = 从上一次嵌入式（具有工具能力的）运行中捕获，并持久化在会话存储中。
- `System prompt (estimate)` = 当不存在运行报告时（或通过不生成该报告的 CLI 后端运行时）即时计算。

无论哪种方式，它都会报告大小和主要贡献者；它**不会**输出完整的系统提示词或工具 schema。
