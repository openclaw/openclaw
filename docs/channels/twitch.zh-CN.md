---
summary: "Twitch 聊天机器人配置和设置"
read_when:
  - 为 OpenClaw 设置 Twitch 聊天集成
title: "Twitch"
---

# Twitch

通过 IRC 连接支持 Twitch 聊天。OpenClaw 以 Twitch 用户（机器人账户）身份连接，以接收和发送频道中的消息。

## 捆绑插件

Twitch 在当前的 OpenClaw 版本中作为捆绑插件提供，因此正常的打包构建不需要单独安装。

如果您使用的是较旧的构建或不包含 Twitch 的自定义安装，请手动安装：

通过 CLI 安装（npm 注册表）：

```bash
openclaw plugins install @openclaw/twitch
```

本地检出（从 git 仓库运行时）：

```bash
openclaw plugins install ./path/to/local/twitch-plugin
```

详细信息：[插件](/tools/plugin)

## 快速设置（初学者）

1. 确保 Twitch 插件可用。
   - 当前打包的 OpenClaw 版本已经内置了它。
   - 较旧/自定义安装可以使用上述命令手动添加。
2. 为机器人创建一个专用的 Twitch 账户（或使用现有账户）。
3. 生成凭据：[Twitch Token Generator](https://twitchtokengenerator.com/)
   - 选择 **Bot Token**
   - 验证选择了 `chat:read` 和 `chat:write` 范围
   - 复制 **Client ID** 和 **Access Token**
4. 找到您的 Twitch 用户 ID：[https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
5. 配置令牌：
   - 环境变量：`OPENCLAW_TWITCH_ACCESS_TOKEN=...`（仅默认账户）
   - 或配置：`channels.twitch.accessToken`
   - 如果两者都设置，配置优先（环境变量回退仅适用于默认账户）。
6. 启动网关。

**⚠️ 重要：** 添加访问控制（`allowFrom` 或 `allowedRoles`）以防止未授权用户触发机器人。`requireMention` 默认设置为 `true`。

最小配置：

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // 机器人的 Twitch 账户
      accessToken: "oauth:abc123...", // OAuth 访问令牌（或使用 OPENCLAW_TWITCH_ACCESS_TOKEN 环境变量）
      clientId: "xyz789...", // 来自 Token Generator 的 Client ID
      channel: "vevisk", // 要加入的 Twitch 频道的聊天（必需）
      allowFrom: ["123456789"], // （推荐）仅您的 Twitch 用户 ID - 从 https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/ 获取
    },
  },
}
```

## 它是什么

- 由网关拥有的 Twitch 频道。
- 确定性路由：回复始终返回 Twitch。
- 每个账户映射到一个隔离的会话键 `agent:<agentId>:twitch:<accountName>`。
- `username` 是机器人的账户（用于认证），`channel` 是要加入的聊天室。

## 设置（详细）

### 生成凭据

使用 [Twitch Token Generator](https://twitchtokengenerator.com/)：

- 选择 **Bot Token**
- 验证选择了 `chat:read` 和 `chat:write` 范围
- 复制 **Client ID** 和 **Access Token**

不需要手动应用注册。令牌在数小时后过期。

### 配置机器人

**环境变量（仅默认账户）：**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**或配置：**

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

如果同时设置了环境变量和配置，配置优先。

### 访问控制（推荐）

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // （推荐）仅您的 Twitch 用户 ID
    },
  },
}
```

首选 `allowFrom` 作为硬白名单。如果您想要基于角色的访问，请使用 `allowedRoles`。

**可用角色：** `"moderator"`、`"owner"`、`"vip"`、`"subscriber"`、`"all"`。

**为什么使用用户 ID？** 用户名可以更改，允许冒充。用户 ID 是永久的。

查找您的 Twitch 用户 ID：[https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)（将您的 Twitch 用户名转换为 ID）

## 令牌刷新（可选）

来自 [Twitch Token Generator](https://twitchtokengenerator.com/) 的令牌无法自动刷新 - 过期时重新生成。

对于自动令牌刷新，在 [Twitch Developer Console](https://dev.twitch.tv/console) 创建您自己的 Twitch 应用并添加到配置：

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

机器人会在过期前自动刷新令牌并记录刷新事件。

## 多账户支持

使用 `channels.twitch.accounts` 和每账户令牌。有关共享模式，请参见 [`gateway/configuration`](/gateway/configuration)。

示例（一个机器人账户在两个频道中）：

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

**注意：** 每个账户需要自己的令牌（每个频道一个令牌）。

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

### 按用户 ID 白名单（最安全）

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

### 基于角色的访问（替代方案）

`allowFrom` 是一个硬白名单。设置后，只允许那些用户 ID。
如果您想要基于角色的访问，请保持 `allowFrom` 未设置并改为配置 `allowedRoles`：

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### 禁用 @ 提及要求

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

**检查访问控制：** 确保您的用户 ID 在 `allowFrom` 中，或暂时删除 `allowFrom` 并设置 `allowedRoles: ["all"]` 进行测试。

**检查机器人是否在频道中：** 机器人必须加入 `channel` 中指定的频道。

### 令牌问题

**"Failed to connect" 或认证错误：**

- 验证 `accessToken` 是 OAuth 访问令牌值（通常以 `oauth:` 前缀开头）
- 检查令牌是否有 `chat:read` 和 `chat:write` 范围
- 如果使用令牌刷新，验证设置了 `clientSecret` 和 `refreshToken`

### 令牌刷新不工作

**检查日志中的刷新事件：**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

如果您看到 "token refresh disabled (no refresh token)"：

- 确保提供了 `clientSecret`
- 确保提供了 `refreshToken`

## 配置

**账户配置：**

- `username` - 机器人用户名
- `accessToken` - 带有 `chat:read` 和 `chat:write` 的 OAuth 访问令牌
- `clientId` - Twitch Client ID（来自 Token Generator 或您的应用）
- `channel` - 要加入的频道（必需）
- `enabled` - 启用此账户（默认：`true`）
- `clientSecret` - 可选：用于自动令牌刷新
- `refreshToken` - 可选：用于自动令牌刷新
- `expiresIn` - 令牌过期时间（秒）
- `obtainmentTimestamp` - 令牌获取时间戳
- `allowFrom` - 用户 ID 白名单
- `allowedRoles` - 基于角色的访问控制（`"moderator" | "owner" | "vip" | "subscriber" | "all"`）
- `requireMention` - 需要 @ 提及（默认：`true`）

**提供商选项：**

- `channels.twitch.enabled` - 启用/禁用频道启动
- `channels.twitch.username` - 机器人用户名（简化的单账户配置）
- `channels.twitch.accessToken` - OAuth 访问令牌（简化的单账户配置）
- `channels.twitch.clientId` - Twitch Client ID（简化的单账户配置）
- `channels.twitch.channel` - 要加入的频道（简化的单账户配置）
- `channels.twitch.accounts.<accountName>` - 多账户配置（上述所有账户字段）

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

代理可以调用 `twitch` 操作：

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

- **将令牌视为密码** - 永远不要将令牌提交到 git
- **对长期运行的机器人使用自动令牌刷新**
- **使用用户 ID 白名单** 而不是用户名为访问控制
- **监控日志** 以了解令牌刷新事件和连接状态
- **最小化令牌范围** - 只请求 `chat:read` 和 `chat:write`
- **如果卡住**：在确认没有其他进程拥有会话后重启网关

## 限制

- **每条消息 500 个字符**（在单词边界自动分块）
- 分块前会剥离 Markdown
- 没有速率限制（使用 Twitch 的内置速率限制）

## 相关

- [频道概述](/channels) — 所有支持的频道
- [配对](/channels/pairing) — 私信认证和配对流程
- [群组](/channels/groups) — 群组聊天行为和提及门控
- [频道路由](/channels/channel-routing) — 消息的会话路由
- [安全](/gateway/security) — 访问模型和强化