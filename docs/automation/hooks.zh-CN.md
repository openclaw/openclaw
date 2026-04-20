---
summary: "钩子：命令和生命周期事件的事件驱动自动化"
read_when:
  - 您希望为 /new、/reset、/stop 和代理生命周期事件提供事件驱动自动化
  - 您希望构建、安装或调试钩子
title: "钩子"
---

# 钩子

钩子是在网关内部发生某些事情时运行的小型脚本。它们会从目录中自动发现，并可以通过 `openclaw hooks` 进行检查。

OpenClaw 中有两种类型的钩子：

- **内部钩子**（本页面）：当代理事件触发时在网关内运行，如 `/new`、`/reset`、`/stop` 或生命周期事件。
- **Webhooks**：允许其他系统在 OpenClaw 中触发工作的外部 HTTP 端点。请参阅 [Webhooks](/automation/cron-jobs#webhooks)。

钩子也可以捆绑在插件中。`openclaw hooks list` 显示独立钩子和插件管理的钩子。

## 快速开始

```bash
# 列出可用的钩子
openclaw hooks list

# 启用钩子
openclaw hooks enable session-memory

# 检查钩子状态
openclaw hooks check

# 获取详细信息
openclaw hooks info session-memory
```

## 事件类型

| 事件                    | 触发时机                                    |
| ------------------------ | ------------------------------------------------ |
| `command:new`            | 发出 `/new` 命令                            |
| `command:reset`          | 发出 `/reset` 命令                          |
| `command:stop`           | 发出 `/stop` 命令                           |
| `command`                | 任何命令事件（通用监听器）             |
| `session:compact:before` | 在压缩总结历史之前             |
| `session:compact:after`  | 压缩完成之后                       |
| `session:patch`          | 当会话属性被修改时             |
| `agent:bootstrap`        | 在注入工作区引导文件之前    |
| `gateway:startup`        | 通道启动和钩子加载之后        |
| `message:received`       | 来自任何通道的入站消息                 |
| `message:transcribed`    | 音频转录完成之后              |
| `message:preprocessed`   | 所有媒体和链接理解完成之后 |
| `message:sent`           | 出站消息已传递                       |

## 编写钩子

### 钩子结构

每个钩子是一个包含两个文件的目录：

```
my-hook/
├── HOOK.md          # 元数据 + 文档
└── handler.ts       # 处理程序实现
```

### HOOK.md 格式

```markdown
---
name: my-hook
description: "此钩子功能的简短描述"
metadata:
  { "openclaw": { "emoji": "🔗", "events": ["command:new"], "requires": { "bins": ["node"] } } }
---

# My Hook

详细文档放在这里。
```

**元数据字段** (`metadata.openclaw`)：

| 字段      | 描述                                          |
| ---------- | ---------------------------------------------------- |
| `emoji`    | CLI 的显示表情                                |
| `events`   | 要监听的事件数组                        |
| `export`   | 要使用的命名导出（默认为 `"default"`）        |
| `os`       | 必需的平台（例如，`["darwin", "linux"]`）     |
| `requires` | 必需的 `bins`、`anyBins`、`env` 或 `config` 路径 |
| `always`   | 绕过资格检查（布尔值）                  |
| `install`  | 安装方法                                 |

### 处理程序实现

```typescript
const handler = async (event) => {
  if (event.type !== "command" || event.action !== "new") {
    return;
  }

  console.log(`[my-hook] New command triggered`);
  // 您的逻辑在这里

  // 可选地向用户发送消息
  event.messages.push("Hook executed!");
};

export default handler;
```

每个事件都包括：`type`、`action`、`sessionKey`、`timestamp`、`messages`（推送以发送给用户）和 `context`（事件特定数据）。

### 事件上下文要点

**命令事件** (`command:new`, `command:reset`)：`context.sessionEntry`、`context.previousSessionEntry`、`context.commandSource`、`context.workspaceDir`、`context.cfg`。

**消息事件** (`message:received`)：`context.from`、`context.content`、`context.channelId`、`context.metadata`（提供商特定数据，包括 `senderId`、`senderName`、`guildId`）。

**消息事件** (`message:sent`)：`context.to`、`context.content`、`context.success`、`context.channelId`。

**消息事件** (`message:transcribed`)：`context.transcript`、`context.from`、`context.channelId`、`context.mediaPath`。

**消息事件** (`message:preprocessed`)：`context.bodyForAgent`（最终丰富的正文）、`context.from`、`context.channelId`。

**引导事件** (`agent:bootstrap`)：`context.bootstrapFiles`（可变数组）、`context.agentId`。

**会话补丁事件** (`session:patch`)：`context.sessionEntry`、`context.patch`（仅更改的字段）、`context.cfg`。只有特权客户端才能触发补丁事件。

**压缩事件**：`session:compact:before` 包括 `messageCount`、`tokenCount`。`session:compact:after` 添加 `compactedCount`、`summaryLength`、`tokensBefore`、`tokensAfter`。

## 钩子发现

钩子从以下目录中发现，按优先级递增顺序：

1. **捆绑钩子**：随 OpenClaw 一起提供
2. **插件钩子**：捆绑在已安装插件中的钩子
3. **托管钩子**：`~/.openclaw/hooks/`（用户安装，跨工作区共享）。来自 `hooks.internal.load.extraDirs` 的额外目录共享此优先级。
4. **工作区钩子**：`<workspace>/hooks/`（每代理，默认禁用，直到明确启用）

工作区钩子可以添加新的钩子名称，但不能覆盖具有相同名称的捆绑、托管或插件提供的钩子。

### 钩子包

钩子包是通过 `package.json` 中的 `openclaw.hooks` 导出钩子的 npm 包。安装方式：

```bash
openclaw plugins install <path-or-spec>
```

Npm 规范仅支持注册表（包名 + 可选的精确版本或 dist-tag）。Git/URL/文件规范和 semver 范围被拒绝。

## 捆绑钩子

| 钩子                  | 事件                         | 功能                                          |
| --------------------- | ------------------------------ | ----------------------------------------------------- |
| session-memory        | `command:new`, `command:reset` | 将会话上下文保存到 `<workspace>/memory/`        |
| bootstrap-extra-files | `agent:bootstrap`              | 从 glob 模式注入额外的引导文件 |
| command-logger        | `command`                      | 将所有命令记录到 `~/.openclaw/logs/commands.log`  |
| boot-md               | `gateway:startup`              | 网关启动时运行 `BOOT.md`                |

启用任何捆绑钩子：

```bash
openclaw hooks enable <hook-name>
```

<a id="session-memory"></a>

### session-memory 详细信息

提取最后 15 条用户/助手消息，通过 LLM 生成描述性文件名 slug，并保存到 `<workspace>/memory/YYYY-MM-DD-slug.md`。需要配置 `workspace.dir`。

<a id="bootstrap-extra-files"></a>

### bootstrap-extra-files 配置

```json
{
  "hooks": {
    "internal": {
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

路径相对于工作区解析。仅加载识别的引导文件名（`AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`、`BOOTSTRAP.md`、`MEMORY.md`）。

<a id="command-logger"></a>

### command-logger 详细信息

将每个斜杠命令记录到 `~/.openclaw/logs/commands.log`。

<a id="boot-md"></a>

### boot-md 详细信息

网关启动时从活动工作区运行 `BOOT.md`。

## 插件钩子

插件可以通过 Plugin SDK 注册钩子以进行更深层次的集成：拦截工具调用、修改提示、控制消息流等。Plugin SDK 公开 28 个钩子，涵盖模型解析、代理生命周期、消息流、工具执行、子代理协调和网关生命周期。

有关完整的插件钩子参考，包括 `before_tool_call`、`before_agent_reply`、`before_install` 和所有其他插件钩子，请参阅 [插件架构](/plugins/architecture#provider-runtime-hooks)。

## 配置

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

每钩子环境变量：

```json
{
  "hooks": {
    "internal": {
      "entries": {
        "my-hook": {
          "enabled": true,
          "env": { "MY_CUSTOM_VAR": "value" }
        }
      }
    }
  }
}
```

额外的钩子目录：

```json
{
  "hooks": {
    "internal": {
      "load": {
        "extraDirs": ["/path/to/more/hooks"]
      }
    }
  }
}
```

<Note>
为了向后兼容，仍然支持旧的 `hooks.internal.handlers` 数组配置格式，但新钩子应使用基于发现的系统。
</Note>

## CLI 参考

```bash
# 列出所有钩子（添加 --eligible、--verbose 或 --json）
openclaw hooks list

# 显示关于钩子的详细信息
openclaw hooks info <hook-name>

# 显示资格摘要
openclaw hooks check

# 启用/禁用
openclaw hooks enable <hook-name>
openclaw hooks disable <hook-name>
```

## 最佳实践

- **保持处理程序快速**。钩子在命令处理期间运行。使用 `void processInBackground(event)` 进行即发即忘的繁重工作。
- **优雅处理错误**。将风险操作包装在 try/catch 中；不要抛出异常，以便其他处理程序可以运行。
- **尽早过滤事件**。如果事件类型/操作不相关，立即返回。
- **使用特定的事件键**。优先使用 `"events": ["command:new"]` 而不是 `"events": ["command"]` 以减少开销。

## 故障排除

### 钩子未被发现

```bash
# 验证目录结构
ls -la ~/.openclaw/hooks/my-hook/
# 应该显示：HOOK.md, handler.ts

# 列出所有发现的钩子
openclaw hooks list
```

### 钩子不符合条件

```bash
openclaw hooks info my-hook
```

检查缺失的二进制文件（PATH）、环境变量、配置值或操作系统兼容性。

### 钩子未执行

1. 验证钩子已启用：`openclaw hooks list`
2. 重启网关进程以便钩子重新加载。
3. 检查网关日志：`./scripts/clawlog.sh | grep hook`

## 相关

- [CLI 参考：hooks](/cli/hooks)
- [Webhooks](/automation/cron-jobs#webhooks)
- [插件架构](/plugins/architecture#provider-runtime-hooks) — 完整的插件钩子参考
- [配置](/gateway/configuration-reference#hooks)