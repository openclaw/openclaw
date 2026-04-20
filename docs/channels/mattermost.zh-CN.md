---
summary: "Mattermost 机器人设置和 OpenClaw 配置"
read_when:
  - 设置 Mattermost
  - 调试 Mattermost 路由
title: "Mattermost"
---

# Mattermost

状态：捆绑插件（机器人令牌 + WebSocket 事件）。支持频道、群组和私信。
Mattermost 是一个可自托管的团队消息平台；有关产品详情和下载，请访问官方网站
[mattermost.com](https://mattermost.com)。

## 捆绑插件

Mattermost 在当前的 OpenClaw 版本中作为捆绑插件提供，因此正常的打包构建不需要单独安装。

如果您使用的是较旧的构建或不包含 Mattermost 的自定义安装，请手动安装：

通过 CLI 安装（npm 注册表）：

```bash
openclaw plugins install @openclaw/mattermost
```

本地检出（从 git 仓库运行时）：

```bash
openclaw plugins install ./path/to/local/mattermost-plugin
```

详细信息：[插件](/tools/plugin)

## 快速设置

1. 确保 Mattermost 插件可用。
   - 当前打包的 OpenClaw 版本已经内置了它。
   - 较旧/自定义安装可以使用上述命令手动添加。
2. 创建一个 Mattermost 机器人账户并复制**机器人令牌**。
3. 复制 Mattermost **基础 URL**（例如，`https://chat.example.com`）。
4. 配置 OpenClaw 并启动网关。

最小配置：

```json5
{
  channels: {
    mattermost: {
      enabled: true,
      botToken: "mm-token",
      baseUrl: "https://chat.example.com",
      dmPolicy: "pairing",
    },
  },
}
```

## 原生斜杠命令

原生斜杠命令是可选的。启用后，OpenClaw 通过 Mattermost API 注册 `oc_*` 斜杠命令，并在网关 HTTP 服务器上接收回调 POST。

```json5
{
  channels: {
    mattermost: {
      commands: {
        native: true,
        nativeSkills: true,
        callbackPath: "/api/channels/mattermost/command",
        // 当 Mattermost 无法直接访问网关时使用（反向代理/公共 URL）。
        callbackUrl: "https://gateway.example.com/api/channels/mattermost/command",
      },
    },
  },
}
```

注意：

- `native: "auto"` 对于 Mattermost 默认禁用。设置 `native: true` 以启用。
- 如果省略 `callbackUrl`，OpenClaw 会从网关主机/端口 + `callbackPath` 派生一个。
- 对于多账户设置，`commands` 可以设置在顶层或 `channels.mattermost.accounts.<id>.commands` 下（账户值覆盖顶层字段）。
- 命令回调通过 OpenClaw 注册 `oc_*` 命令时 Mattermost 返回的每个命令令牌进行验证。
- 当注册失败、启动部分完成或回调令牌与任何注册的命令不匹配时，斜杠回调会失败关闭。
- 可达性要求：回调端点必须可从 Mattermost 服务器访问。
  - 不要将 `callbackUrl` 设置为 `localhost`，除非 Mattermost 与 OpenClaw 在同一主机/网络命名空间中运行。
  - 不要将 `callbackUrl` 设置为您的 Mattermost 基础 URL，除非该 URL 将 `/api/channels/mattermost/command` 反向代理到 OpenClaw。
  - 快速检查是 `curl https://<gateway-host>/api/channels/mattermost/command`；GET 应该从 OpenClaw 返回 `405 Method Not Allowed`，而不是 `404`。
- Mattermost 出站白名单要求：
  - 如果您的回调目标是私有/tailnet/内部地址，请将 Mattermost
    `ServiceSettings.AllowedUntrustedInternalConnections` 设置为包含回调主机/域。
  - 使用主机/域条目，而不是完整 URL。
    - 正确：`gateway.tailnet-name.ts.net`
    - 错误：`https://gateway.tailnet-name.ts.net`

## 环境变量（默认账户）

如果您更喜欢环境变量，请在网关主机上设置这些：

- `MATTERMOST_BOT_TOKEN=...`
- `MATTERMOST_URL=https://chat.example.com`

环境变量仅适用于**默认**账户（`default`）。其他账户必须使用配置值。

## 聊天模式

Mattermost 自动响应私信。频道行为由 `chatmode` 控制：

- `oncall`（默认）：仅在频道中被 @ 提及时响应。
- `onmessage`：响应每条频道消息。
- `onchar`：当消息以触发前缀开始时响应。

配置示例：

```json5
{
  channels: {
    mattermost: {
      chatmode: "onchar",
      oncharPrefixes: [">", "!"],
    },
  },
}
```

注意：

- `onchar` 仍然响应显式的 @ 提及。
- `channels.mattermost.requireMention` 对于旧配置仍然有效，但 `chatmode` 是首选。

## 线程和会话

使用 `channels.mattermost.replyToMode` 控制频道和群组回复是留在主频道中还是在触发帖子下开始线程。

- `off`（默认）：仅当入站帖子已经在线程中时才在线程中回复。
- `first`：对于顶级频道/群组帖子，在该帖子下开始线程并将对话路由到线程范围的会话。
- `all`：目前对 Mattermost 与 `first` 行为相同。
- 私信忽略此设置并保持非线程化。

配置示例：

```json5
{
  channels: {
    mattermost: {
      replyToMode: "all",
    },
  },
}
```

注意：

- 线程范围的会话使用触发帖子 ID 作为线程根。
- `first` 和 `all` 当前是等效的，因为一旦 Mattermost 有线程根，后续的块和媒体会在同一个线程中继续。

## 访问控制（私信）

- 默认：`channels.mattermost.dmPolicy = "pairing"`（未知发送者获得配对代码）。
- 通过以下方式批准：
  - `openclaw pairing list mattermost`
  - `openclaw pairing approve mattermost <CODE>`
- 公共私信：`channels.mattermost.dmPolicy="open"` 加上 `channels.mattermost.allowFrom=["*"]`。

## 频道（群组）

- 默认：`channels.mattermost.groupPolicy = "allowlist"`（提及门控）。
- 使用 `channels.mattermost.groupAllowFrom` 白名单发送者（推荐使用用户 ID）。
- 每频道提及覆盖位于 `channels.mattermost.groups.<channelId>.requireMention`
  或 `channels.mattermost.groups["*"].requireMention` 作为默认值。
- `@username` 匹配是可变的，仅当 `channels.mattermost.dangerouslyAllowNameMatching: true` 时启用。
- 开放频道：`channels.mattermost.groupPolicy="open"`（提及门控）。
- 运行时注意：如果 `channels.mattermost` 完全缺失，运行时会回退到 `groupPolicy="allowlist"` 进行群组检查（即使设置了 `channels.defaults.groupPolicy`）。

示例：

```json5
{
  channels: {
    mattermost: {
      groupPolicy: "open",
      groups: {
        "*": { requireMention: true },
        "team-channel-id": { requireMention: false },
      },
    },
  },
}
```

## 出站传递目标

使用这些目标格式与 `openclaw message send` 或 cron/webhooks 一起使用：

- `channel:<id>` 用于频道
- `user:<id>` 用于私信
- `@username` 用于私信（通过 Mattermost API 解析）

裸不透明 ID（如 `64ifufp...`）在 Mattermost 中是**歧义的**（用户 ID 与频道 ID）。

OpenClaw **优先用户**解析它们：

- 如果 ID 作为用户存在（`GET /api/v4/users/<id>` 成功），OpenClaw 通过 `/api/v4/channels/direct` 解析直接频道来发送**私信**。
- 否则，ID 被视为**频道 ID**。

如果您需要确定性行为，请始终使用显式前缀（`user:<id>` / `channel:<id>`）。

## 私信频道重试

当 OpenClaw 发送到 Mattermost 私信目标并需要首先解析直接频道时，默认情况下它会重试临时的直接频道创建失败。

使用 `channels.mattermost.dmChannelRetry` 为 Mattermost 插件全局调整该行为，或使用 `channels.mattermost.accounts.<id>.dmChannelRetry` 为一个账户调整。

```json5
{
  channels: {
    mattermost: {
      dmChannelRetry: {
        maxRetries: 3,
        initialDelayMs: 1000,
        maxDelayMs: 10000,
        timeoutMs: 30000,
      },
    },
  },
}
```

注意：

- 这仅适用于私信频道创建（`/api/v4/channels/direct`），而不是每个 Mattermost API 调用。
- 重试适用于临时失败，如速率限制、5xx 响应以及网络或超时错误。
- 除 `429` 之外的 4xx 客户端错误被视为永久错误，不会重试。

## 反应（消息工具）

- 使用 `message action=react` 和 `channel=mattermost`。
- `messageId` 是 Mattermost 帖子 ID。
- `emoji` 接受像 `thumbsup` 或 `:+1:` 这样的名称（冒号是可选的）。
- 设置 `remove=true`（布尔值）以删除反应。
- 反应添加/删除事件作为系统事件转发到路由的代理会话。

示例：

```
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup
message action=react channel=mattermost target=channel:<channelId> messageId=<postId> emoji=thumbsup remove=true
```

配置：

- `channels.mattermost.actions.reactions`：启用/禁用反应操作（默认 true）。
- 每账户覆盖：`channels.mattermost.accounts.<id>.actions.reactions`。

## 交互式按钮（消息工具）

发送带有可点击按钮的消息。当用户点击按钮时，代理接收选择并可以响应。

通过向频道功能添加 `inlineButtons` 来启用按钮：

```json5
{
  channels: {
    mattermost: {
      capabilities: ["inlineButtons"],
    },
  },
}
```

使用带有 `buttons` 参数的 `message action=send`。按钮是二维数组（按钮行）：

```
message action=send channel=mattermost target=channel:<channelId> buttons=[[["text":"Yes","callback_data":"yes"],["text":"No","callback_data":"no"]]]
```

按钮字段：

- `text`（必需）：显示标签。
- `callback_data`（必需）：点击时发送回的值（用作动作 ID）。
- `style`（可选）：`"default"`、`"primary"` 或 `"danger"`。

当用户点击按钮时：

1. 所有按钮都替换为确认行（例如，"✓ **Yes** selected by @user"）。
2. 代理将选择作为入站消息接收并响应。

注意：

- 按钮回调使用 HMAC-SHA256 验证（自动，无需配置）。
- Mattermost 从其 API 响应中删除回调数据（安全功能），因此点击时所有按钮都会被删除 — 部分删除是不可能的。
- 包含连字符或下划线的动作 ID 会自动清理
  （Mattermost 路由限制）。

配置：

- `channels.mattermost.capabilities`：功能字符串数组。添加 `"inlineButtons"` 以在代理系统提示中启用按钮工具描述。
- `channels.mattermost.interactions.callbackBaseUrl`：按钮回调的可选外部基础 URL
  （例如 `https://gateway.example.com`）。当 Mattermost 无法直接在其绑定主机访问网关时使用。
- 在多账户设置中，您也可以在
  `channels.mattermost.accounts.<id>.interactions.callbackBaseUrl` 下设置相同的字段。
- 如果省略 `interactions.callbackBaseUrl`，OpenClaw 会从
  `gateway.customBindHost` + `gateway.port` 派生回调 URL，然后回退到 `http://localhost:<port>`。
- 可达性规则：按钮回调 URL 必须可从 Mattermost 服务器访问。
  `localhost` 仅在 Mattermost 和 OpenClaw 在同一主机/网络命名空间中运行时有效。
- 如果您的回调目标是私有/tailnet/内部的，请将其主机/域添加到 Mattermost
  `ServiceSettings.AllowedUntrustedInternalConnections`。

### 直接 API 集成（外部脚本）

外部脚本和 webhook 可以通过 Mattermost REST API 直接发布按钮，而不是通过代理的 `message` 工具。尽可能使用扩展中的 `buildButtonAttachments()`；如果发布原始 JSON，请遵循以下规则：

**负载结构：**

```json5
{
  channel_id: "<channelId>",
  message: "Choose an option:",
  props: {
    attachments: [
      {
        actions: [
          {
            id: "mybutton01", // 仅字母数字 — 见下文
            type: "button", // 必需，否则点击会被静默忽略
            name: "Approve", // 显示标签
            style: "primary", // 可选："default", "primary", "danger"
            integration: {
              url: "https://gateway.example.com/mattermost/interactions/default",
              context: {
                action_id: "mybutton01", // 必须匹配按钮 id（用于名称查找）
                action: "approve",
                // ... 任何自定义字段 ...
                _token: "<hmac>", // 见下文 HMAC 部分
              },
            },
          },
        ],
      },
    ],
  },
}
```

**关键规则：**

1. 附件进入 `props.attachments`，而不是顶级 `attachments`（静默忽略）。
2. 每个动作都需要 `type: "button"` — 没有它，点击会被静默吞掉。
3. 每个动作都需要 `id` 字段 — Mattermost 忽略没有 ID 的动作。
4. 动作 `id` 必须**仅为字母数字**（`[a-zA-Z0-9]`）。连字符和下划线会破坏
   Mattermost 的服务器端动作路由（返回 404）。使用前删除它们。
5. `context.action_id` 必须匹配按钮的 `id`，以便确认消息显示按钮名称
   （例如，"Approve"）而不是原始 ID。
6. `context.action_id` 是必需的 — 交互处理程序没有它会返回 400。

**HMAC 令牌生成：**

网关使用 HMAC-SHA256 验证按钮点击。外部脚本必须生成与网关验证逻辑匹配的令牌：

1. 从机器人令牌派生密钥：
   `HMAC-SHA256(key="openclaw-mattermost-interactions", data=botToken)`
2. 构建除 `_token` 之外的所有字段的上下文对象。
3. 使用**排序键**和**无空格**序列化（网关使用 `JSON.stringify`
   带排序键，产生紧凑输出）。
4. 签名：`HMAC-SHA256(key=secret, data=serializedContext)`
5. 将生成的十六进制摘要添加为上下文中的 `_token`。

Python 示例：

```python
import hmac, hashlib, json

secret = hmac.new(
    b"openclaw-mattermost-interactions",
    bot_token.encode(), hashlib.sha256
).hexdigest()

ctx = {"action_id": "mybutton01", "action": "approve"}
payload = json.dumps(ctx, sort_keys=True, separators=(",", ":"))
token = hmac.new(secret.encode(), payload.encode(), hashlib.sha256).hexdigest()

context = {**ctx, "_token": token}
```

常见 HMAC 陷阱：

- Python 的 `json.dumps` 默认添加空格（`{"key": "val"}`）。使用
  `separators=(",", ":")` 匹配 JavaScript 的紧凑输出（`{"key":"val"}`）。
- 始终签名**所有**上下文字段（减去 `_token`）。网关剥离 `_token` 然后
  签名所有剩余内容。签名子集会导致静默验证失败。
- 使用 `sort_keys=True` — 网关在签名前排序键，Mattermost 可能会
  在存储负载时重新排序上下文字段。
- 从机器人令牌派生密钥（确定性），而不是随机字节。密钥
  必须在创建按钮的过程和验证的网关之间相同。

## 目录适配器

Mattermost 插件包含一个目录适配器，通过 Mattermost API 解析频道和用户名。这在
`openclaw message send` 和 cron/webhook 传递中启用 `#channel-name` 和 `@username` 目标。

不需要配置 — 适配器使用账户配置中的机器人令牌。

## 多账户

Mattermost 在 `channels.mattermost.accounts` 下支持多个账户：

```json5
{
  channels: {
    mattermost: {
      accounts: {
        default: { name: "Primary", botToken: "mm-token", baseUrl: "https://chat.example.com" },
        alerts: { name: "Alerts", botToken: "mm-token-2", baseUrl: "https://alerts.example.com" },
      },
    },
  },
}
```

## 故障排除

- 频道中无回复：确保机器人在频道中并提及它（oncall），使用触发前缀（onchar），或设置 `chatmode: "onmessage"`。
- 认证错误：检查机器人令牌、基础 URL 以及账户是否启用。
- 多账户问题：环境变量仅适用于 `default` 账户。
- 原生斜杠命令返回 `Unauthorized: invalid command token.`：OpenClaw
  不接受回调令牌。典型原因：
  - 斜杠命令注册失败或在启动时仅部分完成
  - 回调击中了错误的网关/账户
  - Mattermost 仍然有指向之前回调目标的旧命令
  - 网关重启但未重新激活斜杠命令
- 如果原生斜杠命令停止工作，请检查日志中的
  `mattermost: failed to register slash commands` 或
  `mattermost: native slash commands enabled but no commands could be registered`。
- 如果省略 `callbackUrl` 且日志警告回调解析为
  `http://127.0.0.1:18789/...`，该 URL 可能仅在
  Mattermost 与 OpenClaw 在同一主机/网络命名空间中运行时才可访问。设置明确的外部可达 `commands.callbackUrl` 代替。
- 按钮显示为白色框：代理可能发送格式错误的按钮数据。检查每个按钮是否同时具有 `text` 和 `callback_data` 字段。
- 按钮渲染但点击无反应：验证 Mattermost 服务器配置中的 `AllowedUntrustedInternalConnections` 包含 `127.0.0.1 localhost`，且 `ServiceSettings` 中的 `EnablePostActionIntegration` 为 `true`。
- 按钮点击返回 404：按钮 `id` 可能包含连字符或下划线。Mattermost 的动作路由器在非字母数字 ID 上中断。仅使用 `[a-zA-Z0-9]`。
- 网关日志 `invalid _token`：HMAC 不匹配。检查您是否签名了所有上下文字段（不是子集），使用排序键，并使用紧凑 JSON（无空格）。见上文 HMAC 部分。
- 网关日志 `missing _token in context`：`_token` 字段不在按钮的上下文中。确保在构建集成负载时包含它。
- 确认显示原始 ID 而不是按钮名称：`context.action_id` 与按钮的 `id` 不匹配。将两者设置为相同的清理值。
- 代理不知道按钮：在 Mattermost 频道配置中添加 `capabilities: ["inlineButtons"]`。

## 相关

- [频道概述](/channels) — 所有支持的频道
- [配对](/channels/pairing) — 私信认证和配对流程
- [群组](/channels/groups) — 群组聊天行为和提及门控
- [频道路由](/channels/channel-routing) — 消息的会话路由
- [安全](/gateway/security) — 访问模型和强化