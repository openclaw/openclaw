---
summary: "Agent 运行时、工作区合约和会话引导"
read_when:
  - 更改代理运行时、工作区引导或会话行为
title: "Agent 运行时"
---

# Agent 运行时

OpenClaw 运行单个嵌入式代理运行时。

## 工作区（必需）

OpenClaw 使用单个代理工作区目录 (`agents.defaults.workspace`) 作为代理的**唯一**工作目录 (`cwd`)，用于工具和上下文。

推荐：使用 `openclaw setup` 创建 `~/.openclaw/openclaw.json`（如果缺失）并初始化工作区文件。

完整工作区布局 + 备份指南：[Agent 工作区](/concepts/agent-workspace)

如果启用了 `agents.defaults.sandbox`，非主会话可以通过 `agents.defaults.sandbox.workspaceRoot` 下的每个会话工作区覆盖此设置（请参阅[网关配置](/gateway/configuration)）。

## 引导文件（注入）

在 `agents.defaults.workspace` 内部，OpenClaw 期望这些用户可编辑文件：

- `AGENTS.md` — 操作说明 + "内存"
- `SOUL.md` — 角色、边界、语气
- `TOOLS.md` — 用户维护的工具说明（例如 `imsg`、`sag`、约定）
- `BOOTSTRAP.md` — 一次性首次运行仪式（完成后删除）
- `IDENTITY.md` — 代理名称/氛围/表情
- `USER.md` — 用户配置文件 + 首选地址

在新会话的第一个回合中，OpenClaw 将这些文件的内容直接注入到代理上下文中。

空白文件会被跳过。大文件会被修剪和截断，并带有标记，以便提示保持简洁（阅读文件以获取完整内容）。

如果文件缺失，OpenClaw 会注入一行"缺失文件"标记（`openclaw setup` 会创建安全的默认模板）。

`BOOTSTRAP.md` 仅为**全新工作区**创建（不存在其他引导文件）。如果您在完成仪式后删除它，在以后的重启中不应重新创建。

要完全禁用引导文件创建（对于预种子工作区），设置：

```json5
{ agent: { skipBootstrap: true } }
```

## 内置工具

核心工具（读/执行/编辑/写和相关系统工具）始终可用，受工具策略限制。`apply_patch` 是可选的，由 `tools.exec.applyPatch` 控制。`TOOLS.md` **不**控制哪些工具存在；它是关于您希望如何使用它们的指导。

## 技能

OpenClaw 从这些位置加载技能（优先级从高到低）：

- 工作区：`<workspace>/skills`
- 项目代理技能：`<workspace>/.agents/skills`
- 个人代理技能：`~/.agents/skills`
- 管理/本地：`~/.openclaw/skills`
- 捆绑（随安装一起提供）
- 额外技能文件夹：`skills.load.extraDirs`

技能可以通过配置/环境进行控制（请参阅 [网关配置](/gateway/configuration) 中的 `skills`）。

## 运行时边界

嵌入式代理运行时基于 Pi 代理核心（模型、工具和提示管道）构建。会话管理、发现、工具连接和通道传递是 OpenClaw 拥有的核心之上的层。

## 会话

会话记录存储为 JSONL，位于：

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

会话 ID 是稳定的，由 OpenClaw 选择。不读取来自其他工具的旧会话文件夹。

## 流式传输时的引导

当队列模式为 `steer` 时，入站消息会被注入到当前运行中。队列引导在**当前助手回合完成其工具调用后**、下一次 LLM 调用之前传递。引导不再跳过当前助手消息的剩余工具调用；而是在下一个模型边界注入队列消息。

当队列模式为 `followup` 或 `collect` 时，入站消息会被保留，直到当前回合结束，然后新的代理回合开始，带有队列负载。请参阅[队列](/concepts/queue)了解模式 + 去抖动/上限行为。

块流式传输会在助手块完成后立即发送它们；默认情况下**关闭**（`agents.defaults.blockStreamingDefault: "off"`）。通过 `agents.defaults.blockStreamingBreak` 调整边界（`text_end` 与 `message_end`；默认为 text_end）。使用 `agents.defaults.blockStreamingChunk` 控制软块分块（默认为 800-1200 字符；优先考虑段落 break，然后是换行符；最后是句子）。使用 `agents.defaults.blockStreamingCoalesce` 合并流式传输的块，以减少单行垃圾信息（发送前基于空闲的合并）。非 Telegram 通道需要显式 `*.blockStreaming: true` 才能启用块回复。详细的工具摘要在工具开始时发出（无去抖动）；控制 UI 在可用时通过代理事件流式传输工具输出。更多详情：[流式传输 + 分块](/concepts/streaming)。

## 模型引用

配置中的模型引用（例如 `agents.defaults.model` 和 `agents.defaults.models`）通过在**第一个** `/` 上分割来解析。

- 配置模型时使用 `provider/model`。
- 如果模型 ID 本身包含 `/`（OpenRouter 风格），请包含提供者前缀（例如：`openrouter/moonshotai/kimi-k2`）。
- 如果您省略提供者，OpenClaw 首先尝试别名，然后是该确切模型 ID 的唯一配置提供者匹配，然后才回退到配置的默认提供者。如果该提供者不再公开配置的默认模型，OpenClaw 会回退到第一个配置的提供者/模型，而不是显示已删除的提供者默认值。

## 配置（最小）

至少设置：

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom`（强烈推荐）

---

_下一个：[群聊](/channels/group-messages)_ 🦞
