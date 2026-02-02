---
last_updated: "2026-01-05"
owner: openclaw
status: complete
summary: 加固 cron.add 输入处理，对齐 schema，并改进 cron UI/智能体工具
title: Cron Add 加固
x-i18n:
  generated_at: "2026-02-01T20:25:08Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d7e469674bd9435b846757ea0d5dc8f174eaa8533917fc013b1ef4f82859496d
  source_path: experiments/plans/cron-add-hardening.md
  workflow: 14
---

# Cron Add 加固与 Schema 对齐

## 背景

近期 Gateway网关日志显示 `cron.add` 反复因无效参数（缺少 `sessionTarget`、`wakeMode`、`payload` 以及格式错误的 `schedule`）而失败。这表明至少有一个客户端（可能是智能体工具调用路径）正在发送包装过的或部分指定的任务载荷。此外，TypeScript、Gateway网关 schema、CLI 标志和 UI 表单类型之间的 cron 提供商枚举存在偏差，同时 `cron.status` 的 UI 也存在不匹配问题（期望 `jobCount`，而 Gateway网关返回的是 `jobs`）。

## 目标

- 通过标准化常见的包装载荷并推断缺失的 `kind` 字段，消除 `cron.add` 的 INVALID_REQUEST 错误。
- 在 Gateway网关 schema、cron 类型、CLI 文档和 UI 表单之间对齐 cron 提供商列表。
- 明确智能体 cron 工具 schema，使 LLM 生成正确的任务载荷。
- 修复 Control UI 中 cron 状态的任务计数显示。
- 添加测试以覆盖标准化和工具行为。

## 非目标

- 更改 cron 调度语义或任务执行行为。
- 添加新的调度类型或 cron 表达式解析。
- 在必要的字段修复之外全面改造 cron 的 UI/UX。

## 发现（当前差距）

- Gateway网关中的 `CronPayloadSchema` 不包含 `signal` + `imessage`，而 TS 类型中包含它们。
- Control UI 的 CronStatus 期望 `jobCount`，但 Gateway网关返回的是 `jobs`。
- 智能体 cron 工具 schema 允许任意 `job` 对象，导致格式错误的输入。
- Gateway网关严格验证 `cron.add` 且不进行标准化，因此包装过的载荷会失败。

## 变更内容

- `cron.add` 和 `cron.update` 现在会标准化常见的包装结构并推断缺失的 `kind` 字段。
- 智能体 cron 工具 schema 与 Gateway网关 schema 保持一致，减少了无效载荷。
- 提供商枚举已在 Gateway网关、CLI、UI 和 macOS 选择器之间对齐。
- Control UI 使用 Gateway网关的 `jobs` 计数字段显示状态。

## 当前行为

- **标准化：** 包装的 `data`/`job` 载荷会被解包；在安全的情况下推断 `schedule.kind` 和 `payload.kind`。
- **默认值：** 当 `wakeMode` 和 `sessionTarget` 缺失时，应用安全的默认值。
- **提供商：** Discord/Slack/Signal/iMessage 现在在 CLI/UI 中一致地显示。

请参阅 [Cron 任务](/automation/cron-jobs) 了解标准化后的结构和示例。

## 验证

- 监控 Gateway网关日志，确认 `cron.add` INVALID_REQUEST 错误已减少。
- 确认 Control UI 的 cron 状态在刷新后显示任务计数。

## 可选后续工作

- 手动 Control UI 冒烟测试：为每个提供商添加一个 cron 任务，并验证状态任务计数。

## 待解决问题

- `cron.add` 是否应接受客户端显式指定的 `state`（目前被 schema 禁止）？
- 是否应允许 `webchat` 作为显式的投递提供商（目前在投递解析中被过滤）？
