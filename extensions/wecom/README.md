# OpenClaw WeCom Plugin / 企业微信插件

[English](#english) | [中文](#中文)

> The official Enterprise WeChat (WeCom) channel plugin for [OpenClaw](https://github.com/openclaw/openclaw). 7,200+ lines of battle-tested code powering real businesses.

---

<a id="english"></a>

## English

### Why This Plugin?

Most WeCom plugins on the market are simple webhook forwarders. This plugin was forged in a **real enterprise production environment**, solving problems that other plugins ignore:

| Problem | Other Plugins | This Plugin |
|---------|--------------|-------------|
| Message loss | Single-layer delivery, lost on failure | **4-layer fallback delivery**, 100% guaranteed |
| User crosstalk | Shared global Agent | **Dynamic Agent routing**, per-user/per-group isolation |
| Duplicate processing | Every message triggers AI | **2-second debounce merge**, saves API calls |
| Text-only | No image/file support | **AES-256-CBC decryption** + image pipeline |
| Single bot | One instance, one bot | **Multi-bot instances** + conflict detection |
| Single mode | Bot mode only | **3 modes**: Bot + Agent + Webhook |

### Core Features

#### 3 Operating Modes

- **AI Bot Mode** — JSON streaming callbacks for group/DM AI conversations
- **Self-built Agent Mode** — XML callbacks for proactive messaging, file transfer, KF customer service
- **Webhook Bot Mode** — Group notifications and alerts

#### 4-Layer Message Delivery Fallback

```
Layer 1: Stream Channel (streaming reply, normal path)
    ↓ fails
Layer 2: response_url (one-time callback URL, valid 1 hour)
    ↓ fails
Layer 3: Webhook Bot / KF API (group notifications / customer service)
    ↓ fails
Layer 4: Agent API (application message API as last resort)
```

Each layer automatically degrades to the next on failure, ensuring 100% message delivery.

#### Dynamic Agent Routing

- DM auto-creates isolated Agent: `wecom-dm-{userId}`
- Group auto-creates isolated Agent: `wecom-group-{chatId}`
- Multi-account namespace isolation: `wecom-sales-dm-{userId}`
- Complete user isolation, zero crosstalk

#### Encrypted Media Handling

- Automatic AES-256-CBC decryption of WeCom encrypted images
- Local image queue + Agent API upload pipeline
- Non-image files auto-routed via DM (group file → DM delivery + group notification)

#### Multi-Bot Instance Management

- Run multiple WeCom bots on a single OpenClaw instance
- Automatic token/agentId conflict detection
- Independent configuration and routing per bot

#### Additional Features

- **Workspace Templates**: Auto-bootstrap new Agents (AGENTS.md / BOOTSTRAP.md / CLAUDE.md)
- **Command Allowlist**: `/new`, `/compact`, `/help`, `/status`
- **Admin Users**: Bypass command restrictions
- **Welcome Messages**: Auto-send on `enter_chat` events
- **Memory Leak Prevention**: Auto-cleanup of expired streamMeta and responseUrl entries

### Quick Start

One command to install, works out of the box:

```bash
openclaw plugins install @openclaw/wecom
```

After installation, select **WeCom / 企业微信** in `openclaw onboard` wizard for interactive setup.

#### Manual Configuration (optional)

Skip the wizard and edit `~/.openclaw/openclaw.json` directly:

```jsonc
{
  "channels": {
    "wecom": {
      "enabled": true,
      // Get these from WeCom admin console
      "token": "your-bot-token",
      "encodingAesKey": "your-43-char-encoding-aes-key",
      // Agent mode (optional — enables proactive messaging and file transfer)
      "agent": {
        "corpId": "your-corp-id",
        "corpSecret": "your-corp-secret",
        "agentId": 1000002
      }
    }
  }
}
```

> Dynamic agent routing, group chat, message debounce are **enabled by default** — no extra config needed.

#### WeCom Admin Setup

1. Log in to [WeCom Admin Console](https://work.weixin.qq.com/)
2. Create an AI Bot or self-built application
3. Set callback URL: `https://your-openclaw-domain/webhooks/wecom`
4. Copy Token and EncodingAESKey to the config above
5. Restart OpenClaw: `openclaw gateway restart`

### Architecture

```
┌──────────────────────────────────────────────┐
│              OpenClaw Runtime                  │
├──────────────────────────────────────────────┤
│           @openclaw/wecom Plugin                │
│                                               │
│  ┌─────────┐  ┌─────────┐  ┌──────────────┐ │
│  │ AI Bot  │  │  Agent   │  │ Webhook Bot  │ │
│  │  Mode   │  │  Mode    │  │    Mode      │ │
│  └────┬────┘  └────┬────┘  └──────┬───────┘ │
│       │            │              │          │
│  ┌────▼────────────▼──────────────▼───────┐  │
│  │        4-Layer Delivery Engine          │  │
│  │  Stream → response_url → Webhook → API │  │
│  └────────────────────────────────────────┘  │
│                                               │
│  ┌──────────────┐  ┌───────────────────────┐ │
│  │ Dynamic Agent│  │ Encrypted Media       │ │
│  │   Routing    │  │   Pipeline            │ │
│  └──────────────┘  └───────────────────────┘ │
│                                               │
│  ┌──────────────┐  ┌───────────────────────┐ │
│  │  Multi-Bot   │  │ Message Debounce      │ │
│  │  Manager     │  │   & Merge             │ │
│  └──────────────┘  └───────────────────────┘ │
└──────────────────────────────────────────────┘
```

### Configuration Reference

| Config | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | boolean | `true` | Enable WeCom channel |
| `token` | string | — | Bot Token |
| `encodingAesKey` | string | — | 43-char encryption key |
| `dynamicAgents.enabled` | boolean | `true` | Enable dynamic Agent routing |
| `dm.createAgentOnFirstMessage` | boolean | `true` | Auto-create Agent per DM user |
| `groupChat.enabled` | boolean | `true` | Enable group chat support |
| `groupChat.requireMention` | boolean | `true` | Require @mention in groups |
| `adminUsers` | string[] | `[]` | Admin user list |
| `agent.corpId` | string | — | Enterprise Corp ID |
| `agent.corpSecret` | string | — | Application Secret |
| `agent.agentId` | number | — | Application Agent ID |
| `webhooks` | object | — | Webhook Bot URL mapping |
| `instances` | array | — | Multi-bot instance configs |

---

<a id="中文"></a>

## 中文

### 为什么选择这个插件？

市面上的企微插件大多只是简单的 webhook 转发器。这个插件是从**真实企业生产环境**中打磨出来的，解决了其他插件没有解决的核心问题：

| 问题 | 其他插件 | 本插件 |
|------|----------|--------|
| 消息丢失 | 单层投递，失败就丢 | **4 层回退投递**，100% 送达 |
| 用户串话 | 全局共享一个 Agent | **动态 Agent 路由**，每用户/每群独立隔离 |
| 连续消息重复处理 | 每条消息都触发 AI | **2 秒去抖合并**，节省 API 调用 |
| 只支持文本 | 不支持图片/文件 | **AES-256-CBC 解密** + 图片处理管线 |
| 单 Bot 限制 | 一个实例一个 Bot | **多 Bot 实例** + 冲突自动检测 |
| 部署模式单一 | 只有 Bot 模式 | **3 种模式**：Bot + Agent + Webhook |

### 核心特性

#### 3 种运行模式

- **AI Bot 模式** — JSON 流式回调，支持群聊/私聊 AI 对话
- **自建应用 Agent 模式** — XML 回调，支持主动推送、文件收发、KF 客服
- **Webhook Bot 模式** — 群通知、告警推送

#### 4 层消息投递回退

```
Layer 1: Stream Channel（流式回复，正常路径）
    ↓ 失败
Layer 2: response_url（一次性回调 URL，1 小时有效）
    ↓ 失败
Layer 3: Webhook Bot / KF API（群通知 / 客服会话）
    ↓ 失败
Layer 4: Agent API（应用消息接口兜底）
```

任何一层失败自动降级到下一层，保证消息 100% 送达。

#### 动态 Agent 路由

- 私聊自动创建独立 Agent：`wecom-dm-{userId}`
- 群聊自动创建独立 Agent：`wecom-group-{chatId}`
- 多账号命名空间隔离：`wecom-sales-dm-{userId}`
- 用户之间完全隔离，互不干扰

#### 企微加密媒体处理

- 自动 AES-256-CBC 解密企微加密图片
- 本地图片队列 + Agent API 上传回传
- 非图片文件自动走私信投递（群聊中发文件 → 私信送达 + 群内提示）

#### 多 Bot 实例管理

```json
{
  "instances": [
    { "name": "sales-bot", "token": "...", "agent": { "corpId": "..." } },
    { "name": "support-bot", "token": "...", "agent": { "corpId": "..." } }
  ]
}
```

- 一个 OpenClaw 实例运行多个企微 Bot
- 自动检测 token / agentId 冲突
- 每个 Bot 独立配置、独立路由

#### 其他特性

- **Workspace 模板**：自动引导新 Agent 启动（AGENTS.md / BOOTSTRAP.md / CLAUDE.md）
- **命令白名单**：`/new`、`/compact`、`/help`、`/status` 等
- **管理员用户**：绕过命令限制
- **进群欢迎语**：`enter_chat` 事件自动发送欢迎消息
- **内存泄漏防护**：自动清理过期 streamMeta 和 responseUrl

### 快速开始

一条命令安装，开箱即用：

```bash
openclaw plugins install @openclaw/wecom
```

安装后在 `openclaw onboard` 向导中选择 **WeCom / 企业微信** 即可进入交互式配置。

#### 手动配置（可选）

如果你想跳过向导，手动编辑 `~/.openclaw/openclaw.json`：

```jsonc
{
  "channels": {
    "wecom": {
      "enabled": true,
      // 从企微后台获取
      "token": "your-bot-token",
      "encodingAesKey": "your-43-char-encoding-aes-key",
      // Agent 模式（可选，启用主动推送和文件收发）
      "agent": {
        "corpId": "your-corp-id",
        "corpSecret": "your-corp-secret",
        "agentId": 1000002
      }
    }
  }
}
```

> 动态 Agent 路由、群聊支持、消息去抖等功能**默认开启**，无需额外配置。

#### 企微后台设置

1. 登录[企业微信管理后台](https://work.weixin.qq.com/)
2. 创建 AI Bot 或自建应用
3. 配置回调 URL：`https://your-openclaw-domain/webhooks/wecom`
4. 复制 Token 和 EncodingAESKey 到上面的配置中
5. 重启 OpenClaw：`openclaw gateway restart`

### 项目结构

```
openclaw-wecom/
├── index.js              # 插件入口
├── crypto.js             # AES 加解密
├── webhook.js            # WeCom 协议处理（签名验证、消息解密）
├── stream-manager.js     # 流式响应管理器
├── dynamic-agent.js      # 动态 Agent 路由
├── image-processor.js    # 图片处理管线
├── logger.js             # 日志
├── utils.js              # 工具函数
├── wecom/
│   ├── channel-plugin.js # 通道插件核心（outbound 适配器）
│   ├── http-handler.js   # HTTP 请求处理（Bot 模式）
│   ├── agent-api.js      # Agent API 封装
│   ├── agent-inbound.js  # Agent 模式入站处理（XML）
│   ├── inbound-processor.js  # 入站消息处理器
│   ├── webhook-bot.js    # Webhook Bot 发送
│   ├── kf-bridge.js      # KF 客服桥接
│   ├── media.js          # 媒体文件处理
│   ├── xml-parser.js     # XML 解析
│   ├── target.js         # 消息目标解析
│   ├── commands.js       # 命令处理
│   ├── constants.js      # 常量定义
│   ├── state.js          # 全局状态管理
│   ├── stream-utils.js   # 流工具函数
│   ├── response-url.js   # response_url 处理
│   ├── accounts.js       # 多账号管理
│   ├── outbound-delivery.js  # 出站投递
│   ├── upload-route.js   # 文件上传路由
│   ├── upload-ticket.js  # 上传凭证管理
│   ├── allow-from.js     # 来源验证
│   ├── webhook-targets.js    # Webhook 目标注册
│   └── workspace-template.js # 工作区模板
├── openclaw.plugin.json  # 插件清单
├── package.json
├── LICENSE               # ISC 开源协议
└── CONTRIBUTING.md       # 贡献指南
```

### 配置参考

| 配置项 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `true` | 启用企微通道 |
| `token` | string | — | Bot Token |
| `encodingAesKey` | string | — | 43 位加密密钥 |
| `dynamicAgents.enabled` | boolean | `true` | 启用动态 Agent 路由 |
| `dm.createAgentOnFirstMessage` | boolean | `true` | 私聊自动创建独立 Agent |
| `groupChat.enabled` | boolean | `true` | 启用群聊支持 |
| `groupChat.requireMention` | boolean | `true` | 群聊需 @提及才响应 |
| `adminUsers` | string[] | `[]` | 管理员用户列表 |
| `workspaceTemplate` | string | — | 自定义启动模板目录 |
| `agent.corpId` | string | — | 企业 Corp ID |
| `agent.corpSecret` | string | — | 应用 Secret |
| `agent.agentId` | number | — | 应用 Agent ID |
| `webhooks` | object | — | Webhook Bot URL 映射 |
| `instances` | array | — | 多 Bot 实例配置 |

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

## License

[MIT](./LICENSE)
