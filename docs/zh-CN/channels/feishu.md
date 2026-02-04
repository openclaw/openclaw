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

## 需要插件

安装 Feishu 插件：

```bash
openclaw plugins install @openclaw/feishu
```

本地 checkout（在 git 仓库内运行）：

```bash
openclaw plugins install ./extensions/feishu
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

在 **权限管理** 页面，点击 **批量导入** 按钮，粘贴以下 JSON 配置一键导入所需权限：

```json
{
  "scopes": {
    "tenant": [
      "aily:file:read",
      "aily:file:write",
      "application:application.app_message_stats.overview:readonly",
      "application:application:self_manage",
      "application:bot.menu:write",
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
2. 添加事件：`im.message.receive_v1`（接收消息）

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
- `"allowlist"` = 仅允许 `groupAllowFrom` 中的用户
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

### 仅允许特定用户在群组中使用

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["ou_xxx", "ou_yyy"],
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

> 注意：飞书目前不支持原生命令菜单，命令需要以文本形式发送。

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

如果需要管理多个飞书机器人：

```json5
{
  channels: {
    feishu: {
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

飞书目前不支持消息编辑，因此默认禁用流式输出（`blockStreaming: true`）。机器人会等待完整回复后一次性发送。

---

## 配置参考

完整配置请参考：[网关配置](/gateway/configuration)

主要选项：

| 配置项                                            | 说明                           | 默认值    |
| ------------------------------------------------- | ------------------------------ | --------- |
| `channels.feishu.enabled`                         | 启用/禁用渠道                  | `true`    |
| `channels.feishu.domain`                          | API 域名（`feishu` 或 `lark`） | `feishu`  |
| `channels.feishu.accounts.<id>.appId`             | 应用 App ID                    | -         |
| `channels.feishu.accounts.<id>.appSecret`         | 应用 App Secret                | -         |
| `channels.feishu.accounts.<id>.domain`            | 单账号 API 域名覆盖            | `feishu`  |
| `channels.feishu.dmPolicy`                        | 私聊策略                       | `pairing` |
| `channels.feishu.allowFrom`                       | 私聊白名单（open_id 列表）     | -         |
| `channels.feishu.groupPolicy`                     | 群组策略                       | `open`    |
| `channels.feishu.groupAllowFrom`                  | 群组白名单                     | -         |
| `channels.feishu.groups.<chat_id>.requireMention` | 是否需要 @提及                 | `true`    |
| `channels.feishu.groups.<chat_id>.enabled`        | 是否启用该群组                 | `true`    |
| `channels.feishu.textChunkLimit`                  | 消息分块大小                   | `2000`    |
| `channels.feishu.mediaMaxMb`                      | 媒体大小限制                   | `30`      |
| `channels.feishu.blockStreaming`                  | 禁用流式输出                   | `true`    |

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
