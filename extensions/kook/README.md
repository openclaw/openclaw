# KOOK Channel Extension

KOOK (开黑啦) 频道扩展，用于 Clawdbot 接入 KOOK 平台。

## 功能特性

- ✅ WebSocket Gateway 连接
- ✅ 实时消息接收与发送
- ✅ 支持多种消息类型（文字、图片、视频、KMarkdown、Card）
- ✅ 私聊消息支持
- ✅ 群组频道支持
- ✅ 消息引用回复
- ✅ DM 策略管理（allowlist/pairing/open）
- ✅ 群组策略管理（allowlist/open/disabled）
- ✅ 多账户支持

## 配置示例

### 基础配置

```json
{
  "channels": {
    "kook": {
      "enabled": true,
      "token": "your-bot-token-here",
      "dm": {
        "policy": "allowlist",
        "allowFrom": ["user_id_1", "user_id_2"]
      },
      "groupPolicy": "allowlist",
      "guilds": {
        "guild_id_here": {
          "slug": "my-guild",
          "requireMention": false,
          "channels": {
            "channel_id_here": {
              "allow": true
            }
          }
        }
      }
    }
  }
}
```

### 使用环境变量

```bash
export KOOK_BOT_TOKEN="your-bot-token"
```

配置文件：

```json
{
  "channels": {
    "kook": {
      "enabled": true
    }
  }
}
```

### 多账户配置

```json
{
  "channels": {
    "kook": {
      "enabled": true,
      "accounts": {
        "default": {
          "name": "Main Bot",
          "token": "token1",
          "dm": {
            "policy": "allowlist",
            "allowFrom": ["user1"]
          }
        },
        "secondary": {
          "name": "Secondary Bot",
          "token": "token2",
          "dm": {
            "policy": "open"
          }
        }
      }
    }
  }
}
```

## 配置选项

### 频道级别

| 选项             | 类型     | 默认值      | 说明                              |
| ---------------- | -------- | ----------- | --------------------------------- |
| `enabled`        | boolean  | false       | 是否启用 KOOK 频道                |
| `token`          | string   | -           | Bot Token（默认账户）             |
| `dm.policy`      | string   | "allowlist" | 私聊策略：allowlist/pairing/open  |
| `dm.allowFrom`   | string[] | []          | 允许私聊的用户 ID 列表            |
| `groupPolicy`    | string   | "disabled"  | 群组策略：allowlist/open/disabled |
| `guilds`         | object   | {}          | 服务器配置                        |
| `historyLimit`   | number   | 10          | 历史消息数量限制                  |
| `mediaMaxMb`     | number   | 10          | 媒体文件大小限制（MB）            |
| `textChunkLimit` | number   | 2000        | 文本分块大小限制                  |
| `replyToMode`    | string   | "off"       | 引用回复模式：off/first/all       |

### 账户级别

每个账户可以单独配置以上所有选项。

## 使用说明

### 1. 创建 KOOK Bot

1. 访问 [KOOK 开发者中心](https://developer.kookapp.cn/)
2. 创建应用并获取 Bot Token
3. 配置 Bot 权限和 Intents

### 2. 配置 Clawdbot

使用 `clawdbot setup` 命令或手动编辑配置文件。

### 3. 启动 Gateway

```bash
pnpm clawdbot gateway
```

应该看到日志：

```
[kook] connected
[kook] HELLO received, session=xxx
```

### 4. 测试

在 KOOK 中给你的 Bot 发送消息，它应该能够回复。

## 消息格式

### 发送消息到频道

```typescript
await runtime.channel.kook.sendMessageKook(
  "channel:1234567890", // 或直接 "1234567890"
  "Hello KOOK!",
);
```

### 发送私聊消息

```typescript
await runtime.channel.kook.sendDirectMessageKook(
  "user:0987654321", // 或直接 "0987654321"
  "Hello user!",
);
```

### 发送 KMarkdown

```typescript
await runtime.channel.kook.sendMessageKook(
  "1234567890",
  "**Bold** *Italic* `Code`",
  { type: 9 }, // 9 = KMarkdown
);
```

## 支持的消息类型

| 类型      | Type 值 | 说明              |
| --------- | ------- | ----------------- |
| 文字      | 1       | 纯文本消息        |
| 图片      | 2       | 图片消息          |
| 视频      | 3       | 视频消息          |
| 文件      | 4       | 文件消息          |
| KMarkdown | 9       | Markdown 格式消息 |
| Card      | 10      | 卡片消息          |
| 道具      | 12      | 道具消息          |

## 故障排除

### 无法连接

1. 检查 Token 是否正确
2. 检查网络连接（KOOK API 在中国可能需要代理）
3. 查看 Gateway 日志

### 收不到消息

1. 检查 DM/Group 策略配置
2. 确认用户/频道在 allowlist 中
3. 检查 Bot 权限

### Token 无效

确保 Token 格式正确，不需要 "Bot " 前缀（系统会自动添加）。

## API 参考

完整 API 文档请参考 `src/kook/` 目录中的源码和类型定义。

## License

MIT
