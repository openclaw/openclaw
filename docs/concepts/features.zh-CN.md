---
summary: "OpenClaw 在通道、路由、媒体和用户体验方面的功能。"
read_when:
  - 你想要 OpenClaw 支持的完整列表
---

# 功能

## 亮点

<Columns>
  <Card title="通道" icon="message-square">
    Discord、iMessage、Signal、Slack、Telegram、WhatsApp、WebChat 等，通过单个网关实现。
  </Card>
  <Card title="插件" icon="plug">
    捆绑插件添加 Matrix、Nextcloud Talk、Nostr、Twitch、Zalo 等，无需在正常当前版本中单独安装。
  </Card>
  <Card title="路由" icon="route">
    具有隔离会话的多代理路由。
  </Card>
  <Card title="媒体" icon="image">
    图像、音频、视频、文档以及图像/视频生成。
  </Card>
  <Card title="应用和 UI" icon="monitor">
    Web 控制 UI 和 macOS 配套应用。
  </Card>
  <Card title="移动节点" icon="smartphone">
    iOS 和 Android 节点，支持配对、语音/聊天和丰富的设备命令。
  </Card>
</Columns>

## 完整列表

**通道：**

- 内置通道包括 Discord、Google Chat、iMessage（旧版）、IRC、Signal、Slack、Telegram、WebChat 和 WhatsApp
- 捆绑插件通道包括 BlueBubbles（用于 iMessage）、飞书、LINE、Matrix、Mattermost、Microsoft Teams、Nextcloud Talk、Nostr、QQ 机器人、Synology Chat、Tlon、Twitch、Zalo 和 Zalo 个人版
- 可选的单独安装通道插件包括语音通话和第三方包，如微信
- 第三方通道插件可以进一步扩展网关，如微信
- 支持基于提及的群组聊天激活
- 带有允许列表和配对的 DM 安全

**代理：**

- 带有工具流式传输的嵌入式代理运行时
- 每个工作区或发送者具有隔离会话的多代理路由
- 会话：直接聊天折叠到共享的 `main`；群组是隔离的
- 长响应的流式传输和分块

**认证和提供商：**

- 35+ 模型提供商（Anthropic、OpenAI、Google 等）
- 通过 OAuth 的订阅认证（例如 OpenAI Codex）
- 自定义和自托管提供商支持（vLLM、SGLang、Ollama 以及任何 OpenAI 兼容或 Anthropic 兼容的端点）

**媒体：**

- 输入和输出的图像、音频、视频和文档
- 共享的图像生成和视频生成能力表面
- 语音笔记转录
- 具有多个提供商的文本到语音转换

**应用和界面：**

- WebChat 和浏览器控制 UI
- macOS 菜单栏配套应用
- iOS 节点，支持配对、Canvas、相机、屏幕录制、位置和语音
- Android 节点，支持配对、聊天、语音、Canvas、相机和设备命令

**工具和自动化：**

- 浏览器自动化、执行、沙盒
- 网络搜索（Brave、DuckDuckGo、Exa、Firecrawl、Gemini、Grok、Kimi、MiniMax Search、Ollama Web Search、Perplexity、SearXNG、Tavily）
- Cron 作业和心跳调度
- 技能、插件和工作流管道（Lobster）
