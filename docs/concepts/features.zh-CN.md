---
summary: "OpenClaw 在频道、路由、媒体和用户体验方面的能力。"
read_when:
  - 您想要 OpenClaw 支持的完整列表
title: "功能"
---

# 功能

## 亮点

<Columns>
  <Card title="频道" icon="message-square">
    一个网关支持 Discord、iMessage、Signal、Slack、Telegram、WhatsApp、WebChat 等更多频道。
  </Card>
  <Card title="插件" icon="plug">
    捆绑插件在当前正常版本中无需单独安装即可添加 Matrix、Nextcloud Talk、Nostr、Twitch、Zalo 等更多功能。
  </Card>
  <Card title="路由" icon="route">
    具有隔离会话的多代理路由。
  </Card>
  <Card title="媒体" icon="image">
    图像、音频、视频、文档以及图像/视频生成。
  </Card>
  <Card title="应用和界面" icon="monitor">
    Web 控制界面和 macOS 配套应用。
  </Card>
  <Card title="移动节点" icon="smartphone">
    具有配对、语音/聊天和丰富设备命令的 iOS 和 Android 节点。
  </Card>
</Columns>

## 完整列表

**频道：**

- 内置频道包括 Discord、Google Chat、iMessage（旧版）、IRC、Signal、Slack、Telegram、WebChat 和 WhatsApp
- 捆绑插件频道包括用于 iMessage 的 BlueBubbles、Feishu、LINE、Matrix、Mattermost、Microsoft Teams、Nextcloud Talk、Nostr、QQ Bot、Synology Chat、Tlon、Twitch、Zalo 和 Zalo Personal
- 可选的单独安装的频道插件包括 Voice Call 和第三方包，如微信
- 第三方频道插件可以进一步扩展网关，如微信
- 支持基于提及的激活的群聊
- 带有允许列表和配对的 DM 安全

**代理：**

- 带有工具流式传输的嵌入式代理运行时
- 每个工作区或发送者具有隔离会话的多代理路由
- 会话：直接聊天合并到共享的 `main` 中；群组是隔离的
- 长响应的流式传输和分块

**身份验证和提供商：**

- 35+ 模型提供商（Anthropic、OpenAI、Google 等）
- 通过 OAuth 的订阅身份验证（例如 OpenAI Codex）
- 自定义和自托管提供商支持（vLLM、SGLang、Ollama 以及任何 OpenAI 兼容或 Anthropic 兼容的端点）

**媒体：**

- 输入和输出的图像、音频、视频和文档
- 共享的图像生成和视频生成能力表面
- 语音笔记转录
- 带有多个提供商的文本转语音

**应用和界面：**

- WebChat 和浏览器控制界面
- macOS 菜单栏配套应用
- 具有配对、Canvas、相机、屏幕录制、位置和语音的 iOS 节点
- 具有配对、聊天、语音、Canvas、相机和设备命令的 Android 节点

**工具和自动化：**

- 浏览器自动化、执行、沙箱
- 网络搜索（Brave、DuckDuckGo、Exa、Firecrawl、Gemini、Grok、Kimi、MiniMax Search、Ollama Web Search、Perplexity、SearXNG、Tavily）
- Cron 作业和心跳调度
- 技能、插件和工作流管道（Lobster）