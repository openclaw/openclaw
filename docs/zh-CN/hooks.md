---
read_when:
  - 你想要针对 /new、/reset、/stop 和智能体生命周期事件的事件驱动自动化
  - 你想要构建、安装或调试钩子
summary: 钩子：针对命令和生命周期事件的事件驱动自动化
title: 钩子
x-i18n:
  generated_at: "2026-02-01T20:42:08Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 853227a0f1abd20790b425fa64dda60efc6b5f93c1b13ecd2dcb788268f71d79
  source_path: hooks.md
  workflow: 14
---

# 钩子

钩子提供了一个可扩展的事件驱动系统，用于在响应智能体命令和事件时自动执行操作。钩子从目录中自动发现，并可通过 CLI 命令管理，类似于 OpenClaw 中 Skills 的工作方式。

## 快速了解

钩子是在某些事件发生时运行的小脚本。有两种类型：

- **钩子**（本页）：在智能体事件触发时在 Gateway网关内部运行，如 `/new`、`/reset`、`/stop` 或生命周期事件。
- **Webhook**：外部 HTTP webhook，允许其他系统在 OpenClaw 中触发工作。参见 [Webhook 钩子](/automation/webhook) 或使用 `openclaw webhooks` 获取 Gmail 辅助命令。

钩子也可以捆绑在插件中；参见 [插件](/plugin#plugin-hooks)。

常见用途：

- 在重置会话时保存记忆快照
- 保留命令审计记录，用于故障排除或合规
- 在会话开始或结束时触发后续自动化
- 在事件触发时将文件写入智能体工作区或调用外部 API

如果你能编写一个小型 TypeScript 函数，就能编写钩子。钩子会自动发现，你可以通过 CLI 启用或禁用它们。

## 概述

钩子系统允许你：

- 在发出 `/new` 时将会话上下文保存到记忆中
- 记录所有命令用于审计
- 在智能体生命周期事件上触发自定义自动化
- 扩展 OpenClaw 的行为而无需修改核心代码

## 快速开始

### 内置钩子

OpenClaw 附带四个自动发现的内置钩子：

- **💾 session-memory**：在你发出 `/new` 时将会话上下文保存到智能体工作区（默认 `~/.openclaw/workspace/memory/`）
- **📝 command-logger**：将所有命令事件记录到 `~/.openclaw/logs/commands.log`
- **🚀 boot-md**：在 Gateway网关启动时运行 `BOOT.md`（需要启用内部钩子）
- **😈 soul-evil**：在清除窗口期间或随机概率下，将注入的 `SOUL.md` 内容替换为 `SOUL_EVIL.md`

列出可用钩子：

```bash
openclaw hooks list
```

启用钩子：

```bash
openclaw hooks enable session-memory
```

检查钩子状态：

```bash
openclaw hooks check
```

获取详细信息：

```bash
openclaw hooks info session-memory
```

### 新手引导

在新手引导（`openclaw onboard`）期间，你会被提示启用推荐的钩子。向导会自动发现符合条件的钩子并展示供你选择。

## 钩子发现

钩子从三个目录自动发现（按优先级排序）：

1. **工作区钩子**：`<workspace>/hooks/`（按智能体，最高优先级）
2. **托管钩子**：`~/.openclaw/hooks/`（用户安装，跨工作区共享）
3. **内置钩子**：`<openclaw>/dist/hooks/bundled/`（随 OpenClaw 附带）

托管钩子目录可以是**单个钩子**或**钩子包**（包目录）。

每个钩子是一个包含以下内容的目录：

```
my-hook/
├── HOOK.md          # 元数据 + 文档
└── handler.ts       # 处理器实现
```

## 钩子包（npm/归档）

钩子包是标准的 npm 包，通过 `package.json` 中的 `openclaw.hooks` 导出一个或多个钩子。使用以下命令安装：

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

每个条目指向一个包含 `HOOK.md` 和 `handler.ts`（或 `index.ts`）的钩子目录。
钩子包可以附带依赖；它们将安装到 `~/.openclaw/hooks/<id>` 下。

## 钩子结构

### HOOK.md 格式

`HOOK.md` 文件包含 YAML 前置元数据和 Markdown 文档：

```markdown
---
name: my-hook
description: "这个钩子做什么的简短描述"
homepage: https://docs.openclaw.ai/hooks#my-hook
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# My Hook

详细文档在这里...

## 功能

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

- **`emoji`**：CLI 显示用的表情符号（例如 `"💾"`）
- **`events`**：要监听的事件数组（例如 `["command:new", "command:reset"]`）
- **`export`**：要使用的命名导出（默认为 `"default"`）
- **`homepage`**：文档 URL
- **`requires`**：可选要求
  - **`bins`**：PATH 中必需的二进制文件（例如 `["git", "node"]`）
  - **`anyBins`**：至少需要其中一个二进制文件
  - **`env`**：必需的环境变量
  - **`config`**：必需的配置路径（例如 `["workspace.dir"]`）
  - **`os`**：必需的平台（例如 `["darwin", "linux"]`）
- **`always`**：跳过资格检查（布尔值）
- **`install`**：安装方式（对于内置钩子：`[{"id":"bundled","kind":"bundled"}]`）

### 处理器实现

`handler.ts` 文件导出一个 `HookHandler` 函数：

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const myHandler: HookHandler = async (event) => {
  // 仅在 'new' 命令时触发
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] New command triggered`);
  console.log(`  Session: ${event.sessionKey}`);
  console.log(`  Timestamp: ${event.timestamp.toISOString()}`);

  // 你的自定义逻辑

  // 可选：向用户发送消息
  event.messages.push("✨ My hook executed!");
};

export default myHandler;
```

#### 事件上下文

每个事件包含：

```typescript
{
  type: 'command' | 'session' | 'agent' | 'gateway',
  action: string,              // 例如 'new'、'reset'、'stop'
  sessionKey: string,          // 会话标识符
  timestamp: Date,             // 事件发生时间
  messages: string[],          // 将消息推送到这里以发送给用户
  context: {
    sessionEntry?: SessionEntry,
    sessionId?: string,
    sessionFile?: string,
    commandSource?: string,    // 例如 'whatsapp'、'telegram'
    senderId?: string,
    workspaceDir?: string,
    bootstrapFiles?: WorkspaceBootstrapFile[],
    cfg?: OpenClawConfig
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

### 智能体事件

- **`agent:bootstrap`**：在工作区引导文件注入之前（钩子可以修改 `context.bootstrapFiles`）

### Gateway网关事件

在 Gateway网关启动时触发：

- **`gateway:startup`**：在渠道启动和钩子加载之后

### 工具结果钩子（插件 API）

这些钩子不是事件流监听器；它们允许插件在 OpenClaw 持久化工具结果之前同步调整工具结果。

- **`tool_result_persist`**：在工具结果写入会话记录之前进行转换。必须是同步的；返回更新后的工具结果负载或 `undefined` 以保持原样。参见 [智能体循环](/concepts/agent-loop)。

### 未来事件

计划中的事件类型：

- **`session:start`**：新会话开始时
- **`session:end`**：会话结束时
- **`agent:error`**：智能体遇到错误时
- **`message:sent`**：消息发送时
- **`message:received`**：消息接收时

## 创建自定义钩子

### 1. 选择位置

- **工作区钩子**（`<workspace>/hooks/`）：按智能体，最高优先级
- **托管钩子**（`~/.openclaw/hooks/`）：跨工作区共享

### 2. 创建目录结构

```bash
mkdir -p ~/.openclaw/hooks/my-hook
cd ~/.openclaw/hooks/my-hook
```

### 3. 创建 HOOK.md

```markdown
---
name: my-hook
description: "做一些有用的事情"
metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
---

# My Hook

当你发出 `/new` 时，这个钩子会做一些有用的事情。
```

### 4. 创建 handler.ts

```typescript
import type { HookHandler } from "../../src/hooks/hooks.js";

const handler: HookHandler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log("[my-hook] Running!");
  // 你的逻辑
};

export default handler;
```

### 5. 启用并测试

```bash
# 验证钩子已被发现
openclaw hooks list

# 启用它
openclaw hooks enable my-hook

# 重启你的 Gateway网关进程（macOS 上重启菜单栏应用，或重启开发进程）

# 触发事件
# 通过消息渠道发送 /new
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

### 单个钩子配置

钩子可以有自定义配置：

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

从额外目录加载钩子：

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

### 旧版配置格式（仍然支持）

旧配置格式仍然可以向后兼容：

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

**迁移**：新钩子请使用基于发现的新系统。旧版处理器在基于目录的钩子之后加载。

## CLI 命令

### 列出钩子

```bash
# 列出所有钩子
openclaw hooks list

# 仅显示符合条件的钩子
openclaw hooks list --eligible

# 详细输出（显示缺失的要求）
openclaw hooks list --verbose

# JSON 输出
openclaw hooks list --json
```

### 钩子信息

```bash
# 显示钩子的详细信息
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
# 启用钩子
openclaw hooks enable session-memory

# 禁用钩子
openclaw hooks disable command-logger
```

## 内置钩子

### session-memory

在你发出 `/new` 时将会话上下文保存到记忆中。

**事件**：`command:new`

**要求**：必须配置 `workspace.dir`

**输出**：`<workspace>/memory/YYYY-MM-DD-slug.md`（默认为 `~/.openclaw/workspace`）

**功能**：

1. 使用重置前的会话条目定位正确的记录
2. 提取最后 15 行对话
3. 使用 LLM 生成描述性的文件名 slug
4. 将会话元数据保存为带日期的记忆文件

**输出示例**：

```markdown
# Session: 2026-01-16 14:30:00 UTC

- **Session Key**: agent:main:main
- **Session ID**: abc123def456
- **Source**: telegram
```

**文件名示例**：

- `2026-01-16-vendor-pitch.md`
- `2026-01-16-api-design.md`
- `2026-01-16-1430.md`（slug 生成失败时的时间戳回退）

**启用**：

```bash
openclaw hooks enable session-memory
```

### command-logger

将所有命令事件记录到集中的审计文件。

**事件**：`command`

**要求**：无

**输出**：`~/.openclaw/logs/commands.log`

**功能**：

1. 捕获事件详情（命令操作、时间戳、会话键、发送者 ID、来源）
2. 以 JSONL 格式追加到日志文件
3. 在后台静默运行

**日志条目示例**：

```jsonl
{"timestamp":"2026-01-16T14:30:00.000Z","action":"new","sessionKey":"agent:main:main","senderId":"+1234567890","source":"telegram"}
{"timestamp":"2026-01-16T15:45:22.000Z","action":"stop","sessionKey":"agent:main:main","senderId":"user@example.com","source":"whatsapp"}
```

**查看日志**：

```bash
# 查看最近的命令
tail -n 20 ~/.openclaw/logs/commands.log

# 用 jq 美化输出
cat ~/.openclaw/logs/commands.log | jq .

# 按操作过滤
grep '"action":"new"' ~/.openclaw/logs/commands.log | jq .
```

**启用**：

```bash
openclaw hooks enable command-logger
```

### soul-evil

在清除窗口期间或随机概率下，将注入的 `SOUL.md` 内容替换为 `SOUL_EVIL.md`。

**事件**：`agent:bootstrap`

**文档**：[SOUL Evil 钩子](/hooks/soul-evil)

**输出**：不写入文件；替换仅在内存中进行。

**启用**：

```bash
openclaw hooks enable soul-evil
```

**配置**：

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

### boot-md

在 Gateway网关启动时（渠道启动之后）运行 `BOOT.md`。
必须启用内部钩子才能运行。

**事件**：`gateway:startup`

**要求**：必须配置 `workspace.dir`

**功能**：

1. 从你的工作区读取 `BOOT.md`
2. 通过智能体运行器运行指令
3. 通过消息工具发送任何请求的出站消息

**启用**：

```bash
openclaw hooks enable boot-md
```

## 最佳实践

### 保持处理器快速

钩子在命令处理期间运行。保持轻量：

```typescript
// ✓ 好 - 异步工作，立即返回
const handler: HookHandler = async (event) => {
  void processInBackground(event); // 发后即忘
};

// ✗ 差 - 阻塞命令处理
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
    // 不要抛出异常 - 让其他处理器继续运行
  }
};
```

### 尽早过滤事件

如果事件不相关，尽早返回：

```typescript
const handler: HookHandler = async (event) => {
  // 仅处理 'new' 命令
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  // 你的逻辑
};
```

### 使用具体的事件键

尽可能在元数据中指定确切的事件：

```yaml
metadata: { "openclaw": { "events": ["command:new"] } } # 具体
```

而不是：

```yaml
metadata: { "openclaw": { "events": ["command"] } } # 通用 - 开销更大
```

## 调试

### 启用钩子日志

Gateway网关在启动时记录钩子加载情况：

```
Registered hook: session-memory -> command:new
Registered hook: command-logger -> command
Registered hook: boot-md -> gateway:startup
```

### 检查发现情况

列出所有已发现的钩子：

```bash
openclaw hooks list --verbose
```

### 检查注册情况

在你的处理器中，记录它被调用的时机：

```typescript
const handler: HookHandler = async (event) => {
  console.log("[my-handler] Triggered:", event.type, event.action);
  // 你的逻辑
};
```

### 验证资格

检查钩子不符合条件的原因：

```bash
openclaw hooks info my-hook
```

查看输出中缺失的要求。

## 测试

### Gateway网关日志

监控 Gateway网关日志以查看钩子执行情况：

```bash
# macOS
./scripts/clawlog.sh -f

# 其他平台
tail -f ~/.openclaw/gateway.log
```

### 直接测试钩子

独立测试你的处理器：

```typescript
import { test } from "vitest";
import { createHookEvent } from "./src/hooks/hooks.js";
import myHandler from "./hooks/my-hook/handler.js";

test("my handler works", async () => {
  const event = createHookEvent("command", "new", "test-session", {
    foo: "bar",
  });

  await myHandler(event);

  // 断言副作用
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
- **`src/gateway/server-startup.ts`**：Gateway网关启动时加载钩子
- **`src/auto-reply/reply/commands-core.ts`**：触发命令事件

### 发现流程

```
Gateway网关启动
    ↓
扫描目录（工作区 → 托管 → 内置）
    ↓
解析 HOOK.md 文件
    ↓
检查资格（二进制文件、环境变量、配置、操作系统）
    ↓
从符合条件的钩子加载处理器
    ↓
为事件注册处理器
```

### 事件流程

```
用户发送 /new
    ↓
命令验证
    ↓
创建钩子事件
    ↓
触发钩子（所有已注册的处理器）
    ↓
继续命令处理
    ↓
会话重置
```

## 故障排除

### 钩子未被发现

1. 检查目录结构：

   ```bash
   ls -la ~/.openclaw/hooks/my-hook/
   # 应该显示：HOOK.md、handler.ts
   ```

2. 验证 HOOK.md 格式：

   ```bash
   cat ~/.openclaw/hooks/my-hook/HOOK.md
   # 应该有包含 name 和 metadata 的 YAML 前置元数据
   ```

3. 列出所有已发现的钩子：
   ```bash
   openclaw hooks list
   ```

### 钩子不符合条件

检查要求：

```bash
openclaw hooks info my-hook
```

查看缺失的内容：

- 二进制文件（检查 PATH）
- 环境变量
- 配置值
- 操作系统兼容性

### 钩子未执行

1. 验证钩子已启用：

   ```bash
   openclaw hooks list
   # 已启用的钩子旁边应显示 ✓
   ```

2. 重启你的 Gateway网关进程以重新加载钩子。

3. 检查 Gateway网关日志中的错误：
   ```bash
   ./scripts/clawlog.sh | grep hook
   ```

### 处理器错误

检查 TypeScript/导入错误：

```bash
# 直接测试导入
node -e "import('./path/to/handler.ts').then(console.log)"
```

## 迁移指南

### 从旧版配置迁移到发现模式

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

1. 创建钩子目录：

   ```bash
   mkdir -p ~/.openclaw/hooks/my-hook
   mv ./hooks/handlers/my-handler.ts ~/.openclaw/hooks/my-hook/handler.ts
   ```

2. 创建 HOOK.md：

   ```markdown
   ---
   name: my-hook
   description: "我的自定义钩子"
   metadata: { "openclaw": { "emoji": "🎯", "events": ["command:new"] } }
   ---

   # My Hook

   做一些有用的事情。
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

4. 验证并重启你的 Gateway网关进程：
   ```bash
   openclaw hooks list
   # 应该显示：🎯 my-hook ✓
   ```

**迁移的好处**：

- 自动发现
- CLI 管理
- 资格检查
- 更好的文档
- 一致的结构

## 另请参阅

- [CLI 参考：hooks](/cli/hooks)
- [内置钩子 README](https://github.com/openclaw/openclaw/tree/main/src/hooks/bundled)
- [Webhook 钩子](/automation/webhook)
- [配置](/gateway/configuration#hooks)
