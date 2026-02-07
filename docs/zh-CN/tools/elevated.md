---
read_when:
  - 调整提升模式默认值、允许列表或斜杠命令行为
summary: 提升的 exec 模式和 /elevated 指令
title: 提升模式
x-i18n:
  generated_at: "2026-02-03T07:55:23Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 83767a01609304026d145feb0aa0b0533e8cf8b16cd200f724d9e3e8cf2920c3
  source_path: tools/elevated.md
  workflow: 15
---

# 提升模式（/elevated 指令）

## 功能说明

- `/elevated on` 在 Gateway 网关主机上运行并保留 exec 审批（与 `/elevated ask` 相同）。
- `/elevated full` 在 Gateway 网关主机上运行**并**自动批准 exec（跳过 exec 审批）。
- `/elevated ask` 在 Gateway 网关主机上运行但保留 exec 审批（与 `/elevated on` 相同）。
- `on`/`ask` **不会**强制 `exec.security=full`；配置的安全/询问策略仍然适用。
- 仅在智能体被**沙箱隔离**时改变行为（否则 exec 已经在主机上运行）。
- 指令形式：`/elevated on|off|ask|full`、`/elev on|off|ask|full`。
- 仅接受 `on|off|ask|full`；其他任何内容返回提示且不改变状态。

## 它控制什么（以及不控制什么）

- **可用性门控**：`tools.elevated` 是全局基线。`agents.list[].tools.elevated` 可以进一步限制每个智能体的提升（两者都必须允许）。
- **每会话状态**：`/elevated on|off|ask|full` 为当前会话键设置提升级别。
- **内联指令**：消息内的 `/elevated on|ask|full` 仅适用于该消息。
- **群组**：在群聊中，仅当智能体被提及时才遵守提升指令。绕过提及要求的纯命令消息被视为已提及。
- **主机执行**：elevated 强制 `exec` 到 Gateway 网关主机；`full` 还设置 `security=full`。
- **审批**：`full` 跳过 exec 审批；`on`/`ask` 在允许列表/询问规则要求时遵守审批。
- **非沙箱隔离智能体**：对位置无影响；仅影响门控、日志和状态。
- **工具策略仍然适用**：如果 `exec` 被工具策略拒绝，则无法使用 elevated。
- **与 `/exec` 分开**：`/exec` 为授权发送者调整每会话默认值，不需要 elevated。

## 解析顺序

1. 消息上的内联指令（仅适用于该消息）。
2. 会话覆盖（通过发送仅含指令的消息设置）。
3. 全局默认值（配置中的 `agents.defaults.elevatedDefault`）。

## 设置会话默认值

- 发送一条**仅**包含指令的消息（允许空白），例如 `/elevated full`。
- 发送确认回复（`Elevated mode set to full...` / `Elevated mode disabled.`）。
- 如果 elevated 访问被禁用或发送者不在批准的允许列表中，指令会回复一个可操作的错误且不改变会话状态。
- 发送不带参数的 `/elevated`（或 `/elevated:`）以查看当前的 elevated 级别。

## 可用性 + 允许列表

- 功能门控：`tools.elevated.enabled`（即使代码支持，也可以通过配置将默认值设为关闭）。
- 发送者允许列表：`tools.elevated.allowFrom`，带有每提供商允许列表（例如 `discord`、`whatsapp`）。
- 每智能体门控：`agents.list[].tools.elevated.enabled`（可选；只能进一步限制）。
- 每智能体允许列表：`agents.list[].tools.elevated.allowFrom`（可选；设置时，发送者必须同时匹配全局 + 每智能体允许列表）。
- Discord 回退：如果省略 `tools.elevated.allowFrom.discord`，则使用 `channels.discord.dm.allowFrom` 列表作为回退。设置 `tools.elevated.allowFrom.discord`（即使是 `[]`）以覆盖。每智能体允许列表**不**使用回退。
- 所有门控都必须通过；否则 elevated 被视为不可用。

## 日志 + 状态

- Elevated exec 调用以 info 级别记录。
- 会话状态包括 elevated 模式（例如 `elevated=ask`、`elevated=full`）。
