---
last_updated: "2026-01-05"
owner: openclaw
status: complete
summary: 加固 cron.add 输入处理，对齐 schema，改进 cron UI/智能体工具
title: Cron Add 加固
x-i18n:
  generated_at: "2026-02-03T07:47:26Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d7e469674bd9435b846757ea0d5dc8f174eaa8533917fc013b1ef4f82859496d
  source_path: experiments/plans/cron-add-hardening.md
  workflow: 15
---

# Cron Add 加固 & Schema 对齐

## 背景

最近的 Gateway 网关日志显示重复的 `cron.add` 失败，参数无效（缺少 `sessionTarget`、`wakeMode`、`payload`，以及格式错误的 `schedule`）。这表明至少有一个客户端（可能是智能体工具调用路径）正在发送包装的或部分指定的任务负载。另外，TypeScript 中的 cron 提供商枚举、Gateway 网关 schema、CLI 标志和 UI 表单类型之间存在漂移，加上 `cron.status` 的 UI 不匹配（期望 `jobCount` 而 Gateway 网关返回 `jobs`）。

## 目标

- 通过规范化常见的包装负载并推断缺失的 `kind` 字段来停止 `cron.add` INVALID_REQUEST 垃圾。
- 在 Gateway 网关 schema、cron 类型、CLI 文档和 UI 表单之间对齐 cron 提供商列表。
- 使智能体 cron 工具 schema 明确，以便 LLM 生成正确的任务负载。
- 修复 Control UI cron 状态任务计数显示。
- 添加测试以覆盖规范化和工具行为。

## 非目标

- 更改 cron 调度语义或任务执行行为。
- 添加新的调度类型或 cron 表达式解析。
- 除了必要的字段修复外，不大改 cron 的 UI/UX。

## 发现（当前差距）

- Gateway 网关中的 `CronPayloadSchema` 排除了 `signal` + `imessage`，而 TS 类型包含它们。
- Control UI CronStatus 期望 `jobCount`，但 Gateway 网关返回 `jobs`。
- 智能体 cron 工具 schema 允许任意 `job` 对象，导致格式错误的输入。
- Gateway 网关严格验证 `cron.add` 而不进行规范化，因此包装的负载会失败。

## 变更内容

- `cron.add` 和 `cron.update` 现在规范化常见的包装形式并推断缺失的 `kind` 字段。
- 智能体 cron 工具 schema 与 Gateway 网关 schema 匹配，减少无效负载。
- 提供商枚举在 Gateway 网关、CLI、UI 和 macOS 选择器之间对齐。
- Control UI 使用 Gateway 网关的 `jobs` 计数字段显示状态。

## 当前行为

- **规范化：**包装的 `data`/`job` 负载被解包；`schedule.kind` 和 `payload.kind` 在安全时被推断。
- **默认值：**当缺失时，为 `wakeMode` 和 `sessionTarget` 应用安全默认值。
- **提供商：**Discord/Slack/Signal/iMessage 现在在 CLI/UI 中一致显示。

参见 [Cron 任务](/automation/cron-jobs) 了解规范化的形式和示例。

## 验证

- 观察 Gateway 网关日志中 `cron.add` INVALID_REQUEST 错误是否减少。
- 确认 Control UI cron 状态在刷新后显示任务计数。

## 可选后续工作

- 手动 Control UI 冒烟测试：为每个提供商添加一个 cron 任务 + 验证状态任务计数。

## 开放问题

- `cron.add` 是否应该接受来自客户端的显式 `state`（当前被 schema 禁止）？
- 我们是否应该允许 `webchat` 作为显式投递提供商（当前在投递解析中被过滤）？
