---
read_when:
  - 添加或修改配置字段时
summary: ~/.openclaw/openclaw.json 的所有配置选项及示例
title: 配置
x-i18n:
  generated_at: "2026-02-01T21:29:41Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: b5e51290bbc755acb259ad455878625aa894c115e5c0ac6a1a3397e10fff8b4b
  source_path: gateway/configuration.md
  workflow: 15
---

# 配置 🔧

OpenClaw 从 `~/.openclaw/openclaw.json` 读取可选的 **JSON5** 配置（支持注释和尾逗号）。

如果文件不存在，OpenClaw 使用安全的默认值（内置 Pi 智能体 + 按发送者分会话 + 工作区 `~/.openclaw/workspace`）。通常只在以下情况需要配置：

- 限制谁可以触发机器人（`channels.whatsapp.allowFrom`、`channels.telegram.allowFrom` 等）
- 控制群组白名单 + 提及行为（`channels.whatsapp.groups`、`channels.telegram.groups`、`channels.discord.guilds`、`agents.list[].groupChat`）
- 自定义消息前缀（`messages`）
- 设置智能体工作区（`agents.defaults.workspace` 或 `agents.list[].workspace`）
- 调整内置智能体默认值（`agents.defaults`）和会话行为（`session`）
- 设置每个智能体的身份标识（`agents.list[].identity`）

> **初次接触配置？** 请查阅[配置示例](/gateway/configuration-examples)指南，获取带有详细说明的完整示例！

## 严格配置验证

OpenClaw 只接受完全匹配 schema 的配置。
未知键、类型错误或无效值会导致 Gateway 网关 **拒绝启动**以确保安全。

验证失败时：

- Gateway 网关不会启动。
- 只允许诊断命令（例如：`openclaw doctor`、`openclaw logs`、`openclaw health`、`openclaw status`、`openclaw service`、`openclaw help`）。
- 运行 `openclaw doctor` 查看具体问题。
- 运行 `openclaw doctor --fix`（或 `--yes`）应用迁移/修复。

Doctor 不会写入任何更改，除非你明确选择了 `--fix`/`--yes`。

## Schema + UI 提示

Gateway 网关通过 `config.schema` 暴露配置的 JSON Schema 表示，供 UI 编辑器使用。
控制台 UI 根据此 schema 渲染表单，并提供 **Raw JSON** 编辑器作为应急手段。

渠道插件和扩展可以为其配置注册 schema + UI 提示，因此渠道设置
在各应用间保持 schema 驱动，无需硬编码表单。

提示信息（标签、分组、敏感字段）随 schema 一起提供，客户端无需硬编码配置知识即可渲染更好的表单。

## 应用 + 重启（RPC）

使用 `config.apply` 在一步中验证 + 写入完整配置并重启 Gateway 网关。
它会写入重启哨兵文件，并在 Gateway 网关恢复后 ping 最后活跃的会话。

警告：`config.apply` 会替换**整个配置**。如果你只想更改部分键，
请使用 `config.patch` 或 `openclaw config set`。请备份 `~/.openclaw/openclaw.json`。

参数：

- `raw`（字符串）— 整个配置的 JSON5 负载
- `baseHash`（可选）— 来自 `config.get` 的配置哈希（当配置已存在时为必需）
- `sessionKey`（可选）— 最后活跃会话的键，用于唤醒 ping
- `note`（可选）— 包含在重启哨兵中的备注
- `restartDelayMs`（可选）— 重启前的延迟（默认 2000）

示例（通过 `gateway call`）：

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.apply --params '{
  "raw": "{\\n  agents: { defaults: { workspace: \\"~/.openclaw/workspace\\" } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## 部分更新（RPC）

使用 `config.patch` 将部分更新合并到现有配置中，而不会覆盖
无关的键。它采用 JSON merge patch 语义：

- 对象递归合并
- `null` 删除键
- 数组替换
  与 `config.apply` 类似，它会验证、写入配置、存储重启哨兵，并调度
  Gateway 网关重启（当提供 `sessionKey` 时可选择唤醒）。

参数：

- `raw`（字符串）— 仅包含要更改的键的 JSON5 负载
- `baseHash`（必需）— 来自 `config.get` 的配置哈希
- `sessionKey`（可选）— 最后活跃会话的键，用于唤醒 ping
- `note`（可选）— 包含在重启哨兵中的备注
- `restartDelayMs`（可选）— 重启前的延迟（默认 2000）

示例：

```bash
openclaw gateway call config.get --params '{}' # capture payload.hash
openclaw gateway call config.patch --params '{
  "raw": "{\\n  channels: { telegram: { groups: { \\"*\\": { requireMention: false } } } }\\n}\\n",
  "baseHash": "<hash-from-config.get>",
  "sessionKey": "agent:main:whatsapp:dm:+15555550123",
  "restartDelayMs": 1000
}'
```

## 最小配置（推荐起点）

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
  channels: { whatsapp: { allowFrom: ["+15555550123"] } },
}
```

首次构建默认镜像：

```bash
scripts/sandbox-setup.sh
```

## 自聊天模式（推荐用于群组控制）

防止机器人在群组中响应 WhatsApp @提及（仅响应特定文本触发器）：

```json5
{
  agents: {
    defaults: { workspace: "~/.openclaw/workspace" },
    list: [
      {
        id: "main",
        groupChat: { mentionPatterns: ["@openclaw", "reisponde"] },
      },
    ],
  },
  channels: {
    whatsapp: {
      // 白名单仅适用于私聊；包含你自己的号码可启用自聊天模式。
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
}
```

## 配置包含（`$include`）

使用 `$include` 指令将配置拆分为多个文件。适用于：

- 组织大型配置（例如按客户定义智能体）
- 跨环境共享通用设置
- 将敏感配置单独存放

### 基本用法

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789 },

  // 包含单个文件（替换该键的值）
  agents: { $include: "./agents.json5" },

  // 包含多个文件（按顺序深度合并）
  broadcast: {
    $include: ["./clients/mueller.json5", "./clients/schmidt.json5"],
  },
}
```

```json5
// ~/.openclaw/agents.json5
{
  defaults: { sandbox: { mode: "all", scope: "session" } },
  list: [{ id: "main", workspace: "~/.openclaw/workspace" }],
}
```

### 合并行为

- **单个文件**：替换包含 `$include` 的对象
- **文件数组**：按顺序深度合并（后面的文件覆盖前面的）
- **带兄弟键**：兄弟键在包含之后合并（覆盖被包含的值）
- **兄弟键 + 数组/原始值**：不支持（被包含的内容必须是对象）

```json5
// 兄弟键覆盖被包含的值
{
  $include: "./base.json5", // { a: 1, b: 2 }
  b: 99, // 结果：{ a: 1, b: 99 }
}
```

### 嵌套包含

被包含的文件本身可以包含 `$include` 指令（最多 10 层深度）：

```json5
// clients/mueller.json5
{
  agents: { $include: "./mueller/agents.json5" },
  broadcast: { $include: "./mueller/broadcast.json5" },
}
```

### 路径解析

- **相对路径**：相对于包含文件解析
- **绝对路径**：直接使用
- **父目录**：`../` 引用按预期工作

```json5
{ "$include": "./sub/config.json5" }      // 相对路径
{ "$include": "/etc/openclaw/base.json5" } // 绝对路径
{ "$include": "../shared/common.json5" }   // 父目录
```

### 错误处理

- **文件缺失**：显示清晰的错误及解析后的路径
- **解析错误**：显示哪个被包含的文件出错
- **循环包含**：检测并报告包含链

### 示例：多客户法律事务设置

```json5
// ~/.openclaw/openclaw.json
{
  gateway: { port: 18789, auth: { token: "secret" } },

  // 通用智能体默认值
  agents: {
    defaults: {
      sandbox: { mode: "all", scope: "session" },
    },
    // 合并所有客户的智能体列表
    list: { $include: ["./clients/mueller/agents.json5", "./clients/schmidt/agents.json5"] },
  },

  // 合并广播配置
  broadcast: {
    $include: ["./clients/mueller/broadcast.json5", "./clients/schmidt/broadcast.json5"],
  },

  channels: { whatsapp: { groupPolicy: "allowlist" } },
}
```

```json5
// ~/.openclaw/clients/mueller/agents.json5
[
  { id: "mueller-transcribe", workspace: "~/clients/mueller/transcribe" },
  { id: "mueller-docs", workspace: "~/clients/mueller/docs" },
]
```

```json5
// ~/.openclaw/clients/mueller/broadcast.json5
{
  "120363403215116621@g.us": ["mueller-transcribe", "mueller-docs"],
}
```

## 常用选项

### 环境变量 + `.env`

OpenClaw 从父进程（shell、launchd/systemd、CI 等）读取环境变量。

此外，它还会加载：

- 当前工作目录中的 `.env`（如果存在）
- `~/.openclaw/.env`（即 `$OPENCLAW_STATE_DIR/.env`）作为全局回退 `.env`

两个 `.env` 文件都不会覆盖已有的环境变量。

你也可以在配置中提供内联环境变量。这些仅在进程环境中缺少该键时应用（相同的不覆盖规则）：

```json5
{
  env: {
    OPENROUTER_API_KEY: "sk-or-...",
    vars: {
      GROQ_API_KEY: "gsk-...",
    },
  },
}
```

参见 [/environment](/environment) 了解优先级和来源详情。

### `env.shellEnv`（可选）

可选便利功能：如果启用且预期键均未设置，OpenClaw 会运行你的登录 shell 并仅导入缺失的预期键（不会覆盖）。
这实际上会 source 你的 shell 配置文件。

```json5
{
  env: {
    shellEnv: {
      enabled: true,
      timeoutMs: 15000,
    },
  },
}
```

等效环境变量：

- `OPENCLAW_LOAD_SHELL_ENV=1`
- `OPENCLAW_SHELL_ENV_TIMEOUT_MS=15000`

### 配置中的环境变量替换

你可以在任何配置字符串值中使用 `${VAR_NAME}` 语法直接引用环境变量。变量在配置加载时、验证之前进行替换。

```json5
{
  models: {
    providers: {
      "vercel-gateway": {
        apiKey: "${VERCEL_GATEWAY_API_KEY}",
      },
    },
  },
  gateway: {
    auth: {
      token: "${OPENCLAW_GATEWAY_TOKEN}",
    },
  },
}
```

**规则：**

- 仅匹配大写环境变量名：`[A-Z_][A-Z0-9_]*`
- 缺失或为空的环境变量在配置加载时会抛出错误
- 使用 `$${VAR}` 转义以输出字面量 `${VAR}`
- 与 `$include` 配合使用（被包含的文件也会进行替换）

**内联替换：**

```json5
{
  models: {
    providers: {
      custom: {
        baseUrl: "${CUSTOM_API_BASE}/v1", // → "https://api.example.com/v1"
      },
    },
  },
}
```

### 认证存储（OAuth + API 密钥）

OpenClaw 在以下位置存储**每个智能体的**认证配置文件（OAuth + API 密钥）：

- `<agentDir>/auth-profiles.json`（默认：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`）

另请参阅：[/concepts/oauth](/concepts/oauth)

旧版 OAuth 导入：

- `~/.openclaw/credentials/oauth.json`（或 `$OPENCLAW_STATE_DIR/credentials/oauth.json`）

内置 Pi 智能体在以下位置维护运行时缓存：

- `<agentDir>/auth.json`（自动管理；请勿手动编辑）

旧版智能体目录（多智能体之前）：

- `~/.openclaw/agent/*`（由 `openclaw doctor` 迁移到 `~/.openclaw/agents/<defaultAgentId>/agent/*`）

覆盖：

- OAuth 目录（仅旧版导入）：`OPENCLAW_OAUTH_DIR`
- 智能体目录（默认智能体根目录覆盖）：`OPENCLAW_AGENT_DIR`（推荐）、`PI_CODING_AGENT_DIR`（旧版）

首次使用时，OpenClaw 会将 `oauth.json` 条目导入到 `auth-profiles.json` 中。

### `auth`

认证配置文件的可选元数据。这**不**存储密钥；它将配置文件 ID 映射到提供商 + 模式（以及可选的邮箱），并定义用于故障转移的提供商轮换顺序。

```json5
{
  auth: {
    profiles: {
      "anthropic:me@example.com": { provider: "anthropic", mode: "oauth", email: "me@example.com" },
      "anthropic:work": { provider: "anthropic", mode: "api_key" },
    },
    order: {
      anthropic: ["anthropic:me@example.com", "anthropic:work"],
    },
  },
}
```

### `agents.list[].identity`

用于默认值和用户体验的可选每智能体身份标识。由 macOS 新手引导助手写入。

如果设置了，OpenClaw 会推导默认值（仅在你未明确设置时）：

- `messages.ackReaction` 来自**活跃智能体**的 `identity.emoji`（回退到 👀）
- `agents.list[].groupChat.mentionPatterns` 来自智能体的 `identity.name`/`identity.emoji`（因此 "@Samantha" 在 Telegram/Slack/Discord/Google Chat/iMessage/WhatsApp 的群组中均可使用）
- `identity.avatar` 接受工作区相对图片路径或远程 URL/data URL。本地文件必须位于智能体工作区内。

`identity.avatar` 接受：

- 工作区相对路径（必须在智能体工作区内）
- `http(s)` URL
- `data:` URI

```json5
{
  agents: {
    list: [
      {
        id: "main",
        identity: {
          name: "Samantha",
          theme: "helpful sloth",
          emoji: "🦥",
          avatar: "avatars/samantha.png",
        },
      },
    ],
  },
}
```

### `wizard`

由 CLI 向导（`onboard`、`configure`、`doctor`）写入的元数据。

```json5
{
  wizard: {
    lastRunAt: "2026-01-01T00:00:00.000Z",
    lastRunVersion: "2026.1.4",
    lastRunCommit: "abc1234",
    lastRunCommand: "configure",
    lastRunMode: "local",
  },
}
```

### `logging`

- 默认日志文件：`/tmp/openclaw/openclaw-YYYY-MM-DD.log`
- 如需稳定路径，将 `logging.file` 设为 `/tmp/openclaw/openclaw.log`。
- 控制台输出可通过以下方式单独调整：
  - `logging.consoleLevel`（默认 `info`，使用 `--verbose` 时提升为 `debug`）
  - `logging.consoleStyle`（`pretty` | `compact` | `json`）
- 工具摘要可以脱敏以避免泄露密钥：
  - `logging.redactSensitive`（`off` | `tools`，默认：`tools`）
  - `logging.redactPatterns`（正则表达式字符串数组；覆盖默认值）

```json5
{
  logging: {
    level: "info",
    file: "/tmp/openclaw/openclaw.log",
    consoleLevel: "info",
    consoleStyle: "pretty",
    redactSensitive: "tools",
    redactPatterns: [
      // 示例：用自定义规则覆盖默认值。
      "\\bTOKEN\\b\\s*[=:]\\s*([\"']?)([^\\s\"']+)\\1",
      "/\\bsk-[A-Za-z0-9_-]{8,}\\b/gi",
    ],
  },
}
```

### `channels.whatsapp.dmPolicy`

控制 WhatsApp 私聊（私信）的处理方式：

- `"pairing"`（默认）：未知发送者会收到配对码；所有者必须批准
- `"allowlist"`：仅允许 `channels.whatsapp.allowFrom`（或已配对的允许存储）中的发送者
- `"open"`：允许所有入站私聊（**需要** `channels.whatsapp.allowFrom` 包含 `"*"`）
- `"disabled"`：忽略所有入站私聊

配对码在 1 小时后过期；机器人仅在创建新请求时发送配对码。待处理的私聊配对请求默认每个渠道上限为 **3 个**。

配对批准：

- `openclaw pairing list whatsapp`
- `openclaw pairing approve whatsapp <code>`

### `channels.whatsapp.allowFrom`

允许触发 WhatsApp 自动回复的 E.164 电话号码白名单（**仅限私聊**）。
如果为空且 `channels.whatsapp.dmPolicy="pairing"`，未知发送者将收到配对码。
对于群组，使用 `channels.whatsapp.groupPolicy` + `channels.whatsapp.groupAllowFrom`。

```json5
{
  channels: {
    whatsapp: {
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "+447700900123"],
      textChunkLimit: 4000, // 可选的出站分块大小（字符数）
      chunkMode: "length", // 可选的分块模式（length | newline）
      mediaMaxMb: 50, // 可选的入站媒体上限（MB）
    },
  },
}
```

### `channels.whatsapp.sendReadReceipts`

控制入站 WhatsApp 消息是否标记为已读（蓝色双勾）。默认：`true`。

自聊天模式始终跳过已读回执，即使已启用。

每账号覆盖：`channels.whatsapp.accounts.<id>.sendReadReceipts`。

```json5
{
  channels: {
    whatsapp: { sendReadReceipts: false },
  },
}
```

### `channels.whatsapp.accounts`（多账号）

在一个 Gateway 网关中运行多个 WhatsApp 账号：

```json5
{
  channels: {
    whatsapp: {
      accounts: {
        default: {}, // 可选；保持默认 id 稳定
        personal: {},
        biz: {
          // 可选覆盖。默认：~/.openclaw/credentials/whatsapp/biz
          // authDir: "~/.openclaw/credentials/whatsapp/biz",
        },
      },
    },
  },
}
```

说明：

- 出站命令默认使用 `default` 账号（如果存在）；否则使用第一个配置的账号 id（排序后）。
- 旧版单账号 Baileys 认证目录由 `openclaw doctor` 迁移到 `whatsapp/default`。

### `channels.telegram.accounts` / `channels.discord.accounts` / `channels.googlechat.accounts` / `channels.slack.accounts` / `channels.mattermost.accounts` / `channels.signal.accounts` / `channels.imessage.accounts`

每个渠道运行多个账号（每个账号有自己的 `accountId` 和可选的 `name`）：

```json5
{
  channels: {
    telegram: {
      accounts: {
        default: {
          name: "Primary bot",
          botToken: "123456:ABC...",
        },
        alerts: {
          name: "Alerts bot",
          botToken: "987654:XYZ...",
        },
      },
    },
  },
}
```

说明：

- 省略 `accountId` 时使用 `default`（CLI + 路由）。
- 环境变量 token 仅适用于**默认**账号。
- 基础渠道设置（群组策略、提及门控等）适用于所有账号，除非在每个账号中单独覆盖。
- 使用 `bindings[].match.accountId` 将每个账号路由到不同的 agents.defaults。

### 群聊提及门控（`agents.list[].groupChat` + `messages.groupChat`）

群消息默认**需要提及**（元数据提及或正则模式）。适用于 WhatsApp、Telegram、Discord、Google Chat 和 iMessage 群聊。

**提及类型：**

- **元数据提及**：原生平台 @提及（例如 WhatsApp 点按提及）。在 WhatsApp 自聊天模式中被忽略（参见 `channels.whatsapp.allowFrom`）。
- **文本模式**：在 `agents.list[].groupChat.mentionPatterns` 中定义的正则模式。无论自聊天模式如何始终检查。
- 提及门控仅在可以检测提及时执行（原生提及或至少一个 `mentionPattern`）。

```json5
{
  messages: {
    groupChat: { historyLimit: 50 },
  },
  agents: {
    list: [{ id: "main", groupChat: { mentionPatterns: ["@openclaw", "openclaw"] } }],
  },
}
```

`messages.groupChat.historyLimit` 设置群组历史上下文的全局默认值。渠道可以通过 `channels.<channel>.historyLimit`（或多账号的 `channels.<channel>.accounts.*.historyLimit`）覆盖。设为 `0` 禁用历史包装。

#### 私聊历史限制

私聊对话使用由智能体管理的基于会话的历史。你可以限制每个私聊会话保留的用户轮次数：

```json5
{
  channels: {
    telegram: {
      dmHistoryLimit: 30, // 将私聊会话限制为 30 个用户轮次
      dms: {
        "123456789": { historyLimit: 50 }, // 每用户覆盖（用户 ID）
      },
    },
  },
}
```

解析顺序：

1. 每私聊覆盖：`channels.<provider>.dms[userId].historyLimit`
2. 提供商默认值：`channels.<provider>.dmHistoryLimit`
3. 无限制（保留所有历史）

支持的提供商：`telegram`、`whatsapp`、`discord`、`slack`、`signal`、`imessage`、`msteams`。

每智能体覆盖（设置后优先，即使为 `[]`）：

```json5
{
  agents: {
    list: [
      { id: "work", groupChat: { mentionPatterns: ["@workbot", "\\+15555550123"] } },
      { id: "personal", groupChat: { mentionPatterns: ["@homebot", "\\+15555550999"] } },
    ],
  },
}
```

提及门控默认值按渠道设置（`channels.whatsapp.groups`、`channels.telegram.groups`、`channels.imessage.groups`、`channels.discord.guilds`）。当设置了 `*.groups` 时，它也充当群组白名单；包含 `"*"` 以允许所有群组。

仅响应特定文本触发器（忽略原生 @提及）：

```json5
{
  channels: {
    whatsapp: {
      // 包含你自己的号码以启用自聊天模式（忽略原生 @提及）。
      allowFrom: ["+15555550123"],
      groups: { "*": { requireMention: true } },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          // 仅这些文本模式会触发响应
          mentionPatterns: ["reisponde", "@openclaw"],
        },
      },
    ],
  },
}
```

### 群组策略（按渠道）

使用 `channels.*.groupPolicy` 控制是否接受群组/房间消息：

```json5
{
  channels: {
    whatsapp: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
    telegram: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["tg:123456789", "@alice"],
    },
    signal: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15551234567"],
    },
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["chat_id:123"],
    },
    msteams: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["user@org.com"],
    },
    discord: {
      groupPolicy: "allowlist",
      guilds: {
        GUILD_ID: {
          channels: { help: { allow: true } },
        },
      },
    },
    slack: {
      groupPolicy: "allowlist",
      channels: { "#general": { allow: true } },
    },
  },
}
```

说明：

- `"open"`：群组绕过白名单；提及门控仍然适用。
- `"disabled"`：阻止所有群组/房间消息。
- `"allowlist"`：仅允许匹配配置白名单的群组/房间。
- `channels.defaults.groupPolicy` 设置提供商的 `groupPolicy` 未设置时的默认值。
- WhatsApp/Telegram/Signal/iMessage/Microsoft Teams 使用 `groupAllowFrom`（回退：显式 `allowFrom`）。
- Discord/Slack 使用渠道白名单（`channels.discord.guilds.*.channels`、`channels.slack.channels`）。
- 群组私聊（Discord/Slack）仍由 `dm.groupEnabled` + `dm.groupChannels` 控制。
- 默认为 `groupPolicy: "allowlist"`（除非被 `channels.defaults.groupPolicy` 覆盖）；如果未配置白名单，群组消息将被阻止。

### 多智能体路由（`agents.list` + `bindings`）

在一个 Gateway 网关中运行多个隔离的智能体（独立的工作区、`agentDir`、会话）。
入站消息通过绑定路由到智能体。

- `agents.list[]`：每智能体覆盖。
  - `id`：稳定的智能体 id（必需）。
  - `default`：可选；当设置多个时，第一个获胜并记录警告。
    如果未设置，列表中的**第一个条目**为默认智能体。
  - `name`：智能体的显示名称。
  - `workspace`：默认 `~/.openclaw/workspace-<agentId>`（对于 `main`，回退到 `agents.defaults.workspace`）。
  - `agentDir`：默认 `~/.openclaw/agents/<agentId>/agent`。
  - `model`：每智能体默认模型，覆盖该智能体的 `agents.defaults.model`。
    - 字符串形式：`"provider/model"`，仅覆盖 `agents.defaults.model.primary`
    - 对象形式：`{ primary, fallbacks }`（fallbacks 覆盖 `agents.defaults.model.fallbacks`；`[]` 为该智能体禁用全局回退）
  - `identity`：每智能体的名称/主题/表情（用于提及模式 + 确认反应）。
  - `groupChat`：每智能体的提及门控（`mentionPatterns`）。
  - `sandbox`：每智能体的沙箱配置（覆盖 `agents.defaults.sandbox`）。
    - `mode`：`"off"` | `"non-main"` | `"all"`
    - `workspaceAccess`：`"none"` | `"ro"` | `"rw"`
    - `scope`：`"session"` | `"agent"` | `"shared"`
    - `workspaceRoot`：自定义沙箱工作区根目录
    - `docker`：每智能体 docker 覆盖（例如 `image`、`network`、`env`、`setupCommand`、限制；`scope: "shared"` 时忽略）
    - `browser`：每智能体沙箱浏览器覆盖（`scope: "shared"` 时忽略）
    - `prune`：每智能体沙箱清理覆盖（`scope: "shared"` 时忽略）
  - `subagents`：每智能体子智能体默认值。
    - `allowAgents`：允许从此智能体执行 `sessions_spawn` 的智能体 id 白名单（`["*"]` = 允许任何；默认：仅同一智能体）
  - `tools`：每智能体工具限制（在沙箱工具策略之前应用）。
    - `profile`：基础工具配置文件（在 allow/deny 之前应用）
    - `allow`：允许的工具名称数组
    - `deny`：拒绝的工具名称数组（deny 优先）
- `agents.defaults`：共享的智能体默认值（模型、工作区、沙箱等）。
- `bindings[]`：将入站消息路由到 `agentId`。
  - `match.channel`（必需）
  - `match.accountId`（可选；`*` = 任何账号；省略 = 默认账号）
  - `match.peer`（可选；`{ kind: dm|group|channel, id }`）
  - `match.guildId` / `match.teamId`（可选；渠道特定）

确定性匹配顺序：

1. `match.peer`
2. `match.guildId`
3. `match.teamId`
4. `match.accountId`（精确匹配，无 peer/guild/team）
5. `match.accountId: "*"`（渠道范围，无 peer/guild/team）
6. 默认智能体（`agents.list[].default`，否则第一个列表条目，否则 `"main"`）

在每个匹配层级内，`bindings` 中的第一个匹配条目获胜。

#### 每智能体访问配置（多智能体）

每个智能体可以携带自己的沙箱 + 工具策略。用于在一个 Gateway 网关中混合访问级别：

- **完全访问**（个人智能体）
- **只读**工具 + 工作区
- **无文件系统访问**（仅消息/会话工具）

参见[多智能体沙箱与工具](/multi-agent-sandbox-tools)了解优先级和更多示例。

完全访问（无沙箱）：

```json5
{
  agents: {
    list: [
      {
        id: "personal",
        workspace: "~/.openclaw/workspace-personal",
        sandbox: { mode: "off" },
      },
    ],
  },
}
```

只读工具 + 只读工作区：

```json5
{
  agents: {
    list: [
      {
        id: "family",
        workspace: "~/.openclaw/workspace-family",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "ro",
        },
        tools: {
          allow: [
            "read",
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
          ],
          deny: ["write", "edit", "apply_patch", "exec", "process", "browser"],
        },
      },
    ],
  },
}
```

无文件系统访问（启用消息/会话工具）：

```json5
{
  agents: {
    list: [
      {
        id: "public",
        workspace: "~/.openclaw/workspace-public",
        sandbox: {
          mode: "all",
          scope: "agent",
          workspaceAccess: "none",
        },
        tools: {
          allow: [
            "sessions_list",
            "sessions_history",
            "sessions_send",
            "sessions_spawn",
            "session_status",
            "whatsapp",
            "telegram",
            "slack",
            "discord",
            "gateway",
          ],
          deny: [
            "read",
            "write",
            "edit",
            "apply_patch",
            "exec",
            "process",
            "browser",
            "canvas",
            "nodes",
            "cron",
            "gateway",
            "image",
          ],
        },
      },
    ],
  },
}
```

示例：两个 WhatsApp 账号 → 两个智能体：

```json5
{
  agents: {
    list: [
      { id: "home", default: true, workspace: "~/.openclaw/workspace-home" },
      { id: "work", workspace: "~/.openclaw/workspace-work" },
    ],
  },
  bindings: [
    { agentId: "home", match: { channel: "whatsapp", accountId: "personal" } },
    { agentId: "work", match: { channel: "whatsapp", accountId: "biz" } },
  ],
  channels: {
    whatsapp: {
      accounts: {
        personal: {},
        biz: {},
      },
    },
  },
}
```

### `tools.agentToAgent`（可选）

智能体间消息传递为可选功能：

```json5
{
  tools: {
    agentToAgent: {
      enabled: false,
      allow: ["home", "work"],
    },
  },
}
```

### `messages.queue`

控制智能体运行已在执行时入站消息的行为。

```json5
{
  messages: {
    queue: {
      mode: "collect", // steer | followup | collect | steer-backlog (steer+backlog ok) | interrupt (queue=steer legacy)
      debounceMs: 1000,
      cap: 20,
      drop: "summarize", // old | new | summarize
      byChannel: {
        whatsapp: "collect",
        telegram: "collect",
        discord: "collect",
        imessage: "collect",
        webchat: "collect",
      },
    },
  },
}
```

### `messages.inbound`

防抖**同一发送者**的快速入站消息，使多条连续消息合并为一个智能体轮次。防抖按渠道 + 对话进行范围限定，并使用最新消息进行回复线程/ID。

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000, // 0 禁用
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

说明：

- 防抖仅批量处理**纯文本**消息；媒体/附件立即刷新。
- 控制命令（例如 `/queue`、`/new`）绕过防抖，保持独立。

### `commands`（聊天命令处理）

控制跨连接器的聊天命令启用方式。

```json5
{
  commands: {
    native: "auto", // 在支持的平台上注册原生命令（auto）
    text: true, // 解析聊天消息中的斜杠命令
    bash: false, // 允许 !（别名：/bash）（仅限主机；需要 tools.elevated 白名单）
    bashForegroundMs: 2000, // bash 前台窗口（0 立即后台运行）
    config: false, // 允许 /config（写入磁盘）
    debug: false, // 允许 /debug（仅运行时覆盖）
    restart: false, // 允许 /restart + gateway 重启工具
    useAccessGroups: true, // 对命令执行访问组白名单/策略
  },
}
```

说明：

- 文本命令必须作为**独立**消息发送，并使用前导 `/`（无纯文本别名）。
- `commands.text: false` 禁用解析聊天消息中的命令。
- `commands.native: "auto"`（默认）为 Discord/Telegram 启用原生命令，Slack 保持关闭；不支持的渠道保持纯文本。
- 设为 `commands.native: true|false` 强制全部开启或关闭，或按渠道覆盖 `channels.discord.commands.native`、`channels.telegram.commands.native`、`channels.slack.commands.native`（bool 或 `"auto"`）。`false` 在启动时清除 Discord/Telegram 上先前注册的命令；Slack 命令在 Slack 应用中管理。
- `channels.telegram.customCommands` 添加额外的 Telegram 机器人菜单项。名称会被规范化；与原生命令冲突的会被忽略。
- `commands.bash: true` 启用 `! <cmd>` 运行主机 shell 命令（`/bash <cmd>` 也可作为别名）。需要 `tools.elevated.enabled` 并在 `tools.elevated.allowFrom.<channel>` 中添加发送者白名单。
- `commands.bashForegroundMs` 控制 bash 在后台运行前等待的时间。当 bash 任务正在运行时，新的 `! <cmd>` 请求会被拒绝（一次一个）。
- `commands.config: true` 启用 `/config`（读写 `openclaw.json`）。
- `channels.<provider>.configWrites` 控制由该渠道发起的配置变更（默认：true）。适用于 `/config set|unset` 以及提供商特定的自动迁移（Telegram 超级群组 ID 变更、Slack 频道 ID 变更）。
- `commands.debug: true` 启用 `/debug`（仅运行时覆盖）。
- `commands.restart: true` 启用 `/restart` 和 gateway 工具重启动作。
- `commands.useAccessGroups: false` 允许命令绕过访问组白名单/策略。
- 斜杠命令和指令仅对**已授权发送者**有效。授权来自渠道白名单/配对以及 `commands.useAccessGroups`。

### `web`（WhatsApp Web 渠道运行时）

WhatsApp 通过 Gateway 网关的 Web 渠道（Baileys Web）运行。当存在已链接的会话时自动启动。
设置 `web.enabled: false` 使其默认关闭。

```json5
{
  web: {
    enabled: true,
    heartbeatSeconds: 60,
    reconnect: {
      initialMs: 2000,
      maxMs: 120000,
      factor: 1.4,
      jitter: 0.2,
      maxAttempts: 0,
    },
  },
}
```

### `channels.telegram`（机器人传输）

OpenClaw 仅在存在 `channels.telegram` 配置段时启动 Telegram。机器人 token 从 `channels.telegram.botToken`（或 `channels.telegram.tokenFile`）解析，`TELEGRAM_BOT_TOKEN` 作为默认账号的回退。
设置 `channels.telegram.enabled: false` 禁用自动启动。
多账号支持在 `channels.telegram.accounts` 下（参见上方多账号部分）。环境变量 token 仅适用于默认账号。
设置 `channels.telegram.configWrites: false` 阻止 Telegram 发起的配置写入（包括超级群组 ID 迁移和 `/config set|unset`）。

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "your-bot-token",
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["tg:123456789"], // 可选；"open" 需要 ["*"]
      groups: {
        "*": { requireMention: true },
        "-1001234567890": {
          allowFrom: ["@admin"],
          systemPrompt: "Keep answers brief.",
          topics: {
            "99": {
              requireMention: false,
              skills: ["search"],
              systemPrompt: "Stay on topic.",
            },
          },
        },
      },
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
      historyLimit: 50, // 包含最近 N 条群消息作为上下文（0 禁用）
      replyToMode: "first", // off | first | all
      linkPreview: true, // 切换出站链接预览
      streamMode: "partial", // off | partial | block（草稿流式传输；与分块流式传输分开）
      draftChunk: {
        // 可选；仅用于 streamMode=block
        minChars: 200,
        maxChars: 800,
        breakPreference: "paragraph", // paragraph | newline | sentence
      },
      actions: { reactions: true, sendMessage: true }, // 工具动作开关（false 禁用）
      reactionNotifications: "own", // off | own | all
      mediaMaxMb: 5,
      retry: {
        // 出站重试策略
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
      network: {
        // 传输覆盖
        autoSelectFamily: false,
      },
      proxy: "socks5://localhost:9050",
      webhookUrl: "https://example.com/telegram-webhook", // 需要 webhookSecret
      webhookSecret: "secret",
      webhookPath: "/telegram-webhook",
    },
  },
}
```

草稿流式传输说明：

- 使用 Telegram `sendMessageDraft`（草稿气泡，不是真正的消息）。
- 需要**私聊话题**（私信 中的 message_thread_id；机器人已启用话题）。
- `/reasoning stream` 将推理过程流式传输到草稿中，然后发送最终答案。
  重试策略默认值和行为记录在[重试策略](/concepts/retry)中。

### `channels.discord`（机器人传输）

通过设置机器人 token 和可选的门控配置 Discord 机器人：
多账号支持在 `channels.discord.accounts` 下（参见上方多账号部分）。环境变量 token 仅适用于默认账号。

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "your-bot-token",
      mediaMaxMb: 8, // 限制入站媒体大小
      allowBots: false, // 允许机器人发送的消息
      actions: {
        // 工具动作开关（false 禁用）
        reactions: true,
        stickers: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        voiceStatus: true,
        events: true,
        moderation: false,
      },
      replyToMode: "off", // off | first | all
      dm: {
        enabled: true, // 设为 false 时禁用所有私聊
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["1234567890", "steipete"], // 可选私聊白名单（"open" 需要 ["*"]）
        groupEnabled: false, // 启用群组私聊
        groupChannels: ["openclaw-dm"], // 可选群组私聊白名单
      },
      guilds: {
        "123456789012345678": {
          // 服务器 id（推荐）或 slug
          slug: "friends-of-openclaw",
          requireMention: false, // 每服务器默认值
          reactionNotifications: "own", // off | own | all | allowlist
          users: ["987654321098765432"], // 可选的每服务器用户白名单
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["docs"],
              systemPrompt: "Short answers only.",
            },
          },
        },
      },
      historyLimit: 20, // 包含最近 N 条服务器消息作为上下文
      textChunkLimit: 2000, // 可选出站文本分块大小（字符数）
      chunkMode: "length", // 可选分块模式（length | newline）
      maxLinesPerMessage: 17, // 每条消息的软最大行数（Discord UI 裁剪）
      retry: {
        // 出站重试策略
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

OpenClaw 仅在存在 `channels.discord` 配置段时启动 Discord。token 从 `channels.discord.token` 解析，`DISCORD_BOT_TOKEN` 作为默认账号的回退（除非 `channels.discord.enabled` 为 `false`）。在为 cron/CLI 命令指定投递目标时，使用 `user:<id>`（私聊）或 `channel:<id>`（服务器频道）；裸数字 ID 有歧义会被拒绝。
服务器 slug 为小写，空格替换为 `-`；频道键使用 slug 化的频道名称（无前导 `#`）。建议使用服务器 id 作为键以避免重命名歧义。
机器人发送的消息默认被忽略。通过 `channels.discord.allowBots` 启用（自身消息仍会被过滤以防止自回复循环）。
反应通知模式：

- `off`：无反应事件。
- `own`：机器人自身消息上的反应（默认）。
- `all`：所有消息上的所有反应。
- `allowlist`：`guilds.<id>.users` 中的用户在所有消息上的反应（空列表禁用）。
  出站文本按 `channels.discord.textChunkLimit`（默认 2000）分块。设置 `channels.discord.chunkMode="newline"` 在长度分块前按空行（段落边界）分割。Discord 客户端可能裁剪过高的消息，因此 `channels.discord.maxLinesPerMessage`（默认 17）即使在 2000 字符以内也会分割长多行回复。
  重试策略默认值和行为记录在[重试策略](/concepts/retry)中。

### `channels.googlechat`（Chat API webhook）

Google Chat 通过 HTTP webhook 运行，使用应用级认证（服务账号）。
多账号支持在 `channels.googlechat.accounts` 下（参见上方多账号部分）。环境变量仅适用于默认账号。

```json5
{
  channels: {
    googlechat: {
      enabled: true,
      serviceAccountFile: "/path/to/service-account.json",
      audienceType: "app-url", // app-url | project-number
      audience: "https://gateway.example.com/googlechat",
      webhookPath: "/googlechat",
      botUser: "users/1234567890", // 可选；改善提及检测
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["users/1234567890"], // 可选；"open" 需要 ["*"]
      },
      groupPolicy: "allowlist",
      groups: {
        "spaces/AAAA": { allow: true, requireMention: true },
      },
      actions: { reactions: true },
      typingIndicator: "message",
      mediaMaxMb: 20,
    },
  },
}
```

说明：

- 服务账号 JSON 可以内联（`serviceAccount`）或基于文件（`serviceAccountFile`）。
- 默认账号的环境变量回退：`GOOGLE_CHAT_SERVICE_ACCOUNT` 或 `GOOGLE_CHAT_SERVICE_ACCOUNT_FILE`。
- `audienceType` + `audience` 必须与 Chat 应用的 webhook 认证配置匹配。
- 设置投递目标时使用 `spaces/<spaceId>` 或 `users/<userId|email>`。

### `channels.slack`（socket 模式）

Slack 以 Socket Mode 运行，需要机器人 token 和应用 token：

```json5
{
  channels: {
    slack: {
      enabled: true,
      botToken: "xoxb-...",
      appToken: "xapp-...",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["U123", "U456", "*"], // 可选；"open" 需要 ["*"]
        groupEnabled: false,
        groupChannels: ["G123"],
      },
      channels: {
        C123: { allow: true, requireMention: true, allowBots: false },
        "#general": {
          allow: true,
          requireMention: true,
          allowBots: false,
          users: ["U123"],
          skills: ["docs"],
          systemPrompt: "Short answers only.",
        },
      },
      historyLimit: 50, // 包含最近 N 条频道/群组消息作为上下文（0 禁用）
      allowBots: false,
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["U123"],
      replyToMode: "off", // off | first | all
      thread: {
        historyScope: "thread", // thread | channel
        inheritParent: false,
      },
      actions: {
        reactions: true,
        messages: true,
        pins: true,
        memberInfo: true,
        emojiList: true,
      },
      slashCommand: {
        enabled: true,
        name: "openclaw",
        sessionPrefix: "slack:slash",
        ephemeral: true,
      },
      textChunkLimit: 4000,
      chunkMode: "length",
      mediaMaxMb: 20,
    },
  },
}
```

多账号支持在 `channels.slack.accounts` 下（参见上方多账号部分）。环境变量 token 仅适用于默认账号。

OpenClaw 在提供商启用且两个 token 都已设置时启动 Slack（通过配置或 `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`）。在为 cron/CLI 命令指定投递目标时使用 `user:<id>`（私聊）或 `channel:<id>`。
设置 `channels.slack.configWrites: false` 阻止 Slack 发起的配置写入（包括频道 ID 迁移和 `/config set|unset`）。

机器人发送的消息默认被忽略。通过 `channels.slack.allowBots` 或 `channels.slack.channels.<id>.allowBots` 启用。

反应通知模式：

- `off`：无反应事件。
- `own`：机器人自身消息上的反应（默认）。
- `all`：所有消息上的所有反应。
- `allowlist`：`channels.slack.reactionAllowlist` 中的用户在所有消息上的反应（空列表禁用）。

线程会话隔离：

- `channels.slack.thread.historyScope` 控制线程历史是按线程（`thread`，默认）还是跨频道共享（`channel`）。
- `channels.slack.thread.inheritParent` 控制新线程会话是否继承父频道的记录（默认：false）。

Slack 动作组（控制 `slack` 工具动作）：
| 动作组 | 默认 | 说明 |
| --- | --- | --- |
| reactions | 已启用 | 反应 + 列出反应 |
| messages | 已启用 | 读取/发送/编辑/删除 |
| pins | 已启用 | 固定/取消固定/列出 |
| memberInfo | 已启用 | 成员信息 |
| emojiList | 已启用 | 自定义表情列表 |

### `channels.mattermost`（机器人 token）

Mattermost 作为插件提供，不包含在核心安装中。
请先安装：`openclaw plugins install @openclaw/mattermost`（或从 git checkout 使用 `./extensions/mattermost`）。

Mattermost 需要机器人 token 加上服务器的基础 URL：

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
      chatmode: "oncall", // oncall | onmessage | onchar
      oncharPrefixes: [">", "!"],
      textChunkLimit: 4000,
      chunkMode: "length",
    },
  },
}
```

OpenClaw 在账号已配置（机器人 token + 基础 URL）且已启用时启动 Mattermost。token + 基础 URL 从 `channels.mattermost.botToken` + `channels.mattermost.baseUrl` 或默认账号的 `MATTERMOST_BOT_TOKEN` + `MATTERMOST_URL` 解析（除非 `channels.mattermost.enabled` 为 `false`）。

聊天模式：

- `oncall`（默认）：仅在被 @提及时响应频道消息。
- `onmessage`：响应每条频道消息。
- `onchar`：当消息以触发前缀开头时响应（`channels.mattermost.oncharPrefixes`，默认 `[">", "!"]`）。

访问控制：

- 默认私聊：`channels.mattermost.dmPolicy="pairing"`（未知发送者收到配对码）。
- 公开私聊：`channels.mattermost.dmPolicy="open"` 加上 `channels.mattermost.allowFrom=["*"]`。
- 群组：`channels.mattermost.groupPolicy="allowlist"` 为默认值（提及门控）。使用 `channels.mattermost.groupAllowFrom` 限制发送者。

多账号支持在 `channels.mattermost.accounts` 下（参见上方多账号部分）。环境变量仅适用于默认账号。
指定投递目标时使用 `channel:<id>` 或 `user:<id>`（或 `@username`）；裸 id 被视为频道 id。

### `channels.signal`（signal-cli）

Signal 反应可以发出系统事件（共享反应工具）：

```json5
{
  channels: {
    signal: {
      reactionNotifications: "own", // off | own | all | allowlist
      reactionAllowlist: ["+15551234567", "uuid:123e4567-e89b-12d3-a456-426614174000"],
      historyLimit: 50, // 包含最近 N 条群消息作为上下文（0 禁用）
    },
  },
}
```

反应通知模式：

- `off`：无反应事件。
- `own`：机器人自身消息上的反应（默认）。
- `all`：所有消息上的所有反应。
- `allowlist`：`channels.signal.reactionAllowlist` 中的用户在所有消息上的反应（空列表禁用）。

### `channels.imessage`（imsg CLI）

OpenClaw 会生成 `imsg rpc`（通过 stdio 的 JSON-RPC）。无需守护进程或端口。

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "imsg",
      dbPath: "~/Library/Messages/chat.db",
      remoteHost: "user@gateway-host", // 使用 SSH 包装器时通过 SCP 获取远程附件
      dmPolicy: "pairing", // pairing | allowlist | open | disabled
      allowFrom: ["+15555550123", "user@example.com", "chat_id:123"],
      historyLimit: 50, // 包含最近 N 条群消息作为上下文（0 禁用）
      includeAttachments: false,
      mediaMaxMb: 16,
      service: "auto",
      region: "US",
    },
  },
}
```

多账号支持在 `channels.imessage.accounts` 下（参见上方多账号部分）。

说明：

- 需要对消息数据库的完全磁盘访问权限。
- 首次发送时会提示请求消息自动化权限。
- 建议使用 `chat_id:<id>` 目标。使用 `imsg chats --limit 20` 列出聊天。
- `channels.imessage.cliPath` 可以指向包装脚本（例如 `ssh` 到另一台运行 `imsg rpc` 的 Mac）；使用 SSH 密钥避免密码提示。
- 对于远程 SSH 包装器，设置 `channels.imessage.remoteHost` 以便在启用 `includeAttachments` 时通过 SCP 获取附件。

示例包装器：

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

### `agents.defaults.workspace`

设置智能体用于文件操作的**单一全局工作区目录**。

默认：`~/.openclaw/workspace`。

```json5
{
  agents: { defaults: { workspace: "~/.openclaw/workspace" } },
}
```

如果启用了 `agents.defaults.sandbox`，非主会话可以在 `agents.defaults.sandbox.workspaceRoot` 下使用各自的每范围工作区来覆盖此设置。

### `agents.defaults.repoRoot`

在系统提示的 Runtime 行中显示的可选仓库根目录。如果未设置，OpenClaw 会从工作区（和当前工作目录）向上查找 `.git` 目录进行检测。路径必须存在才能使用。

```json5
{
  agents: { defaults: { repoRoot: "~/Projects/openclaw" } },
}
```

### `agents.defaults.skipBootstrap`

禁用自动创建工作区引导文件（`AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md` 和 `BOOTSTRAP.md`）。

适用于工作区文件来自仓库的预置部署。

```json5
{
  agents: { defaults: { skipBootstrap: true } },
}
```

### `agents.defaults.bootstrapMaxChars`

注入系统提示前每个工作区引导文件截断前的最大字符数。默认：`20000`。

当文件超过此限制时，OpenClaw 会记录警告并注入带标记的头尾截断内容。

```json5
{
  agents: { defaults: { bootstrapMaxChars: 20000 } },
}
```

### `agents.defaults.userTimezone`

设置用户时区用于**系统提示上下文**（不用于消息信封中的时间戳）。如果未设置，OpenClaw 在运行时使用主机时区。

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

### `agents.defaults.timeFormat`

控制系统提示中"当前日期和时间"部分显示的**时间格式**。
默认：`auto`（操作系统偏好）。

```json5
{
  agents: { defaults: { timeFormat: "auto" } }, // auto | 12 | 24
}
```

### `messages`

控制入站/出站前缀和可选的确认反应。
参见[消息](/concepts/messages)了解排队、会话和流式上下文。

```json5
{
  messages: {
    responsePrefix: "🦞", // 或 "auto"
    ackReaction: "👀",
    ackReactionScope: "group-mentions",
    removeAckAfterReply: false,
  },
}
```

`responsePrefix` 应用于跨渠道的**所有出站回复**（工具摘要、分块流式传输、最终回复），除非已存在。

如果未设置 `messages.responsePrefix`，默认不应用前缀。WhatsApp 自聊天回复是例外：它们在设置时默认为 `[{identity.name}]`，否则为 `[openclaw]`，以保持同一手机上的对话可读性。
设为 `"auto"` 可为路由的智能体推导 `[{identity.name}]`（当设置时）。

#### 模板变量

`responsePrefix` 字符串可以包含动态解析的模板变量：

| 变量              | 描述           | 示例                        |
| ----------------- | -------------- | --------------------------- |
| `{model}`         | 短模型名称     | `claude-opus-4-5`、`gpt-4o` |
| `{modelFull}`     | 完整模型标识符 | `anthropic/claude-opus-4-5` |
| `{provider}`      | 提供商名称     | `anthropic`、`openai`       |
| `{thinkingLevel}` | 当前思考级别   | `high`、`low`、`off`        |
| `{identity.name}` | 智能体身份名称 | （与 `"auto"` 模式相同）    |

变量不区分大小写（`{MODEL}` = `{model}`）。`{think}` 是 `{thinkingLevel}` 的别名。
未解析的变量保持为字面文本。

```json5
{
  messages: {
    responsePrefix: "[{model} | think:{thinkingLevel}]",
  },
}
```

输出示例：`[claude-opus-4-5 | think:high] Here's my response...`

WhatsApp 入站前缀通过 `channels.whatsapp.messagePrefix` 配置（已弃用：`messages.messagePrefix`）。默认保持**不变**：当 `channels.whatsapp.allowFrom` 为空时为 `"[openclaw]"`，否则为 `""`（无前缀）。使用 `"[openclaw]"` 时，如果路由的智能体设置了 `identity.name`，OpenClaw 会改用 `[{identity.name}]`。

`ackReaction` 在支持反应的渠道（Slack/Discord/Telegram/Google Chat）上发送尽力而为的表情反应来确认入站消息。设置时默认为活跃智能体的 `identity.emoji`，否则为 `"👀"`。设为 `""` 禁用。

`ackReactionScope` 控制反应触发时机：

- `group-mentions`（默认）：仅在群组/房间要求提及**且**机器人被提及时
- `group-all`：所有群组/房间消息
- `direct`：仅私聊消息
- `all`：所有消息

`removeAckAfterReply` 在发送回复后移除机器人的确认反应（仅 Slack/Discord/Telegram/Google Chat）。默认：`false`。

#### `messages.tts`

为出站回复启用文字转语音。开启后，OpenClaw 使用 ElevenLabs 或 OpenAI 生成音频并附加到回复中。Telegram 使用 Opus 语音消息；其他渠道发送 MP3 音频。

```json5
{
  messages: {
    tts: {
      auto: "always", // off | always | inbound | tagged
      mode: "final", // final | all（包含工具/块回复）
      provider: "elevenlabs",
      summaryModel: "openai/gpt-4.1-mini",
      modelOverrides: {
        enabled: true,
      },
      maxTextLength: 4000,
      timeoutMs: 30000,
      prefsPath: "~/.openclaw/settings/tts.json",
      elevenlabs: {
        apiKey: "elevenlabs_api_key",
        baseUrl: "https://api.elevenlabs.io",
        voiceId: "voice_id",
        modelId: "eleven_multilingual_v2",
        seed: 42,
        applyTextNormalization: "auto",
        languageCode: "en",
        voiceSettings: {
          stability: 0.5,
          similarityBoost: 0.75,
          style: 0.0,
          useSpeakerBoost: true,
          speed: 1.0,
        },
      },
      openai: {
        apiKey: "openai_api_key",
        model: "gpt-4o-mini-tts",
        voice: "alloy",
      },
    },
  },
}
```

说明：

- `messages.tts.auto` 控制自动 TTS（`off`、`always`、`inbound`、`tagged`）。
- `/tts off|always|inbound|tagged` 设置每会话的自动模式（覆盖配置）。
- `messages.tts.enabled` 为旧版；doctor 会将其迁移为 `messages.tts.auto`。
- `prefsPath` 存储本地覆盖（提供商/限制/摘要）。
- `maxTextLength` 是 TTS 输入的硬上限；摘要会被截断以适应。
- `summaryModel` 覆盖自动摘要的 `agents.defaults.model.primary`。
  - 接受 `provider/model` 或来自 `agents.defaults.models` 的别名。
- `modelOverrides` 启用模型驱动的覆盖如 `[[tts:...]]` 标签（默认开启）。
- `/tts limit` 和 `/tts summary` 控制每用户的摘要设置。
- `apiKey` 值回退到 `ELEVENLABS_API_KEY`/`XI_API_KEY` 和 `OPENAI_API_KEY`。
- `elevenlabs.baseUrl` 覆盖 ElevenLabs API 基础 URL。
- `elevenlabs.voiceSettings` 支持 `stability`/`similarityBoost`/`style`（0..1）、
  `useSpeakerBoost` 和 `speed`（0.5..2.0）。

### `talk`

Talk 模式（macOS/iOS/Android）的默认值。语音 ID 在未设置时回退到 `ELEVENLABS_VOICE_ID` 或 `SAG_VOICE_ID`。
`apiKey` 在未设置时回退到 `ELEVENLABS_API_KEY`（或 Gateway 网关的 shell 配置文件）。
`voiceAliases` 允许 Talk 指令使用友好名称（例如 `"voice":"Clawd"`）。

```json5
{
  talk: {
    voiceId: "elevenlabs_voice_id",
    voiceAliases: {
      Clawd: "EXAVITQu4vr4xnSDxMaL",
      Roger: "CwhRBWXzGAHq8TQ4Fs17",
    },
    modelId: "eleven_v3",
    outputFormat: "mp3_44100_128",
    apiKey: "elevenlabs_api_key",
    interruptOnSpeech: true,
  },
}
```

### `agents.defaults`

控制内置智能体运行时（模型/思考/详细/超时）。
`agents.defaults.models` 定义已配置的模型目录（也充当 `/model` 的白名单）。
`agents.defaults.model.primary` 设置默认模型；`agents.defaults.model.fallbacks` 是全局故障转移。
`agents.defaults.imageModel` 是可选的，**仅在主模型缺少图像输入时使用**。
每个 `agents.defaults.models` 条目可以包含：

- `alias`（可选的模型快捷方式，例如 `/opus`）。
- `params`（可选的提供商特定 API 参数，传递给模型请求）。

`params` 也应用于流式运行（内置智能体 + 压缩）。目前支持的键：`temperature`、`maxTokens`。这些与调用时选项合并；调用方提供的值优先。`temperature` 是高级旋钮——除非你了解模型的默认值且需要更改，否则不要设置。

示例：

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-sonnet-4-5-20250929": {
          params: { temperature: 0.6 },
        },
        "openai/gpt-5.2": {
          params: { maxTokens: 8192 },
        },
      },
    },
  },
}
```

Z.AI GLM-4.x 模型会自动启用思考模式，除非你：

- 设置 `--thinking off`，或
- 自行定义 `agents.defaults.models["zai/<model>"].params.thinking`。

OpenClaw 还内置了一些别名快捷方式。默认值仅在模型已存在于 `agents.defaults.models` 中时才应用：

- `opus` -> `anthropic/claude-opus-4-5`
- `sonnet` -> `anthropic/claude-sonnet-4-5`
- `gpt` -> `openai/gpt-5.2`
- `gpt-mini` -> `openai/gpt-5-mini`
- `gemini` -> `google/gemini-3-pro-preview`
- `gemini-flash` -> `google/gemini-3-flash-preview`

如果你配置了相同的别名（不区分大小写），你的值优先（默认值不会覆盖）。

示例：Opus 4.5 主模型，MiniMax M2.1 回退（托管 MiniMax）：

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-5": { alias: "opus" },
        "minimax/MiniMax-M2.1": { alias: "minimax" },
      },
      model: {
        primary: "anthropic/claude-opus-4-5",
        fallbacks: ["minimax/MiniMax-M2.1"],
      },
    },
  },
}
```

MiniMax 认证：设置 `MINIMAX_API_KEY`（环境变量）或配置 `models.providers.minimax`。

#### `agents.defaults.cliBackends`（CLI 回退）

可选的 CLI 后端用于纯文本回退运行（无工具调用）。当 API 提供商失败时可作为备用路径。当你配置了接受文件路径的 `imageArg` 时支持图像透传。

说明：

- CLI 后端**以文本为主**；工具始终禁用。
- 设置 `sessionArg` 时支持会话；会话 id 按后端持久化。
- 对于 `claude-cli`，默认值已内置。如果 PATH 不完整（launchd/systemd），请覆盖命令路径。

示例：

```json5
{
  agents: {
    defaults: {
      cliBackends: {
        "claude-cli": {
          command: "/opt/homebrew/bin/claude",
        },
        "my-cli": {
          command: "my-cli",
          args: ["--json"],
          output: "json",
          modelArg: "--model",
          sessionArg: "--session",
          sessionMode: "existing",
          systemPromptArg: "--system",
          systemPromptWhen: "first",
          imageArg: "--image",
          imageMode: "repeat",
        },
      },
    },
  },
}
```

```json5
{
  agents: {
    defaults: {
      models: {
        "anthropic/claude-opus-4-5": { alias: "Opus" },
        "anthropic/claude-sonnet-4-1": { alias: "Sonnet" },
        "openrouter/deepseek/deepseek-r1:free": {},
        "zai/glm-4.7": {
          alias: "GLM",
          params: {
            thinking: {
              type: "enabled",
              clear_thinking: false,
            },
          },
        },
      },
      model: {
        primary: "anthropic/claude-opus-4-5",
        fallbacks: [
          "openrouter/deepseek/deepseek-r1:free",
          "openrouter/meta-llama/llama-3.3-70b-instruct:free",
        ],
      },
      imageModel: {
        primary: "openrouter/qwen/qwen-2.5-vl-72b-instruct:free",
        fallbacks: ["openrouter/google/gemini-2.0-flash-vision:free"],
      },
      thinkingDefault: "low",
      verboseDefault: "off",
      elevatedDefault: "on",
      timeoutSeconds: 600,
      mediaMaxMb: 5,
      heartbeat: {
        every: "30m",
        target: "last",
      },
      maxConcurrent: 3,
      subagents: {
        model: "minimax/MiniMax-M2.1",
        maxConcurrent: 1,
        archiveAfterMinutes: 60,
      },
      exec: {
        backgroundMs: 10000,
        timeoutSec: 1800,
        cleanupMs: 1800000,
      },
      contextTokens: 200000,
    },
  },
}
```

#### `agents.defaults.contextPruning`（工具结果裁剪）

`agents.defaults.contextPruning` 在请求发送到 LLM 之前裁剪内存上下文中的**旧工具结果**。
它**不会**修改磁盘上的会话历史（`*.jsonl` 保持完整）。

这旨在减少随时间积累大量工具输出的智能体的 token 消耗。

概述：

- 不触及用户/助手消息。
- 保护最后 `keepLastAssistants` 条助手消息（该点之后的工具结果不会被裁剪）。
- 保护引导前缀（第一条用户消息之前的内容不会被裁剪）。
- 模式：
  - `adaptive`：当估计的上下文比率超过 `softTrimRatio` 时，软裁剪过大的工具结果（保留头尾）。
    然后当估计的上下文比率超过 `hardClearRatio` **且**有足够的可裁剪工具结果量（`minPrunableToolChars`）时，硬清除最旧的符合条件的工具结果。
  - `aggressive`：始终用 `hardClear.placeholder` 替换截止点之前符合条件的工具结果（不做比率检查）。

软裁剪 vs 硬裁剪（发送给 LLM 的上下文中的变化）：

- **软裁剪**：仅针对*过大*的工具结果。保留开头 + 结尾，在中间插入 `...`。
  - 之前：`toolResult("…很长的输出…")`
  - 之后：`toolResult("HEAD…\n...\n…TAIL\n\n[Tool result trimmed: …]")`
- **硬清除**：用占位符替换整个工具结果。
  - 之前：`toolResult("…很长的输出…")`
  - 之后：`toolResult("[Old tool result content cleared]")`

说明 / 当前限制：

- 目前包含**图像块的工具结果会被跳过**（不会被裁剪/清除）。
- 估计的"上下文比率"基于**字符**（近似值），不是精确的 token 数。
- 如果会话尚未包含至少 `keepLastAssistants` 条助手消息，则跳过裁剪。
- 在 `aggressive` 模式下，`hardClear.enabled` 被忽略（符合条件的工具结果始终被替换为 `hardClear.placeholder`）。

默认值（adaptive）：

```json5
{
  agents: { defaults: { contextPruning: { mode: "adaptive" } } },
}
```

禁用：

```json5
{
  agents: { defaults: { contextPruning: { mode: "off" } } },
}
```

默认值（当 `mode` 为 `"adaptive"` 或 `"aggressive"` 时）：

- `keepLastAssistants`：`3`
- `softTrimRatio`：`0.3`（仅 adaptive）
- `hardClearRatio`：`0.5`（仅 adaptive）
- `minPrunableToolChars`：`50000`（仅 adaptive）
- `softTrim`：`{ maxChars: 4000, headChars: 1500, tailChars: 1500 }`（仅 adaptive）
- `hardClear`：`{ enabled: true, placeholder: "[Old tool result content cleared]" }`

示例（aggressive，最小化）：

```json5
{
  agents: { defaults: { contextPruning: { mode: "aggressive" } } },
}
```

示例（调优的 adaptive）：

```json5
{
  agents: {
    defaults: {
      contextPruning: {
        mode: "adaptive",
        keepLastAssistants: 3,
        softTrimRatio: 0.3,
        hardClearRatio: 0.5,
        minPrunableToolChars: 50000,
        softTrim: { maxChars: 4000, headChars: 1500, tailChars: 1500 },
        hardClear: { enabled: true, placeholder: "[Old tool result content cleared]" },
        // 可选：限制裁剪仅针对特定工具（deny 优先；支持 "*" 通配符）
        tools: { deny: ["browser", "canvas"] },
      },
    },
  },
}
```

参见 [/concepts/session-pruning](/concepts/session-pruning) 了解行为细节。

#### `agents.defaults.compaction`（预留空间 + 记忆刷新）

`agents.defaults.compaction.mode` 选择压缩摘要策略。默认为 `default`；设为 `safeguard` 可为超长历史启用分块摘要。参见 [/concepts/compaction](/concepts/compaction)。

`agents.defaults.compaction.reserveTokensFloor` 为 Pi 压缩强制一个最小 `reserveTokens` 值（默认：`20000`）。设为 `0` 禁用此底线。

`agents.defaults.compaction.memoryFlush` 在自动压缩前运行一个**静默**智能体轮次，指示模型将持久记忆存储到磁盘（例如 `memory/YYYY-MM-DD.md`）。当会话 token 估计值超过压缩限制以下的软阈值时触发。

旧版默认值：

- `memoryFlush.enabled`：`true`
- `memoryFlush.softThresholdTokens`：`4000`
- `memoryFlush.prompt` / `memoryFlush.systemPrompt`：带 `NO_REPLY` 的内置默认值
- 注意：当会话工作区为只读时跳过记忆刷新（`agents.defaults.sandbox.workspaceAccess: "ro"` 或 `"none"`）。

示例（调优）：

```json5
{
  agents: {
    defaults: {
      compaction: {
        mode: "safeguard",
        reserveTokensFloor: 24000,
        memoryFlush: {
          enabled: true,
          softThresholdTokens: 6000,
          systemPrompt: "Session nearing compaction. Store durable memories now.",
          prompt: "Write any lasting notes to memory/YYYY-MM-DD.md; reply with NO_REPLY if nothing to store.",
        },
      },
    },
  },
}
```

分块流式传输：

- `agents.defaults.blockStreamingDefault`：`"on"`/`"off"`（默认 off）。
- 渠道覆盖：`*.blockStreaming`（及每账号变体）强制分块流式传输开/关。
  非 Telegram 渠道需要显式设置 `*.blockStreaming: true` 来启用块回复。
- `agents.defaults.blockStreamingBreak`：`"text_end"` 或 `"message_end"`（默认：text_end）。
- `agents.defaults.blockStreamingChunk`：流式块的软分块。默认 800–1200 字符，优先段落分隔（`\n\n`），然后换行，然后句子。
  示例：
  ```json5
  {
    agents: { defaults: { blockStreamingChunk: { minChars: 800, maxChars: 1200 } } },
  }
  ```
- `agents.defaults.blockStreamingCoalesce`：发送前合并流式块。
  默认为 `{ idleMs: 1000 }`，从 `blockStreamingChunk` 继承 `minChars`，
  `maxChars` 上限为渠道文本限制。Signal/Slack/Discord/Google Chat 默认
  `minChars: 1500`，除非被覆盖。
  渠道覆盖：`channels.whatsapp.blockStreamingCoalesce`、`channels.telegram.blockStreamingCoalesce`、
  `channels.discord.blockStreamingCoalesce`、`channels.slack.blockStreamingCoalesce`、`channels.mattermost.blockStreamingCoalesce`、
  `channels.signal.blockStreamingCoalesce`、`channels.imessage.blockStreamingCoalesce`、`channels.msteams.blockStreamingCoalesce`、
  `channels.googlechat.blockStreamingCoalesce`
  （及每账号变体）。
- `agents.defaults.humanDelay`：第一条之后**块回复**之间的随机延迟。
  模式：`off`（默认）、`natural`（800–2500ms）、`custom`（使用 `minMs`/`maxMs`）。
  每智能体覆盖：`agents.list[].humanDelay`。
  示例：
  ```json5
  {
    agents: { defaults: { humanDelay: { mode: "natural" } } },
  }
  ```
  参见 [/concepts/streaming](/concepts/streaming) 了解行为 + 分块细节。

输入指示器：

- `agents.defaults.typingMode`：`"never" | "instant" | "thinking" | "message"`。私聊/提及默认为
  `instant`，未被提及的群聊默认为 `message`。
- `session.typingMode`：每会话的模式覆盖。
- `agents.defaults.typingIntervalSeconds`：输入信号刷新频率（默认：6s）。
- `session.typingIntervalSeconds`：每会话的刷新间隔覆盖。
  参见 [/concepts/typing-indicators](/concepts/typing-indicators) 了解行为细节。

`agents.defaults.model.primary` 应设为 `provider/model`（例如 `anthropic/claude-opus-4-5`）。
别名来自 `agents.defaults.models.*.alias`（例如 `Opus`）。
如果省略提供商，OpenClaw 目前假定 `anthropic` 作为临时弃用回退。
Z.AI 模型可通过 `zai/<model>` 使用（例如 `zai/glm-4.7`），需要环境中设置
`ZAI_API_KEY`（或旧版 `Z_AI_API_KEY`）。

`agents.defaults.heartbeat` 配置定期心跳运行：

- `every`：持续时间字符串（`ms`、`s`、`m`、`h`）；默认单位分钟。默认：
  `30m`。设为 `0m` 禁用。
- `model`：可选的心跳运行覆盖模型（`provider/model`）。
- `includeReasoning`：为 `true` 时，心跳也会传递单独的 `Reasoning:` 消息（与 `/reasoning on` 相同形式）。默认：`false`。
- `session`：可选的会话键，控制心跳在哪个会话中运行。默认：`main`。
- `to`：可选的收件人覆盖（渠道特定 id，例如 WhatsApp 的 E.164，Telegram 的聊天 id）。
- `target`：可选的投递渠道（`last`、`whatsapp`、`telegram`、`discord`、`slack`、`msteams`、`signal`、`imessage`、`none`）。默认：`last`。
- `prompt`：可选的心跳内容覆盖（默认：`Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`）。覆盖值按原样发送；如果仍需读取文件，请包含 `Read HEARTBEAT.md` 行。
- `ackMaxChars`：`HEARTBEAT_OK` 之后投递前允许的最大字符数（默认：300）。

每智能体心跳：

- 设置 `agents.list[].heartbeat` 为特定智能体启用或覆盖心跳设置。
- 如果任何智能体条目定义了 `heartbeat`，**仅那些智能体**运行心跳；默认值
  成为那些智能体的共享基线。

心跳运行完整的智能体轮次。较短的间隔消耗更多 token；请注意
`every`，保持 `HEARTBEAT.md` 精简，和/或选择更便宜的 `model`。

`tools.exec` 配置后台执行默认值：

- `backgroundMs`：自动后台化前的时间（ms，默认 10000）
- `timeoutSec`：超过此运行时间后自动终止（秒，默认 1800）
- `cleanupMs`：完成的会话在内存中保留多久（ms，默认 1800000）
- `notifyOnExit`：后台执行退出时加入系统事件 + 请求心跳（默认 true）
- `applyPatch.enabled`：启用实验性 `apply_patch`（仅 OpenAI/OpenAI Codex；默认 false）
- `applyPatch.allowModels`：可选的模型 id 白名单（例如 `gpt-5.2` 或 `openai/gpt-5.2`）
  注意：`applyPatch` 仅在 `tools.exec` 下。

`tools.web` 配置 Web 搜索 + 获取工具：

- `tools.web.search.enabled`（默认：有密钥时为 true）
- `tools.web.search.apiKey`（推荐：通过 `openclaw configure --section web` 设置，或使用 `BRAVE_API_KEY` 环境变量）
- `tools.web.search.maxResults`（1–10，默认 5）
- `tools.web.search.timeoutSeconds`（默认 30）
- `tools.web.search.cacheTtlMinutes`（默认 15）
- `tools.web.fetch.enabled`（默认 true）
- `tools.web.fetch.maxChars`（默认 50000）
- `tools.web.fetch.timeoutSeconds`（默认 30）
- `tools.web.fetch.cacheTtlMinutes`（默认 15）
- `tools.web.fetch.userAgent`（可选覆盖）
- `tools.web.fetch.readability`（默认 true；禁用后仅使用基本 HTML 清理）
- `tools.web.fetch.firecrawl.enabled`（默认：设置了 API 密钥时为 true）
- `tools.web.fetch.firecrawl.apiKey`（可选；默认为 `FIRECRAWL_API_KEY`）
- `tools.web.fetch.firecrawl.baseUrl`（默认 https://api.firecrawl.dev）
- `tools.web.fetch.firecrawl.onlyMainContent`（默认 true）
- `tools.web.fetch.firecrawl.maxAgeMs`（可选）
- `tools.web.fetch.firecrawl.timeoutSeconds`（可选）

`tools.media` 配置入站媒体理解（图片/音频/视频）：

- `tools.media.models`：共享模型列表（按能力标记；在每能力列表之后使用）。
- `tools.media.concurrency`：最大并发能力运行数（默认 2）。
- `tools.media.image` / `tools.media.audio` / `tools.media.video`：
  - `enabled`：选择退出开关（配置了模型时默认为 true）。
  - `prompt`：可选的提示覆盖（图片/视频自动附加 `maxChars` 提示）。
  - `maxChars`：最大输出字符数（图片/视频默认 500；音频未设置）。
  - `maxBytes`：发送的最大媒体大小（默认：图片 10MB，音频 20MB，视频 50MB）。
  - `timeoutSeconds`：请求超时（默认：图片 60s，音频 60s，视频 120s）。
  - `language`：可选的音频提示。
  - `attachments`：附件策略（`mode`、`maxAttachments`、`prefer`）。
  - `scope`：可选的门控（第一个匹配获胜），带 `match.channel`、`match.chatType` 或 `match.keyPrefix`。
  - `models`：有序的模型条目列表；失败或超大媒体回退到下一个条目。
- 每个 `models[]` 条目：
  - 提供商条目（`type: "provider"` 或省略）：
    - `provider`：API 提供商 id（`openai`、`anthropic`、`google`/`gemini`、`groq` 等）。
    - `model`：模型 id 覆盖（图片必需；音频提供商默认为 `gpt-4o-mini-transcribe`/`whisper-large-v3-turbo`，视频默认为 `gemini-3-flash-preview`）。
    - `profile` / `preferredProfile`：认证配置文件选择。
  - CLI 条目（`type: "cli"`）：
    - `command`：要运行的可执行文件。
    - `args`：模板化参数（支持 `{{MediaPath}}`、`{{Prompt}}`、`{{MaxChars}}` 等）。
  - `capabilities`：可选的能力列表（`image`、`audio`、`video`）用于门控共享条目。省略时的默认值：`openai`/`anthropic`/`minimax` → image，`google` → image+audio+video，`groq` → audio。
  - `prompt`、`maxChars`、`maxBytes`、`timeoutSeconds`、`language` 可在每个条目中覆盖。

如果未配置模型（或 `enabled: false`），理解将被跳过；模型仍会接收原始附件。

提供商认证遵循标准模型认证顺序（认证配置文件、环境变量如 `OPENAI_API_KEY`/`GROQ_API_KEY`/`GEMINI_API_KEY`，或 `models.providers.*.apiKey`）。

示例：

```json5
{
  tools: {
    media: {
      audio: {
        enabled: true,
        maxBytes: 20971520,
        scope: {
          default: "deny",
          rules: [{ action: "allow", match: { chatType: "direct" } }],
        },
        models: [
          { provider: "openai", model: "gpt-4o-mini-transcribe" },
          { type: "cli", command: "whisper", args: ["--model", "base", "{{MediaPath}}"] },
        ],
      },
      video: {
        enabled: true,
        maxBytes: 52428800,
        models: [{ provider: "google", model: "gemini-3-flash-preview" }],
      },
    },
  },
}
```

`agents.defaults.subagents` 配置子智能体默认值：

- `model`：生成的子智能体的默认模型（字符串或 `{ primary, fallbacks }`）。如果省略，子智能体继承调用者的模型，除非按智能体或按调用覆盖。
- `maxConcurrent`：最大并发子智能体运行数（默认 1）
- `archiveAfterMinutes`：N 分钟后自动归档子智能体会话（默认 60；设为 `0` 禁用）
- 每子智能体工具策略：`tools.subagents.tools.allow` / `tools.subagents.tools.deny`（deny 优先）

`tools.profile` 设置 `tools.allow`/`tools.deny` 之前的**基础工具白名单**：

- `minimal`：仅 `session_status`
- `coding`：`group:fs`、`group:runtime`、`group:sessions`、`group:memory`、`image`
- `messaging`：`group:messaging`、`sessions_list`、`sessions_history`、`sessions_send`、`session_status`
- `full`：无限制（与未设置相同）

每智能体覆盖：`agents.list[].tools.profile`。

示例（默认仅消息传递，另外允许 Slack + Discord 工具）：

```json5
{
  tools: {
    profile: "messaging",
    allow: ["slack", "discord"],
  },
}
```

示例（编码配置文件，但全局拒绝 exec/process）：

```json5
{
  tools: {
    profile: "coding",
    deny: ["group:runtime"],
  },
}
```

`tools.byProvider` 允许你为特定提供商（或单个 `provider/model`）**进一步限制**工具。
每智能体覆盖：`agents.list[].tools.byProvider`。

顺序：基础配置文件 → 提供商配置文件 → allow/deny 策略。
提供商键接受 `provider`（例如 `google-antigravity`）或 `provider/model`
（例如 `openai/gpt-5.2`）。

示例（保持全局编码配置文件，但为 Google Antigravity 使用最小工具）：

```json5
{
  tools: {
    profile: "coding",
    byProvider: {
      "google-antigravity": { profile: "minimal" },
    },
  },
}
```

示例（提供商/模型特定白名单）：

```json5
{
  tools: {
    allow: ["group:fs", "group:runtime", "sessions_list"],
    byProvider: {
      "openai/gpt-5.2": { allow: ["group:fs", "sessions_list"] },
    },
  },
}
```

`tools.allow` / `tools.deny` 配置全局工具允许/拒绝策略（deny 优先）。
匹配不区分大小写并支持 `*` 通配符（`"*"` 表示所有工具）。
即使 Docker 沙箱**关闭**，此策略也会应用。

示例（全局禁用 browser/canvas）：

```json5
{
  tools: { deny: ["browser", "canvas"] },
}
```

工具组（简写）在**全局**和**每智能体**工具策略中可用：

- `group:runtime`：`exec`、`bash`、`process`
- `group:fs`：`read`、`write`、`edit`、`apply_patch`
- `group:sessions`：`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- `group:memory`：`memory_search`、`memory_get`
- `group:web`：`web_search`、`web_fetch`
- `group:ui`：`browser`、`canvas`
- `group:automation`：`cron`、`gateway`
- `group:messaging`：`message`
- `group:nodes`：`nodes`
- `group:openclaw`：所有内置 OpenClaw 工具（不包含提供商插件）

`tools.elevated` 控制提升（主机）执行访问：

- `enabled`：允许提升模式（默认 true）
- `allowFrom`：每渠道白名单（空 = 禁用）
  - `whatsapp`：E.164 号码
  - `telegram`：聊天 id 或用户名
  - `discord`：用户 id 或用户名（省略时回退到 `channels.discord.dm.allowFrom`）
  - `signal`：E.164 号码
  - `imessage`：句柄/聊天 id
  - `webchat`：会话 id 或用户名

示例：

```json5
{
  tools: {
    elevated: {
      enabled: true,
      allowFrom: {
        whatsapp: ["+15555550123"],
        discord: ["steipete", "1234567890123"],
      },
    },
  },
}
```

每智能体覆盖（进一步限制）：

```json5
{
  agents: {
    list: [
      {
        id: "family",
        tools: {
          elevated: { enabled: false },
        },
      },
    ],
  },
}
```

说明：

- `tools.elevated` 是全局基线。`agents.list[].tools.elevated` 只能进一步限制（两者都必须允许）。
- `/elevated on|off|ask|full` 按会话键存储状态；内联指令仅应用于单条消息。
- 提升的 `exec` 在主机上运行并绕过沙箱。
- 工具策略仍然适用；如果 `exec` 被拒绝，则无法使用提升。

`agents.defaults.maxConcurrent` 设置跨会话可并行执行的内置智能体运行的最大数量。每个会话仍然是串行的（每个会话键同时只有一个运行）。默认：1。

### `agents.defaults.sandbox`

为内置智能体提供可选的 **Docker 沙箱**。适用于非主会话，使其无法访问你的主机系统。

详情：[沙箱](/gateway/sandboxing)

默认值（如果启用）：

- scope：`"agent"`（每个智能体一个容器 + 工作区）
- 基于 Debian bookworm-slim 的镜像
- 智能体工作区访问：`workspaceAccess: "none"`（默认）
  - `"none"`：在 `~/.openclaw/sandboxes` 下使用每范围的沙箱工作区
- `"ro"`：将沙箱工作区保持在 `/workspace`，智能体工作区以只读方式挂载到 `/agent`（禁用 `write`/`edit`/`apply_patch`）
  - `"rw"`：将智能体工作区以读写方式挂载到 `/workspace`
- 自动清理：空闲超过 24h 或存在超过 7d
- 工具策略：仅允许 `exec`、`process`、`read`、`write`、`edit`、`apply_patch`、`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`（deny 优先）
  - 通过 `tools.sandbox.tools` 配置，通过 `agents.list[].tools.sandbox.tools` 进行每智能体覆盖
  - 沙箱策略中支持工具组简写：`group:runtime`、`group:fs`、`group:sessions`、`group:memory`（参见[沙箱 vs 工具策略 vs 提升](/gateway/sandbox-vs-tool-policy-vs-elevated#tool-groups-shorthands)）
- 可选的沙箱浏览器（Chromium + CDP，noVNC 观察器）
- 加固旋钮：`network`、`user`、`pidsLimit`、`memory`、`cpus`、`ulimits`、`seccompProfile`、`apparmorProfile`

警告：`scope: "shared"` 意味着共享容器和共享工作区。无跨会话隔离。使用 `scope: "session"` 获得每会话隔离。

旧版：`perSession` 仍然支持（`true` → `scope: "session"`，`false` → `scope: "shared"`）。

`setupCommand` 在容器创建后**运行一次**（在容器内通过 `sh -lc` 执行）。
对于包安装，确保网络出口、可写根文件系统和 root 用户。

```json5
{
  agents: {
    defaults: {
      sandbox: {
        mode: "non-main", // off | non-main | all
        scope: "agent", // session | agent | shared（agent 为默认）
        workspaceAccess: "none", // none | ro | rw
        workspaceRoot: "~/.openclaw/sandboxes",
        docker: {
          image: "openclaw-sandbox:bookworm-slim",
          containerPrefix: "openclaw-sbx-",
          workdir: "/workspace",
          readOnlyRoot: true,
          tmpfs: ["/tmp", "/var/tmp", "/run"],
          network: "none",
          user: "1000:1000",
          capDrop: ["ALL"],
          env: { LANG: "C.UTF-8" },
          setupCommand: "apt-get update && apt-get install -y git curl jq",
          // 每智能体覆盖（多智能体）：agents.list[].sandbox.docker.*
          pidsLimit: 256,
          memory: "1g",
          memorySwap: "2g",
          cpus: 1,
          ulimits: {
            nofile: { soft: 1024, hard: 2048 },
            nproc: 256,
          },
          seccompProfile: "/path/to/seccomp.json",
          apparmorProfile: "openclaw-sandbox",
          dns: ["1.1.1.1", "8.8.8.8"],
          extraHosts: ["internal.service:10.0.0.5"],
          binds: ["/var/run/docker.sock:/var/run/docker.sock", "/home/user/source:/source:rw"],
        },
        browser: {
          enabled: false,
          image: "openclaw-sandbox-browser:bookworm-slim",
          containerPrefix: "openclaw-sbx-browser-",
          cdpPort: 9222,
          vncPort: 5900,
          noVncPort: 6080,
          headless: false,
          enableNoVnc: true,
          allowHostControl: false,
          allowedControlUrls: ["http://10.0.0.42:18791"],
          allowedControlHosts: ["browser.lab.local", "10.0.0.42"],
          allowedControlPorts: [18791],
          autoStart: true,
          autoStartTimeoutMs: 12000,
        },
        prune: {
          idleHours: 24, // 0 禁用空闲清理
          maxAgeDays: 7, // 0 禁用最大存活时间清理
        },
      },
    },
  },
  tools: {
    sandbox: {
      tools: {
        allow: [
          "exec",
          "process",
          "read",
          "write",
          "edit",
          "apply_patch",
          "sessions_list",
          "sessions_history",
          "sessions_send",
          "sessions_spawn",
          "session_status",
        ],
        deny: ["browser", "canvas", "nodes", "cron", "discord", "gateway"],
      },
    },
  },
}
```

首次构建默认沙箱镜像：

```bash
scripts/sandbox-setup.sh
```

注意：沙箱容器默认为 `network: "none"`；如果智能体需要出站访问，请将 `agents.defaults.sandbox.docker.network` 设为 `"bridge"`（或你的自定义网络）。

注意：入站附件会暂存到活跃工作区的 `media/inbound/*` 中。使用 `workspaceAccess: "rw"` 时，文件会写入智能体工作区。

注意：`docker.binds` 挂载额外的主机目录；全局和每智能体的 binds 会合并。

构建可选的浏览器镜像：

```bash
scripts/sandbox-browser-setup.sh
```

当 `agents.defaults.sandbox.browser.enabled=true` 时，浏览器工具使用沙箱化的
Chromium 实例（CDP）。如果启用了 noVNC（headless=false 时默认启用），
noVNC URL 会注入系统提示中，以便智能体可以引用它。
这不需要主配置中的 `browser.enabled`；沙箱控制 URL 按会话注入。

`agents.defaults.sandbox.browser.allowHostControl`（默认：false）允许
沙箱会话通过浏览器工具显式访问**主机**浏览器控制服务器
（`target: "host"`）。如果你需要严格的沙箱隔离，请保持关闭。

远程控制白名单：

- `allowedControlUrls`：`target: "custom"` 允许的精确控制 URL。
- `allowedControlHosts`：允许的主机名（仅主机名，无端口）。
- `allowedControlPorts`：允许的端口（默认：http=80，https=443）。
  默认：所有白名单未设置（无限制）。`allowHostControl` 默认为 false。

### `models`（自定义提供商 + 基础 URL）

OpenClaw 使用 **pi-coding-agent** 模型目录。你可以通过编写
`~/.openclaw/agents/<agentId>/agent/models.json` 或在 OpenClaw 配置中的 `models.providers` 下定义相同的 schema 来添加自定义提供商（LiteLLM、本地 OpenAI 兼容服务器、Anthropic 代理等）。
按提供商的概述 + 示例：[/concepts/model-providers](/concepts/model-providers)。

当存在 `models.providers` 时，OpenClaw 在启动时将 `models.json` 写入/合并到
`~/.openclaw/agents/<agentId>/agent/`：

- 默认行为：**合并**（保留现有提供商，按名称覆盖）
- 设为 `models.mode: "replace"` 覆盖文件内容

通过 `agents.defaults.model.primary`（provider/model）选择模型。

```json5
{
  agents: {
    defaults: {
      model: { primary: "custom-proxy/llama-3.1-8b" },
      models: {
        "custom-proxy/llama-3.1-8b": {},
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "LITELLM_KEY",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
}
```

### OpenCode Zen（多模型代理）

OpenCode Zen 是一个具有每模型端点的多模型网关。OpenClaw 使用
pi-ai 内置的 `opencode` 提供商；从 https://opencode.ai/auth 设置 `OPENCODE_API_KEY`（或
`OPENCODE_ZEN_API_KEY`）。

说明：

- 模型引用使用 `opencode/<modelId>`（示例：`opencode/claude-opus-4-5`）。
- 如果你通过 `agents.defaults.models` 启用白名单，请添加你计划使用的每个模型。
- 快捷方式：`openclaw onboard --auth-choice opencode-zen`。

```json5
{
  agents: {
    defaults: {
      model: { primary: "opencode/claude-opus-4-5" },
      models: { "opencode/claude-opus-4-5": { alias: "Opus" } },
    },
  },
}
```

### Z.AI（GLM-4.7）— 提供商别名支持

Z.AI 模型通过内置的 `zai` 提供商提供。在环境中设置 `ZAI_API_KEY`
并通过 provider/model 引用模型。

快捷方式：`openclaw onboard --auth-choice zai-api-key`。

```json5
{
  agents: {
    defaults: {
      model: { primary: "zai/glm-4.7" },
      models: { "zai/glm-4.7": {} },
    },
  },
}
```

说明：

- `z.ai/*` 和 `z-ai/*` 是接受的别名，规范化为 `zai/*`。
- 如果缺少 `ZAI_API_KEY`，对 `zai/*` 的请求将在运行时因认证错误失败。
- 示例错误：`No API key found for provider "zai".`
- Z.AI 的通用 API 端点是 `https://api.z.ai/api/paas/v4`。GLM 编码
  请求使用专用编码端点 `https://api.z.ai/api/coding/paas/v4`。
  内置的 `zai` 提供商使用编码端点。如果你需要通用
  端点，请在 `models.providers` 中定义自定义提供商并覆盖基础 URL
  （参见上方自定义提供商部分）。
- 在文档/配置中使用假占位符；切勿提交真实 API 密钥。

### Moonshot AI（Kimi）

使用 Moonshot 的 OpenAI 兼容端点：

```json5
{
  env: { MOONSHOT_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "moonshot/kimi-k2.5" },
      models: { "moonshot/kimi-k2.5": { alias: "Kimi K2.5" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "${MOONSHOT_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "kimi-k2.5",
            name: "Kimi K2.5",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 256000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

说明：

- 在环境中设置 `MOONSHOT_API_KEY` 或使用 `openclaw onboard --auth-choice moonshot-api-key`。
- 模型引用：`moonshot/kimi-k2.5`。
- 如需中国端点，使用 `https://api.moonshot.cn/v1`。

### Kimi Coding

使用 Moonshot AI 的 Kimi Coding 端点（Anthropic 兼容，内置提供商）：

```json5
{
  env: { KIMI_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "kimi-coding/k2p5" },
      models: { "kimi-coding/k2p5": { alias: "Kimi K2.5" } },
    },
  },
}
```

说明：

- 在环境中设置 `KIMI_API_KEY` 或使用 `openclaw onboard --auth-choice kimi-code-api-key`。
- 模型引用：`kimi-coding/k2p5`。

### Synthetic（Anthropic 兼容）

使用 Synthetic 的 Anthropic 兼容端点：

```json5
{
  env: { SYNTHETIC_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: { primary: "synthetic/hf:MiniMaxAI/MiniMax-M2.1" },
      models: { "synthetic/hf:MiniMaxAI/MiniMax-M2.1": { alias: "MiniMax M2.1" } },
    },
  },
  models: {
    mode: "merge",
    providers: {
      synthetic: {
        baseUrl: "https://api.synthetic.new/anthropic",
        apiKey: "${SYNTHETIC_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "hf:MiniMaxAI/MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 192000,
            maxTokens: 65536,
          },
        ],
      },
    },
  },
}
```

说明：

- 设置 `SYNTHETIC_API_KEY` 或使用 `openclaw onboard --auth-choice synthetic-api-key`。
- 模型引用：`synthetic/hf:MiniMaxAI/MiniMax-M2.1`。
- 基础 URL 应省略 `/v1`，因为 Anthropic 客户端会自动附加。

### 本地模型（LM Studio）— 推荐设置

参见 [/gateway/local-models](/gateway/local-models) 了解当前本地指南。简而言之：在高性能硬件上通过 LM Studio Responses API 运行 MiniMax M2.1；保留托管模型合并作为回退。

### MiniMax M2.1

不通过 LM Studio 直接使用 MiniMax M2.1：

```json5
{
  agent: {
    model: { primary: "minimax/MiniMax-M2.1" },
    models: {
      "anthropic/claude-opus-4-5": { alias: "Opus" },
      "minimax/MiniMax-M2.1": { alias: "Minimax" },
    },
  },
  models: {
    mode: "merge",
    providers: {
      minimax: {
        baseUrl: "https://api.minimax.io/anthropic",
        apiKey: "${MINIMAX_API_KEY}",
        api: "anthropic-messages",
        models: [
          {
            id: "MiniMax-M2.1",
            name: "MiniMax M2.1",
            reasoning: false,
            input: ["text"],
            // 定价：如需精确费用跟踪，请在 models.json 中更新。
            cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
            contextWindow: 200000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
}
```

说明：

- 设置 `MINIMAX_API_KEY` 环境变量或使用 `openclaw onboard --auth-choice minimax-api`。
- 可用模型：`MiniMax-M2.1`（默认）。
- 如需精确费用跟踪，请在 `models.json` 中更新定价。

### Cerebras（GLM 4.6 / 4.7）

通过 Cerebras 的 OpenAI 兼容端点使用：

```json5
{
  env: { CEREBRAS_API_KEY: "sk-..." },
  agents: {
    defaults: {
      model: {
        primary: "cerebras/zai-glm-4.7",
        fallbacks: ["cerebras/zai-glm-4.6"],
      },
      models: {
        "cerebras/zai-glm-4.7": { alias: "GLM 4.7 (Cerebras)" },
        "cerebras/zai-glm-4.6": { alias: "GLM 4.6 (Cerebras)" },
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      cerebras: {
        baseUrl: "https://api.cerebras.ai/v1",
        apiKey: "${CEREBRAS_API_KEY}",
        api: "openai-completions",
        models: [
          { id: "zai-glm-4.7", name: "GLM 4.7 (Cerebras)" },
          { id: "zai-glm-4.6", name: "GLM 4.6 (Cerebras)" },
        ],
      },
    },
  },
}
```

说明：

- Cerebras 使用 `cerebras/zai-glm-4.7`；Z.AI 直连使用 `zai/glm-4.7`。
- 在环境或配置中设置 `CEREBRAS_API_KEY`。

说明：

- 支持的 API：`openai-completions`、`openai-responses`、`anthropic-messages`、
  `google-generative-ai`
- 对于自定义认证需求使用 `authHeader: true` + `headers`。
- 如果你希望 `models.json` 存储在其他位置，请使用 `OPENCLAW_AGENT_DIR`（或 `PI_CODING_AGENT_DIR`）覆盖智能体配置根目录（默认：`~/.openclaw/agents/main/agent`）。

### `session`

控制会话作用域、重置策略、重置触发器以及会话存储的写入位置。

```json5
{
  session: {
    scope: "per-sender",
    dmScope: "main",
    identityLinks: {
      alice: ["telegram:123456789", "discord:987654321012345678"],
    },
    reset: {
      mode: "daily",
      atHour: 4,
      idleMinutes: 60,
    },
    resetByType: {
      thread: { mode: "daily", atHour: 4 },
      dm: { mode: "idle", idleMinutes: 240 },
      group: { mode: "idle", idleMinutes: 120 },
    },
    resetTriggers: ["/new", "/reset"],
    // 默认已按智能体存储在 ~/.openclaw/agents/<agentId>/sessions/sessions.json
    // 你可以使用 {agentId} 模板进行覆盖：
    store: "~/.openclaw/agents/{agentId}/sessions/sessions.json",
    // 私聊折叠到 agent:<agentId>:<mainKey>（默认："main"）。
    mainKey: "main",
    agentToAgent: {
      // 请求者/目标之间的最大乒乓回复轮次（0–5）。
      maxPingPongTurns: 5,
    },
    sendPolicy: {
      rules: [{ action: "deny", match: { channel: "discord", chatType: "group" } }],
      default: "allow",
    },
  },
}
```

字段：

- `mainKey`：私聊桶键（默认：`"main"`）。当你想"重命名"主私聊线程而不更改 `agentId` 时有用。
  - 沙箱说明：`agents.defaults.sandbox.mode: "non-main"` 使用此键检测主会话。任何不匹配 `mainKey` 的会话键（群组/频道）都会被沙箱化。
- `dmScope`：私聊会话如何分组（默认：`"main"`）。
  - `main`：所有私聊共享主会话以保持连续性。
  - `per-peer`：按发送者 id 跨渠道隔离私聊。
  - `per-channel-peer`：按渠道 + 发送者隔离私聊（推荐用于多用户收件箱）。
  - `per-account-channel-peer`：按账号 + 渠道 + 发送者隔离私聊（推荐用于多账号收件箱）。
- `identityLinks`：将规范 id 映射到提供商前缀的对等方，以便在使用 `per-peer`、`per-channel-peer` 或 `per-account-channel-peer` 时同一人跨渠道共享私聊会话。
  - 示例：`alice: ["telegram:123456789", "discord:987654321012345678"]`。
- `reset`：主重置策略。默认为 Gateway 网关主机上本地时间凌晨 4:00 每日重置。
  - `mode`：`daily` 或 `idle`（当存在 `reset` 时默认：`daily`）。
  - `atHour`：本地小时（0-23）作为每日重置边界。
  - `idleMinutes`：滑动空闲窗口（分钟）。当 daily + idle 都配置时，先到期的获胜。
- `resetByType`：`dm`、`group` 和 `thread` 的每会话覆盖。
  - 如果你只设置了旧版 `session.idleMinutes` 而没有任何 `reset`/`resetByType`，OpenClaw 保持仅空闲模式以向后兼容。
- `heartbeatIdleMinutes`：可选的心跳检查空闲覆盖（启用时每日重置仍然适用）。
- `agentToAgent.maxPingPongTurns`：请求者/目标之间的最大回复轮次（0–5，默认 5）。
- `sendPolicy.default`：无规则匹配时的 `allow` 或 `deny` 回退。
- `sendPolicy.rules[]`：按 `channel`、`chatType`（`direct|group|room`）或 `keyPrefix`（例如 `cron:`）匹配。第一个 deny 获胜；否则 allow。

### `skills`（Skills 配置）

控制内置白名单、安装偏好、额外 Skills 文件夹和每 Skills 覆盖。适用于**内置**Skills 和 `~/.openclaw/skills`（工作区 Skills 在名称冲突时仍然优先）。

字段：

- `allowBundled`：可选的**仅内置**Skills 白名单。如果设置，仅那些内置 Skills 符合条件（管理/工作区 Skills 不受影响）。
- `load.extraDirs`：额外要扫描的 Skills 目录（最低优先级）。
- `install.preferBrew`：可用时优先使用 brew 安装程序（默认：true）。
- `install.nodeManager`：node 安装偏好（`npm` | `pnpm` | `yarn`，默认：npm）。
- `entries.<skillKey>`：每 Skills 配置覆盖。

每 Skills 字段：

- `enabled`：设为 `false` 禁用 Skills，即使它是内置/已安装的。
- `env`：为智能体运行注入的环境变量（仅在尚未设置时）。
- `apiKey`：对于声明了主环境变量的 Skills 的可选便利字段（例如 `nano-banana-pro` → `GEMINI_API_KEY`）。

示例：

```json5
{
  skills: {
    allowBundled: ["gemini", "peekaboo"],
    load: {
      extraDirs: ["~/Projects/agent-scripts/skills", "~/Projects/oss/some-skill-pack/skills"],
    },
    install: {
      preferBrew: true,
      nodeManager: "npm",
    },
    entries: {
      "nano-banana-pro": {
        apiKey: "GEMINI_KEY_HERE",
        env: {
          GEMINI_API_KEY: "GEMINI_KEY_HERE",
        },
      },
      peekaboo: { enabled: true },
      sag: { enabled: false },
    },
  },
}
```

### `plugins`（扩展）

控制插件发现、允许/拒绝和每插件配置。插件从 `~/.openclaw/extensions`、`<workspace>/.openclaw/extensions` 以及任何 `plugins.load.paths` 条目加载。**配置更改需要重启 Gateway 网关。**
参见 [/plugin](/plugin) 了解详情。

字段：

- `enabled`：插件加载的主开关（默认：true）。
- `allow`：可选的插件 id 白名单；设置后仅加载列出的插件。
- `deny`：可选的插件 id 拒绝列表（deny 优先）。
- `load.paths`：要加载的额外插件文件或目录（绝对路径或 `~`）。
- `entries.<pluginId>`：每插件覆盖。
  - `enabled`：设为 `false` 禁用。
  - `config`：插件特定的配置对象（如果提供，由插件验证）。

示例：

```json5
{
  plugins: {
    enabled: true,
    allow: ["voice-call"],
    load: {
      paths: ["~/Projects/oss/voice-call-extension"],
    },
    entries: {
      "voice-call": {
        enabled: true,
        config: {
          provider: "twilio",
        },
      },
    },
  },
}
```

### `browser`（OpenClaw 管理的浏览器）

OpenClaw 可以为 OpenClaw 启动一个**专用、隔离的** Chrome/Brave/Edge/Chromium 实例并暴露一个小型 local loopback 控制服务。
配置文件可以通过 `profiles.<name>.cdpUrl` 指向**远程** Chromium 浏览器。远程配置文件为仅附加模式（start/stop/reset 被禁用）。

`browser.cdpUrl` 保留用于旧版单配置文件配置，以及作为仅设置 `cdpPort` 的配置文件的基础 scheme/host。

默认值：

- enabled：`true`
- evaluateEnabled：`true`（设为 `false` 禁用 `act:evaluate` 和 `wait --fn`）
- 控制服务：仅 local loopback（端口从 `gateway.port` 派生，默认 `18791`）
- CDP URL：`http://127.0.0.1:18792`（控制服务 + 1，旧版单配置文件）
- 配置文件颜色：`#FF4500`（龙虾橙）
- 注意：控制服务器由运行中的 Gateway 网关（OpenClaw.app 菜单栏或 `openclaw gateway`）启动。
- 自动检测顺序：如果为 Chromium 内核则使用默认浏览器；否则 Chrome → Brave → Edge → Chromium → Chrome Canary。

```json5
{
  browser: {
    enabled: true,
    evaluateEnabled: true,
    // cdpUrl: "http://127.0.0.1:18792", // 旧版单配置文件覆盖
    defaultProfile: "chrome",
    profiles: {
      openclaw: { cdpPort: 18800, color: "#FF4500" },
      work: { cdpPort: 18801, color: "#0066CC" },
      remote: { cdpUrl: "http://10.0.0.42:9222", color: "#00AA00" },
    },
    color: "#FF4500",
    // 高级：
    // headless: false,
    // noSandbox: false,
    // executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    // attachOnly: false, // 将远程 CDP 隧道到 localhost 时设为 true
  },
}
```

### `ui`（外观）

原生应用用于 UI 外观的可选强调色（例如 Talk 模式气泡着色）。

如果未设置，客户端回退到柔和的浅蓝色。

```json5
{
  ui: {
    seamColor: "#FF4500", // 十六进制（RRGGBB 或 #RRGGBB）
    // 可选：控制台 UI 助手身份覆盖。
    // 如果未设置，控制台 UI 使用活跃智能体的身份（配置或 IDENTITY.md）。
    assistant: {
      name: "OpenClaw",
      avatar: "CB", // 表情、短文本，或图片 URL/data URI
    },
  },
}
```

### `gateway`（Gateway 网关服务器模式 + 绑定）

使用 `gateway.mode` 明确声明此机器是否应运行 Gateway 网关。

默认值：

- mode：**未设置**（视为"不自动启动"）
- bind：`loopback`
- port：`18789`（WS + HTTP 单端口）

```json5
{
  gateway: {
    mode: "local", // 或 "remote"
    port: 18789, // WS + HTTP 多路复用
    bind: "loopback",
    // controlUi: { enabled: true, basePath: "/openclaw" }
    // auth: { mode: "token", token: "your-token" } // token 控制 WS + 控制台 UI 访问
    // tailscale: { mode: "off" | "serve" | "funnel" }
  },
}
```

控制台 UI 基础路径：

- `gateway.controlUi.basePath` 设置控制台 UI 提供服务的 URL 前缀。
- 示例：`"/ui"`、`"/openclaw"`、`"/apps/openclaw"`。
- 默认：根路径（`/`）（不变）。
- `gateway.controlUi.root` 设置控制台 UI 资产的文件系统根目录（默认：`dist/control-ui`）。
- `gateway.controlUi.allowInsecureAuth` 允许在省略设备身份时对控制台 UI 进行仅 token 认证（通常通过 HTTP）。默认：`false`。建议使用 HTTPS（Tailscale Serve）或 `127.0.0.1`。
- `gateway.controlUi.dangerouslyDisableDeviceAuth` 禁用控制台 UI 的设备身份检查（仅 token/密码）。默认：`false`。仅用于紧急情况。

相关文档：

- [控制台 UI](/web/control-ui)
- [Web 概述](/web)
- [Tailscale](/gateway/tailscale)
- [远程访问](/gateway/remote)

信任的代理：

- `gateway.trustedProxies`：在 Gateway 网关前面终止 TLS 的反向代理 IP 列表。
- 当连接来自这些 IP 之一时，OpenClaw 使用 `x-forwarded-for`（或 `x-real-ip`）来确定客户端 IP，用于本地配对检查和 HTTP 认证/本地检查。
- 仅列出你完全控制的代理，并确保它们**覆盖**传入的 `x-forwarded-for`。

说明：

- `openclaw gateway` 拒绝启动，除非 `gateway.mode` 设为 `local`（或你传递了覆盖标志）。
- `gateway.port` 控制用于 WebSocket + HTTP（控制台 UI、hooks、A2UI）的单一多路复用端口。
- OpenAI Chat Completions 端点：**默认禁用**；通过 `gateway.http.endpoints.chatCompletions.enabled: true` 启用。
- 优先级：`--port` > `OPENCLAW_GATEWAY_PORT` > `gateway.port` > 默认 `18789`。
- 默认需要 Gateway 网关认证（token/密码或 Tailscale Serve 身份）。非 local loopback 绑定需要共享 token/密码。
- 新手引导向导默认生成 gateway token（即使在 local loopback 上）。
- `gateway.remote.token` **仅**用于远程 CLI 调用；它不启用本地 gateway 认证。`gateway.token` 被忽略。

认证和 Tailscale：

- `gateway.auth.mode` 设置握手要求（`token` 或 `password`）。未设置时，假定 token 认证。
- `gateway.auth.token` 存储 token 认证的共享 token（同一机器上的 CLI 使用）。
- 当设置了 `gateway.auth.mode` 时，仅接受该方法（加上可选的 Tailscale 头部）。
- `gateway.auth.password` 可在此设置，或通过 `OPENCLAW_GATEWAY_PASSWORD`（推荐）。
- `gateway.auth.allowTailscale` 允许 Tailscale Serve 身份头部
  （`tailscale-user-login`）在请求通过 local loopback 到达且带有 `x-forwarded-for`、
  `x-forwarded-proto` 和 `x-forwarded-host` 时满足认证。OpenClaw 在接受之前
  通过 `tailscale whois` 解析 `x-forwarded-for` 地址来验证身份。为 `true` 时，
  Serve 请求不需要 token/密码；设为 `false` 要求显式凭据。当
  `tailscale.mode = "serve"` 且认证模式不是 `password` 时默认为 `true`。
- `gateway.tailscale.mode: "serve"` 使用 Tailscale Serve（仅 tailnet，local loopback 绑定）。
- `gateway.tailscale.mode: "funnel"` 公开暴露仪表板；需要认证。
- `gateway.tailscale.resetOnExit` 在关闭时重置 Serve/Funnel 配置。

远程客户端默认值（CLI）：

- `gateway.remote.url` 设置 `gateway.mode = "remote"` 时 CLI 调用的默认 Gateway 网关 WebSocket URL。
- `gateway.remote.transport` 选择 macOS 远程传输（`ssh` 默认，`direct` 用于 ws/wss）。使用 `direct` 时，`gateway.remote.url` 必须为 `ws://` 或 `wss://`。`ws://host` 默认端口 `18789`。
- `gateway.remote.token` 提供远程调用的 token（不需要认证时留空）。
- `gateway.remote.password` 提供远程调用的密码（不需要认证时留空）。

macOS 应用行为：

- OpenClaw.app 监视 `~/.openclaw/openclaw.json`，当 `gateway.mode` 或 `gateway.remote.url` 变更时实时切换模式。
- 如果 `gateway.mode` 未设置但 `gateway.remote.url` 已设置，macOS 应用将其视为远程模式。
- 当你在 macOS 应用中更改连接模式时，它会将 `gateway.mode`（以及远程模式下的 `gateway.remote.url` + `gateway.remote.transport`）写回配置文件。

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      url: "ws://gateway.tailnet:18789",
      token: "your-token",
      password: "your-password",
    },
  },
}
```

直连传输示例（macOS 应用）：

```json5
{
  gateway: {
    mode: "remote",
    remote: {
      transport: "direct",
      url: "wss://gateway.example.ts.net",
      token: "your-token",
    },
  },
}
```

### `gateway.reload`（配置热重载）

Gateway 网关监视 `~/.openclaw/openclaw.json`（或 `OPENCLAW_CONFIG_PATH`）并自动应用更改。

模式：

- `hybrid`（默认）：安全更改热应用；关键更改重启 Gateway 网关。
- `hot`：仅应用热安全更改；需要重启时记录日志。
- `restart`：任何配置更改都重启 Gateway 网关。
- `off`：禁用热重载。

```json5
{
  gateway: {
    reload: {
      mode: "hybrid",
      debounceMs: 300,
    },
  },
}
```

#### 热重载矩阵（文件 + 影响）

监视的文件：

- `~/.openclaw/openclaw.json`（或 `OPENCLAW_CONFIG_PATH`）

热应用（无需完全重启 Gateway 网关）：

- `hooks`（webhook 认证/路径/映射）+ `hooks.gmail`（Gmail 监视器重启）
- `browser`（浏览器控制服务器重启）
- `cron`（cron 服务重启 + 并发更新）
- `agents.defaults.heartbeat`（心跳运行器重启）
- `web`（WhatsApp Web 渠道重启）
- `telegram`、`discord`、`signal`、`imessage`（渠道重启）
- `agent`、`models`、`routing`、`messages`、`session`、`whatsapp`、`logging`、`skills`、`ui`、`talk`、`identity`、`wizard`（动态读取）

需要完全重启 Gateway 网关：

- `gateway`（端口/绑定/认证/控制台 UI/tailscale）
- `bridge`（旧版）
- `discovery`
- `canvasHost`
- `plugins`
- 任何未知/不支持的配置路径（为安全默认重启）

### 多实例隔离

要在一台主机上运行多个 Gateway 网关（用于冗余或救援机器人），请隔离每个实例的状态 + 配置并使用唯一端口：

- `OPENCLAW_CONFIG_PATH`（每实例配置）
- `OPENCLAW_STATE_DIR`（会话/凭据）
- `agents.defaults.workspace`（记忆）
- `gateway.port`（每实例唯一）

便利标志（CLI）：

- `openclaw --dev …` → 使用 `~/.openclaw-dev` + 端口从基础 `19001` 偏移
- `openclaw --profile <name> …` → 使用 `~/.openclaw-<name>`（端口通过配置/环境变量/标志）

参见 [Gateway 网关运维手册](/gateway) 了解派生的端口映射（gateway/browser/canvas）。
参见[多 Gateway 网关](/gateway/multiple-gateways) 了解浏览器/CDP 端口隔离细节。

示例：

```bash
OPENCLAW_CONFIG_PATH=~/.openclaw/a.json \
OPENCLAW_STATE_DIR=~/.openclaw-a \
openclaw gateway --port 19001
```

### `hooks`（Gateway 网关 webhook）

在 Gateway 网关 HTTP 服务器上启用简单的 HTTP webhook 端点。

默认值：

- enabled：`false`
- path：`/hooks`
- maxBodyBytes：`262144`（256 KB）

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
    presets: ["gmail"],
    transformsDir: "~/.openclaw/hooks",
    mappings: [
      {
        match: { path: "gmail" },
        action: "agent",
        wakeMode: "now",
        name: "Gmail",
        sessionKey: "hook:gmail:{{messages[0].id}}",
        messageTemplate: "From: {{messages[0].from}}\nSubject: {{messages[0].subject}}\n{{messages[0].snippet}}",
        deliver: true,
        channel: "last",
        model: "openai/gpt-5.2-mini",
      },
    ],
  },
}
```

请求必须包含 hook token：

- `Authorization: Bearer <token>` **或**
- `x-openclaw-token: <token>` **或**
- `?token=<token>`

端点：

- `POST /hooks/wake` → `{ text, mode?: "now"|"next-heartbeat" }`
- `POST /hooks/agent` → `{ message, name?, sessionKey?, wakeMode?, deliver?, channel?, to?, model?, thinking?, timeoutSeconds? }`
- `POST /hooks/<name>` → 通过 `hooks.mappings` 解析

`/hooks/agent` 始终将摘要发布到主会话（并可通过 `wakeMode: "now"` 可选地触发即时心跳）。

映射说明：

- `match.path` 匹配 `/hooks` 之后的子路径（例如 `/hooks/gmail` → `gmail`）。
- `match.source` 匹配负载字段（例如 `{ source: "gmail" }`），以便使用通用的 `/hooks/ingest` 路径。
- `{{messages[0].subject}}` 等模板从负载中读取。
- `transform` 可以指向返回 hook 动作的 JS/TS 模块。
- `deliver: true` 将最终回复发送到渠道；`channel` 默认为 `last`（回退到 WhatsApp）。
- 如果没有先前的投递路由，请显式设置 `channel` + `to`（Telegram/Discord/Google Chat/Slack/Signal/iMessage/MS Teams 必需）。
- `model` 覆盖此 hook 运行的 LLM（`provider/model` 或别名；如果设置了 `agents.defaults.models` 则必须被允许）。

Gmail 辅助配置（由 `openclaw webhooks gmail setup` / `run` 使用）：

```json5
{
  hooks: {
    gmail: {
      account: "openclaw@gmail.com",
      topic: "projects/<project-id>/topics/gog-gmail-watch",
      subscription: "gog-gmail-watch-push",
      pushToken: "shared-push-token",
      hookUrl: "http://127.0.0.1:18789/hooks/gmail",
      includeBody: true,
      maxBytes: 20000,
      renewEveryMinutes: 720,
      serve: { bind: "127.0.0.1", port: 8788, path: "/" },
      tailscale: { mode: "funnel", path: "/gmail-pubsub" },

      // 可选：为 Gmail hook 处理使用更便宜的模型
      // 在认证/速率限制/超时时回退到 agents.defaults.model.fallbacks，然后 primary
      model: "openrouter/meta-llama/llama-3.3-70b-instruct:free",
      // 可选：Gmail hook 的默认思考级别
      thinking: "off",
    },
  },
}
```

Gmail hook 的模型覆盖：

- `hooks.gmail.model` 指定用于 Gmail hook 处理的模型（默认为会话主模型）。
- 接受 `provider/model` 引用或来自 `agents.defaults.models` 的别名。
- 在认证/速率限制/超时时回退到 `agents.defaults.model.fallbacks`，然后 `agents.defaults.model.primary`。
- 如果设置了 `agents.defaults.models`，请将 hooks 模型包含在白名单中。
- 启动时，如果配置的模型不在模型目录或白名单中，会发出警告。
- `hooks.gmail.thinking` 设置 Gmail hook 的默认思考级别，被每 hook 的 `thinking` 覆盖。

Gateway 网关自动启动：

- 如果 `hooks.enabled=true` 且 `hooks.gmail.account` 已设置，Gateway 网关在启动时
  启动 `gog gmail watch serve` 并自动续期监视。
- 设置 `OPENCLAW_SKIP_GMAIL_WATCHER=1` 禁用自动启动（用于手动运行）。
- 避免在 Gateway 网关旁边单独运行 `gog gmail watch serve`；它会
  因 `listen tcp 127.0.0.1:8788: bind: address already in use` 而失败。

注意：当 `tailscale.mode` 开启时，OpenClaw 将 `serve.path` 默认为 `/`，以便
Tailscale 可以正确代理 `/gmail-pubsub`（它会去除设置的路径前缀）。
如果你需要后端接收带前缀的路径，请将
`hooks.gmail.tailscale.target` 设为完整 URL（并对齐 `serve.path`）。

### `canvasHost`（LAN/tailnet Canvas 文件服务器 + 实时重载）

Gateway 网关通过 HTTP 提供 HTML/CSS/JS 目录服务，以便 iOS/Android 节点可以简单地 `canvas.navigate` 到它。

默认根目录：`~/.openclaw/workspace/canvas`
默认端口：`18793`（选择此端口以避免 OpenClaw 浏览器 CDP 端口 `18792`）
服务器监听 **Gateway 网关绑定主机**（LAN 或 Tailnet），以便节点可以访问。

服务器：

- 提供 `canvasHost.root` 下的文件
- 向提供的 HTML 注入微型实时重载客户端
- 监视目录并通过 `/__openclaw__/ws` 的 WebSocket 端点广播重载
- 目录为空时自动创建起始 `index.html`（以便你立即看到内容）
- 同时在 `/__openclaw__/a2ui/` 提供 A2UI，并作为 `canvasHostUrl` 通告给节点
  （节点始终使用它来访问 Canvas/A2UI）

如果目录很大或遇到 `EMFILE`，请禁用实时重载（和文件监视）：

- 配置：`canvasHost: { liveReload: false }`

```json5
{
  canvasHost: {
    root: "~/.openclaw/workspace/canvas",
    port: 18793,
    liveReload: true,
  },
}
```

`canvasHost.*` 的更改需要重启 Gateway 网关（配置重载会触发重启）。

禁用方式：

- 配置：`canvasHost: { enabled: false }`
- 环境变量：`OPENCLAW_SKIP_CANVAS_HOST=1`

### `bridge`（旧版 TCP 桥接，已移除）

当前版本不再包含 TCP 桥接监听器；`bridge.*` 配置键会被忽略。
节点通过 Gateway 网关 WebSocket 连接。此部分仅保留供历史参考。

旧版行为：

- Gateway 网关可以为节点（iOS/Android）暴露简单的 TCP 桥接，通常在端口 `18790`。

默认值：

- enabled：`true`
- port：`18790`
- bind：`lan`（绑定到 `0.0.0.0`）

绑定模式：

- `lan`：`0.0.0.0`（可通过任何接口访问，包括 LAN/Wi‑Fi 和 Tailscale）
- `tailnet`：仅绑定到机器的 Tailscale IP（推荐用于跨地域访问）
- `loopback`：`127.0.0.1`（仅本地）
- `auto`：如果存在 tailnet IP 则优先使用，否则 `lan`

TLS：

- `bridge.tls.enabled`：为桥接连接启用 TLS（启用时仅 TLS）。
- `bridge.tls.autoGenerate`：当无证书/密钥时生成自签名证书（默认：true）。
- `bridge.tls.certPath` / `bridge.tls.keyPath`：桥接证书 + 私钥的 PEM 路径。
- `bridge.tls.caPath`：可选的 PEM CA 捆绑包（自定义根证书或未来的 mTLS）。

启用 TLS 后，Gateway 网关在发现 TXT 记录中通告 `bridgeTls=1` 和 `bridgeTlsSha256`，以便节点可以固定证书。如果尚未存储指纹，手动连接使用首次信任。
自动生成的证书需要 PATH 中有 `openssl`；如果生成失败，桥接不会启动。

```json5
{
  bridge: {
    enabled: true,
    port: 18790,
    bind: "tailnet",
    tls: {
      enabled: true,
      // 省略时使用 ~/.openclaw/bridge/tls/bridge-{cert,key}.pem。
      // certPath: "~/.openclaw/bridge/tls/bridge-cert.pem",
      // keyPath: "~/.openclaw/bridge/tls/bridge-key.pem"
    },
  },
}
```

### `discovery.mdns`（Bonjour / mDNS 广播模式）

控制 LAN mDNS 发现广播（`_openclaw-gw._tcp`）。

- `minimal`（默认）：从 TXT 记录中省略 `cliPath` + `sshPort`
- `full`：在 TXT 记录中包含 `cliPath` + `sshPort`
- `off`：完全禁用 mDNS 广播
- 主机名：默认为 `openclaw`（通告 `openclaw.local`）。通过 `OPENCLAW_MDNS_HOSTNAME` 覆盖。

```json5
{
  discovery: { mdns: { mode: "minimal" } },
}
```

### `discovery.wideArea`（广域 Bonjour / 单播 DNS‑SD）

启用后，Gateway 网关在 `~/.openclaw/dns/` 下使用配置的发现域（示例：`openclaw.internal.`）为 `_openclaw-gw._tcp` 写入单播 DNS-SD 区域。

要使 iOS/Android 跨网络发现（跨地域访问），请配合以下使用：

- 在 Gateway 网关主机上运行 DNS 服务器，为你选择的域名提供服务（推荐 CoreDNS）
- Tailscale **split DNS**，使客户端通过 Gateway 网关 DNS 服务器解析该域名

一次性设置助手（Gateway 网关主机）：

```bash
openclaw dns setup --apply
```

```json5
{
  discovery: { wideArea: { enabled: true } },
}
```

## 模板变量

模板占位符在 `tools.media.*.models[].args` 和 `tools.media.models[].args`（以及未来任何模板化参数字段）中展开。

| 变量               | 描述                                                  |
| ------------------ | ----------------------------------------------------- | -------- | ------- | ---------- | ----- | ------ | -------- | ------- | ------- | --- |
| `{{Body}}`         | 完整的入站消息正文                                    |
| `{{RawBody}}`      | 原始入站消息正文（无历史/发送者包装；最适合命令解析） |
| `{{BodyStripped}}` | 去除群组提及的正文（最适合智能体的默认值）            |
| `{{From}}`         | 发送者标识符（WhatsApp 为 E.164；按渠道可能不同）     |
| `{{To}}`           | 目标标识符                                            |
| `{{MessageSid}}`   | 渠道消息 id（如果可用）                               |
| `{{SessionId}}`    | 当前会话 UUID                                         |
| `{{IsNewSession}}` | 创建新会话时为 `"true"`                               |
| `{{MediaUrl}}`     | 入站媒体伪 URL（如果存在）                            |
| `{{MediaPath}}`    | 本地媒体路径（如果已下载）                            |
| `{{MediaType}}`    | 媒体类型（image/audio/document/…）                    |
| `{{Transcript}}`   | 音频转录（启用时）                                    |
| `{{Prompt}}`       | CLI 条目的已解析媒体提示                              |
| `{{MaxChars}}`     | CLI 条目的已解析最大输出字符数                        |
| `{{ChatType}}`     | `"direct"` 或 `"group"`                               |
| `{{GroupSubject}}` | 群组主题（尽力而为）                                  |
| `{{GroupMembers}}` | 群组成员预览（尽力而为）                              |
| `{{SenderName}}`   | 发送者显示名称（尽力而为）                            |
| `{{SenderE164}}`   | 发送者电话号码（尽力而为）                            |
| `{{Provider}}`     | 提供商提示（whatsapp                                  | telegram | discord | googlechat | slack | signal | imessage | msteams | webchat | …） |

## Cron（Gateway 网关调度器）

Cron 是 Gateway 网关自有的唤醒和定时任务调度器。参见 [Cron 任务](/automation/cron-jobs) 了解功能概述和 CLI 示例。

```json5
{
  cron: {
    enabled: true,
    maxConcurrentRuns: 2,
  },
}
```

---

_下一步：[智能体运行时](/concepts/agent)_ 🦞
