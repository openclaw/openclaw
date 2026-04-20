---
summary: "/think、/fast、/verbose、/trace 和推理可见性的指令语法"
read_when:
  - 调整思考、快速模式或详细指令解析或默认值
title: "思考级别"
---

# 思考级别（/think 指令）

## 功能

- 任何入站消息体中的内联指令：`/t <level>`、`/think:<level>` 或 `/thinking <level>`。
- 级别（别名）：`off | minimal | low | medium | high | xhigh | adaptive`
  - minimal → "think"
  - low → "think hard"
  - medium → "think harder"
  - high → "ultrathink"（最大预算）
  - xhigh → "ultrathink+"（GPT-5.2 + Codex 模型和 Anthropic Claude Opus 4.7 努力）
  - adaptive → 提供者管理的自适应思考（支持 Anthropic Claude 4.6 和 Opus 4.7）
  - `x-high`、`x_high`、`extra-high`、`extra high` 和 `extra_high` 映射到 `xhigh`。
  - `highest`、`max` 映射到 `high`。
- 提供者说明：
  - 当未设置明确的思考级别时，Anthropic Claude 4.6 模型默认为 `adaptive`。
  - Anthropic Claude Opus 4.7 不默认为自适应思考。除非您明确设置思考级别，否则其 API 努力默认值仍然由提供者拥有。
  - Anthropic Claude Opus 4.7 将 `/think xhigh` 映射到自适应思考加上 `output_config.effort: "xhigh"`，因为 `/think` 是思考指令，而 `xhigh` 是 Opus 4.7 努力设置。
  - Anthropic 兼容流式路径上的 MiniMax (`minimax/*`) 默认为 `thinking: { type: "disabled" }`，除非您在模型参数或请求参数中明确设置思考。这避免了 MiniMax 非原生 Anthropic 流格式泄漏的 `reasoning_content` 增量。
  - Z.AI (`zai/*`) 仅支持二元思考 (`on`/`off`)。任何非 `off` 级别都被视为 `on`（映射到 `low`）。
  - Moonshot (`moonshot/*`) 将 `/think off` 映射到 `thinking: { type: "disabled" }`，任何非 `off` 级别映射到 `thinking: { type: "enabled" }`。当启用思考时，Moonshot 仅接受 `tool_choice` `auto|none`；OpenClaw 将不兼容的值标准化为 `auto`。

## 解析顺序

1. 消息上的内联指令（仅适用于该消息）。
2. 会话覆盖（通过发送仅包含指令的消息设置）。
3. 每个代理的默认值（配置中的 `agents.list[].thinkingDefault`）。
4. 全局默认值（配置中的 `agents.defaults.thinkingDefault`）。
5. 回退：Anthropic Claude 4.6 模型为 `adaptive`，Anthropic Claude Opus 4.7 为 `off`（除非明确配置），其他支持推理的模型为 `low`，否则为 `off`。

## 设置会话默认值

- 发送**仅**包含指令的消息（允许空白），例如 `/think:medium` 或 `/t high`。
- 这会在当前会话中保持（默认按发送者）；通过 `/think:off` 或会话空闲重置清除。
- 发送确认回复（`Thinking level set to high.` / `Thinking disabled.`）。如果级别无效（例如 `/thinking big`），命令会被拒绝并带有提示，会话状态保持不变。
- 发送 `/think`（或 `/think:`）无参数以查看当前思考级别。

## 由代理应用

- **嵌入式 Pi**：解析的级别传递给进程内 Pi 代理运行时。

## 快速模式（/fast）

- 级别：`on|off`。
- 仅指令消息切换会话快速模式覆盖并回复 `Fast mode enabled.` / `Fast mode disabled.`。
- 发送 `/fast`（或 `/fast status`）无模式以查看当前有效的快速模式状态。
- OpenClaw 按以下顺序解析快速模式：
  1. 内联/仅指令 `/fast on|off`
  2. 会话覆盖
  3. 每个代理的默认值（`agents.list[].fastModeDefault`）
  4. 每个模型配置：`agents.defaults.models["<provider>/<model>"].params.fastMode`
  5. 回退：`off`
- 对于 `openai/*`，快速模式通过在支持的 Responses 请求上发送 `service_tier=priority` 映射到 OpenAI 优先处理。
- 对于 `openai-codex/*`，快速模式在 Codex Responses 上发送相同的 `service_tier=priority` 标志。OpenClaw 在两个认证路径上保持一个共享的 `/fast` 切换。
- 对于直接的公共 `anthropic/*` 请求，包括发送到 `api.anthropic.com` 的 OAuth 认证流量，快速模式映射到 Anthropic 服务层级：`/fast on` 设置 `service_tier=auto`，`/fast off` 设置 `service_tier=standard_only`。
- 对于 Anthropic 兼容路径上的 `minimax/*`，`/fast on`（或 `params.fastMode: true`）将 `MiniMax-M2.7` 重写为 `MiniMax-M2.7-highspeed`。
- 当同时设置时，显式的 Anthropic `serviceTier` / `service_tier` 模型参数覆盖快速模式默认值。对于非 Anthropic 代理基础 URL，OpenClaw 仍然跳过 Anthropic 服务层级注入。

## 详细指令（/verbose 或 /v）

- 级别：`on`（最小）| `full` | `off`（默认）。
- 仅指令消息切换会话详细模式并回复 `Verbose logging enabled.` / `Verbose logging disabled.`；无效级别返回提示而不更改状态。
- `/verbose off` 存储显式会话覆盖；通过 Sessions UI 选择 `inherit` 清除它。
- 内联指令仅影响该消息；否则应用会话/全局默认值。
- 发送 `/verbose`（或 `/verbose:`）无参数以查看当前详细级别。
- 当详细模式开启时，发出结构化工具结果的代理（Pi、其他 JSON 代理）将每个工具调用作为自己的仅元数据消息发送，当可用时（路径/命令）前缀为 `<emoji> <tool-name>: <arg>`。这些工具摘要在每个工具开始时发送（单独的气泡），而不是作为流式增量。
- 工具失败摘要在正常模式下仍然可见，但原始错误详细信息后缀被隐藏，除非详细模式为 `on` 或 `full`。
- 当详细模式为 `full` 时，工具输出也会在完成后转发（单独的气泡，截断到安全长度）。如果您在运行进行中切换 `/verbose on|full|off`，后续的工具气泡将遵循新设置。

## 插件跟踪指令（/trace）

- 级别：`on` | `off`（默认）。
- 仅指令消息切换会话插件跟踪输出并回复 `Plugin trace enabled.` / `Plugin trace disabled.`。
- 内联指令仅影响该消息；否则应用会话/全局默认值。
- 发送 `/trace`（或 `/trace:`）无参数以查看当前跟踪级别。
- `/trace` 比 `/verbose` 更窄：它仅公开插件拥有的跟踪/调试行，例如 Active Memory 调试摘要。
- 跟踪行可以出现在 `/status` 中，并作为正常助手回复后的后续诊断消息。

## 推理可见性（/reasoning）

- 级别：`on|off|stream`。
- 仅指令消息切换思考块是否在回复中显示。
- 启用时，推理作为**单独的消息**发送，前缀为 `Reasoning:`。
- `stream`（仅 Telegram）：在回复生成时将推理流式传输到 Telegram 草稿气泡中，然后发送最终答案而不包含推理。
- 别名：`/reason`。
- 发送 `/reasoning`（或 `/reasoning:`）无参数以查看当前推理级别。
- 解析顺序：内联指令，然后是会话覆盖，然后是每个代理的默认值（`agents.list[].reasoningDefault`），然后是回退（`off`）。

## 相关

- 提升模式文档位于 [提升模式](/tools/elevated)。

## 心跳

- 心跳探测体是配置的心跳提示（默认：`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`）。心跳消息中的内联指令照常应用（但避免从心跳更改会话默认值）。
- 心跳传递默认为仅最终有效载荷。要在可用时也发送单独的 `Reasoning:` 消息，请设置 `agents.defaults.heartbeat.includeReasoning: true` 或每个代理的 `agents.list[].heartbeat.includeReasoning: true`。

## 网络聊天 UI

- 网络聊天思考选择器在页面加载时从入站会话存储/配置中镜像会话的存储级别。
- 选择另一个级别会立即通过 `sessions.patch` 写入会话覆盖；它不会等待下一次发送，也不是一次性的 `thinkingOnce` 覆盖。
- 第一个选项始终是 `Default (<resolved level>)`，其中解析的默认值来自活动会话模型：Anthropic 上的 Claude 4.6 为 `adaptive`，Anthropic Claude Opus 4.7 为 `off`（除非配置），其他支持推理的模型为 `low`，否则为 `off`。
- 选择器保持提供者感知：
  - 大多数提供者显示 `off | minimal | low | medium | high | adaptive`
  - Anthropic Claude Opus 4.7 显示 `off | minimal | low | medium | high | xhigh | adaptive`
  - Z.AI 显示二元 `off | on`
- `/think:<level>` 仍然有效并更新相同的存储会话级别，因此聊天指令和选择器保持同步。