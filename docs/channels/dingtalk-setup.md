# DingTalk Channel 配置指南

本文档详细说明如何配置 DingTalk channel，包括需要的信息、配置步骤和常见场景。

## 前置准备：获取 DingTalk 凭证

在配置 OpenClaw 之前，你需要从钉钉开放平台获取以下信息：

### 1. 创建钉钉应用

1. 访问 [钉钉开放平台](https://open.dingtalk.com/)
2. 登录你的钉钉企业账号
3. 进入「应用开发」→「企业内部开发」→「H5微应用」或「小程序」
4. 点击「创建应用」，填写应用信息：
   - 应用名称：例如 "OpenClaw Bot"
   - 应用描述：可选
   - 应用图标：可选
5. 创建完成后，记录应用的 **AppKey** 和 **AppSecret**

### 2. 配置应用权限

在应用详情页面，需要配置以下权限：

- **通讯录权限**：读取用户信息（用于用户识别和配对）
- **消息权限**：接收消息（用于接收用户消息）
- **群聊权限**：读取群聊信息（如果需要在群组中使用）

### 3. 启用 Stream 模式

1. 在应用详情页面，找到「开发管理」→「连接方式」
2. 选择「Stream 模式」（流式模式）
3. 确认启用 Stream 模式（不需要配置 webhook URL）

### 4. 获取必要信息

配置 OpenClaw 需要以下信息：

| 信息 | 说明 | 获取位置 |
|------|------|----------|
| **AppKey** | 应用的唯一标识 | 应用详情页面的「基本信息」→「AppKey」 |
| **AppSecret** | 应用的密钥 | 应用详情页面的「基本信息」→「AppSecret」（点击显示） |

## 配置步骤

### 方法 1：使用 CLI 配置向导（推荐）

1. **安装 DingTalk 插件**

```bash
openclaw plugins install @openclaw/dingtalk
```

如果是从源码运行：

```bash
openclaw plugins install ./extensions/dingtalk
```

2. **运行配置向导**

```bash
openclaw configure
```

在向导中选择 DingTalk，然后按提示输入：
- AppKey
- AppSecret

3. **配置访问控制**（可选）

向导会询问：
- DM 访问策略（默认：配对模式）
- 群组访问策略（默认：白名单模式）
- 允许的用户列表

### 方法 2：手动编辑配置文件

编辑 `~/.openclaw/openclaw.json`（或你的配置文件路径）：

```json5
{
  channels: {
    dingtalk: {
      enabled: true,
      appKey: "your-app-key-here",
      appSecret: "your-app-secret-here"
    }
  }
}
```

### 方法 3：使用环境变量

你也可以通过环境变量设置凭证：

```bash
export DINGTALK_APP_KEY="your-app-key-here"
export DINGTALK_APP_SECRET="your-app-secret-here"
```

然后在配置文件中只需启用：

```json5
{
  channels: {
    dingtalk: {
      enabled: true
    }
  }
}
```

## 配置示例

### 基础配置（最小配置）

```json5
{
  channels: {
    dingtalk: {
      enabled: true,
      appKey: "dingxxxxxxxxxxxx",
      appSecret: "your-secret-here"
    }
  }
}
```

### 完整配置示例

```json5
{
  channels: {
    dingtalk: {
      enabled: true,
      appKey: "dingxxxxxxxxxxxx",
      appSecret: "your-secret-here",
      
      // 访问控制
      dmPolicy: "pairing",  // DM 策略：pairing（配对模式）或 open（开放模式）
      allowFrom: ["user123", "user456"],  // 允许的 DM 发送者（用户 ID）
      groupPolicy: "allowlist",  // 群组策略：open（开放）、allowlist（白名单）、disabled（禁用）
      groupAllowFrom: ["user123"],  // 允许的群组发送者
      
      // 消息设置
      requireMention: true,  // 群组中是否需要 @mention（默认：true）
      textChunkLimit: 4000,  // 消息分块大小（字符数）
      chunkMode: "length",  // 分块模式：length（按长度）或 newline（按换行）
      historyLimit: 50,  // 群组历史消息数量（0=禁用）
      dmHistoryLimit: 20,  // DM 历史消息数量
      
      // 媒体设置
      mediaMaxMb: 20,  // 最大媒体文件大小（MB）
      mediaAllowHosts: ["*.dingtalk.com"],  // 允许的媒体主机后缀
      
      // 群组级配置
      groups: {
        "groupId123": {
          requireMention: true,  // 此群组是否需要 @mention
          channels: {
            "channelId456": {
              requireMention: false  // 此频道不需要 @mention
            }
          }
        }
      },
      
      // 高级设置
      configWrites: true,  // 允许通过 channel 更新配置
      capabilities: ["text", "media"],  // 能力标签
    }
  }
}
```

## 常见配置场景

### 场景 1：仅允许特定用户使用（DM + 群组）

```json5
{
  channels: {
    dingtalk: {
      enabled: true,
      appKey: "your-app-key",
      appSecret: "your-app-secret",
      dmPolicy: "pairing",
      allowFrom: ["user123", "user456"],  // 允许的用户 ID
      groupPolicy: "allowlist",
      groupAllowFrom: ["user123", "user456"]  // 群组中也只允许这些用户
    }
  }
}
```

### 场景 2：开放 DM，群组需要 @mention

```json5
{
  channels: {
    dingtalk: {
      enabled: true,
      appKey: "your-app-key",
      appSecret: "your-app-secret",
      dmPolicy: "open",  // DM 开放给所有人
      allowFrom: ["*"],  // 允许所有用户
      groupPolicy: "open",  // 群组开放
      requireMention: true  // 但需要 @mention
    }
  }
}
```

### 场景 3：仅允许特定群组

```json5
{
  channels: {
    dingtalk: {
      enabled: true,
      appKey: "your-app-key",
      appSecret: "your-app-secret",
      groupPolicy: "allowlist",
      groups: {
        "groupId123": {
          requireMention: true
        },
        "groupId456": {
          requireMention: false
        }
      }
    }
  }
}
```

### 场景 4：禁用群组，仅使用 DM

```json5
{
  channels: {
    dingtalk: {
      enabled: true,
      appKey: "your-app-key",
      appSecret: "your-app-secret",
      groupPolicy: "disabled"  // 禁用所有群组
    }
  }
}
```

## 配置验证

配置完成后，验证配置是否正确：

```bash
# 检查配置状态
openclaw channels status

# 探测 DingTalk 连接
openclaw channels status --probe
```

如果配置正确，你应该看到：

```
dingtalk:
  configured: true
  running: false
  probe: { ok: true, appKey: "dingxxxxxxxxxxxx" }
```

## 启动 Gateway

配置完成后，启动 gateway：

```bash
openclaw gateway run
```

如果使用 macOS app，gateway 会自动启动。

## 获取用户 ID

配置 `allowFrom` 或 `groupAllowFrom` 时，你需要知道用户的 DingTalk 用户 ID。可以通过以下方式获取：

1. **通过 DingTalk API**：使用钉钉开放平台的 API 查询用户信息
2. **通过日志**：当用户首次发送消息时，OpenClaw 会在日志中记录用户 ID
3. **通过配对流程**：在配对模式下，用户首次发送消息时会触发配对请求

## 配对流程（DM Policy: pairing）

当 `dmPolicy: "pairing"` 时：

1. 用户首次发送 DM 消息
2. OpenClaw 检测到未配对的用户
3. 发送配对提示消息
4. 管理员需要批准配对（通过配置或 CLI）
5. 批准后，用户才能正常使用

批准配对：

```bash
# 查看待配对的用户
openclaw channels pairing list

# 批准配对
openclaw channels pairing approve dingtalk user123
```

## 故障排查

### 问题 1：连接失败

**症状**：`probe: { ok: false, error: "..." }`

**可能原因**：
- AppKey 或 AppSecret 错误
- 应用未启用 Stream 模式
- 网络连接问题

**解决方法**：
1. 检查 AppKey 和 AppSecret 是否正确
2. 确认应用已启用 Stream 模式
3. 检查网络连接和防火墙设置

### 问题 2：收不到消息

**症状**：配置正确但收不到消息

**可能原因**：
- 用户不在 allowlist 中
- 群组策略限制
- 需要 @mention 但未 @

**解决方法**：
1. 检查 `allowFrom` 或 `groupAllowFrom` 配置
2. 检查 `groupPolicy` 设置
3. 检查 `requireMention` 设置
4. 查看日志：`openclaw channels status --deep`

### 问题 3：无法发送消息

**症状**：能收到消息但无法回复

**可能原因**：
- 应用权限不足
- 用户 ID 格式错误
- Stream SDK 连接问题

**解决方法**：
1. 检查应用权限配置
2. 确认用户 ID 格式正确（通常是数字字符串）
3. 检查 Stream SDK 连接状态

## 安全建议

1. **保护凭证**：
   - 不要将 AppSecret 提交到版本控制系统
   - 使用环境变量或配置文件权限保护
   - 定期轮换 AppSecret

2. **访问控制**：
   - 使用 `allowlist` 模式限制访问
   - 群组中使用 `requireMention` 避免误触发
   - 定期审查 `allowFrom` 列表

3. **监控**：
   - 定期检查日志
   - 监控异常消息
   - 设置告警

## 参考资源

- [DingTalk 开放平台文档](https://open.dingtalk.com/document/)
- [DingTalk Stream SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)
- [OpenClaw 配置文档](/configuration)
- [DingTalk Channel 文档](/channels/dingtalk)
