---
read_when:
  - 你想连接一个飞书/Lark 机器人
  - 你正在配置飞书渠道
summary: 飞书机器人概览、功能和配置
title: 飞书
x-i18n:
  generated_at: "2026-03-16T06:21:11Z"
  model: gpt-5.4
  provider: openai
  source_hash: 951e78c5c7264471382f863fa896a15ddeaf0717ef782da20d0f1b3eb23396ba
  source_path: channels/feishu.md
  workflow: 15
---

# 飞书机器人

飞书（Lark）是企业用于消息沟通与协作的团队聊天平台。此插件通过平台的 WebSocket 事件订阅将 OpenClaw 连接到飞书/Lark 机器人，因此无需暴露公共 webhook URL 即可接收消息。

---

## 捆绑插件

飞书随当前的 OpenClaw 版本一同捆绑提供，因此无需单独安装插件。

如果你使用的是较旧版本，或使用了不包含捆绑飞书的自定义安装，请手动安装：

```bash
openclaw plugins install @openclaw/feishu
```

---

## 快速开始

有两种方式可添加飞书渠道：

### 方法 1：设置向导（推荐）

如果你刚安装 OpenClaw，请运行设置向导：

```bash
openclaw onboard
```

向导会引导你完成以下步骤：

1. 创建飞书应用并收集凭证
2. 在 OpenClaw 中配置应用凭证
3. 启动 Gateway 网关

✅ **配置完成后**，检查 Gateway 网关状态：

- `openclaw gateway status`
- `openclaw logs --follow`

### 方法 2：CLI 设置

如果你已经完成初始安装，可通过 CLI 添加该渠道：

```bash
openclaw channels add
```

选择 **Feishu**，然后输入 App ID 和 App Secret。

✅ **配置完成后**，管理 Gateway 网关：

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## 第 1 步：创建飞书应用

### 1. 打开飞书开放平台

访问 [Feishu Open Platform](https://open.feishu.cn/app) 并登录。

Lark（国际版）租户应使用 [https://open.larksuite.com/app](https://open.larksuite.com/app)，并在飞书配置中设置 `domain: "lark"`。

### 2. 创建应用

1. 点击 **Create enterprise app**
2. 填写应用名称和描述
3. 选择应用图标

![Create enterprise app](../images/feishu-step2-create-app.png)

### 3. 复制凭证

在 **Credentials & Basic Info** 中，复制：

- **App ID**（格式：`cli_xxx`）
- **App Secret**

❗ **重要：**请将 App Secret 妥善保密。

![Get credentials](../images/feishu-step3-credentials.png)

### 4. 配置权限

在 **Permissions** 中，点击 **Batch import** 并粘贴：

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
      "cardkit:card:read",
      "cardkit:card:write",
      "contact:user.employee_id:readonly",
      "corehr:file:download",
      "event:ip_list",
      "im:chat.access_event.bot_p2p_chat:read",
      "im:chat.members:bot_access",
      "im:message",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:resource"
    ],
    "user": ["aily:file:read", "aily:file:write", "im:chat.access_event.bot_p2p_chat:read"]
  }
}
```

![Configure permissions](../images/feishu-step4-permissions.png)

### 5. 启用机器人能力

在 **App Capability** > **Bot** 中：

1. 启用机器人能力
2. 设置机器人名称

![Enable bot capability](../images/feishu-step5-bot-capability.png)

### 6. 配置事件订阅

⚠️ **重要：**在设置事件订阅前，请确保：

1. 你已经为飞书运行过 `openclaw channels add`
2. Gateway 网关正在运行（`openclaw gateway status`）

在 **Event Subscription** 中：

1. 选择 **Use long connection to receive events**（WebSocket）
2. 添加事件：`im.message.receive_v1`

⚠️ 如果 Gateway 网关未运行，长连接设置可能无法保存。

![Configure event subscription](../images/feishu-step6-event-subscription.png)

### 7. 发布应用

1. 在 **Version Management & Release** 中创建版本
2. 提交审核并发布
3. 等待管理员批准（企业应用通常会自动批准）

---

## 第 2 步：配置 OpenClaw

### 使用向导配置（推荐）

```bash
openclaw channels add
```

选择 **Feishu**，然后粘贴你的 App ID 和 App Secret。

### 通过配置文件进行配置

编辑 `~/.openclaw/openclaw.json`：

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        default: {
          appId: "cli_xxx",
          appSecret: "xxx",
          name: "My AI assistant",
        },
      },
    },
  },
}
```

如果你使用 `connectionMode: "webhook"`，请同时设置 `verificationToken` 和 `encryptKey`。飞书 webhook 服务器默认绑定到 `127.0.0.1`；只有在你明确需要不同绑定地址时，才设置 `webhookHost`。

#### Verification Token 和 Encrypt Key（webhook 模式）

使用 webhook 模式时，请在配置中同时设置 `channels.feishu.verificationToken` 和 `channels.feishu.encryptKey`。获取这些值的方法如下：

1. 在飞书开放平台中，打开你的应用
2. 前往 **Development** → **Events & Callbacks**（开发配置 → 事件与回调）
3. 打开 **Encryption** 标签页（加密策略）
4. 复制 **Verification Token** 和 **Encrypt Key**

下图展示了 **Verification Token** 的位置。**Encrypt Key** 位于同一个 **Encryption** 区域中。

![Verification Token location](../images/feishu-verification-token.png)

### 通过环境变量配置

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark（国际版）域名

如果你的租户位于 Lark（国际版），请将域名设置为 `lark`（或完整域名字串）。你可以在 `channels.feishu.domain` 设置，也可以按账户设置（`channels.feishu.accounts.<id>.domain`）。

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        default: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

### 配额优化标志

你可以使用两个可选标志来减少飞书 API 使用量：

- `typingIndicator`（默认 `true`）：设为 `false` 时，跳过“正在输入”反应调用。
- `resolveSenderNames`（默认 `true`）：设为 `false` 时，跳过发送者资料查询调用。

你可以在顶层或按账户进行设置：

```json5
{
  channels: {
    feishu: {
      typingIndicator: false,
      resolveSenderNames: false,
      accounts: {
        default: {
          appId: "cli_xxx",
          appSecret: "xxx",
          typingIndicator: true,
          resolveSenderNames: false,
        },
      },
    },
  },
}
```

---

## 第 3 步：启动并测试

### 1. 启动 Gateway 网关

```bash
openclaw gateway
```

### 2. 发送测试消息

在飞书中找到你的机器人并发送一条消息。

### 3. 批准配对

默认情况下，机器人会回复一个配对码。批准它：

```bash
openclaw pairing approve feishu <CODE>
```

批准后，你就可以正常聊天了。

---

## 概览

- **飞书机器人渠道**：由 Gateway 网关管理的飞书机器人
- **确定性路由**：回复始终返回到飞书
- **会话隔离**：私信共享主会话；群组彼此隔离
- **WebSocket 连接**：通过飞书 SDK 建立长连接，无需公共 URL

---

## 访问控制

### 私信

- **默认**：`dmPolicy: "pairing"`（未知用户会收到配对码）
- **批准配对**：

  ```bash
  openclaw pairing list feishu
  openclaw pairing approve feishu <CODE>
  ```

- **Allowlist 模式**：设置 `channels.feishu.allowFrom`，填入允许的 Open ID

### 群聊

**1. 群组策略**（`channels.feishu.groupPolicy`）：

- `"open"` = 允许群组中的所有人（默认）
- `"allowlist"` = 仅允许 `groupAllowFrom`
- `"disabled"` = 禁用群消息

**2. 提及要求**（`channels.feishu.groups.<chat_id>.requireMention`）：

- `true` = 需要 @ 提及（默认）
- `false` = 无需提及也会回复

---

## 群组配置示例

### 允许所有群组，要求 @ 提及（默认）

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // Default requireMention: true
    },
  },
}
```

### 允许所有群组，无需 @ 提及

```json5
{
  channels: {
    feishu: {
      groups: {
        oc_xxx: { requireMention: false },
      },
    },
  },
}
```

### 仅允许特定群组

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      // Feishu group IDs (chat_id) look like: oc_xxx
      groupAllowFrom: ["oc_xxx", "oc_yyy"],
    },
  },
}
```

### 限制哪些发送者可以在群组中发消息（发送者 allowlist）

除了允许群组本身外，该群组中的**所有消息**还会按发送者 `open_id` 进行限制：只有列在 `groups.<chat_id>.allowFrom` 中的用户，其消息才会被处理；其他成员发送的消息会被忽略（这是完整的发送者级限制，而不只是对 `/reset` 或 `/new` 等控制命令生效）。

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["oc_xxx"],
      groups: {
        oc_xxx: {
          // Feishu user IDs (open_id) look like: ou_xxx
          allowFrom: ["ou_user1", "ou_user2"],
        },
      },
    },
  },
}
```

---

## 获取群组/用户 ID

### 群组 ID（`chat_id`）

群组 ID 看起来像 `oc_xxx`。

**方法 1（推荐）**

1. 启动 Gateway 网关并在群里 @ 提及机器人
2. 运行 `openclaw logs --follow` 并查找 `chat_id`

**方法 2**

使用飞书 API 调试器列出群聊。

### 用户 ID（`open_id`）

用户 ID 看起来像 `ou_xxx`。

**方法 1（推荐）**

1. 启动 Gateway 网关并向机器人发送私信
2. 运行 `openclaw logs --follow` 并查找 `open_id`

**方法 2**

检查配对请求中的用户 Open ID：

```bash
openclaw pairing list feishu
```

---

## 常用命令

| Command   | Description    |
| --------- | -------------- |
| `/status` | 显示机器人状态 |
| `/reset`  | 重置会话       |
| `/model`  | 显示/切换模型  |

> 注意：飞书暂不支持原生命令菜单，因此命令必须以文本形式发送。

## Gateway 网关管理命令

| Command                    | Description                |
| -------------------------- | -------------------------- |
| `openclaw gateway status`  | 显示 Gateway 网关状态      |
| `openclaw gateway install` | 安装/启动 Gateway 网关服务 |
| `openclaw gateway stop`    | 停止 Gateway 网关服务      |
| `openclaw gateway restart` | 重启 Gateway 网关服务      |
| `openclaw logs --follow`   | 跟踪 Gateway 网关日志      |

---

## 故障排除

### 机器人在群聊中没有响应

1. 确保机器人已加入群组
2. 确保你 @ 提及了机器人（默认行为）
3. 检查 `groupPolicy` 未设置为 `"disabled"`
4. 检查日志：`openclaw logs --follow`

### 机器人未接收到消息

1. 确保应用已发布并获批准
2. 确保事件订阅包含 `im.message.receive_v1`
3. 确保已启用**长连接**
4. 确保应用权限完整
5. 确保 Gateway 网关正在运行：`openclaw gateway status`
6. 检查日志：`openclaw logs --follow`

### App Secret 泄露

1. 在飞书开放平台中重置 App Secret
2. 在你的配置中更新 App Secret
3. 重启 Gateway 网关

### 消息发送失败

1. 确保应用具有 `im:message:send_as_bot` 权限
2. 确保应用已发布
3. 查看日志以获取详细错误信息

---

## 高级配置

### 多账户

```json5
{
  channels: {
    feishu: {
      defaultAccount: "main",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          name: "Primary bot",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          name: "Backup bot",
          enabled: false,
        },
      },
    },
  },
}
```

`defaultAccount` 用于控制当出站 API 未显式指定 `accountId` 时，使用哪个飞书账户。

### 消息限制

- `textChunkLimit`：出站文本分块大小（默认：2000 个字符）
- `mediaMaxMb`：媒体上传/下载限制（默认：30 MB）

### 流式传输

飞书通过交互式卡片支持流式回复。启用后，机器人会在生成文本时更新卡片。

```json5
{
  channels: {
    feishu: {
      streaming: true, // 启用流式卡片输出（默认 true）
      blockStreaming: true, // 启用分块流式传输（默认 true）
    },
  },
}
```

将 `streaming: false` 设为等待完整回复生成后再发送。

### ACP 会话

飞书支持以下 ACP 场景：

- 私信
- 群组话题会话

飞书 ACP 由文本命令驱动。没有原生斜杠命令菜单，因此请直接在会话中使用 `/acp ...` 消息。

#### 持久化 ACP 绑定

使用顶层类型化 ACP 绑定，将飞书私信或话题会话固定到持久化 ACP 会话。

```json5
{
  agents: {
    list: [
      {
        id: "codex",
        runtime: {
          type: "acp",
          acp: {
            agent: "codex",
            backend: "acpx",
            mode: "persistent",
            cwd: "/workspace/openclaw",
          },
        },
      },
    ],
  },
  bindings: [
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "feishu",
        accountId: "default",
        peer: { kind: "direct", id: "ou_1234567890" },
      },
    },
    {
      type: "acp",
      agentId: "codex",
      match: {
        channel: "feishu",
        accountId: "default",
        peer: { kind: "group", id: "oc_group_chat:topic:om_topic_root" },
      },
      acp: { label: "codex-feishu-topic" },
    },
  ],
}
```

#### 从聊天中按线程绑定 ACP 生成

在飞书私信或话题会话中，你可以就地生成并绑定一个 ACP 会话：

```text
/acp spawn codex --thread here
```

说明：

- `--thread here` 适用于私信和飞书话题。
- 绑定后的私信/话题中的后续消息会直接路由到该 ACP 会话。
- v1 不支持针对通用的非话题群聊。

### 多智能体路由

使用 `bindings` 将飞书私信或群组路由到不同的智能体。

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "clawd-fan",
        workspace: "/home/user/clawd-fan",
        agentDir: "/home/user/.openclaw/agents/clawd-fan/agent",
      },
      {
        id: "clawd-xi",
        workspace: "/home/user/clawd-xi",
        agentDir: "/home/user/.openclaw/agents/clawd-xi/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "direct", id: "ou_xxx" },
      },
    },
    {
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "direct", id: "ou_yyy" },
      },
    },
    {
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

路由字段：

- `match.channel`：`"feishu"`
- `match.peer.kind`：`"direct"` 或 `"group"`
- `match.peer.id`：用户 Open ID（`ou_xxx`）或群组 ID（`oc_xxx`）

查找提示请参见 [获取群组/用户 ID](#get-groupuser-ids)。

---

## 配置参考

完整配置：[Gateway 网关配置](/gateway/configuration)

关键选项：

| Setting                                           | Description                      | Default          |
| ------------------------------------------------- | -------------------------------- | ---------------- |
| `channels.feishu.enabled`                         | 启用/禁用渠道                    | `true`           |
| `channels.feishu.domain`                          | API 域名（`feishu` 或 `lark`）   | `feishu`         |
| `channels.feishu.connectionMode`                  | 事件传输模式                     | `websocket`      |
| `channels.feishu.defaultAccount`                  | 出站路由的默认账户 ID            | `default`        |
| `channels.feishu.verificationToken`               | webhook 模式必填                 | -                |
| `channels.feishu.encryptKey`                      | webhook 模式必填                 | -                |
| `channels.feishu.webhookPath`                     | webhook 路由路径                 | `/feishu/events` |
| `channels.feishu.webhookHost`                     | webhook 绑定主机                 | `127.0.0.1`      |
| `channels.feishu.webhookPort`                     | webhook 绑定端口                 | `3000`           |
| `channels.feishu.accounts.<id>.appId`             | App ID                           | -                |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                       | -                |
| `channels.feishu.accounts.<id>.domain`            | 按账户覆盖 API 域名              | `feishu`         |
| `channels.feishu.dmPolicy`                        | 私信策略                         | `pairing`        |
| `channels.feishu.allowFrom`                       | 私信 allowlist（`open_id` 列表） | -                |
| `channels.feishu.groupPolicy`                     | 群组策略                         | `open`           |
| `channels.feishu.groupAllowFrom`                  | 群组 allowlist                   | -                |
| `channels.feishu.groups.<chat_id>.requireMention` | 要求 @ 提及                      | `true`           |
| `channels.feishu.groups.<chat_id>.enabled`        | 启用群组                         | `true`           |
| `channels.feishu.textChunkLimit`                  | 消息分块大小                     | `2000`           |
| `channels.feishu.mediaMaxMb`                      | 媒体大小限制                     | `30`             |
| `channels.feishu.streaming`                       | 启用流式卡片输出                 | `true`           |
| `channels.feishu.blockStreaming`                  | 启用分块流式传输                 | `true`           |

---

## dmPolicy 参考

| Value         | Behavior                                             |
| ------------- | ---------------------------------------------------- |
| `"pairing"`   | **默认。**未知用户会收到配对码；必须获批准后才能使用 |
| `"allowlist"` | 只有 `allowFrom` 中的用户可以聊天                    |
| `"open"`      | 允许所有用户（要求 `allowFrom` 中有 `"*"`）          |
| `"disabled"`  | 禁用私信                                             |

---

## 支持的消息类型

### 接收

- ✅ 文本
- ✅ 富文本（post）
- ✅ 图片
- ✅ 文件
- ✅ 音频
- ✅ 视频
- ✅ 贴纸

### 发送

- ✅ 文本
- ✅ 图片
- ✅ 文件
- ✅ 音频
- ⚠️ 富文本（部分支持）
