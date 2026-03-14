# runtime="claude-code" 使用说明

## 概述

`runtime="claude-code"` 是 openclaw 的新运行时选项，允许在独立的工作空间会话中异步执行 Claude Code CLI 任务。

## 与其他 runtime 的对比

| 特性         | subagent   | acp  | claude-code   |
| ------------ | ---------- | ---- | ------------- |
| 执行方式     | 同步       | 异步 | 异步          |
| 工作空间隔离 | 继承父进程 | 独立 | 独立 (按 cwd) |
| 会话持久化   | 否         | 是   | 是            |
| 并发支持     | 受限       | 受限 | 完全支持      |
| 附件支持     | 是         | 否   | 否            |

## 基本用法

### 工具调用

```
sessions_spawn(
  task: "你的任务描述",
  runtime: "claude-code",
  cwd: "/path/to/workspace",
  mode: "run" | "session",
  label: "可选标签",
  timeoutSeconds: 300
)
```

### 参数说明

| 参数             | 类型    | 必需 | 说明                                  |
| ---------------- | ------- | ---- | ------------------------------------- |
| `task`           | string  | ✅   | 要执行的任务描述                      |
| `runtime`        | string  | ✅   | 固定为 `"claude-code"`                |
| `cwd`            | string  | ❌   | 工作目录，默认当前目录                |
| `mode`           | string  | ❌   | `"run"` 一次性 / `"session"` 持久会话 |
| `label`          | string  | ❌   | 任务标签，用于识别                    |
| `timeoutSeconds` | number  | ❌   | 超时时间（秒）                        |
| `thread`         | boolean | ❌   | 是否恢复已有会话                      |

## 工作原理

### 会话隔离

每个 `cwd` 对应一个独立的 Claude Code 会话：

```
cwd: /project/A  →  session: agent:claude-code:workspace:a1b2c3d4
cwd: /project/B  →  session: agent:claude-code:workspace:e5f6g7h8
```

相同 `cwd` 的后续调用会复用已有会话（当 `thread=true` 或 `mode="session"` 时）。

### 执行流程

1. **注册任务** → 生成 `runId`
2. **解析会话** → 按工作空间创建/复用会话
3. **启动进程** → 调用 `claude` CLI
4. **异步执行** → 父进程不阻塞
5. **结果回调** → 完成后通知

## 使用场景

### 场景 1：一次性任务

```
sessions_spawn(
  task: "分析代码库结构并生成 README",
  runtime: "claude-code",
  cwd: "/home/user/my-project",
  mode: "run"
)
```

执行完成后会话自动清理。

### 场景 2：持续会话

```
# 首次调用
sessions_spawn(
  task: "帮我实现用户认证功能",
  runtime: "claude-code",
  cwd: "/home/user/my-project",
  mode: "session"
)

# 后续调用（继续同一会话）
sessions_spawn(
  task: "现在添加密码重置功能",
  runtime: "claude-code",
  cwd: "/home/user/my-project",
  thread: true
)
```

会话会保持，可跨多次调用。

### 场景 3：并行任务

```
# 同时启动多个独立任务
sessions_spawn(task: "修复 bug #123", runtime: "claude-code", cwd: "/project/A")
sessions_spawn(task: "实现 feature #456", runtime: "claude-code", cwd: "/project/B")
sessions_spawn(task: "编写测试用例", runtime: "claude-code", cwd: "/project/C")
```

## 返回值

```json
{
  "status": "accepted",
  "childSessionKey": "agent:claude-code:workspace:a1b2c3d4",
  "runId": "550e8400-e29b-41d4-a716-446655440000",
  "mode": "run",
  "note": "Claude Code task queued in isolated workspace session; results will be announced when complete."
}
```

| 字段              | 说明                               |
| ----------------- | ---------------------------------- |
| `status`          | `accepted` / `forbidden` / `error` |
| `childSessionKey` | 子会话标识                         |
| `runId`           | 任务 ID，用于追踪                  |
| `mode`            | 实际执行模式                       |
| `note`            | 状态说明                           |

## 限制

1. **沙箱环境限制**：沙箱会话无法调用 `claude-code`（需要主机环境）
2. **附件不支持**：暂不支持传递附件
3. **需要 Claude CLI**：系统需安装 `claude` 命令行工具

## 配置

可在 `openclaw.config.toml` 中自定义：

```toml
[agents.defaults.cliBackends.claude-code]
command = "claude"
args = ["--non-interactive", "--output-format", "json", "--permission-mode", "bypassPermissions"]
```

## 会话延续机制

### 工作原理

当使用 `thread=true` 或 `mode="session"` 时，系统会尝试恢复已有的 Claude Code 会话：

1. **查找会话**：根据 `cwd` 路径查找已存储的 Claude Session ID
2. **恢复会话**：使用 `--resume` 参数恢复对话上下文
3. **保存会话**：执行完成后更新会话信息

### 关键区别

| 参数           | 用途                     | 上下文   |
| -------------- | ------------------------ | -------- |
| `--session-id` | 创建新会话时指定 ID      | 全新会话 |
| `--resume`     | 恢复已有会话，保留上下文 | 延续会话 |

**重要**：只有使用 `--resume` 才能真正恢复会话上下文。`--session-id` 只是给新会话指定一个 ID，不会保留之前的对话记忆。

### 验证会话延续

```bash
# 第一次调用
sessions_spawn(
  task: "记住数字 123",
  runtime: "claude-code",
  cwd: "/tmp/test-project",
  mode: "session"
)

# 第二次调用（应该记得 123）
sessions_spawn(
  task: "我之前让你记住的数字是什么？",
  runtime: "claude-code",
  cwd: "/tmp/test-project",
  thread: true
)
```

如果会话延续正常工作，第二次调用应该能正确回答 "123"。

### 会话存储位置

Claude CLI 的会话 ID 映射存储在：

```
~/.openclaw/claude-code-sessions.json
```

每个工作空间路径通过 SHA-256 哈希映射到对应的 Claude Session ID：

```bash
# 查看所有 session
cat ~/.openclaw/claude-code-sessions.json | jq '.sessions'

# 验证特定路径的 session
path="/your/project/path"
hash=$(echo -n "$(cd "$path" && pwd)" | sha256sum | cut -c1-16)
cat ~/.openclaw/claude-code-sessions.json | jq --arg h "$hash" '.sessions[$h]'
```

## 架构说明

### 文件结构

```
src/agents/
├── claude-code-spawn.ts      # 主要 spawn 函数
├── claude-code-sessions.ts   # 会话隔离逻辑
├── claude-code-registry.ts   # 进程状态管理
└── tools/
    └── sessions-spawn-tool.ts # 工具入口（已添加 runtime 选项）
```

### 与现有系统集成

- **cli-backends.ts**: 新增 `DEFAULT_CLAUDE_CODE_BACKEND` 配置
- **sessions-spawn-tool.ts**: `SESSIONS_SPAWN_RUNTIMES` 已扩展为 `["subagent", "acp", "claude-code"]`
