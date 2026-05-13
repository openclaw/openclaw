# Recovery Guide

`dws` 的 recovery 闭环以 `dws recovery execute` 为正式入口。主入口仍是 [SKILL.md](../SKILL.md)，错误分类与排查细节可结合 [error-codes.md](./error-codes.md) 和 [global-reference.md](./global-reference.md) 一起使用。

## 标准流程

1. 原始 `dws` 命令失败后，从 stderr 提取 `RECOVERY_EVENT_ID=<event_id>`
2. 执行 `dws recovery execute --event-id <event_id> --format json`
3. 读取返回的 `RecoveryBundle`
4. 先查看 `plan.decision_owner`
5. 当 `decision_owner == "agent"` 时，把完整 `RecoveryBundle` 视为事实包，由 Agent 基于事实包、对应产品文档和 `dws` skill 做整体判断，再决定是否组织下一次 grounded 的 `dws` 恢复尝试
6. 恢复尝试结束后，执行 `dws recovery finalize --event-id <event_id> --outcome recovered|failed|handoff --execution-file <file.json> --format json`

CLI 会把 recovery 过程文件保存在 `DWS_CONFIG_DIR/recovery/` 下，并自动清理 30 天前的旧文件与旧事件记录。

## 如何阅读 `RecoveryBundle`

`RecoveryBundle` 重点字段：

- `status`：`needs_agent_action` 或 `analysis_failed`
- `context`：原始失败上下文
- `replay`：可重放的脱敏命令信息和工具参数
- `plan`：规则分类、`decision_owner`、`agent_route`、`doc_search`、`kb_hits`、`doc_actions`、`human_actions`
- `doc_search.request`：CLI 实际发起的开放平台文档检索请求参数
- `doc_search.response`：CLI 收到的原始文档检索返回内容块
- `probe_results`：CLI 已完成的只读探测和上下文审计结果
- `agent_task`：给 Agent 的明确工作单
- `finalize_hint`：最终必须回写的 `finalize` 命令模板和 `execution-file` 要求

当 `status == "analysis_failed"` 时，不要假设 CLI 已经修复问题；应先读取 `analysis_error`、`doc_search`、`probe_results`，再判断是否还能继续 grounded 尝试。

当 `plan.decision_owner == "agent"` 时：

- 必须把 CLI 返回内容视为事实包，而不是已定案的恢复结论
- 优先基于完整 `RecoveryBundle` 做判断；若只能读取 `agent_route.payload`，也必须使用其中的 `context`、`replay`、`doc_search`、`kb_hits`、`doc_actions`、`probe_results`
- unknown 场景里，不要把 `should_retry`、`should_stop`、`human_actions` 当作 CLI 已经替 Agent 作出的最终决定

## Agent 允许做什么

- 读取 [global-reference.md](./global-reference.md)、[error-codes.md](./error-codes.md) 和对应产品文档
- 基于完整 `RecoveryBundle`，尤其是 `doc_actions`、`kb_hits`、`probe_results`、`context`、`replay` 做整体判断
- 仅在依据明确时重新发起新的 `dws` 命令
- 将真实尝试过程记录进 `execution-file`，再调用 `finalize`

## Agent 禁止做什么

- 编造 taskId、recordId、threadId、UUID、token、URL 或其他业务参数
- 绕过 `dws` 改用 curl、HTTP API、浏览器或其他未授权手段
- 未确认前把失败命令替换成另一套业务流程
- 因为 `human_actions` 里提到用户步骤，就跳过 bundle 里的其余分析信息

## `execution-file` 最小要求

`execution-file` 必须至少包含：

- `actions`
- `attempts`
- `result`
- `error_summary`

`attempts` 是数组，每次尝试至少记录：

- `command_summary`
- `result`
- `error_summary`
- `source`

兼容旧格式：

- `action` 会被归一化成单元素 `actions`
- 数值型 `attempts` 会被展开为 `legacy_execution_file` 来源的 attempts 记录
- `error` 会被归一化到 `error_summary`

## unknown 参数错误处理

如果 `execute` 进入 unknown 场景，且 `probe_results` 已给出 CLI 检查过的上下文来源，Agent 应：

- 先检查上一步输出、已有上下文、产品文档或 `probe_results` 里是否存在真实参数来源
- 若没有可靠来源，就回写 `handoff`
- 不要盲猜新的 ID、UUID、URL、token 或其他业务参数

对应标准闭环：

```bash
dws recovery execute --event-id <event_id> --format json
dws recovery finalize --event-id <event_id> --outcome handoff --execution-file execution.json --format json
```

## 必读参考

- [error-codes.md](./error-codes.md)
- [global-reference.md](./global-reference.md)
- [intent-guide.md](./intent-guide.md)
- [products/](./products/)
