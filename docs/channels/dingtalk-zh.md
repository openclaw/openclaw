---
summary: "钉钉机器人概述、功能与配置"
read_when:
  - 你想接入钉钉机器人
  - 你正在配置钉钉 channel
title: 钉钉
---

# 钉钉机器人

钉钉是中国企业广泛使用的团队协作平台。本插件通过钉钉的 Stream 模式（WebSocket 长连接）将 OpenClaw 连接到钉钉机器人，无需暴露公网 Webhook URL 即可接收消息。

---

## 需要安装插件

安装钉钉插件：

```bash
openclaw plugins install @openclaw/dingtalk
```

本地开发（从 git 仓库运行时）：

```bash
openclaw plugins install ./extensions/dingtalk
```

---

## 快速开始

有两种方式添加钉钉 channel：

### 方式一：引导向导（推荐）

如果你刚安装 OpenClaw，运行向导：

```bash
openclaw onboard
```

向导会引导你完成：

1. 创建钉钉应用并获取凭证
2. 在 OpenClaw 中配置应用凭证
3. 启动网关

✅ **配置完成后**，检查网关状态：

- `openclaw gateway status`
- `openclaw logs --follow`

### 方式二：CLI 设置

如果你已完成初始安装，通过 CLI 添加 channel：

```bash
openclaw channels add
```

选择 **DingTalk**，然后输入 Client ID 和 Client Secret。

✅ **配置完成后**，管理网关：

- `openclaw gateway status`
- `openclaw gateway restart`
- `openclaw logs --follow`

---

## 第一步：创建钉钉应用

### 1. 打开钉钉开发者后台

访问 [钉钉开发者后台](https://open-dev.dingtalk.com)，使用企业管理员账号登录。

### 2. 创建企业内部应用

1. 点击 **应用开发** > **企业内部开发** > **创建应用**
2. 填写应用名称和描述
3. 选择应用图标

### 3. 获取凭证

在应用的 **基本信息** 页面，复制：

- **Client ID**（即 AppKey）
- **Client Secret**（即 AppSecret）

❗ **重要：** 请妥善保管 Client Secret，不要泄露。

### 4. 开启机器人能力

在 **应用功能** > **机器人** 中：

1. 开启机器人能力
2. 设置机器人名称
3. **消息接收模式选择 Stream 模式**（非 HTTP 模式）

### 5. 开通权限

在 **权限管理** 中，根据需要的功能开通以下权限：

| 权限                   | 用途             | 说明                           |
| ---------------------- | ---------------- | ------------------------------ |
| `qyapi_robot_sendmsg`  | **必须**         | 机器人发送消息（主动发送消息） |
| `Card.Instance.Write`  | AI Card 流式输出 | 创建互动卡片实例               |
| `Card.Streaming.Write` | AI Card 流式输出 | 向互动卡片推送流式内容         |

开通权限后，必须**重新发布应用**才能生效。

### 6. 发布应用

1. 在 **版本管理与发布** 中，创建新版本
2. 设置可见范围（哪些用户/部门可以访问机器人）
3. 提交审核并发布
4. 等待管理员审批

---

## 第二步：配置 OpenClaw

### 使用向导配置（推荐）

```bash
openclaw channels add
```

选择 **DingTalk**，粘贴 Client ID 和 Client Secret。

### 通过配置文件配置

编辑 `~/.openclaw/openclaw.json`：

```json5
{
  channels: {
    dingtalk: {
      enabled: true,
      dmPolicy: "pairing",
      clientId: "你的-client-id",
      clientSecret: "你的-client-secret",
    },
  },
}
```

### 通过环境变量配置

```bash
export DINGTALK_CLIENT_ID="你的-client-id"
export DINGTALK_CLIENT_SECRET="你的-client-secret"
```

---

## 第三步：启动与测试

### 1. 启动网关

```bash
openclaw gateway
```

### 2. 发送测试消息

在钉钉中找到你的机器人，发送一条消息（私聊或在群组中 @机器人）。

### 3. 审批配对

默认情况下，机器人会回复一个配对码。通过以下命令审批：

```bash
openclaw pairing approve dingtalk <配对码>
```

审批通过后，即可正常对话。

---

## 功能概览

- **钉钉机器人 channel**：由网关管理的钉钉机器人
- **Stream 模式**：通过 `dingtalk-stream` SDK 建立 WebSocket 长连接，无需公网 URL
- **确定性路由**：回复始终返回到钉钉
- **会话隔离**：私聊共享主会话；群组相互隔离
- **流式卡片输出**：通过互动卡片实现打字机风格的增量文本显示

---

## 访问控制

### 私聊（DM）

- **默认**：`dmPolicy: "pairing"`（未知用户会收到配对码）
- **审批配对**：

  ```bash
  openclaw pairing list dingtalk
  openclaw pairing approve dingtalk <配对码>
  ```

- **白名单模式**：设置 `channels.dingtalk.allowFrom`，填入允许的 staffId 列表

### 群聊

**1. 群组策略** (`channels.dingtalk.groupPolicy`)：

- `"open"` = 允许所有群组（默认，需要 @机器人）
- `"allowlist"` = 仅允许 `groupAllowFrom` 中的群组
- `"disabled"` = 禁用群消息

**2. @提及要求** (`channels.dingtalk.requireMention`)：

- `true` = 需要 @机器人才响应（默认）
- `false` = 不需要 @也能响应

---

## 群组配置示例

### 允许所有群组，需要 @机器人（默认）

```json5
{
  channels: {
    dingtalk: {
      groupPolicy: "open",
      // 默认 requireMention: true
    },
  },
}
```

### 仅允许特定群组

```json5
{
  channels: {
    dingtalk: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["cidXXXXXX", "cidYYYYYY"],
    },
  },
}
```

---

## 获取群/用户 ID

### 群组 ID（conversationId）

群组 ID 格式类似 `cidXXXXXX`。

**方法一（推荐）**

1. 启动网关，在群里 @机器人
2. 运行 `openclaw logs --follow`，查找 `conversationId`

### 用户 ID（staffId）

**方法一（推荐）**

1. 启动网关，私聊机器人
2. 运行 `openclaw logs --follow`，查找 `senderStaffId`

**方法二**

查看配对请求中的用户 staffId：

```bash
openclaw pairing list dingtalk
```

---

## 常用命令

| 命令      | 说明           |
| --------- | -------------- |
| `/status` | 显示机器人状态 |
| `/reset`  | 重置当前会话   |
| `/model`  | 显示/切换模型  |

> 注意：钉钉不支持原生的命令菜单，所有命令需以文本消息形式发送。

## 网关管理命令

| 命令                       | 说明              |
| -------------------------- | ----------------- |
| `openclaw gateway status`  | 查看网关状态      |
| `openclaw gateway install` | 安装/启动网关服务 |
| `openclaw gateway stop`    | 停止网关服务      |
| `openclaw gateway restart` | 重启网关服务      |
| `openclaw logs --follow`   | 实时查看网关日志  |

---

## 故障排除

### 机器人在群聊中不回复

1. 确保机器人已添加到群组
2. 确保你 @了机器人（默认行为）
3. 检查 `groupPolicy` 是否设置为 `"disabled"`
4. 查看日志：`openclaw logs --follow`

### 机器人收不到消息

1. 确保应用已发布并审批通过
2. 确保机器人能力已开启，且使用 **Stream 模式**
3. 确保可见范围包含了目标用户/群组
4. 确保网关正在运行：`openclaw gateway status`
5. 查看日志：`openclaw logs --follow`

### Client Secret 泄露

1. 在钉钉开发者后台重置 Client Secret
2. 更新配置中的 Client Secret
3. 重启网关

### 消息发送失败

1. 确保应用已开启机器人能力
2. 确保应用已发布
3. 注意速率限制（钉钉：每分钟 20 条消息/机器人）
4. 查看日志获取详细错误信息

### 群聊媒体限制

钉钉在私聊和群聊中的媒体支持有差异：

- **私聊**：支持文本、图片、语音、视频、文件
- **群聊（@机器人）**：仅支持文本和图片

---

## 高级配置

### 多账号

```json5
{
  channels: {
    dingtalk: {
      defaultAccount: "main",
      accounts: {
        main: {
          clientId: "app-key-1",
          clientSecret: "app-secret-1",
          name: "主机器人",
        },
        backup: {
          clientId: "app-key-2",
          clientSecret: "app-secret-2",
          name: "备用机器人",
          enabled: false,
        },
      },
    },
  },
}
```

`defaultAccount` 控制当出站 API 未明确指定 `accountId` 时使用哪个钉钉账号。

### 消息限制

- `textChunkLimit`：出站消息分块大小（默认：2000 字符）
- `mediaMaxMb`：媒体上传/下载大小限制（默认：20MB）

### 流式输出（AI Card）

钉钉通过 [AI 互动卡片](https://open.dingtalk.com/document/isvapp/streaming-interactive-card) 支持流式回复。启用后，机器人会先创建一张卡片，然后在 AI 生成文本时持续更新卡片内容（打字机效果）。

**前提条件：** 钉钉应用必须开通 `Card.Instance.Write` 和 `Card.Streaming.Write` 权限。参见 [开通权限](#5-开通权限)。

```json5
{
  channels: {
    dingtalk: {
      streaming: {
        enabled: true,
      },
    },
  },
}
```

如果运行时创建卡片失败（如权限未开通），机器人会自动降级为纯文本消息发送。

设置 `streaming.enabled: false`（默认）可始终等待完整回复后以单条文本/Markdown 消息发送。

### 多 Agent 路由

使用 `bindings` 将钉钉私聊或群组路由到不同的 agent。

```json5
{
  agents: {
    list: [
      { id: "main" },
      {
        id: "support-bot",
        workspace: "/home/user/support-bot",
        agentDir: "/home/user/.openclaw/agents/support-bot/agent",
      },
    ],
  },
  bindings: [
    {
      agentId: "main",
      match: {
        channel: "dingtalk",
        peer: { kind: "direct", id: "staffId123" },
      },
    },
    {
      agentId: "support-bot",
      match: {
        channel: "dingtalk",
        peer: { kind: "group", id: "cidXXXXXX" },
      },
    },
  ],
}
```

路由字段说明：

- `match.channel`：`"dingtalk"`
- `match.peer.kind`：`"direct"`（私聊）或 `"group"`（群聊）
- `match.peer.id`：用户 staffId 或群组 conversationId

参见 [获取群/用户 ID](#获取群用户-id) 了解查找方法。

---

## 配置参考表

完整配置参见：[网关配置](/gateway/configuration)

核心配置项：

| 配置项                                                     | 说明                              | 默认值     |
| ---------------------------------------------------------- | --------------------------------- | ---------- |
| `channels.dingtalk.enabled`                                | 启用/禁用 channel                 | `true`     |
| `channels.dingtalk.clientId`                               | 应用 Client ID（AppKey）          | -          |
| `channels.dingtalk.clientSecret`                           | 应用 Client Secret（AppSecret）   | -          |
| `channels.dingtalk.robotCode`                              | 机器人编码（默认等于 clientId）   | `clientId` |
| `channels.dingtalk.defaultAccount`                         | 出站路由的默认账号 ID             | `default`  |
| `channels.dingtalk.accounts.<id>.clientId`                 | 单账号 Client ID                  | -          |
| `channels.dingtalk.accounts.<id>.clientSecret`             | 单账号 Client Secret              | -          |
| `channels.dingtalk.dmPolicy`                               | 私聊策略                          | `pairing`  |
| `channels.dingtalk.allowFrom`                              | 私聊白名单（staffId 列表）        | -          |
| `channels.dingtalk.groupPolicy`                            | 群组策略                          | `open`     |
| `channels.dingtalk.groupAllowFrom`                         | 群组白名单（conversationId 列表） | -          |
| `channels.dingtalk.requireMention`                         | 群聊中是否需要 @机器人            | `true`     |
| `channels.dingtalk.groups.<conversationId>.requireMention` | 单群组 @提及要求                  | `true`     |
| `channels.dingtalk.groups.<conversationId>.enabled`        | 启用/禁用单个群组                 | `true`     |
| `channels.dingtalk.textChunkLimit`                         | 消息分块大小                      | `2000`     |
| `channels.dingtalk.mediaMaxMb`                             | 媒体大小限制                      | `20`       |
| `channels.dingtalk.streaming.enabled`                      | 启用 AI Card 流式输出             | `false`    |
| `channels.dingtalk.resolveSenderNames`                     | 解析发送者显示名称                | `true`     |

---

## dmPolicy 参考

| 值            | 行为                                                      |
| ------------- | --------------------------------------------------------- |
| `"pairing"`   | **默认。** 未知用户会收到配对码，需要管理员审批后才能对话 |
| `"allowlist"` | 仅 `allowFrom` 中的用户可以对话                           |
| `"open"`      | 允许所有用户（需要 `allowFrom` 包含 `"*"`）               |

---

## 主动发送消息

OpenClaw 支持主动向钉钉用户或群组发送消息，无需等待用户先发消息。底层使用钉钉机器人消息 API（私聊：`/v1.0/robot/oToMessages/batchSend`，群聊：`/v1.0/robot/groupMessages/send`）。

**前提条件：** 钉钉应用必须开通 `qyapi_robot_sendmsg` 权限。

### CLI 方式

```bash
# 发送给用户（使用 staffId）
openclaw message send --channel dingtalk --to "staffId123" --text "你好！"

# 发送到群组（使用 conversationId）
openclaw message send --channel dingtalk --to "cidXXXXXX" --text "大家好！"
```

### API 方式

通过出站 API 使用 `channel: "dingtalk"`：

- **`sendText`**：发送文本或 Markdown 消息（自动检测格式）
- **`sendMedia`**：发送图片（通过 URL）或文件链接

目标格式：

- **私聊**：使用 `staffId` 作为目标
- **群聊**：使用 `conversationId`（如 `cidXXXXXX`）作为目标

---

## 支持的消息类型

### 接收

- ✅ 文本
- ✅ 图片（私聊 + 群聊）
- ✅ 语音（仅私聊）
- ✅ 文件（仅私聊）
- ✅ 视频（仅私聊）

### 发送

- ✅ 文本
- ✅ Markdown
- ✅ 图片
- ✅ 文件（仅私聊）
- ✅ 语音（仅私聊）
- ✅ 视频（仅私聊）
- ✅ 互动卡片（流式输出）
- ✅ ActionCard

---

## 与飞书功能对比

| 功能           | 钉钉       | 飞书 |
| -------------- | ---------- | ---- |
| 文本消息       | ✅         | ✅   |
| Markdown       | ✅         | ✅   |
| 图片           | ✅         | ✅   |
| 文件           | ✅（私聊） | ✅   |
| 音视频         | ✅（私聊） | ✅   |
| 流式卡片       | ✅         | ✅   |
| 消息表情回应   | ❌         | ✅   |
| 消息编辑       | ❌         | ✅   |
| 回复/话题      | ❌         | ✅   |
| 贴纸           | ❌         | ✅   |
| WebSocket 模式 | ✅         | ✅   |
