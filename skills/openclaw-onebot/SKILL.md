---
name: openclaw-onebot
description: OneBot 11 channel plugin for QQ via NapCat/go-cqhttp. Native OpenClaw integration for private and group chat, group reactions, block streaming, voice pipeline, and allowFrom routing. 106 tests passing.
---

# OpenClaw OneBot 11 Channel Plugin

[中文](#中文) | [English](#english)

---

## 中文

OpenClaw 的 **OneBot 11 协议通道插件**，让 QQ 成为 OpenClaw 一等消息通道。

支持 [NapCat](https://github.com/NapNeko/NapCatQQ)、[go-cqhttp](https://github.com/Mrs4s/go-cqhttp) 等所有兼容 OneBot 11 协议的 QQ 机器人框架。

说明：

- 插件 `id` 是 `openclaw-onebot`
- 通道 `id` 仍然是 `onebot`
- 因此 `plugins.allow` / `plugins.entries` / `plugins.installs` 使用 `openclaw-onebot`
- `channels.onebot` 保持不变

### 功能

- 原生 OpenClaw ChannelPlugin 集成
- QQ 私聊和群聊收发
- 群聊 reaction
- 群聊自动 reaction，默认开启
- OpenClaw block streaming 分块回复
- QQ 语音链路：SILK/AMR -> MP3 -> STT/TTS -> sendRecord
- 图片、语音、文件附件发送
- `allowFrom` 来源过滤
- WebSocket 自动重连
- OpenClaw 文本命令全支持（`/status`、`/help`、`/commands`、`/model`、`/new`、`/reset` 等）
- 106 个测试用例通过
- 覆盖率：Statements/Lines 92.11%，Branches 83.68%，Functions 95.16%

### 为什么选它

相对 QQ 官方 Bot API 方案：

- 保留 OneBot 生态兼容性
- 直接进入 OpenClaw 原生消息路由
- 更适合 NapCat / go-cqhttp 现有部署

相对独立 Python 桥接脚本方案：

- 不需要额外 listener 或文件队列
- 不需要自己维护消息桥接逻辑
- block streaming、group reaction、voice pipeline 都在同一插件里
- 测试覆盖更完整

### 能力边界

- 群聊 reaction 可用
- QQ 私聊 reaction 目前不可靠，不应作为稳定能力依赖
- streaming 这里指 OpenClaw `block streaming`
- QQ 端表现为连续多条分块消息，不是“编辑同一条消息”

### OpenClaw 侧最小配置

```json
{
  "plugins": {
    "allow": ["openclaw-onebot"],
    "entries": {
      "openclaw-onebot": {
        "enabled": true
      }
    }
  },
  "channels": {
    "onebot": {
      "enabled": true,
      "wsUrl": "ws://your-host:3001",
      "httpUrl": "http://your-host:3001",
      "groupAutoReact": true,
      "groupAutoReactEmojiId": 1
    }
  }
}
```

如果你希望 QQ 支持 block streaming，还需要：

```json
{
  "agents": {
    "defaults": {
      "blockStreamingDefault": "on"
    }
  }
}
```

可选调优：

```json
{
  "channels": {
    "onebot": {
      "blockStreamingCoalesce": {
        "minChars": 80,
        "idleMs": 600
      }
    }
  }
}
```

### 常用参数

- `channels.onebot.wsUrl`: OneBot WebSocket 地址
- `channels.onebot.httpUrl`: OneBot HTTP API 地址
- `channels.onebot.accessToken`: 可选鉴权 token
- `channels.onebot.allowFrom`: 允许的私聊/群聊来源
- `channels.onebot.groupAutoReact`: 群聊自动 reaction 开关，默认 `true`
- `channels.onebot.groupAutoReactEmojiId`: 默认群聊 reaction emoji id，默认 `1`
- `agents.defaults.blockStreamingDefault`: 是否默认开启 block streaming

### 目标格式

- `private:<QQ号>` -> 私聊
- `group:<群号>` -> 群聊
- `<QQ号>` -> 自动识别为私聊

### 使用前建议

- 先查看 GitHub 仓库：`https://github.com/xucheng/openclaw-onebot`
- 安装前先备份 `~/.openclaw/openclaw.json`
- 如果要执行安装、改配置、重启 gateway，应先确认影响范围
- 如果更在意供应链安全，建议固定到指定 tag 或 commit 再安装

### 安装后建议验证

```bash
cd ~/.openclaw/local-plugins/openclaw-onebot
npm test
openclaw status --deep
```

成功标准：

- 测试通过
- `OneBot = ON / OK`
- QQ 能正常收发
- 群聊 reaction 生效
- 开启 streaming 后日志能看到 `deliver(block)`

---

## English

An **OpenClaw OneBot 11 channel plugin** that makes QQ a first-class OpenClaw channel.

Works with [NapCat](https://github.com/NapNeko/NapCatQQ), [go-cqhttp](https://github.com/Mrs4s/go-cqhttp), and other OneBot 11 compatible QQ bot frameworks.

Notes:

- Plugin id: `openclaw-onebot`
- Channel id: `onebot`
- Use `openclaw-onebot` for `plugins.allow` / `plugins.entries` / `plugins.installs`
- Use `channels.onebot` for runtime channel config

### Features

- Native OpenClaw ChannelPlugin integration
- QQ private and group messaging
- Group reactions
- Automatic group reactions enabled by default
- OpenClaw block streaming
- Voice pipeline for QQ voice messages
- Attachments for images, voice, and files
- `allowFrom` filtering
- WebSocket auto-reconnect
- 106 tests passing
- Coverage: Statements/Lines 92.11%, Branches 83.68%, Functions 95.16%

### Why choose it

Compared with the QQ official bot API route:

- keeps compatibility with the OneBot ecosystem
- plugs directly into OpenClaw native routing
- fits existing NapCat / go-cqhttp deployments better

Compared with standalone Python bridge scripts:

- no extra listener or file-queue bridge
- no custom routing glue to maintain
- block streaming, group reactions, and voice pipeline live in one plugin
- better test coverage

### Capability boundaries

- Group reactions are supported
- Private-chat reactions are not reliable
- Streaming here means OpenClaw `block streaming`
- QQ receives multiple chunked messages, not in-place message edits

### Minimal OpenClaw config

```json
{
  "plugins": {
    "allow": ["openclaw-onebot"],
    "entries": {
      "openclaw-onebot": {
        "enabled": true
      }
    }
  },
  "channels": {
    "onebot": {
      "enabled": true,
      "wsUrl": "ws://your-host:3001",
      "httpUrl": "http://your-host:3001",
      "groupAutoReact": true,
      "groupAutoReactEmojiId": 1
    }
  }
}
```

To enable block streaming:

```json
{
  "agents": {
    "defaults": {
      "blockStreamingDefault": "on"
    }
  }
}
```

Optional tuning:

```json
{
  "channels": {
    "onebot": {
      "blockStreamingCoalesce": {
        "minChars": 80,
        "idleMs": 600
      }
    }
  }
}
```

### Common settings

- `channels.onebot.wsUrl`: OneBot WebSocket URL
- `channels.onebot.httpUrl`: OneBot HTTP API URL
- `channels.onebot.accessToken`: optional auth token
- `channels.onebot.allowFrom`: allowed private/group sources
- `channels.onebot.groupAutoReact`: group auto-reaction switch, default `true`
- `channels.onebot.groupAutoReactEmojiId`: default group emoji id, default `1`
- `agents.defaults.blockStreamingDefault`: default block streaming behavior

### Before installing

- review the GitHub repository: `https://github.com/xucheng/openclaw-onebot`
- back up `~/.openclaw/openclaw.json`
- understand the effect of install/config changes/gateway restart before applying
- if supply-chain trust matters, pin to a specific tag or commit first

### Suggested verification

```bash
cd ~/.openclaw/local-plugins/openclaw-onebot
npm test
openclaw status --deep
```

Expected:

- tests pass
- `OneBot = ON / OK`
- QQ messages round-trip
- group reactions are visible
- `deliver(block)` appears in logs when streaming is enabled
