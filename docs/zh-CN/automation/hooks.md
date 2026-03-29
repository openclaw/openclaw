---
read_when:
  - 你希望为 `/new`、`/reset`、`/stop` 和智能体生命周期事件使用事件驱动自动化
  - 你希望构建、安装或调试 Hooks
summary: Hooks：用于命令和生命周期事件的事件驱动自动化
title: Hooks
x-i18n:
  generated_at: "2026-03-16T06:21:34Z"
  model: gpt-5.4
  provider: openai
  source_hash: fc1370a05127d778eb685f687ee9a52062aa6f5c895e80152b9de41c3a02c592
  source_path: automation/hooks.md
  workflow: 15
---

# Hooks

Hooks 提供了一个可扩展的事件驱动系统，用于在响应智能体命令和事件时自动执行操作。Hooks 会从目录中自动发现，并且可以通过 CLI 命令进行管理，方式与 OpenClaw 中的 Skills 类似。

## 熟悉基础

Hooks 是在某些事情发生时运行的小脚本。它们有两种类型：

- **Hooks**（本页）：当智能体事件触发时，在 Gateway 网关内运行，例如 `/new`、`/reset`、`/stop` 或生命周期事件。
- **Webhooks**：外部 HTTP webhook，可让其他系统在 OpenClaw 中触发工作。请参阅 [Webhook Hooks](/automation/webhook)，或使用 `openclaw webhooks` 获取 Gmail 辅助命令。

Hooks 也可以打包在插件中；请参阅 [Plugins](/tools/plugin#plugin-hooks)。

常见用途：

- 当你重置会话时保存一份内存快照
- 为故障排除或合规保留命令审计轨迹
- 当会话开始或结束时触发后续自动化
- 当事件触发时，将文件写入智能体工作区或调用外部 API

如果你会写一个小型 TypeScript 函数，你就能编写一个 hook。Hooks 会被自动发现，你可以通过 CLI 启用或禁用它们。

## 概览

Hooks 系统允许你：

- 当发出 `/new` 时，将会话上下文保存到 memory
- 记录所有命令以供审计
- 在智能体生命周期事件上触发自定义自动化
- 在不修改核心代码的情况下扩展 OpenClaw 的行为

## 入门指南

### 内置 Hooks

OpenClaw 自带四个会被自动发现的内置 hook：

- **💾 session-memory**：当你发出 `/new` 时，将会话上下文保存到你的智能体工作区（默认是 `~/.openclaw/workspace/memory/`）
- **📎 bootstrap-extra-files**：在 `agent:bootstrap` 期间，从已配置的 glob/路径模式中注入额外的工作区引导文件
- **📝 command-logger**：将所有命令事件记录到 `~/.openclaw/logs/commands.log`
- **🚀 boot-md**：当 Gateway 网关启动时运行 `BOOT.md`（需要启用内部 hooks）

列出可用 hooks：

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

在新手引导期间（`openclaw onboard`），系统会提示你启用推荐的 hooks。向导会自动发现符合条件的 hooks 并供你选择。

## Hook 发现

Hooks 会从三个目录中自动发现（按优先级顺序）：

1. **工作区 hooks**：`<workspace>/hooks/`（每个智能体单独配置，优先级最高）
2. **托管 hooks**：`~/.openclaw/hooks/`（用户安装，在各工作区之间共享）
3. **内置 hooks**：`<openclaw>/dist/hooks/bundled/`（随 OpenClaw 一起提供）

托管 hook 目录既可以是 **单个 hook**，也可以是 **hook 包**（包目录）。

每个 hook 都是一个包含以下内容的目录：

```
my-hook/
├── HOOK.md          # 元数据 + 文档
└── handler.ts       # 处理器实现
```

## Hook 包（npm/归档）

Hook 包是标准的 npm 包，它们通过 `package.json` 中的 `openclaw.hooks` 导出一个或多个 hook。使用以下命令安装它们：

```bash
openclaw hooks install <path-or-spec>
```

npm spec 仅支持注册表形式（包名 + 可选的精确版本或 dist-tag）。
Git/URL/file spec 和 semver 范围会被拒绝。

裸 spec 和 `@latest` 会保持在稳定轨道上。如果 npm 将其中任意一种解析为预发布版本，OpenClaw 会停止并要求你通过预发布标签（例如 `@beta`/`@rc`）或精确的预发布版本显式选择加入。

`package.json` 示例：

```json
{
  "name": "@acme/my-hooks",
  "version": "0.1.0",
  "openclaw": {
    "hooks": ["./hooks/my-hook", "./hooks/other-hook"]
  }
}
```

每个条目都指向一个包含 `HOOK.md` 和 `handler.ts`（或 `index.ts`）的 hook 目录。
Hook 包可以携带依赖；它们会安装到 `~/.openclaw/hooks/<id>` 下。
每个 `openclaw.hooks` 条目在解析符号链接后都必须保持在包目录内部；超出目录范围的条目会被拒绝。

安全说明：`openclaw hooks install` 会使用 `npm install --ignore-scripts` 安装依赖
（不运行生命周期脚本）。请保持 hook 包依赖树为“纯 JS/TS”，并避免依赖 `postinstall` 构建的包。

## Hook 结构

### HOOK.md 格式

`HOOK.md` 文件包含 YAML frontmatter 中的元数据以及 Markdown 文档：

```markdown
---
name: my-hook
description: "关于此 hook 功能的简短描述"
homepage: https://docs.openclaw.ai/automation/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# My Hook

详细文档写在这里……

## 它的作用

- 监听 `/new` 命令
- 执行某些操作
- 记录结果

## 要求

- 必须安装 Node.js

## 配置

无需配置。
```

### 元数据字段

`metadata.openclaw` 对象支持：

- **`emoji`**：CLI 显示用 emoji（例如 `"💾"`）
- **`events`**：要监听的事件数组（例如 `["command:new", "command:reset"]`）
- **`export`**：要使用的命名导出（默认为 `"default"`）
- **`homepage`**：文档 URL
- **`requires`**：可选要求
  - **`bins`**：PATH 中必须存在的二进制文件（例如 `["git", "node"]`）
  - **`anyBins`**：这些二进制文件中至少要存在一个
  - **`env`**：必需的环境变量
  - **`config`**：必需的配置路径（例如 `["workspace.dir"]`）
  - **`os`**：支持的平台（例如 `["darwin", "linux"]`）
- **`always`**：绕过资格检查（布尔值）
- **`install`**：安装方式（对于内置 hooks：`[{"id":"bundled","kind":"bundled"}]`）

### 处理器实现

`handler.ts` 文件会导出一个 `HookHandler` 函数：

```typescript
const myHandler = async (event) => {
  // 仅在 'new' 命令时触发
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] New command triggered`);
  console.log(`  Session: ${event.sessionKey}`);
  console.log(`  Timestamp: ${event.timestamp.toISOString()}`);

  // 你的自定义逻辑写在这里

  // 可选：向用户发送消息
  event.messages.push("✨ My hook executed!");
};

export default myHandler;
```

#### 事件上下文

每个事件都包含：

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway' | 'message',
  action: string,              // 例如 'new'、'reset'、'stop'、'received'、'sent'
  sessionKey: string,          // 会话标识符
  timestamp: Date,             // 事件发生时间
  messages: string[],          // 将消息推入这里以发送给用户
  context: {
    // 命令事件：
    sessionEntry?: SessionEntry,
    sessionId?: string,
    sessionFile?: string,
    commandSource?: string,    // 例如 'whatsapp'、'telegram'
    senderId?: string,
    workspaceDir?: string,
    bootstrapFiles?: WorkspaceBootstrapFile[],
    cfg?: OpenClawConfig,
    // 消息事件（完整详情见“消息事件”部分）：
    from?: string,             // message:received
    to?: string,               // message:sent
    content?: string,
    channelId?: string,
    success?: boolean,         // message:sent
  }
}
```

## 事件类型

### 命令事件

在发出智能体命令时触发：

- **`command`**：所有命令事件（通用监听器）
- **`command:new`**：发出 `/new` 命令时
- **`command:reset`**：发出 `/reset` 命令时
- **`command:stop`**：发出 `/stop` 命令时

### 会话事件

- **`session:compact:before`**：在压缩开始总结历史记录之前
- **`session:compact:after`**：在压缩完成并带有摘要元数据之后

内部 hook 负载会将这些事件表示为 `type: "session"`，并将 `action` 设为 `"compact:before"` / `"compact:after"`；监听器使用上面的组合键进行订阅。
具体处理器注册使用字面量键格式 `${type}:${action}`。对于这些事件，请注册 `session:compact:before` 和 `session:compact:after`。

### 智能体事件

- **`agent:bootstrap`**：在工作区引导文件被注入之前（hooks 可以修改 `context.bootstrapFiles`）

### Gateway 网关事件

在 Gateway 网关启动时触发：

- **`gateway:startup`**：在渠道启动且 hooks 已加载之后

### 消息事件

在消息被接收或发送时触发：

- **`message`**：所有消息事件（通用监听器）
- **`message:received`**：当从任意渠道收到入站消息时。在处理的早期阶段触发，此时媒体理解尚未完成。对于尚未处理的媒体附件，内容中可能包含类似 `<media:audio>` 的原始占位符。
- **`message:transcribed`**：当一条消息已被完全处理，包括音频转写和链接理解时触发。此时，`transcript` 包含音频消息的完整转写文本。当你需要访问已转写的音频内容时，请使用此 hook。
- **`message:preprocessed`**：在所有媒体 + 链接理解完成后，为每条消息触发，使 hooks 可以在智能体看到消息之前访问完全增强的正文（转写、图像描述、链接摘要）。
- **`message:sent`**：当出站消息成功发送时

#### 消息事件上下文

消息事件包含关于消息的丰富上下文：

```typescript
// message:received context
{
  from: string,           // 发送者标识符（电话号码、用户 ID 等）
  content: string,        // 消息内容
  timestamp?: number,     // 接收时的 Unix 时间戳
  channelId: string,      // 渠道（例如 "whatsapp"、"telegram"、"discord"）
  accountId?: string,     // 多账号设置中的提供商账号 ID
  conversationId?: string, // 聊天/会话 ID
  messageId?: string,     // 提供商返回的消息 ID
  metadata?: {            // 额外的提供商特定数据
    to?: string,
    provider?: string,
    surface?: string,
    threadId?: string,
    senderId?: string,
    senderName?: string,
    senderUsername?: string,
    senderE164?: string,
  }
}

// message:sent context
{
  to: string,             // 接收者标识符
  content: string,        // 已发送的消息内容
  success: boolean,       // 发送是否成功
  error?: string,         // 如果发送失败，则为错误消息
  channelId: string,      // 渠道（例如 "whatsapp"、"telegram"、"discord"）
  accountId?: string,     // 提供商账号 ID
  conversationId?: string, // 聊天/会话 ID
  messageId?: string,     // 提供商返回的消息 ID
  isGroup?: boolean,      // 此出站消息是否属于群组/渠道上下文
  groupId?: string,       // 用于与 message:received 关联的群组/渠道标识符
}

// message:transcribed context
{
  body?: string,          // 增强前的原始入站正文
  bodyForAgent?: string,  // 对智能体可见的增强正文
  transcript: string,     // 音频转写文本
  channelId: string,      // 渠道（例如 "telegram"、"whatsapp"）
  conversationId?: string,
  messageId?: string,
}

// message:preprocessed context
{
  body?: string,          // 原始入站正文
  bodyForAgent?: string,  // 媒体/链接理解后的最终增强正文
  transcript?: string,    // 存在音频时的转写内容
  channelId: string,      // 渠道（例如 "telegram"、"whatsapp"）
  conversationId?: string,
  messageId?: string,
  isGroup?: boolean,
  groupId?: string,
}
```

#### 示例：消息记录器 Hook

```typescript
const isMessageReceivedEvent = (event: { type: string; action: string }) =>
  event.type === "message" && event.action === "received";
const isMessageSentEvent = (event: { type: string; action: string }) =>
  event.type === "message" && event.action === "sent";

const handler = async (event) => {
  if (isMessageReceivedEvent(event as { type: string; action: string })) {
    console.log(`[message-logger] Received from ${event.context.from}: ${event.context.content}`);
  } else if (isMessageSentEvent(event as { type: string; action: string })) {
    console.log(`[message-logger] Sent to ${event.context.to}: ${event.context.content}`);
  }
};

export default handler;
```

### 工具结果 Hooks（插件 API）

这些 hooks 不是事件流监听器；它们允许插件在 OpenClaw 持久化工具结果之前同步调整工具结果。

- **`tool_result_persist`**：在工具结果写入会话转录之前对其进行转换。必须是同步的；返回更新后的工具结果负载，或返回 `undefined` 以保持原样。请参阅 [Agent Loop](/concepts/agent-loop)。

### 插件 Hook 事件

通过插件 hook 运行器公开的压缩生命周期 hooks：

- **`before_compaction`**：在压缩前运行，并带有计数/token 元数据
- **`after_compaction`**：在压缩后运行，并带有压缩摘要元数据

### 未来事件

计划中的事件类型：

- **`session:start`**：当新会话开始时
- **`session:end`**：当会话结束时
- **`agent:error`**：当智能体遇到错误时

## 创建自定义 Hooks

### 1. 选择位置

- **工作区 hooks**（`<workspace>/hooks/`）：每个智能体单独配置，优先级最高
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
description: "执行某些有用的事情"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# My Custom Hook

当你发出 `/new` 时，此 hook 会执行一些有用的事情。
```

### 4. 创建 handler.ts

```typescript
const handler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log("[my-hook] Running!");
  // 你的逻辑写在这里
};

export default handler;
```

### 5. 启用并测试

```bash
# 验证 hook 已被发现
openclaw hooks list

# 启用它
openclaw hooks enable my-hook

# 重启你的 Gateway 网关进程（macOS 上重启菜单栏应用，或重启你的开发进程）

# 触发事件
# 通过你的消息渠道发送 /new
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

### 每个 Hook 的配置

Hooks 可以具有自定义配置：

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

### 旧版配置格式（仍受支持）

旧配置格式仍可用于向后兼容：

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

注意：`module` 必须是相对于工作区的路径。绝对路径和超出工作区范围的遍历路径会被拒绝。

**迁移**：对于新的 hooks，请使用基于发现的新系统。旧版 handlers 会在基于目录的 hooks 之后加载。

## CLI 命令

### 列出 Hooks

```bash
# 列出所有 hooks
openclaw hooks list

# 仅显示符合条件的 hooks
openclaw hooks list --eligible

# 详细输出（显示缺失的要求）
openclaw hooks list --verbose

# JSON 输出
openclaw hooks list --json
```

### Hook 信息

```bash
# 显示某个 hook 的详细信息
openclaw hooks info session-memory

# JSON 输出
openclaw hooks info session-memory --json
```

### 检查资格

```bash
# 显示资格摘要
openclaw hooks check

# JSON 输出
openclaw hooks check --json
```

### 启用/禁用

```bash
# 启用一个 hook
openclaw hooks enable session-memory

# 禁用一个 hook
openclaw hooks disable command-logger
```

## 内置 hook 参考

### session-memory

当你发出 `/new` 时，将会话上下文保存到 memory。

**事件**：`command:new`

**要求**：必须配置 `workspace.dir`

**输出**：`<workspace>/memory/YYYY-MM-DD-slug.md`（默认是 `~/.openclaw/workspace`）

**它的作用**：

1. 使用重置前的会话条目定位正确的转录
2. 提取最近 15 行对话
3. 使用 LLM 生成描述性的文件名 slug
4. 将会话元数据保存到带日期的 memory 文件中

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
- `2026-01-16-1430.md`（如果 slug 生成失败，则回退为时间戳）

**启用**：

```bash
openclaw hooks enable session-memory
```

### bootstrap-extra-files

在 `agent:bootstrap` 期间注入额外的引导文件（例如 monorepo 本地的 `AGENTS.md` / `TOOLS.md`）。

**事件**：`agent:bootstrap`

**要求**：必须配置 `workspace.dir`

**输出**：不写入文件；仅在内存中修改引导上下文。

**配置**：

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "bootstrap-extra-files": {
          "enabled": true,
          "paths": ["packages/*/AGENTS.md", "packages/*/TOOLS.md"]
        }
      }
    }
  }
}
```

**说明**：

- 路径相对于工作区解析。
- 文件必须保持在工作区内部（通过 realpath 检查）。
- 仅加载已识别的引导基础文件名。
- 会保留子智能体允许列表（仅 `AGENTS.md` 和 `TOOLS.md`）。

**启用**：

```bash
openclaw hooks enable bootstrap-extra-files
```

### command-logger

将所有命令事件记录到集中式审计文件。

**事件**：`command`

**要求**：无

**输出**：`~/.openclaw/logs/commands.log`

**它的作用**：

1. 捕获事件详情（命令操作、时间戳、会话键、发送者 ID、来源）
2. 以 JSONL 格式附加到日志文件
3. 在后台静默运行

**示例日志条目**：

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**查看日志**：

```bash
# 查看最近的命令
tail -n 20 ~/.openclaw/logs/commands.log

# 使用 jq 美化输出
cat ~/.openclaw/logs/commands.log | jq .

# 按操作筛选
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**启用**：

```bash
openclaw hooks enable command-logger
```

### boot-md

当 Gateway 网关启动时（渠道启动之后）运行 `BOOT.md`。
必须启用内部 hooks，此功能才会运行。

**事件**：`gateway:startup`

**要求**：必须配置 `workspace.dir`

**它的作用**：

1. 从你的工作区读取 `BOOT.md`
2. 通过智能体运行器执行其中的指令
3. 通过消息工具发送任何请求的出站消息

**启用**：

```bash
openclaw hooks enable boot-md
```

## 最佳实践

### 保持处理器快速

Hooks 在命令处理期间运行。请保持其轻量：

```typescript
// ✓ 好 - 异步工作，立即返回
const handler: HookHandler = async (event) => {
  void processInBackground(event); // 触发后不等待
};

// ✗ 差 - 阻塞命令处理
const handler: HookHandler = async (event) => {
  await slowDatabaseQuery(event);
  await evenSlowerAPICall(event);
};
```

### 优雅地处理错误

始终包装高风险操作：

```typescript
const handler: HookHandler = async (event) => {
  try {
    await riskyOperation(event);
  } catch (err) {
    console.error("[my-handler] Failed:", err instanceof Error ? err.message : String(err));
    // 不要抛出错误 - 让其他处理器继续运行
  }
};
```

### 尽早过滤事件

如果事件不相关，请尽早返回：

```typescript
const handler: HookHandler = async (event) => {
  // 仅处理 'new' 命令
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // 你的逻辑写在这里
};
```

### 使用具体事件键

如果可能，请在元数据中指定精确事件：

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # 精确
```

而不是：

```yaml
metadata: { "openclaw": { "events": ["command"] } } # 通用 - 开销更大
```

## 调试

### 启用 Hook 日志

Gateway 网关会在启动时记录 hook 加载情况：

```
Registered hook: session-memory -> command:new
Registered hook: bootstrap-extra-files -> agent:bootstrap
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### 检查发现情况

列出所有已发现的 hooks：

```bash
openclaw hooks list --verbose
```

### 检查注册情况

在你的处理器中，记录它何时被调用：

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // 你的逻辑
};
```

### 验证资格

检查某个 hook 为什么不符合条件：

```bash
openclaw hooks info my-hook
```

查看输出中缺失的要求。

## 测试

### Gateway 网关日志

监控 Gateway 网关日志以查看 hook 执行情况：

```bash
# macOS
./scripts/clawlog.sh -f

# 其他平台
tail -f ~/.openclaw/gateway.log
```

### 直接测试 Hooks

单独测试你的 handlers：

```typescript
import { test } from "vitest";
import myHandler from "./hooks/my-hook/handler.js";

test("my handler works", async () => {
  const event = {
    type: "command",
    action: "new",
    sessionKey: "test-session",
    timestamp: new Date(),
    messages: [],
    context: { foo: "bar" },
  };

  await myHandler(event);

  // 断言副作用
});
```

## 架构

### 核心组件

- **`src/hooks/types.ts`**：类型定义
- **`src/hooks/workspace.ts`**：目录扫描与加载
- **`src/hooks/frontmatter.ts`**：`HOOK.md` 元数据解析
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
扫描目录（工作区 → 托管 → 内置）
    ↓
解析 HOOK.md 文件
    ↓
检查资格（bins、env、config、os）
    ↓
从符合条件的 hooks 加载 handlers
    ↓
为事件注册 handlers
```

### 事件流程

```
用户发送 /new
    ↓
命令校验
    ↓
创建 hook 事件
    ↓
触发 hook（所有已注册的 handlers）
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
   # 应显示：HOOK.md, handler.ts
   ```

2. 验证 HOOK.md 格式：

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # 应包含带有 name 和 metadata 的 YAML frontmatter
   ```

3. 列出所有已发现的 hooks：

   ```bash
   openclaw hooks list
   ```

### Hook 不符合条件

检查要求：

```bash
openclaw hooks info my-hook
```

查看是否缺少：

- 二进制文件（检查 PATH）
- 环境变量
- 配置值
- OS 兼容性

### Hook 未执行

1. 验证 hook 已启用：

   ```bash
   openclaw hooks list
   # 应在已启用的 hooks 旁显示 ✓
   ```

2. 重启你的 Gateway 网关进程以重新加载 hooks。

3. 检查 Gateway 网关日志中的错误：

   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### 处理器错误

检查 TypeScript/import 错误：

```bash
# 直接测试导入
node -e "import('./path/to/handler.ts').then(console.log)"
```

## 迁移指南

### 从旧版配置迁移到发现机制

**迁移前**：

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

**迁移后**：

1. 创建 hook 目录：

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. 创建 HOOK.md：

   ```markdown
   ---
   name: my-hook
   description: "我的自定义 hook"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # My Hook

   执行某些有用的事情。
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
   # 应显示：🎯 my-hook ✓
   ```

**迁移的好处**：

- 自动发现
- CLI 管理
- 资格检查
- 更好的文档
- 一致的结构

## 另请参阅

- [CLI Reference: hooks](/cli/hooks)
- [Bundled Hooks README](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook Hooks](/automation/webhook)
- [Configuration](/gateway/configuration#hooks)
