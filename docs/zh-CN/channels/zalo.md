---
read_when:
  - 开发 Zalo 功能或 webhooks
summary: Zalo bot 支持状态、功能和配置
title: Zalo
x-i18n:
  generated_at: "2026-02-03T07:44:44Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 0311d932349f96412b712970b5d37329b91929bf3020536edf3ca0ff464373c0
  source_path: channels/zalo.md
  workflow: 15
---

# Zalo (Bot API)

状态：实验性。仅支持私信；根据 Zalo 文档，群组即将推出。

## 需要插件

Zalo 以插件形式提供，不包含在核心安装中。

- 通过 CLI 安装：`openclaw plugins install @openclaw/zalo`
- 或在新手引导期间选择 **Zalo** 并确认安装提示
- 详情：[插件](/plugin)

## 快速设置（初学者）

1. 安装 Zalo 插件：
   - 从源代码检出：`openclaw plugins install ./extensions/zalo`
   - 从 npm（如果已发布）：`openclaw plugins install @openclaw/zalo`
   - 或在新手引导中选择 **Zalo** 并确认安装提示
2. 设置 token：
   - 环境变量：`ZALO_BOT_TOKEN=...`
   - 或配置：`channels.zalo.botToken: "..."`。
3. 重启 Gateway 网关（或完成新手引导）。
4. 私信访问默认为配对模式；首次联系时批准配对码。

最小配置：

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## 它是什么

Zalo 是一款专注于越南市场的即时通讯应用；其 Bot API 让 Gateway 网关可以运行一个用于一对一对话的 bot。
它非常适合需要确定性路由回 Zalo 的支持或通知场景。

- 由 Gateway 网关拥有的 Zalo Bot API 渠道。
- 确定性路由：回复返回到 Zalo；模型不会选择渠道。
- 私信共享智能体的主会话。
- 群组尚不支持（Zalo 文档标注"即将推出"）。

## 设置（快速路径）

### 1）创建 bot token（Zalo Bot 平台）

1. 前往 **https://bot.zaloplatforms.com** 并登录。
2. 创建新 bot 并配置其设置。
3. 复制 bot token（格式：`12345689:abc-xyz`）。

### 2）配置 token（环境变量或配置）

示例：

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

环境变量选项：`ZALO_BOT_TOKEN=...`（仅适用于默认账户）。

多账户支持：使用 `channels.zalo.accounts` 配置每账户 token 和可选的 `name`。

3. 重启 Gateway 网关。当 token 被解析（环境变量或配置）时，Zalo 启动。
4. 私信访问默认为配对模式。当 bot 首次被联系时批准配对码。

## 工作原理（行为）

- 入站消息被规范化为带有媒体占位符的共享渠道信封。
- 回复始终路由回同一 Zalo 聊天。
- 默认使用长轮询；可通过 `channels.zalo.webhookUrl` 启用 webhook 模式。

## 限制

- 出站文本按 2000 字符分块（Zalo API 限制）。
- 媒体下载/上传受 `channels.zalo.mediaMaxMb` 限制（默认 5）。
- 由于 2000 字符限制使流式传输效果不佳，默认阻止流式传输。

## 访问控制（私信）

### 私信访问

- 默认：`channels.zalo.dmPolicy = "pairing"`。未知发送者会收到配对码；消息在批准前会被忽略（配对码 1 小时后过期）。
- 通过以下方式批准：
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- 配对是默认的令牌交换方式。详情：[配对](/start/pairing)
- `channels.zalo.allowFrom` 接受数字用户 ID（无用户名查找功能）。

## 长轮询与 webhook

- 默认：长轮询（不需要公共 URL）。
- Webhook 模式：设置 `channels.zalo.webhookUrl` 和 `channels.zalo.webhookSecret`。
  - Webhook secret 必须为 8-256 个字符。
  - Webhook URL 必须使用 HTTPS。
  - Zalo 发送事件时带有 `X-Bot-Api-Secret-Token` 头用于验证。
  - Gateway 网关 HTTP 在 `channels.zalo.webhookPath` 处理 webhook 请求（默认为 webhook URL 路径）。

**注意：** 根据 Zalo API 文档，getUpdates（轮询）和 webhook 是互斥的。

## 支持的消息类型

- **文本消息**：完全支持，2000 字符分块。
- **图片消息**：下载和处理入站图片；通过 `sendPhoto` 发送图片。
- **贴纸**：已记录但未完全处理（无智能体响应）。
- **不支持的类型**：已记录（例如来自受保护用户的消息）。

## 功能

| 功能         | 状态                          |
| ------------ | ----------------------------- |
| 私信         | ✅ 支持                       |
| 群组         | ❌ 即将推出（根据 Zalo 文档） |
| 媒体（图片） | ✅ 支持                       |
| 表情回应     | ❌ 不支持                     |
| 主题         | ❌ 不支持                     |
| 投票         | ❌ 不支持                     |
| 原生命令     | ❌ 不支持                     |
| 流式传输     | ⚠️ 已阻止（2000 字符限制）    |

## 投递目标（CLI/cron）

- 使用聊天 id 作为目标。
- 示例：`openclaw message send --channel zalo --target 123456789 --message "hi"`。

## 故障排除

**Bot 不响应：**

- 检查 token 是否有效：`openclaw channels status --probe`
- 验证发送者已被批准（配对或 allowFrom）
- 检查 Gateway 网关日志：`openclaw logs --follow`

**Webhook 未收到事件：**

- 确保 webhook URL 使用 HTTPS
- 验证 secret token 为 8-256 个字符
- 确认 Gateway 网关 HTTP 端点在配置的路径上可访问
- 检查 getUpdates 轮询未在运行（它们是互斥的）

## 配置参考（Zalo）

完整配置：[配置](/gateway/configuration)

提供商选项：

- `channels.zalo.enabled`：启用/禁用渠道启动。
- `channels.zalo.botToken`：来自 Zalo Bot 平台的 bot token。
- `channels.zalo.tokenFile`：从文件路径读取 token。
- `channels.zalo.dmPolicy`：`pairing | allowlist | open | disabled`（默认：pairing）。
- `channels.zalo.allowFrom`：私信允许列表（用户 ID）。`open` 需要 `"*"`。向导会询问数字 ID。
- `channels.zalo.mediaMaxMb`：入站/出站媒体上限（MB，默认 5）。
- `channels.zalo.webhookUrl`：启用 webhook 模式（需要 HTTPS）。
- `channels.zalo.webhookSecret`：webhook secret（8-256 字符）。
- `channels.zalo.webhookPath`：Gateway 网关 HTTP 服务器上的 webhook 路径。
- `channels.zalo.proxy`：API 请求的代理 URL。

多账户选项：

- `channels.zalo.accounts.<id>.botToken`：每账户 token。
- `channels.zalo.accounts.<id>.tokenFile`：每账户 token 文件。
- `channels.zalo.accounts.<id>.name`：显示名称。
- `channels.zalo.accounts.<id>.enabled`：启用/禁用账户。
- `channels.zalo.accounts.<id>.dmPolicy`：每账户私信策略。
- `channels.zalo.accounts.<id>.allowFrom`：每账户允许列表。
- `channels.zalo.accounts.<id>.webhookUrl`：每账户 webhook URL。
- `channels.zalo.accounts.<id>.webhookSecret`：每账户 webhook secret。
- `channels.zalo.accounts.<id>.webhookPath`：每账户 webhook 路径。
- `channels.zalo.accounts.<id>.proxy`：每账户代理 URL。
