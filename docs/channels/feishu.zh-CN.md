---
summary: "飞书机器人概述、功能和配置"
read_when:
  - 你想连接飞书/ Lark 机器人
  - 你正在配置飞书通道
title: 飞书
---

# 飞书 / Lark

飞书/ Lark 是一个一体化协作平台，团队可以在其中聊天、共享文档、管理日历并一起完成工作。

**状态：** 生产就绪，支持机器人私信 + 群聊。默认使用 WebSocket 模式；可选使用 webhook 模式。

---

## 快速开始

> **需要 OpenClaw 2026.4.10 或更高版本。** 运行 `openclaw --version` 检查。使用 `openclaw update` 升级。

<步骤>
<步骤标题="运行通道设置向导">

```bash
openclaw channels login --channel feishu
```

使用你的飞书/ Lark 移动应用扫描二维码，自动创建飞书/ Lark 机器人。
</步骤>

<步骤标题="设置完成后，重启网关以应用更改">

```bash
openclaw gateway restart
```

</步骤>
</步骤>

---

## 访问控制

### 私信

配置 `dmPolicy` 来控制谁可以向机器人发送私信：

- `"pairing"` — 未知用户会收到配对代码；通过 CLI 批准
- `"allowlist"` — 只有在 `allowFrom` 中列出的用户可以聊天（默认：仅机器人所有者）
- `"open"` — 允许所有用户
- `"disabled"` — 禁用所有私信

**批准配对请求：**

```bash
openclaw pairing list feishu
openclaw pairing approve feishu <代码>
```

### 群聊

**群组策略** (`channels.feishu.groupPolicy`)：

| 值            | 行为                             |
| ------------- | -------------------------------- |
| `"open"`      | 响应群组中的所有消息             |
| `"allowlist"` | 只响应 `groupAllowFrom` 中的群组 |
| `"disabled"`  | 禁用所有群消息                   |

默认：`allowlist`

**提及要求** (`channels.feishu.requireMention`)：

- `true` — 需要 @提及（默认）
- `false` — 无需 @提及即可响应
- 群组覆盖：`channels.feishu.groups.<chat_id>.requireMention`

---

## 群组配置示例

### 允许所有群组，无需 @提及

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
    },
  },
}
```

### 允许所有群组，仍需 @提及

```json5
{
  channels: {
    feishu: {
      groupPolicy: "open",
      requireMention: true,
    },
  },
}
```

### 只允许特定群组

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      // 群组 ID 格式：oc_xxx
      groupAllowFrom: ["oc_xxx", "oc_yyy"],
    },
  },
}
```

### 限制群组内的发送者

```json5
{
  channels: {
    feishu: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["oc_xxx"],
      groups: {
        oc_xxx: {
          // 用户 open_id 格式：ou_xxx
          allowFrom: ["ou_user1", "ou_user2"],
        },
      },
    },
  },
}
```

---

## 获取群组/用户 ID

### 群组 ID (`chat_id`，格式：`oc_xxx`)

在飞书/ Lark 中打开群组，点击右上角的菜单图标，进入**设置**。群组 ID (`chat_id`) 列在设置页面上。

![获取群组 ID](/images/feishu-get-group-id.png)

### 用户 ID (`open_id`，格式：`ou_xxx`)

启动网关，向机器人发送私信，然后检查日志：

```bash
openclaw logs --follow
```

在日志输出中查找 `open_id`。你也可以检查待处理的配对请求：

```bash
openclaw pairing list feishu
```

---

## 常用命令

| 命令      | 描述               |
| --------- | ------------------ |
| `/status` | 显示机器人状态     |
| `/reset`  | 重置当前会话       |
| `/model`  | 显示或切换 AI 模型 |

> 飞书/ Lark 不支持原生斜杠命令菜单，因此请将这些作为纯文本消息发送。

---

## 故障排除

### 机器人在群聊中不响应

1. 确保机器人已添加到群组
2. 确保你 @提及了机器人（默认要求）
3. 验证 `groupPolicy` 不是 `"disabled"`
4. 检查日志：`openclaw logs --follow`

### 机器人不接收消息

1. 确保机器人已在飞书开放平台/ Lark 开发者平台发布并批准
2. 确保事件订阅包含 `im.message.receive_v1`
3. 确保选择了**持久连接**（WebSocket）
4. 确保授予了所有必要的权限范围
5. 确保网关正在运行：`openclaw gateway status`
6. 检查日志：`openclaw logs --follow`

### App Secret 泄露

1. 在飞书开放平台/ Lark 开发者平台重置 App Secret
2. 在配置中更新值
3. 重启网关：`openclaw gateway restart`

---

## 高级配置

### 多个账户

```json5
{
  channels: {
    feishu: {
      defaultAccount: "main",
      accounts: {
        main: {
          appId: "cli_xxx",
          appSecret: "xxx",
          name: "主要机器人",
        },
        backup: {
          appId: "cli_yyy",
          appSecret: "yyy",
          name: "备份机器人",
          enabled: false,
        },
      },
    },
  },
}
```

`defaultAccount` 控制当出站 API 未指定 `accountId` 时使用哪个账户。

### 消息限制

- `textChunkLimit` — 出站文本分块大小（默认：`2000` 字符）
- `mediaMaxMb` — 媒体上传/下载限制（默认：`30` MB）

### 流式输出

飞书/ Lark 通过交互式卡片支持流式回复。启用后，机器人会在生成文本时实时更新卡片。

```json5
{
  channels: {
    feishu: {
      streaming: true, // 启用流式卡片输出（默认：true）
      blockStreaming: true, // 启用块级流式输出（默认：true）
    },
  },
}
```

设置 `streaming: false` 以在一条消息中发送完整回复。

### 配额优化

使用两个可选标志减少飞书/ Lark API 调用次数：

- `typingIndicator`（默认 `true`）：设置为 `false` 以跳过输入反应调用
- `resolveSenderNames`（默认 `true`）：设置为 `false` 以跳过发送者个人资料查找

```json5
{
  channels: {
    feishu: {
      typingIndicator: false,
      resolveSenderNames: false,
    },
  },
}
```

### ACP 会话

飞书/ Lark 支持私信和群组线程消息的 ACP。飞书/ Lark ACP 是文本命令驱动的 — 没有原生斜杠命令菜单，因此直接在对话中使用 `/acp ...` 消息。

#### 持久 ACP 绑定

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

#### 从聊天中生成 ACP

在飞书/ Lark 私信或线程中：

```text
/acp spawn codex --thread here
```

`--thread here` 适用于私信和飞书/ Lark 线程消息。绑定对话中的后续消息直接路由到该 ACP 会话。

### 多代理路由

使用 `bindings` 将飞书/ Lark 私信或群组路由到不同的代理。

```json5
{
  agents: {
    list: [
      { id: "main" },
      { id: "agent-a", workspace: "/home/user/agent-a" },
      { id: "agent-b", workspace: "/home/user/agent-b" },
    ],
  },
  bindings: [
    {
      agentId: "agent-a",
      match: {
        channel: "feishu",
        peer: { kind: "direct", id: "ou_xxx" },
      },
    },
    {
      agentId: "agent-b",
      match: {
        channel: "feishu",
        peer: { kind: "group", id: "oc_zzz" },
      },
    },
  ],
}
```

路由字段：

- `match.channel`: `"feishu"`
- `match.peer.kind`: `"direct"`（私信）或 `"group"`（群聊）
- `match.peer.id`: 用户 Open ID (`ou_xxx`) 或群组 ID (`oc_xxx`)

有关查找提示，请参阅[获取群组/用户 ID](#获取群组用户-id)。

---

## 配置参考

完整配置：[网关配置](/gateway/configuration)

| 设置                                              | 描述                                | 默认值           |
| ------------------------------------------------- | ----------------------------------- | ---------------- |
| `channels.feishu.enabled`                         | 启用/禁用通道                       | `true`           |
| `channels.feishu.domain`                          | API 域名 (`feishu` 或 `lark`)       | `feishu`         |
| `channels.feishu.connectionMode`                  | 事件传输 (`websocket` 或 `webhook`) | `websocket`      |
| `channels.feishu.defaultAccount`                  | 出站路由的默认账户                  | `default`        |
| `channels.feishu.verificationToken`               | webhook 模式所需                    | —                |
| `channels.feishu.encryptKey`                      | webhook 模式所需                    | —                |
| `channels.feishu.webhookPath`                     | Webhook 路由路径                    | `/feishu/events` |
| `channels.feishu.webhookHost`                     | Webhook 绑定主机                    | `127.0.0.1`      |
| `channels.feishu.webhookPort`                     | Webhook 绑定端口                    | `3000`           |
| `channels.feishu.accounts.<id>.appId`             | App ID                              | —                |
| `channels.feishu.accounts.<id>.appSecret`         | App Secret                          | —                |
| `channels.feishu.accounts.<id>.domain`            | 每个账户的域名覆盖                  | `feishu`         |
| `channels.feishu.dmPolicy`                        | 私信策略                            | `allowlist`      |
| `channels.feishu.allowFrom`                       | 私信允许列表 (open_id 列表)         | [BotOwnerId]     |
| `channels.feishu.groupPolicy`                     | 群组策略                            | `allowlist`      |
| `channels.feishu.groupAllowFrom`                  | 群组允许列表                        | —                |
| `channels.feishu.requireMention`                  | 群组中需要 @提及                    | `true`           |
| `channels.feishu.groups.<chat_id>.requireMention` | 每个群组的 @提及覆盖                | 继承             |
| `channels.feishu.groups.<chat_id>.enabled`        | 启用/禁用特定群组                   | `true`           |
| `channels.feishu.textChunkLimit`                  | 消息分块大小                        | `2000`           |
| `channels.feishu.mediaMaxMb`                      | 媒体大小限制                        | `30`             |
| `channels.feishu.streaming`                       | 流式卡片输出                        | `true`           |
| `channels.feishu.blockStreaming`                  | 块级流式输出                        | `true`           |
| `channels.feishu.typingIndicator`                 | 发送输入反应                        | `true`           |
| `channels.feishu.resolveSenderNames`              | 解析发送者显示名称                  | `true`           |

---

## 支持的消息类型

### 接收

- ✅ 文本
- ✅ 富文本 (post)
- ✅ 图片
- ✅ 文件
- ✅ 音频
- ✅ 视频/媒体
- ✅ 表情贴纸

### 发送

- ✅ 文本
- ✅ 图片
- ✅ 文件
- ✅ 音频
- ✅ 视频/媒体
- ✅ 交互式卡片（包括流式更新）
- ⚠️ 富文本（post 样式格式；不支持完整的飞书/ Lark 创作功能）

### 线程和回复

- ✅ 内联回复
- ✅ 线程回复
- ✅ 媒体回复在回复线程消息时保持线程感知

---

## 相关

- [通道概述](/channels) — 所有支持的通道
- [配对](/channels/pairing) — 私信认证和配对流程
- [群组](/channels/groups) — 群聊行为和提及门控
- [通道路由](/channels/channel-routing) — 消息的会话路由
- [安全](/gateway/security) — 访问模型和强化
