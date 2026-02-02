---
read_when:
  - 为 OpenClaw 设置 Twitch 聊天集成
summary: Twitch 聊天机器人配置与设置
title: Twitch
x-i18n:
  generated_at: "2026-02-01T19:58:38Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: aa7d60444e7f7e5dd7d02ce21527089058e024b8f427aeedf9e200a2818eb007
  source_path: channels/twitch.md
  workflow: 14
---

# Twitch（插件）

通过 IRC 连接支持 Twitch 聊天。OpenClaw 以 Twitch 用户（机器人账号）身份连接，在频道中接收和发送消息。

## 需要插件

Twitch 以插件形式提供，未包含在核心安装中。

通过 CLI（npm 注册表）安装：

```bash
openclaw plugins install @openclaw/twitch
```

本地签出（从 git 仓库运行时）：

```bash
openclaw plugins install ./extensions/twitch
```

详情：[插件](/plugin)

## 快速设置（入门）

1. 为机器人创建一个专用 Twitch 账号（或使用现有账号）。
2. 生成凭证：[Twitch Token Generator](https://twitchtokengenerator.com/)
   - 选择 **Bot Token**
   - 确认已勾选 `chat:read` 和 `chat:write` 权限范围
   - 复制 **Client ID** 和 **Access Token**
3. 查找你的 Twitch 用户 ID：https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
4. 配置令牌：
   - 环境变量：`OPENCLAW_TWITCH_ACCESS_TOKEN=...`（仅限默认账号）
   - 或配置文件：`channels.twitch.accessToken`
   - 如果两者都设置了，配置文件优先（环境变量回退仅适用于默认账号）。
5. 启动 Gateway网关。

**⚠️ 重要：** 添加访问控制（`allowFrom` 或 `allowedRoles`）以防止未授权用户触发机器人。`requireMention` 默认为 `true`。

最小配置：

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // 机器人的 Twitch 账号
      accessToken: "oauth:abc123...", // OAuth Access Token（或使用 OPENCLAW_TWITCH_ACCESS_TOKEN 环境变量）
      clientId: "xyz789...", // 从 Token Generator 获取的 Client ID
      channel: "vevisk", // 要加入的 Twitch 频道聊天室（必填）
      allowFrom: ["123456789"], // （推荐）仅限你的 Twitch 用户 ID - 从 https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/ 获取
    },
  },
}
```

## 工作原理

- 由 Gateway网关拥有的 Twitch 渠道。
- 确定性路由：回复始终返回到 Twitch。
- 每个账号映射到一个隔离的会话键 `agent:<agentId>:twitch:<accountName>`。
- `username` 是机器人的账号（用于认证），`channel` 是要加入的聊天室。

## 设置（详细）

### 生成凭证

使用 [Twitch Token Generator](https://twitchtokengenerator.com/)：

- 选择 **Bot Token**
- 确认已勾选 `chat:read` 和 `chat:write` 权限范围
- 复制 **Client ID** 和 **Access Token**

无需手动注册应用。令牌在数小时后过期。

### 配置机器人

**环境变量（仅限默认账号）：**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**或配置文件：**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

如果环境变量和配置文件都设置了，配置文件优先。

### 访问控制（推荐）

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // （推荐）仅限你的 Twitch 用户 ID
      allowedRoles: ["moderator"], // 或按角色限制
    },
  },
}
```

**可用角色：** `"moderator"`、`"owner"`、`"vip"`、`"subscriber"`、`"all"`。

**为什么使用用户 ID？** 用户名可以更改，存在冒充风险。用户 ID 是永久的。

查找你的 Twitch 用户 ID：https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/（将 Twitch 用户名转换为 ID）

## 令牌刷新（可选）

从 [Twitch Token Generator](https://twitchtokengenerator.com/) 获取的令牌无法自动刷新——过期后需重新生成。

如需自动刷新令牌，请在 [Twitch Developer Console](https://dev.twitch.tv/console) 创建你自己的 Twitch 应用，并添加到配置中：

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

机器人会在令牌过期前自动刷新，并记录刷新事件。

## 多账号支持

使用 `channels.twitch.accounts` 配置每个账号的令牌。参见 [`gateway/configuration`](/gateway/configuration) 了解通用模式。

示例（一个机器人账号加入两个频道）：

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**注意：** 每个账号需要自己的令牌（每个频道一个令牌）。

## 访问控制

### 基于角色的限制

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### 按用户 ID 设置允许列表（最安全）

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### 组合允许列表 + 角色

`allowFrom` 中的用户可绕过角色检查：

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### 禁用 @提及要求

默认情况下，`requireMention` 为 `true`。要禁用并响应所有消息：

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## 故障排除

首先，运行诊断命令：

```bash
openclaw doctor
openclaw channels status --probe
```

### 机器人不响应消息

**检查访问控制：** 临时设置 `allowedRoles: ["all"]` 进行测试。

**检查机器人是否在频道中：** 机器人必须加入 `channel` 中指定的频道。

### 令牌问题

**"Failed to connect" 或认证错误：**

- 确认 `accessToken` 是 OAuth 访问令牌值（通常以 `oauth:` 前缀开头）
- 检查令牌是否具有 `chat:read` 和 `chat:write` 权限范围
- 如果使用令牌刷新，确认已设置 `clientSecret` 和 `refreshToken`

### 令牌刷新不工作

**检查日志中的刷新事件：**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

如果看到 "token refresh disabled (no refresh token)"：

- 确保已提供 `clientSecret`
- 确保已提供 `refreshToken`

## 配置

**账号配置：**

- `username` - 机器人用户名
- `accessToken` - 具有 `chat:read` 和 `chat:write` 权限的 OAuth 访问令牌
- `clientId` - Twitch Client ID（来自 Token Generator 或你的应用）
- `channel` - 要加入的频道（必填）
- `enabled` - 启用此账号（默认：`true`）
- `clientSecret` - 可选：用于自动刷新令牌
- `refreshToken` - 可选：用于自动刷新令牌
- `expiresIn` - 令牌过期时间（秒）
- `obtainmentTimestamp` - 令牌获取时间戳
- `allowFrom` - 用户 ID 允许列表
- `allowedRoles` - 基于角色的访问控制（`"moderator" | "owner" | "vip" | "subscriber" | "all"`）
- `requireMention` - 要求 @提及（默认：`true`）

**提供商选项：**

- `channels.twitch.enabled` - 启用/禁用渠道启动
- `channels.twitch.username` - 机器人用户名（简化单账号配置）
- `channels.twitch.accessToken` - OAuth 访问令牌（简化单账号配置）
- `channels.twitch.clientId` - Twitch Client ID（简化单账号配置）
- `channels.twitch.channel` - 要加入的频道（简化单账号配置）
- `channels.twitch.accounts.<accountName>` - 多账号配置（上述所有账号字段）

完整示例：

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## 工具操作

智能体可以调用 `twitch` 执行以下操作：

- `send` - 向频道发送消息

示例：

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## 安全与运维

- **将令牌视为密码** - 切勿将令牌提交到 git
- **使用自动令牌刷新** 用于长时间运行的机器人
- **使用用户 ID 允许列表** 而非用户名进行访问控制
- **监控日志** 关注令牌刷新事件和连接状态
- **最小化令牌权限范围** - 仅请求 `chat:read` 和 `chat:write`
- **如遇问题**：确认没有其他进程占用会话后，重启 Gateway网关

## 限制

- 每条消息最多 **500 个字符**（按词边界自动分块）
- 分块前会移除 Markdown 格式
- 无速率限制（使用 Twitch 内置的速率限制）
