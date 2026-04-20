---
summary: "代理运行时、工作区契约和会话引导"
read_when:
  - 更改代理运行时、工作区引导或会话行为
title: "代理运行时"
---

# 代理运行时

OpenClaw运行单个嵌入式代理运行时。

## 工作区（必需）

OpenClaw使用单个代理工作区目录（`agents.defaults.workspace`）作为代理的**唯一**工作目录（`cwd`），用于工具和上下文。

推荐：如果缺少`~/.openclaw/openclaw.json`，使用`openclaw setup`创建它并初始化工作区文件。

完整的工作区布局 + 备份指南：[代理工作区](/concepts/agent-workspace)

如果启用了`agents.defaults.sandbox`，非主会话可以使用`agents.defaults.sandbox.workspaceRoot`下的每个会话工作区覆盖此设置（请参阅[网关配置](/gateway/configuration)）。

## 引导文件（注入）

在`agents.defaults.workspace`内，OpenClaw期望这些用户可编辑的文件：

- `AGENTS.md` — 操作说明 + "内存"
- `SOUL.md` — 角色、边界、语气
- `TOOLS.md` — 用户维护的工具说明（例如`imsg`、`sag`、约定）
- `BOOTSTRAP.md` — 一次性首次运行仪式（完成后删除）
- `IDENTITY.md` — 代理名称/氛围/表情符号
- `USER.md` — 用户配置文件 + 首选称呼

在新会话的第一个回合，OpenClaw将这些文件的内容直接注入到代理上下文中。

空白文件被跳过。大文件会被修剪和截断，并带有标记，以便提示保持精简（阅读文件获取完整内容）。

如果文件缺失，OpenClaw会注入一行"缺失文件"标记（并且`openclaw setup`会创建一个安全的默认模板）。

`BOOTSTRAP.md`仅为**全新工作区**创建（不存在其他引导文件）。如果你在完成仪式后删除它，它不应在以后的重启中重新创建。

要完全禁用引导文件创建（对于预填充的工作区），设置：

```json5
{ agent: { skipBootstrap: true } }
```

## 内置工具

核心工具（读/执行/编辑/写和相关系统工具）始终可用，受工具策略约束。`apply_patch`是可选的，由`tools.exec.applyPatch`控制。`TOOLS.md`**不**控制哪些工具存在；它是关于你希望如何使用它们的指导。

## 技能

OpenClaw从以下位置加载技能（优先级从高到低）：

- 工作区：`<workspace>/skills`
- 项目代理技能：`<workspace>/.agents/skills`
- 个人代理技能：`~/.agents/skills`
- 管理/本地：`~/.openclaw/skills`
- 捆绑（随安装一起提供）
- 额外技能文件夹：`skills.load.extraDirs`

技能可以通过配置/环境进行控制（请参阅[网关配置](/gateway/configuration)中的`skills`）。

## 运行时边界

嵌入式代理运行时构建在Pi代理核心（模型、工具和提示管道）上。会话管理、发现、工具连接和频道交付是在该核心之上的OpenClaw拥有的层。

## 会话

会话记录存储为JSONL，位于：

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

会话ID是稳定的，由OpenClaw选择。
不读取来自其他工具的旧会话文件夹。

## 流式传输时的引导

当队列模式为`steer`时，入站消息会被注入到当前运行中。
排队的引导在**当前助手回合完成其工具调用后**，在下一个LLM调用之前传递。引导不再跳过当前助手消息的剩余工具调用；而是在下次模型边界处注入排队的消息。

当队列模式为`followup`或`collect`时，入站消息会被保留，直到当前回合结束，然后新的代理回合会使用排队的负载开始。有关模式 + 防抖/上限行为，请参阅[队列](/concepts/queue)。

块流式传输会在助手块完成后立即发送它们；默认情况下**关闭**（`agents.defaults.blockStreamingDefault: "off"`）。
通过`agents.defaults.blockStreamingBreak`调整边界（`text_end` vs `message_end`；默认为text_end）。
使用`agents.defaults.blockStreamingChunk`控制软块分块（默认为800–1200字符；优先考虑段落分隔，然后是换行符；最后是句子）。
使用`agents.defaults.blockStreamingCoalesce`合并流式传输的块，以减少单行垃圾信息（发送前基于空闲的合并）。非Telegram频道需要显式`*.blockStreaming: true`才能启用块回复。
详细的工具摘要在工具开始时发出（无防抖）；控制UI在可用时通过代理事件流式传输工具输出。
更多详情：[流式传输 + 分块](/concepts/streaming)。

## 模型引用

配置中的模型引用（例如`agents.defaults.model`和`agents.defaults.models`）通过在**第一个**`/`上分割进行解析。

- 配置模型时使用`provider/model`。
- 如果模型ID本身包含`/`（OpenRouter风格），请包含提供程序前缀（示例：`openrouter/moonshotai/kimi-k2`）。
- 如果你省略提供程序，OpenClaw会先尝试别名，然后尝试该确切模型ID的唯一配置提供程序匹配，只有在那时才会回退到配置的默认提供程序。如果该提供程序不再公开配置的默认模型，OpenClaw会回退到第一个配置的提供程序/模型，而不是显示过时的已删除提供程序默认值。

## 配置（最小）

至少设置：

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom`（强烈推荐）

---

_下一个：[群聊](/channels/group-messages)_ 🦞
