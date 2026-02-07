---
read_when:
  - 添加或修改后台 exec 行为
  - 调试长时间运行的 exec 任务
summary: 后台 exec 执行和进程管理
title: 后台 Exec 和 Process 工具
x-i18n:
  generated_at: "2026-02-03T10:05:51Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: e11a7d74a75000d6882f703693c2c49a2ecd3e730b6ec2b475ac402abde9e465
  source_path: gateway/background-process.md
  workflow: 15
---

# 后台 Exec + Process 工具

OpenClaw 通过 `exec` 工具运行 shell 命令，并将长时间运行的任务保存在内存中。`process` 工具管理这些后台会话。

## exec 工具

关键参数：

- `command`（必填）
- `yieldMs`（默认 10000）：在此延迟后自动转为后台运行
- `background`（布尔值）：立即转为后台运行
- `timeout`（秒，默认 1800）：在此超时后终止进程
- `elevated`（布尔值）：如果启用/允许提权模式，则在宿主机上运行
- 需要真实 TTY？设置 `pty: true`。
- `workdir`、`env`

行为：

- 前台运行直接返回输出。
- 当转为后台运行（显式或超时）时，工具返回 `status: "running"` + `sessionId` 和一小段尾部输出。
- 输出保存在内存中，直到会话被轮询或清除。
- 如果 `process` 工具被禁用，`exec` 将同步运行并忽略 `yieldMs`/`background`。

## 子进程桥接

当在 exec/process 工具之外生成长时间运行的子进程时（例如 CLI 重新生成或 Gateway 网关辅助程序），请附加子进程桥接辅助程序，以便终止信号被转发，监听器在退出/错误时被分离。这可以避免在 systemd 上产生孤立进程，并保持跨平台的关闭行为一致。

环境变量覆盖：

- `PI_BASH_YIELD_MS`：默认 yield 时间（毫秒）
- `PI_BASH_MAX_OUTPUT_CHARS`：内存输出上限（字符）
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`：每个流的待处理 stdout/stderr 上限（字符）
- `PI_BASH_JOB_TTL_MS`：已完成会话的 TTL（毫秒，限制在 1 分钟至 3 小时之间）

配置（推荐）：

- `tools.exec.backgroundMs`（默认 10000）
- `tools.exec.timeoutSec`（默认 1800）
- `tools.exec.cleanupMs`（默认 1800000）
- `tools.exec.notifyOnExit`（默认 true）：当后台 exec 退出时，将系统事件加入队列并请求心跳。

## process 工具

操作：

- `list`：正在运行和已完成的会话
- `poll`：获取会话的新输出（同时报告退出状态）
- `log`：读取聚合输出（支持 `offset` + `limit`）
- `write`：发送 stdin（`data`，可选 `eof`）
- `kill`：终止后台会话
- `clear`：从内存中移除已完成的会话
- `remove`：如果正在运行则终止，否则清除已完成的会话

注意事项：

- 只有后台会话会在内存中列出/保留。
- 会话在进程重启时会丢失（无磁盘持久化）。
- 会话日志只有在你运行 `process poll/log` 且工具结果被记录时才会保存到聊天历史。
- `process` 按智能体隔离；它只能看到该智能体启动的会话。
- `process list` 包含派生的 `name`（命令动词 + 目标）以便快速浏览。
- `process log` 使用基于行的 `offset`/`limit`（省略 `offset` 以获取最后 N 行）。

## 示例

运行长时间任务并稍后轮询：

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
