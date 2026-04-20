---
summary: "Zalo 机器人支持状态、功能和配置"
read_when:
  - 处理 Zalo 功能或 webhook
title: "Zalo"
---

# Zalo（机器人 API）

状态：实验性。支持 DM。下面的[功能](#capabilities)部分反映了当前 Marketplace 机器人的行为。

## 捆绑插件

Zalo 在当前的 OpenClaw 版本中作为捆绑插件提供，因此正常的打包构建不需要单独安装。

如果您使用的是较旧的构建或排除了 Zalo 的自定义安装，请手动安装：

- 通过 CLI 安装：`openclaw plugins install @openclaw/zalo`
- 或从源代码检出：`openclaw plugins install ./path/to/local/zalo-plugin`
- 详情：[插件](/tools/plugin)

## 快速设置（初学者）

1. 确保 Zalo 插件可用。
   - 当前打包的 OpenClaw 版本已经捆绑了它。
   - 较旧/自定义安装可以使用上面的命令手动添加它。
2. 设置令牌：
   - 环境变量：`ZALO_BOT_TOKEN=...`
   - 或配置：`channels.zalo.accounts.default.botToken: "..."`。
3. 重启网关（或完成设置）。
4. DM 访问默认需要配对；首次联系时批准配对码。

最小配置：

```json5
{
  channels: {
    zalo: {
      enabled: true,
      accounts: {
        default: {
          botToken: "12345689:abc-xyz",
          dmPolicy: "pairing",
        },
      },
    },
  },
}
```

## 是什么

Zalo 是一个面向越南的消息应用；其机器人 API 允许网关运行用于 1:1 对话的机器人。
它非常适合您希望确定性路由回 Zalo 的支持或通知场景。

本页面反映了 OpenClaw 对**Zalo Bot Creator / Marketplace 机器人**的当前行为。**Zalo 官方账户 (OA) 机器人**是不同的 Zalo 产品表面，可能表现不同。

- 网关拥有的 Zalo Bot API 频道。
- 确定性路由：回复返回 Zalo；模型永远不会选择频道。
- DM 共享代理的主会话。
- 下面的[功能](#capabilities)部分显示了当前 Marketplace 机器人的支持情况。

## 设置（快速路径）

### 1）创建机器人令牌（Zalo Bot Platform）

1. 前往 [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) 并登录。
2. 创建新机器人并配置其设置。
3. 复制完整的机器人令牌（通常为 `numeric_id:secret`）。对于 Marketplace 机器人，可用的运行时令牌可能会在创建后的机器人欢迎消息中显示。

### 2）配置令牌（环境变量或配置）

示例：

```json5
{
  channels: {
    zalo: {
      enabled: true,
      accounts: {
        default: {
          botToken: "12345689:abc-xyz",
          dmPolicy: "pairing",
        },
      },
    },
  },
}
```

如果您稍后迁移到支持群组的 Zalo 机器人表面，您可以明确添加群组特定的配置，如 `groupPolicy` 和 `groupAllowFrom`。对于当前 Marketplace 机器人的行为，请参见[功能](#capabilities)。

环境变量选项：`ZALO_BOT_TOKEN=...`（仅对默认账户有效）。

多账户支持：使用 `channels.zalo.accounts` 并为每个账户设置令牌和可选的 `name`。

3. 重启网关。当令牌解析（环境变量或配置）时，Zalo 启动。
4. DM 访问默认为配对。当机器人首次被联系时，批准代码。

## 工作原理（行为）

- 入站消息被标准化为带有媒体占位符的共享频道信封。
- 回复始终路由回同一个 Zalo 聊天。
- 默认使用长轮询；通过 `channels.zalo.webhookUrl` 可使用 webhook 模式。

## 限制

- 出站文本被分块为 2000 个字符（Zalo API 限制）。
- 媒体下载/上传受 `channels.zalo.mediaMaxMb` 限制（默认 5）。
- 由于 2000 字符限制使流式传输不太有用，默认情况下流式传输被阻止。

## 访问控制（DM）

### DM 访问

- 默认：`channels.zalo.dmPolicy = "pairing"`。未知发送者会收到一个配对码；消息在批准前被忽略（代码在 1 小时后过期）。
- 通过以下方式批准：
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- 配对是默认的令牌交换。详情：[配对](/channels/pairing)
- `channels.zalo.allowFrom` 接受数字用户 ID（无法查找用户名）。

<a id="access-control-groups"></a>

## 访问控制（群组）

对于**Zalo Bot Creator / Marketplace 机器人**，实际上不支持群组，因为机器人根本无法被添加到群组中。

这意味着下面的群组相关配置键存在于架构中，但对于 Marketplace 机器人不可用：

- `channels.zalo.groupPolicy` 控制群组入站处理：`open | allowlist | disabled`。
- `channels.zalo.groupAllowFrom` 限制哪些发送者 ID 可以在群组中触发机器人。
- 如果未设置 `groupAllowFrom`，Zalo 会回退到 `allowFrom` 进行发送者检查。
- 运行时注意：如果完全缺少 `channels.zalo`，运行时仍会回退到 `groupPolicy="allowlist"` 以确保安全。

当您的机器人表面支持群组访问时，群组策略值为：

- `groupPolicy: "disabled"` — 阻止所有群组消息。
- `groupPolicy: "open"` — 允许任何群组成员（提及门控）。
- `groupPolicy: "allowlist"` — 默认关闭；只接受允许的发送者。

如果您使用不同的 Zalo 机器人产品表面并已验证工作的群组行为，请单独记录，而不是假设它与 Marketplace 机器人流程匹配。

## 长轮询与 webhook

- 默认：长轮询（不需要公共 URL）。
- Webhook 模式：设置 `channels.zalo.webhookUrl` 和 `channels.zalo.webhookSecret`。
  - Webhook 密钥必须为 8-256 个字符。
  - Webhook URL 必须使用 HTTPS。
  - Zalo 发送带有 `X-Bot-Api-Secret-Token` 头的事件进行验证。
  - 网关 HTTP 在 `channels.zalo.webhookPath`（默认为 webhook URL 路径）处理 webhook 请求。
  - 请求必须使用 `Content-Type: application/json`（或 `+json` 媒体类型）。
  - 重复事件（`event_name + message_id`）在短重播窗口内被忽略。
  - 突发流量按路径/源进行速率限制，可能返回 HTTP 429。

**注意：** 根据 Zalo API 文档，getUpdates（轮询）和 webhook 是互斥的。

## 支持的消息类型

有关快速支持快照，请参见[功能](#capabilities)。下面的注释在行为需要额外上下文的地方添加了详细信息。

- **文本消息**：完全支持，2000 字符分块。
- **文本中的纯 URL**：表现像普通文本输入。
- **链接预览 / 富链接卡片**：参见[功能](#capabilities)中的 Marketplace 机器人状态；它们不能可靠地触发回复。
- **图像消息**：参见[功能](#capabilities)中的 Marketplace 机器人状态；入站图像处理不可靠（只有 typing 指示器，没有最终回复）。
- **贴纸**：参见[功能](#capabilities)中的 Marketplace 机器人状态。
- **语音笔记 / 音频文件 / 视频 / 通用文件附件**：参见[功能](#capabilities)中的 Marketplace 机器人状态。
- **不支持的类型**：已记录（例如，来自受保护用户的消息）。

<a id="capabilities"></a>

## 功能

此表总结了 OpenClaw 中当前**Zalo Bot Creator / Marketplace 机器人**的行为。

| 功能                   | 状态                               |
| ---------------------- | ---------------------------------- |
| 直接消息               | ✅ 支持                            |
| 群组                   | ❌ Marketplace 机器人不可用        |
| 媒体（入站图像）       | ⚠️ 有限 / 在您的环境中验证         |
| 媒体（出站图像）       | ⚠️ 未为 Marketplace 机器人重新测试 |
| 文本中的纯 URL         | ✅ 支持                            |
| 链接预览               | ⚠️ Marketplace 机器人不可靠        |
| 反应                   | ❌ 不支持                          |
| 贴纸                   | ⚠️ Marketplace 机器人无代理回复    |
| 语音笔记 / 音频 / 视频 | ⚠️ Marketplace 机器人无代理回复    |
| 文件附件               | ⚠️ Marketplace 机器人无代理回复    |
| 线程                   | ❌ 不支持                          |
| 投票                   | ❌ 不支持                          |
| 原生命令               | ❌ 不支持                          |
| 流式传输               | ⚠️ 已阻止（2000 字符限制）         |

## 传递目标（CLI/ cron）

- 使用聊天 ID 作为目标。
- 示例：`openclaw message send --channel zalo --target 123456789 --message "hi"`。

## 故障排除

**机器人不响应：**

- 检查令牌是否有效：`openclaw channels status --probe`
- 验证发送者已被批准（配对或 allowFrom）
- 检查网关日志：`openclaw logs --follow`

**Webhook 未接收事件：**

- 确保 webhook URL 使用 HTTPS
- 验证密钥令牌为 8-256 个字符
- 确认网关 HTTP 端点在配置的路径上可访问
- 检查 getUpdates 轮询是否未运行（它们是互斥的）

## 配置参考（Zalo）

完整配置：[配置](/gateway/configuration)

扁平的顶级键（`channels.zalo.botToken`、`channels.zalo.dmPolicy` 等）是遗留的单账户简写。对于新配置，首选 `channels.zalo.accounts.<id>.*`。这两种形式仍然在此处记录，因为它们存在于架构中。

提供商选项：

- `channels.zalo.enabled`：启用/禁用频道启动。
- `channels.zalo.botToken`：来自 Zalo Bot Platform 的机器人令牌。
- `channels.zalo.tokenFile`：从常规文件路径读取令牌。拒绝符号链接。
- `channels.zalo.dmPolicy`：`pairing | allowlist | open | disabled`（默认：pairing）。
- `channels.zalo.allowFrom`：DM 允许列表（用户 ID）。`open` 需要 `"*"`。向导会要求提供数字 ID。
- `channels.zalo.groupPolicy`：`open | allowlist | disabled`（默认：allowlist）。存在于配置中；有关当前 Marketplace 机器人行为，请参见[功能](#capabilities)和[访问控制（群组）](#access-control-groups)。
- `channels.zalo.groupAllowFrom`：群组发送者允许列表（用户 ID）。未设置时回退到 `allowFrom`。
- `channels.zalo.mediaMaxMb`：入站/出站媒体上限（MB，默认 5）。
- `channels.zalo.webhookUrl`：启用 webhook 模式（需要 HTTPS）。
- `channels.zalo.webhookSecret`：webhook 密钥（8-256 字符）。
- `channels.zalo.webhookPath`：网关 HTTP 服务器上的 webhook 路径。
- `channels.zalo.proxy`：API 请求的代理 URL。

多账户选项：

- `channels.zalo.accounts.<id>.botToken`：每个账户的令牌。
- `channels.zalo.accounts.<id>.tokenFile`：每个账户的常规令牌文件。拒绝符号链接。
- `channels.zalo.accounts.<id>.name`：显示名称。
- `channels.zalo.accounts.<id>.enabled`：启用/禁用账户。
- `channels.zalo.accounts.<id>.dmPolicy`：每个账户的 DM 策略。
- `channels.zalo.accounts.<id>.allowFrom`：每个账户的允许列表。
- `channels.zalo.accounts.<id>.groupPolicy`：每个账户的群组策略。存在于配置中；有关当前 Marketplace 机器人行为，请参见[功能](#capabilities)和[访问控制（群组）](#access-control-groups)。
- `channels.zalo.accounts.<id>.groupAllowFrom`：每个账户的群组发送者允许列表。
- `channels.zalo.accounts.<id>.webhookUrl`：每个账户的 webhook URL。
- `channels.zalo.accounts.<id>.webhookSecret`：每个账户的 webhook 密钥。
- `channels.zalo.accounts.<id>.webhookPath`：每个账户的 webhook 路径。
- `channels.zalo.accounts.<id>.proxy`：每个账户的代理 URL。

## 相关

- [频道概述](/channels) — 所有支持的频道
- [配对](/channels/pairing) — DM 认证和配对流程
- [群组](/channels/groups) — 群聊行为和提及门控
- [频道路由](/channels/channel-routing) — 消息的会话路由
- [安全](/gateway/security) — 访问模型和强化
