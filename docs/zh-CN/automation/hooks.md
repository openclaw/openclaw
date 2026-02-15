---
read_when:
  - 你想为 /new、/reset、/stop 和智能体生命周期事件实现事件驱动自动化
  - 你想构建、安装或调试 hooks
summary: Hooks：用于命令和生命周期事件的事件驱动自动化
title: Hooks
x-i18n:
  generated_at: "2026-02-03T07:50:59Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 853227a0f1abd20790b425fa64dda60efc6b5f93c1b13ecd2dcb788268f71d79
  source_path: automation/hooks.md
  workflow: 15
---

# Hooks

Hooks 提供了一个可扩展的事件驱动系统，用于响应智能体命令和事件自动执行操作。Hooks 从目录中自动发现，可以通过 CLI 命令管理，类似于 OpenClaw 中 Skills 的工作方式。

## 入门指南

Hooks 是在事件发生时运行的小脚本。有两种类型：

- **Hooks**（本页）：当智能体事件触发时在 Gateway 网关内运行，如 `/new`、`/reset`、`/stop` 或生命周期事件。
- **Webhooks**：外部 HTTP webhooks，让其他系统触发 OpenClaw 中的工作。参见 [Webhook Hooks](/automation/webhook) 或使用 `openclaw webhooks` 获取 Gmail 助手命令。

Hooks 也可以捆绑在插件中；参见 [插件](/tools/plugin#plugin-hooks)。

常见用途：

- 重置会话时保存记忆快照
- 保留命令审计跟踪用于故障排除或合规
- 会话开始或结束时触发后续自动化
- 事件触发时向智能体工作区写入文件或调用外部 API

如果你能写一个小的 TypeScript 函数，你就能写一个 hook。Hooks 会自动发现，你可以通过 CLI 启用或禁用它们。

## 概述

hooks 系统允许你：

- 在发出 `/new` 时将会话上下文保存到记忆
- 记录所有命令以供审计
- 在智能体生命周期事件上触发自定义自动化
- 在不修改核心代码的情况下扩展 OpenClaw 的行为

## 入门

### 捆绑的 Hooks

OpenClaw 附带三个自动发现的捆绑 hooks：

- **💾 session-memory**：当你发出 `/new` 时将会话上下文保存到智能体工作区（默认 `~/.openclaw/workspace/memory/`）
- **📝 command-logger**：将所有命令事件记录到 `~/.openclaw/logs/commands.log`
- **🚀 boot-md**：当 Gateway 网关启动时运行 `BOOT.md`（需要启用内部 hooks）

列出可用的 hooks：

```bash
openclaw hooks list
```

启用一个 hook：

```bash
openclaw hooks enable session-memory
```

检查 hook 状态：

```bash
openclaw hooks check
```

获取详细信息：

```bash
openclaw hooks info session-memory
```

### 新手引导

在新手引导期间（`openclaw onboard`），你将被提示启用推荐的 hooks。向导会自动发现符合条件的 hooks 并呈现供选择。

## Hook 发现

Hooks 从三个目录自动发现（按优先级顺序）：

1. **工作区 hooks**：`<workspace>/hooks/`（每智能体，最高优先级）
2. **托管 hooks**：`~/.openclaw/hooks/`（用户安装，跨工作区共享）
3. **捆绑 hooks**：`<openclaw>/dist/hooks/bundled/`（随 OpenClaw 附带）

托管 hook 目录可以是**单个 hook** 或 **hook 包**（包目录）。

每个 hook 是一个包含以下内容的目录：

```
my-hook/
├── HOOK.md          # 元数据 + 文档
└── handler.ts       # 处理程序实现
```

## Hook 包（npm/archives）

Hook 包是标准的 npm 包，通过 `package.json` 中的 `openclaw.hooks` 导出一个或多个 hooks。使用以下命令安装：

```bash
openclaw hooks install <path-or-spec>
```

示例 `package.json`：

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

每个条目指向包含 `HOOK.md` 和 `handler.ts`（或 `index.ts`）的 hook 目录。
Hook 包可以附带依赖；它们将安装在 `~/.openclaw/hooks/<id>` 下。

## Hook 结构

### HOOK.md 格式

`HOOK.md` 文件在 YAML frontmatter 中包含元数据，加上 Markdown 文档：

```markdown
---
name: my-hook
description: "Short description of what this hook does"
homepage: https://docs.openclaw.ai/automation/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# My Hook

Detailed documentation goes here...

## What It Does

- Listens for `/new` commands
- Performs some action
- Logs the result

## Requirements

- Node.js must be installed

## Configuration

No configuration needed.
```

### 元数据字段

`metadata.openclaw` 对象支持：

- **`emoji`**：CLI 的显示表情符号（例如 `"💾"`）
- **`events`**：要监听的事件数组（例如 `["command:new", "command:reset"]`）
- **`export`**：要使用的命名导出（默认为 `"default"`）
- **`homepage`**：文档 URL
- **`requires`**：可选要求
  - **`bins`**：PATH 中需要的二进制文件（例如 `["git", "node"]`）
  - **`anyBins`**：这些二进制文件中至少有一个必须存在
  - **`env`**：需要的环境变量
  - **`config`**：需要的配置路径（例如 `["workspace.dir"]`）
  - **`os`**：需要的平台（例如 `["darwin", "linux"]`）
- **`always`**：绕过资格检查（布尔值）
- **`install`**：安装方法（对于捆绑 hooks：`[{"id":"bundled","kind":"bundled"}]`）

### 处理程序实现

`handler.ts` 文件导出一个 `HookHandler` 函数：

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  // Only trigger on 'new' command
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] New command triggered`);
  console.log(`  Session: ${event.sessionKey}`);
  console.log(`  Timestamp: ${event.timestamp.toISOString()}`);

  // Your custom logic here

  // Optionally send message to user
  event.messages.push("✨ My hook executed!");
};

export default myHandler;
```

#### 事件上下文

每个事件包含：

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway' | 'message',
  action: string,              // e.g., 'new', 'reset', 'stop'
  sessionKey: string,          // Session identifier
  timestamp: Date,             // When the event occurred
  messages: string[],          // Push messages here to send to user
  context: {
    sessionEntry?: SessionEntry,
    sessionId?: string,
    sessionFile?: string,
    commandSource?: string,    // e.g., 'whatsapp', 'telegram'
    senderId?: string,
    workspaceDir?: string,
    bootstrapFiles?: WorkspaceBootstrapFile[],
    cfg?: OpenClawConfig
  }
}
```

## 事件类型

### 命令事件

当发出智能体命令时触发：

- **`command`**：所有命令事件（通用监听器）
- **`command:new`**：当发出 `/new` 命令时
- **`command:reset`**：当发出 `/reset` 命令时
- **`command:stop`**：当发出 `/stop` 命令时

### 智能体事件

- **`agent:bootstrap`**：在注入工作区引导文件之前（hooks 可以修改 `context.bootstrapFiles`）

### Gateway 网关事件

当 Gateway 网关启动时触发：

- **`gateway:startup`**：在渠道启动和 hooks 加载之后

### 消息事件

在消息生命周期中触发。这些事件桥接到工作区 hook 系统，使 hooks 可以观察和修改智能体对话。

- **`message:received`**（即发即弃）：当入站消息到达时触发，在任何处理之前。适用于日志记录、分析或触发副作用。
- **`message:before`**（可修改）：在智能体提示发送之前触发。处理器可以返回 `prependContext` 和/或 `systemPrompt` 来修改智能体的输入。多个 `prependContext` 值用双换行符合并；最后一个 `systemPrompt` 生效。
- **`message:sent`**（即发即弃）：在智能体完成响应后触发。适用于后处理、日志记录或触发后续操作。

#### 上下文字段

**`message:received`**：

| 字段            | 类型                  | 描述                         |
| --------------- | --------------------- | ---------------------------- |
| `from`          | `string`              | 发送者标识（电话号码、邮箱） |
| `content`       | `string`              | 消息正文                     |
| `channel`       | `string`              | 来源渠道（如 `"telegram"`）  |
| `senderId`      | `string \| undefined` | 平台特定的发送者 ID          |
| `senderName`    | `string \| undefined` | 发送者显示名称               |
| `commandSource` | `string`              | 接收消息的表面/提供者        |

**`message:before`**：

| 字段            | 类型                  | 描述               |
| --------------- | --------------------- | ------------------ |
| `prompt`        | `string`              | 即将发送的有效提示 |
| `messages`      | `AgentMessage[]`      | 当前对话历史       |
| `agentId`       | `string`              | 解析后的智能体 ID  |
| `sessionId`     | `string`              | 会话标识符         |
| `commandSource` | `string \| undefined` | 消息提供者/渠道    |

**`message:sent`**：

| 字段        | 类型             | 描述                     |
| ----------- | ---------------- | ------------------------ |
| `messages`  | `AgentMessage[]` | 最终对话快照（包含回复） |
| `sessionId` | `string`         | 会话标识符               |
| `success`   | `boolean`        | 智能体是否无错误完成     |

#### 返回值（仅 `message:before`）

为 `message:before` 注册的处理器可以返回 `InternalHookResult`：

```typescript
interface InternalHookResult {
  prependContext?: string; // 前置到提示中
  systemPrompt?: string; // 覆盖系统提示
}
```

多个处理器会被合并：`prependContext` 值用 `\n\n` 连接，最后一个非 undefined 的 `systemPrompt` 生效。返回 `undefined` 或 `void` 为无操作。

#### HOOK.md 示例

```markdown
---
name: message-context-injector
description: "Inject extra context before each agent turn"
metadata: { "openclaw": { "emoji": "💉", "events": ["message:before"] } }
---

# Message Context Injector

为每次智能体提示添加额外上下文。
```

#### 处理器示例

**即发即弃日志记录（`message:received`）**：

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "message" || event.action !== "received") {
    return;
  }

  console.log(`[msg-log] from=${event.context.from} channel=${event.context.channel}`);
};

export default handler;
```

**可修改 hook（`message:before`）**：

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "message" || event.action !== "before") {
    return;
  }

  return {
    prependContext: `Current user timezone: America/New_York`,
  };
};

export default handler;
```

**响应后 hook（`message:sent`）**：

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "message" || event.action !== "sent") {
    return;
  }

  const { success, sessionId } = event.context as {
    success: boolean;
    sessionId: string;
  };
  if (!success) {
    console.warn(`[msg-sent] Agent failed for session ${sessionId}`);
  }
};

export default handler;
```

### 工具结果 Hooks（插件 API）

这些 hooks 不是事件流监听器；它们让插件在 OpenClaw 持久化工具结果之前同步调整它们。

- **`tool_result_persist`**：在工具结果写入会话记录之前转换它们。必须是同步的；返回更新后的工具结果负载或 `undefined` 保持原样。参见 [智能体循环](/concepts/agent-loop)。

### 未来事件

计划中的事件类型：

- **`session:start`**：当新会话开始时
- **`session:end`**：当会话结束时
- **`agent:error`**：当智能体遇到错误时

## 创建自定义 Hooks

### 1. 选择位置

- **工作区 hooks**（`<workspace>/hooks/`）：每智能体，最高优先级
- **托管 hooks**（`~/.openclaw/hooks/`）：跨工作区共享

### 2. 创建目录结构

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. 创建 HOOK.md

```markdown
---
name: my-hook
description: "Does something useful"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# My Custom Hook

This hook does something useful when you issue `/new`.
```

### 4. 创建 handler.ts

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log("[my-hook] Running!");
  // Your logic here
};

export default handler;
```

### 5. 启用并测试

```bash
# Verify hook is discovered
openclaw hooks list

# Enable it
openclaw hooks enable my-hook

# Restart your gateway process (menu bar app restart on macOS, or restart your dev process)

# Trigger the event
# Send /new via your messaging channel
```

## 配置

### 新配置格式（推荐）

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "session-memory": { "enabled": true },
        "command-logger": { "enabled": false }
      }
    }
  }
}
```

### 每 Hook 配置

Hooks 可以有自定义配置：

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "my-hook": {
          "enabled": true,
          "env": {
            "MY_CUSTOM_VAR": "value"
          }
        }
      }
    }
  }
}
```

### 额外目录

从额外目录加载 hooks：

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "load": {
        "extraDirs": ["/path/to/more/hooks"]
      }
    }
  }
}
```

### 遗留配置格式（仍然支持）

旧配置格式仍然有效以保持向后兼容：

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts",
          "export": "default"
        }
      ]
    }
  }
}
```

**迁移**：对新 hooks 使用基于发现的新系统。遗留处理程序在基于目录的 hooks 之后加载。

## CLI 命令

### 列出 Hooks

```bash
# List all hooks
openclaw hooks list

# Show only eligible hooks
openclaw hooks list --eligible

# Verbose output (show missing requirements)
openclaw hooks list --verbose

# JSON output
openclaw hooks list --json
```

### Hook 信息

```bash
# Show detailed info about a hook
openclaw hooks info session-memory

# JSON output
openclaw hooks info session-memory --json
```

### 检查资格

```bash
# Show eligibility summary
openclaw hooks check

# JSON output
openclaw hooks check --json
```

### 启用/禁用

```bash
# Enable a hook
openclaw hooks enable session-memory

# Disable a hook
openclaw hooks disable command-logger
```

## 捆绑的 Hooks

### session-memory

当你发出 `/new` 时将会话上下文保存到记忆。

**事件**：`command:new`

**要求**：必须配置 `workspace.dir`

**输出**：`<workspace>/memory/YYYY-MM-DD-slug.md`（默认为 `~/.openclaw/workspace`）

**功能**：

1. 使用预重置会话条目定位正确的记录
2. 提取最后 15 行对话
3. 使用 LLM 生成描述性文件名 slug
4. 将会话元数据保存到带日期的记忆文件

**示例输出**：

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

**文件名示例**：

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md`（如果 slug 生成失败则回退到时间戳）

**启用**：

```bash
openclaw hooks enable session-memory
```

### command-logger

将所有命令事件记录到集中审计文件。

**事件**：`command`

**要求**：无

**输出**：`~/.openclaw/logs/commands.log`

**功能**：

1. 捕获事件详情（命令操作、时间戳、会话键、发送者 ID、来源）
2. 以 JSONL 格式追加到日志文件
3. 在后台静默运行

**示例日志条目**：

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**查看日志**：

```bash
# View recent commands
tail -n 20 ~/.openclaw/logs/commands.log

# Pretty-print with jq
cat ~/.openclaw/logs/commands.log | jq .

# Filter by action
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**启用**：

```bash
openclaw hooks enable command-logger
```

### boot-md

当 Gateway 网关启动时运行 `BOOT.md`（在渠道启动之后）。
必须启用内部 hooks 才能运行。

**事件**：`gateway:startup`

**要求**：必须配置 `workspace.dir`

**功能**：

1. 从你的工作区读取 `BOOT.md`
2. 通过智能体运行器运行指令
3. 通过 message 工具发送任何请求的出站消息

**启用**：

```bash
openclaw hooks enable boot-md
```

## 最佳实践

### 保持处理程序快速

Hooks 在命令处理期间运行。保持它们轻量：

```typescript
// ✓ Good - async work, returns immediately
const handler: HookHandler = async (event) => {
  void processInBackground(event); // Fire and forget
};

// ✗ Bad - blocks command processing
const handler: HookHandler = async (event) => {
  await slowDatabaseQuery(event);
  await evenSlowerAPICall(event);
};
```

### 优雅处理错误

始终包装有风险的操作：

```typescript
const handler: HookHandler = async (event) => {
  try {
    await riskyOperation(event);
  } catch (err) {
    console.error("[my-handler] Failed:", err instanceof Error ? err.message : String(err));
    // Don't throw - let other handlers run
  }
};
```

### 尽早过滤事件

如果事件不相关则尽早返回：

```typescript
const handler: HookHandler = async (event) => {
  // Only handle 'new' commands
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // Your logic here
};
```

### 使用特定事件键

尽可能在元数据中指定确切事件：

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # Specific
```

而不是：

```yaml
metadata: { "openclaw": { "events": ["command"] } } # General - more overhead
```

## 调试

### 启用 Hook 日志

Gateway 网关在启动时记录 hook 加载：

```
Registered hook: session-memory -> command:new
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### 检查发现

列出所有发现的 hooks：

```bash
openclaw hooks list --verbose
```

### 检查注册

在你的处理程序中，记录它被调用的时间：

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // Your logic
};
```

### 验证资格

检查为什么 hook 不符合条件：

```bash
openclaw hooks info my-hook
```

在输出中查找缺失的要求。

## 测试

### Gateway 网关日志

监控 Gateway 网关日志以查看 hook 执行：

```bash
# macOS
./scripts/clawlog.sh -f

# Other platforms
tail -f ~/.openclaw/gateway.log
```

### 直接测试 Hooks

隔离测试你的处理程序：

```typescript
import { test } from "vitest";
import { createHookEvent } from "./src/hooks/hooks.js";
import myHandler from "./hooks/my-hook/handler.js";

test("my handler works", async () => {
  const event = createHookEvent("command", "new", "test-session", {
    foo: "bar",
  });

  await myHandler(event);

  // Assert side effects
});
```

## 架构

### 核心组件

- **`src/hooks/types.ts`**：类型定义
- **`src/hooks/workspace.ts`**：目录扫描和加载
- **`src/hooks/frontmatter.ts`**：HOOK.md 元数据解析
- **`src/hooks/config.ts`**：资格检查
- **`src/hooks/hooks-status.ts`**：状态报告
- **`src/hooks/loader.ts`**：动态模块加载器
- **`src/cli/hooks-cli.ts`**：CLI 命令
- **`src/gateway/server-startup.ts`**：在 Gateway 网关启动时加载 hooks
- **`src/auto-reply/reply/commands-core.ts`**：触发命令事件

### 发现流程

```
Gateway 网关启动
    ↓
扫描目录（工作区 → 托管 → 捆绑）
    ↓
解析 HOOK.md 文件
    ↓
检查资格（bins、env、config、os）
    ↓
从符合条件的 hooks 加载处理程序
    ↓
为事件注册处理程序
```

### 事件流程

```
用户发送 /new
    ↓
命令验证
    ↓
创建 hook 事件
    ↓
触发 hook（所有注册的处理程序）
    ↓
命令处理继续
    ↓
会话重置
```

## 故障排除

### Hook 未被发现

1. 检查目录结构：

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # Should show: HOOK.md, handler.ts
   ```

2. 验证 HOOK.md 格式：

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # Should have YAML frontmatter with name and metadata
   ```

3. 列出所有发现的 hooks：
   ```bash
   openclaw hooks list
   ```

### Hook 不符合条件

检查要求：

```bash
openclaw hooks info my-hook
```

查找缺失的：

- 二进制文件（检查 PATH）
- 环境变量
- 配置值
- 操作系统兼容性

### Hook 未执行

1. 验证 hook 已启用：

   ```bash
   openclaw hooks list
   # Should show ✓ next to enabled hooks
   ```

2. 重启你的 Gateway 网关进程以重新加载 hooks。

3. 检查 Gateway 网关日志中的错误：
   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### 处理程序错误

检查 TypeScript/import 错误：

```bash
# Test import directly
node -e "import('./path/to/handler.ts').then(console.log)"
```

## 迁移指南

### 从遗留配置到发现

**之前**：

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "handlers": [
        {
          "event": "command:new",
          "module": "./hooks/handlers/my-handler.ts"
        }
      ]
    }
  }
}
```

**之后**：

1. 创建 hook 目录：

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. 创建 HOOK.md：

   ```markdown
   ---
   name: my-hook
   description: "My custom hook"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # My Hook

   Does something useful.
   ```

3. 更新配置：

   ```json
   {
     "hooks": {
       "internal": {
         "enabled": true,
         "entries": {
           "my-hook": { "enabled": true }
         }
       }
     }
   }
   ```

4. 验证并重启你的 Gateway 网关进程：
   ```bash
   openclaw hooks list
   # Should show: 🎯 my-hook ✓
   ```

**迁移的好处**：

- 自动发现
- CLI 管理
- 资格检查
- 更好的文档
- 一致的结构

## 另请参阅

- [CLI 参考：hooks](/cli/hooks)
- [捆绑 Hooks README](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook Hooks](/automation/webhook)
- [配置](/gateway/configuration#hooks)
