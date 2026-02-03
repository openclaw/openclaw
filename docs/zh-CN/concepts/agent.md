---
read_when:
  - 更改智能体运行时、工作区引导或会话行为
summary: 智能体运行时（嵌入式 pi-mono）、工作区契约和会话引导
title: 智能体运行时
x-i18n:
  generated_at: "2026-02-01T20:22:02Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 04b4e0bc6345d2afd9a93186e5d7a02a393ec97da2244e531703cb6a1c182325
  source_path: concepts/agent.md
  workflow: 14
---

# 智能体运行时 🤖

OpenClaw 运行一个源自 **pi-mono** 的单一嵌入式智能体运行时。

## 工作区（必需）

OpenClaw 使用单一智能体工作区目录（`agents.defaults.workspace`）作为智能体工具和上下文的**唯一**工作目录（`cwd`）。

建议：使用 `openclaw setup` 创建 `~/.openclaw/openclaw.json`（如果不存在）并初始化工作区文件。

完整的工作区布局 + 备份指南：[智能体工作区](/concepts/agent-workspace)

如果启用了 `agents.defaults.sandbox`，非主会话可以使用 `agents.defaults.sandbox.workspaceRoot` 下的按会话工作区覆盖此设置（参见 [Gateway网关配置](/gateway/configuration)）。

## 引导文件（注入）

在 `agents.defaults.workspace` 内，OpenClaw 期望这些用户可编辑的文件：

- `AGENTS.md` — 操作指令 + "记忆"
- `SOUL.md` — 角色设定、边界、语气
- `TOOLS.md` — 用户维护的工具说明（例如 `imsg`、`sag`、约定）
- `BOOTSTRAP.md` — 一次性首次运行仪式（完成后删除）
- `IDENTITY.md` — 智能体名称/风格/表情符号
- `USER.md` — 用户档案 + 首选称呼

在新会话的第一轮对话中，OpenClaw 会将这些文件的内容直接注入到智能体上下文中。

空白文件会被跳过。大文件会被裁剪和截断并附带标记，以保持提示词精简（阅读完整文件以获取全部内容）。

如果文件缺失，OpenClaw 会注入一行"文件缺失"标记（`openclaw setup` 会创建安全的默认模板）。

`BOOTSTRAP.md` 仅在**全新工作区**（没有其他引导文件存在）时创建。如果你在完成仪式后删除了它，后续重启时不会重新创建。

要完全禁用引导文件创建（用于预填充的工作区），请设置：

```json5
{ agent: { skipBootstrap: true } }
```

## 内置工具

核心工具（read/exec/edit/write 及相关系统工具）始终可用，受工具策略约束。`apply_patch` 是可选的，由 `tools.exec.applyPatch` 控制。`TOOLS.md` **不**控制哪些工具存在；它是关于你希望如何使用这些工具的指导。

## Skills

OpenClaw 从三个位置加载 Skills（名称冲突时工作区优先）：

- 内置（随安装包附带）
- 托管/本地：`~/.openclaw/skills`
- 工作区：`<workspace>/skills`

Skills 可以通过配置/环境变量进行控制（参见 [Gateway网关配置](/gateway/configuration) 中的 `skills`）。

## pi-mono 集成

OpenClaw 复用了 pi-mono 代码库的部分内容（模型/工具），但**会话管理、发现和工具连接由 OpenClaw 负责**。

- 没有 pi-coding 智能体运行时。
- 不会读取 `~/.pi/agent` 或 `<workspace>/.pi` 设置。

## 会话

会话记录以 JSONL 格式存储在：

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

会话 ID 是稳定的，由 OpenClaw 选择。
**不会**读取旧版 Pi/Tau 会话文件夹。

## 流式传输期间的引导

当队列模式为 `steer` 时，入站消息会被注入到当前运行中。队列在**每次工具调用后**检查；如果存在排队消息，当前助手消息的剩余工具调用会被跳过（工具结果显示"Skipped due to queued user message."错误），然后在下一个助手响应之前注入排队的用户消息。

当队列模式为 `followup` 或 `collect` 时，入站消息会被保留直到当前轮次结束，然后使用排队的负载开始新的智能体轮次。参见[队列](/concepts/queue)了解模式 + 防抖/上限行为。

块流式传输在完成的助手块完成后立即发送；**默认关闭**（`agents.defaults.blockStreamingDefault: "off"`）。
通过 `agents.defaults.blockStreamingBreak` 调整边界（`text_end` 与 `message_end`；默认为 text_end）。
使用 `agents.defaults.blockStreamingChunk` 控制软块分块（默认 800–1200 字符；优先段落分隔，其次换行；最后是句子）。
使用 `agents.defaults.blockStreamingCoalesce` 合并流式块，以减少单行刷屏（基于空闲的合并后再发送）。非 Telegram 渠道需要显式设置 `*.blockStreaming: true` 以启用块回复。
详细的工具摘要在工具启动时发出（无防抖）；Control UI 在可用时通过智能体事件流式传输工具输出。
更多详情：[流式传输 + 分块](/concepts/streaming)。

## 模型引用

配置中的模型引用（例如 `agents.defaults.model` 和 `agents.defaults.models`）通过**第一个** `/` 进行拆分解析。

- 配置模型时使用 `provider/model` 格式。
- 如果模型 ID 本身包含 `/`（OpenRouter 风格），请包含提供商前缀（示例：`openrouter/moonshotai/kimi-k2`）。
- 如果省略提供商，OpenClaw 会将输入视为别名或**默认提供商**的模型（仅在模型 ID 中没有 `/` 时有效）。

## 配置（最小化）

至少需要设置：

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom`（强烈建议）

---

_下一篇：[群聊](/concepts/group-messages)_ 🦞
