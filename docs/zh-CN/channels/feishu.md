---
summary: "飞书机器人支持状态、功能和配置"
read_when:
  - 您想要连接飞书机器人
  - 您正在配置飞书渠道
title: 飞书
---

# 飞书机器人

状态：生产就绪，支持机器人私聊和群组。使用 WebSocket 长连接模式接收消息。

---

## 内置插件

当前版本的 OpenClaw 已内置 Feishu 插件，因此通常不需要单独安装。

如果你使用的是较旧版本，或是没有内置 Feishu 的自定义安装，可手动安装：

```bash
openclaw plugins install @openclaw/feishu
```

---

## 快速开始

添加飞书渠道有两种方式：

### 方式一：通过安装向导添加（推荐）

如果您刚安装完 OpenClaw，可以直接运行向导，根据提示添加飞书：

```bash
openclaw onboard
```

向导会引导您完成：

1. 创建飞书应用并获取凭证
2. 配置应用凭证
3. 启动网关

✅ **完成配置后**，您可以使用以下命令检查网关状态：

- `openclaw gateway status` - 查看网关运行状态
- `openclaw logs --follow` - 查看实时日志

### 方式二：通过命令行添加

如果您已经完成了初始安装，可以用以下命令添加飞书渠道：

```bash
openclaw channels add
```

然后根据交互式提示选择 Feishu，输入 App ID 和 App Secret 即可。

✅ **完成配置后**，您可以使用以下命令管理网关：

- `openclaw gateway status` - 查看网关运行状态
- `openclaw gateway restart` - 重启网关以应用新配置
- `openclaw logs --follow` - 查看实时日志

---

## 第一步：创建飞书应用

### 1. 打开飞书开放平台

访问 [飞书开放平台](https://open.feishu.cn/app)，使用飞书账号登录。

Lark（国际版）请使用 https://open.larksuite.com/app，并在配置中设置 `domain: "lark"`。

### 2. 创建应用

1. 点击 **创建企业自建应用**
2. 填写应用名称和描述
3. 选择应用图标

![创建企业自建应用](/images/feishu-step2-create-app.png)

### 3. 获取应用凭证

在应用的 **凭证与基础信息** 页面，复制：

- **App ID**（格式如 `cli_xxx`）
- **App Secret**

❗ **重要**：请妥善保管 App Secret，不要分享给他人。

![获取应用凭证](/images/feishu-step3-credentials.png)

### 4. 配置应用权限

Lark 的权限界面这些年有过调整，官方示例里现在也经常会出现一大串 `user` scopes。OpenClaw 的 Feishu/Lark 渠道使用的是自建应用 + `App ID` + `App Secret` + `tenant_access_token`，因此正常的机器人收发消息**不需要** `offline_access`，也不需要那套通用的 user OAuth 权限。

在 **权限管理** 页面，点击 **批量导入** 按钮，先导入下面这组 tenant scopes：

```json
{
  "scopes": {
    "tenant": [
      "application:application:self_manage",
      "cardkit:card:read",
      "cardkit:card:write",
      "contact:user.base:readonly",
      "im:chat.members:read",
      "im:chat:read",
      "im:message.group_at_msg:readonly",
      "im:message.p2p_msg:readonly",
      "im:message:readonly",
      "im:message:send_as_bot",
      "im:message:update",
      "im:resource"
    ]
  }
}
```

说明：

- 一些 Lark 页面仍会出现较旧或不一致的权限名，例如 `im:chat` 或 `im:message.group_msg`。请以你的 Lark 控制台当前实际接受的权限名为准。
- 在应用配置里，联系人权限请以 `contact:user.base:readonly` 作为标准写法。你仍然可能在旧文档或错误信息里看到过时别名 `contact:contact.base:readonly`；OpenClaw 在构造权限修复链接时会把它重写成正确名称。
- 如果你启用了 OpenClaw 的可选 Feishu 工具，还需要额外补上对应 API 所需的 Lark 权限。常见的有文档（`docx:*`）、云盘文件（`drive:*`）、知识库（`wiki:*`）以及多维表格/应用（`base:*`）。

![配置应用权限](/images/feishu-step4-permissions.png)

### 5. 启用机器人能力

在 **应用能力** > **机器人** 页面：

1. 开启机器人能力
2. 配置机器人名称

![启用机器人能力](/images/feishu-step5-bot-capability.png)

### 6. 配置事件订阅

⚠️ **重要提醒**：在配置事件订阅前，请务必确保已完成以下步骤：

1. 运行 `openclaw channels add` 添加了 Feishu 渠道
2. 网关处于启动状态（可通过 `openclaw gateway status` 检查状态）

在 **事件订阅** 页面：

1. 选择 **使用长连接接收事件**（WebSocket 模式）
2. 添加事件：
   - `im.message.receive_v1`
   - `im.message.reaction.created_v1`
   - `im.message.reaction.deleted_v1`
   - `application.bot.menu_v6`

⚠️ **注意**：如果网关未启动或渠道未添加，长连接设置将保存失败。

![配置事件订阅](/images/feishu-step6-event-subscription.png)

### 7. 发布应用

1. 在 **版本管理与发布** 页面创建版本
2. 提交审核并发布
3. 等待管理员审批（企业自建应用通常自动通过）

---

## 第二步：配置 OpenClaw

### 通过向导配置（推荐）

运行以下命令，根据提示粘贴 App ID 和 App Secret：

```bash
openclaw channels add
```

选择 **Feishu**，然后输入您在第一步获取的凭证即可。

### 通过配置文件配置

编辑 `~/.openclaw/openclaw.json`：

```json5
{
  channels: {
    feishu: {
      enabled: true,
      dmPolicy: "pairing",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "我的AI助手",
        },
      },
    },
  },
}
```

若使用 `connectionMode: "webhook"`，需设置 `verificationToken`。飞书 Webhook 服务默认绑定 `127.0.0.1`；仅在需要不同监听地址时设置 `webhookHost`。

#### 获取 Verification Token（仅 Webhook 模式）

使用 Webhook 模式时，需在配置中设置 `channels.feishu.verificationToken`。获取方式：

1. 在飞书开放平台打开您的应用
2. 进入 **开发配置** → **事件与回调**
3. 打开 **加密策略** 选项卡
4. 复制 **Verification Token**（校验令牌）

![Verification Token 位置](/images/feishu-verification-token.png)

### 通过环境变量配置

```bash
export FEISHU_APP_ID="cli_xxx"
export FEISHU_APP_SECRET="xxx"
```

### Lark（国际版）域名

如果您的租户在 Lark（国际版），请设置域名为 `lark`（或完整域名），可配置 `channels.feishu.domain` 或 `channels.feishu.accounts.<id>.domain`：

```json5
{
  channels: {
    feishu: {
      domain: "lark",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
        },
      },
    },
  },
}
```

### 配额优化

可通过以下可选配置减少飞书 API 调用：

- `typingIndicator`（默认 `true`）：设为 `false` 时不发送“正在输入”状态。
- `resolveSenderNames`（默认 `true`）：设为 `false` 时不拉取发送者资料。

可在渠道级或账号级配置：

```json5
{
  channels: {
    feishu: {
      typingIndicator: false,
      resolveSenderNames: false,
      accounts: {
        main: {
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

## 第三步：启动并测试

### 1. 启动网关

```bash
openclaw gateway
```

### 2. 发送测试消息

在飞书中找到您创建的机器人，发送一条消息。

### 3. 配对授权

默认情况下，机器人会回复一个 **配对码**。您需要批准此代码：

```bash
openclaw pairing approve feishu <配对码>
```

批准后即可正常对话。

---

## 介绍

- **飞书机器人渠道**：由网关管理的飞书机器人
- **确定性路由**：回复始终返回飞书，模型不会选择渠道
- **会话隔离**：私聊共享主会话；群组独立隔离
- **WebSocket 连接**：使用飞书 SDK 的长连接模式，无需公网 URL

---

## 访问控制

### 私聊访问

- **默认**：`dmPolicy: "pairing"`，陌生用户会收到配对码
- **批准配对**：
  ```bash
  openclaw pairing list feishu      # 查看待审批列表
  openclaw pairing approve feishu <CODE>  # 批准
  ```
- **白名单模式**：通过 `channels.feishu.allowFrom` 配置允许的用户 Open ID

### 群组访问

**1. 群组策略**（`channels.feishu.groupPolicy`）：

- `"open"` = 允许群组中所有人（默认）
- `"allowlist"` = 仅允许 `groupAllowFrom` 中的群组
- `"disabled"` = 禁用群组消息

**2. @提及要求**（`channels.feishu.groups.<chat_id>.requireMention`）：

- `true` = 需要 @机器人才响应（默认）
- `false` = 无需 @也响应

---

## 群组配置示例

### 允许所有群组，需要 @提及（默认行为）

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      // 默认 requireMention: true
    },
  },
}
```

### 允许所有群组，无需 @提及

需要为特定群组配置：

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
      // 群组 ID 格式为 oc_xxx
      groupAllowFrom: ["oc_xxx", "oc_yyy"],
    },
  },
}
```

### 仅允许特定成员在群组中发信（发送者白名单）

除群组白名单外，该群组内**所有消息**均按发送者 open_id 校验：仅 `groups.<chat_id>.allowFrom` 中列出的用户消息会被处理，其他成员的消息会被忽略（此为发送者级白名单，不仅针对 /reset、/new 等控制命令）。

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["oc_xxx"],
      groups: {
        oc_xxx: {
          // 用户 open_id 格式为 ou_xxx
          allowFrom: ["ou_user1", "ou_user2"],
        },
      },
    },
  },
}
```

---

## 获取群组/用户 ID

### 获取群组 ID（chat_id）

群组 ID 格式为 `oc_xxx`，可以通过以下方式获取：

**方法一**（推荐）：

1. 启动网关并在群组中 @机器人发消息
2. 运行 `openclaw logs --follow` 查看日志中的 `chat_id`

**方法二**：
使用飞书 API 调试工具获取机器人所在群组列表。

### 获取用户 ID（open_id）

用户 ID 格式为 `ou_xxx`，可以通过以下方式获取：

**方法一**（推荐）：

1. 启动网关并给机器人发消息
2. 运行 `openclaw logs --follow` 查看日志中的 `open_id`

**方法二**：
查看配对请求列表，其中包含用户的 Open ID：

```bash
openclaw pairing list feishu
```

---

## 常用命令

| 命令      | 说明           |
| --------- | -------------- |
| `/status` | 查看机器人状态 |
| `/reset`  | 重置对话会话   |
| `/model`  | 查看/切换模型  |

飞书机器人菜单建议直接在飞书开放平台的机器人能力页面配置。OpenClaw 当前支持接收 `application.bot.menu_v6` 事件，并把点击事件转换成普通文本命令（例如 `/menu <eventKey>`）继续走现有消息路由，但不通过渠道配置自动创建或同步菜单。

## 网关管理命令

在配置和使用飞书渠道时，您可能需要使用以下网关管理命令：

| 命令                       | 说明              |
| -------------------------- | ----------------- |
| `openclaw gateway status`  | 查看网关运行状态  |
| `openclaw gateway install` | 安装/启动网关服务 |
| `openclaw gateway stop`    | 停止网关服务      |
| `openclaw gateway restart` | 重启网关服务      |
| `openclaw logs --follow`   | 实时查看日志输出  |

---

## 故障排除

### 机器人在群组中不响应

1. 检查机器人是否已添加到群组
2. 检查是否 @了机器人（默认需要 @提及）
3. 检查 `groupPolicy` 是否为 `"disabled"`
4. 查看日志：`openclaw logs --follow`

### 机器人收不到消息

1. 检查应用是否已发布并审批通过
2. 检查事件订阅是否配置正确（`im.message.receive_v1`）
3. 检查是否选择了 **长连接** 模式
4. 检查应用权限是否完整
5. 检查网关是否正在运行：`openclaw gateway status`
6. 查看实时日志：`openclaw logs --follow`

### App Secret 泄露怎么办

1. 在飞书开放平台重置 App Secret
2. 更新配置文件中的 App Secret
3. 重启网关

### 发送消息失败

1. 检查应用是否有 `im:message:send_as_bot` 权限
2. 检查应用是否已发布
3. 查看日志获取详细错误信息

---

## 高级配置

### 多账号配置

如果需要管理多个飞书机器人，可配置 `defaultAccount` 指定出站未显式指定 `accountId` 时使用的账号：

```json5
{
  channels: {
    feishu: {
      defaultAccount: "main",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          botName: "主机器人",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          botName: "备用机器人",
          enabled: false, // 暂时禁用
        },
      },
    },
  },
}
```

### 消息限制

- `textChunkLimit`：出站文本分块大小（默认 2000 字符）
- `mediaMaxMb`：媒体上传/下载限制（默认 30MB）

### 流式输出

飞书支持通过交互式卡片实现流式输出，机器人会实时更新卡片内容显示生成进度。默认配置：

```json5
{
  channels: {
    feishu: {
      streaming: true, // 启用流式卡片输出（默认 true）
      blockStreamingCoalesce: {
        enabled: true,
        minDelayMs: 50,
        maxDelayMs: 250,
      },
    },
  },
}
```

如需禁用流式输出（等待完整回复后一次性发送），可设置 `streaming: false`。

### 交互式卡片

OpenClaw 默认会在需要时发送 Markdown 卡片；如果你需要完整的 Feishu 原生交互式卡片，也可以显式发送原始 `card` payload。

- 默认路径：文本自动渲染或 Markdown 卡片
- 显式卡片：通过消息动作的 `card` 参数发送原始交互卡片
- 更新卡片：同一消息支持后续 patch/update

卡片按钮回调当前走文本回退路径：

- 若 `action.value.text` 存在，则作为入站文本继续处理
- 若 `action.value.command` 存在，则作为命令文本继续处理
- 其他对象值会序列化为 JSON 文本

这样可以保持与现有消息/命令路由兼容，而不要求下游先理解 Feishu 专有的交互 payload。

### 表情反应

飞书渠道现已完整支持表情反应生命周期：

- 接收 `reaction created`
- 接收 `reaction deleted`
- 主动添加反应
- 主动删除自身反应
- 查询消息上的反应列表

是否把入站反应转成内部消息，可通过 `reactionNotifications` 控制：

| 值    | 行为                         |
| ----- | ---------------------------- |
| `off` | 不生成反应通知               |
| `own` | 仅当反应发生在机器人消息上时 |
| `all` | 所有可验证的反应都生成通知   |

### 消息引用

在群聊中，机器人的回复可以引用用户发送的原始消息，让对话上下文更加清晰。

配置选项：

```json5
{
  channels: {
    feishu: {
      // 账户级别配置（默认 "all"）
      replyToMode: "all",
      groups: {
        oc_xxx: {
          // 特定群组可以覆盖
          replyToMode: "first",
        },
      },
    },
  },
}
```

`replyToMode` 值说明：

| 值        | 行为                               |
| --------- | ---------------------------------- |
| `"off"`   | 不引用原消息（私聊默认值）         |
| `"first"` | 仅在第一条回复时引用原消息         |
| `"all"`   | 所有回复都引用原消息（群聊默认值） |

> 注意：消息引用功能与流式卡片输出（`streaming: true`）不能同时使用。当启用流式输出时，回复会以卡片形式呈现，不会显示引用。

### 多 Agent 路由

通过 `bindings` 配置，您可以用一个飞书机器人对接多个不同功能或性格的 Agent。系统会根据用户 ID 或群组 ID 自动将对话分发到对应的 Agent。

配置示例：

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
      // 用户 A 的私聊 → main agent
      agentId: "main",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_28b31a88..." },
      },
    },
    {
      // 用户 B 的私聊 → clawd-fan agent
      agentId: "clawd-fan",
      match: {
        channel: "feishu",
        peer: { kind: "dm", id: "ou_0fe6b1c9..." },
      },
    },
    {
      // 某个群组 → clawd-xi agent
      agentId: "clawd-xi",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_xxx..." },
      },
    },
  ],
}
```

匹配规则说明：

| 字段              | 说明                                          |
| ----------------- | --------------------------------------------- |
| `agentId`         | 目标 Agent 的 ID，需要在 `agents.list` 中定义 |
| `match.channel`   | 渠道类型，这里固定为 `"feishu"`               |
| `match.peer.kind` | 对话类型：`"dm"`（私聊）或 `"group"`（群组）  |
| `match.peer.id`   | 用户 Open ID（`ou_xxx`）或群组 ID（`oc_xxx`） |

> 获取 ID 的方法：参见上文 [获取群组/用户 ID](#获取群组用户-id) 章节。

---

## 配置参考

完整配置请参考：[网关配置](/gateway/configuration)

主要选项：

| 配置项                                            | 说明                              | 默认值           |
| ------------------------------------------------- | --------------------------------- | ---------------- |
| `channels.feishu.enabled`                         | 启用/禁用渠道                     | `true`           |
| `channels.feishu.domain`                          | API 域名（`feishu` 或 `lark`）    | `feishu`         |
| `channels.feishu.connectionMode`                  | 事件传输模式（websocket/webhook） | `websocket`      |
| `channels.feishu.defaultAccount`                  | 出站路由默认账号 ID               | `default`        |
| `channels.feishu.verificationToken`               | Webhook 模式必填                  | -                |
| `channels.feishu.webhookPath`                     | Webhook 路由路径                  | `/feishu/events` |
| `channels.feishu.webhookHost`                     | Webhook 监听地址                  | `127.0.0.1`      |
| `channels.feishu.webhookPort`                     | Webhook 监听端口                  | `3000`           |
| `channels.feishu.accounts.<id>.appId`             | 应用 App ID                       | -                |
| `channels.feishu.accounts.<id>.appSecret`         | 应用 App Secret                   | -                |
| `channels.feishu.accounts.<id>.domain`            | 单账号 API 域名覆盖               | `feishu`         |
| `channels.feishu.dmPolicy`                        | 私聊策略                          | `pairing`        |
| `channels.feishu.allowFrom`                       | 私聊白名单（open_id 列表）        | -                |
| `channels.feishu.groupPolicy`                     | 群组策略                          | `allowlist`      |
| `channels.feishu.groupAllowFrom`                  | 群组白名单                        | -                |
| `channels.feishu.groups.<chat_id>.requireMention` | 是否需要 @提及                    | `true`           |
| `channels.feishu.groups.<chat_id>.enabled`        | 是否启用该群组                    | `true`           |
| `channels.feishu.replyInThread`                   | 群聊回复是否进入飞书话题线程      | `disabled`       |
| `channels.feishu.groupSessionScope`               | 群聊会话隔离粒度                  | `group`          |
| `channels.feishu.textChunkLimit`                  | 消息分块大小                      | `2000`           |
| `channels.feishu.mediaMaxMb`                      | 媒体大小限制                      | `30`             |
| `channels.feishu.streaming`                       | 启用流式卡片输出                  | `true`           |
| `channels.feishu.blockStreamingCoalesce.enabled`  | 启用块级流式合并                  | `true`           |
| `channels.feishu.typingIndicator`                 | 发送“正在输入”状态                | `true`           |
| `channels.feishu.resolveSenderNames`              | 拉取发送者名称                    | `true`           |
| `channels.feishu.reactionNotifications`           | 入站反应通知策略                  | `own`            |

---

## dmPolicy 策略说明

| 值            | 行为                                               |
| ------------- | -------------------------------------------------- |
| `"pairing"`   | **默认**。未知用户收到配对码，管理员批准后才能对话 |
| `"allowlist"` | 仅 `allowFrom` 列表中的用户可对话，其他静默忽略    |
| `"open"`      | 允许所有人对话（需在 allowFrom 中加 `"*"`）        |
| `"disabled"`  | 完全禁止私聊                                       |

---

## 支持的消息类型

### 接收

- ✅ 文本消息
- ✅ 富文本（帖子）
- ✅ 图片
- ✅ 文件
- ✅ 音频
- ✅ 视频
- ✅ 表情包

### 发送

- ✅ 文本消息
- ✅ 图片
- ✅ 文件
- ✅ 音频
- ⚠️ 富文本（部分支持）
