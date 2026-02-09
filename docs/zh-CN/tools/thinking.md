---
read_when:
  - 调整思考或详细模式指令解析或默认值时
summary: "`/think` + `/verbose` 的指令语法及其对模型推理的影响"
title: 思考级别
x-i18n:
  generated_at: "2026-02-01T21:43:37Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 1a611474c2781c9a8e9dac0e084e7ee4ef58aebece181fdc877392fc27442746
  source_path: tools/thinking.md
  workflow: 15
---

# 思考级别（/think 指令）

## 功能说明

- 在任何入站消息正文中使用内联指令：`/t <level>`、`/think:<level>` 或 `/thinking <level>`。
- 级别（别名）：`off | minimal | low | medium | high | xhigh`（仅 GPT-5.2 + Codex 模型）
  - minimal → "think"
  - low → "think hard"
  - medium → "think harder"
  - high → "ultrathink"（最大预算）
  - xhigh → "ultrathink+"（仅 GPT-5.2 + Codex 模型）
  - `highest`、`max` 映射为 `high`。
- 提供商说明：
  - Z.AI（`zai/*`）仅支持二元思考（`on`/`off`）。任何非 `off` 级别均视为 `on`（映射为 `low`）。

## 解析优先顺序

1. 消息上的内联指令（仅适用于该条消息）。
2. 会话覆盖（通过发送仅包含指令的消息设置）。
3. 全局默认值（配置中的 `agents.defaults.thinkingDefault`）。
4. 回退：具备推理能力的模型为 low；否则为 off。

## 设置会话默认值

- 发送一条**仅包含**指令的消息（允许空白），例如 `/think:medium` 或 `/t high`。
- 该设置在当前会话中持续生效（默认按发送者）；通过 `/think:off` 或会话空闲重置来清除。
- 会发送确认回复（`Thinking level set to high.` / `Thinking disabled.`）。如果级别无效（例如 `/thinking big`），命令将被拒绝并给出提示，会话状态保持不变。
- 不带参数发送 `/think`（或 `/think:`）可查看当前思考级别。

## 按智能体应用

- **内嵌 Pi**：解析后的级别传递给进程内的 Pi 智能体运行时。

## 详细模式指令（/verbose 或 /v）

- 级别：`on`（最小）| `full` | `off`（默认）。
- 仅包含指令的消息切换会话详细模式并回复 `Verbose logging enabled.` / `Verbose logging disabled.`；无效级别返回提示且不改变状态。
- `/verbose off` 存储一个显式的会话覆盖；通过会话 UI 选择 `inherit` 来清除。
- 内联指令仅影响该条消息；否则应用会话/全局默认值。
- 不带参数发送 `/verbose`（或 `/verbose:`）可查看当前详细模式级别。
- 启用详细模式后，发出结构化工具结果的智能体（Pi 及其他 JSON 智能体）会将每个工具调用作为独立的元数据消息发回，可用时以 `<emoji> <tool-name>: <arg>` 为前缀（路径/命令）。这些工具摘要在每个工具启动时立即发送（独立气泡），而非作为流式增量。
- 当详细模式为 `full` 时，工具输出也会在完成后转发（独立气泡，截断至安全长度）。如果在运行过程中切换 `/verbose on|full|off`，后续的工具气泡会遵循新设置。

## 推理可见性（/reasoning）

- 级别：`on|off|stream`。
- 仅包含指令的消息切换回复中是否显示思考块。
- 启用时，推理内容作为**独立消息**发送，以 `Reasoning:` 为前缀。
- `stream`（仅 Telegram）：在回复生成期间将推理内容流式输出到 Telegram 草稿气泡中，然后发送不包含推理的最终回答。
- 别名：`/reason`。
- 不带参数发送 `/reasoning`（或 `/reasoning:`）可查看当前推理级别。

## 相关内容

- 提权模式文档位于[提权模式](/tools/elevated)。

## 心跳

- 心跳探测正文为配置的心跳提示词（默认：`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`）。心跳消息中的内联指令照常生效（但避免从心跳中更改会话默认值）。
- 心跳投递默认仅包含最终负载。要同时发送单独的 `Reasoning:` 消息（如果可用），请设置 `agents.defaults.heartbeat.includeReasoning: true` 或按智能体 `agents.list[].heartbeat.includeReasoning: true`。

## Web 聊天 UI

- Web 聊天的思考选择器在页面加载时从入站会话存储/配置中读取并反映会话的已存储级别。
- 选择另一个级别仅应用于下一条消息（`thinkingOnce`）；发送后，选择器会回到已存储的会话级别。
- 要更改会话默认值，请发送 `/think:<level>` 指令（和之前一样）；选择器将在下次刷新后反映该设置。
