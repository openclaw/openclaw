# OpenClaw 企业微信 (WeCom) AI 机器人插件

[简体中文](https://github.com/sunnoy/openclaw-plugin-wecom/blob/main/README_ZH.md) | [English](https://github.com/sunnoy/openclaw-plugin-wecom/blob/main/README.md)

`openclaw-plugin-wecom` 是一个专为 [OpenClaw](https://github.com/openclaw/openclaw) 框架开发的企业微信（WeCom）集成插件。它允许你将强大的 AI 能力无缝接入企业微信，并支持多项高级功能。

## 核心特性

- **流式输出 (Streaming)**: 基于企业微信最新的 AI 机器人流式分片机制，实现流畅的打字机式回复体验。
- **动态 Agent 管理**: 默认按"每个私聊用户 / 每个群聊"自动创建独立 Agent。每个 Agent 拥有独立的工作区与对话上下文，实现更强的数据隔离。
- **群聊深度集成**: 支持群聊消息解析，可通过 @提及（At-mention）精准触发机器人响应。
- **丰富消息类型**: 支持文本、图片、语音、图文混排、文件、位置、链接等消息类型。
- **入站图片解密**: 自动解密企业微信 AES-256-CBC 加密的图片，用于 AI 视觉分析。
- **出站图片发送**: 自动将本地图片（截图、生成的图像）进行 base64 编码，通过 `msg_item` API 发送。
- **消息防抖合并**: 同一用户在短时间内（2 秒内）连续发送的多条消息会自动合并为一次 AI 请求。
- **管理员用户**: 可配置管理员列表，绕过指令白名单和动态 Agent 路由限制。
- **指令白名单**: 内置常用指令支持（如 `/new`、`/status`），并提供指令白名单配置功能。
- **安全与认证**: 完整支持企业微信消息加解密、URL 验证及发送者身份校验。
- **高性能异步处理**: 采用异步消息处理架构，确保即使在长耗时 AI 推理过程中，企业微信网关也能保持高响应性。

## 前置要求

- 已安装 [OpenClaw](https://github.com/openclaw/openclaw) (版本 2026.1.30+)
- 企业微信管理后台权限，可创建智能机器人应用
- 可从企业微信访问的服务器地址（HTTP/HTTPS）

## 安装

```bash
openclaw plugins install @sunnoy/wecom
```

此命令会自动：

- 从 npm 下载插件
- 安装到 `~/.openclaw/extensions/` 目录
- 更新 OpenClaw 配置
- 注册插件

## 配置

在 OpenClaw 配置文件（`~/.openclaw/openclaw.json`）中添加：

```json
{
  "plugins": {
    "entries": {
      "wecom": {
        "enabled": true
      }
    }
  },
  "channels": {
    "wecom": {
      "enabled": true,
      "token": "你的 Token",
      "encodingAesKey": "你的 EncodingAESKey",
      "adminUsers": ["管理员userid"],
      "commands": {
        "enabled": true,
        "allowlist": ["/new", "/status", "/help", "/compact"]
      }
    }
  }
}
```

### 配置说明

| 配置项                              | 类型    | 必填 | 说明                                           |
| ----------------------------------- | ------- | ---- | ---------------------------------------------- |
| `plugins.entries.wecom.enabled`     | boolean | 是   | 启用插件                                       |
| `channels.wecom.token`              | string  | 是   | 企业微信机器人 Token                           |
| `channels.wecom.encodingAesKey`     | string  | 是   | 企业微信消息加密密钥（43 位）                  |
| `channels.wecom.adminUsers`         | array   | 否   | 管理员用户 ID 列表（绕过指令白名单和动态路由） |
| `channels.wecom.commands.allowlist` | array   | 否   | 允许的指令白名单                               |

## 企业微信后台配置

1. 登录[企业微信管理后台](https://work.weixin.qq.com/)
2. 进入"应用管理" > "应用" > "创建应用" > 选择"智能机器人"
3. 在"接收消息配置"中设置：
   - **URL**: `https://your-domain.com/webhooks/wecom`
   - **Token**: 与 `channels.wecom.token` 一致
   - **EncodingAESKey**: 与 `channels.wecom.encodingAesKey` 一致
4. 保存配置并启用消息接收

## 支持的消息类型

| 类型             | 方向  | 说明                                              |
| ---------------- | ----- | ------------------------------------------------- |
| 文本 (text)      | 收/发 | 纯文本消息                                        |
| 图片 (image)     | 收/发 | 入站图片自动解密；出站通过 `msg_item` base64 发送 |
| 语音 (voice)     | 收    | 企业微信自动转文字后处理（仅限私聊）              |
| 图文混排 (mixed) | 收    | 文本 + 图片混合消息                               |
| 文件 (file)      | 收    | 文件附件（下载后传给 AI 分析）                    |
| 位置 (location)  | 收    | 位置分享（转换为文本描述）                        |
| 链接 (link)      | 收    | 分享链接（提取标题、描述、URL 为文本）            |

## 管理员用户

管理员用户可以绕过指令白名单限制，并跳过动态 Agent 路由（直接路由到主 Agent）。

```json
{
  "channels": {
    "wecom": {
      "adminUsers": ["user1", "user2"]
    }
  }
}
```

管理员用户 ID 不区分大小写，匹配企业微信的 `userid` 字段。

## 动态 Agent 路由

本插件实现"按人/按群隔离"的 Agent 管理：

### 工作原理

1. 企业微信消息到达后，插件生成确定性的 `agentId`：
   - **私聊**: `wecom-dm-<userId>`
   - **群聊**: `wecom-group-<chatId>`
2. OpenClaw 自动创建/复用对应的 Agent 工作区
3. 每个用户/群聊拥有独立的对话历史和上下文
4. **管理员用户**跳过动态路由，直接使用主 Agent

### 高级配置

配置在 `channels.wecom` 下：

```json
{
  "channels": {
    "wecom": {
      "dynamicAgents": {
        "enabled": true
      },
      "dm": {
        "createAgentOnFirstMessage": true
      },
      "groupChat": {
        "enabled": true,
        "requireMention": true
      }
    }
  }
}
```

| 配置项                         | 类型    | 默认值 | 说明                  |
| ------------------------------ | ------- | ------ | --------------------- |
| `dynamicAgents.enabled`        | boolean | `true` | 是否启用动态 Agent    |
| `dm.createAgentOnFirstMessage` | boolean | `true` | 私聊使用动态 Agent    |
| `groupChat.enabled`            | boolean | `true` | 启用群聊处理          |
| `groupChat.requireMention`     | boolean | `true` | 群聊必须 @ 提及才响应 |

### 禁用动态 Agent

如果需要所有消息进入默认 Agent：

```json
{
  "channels": {
    "wecom": {
      "dynamicAgents": { "enabled": false }
    }
  }
}
```

## 指令白名单

为防止普通用户通过企业微信消息执行敏感的 Gateway 管理指令，本插件支持**指令白名单**机制。

```json
{
  "channels": {
    "wecom": {
      "commands": {
        "enabled": true,
        "allowlist": ["/new", "/status", "/help", "/compact"]
      }
    }
  }
}
```

### 推荐白名单指令

| 指令       | 说明                       | 安全级别 |
| ---------- | -------------------------- | -------- |
| `/new`     | 重置当前对话，开启全新会话 | 用户级   |
| `/compact` | 压缩当前会话上下文         | 用户级   |
| `/help`    | 查看帮助信息               | 用户级   |
| `/status`  | 查看当前 Agent 状态        | 用户级   |

> **安全提示**：不要将 `/gateway`、`/plugins` 等管理指令添加到白名单，避免普通用户获得 Gateway 实例的管理权限。配置在 `adminUsers` 中的管理员不受此限制。

## 消息防抖合并

当用户在短时间内（2 秒内）连续发送多条消息时，插件会自动将它们合并为一次 AI 请求。这样可以避免同一用户触发多个并发的 LLM 调用，提供更连贯的回复。

- 第一条消息的流式通道接收 AI 回复
- 后续被合并的消息会显示已合并的提示
- 指令消息（以 `/` 开头）不参与防抖，会立即处理

## 常见问题 (FAQ)

### Q: 入站图片是怎么处理的？

**A:** 企业微信使用 AES-256-CBC 加密用户发送的图片。插件会自动：

1. 从企业微信的 URL 下载加密图片
2. 使用配置的 `encodingAesKey` 解密
3. 保存到本地并传给 AI 进行视觉分析

图文混排消息也完全支持——文本和图片会一起提取并发送给 AI。

### Q: 出站图片发送是如何工作的？

**A:** 插件会自动处理 OpenClaw 生成的图片（如浏览器截图）：

- **本地图片**（来自 `~/.openclaw/media/`）会自动进行 base64 编码，通过企业微信 `msg_item` API 发送
- **图片限制**：单张图片最大 2MB，支持 JPG 和 PNG 格式，每条消息最多 10 张图片
- **无需配置**：开箱即用，配合浏览器截图等工具自动生效
- 图片会在 AI 完成回复后显示（流式输出不支持增量发送图片）

如果图片处理失败（超出大小限制、格式不支持等），文本回复仍会正常发送，错误信息会记录在日志中。

### Q: 机器人支持语音消息吗？

**A:** 支持！私聊中的语音消息会被企业微信自动转录为文字并作为文本处理，无需额外配置。

### Q: 机器人支持文件消息吗？

**A:** 支持。用户发送的文件会被下载并作为附件传给 AI。AI 可以分析文件内容（如读取 PDF 或解析代码文件）。MIME 类型根据文件扩展名自动检测。

### Q: OpenClaw 开放公网需要 auth token，企业微信回调如何配置？

**A:** 企业微信机器人**不需要**配置 OpenClaw 的 Gateway Auth Token。

- **Gateway Auth Token** (`gateway.auth.token`) 主要用于：
  - WebUI 访问认证
  - WebSocket 连接认证
  - CLI 远程连接认证

- **企业微信 Webhook** (`/webhooks/wecom`) 的认证机制：
  - 使用企业微信自己的签名验证（Token + EncodingAESKey）
  - 不需要 Gateway Auth Token
  - OpenClaw 插件系统会自动处理 webhook 路由

**部署建议：**

1. 如果使用反向代理（如 Nginx），可以为 `/webhooks/wecom` 路径配置豁免认证
2. 或者将 webhook 端点暴露在独立端口，不经过 Gateway Auth

### Q: EncodingAESKey 长度验证失败怎么办？

**A:** 常见原因和解决方法：

1. **检查配置键名**：确保使用正确的键名 `encodingAesKey`（注意大小写）

   ```json
   {
     "channels": {
       "wecom": {
         "encodingAesKey": "..."
       }
     }
   }
   ```

2. **检查密钥长度**：EncodingAESKey 必须是 43 位字符

   ```bash
   # 检查长度
   echo -n "你的密钥" | wc -c
   ```

3. **检查是否有多余空格/换行**：确保密钥字符串前后没有空格或换行符

## 项目结构

```
openclaw-plugin-wecom/
├── index.js              # 插件入口
├── webhook.js            # 企业微信 HTTP 通信处理
├── dynamic-agent.js      # 动态 Agent 分配逻辑
├── stream-manager.js     # 流式回复管理
├── image-processor.js    # 图片编码/校验（msg_item）
├── crypto.js             # 企业微信加密算法（消息 + 媒体）
├── logger.js             # 日志模块
├── utils.js              # 工具函数（TTL 缓存、消息去重）
├── package.json          # npm 包配置
└── openclaw.plugin.json  # OpenClaw 插件清单
```

## 贡献规范

我们非常欢迎开发者参与贡献！如果你发现了 Bug 或有更好的功能建议，请提交 Issue 或 Pull Request。

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)

## 开源协议

本项目采用 [ISC License](./LICENSE) 协议。
