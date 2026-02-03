---
read_when:
  - 添加或修改后台 exec 行为
  - 调试长时间运行的 exec 任务
summary: 后台 exec 执行与进程管理
title: 后台 Exec 与 Process 工具
x-i18n:
  generated_at: "2026-02-01T20:25:21Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: e11a7d74a75000d6882f703693c2c49a2ecd3e730b6ec2b475ac402abde9e465
  source_path: gateway/background-process.md
  workflow: 14
---

# 后台 Exec + Process 工具

OpenClaw 通过 `exec` 工具运行 shell 命令，并将长时间运行的任务保存在内存中。`process` 工具用于管理这些后台会话。

## exec 工具

关键参数：

- `command`（必填）
- `yieldMs`（默认 10000）：超过此延迟后自动转为后台运行
- `background`（布尔值）：立即转入后台
- `timeout`（秒，默认 1800）：超时后终止进程
- `elevated`（布尔值）：如果提权模式已启用/允许，则在宿主机上运行
- 需要真实 TTY？设置 `pty: true`。
- `workdir`、`env`

行为：

- 前台运行直接返回输出。
- 转入后台时（显式指定或超时触发），工具返回 `status: "running"` + `sessionId` 以及末尾的少量输出。
- 输出保存在内存中，直到会话被轮询或清除。
- 如果 `process` 工具被禁用，`exec` 将同步运行并忽略 `yieldMs`/`background`。

## 子进程桥接

在 exec/process 工具之外启动长时间运行的子进程时（例如 CLI 重启或 Gateway网关辅助进程），请挂载子进程桥接助手，以便终止信号能被正确转发，并在退出/出错时分离监听器。这可以避免在 systemd 上产生孤儿进程，并保持跨平台的关闭行为一致性。

环境变量覆盖：

- `PI_BASH_YIELD_MS`：默认 yield 时间（毫秒）
- `PI_BASH_MAX_OUTPUT_CHARS`：内存输出上限（字符数）
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`：每个流的待处理 stdout/stderr 上限（字符数）
- `PI_BASH_JOB_TTL_MS`：已完成会话的 TTL（毫秒，限制在 1 分钟到 3 小时之间）

配置（推荐方式）：

- `tools.exec.backgroundMs`（默认 10000）
- `tools.exec.timeoutSec`（默认 1800）
- `tools.exec.cleanupMs`（默认 1800000）
- `tools.exec.notifyOnExit`（默认 true）：后台 exec 退出时，加入系统事件队列并请求心跳。

## process 工具

操作：

- `list`：列出正在运行和已完成的会话
- `poll`：获取会话的新输出（同时报告退出状态）
- `log`：读取聚合输出（支持 `offset` + `limit`）
- `write`：发送 stdin（`data`，可选 `eof`）
- `kill`：终止后台会话
- `clear`：从内存中移除已完成的会话
- `remove`：如果正在运行则终止，如果已完成则清除

注意事项：

- 只有后台会话会被列出/保留在内存中。
- 进程重启后会话会丢失（无磁盘持久化）。
- 会话日志仅在你运行 `process poll/log` 且工具结果被记录时，才会保存到聊天历史中。
- `process` 的作用域为单个智能体；它只能看到该智能体启动的会话。
- `process list` 包含一个派生的 `name`（命令动词 + 目标），方便快速浏览。
- `process log` 使用基于行的 `offset`/`limit`（省略 `offset` 可获取最后 N 行）。

## 示例

运行一个长任务，稍后轮询：

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

立即在后台启动：

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

发送 stdin：

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
