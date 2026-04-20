---
summary: "后台执行和进程管理"
read_when:
  - 添加或修改后台执行行为
  - 调试长时间运行的执行任务
title: "后台执行和进程工具"
---

# 后台执行 + 进程工具

OpenClaw 通过 `exec` 工具运行 shell 命令，并将长时间运行的任务保存在内存中。`process` 工具管理这些后台会话。

## exec 工具

关键参数：

- `command`（必需）
- `yieldMs`（默认 10000）：在此延迟后自动后台运行
- `background`（布尔值）：立即后台运行
- `timeout`（秒，默认 1800）：在此超时后终止进程
- `elevated`（布尔值）：如果启用/允许提升模式，则在沙箱外运行（默认为 `gateway`，或当执行目标为 `node` 时为 `node`）
- 需要真实 TTY？设置 `pty: true`。
- `workdir`、`env`

行为：

- 前台运行直接返回输出。
- 当后台运行时（显式或超时），工具返回 `status: "running"` + `sessionId` 和一个短尾输出。
- 输出保存在内存中，直到会话被轮询或清除。
- 如果 `process` 工具被禁用，`exec` 同步运行并忽略 `yieldMs`/`background`。
- 生成的执行命令接收 `OPENCLAW_SHELL=exec` 以用于上下文感知的 shell/配置文件规则。
- 对于现在开始的长时间工作，启动一次并依赖自动完成唤醒（当它启用且命令发出输出或失败时）。
- 如果自动完成唤醒不可用，或者您需要对干净退出且无输出的命令进行静默成功确认，请使用 `process` 确认完成。
- 不要使用 `sleep` 循环或重复轮询来模拟提醒或延迟跟进；对未来工作使用 cron。

## 子进程桥接

当在 exec/process 工具之外生成长时间运行的子进程时（例如，CLI 重新生成或网关助手），附加子进程桥接助手，以便终止信号被转发，并且监听器在退出/错误时被分离。这避免了 systemd 上的孤立进程，并在跨平台保持一致的关闭行为。

环境覆盖：

- `PI_BASH_YIELD_MS`：默认 yield（毫秒）
- `PI_BASH_MAX_OUTPUT_CHARS`：内存输出上限（字符）
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`：每个流的待处理 stdout/stderr 上限（字符）
- `PI_BASH_JOB_TTL_MS`：已完成会话的 TTL（毫秒，限制为 1m–3h）

配置（首选）：

- `tools.exec.backgroundMs`（默认 10000）
- `tools.exec.timeoutSec`（默认 1800）
- `tools.exec.cleanupMs`（默认 1800000）
- `tools.exec.notifyOnExit`（默认 true）：当后台执行退出时，入队系统事件 + 请求心跳。
- `tools.exec.notifyOnExitEmptySuccess`（默认 false）：当为 true 时，还会为产生无输出的成功后台运行入队完成事件。

## process 工具

操作：

- `list`：运行中 + 已完成的会话
- `poll`：排出会话的新输出（也报告退出状态）
- `log`：读取聚合输出（支持 `offset` + `limit`）
- `write`：发送 stdin（`data`，可选 `eof`）
- `send-keys`：向 PTY 支持的会话发送显式按键令牌或字节
- `submit`：向 PTY 支持的会话发送 Enter / 回车
- `paste`：发送文字文本，可选包装在括号粘贴模式中
- `kill`：终止后台会话
- `clear`：从内存中删除已完成的会话
- `remove`：如果运行则终止，否则如果已完成则清除

注意：

- 只有后台会话在内存中列出/持久化。
- 会话在进程重启时丢失（无磁盘持久化）。
- 会话日志仅在您运行 `process poll/log` 且工具结果被记录时保存到聊天历史中。
- `process` 按每个代理作用域；它只看到该代理启动的会话。
- 使用 `poll` / `log` 获取状态、日志、静默成功确认，或在自动完成唤醒不可用时确认完成。
- 当您需要输入或干预时，使用 `write` / `send-keys` / `submit` / `paste` / `kill`。
- `process list` 包含派生的 `name`（命令动词 + 目标）以便快速扫描。
- `process log` 使用基于行的 `offset`/`limit`。
- 当 `offset` 和 `limit` 都被省略时，它返回最后 200 行并包含分页提示。
- 当提供 `offset` 但省略 `limit` 时，它返回从 `offset` 到末尾（不限制为 200）。
- 轮询用于按需状态，而不是等待循环调度。如果工作应该稍后发生，请改用 cron。

## 示例

运行长任务并稍后轮询：

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

发送 PTY 按键：

```json
{ "tool": "process", "action": "send-keys", "sessionId": "<id>", "keys": ["C-c"] }
```

提交当前行：

```json
{ "tool": "process", "action": "submit", "sessionId": "<id>" }
```

粘贴文字文本：

```json
{ "tool": "process", "action": "paste", "sessionId": "<id>", "text": "line1\nline2\n" }
```