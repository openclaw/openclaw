---
summary: "OpenClaw 在渠道、路由、媒体和 UX 方面的能力"
read_when:
  - 您想了解 OpenClaw 支持的完整功能列表
title: "功能"
---

## 亮点

<Columns>
  <Card title="渠道" icon="message-square" href="/channels">
    Discord、iMessage、Signal、Slack、Telegram、WhatsApp、WebChat 等，一个 Gateway 搞定。
  </Card>
  <Card title="插件" icon="plug" href="/tools/plugin">
    捆绑插件在正式版中添加 Matrix、Nextcloud Talk、Nostr、Twitch、Zalo 等，无需单独安装。
  </Card>
  <Card title="路由" icon="route" href="/concepts/multi-agent">
    带隔离会话的多 Agent 路由。
  </Card>
  <Card title="媒体" icon="image" href="/nodes/images">
    图片、音频、视频、文档，以及图片/视频生成。
  </Card>
  <Card title="应用和界面" icon="monitor" href="/web/control-ui">
    Web Control UI 和 macOS 配套应用。
  </Card>
  <Card title="移动节点" icon="smartphone" href="/nodes">
    iOS 和 Android 节点，支持配对、语音/聊天和丰富的设备命令。
  </Card>
</Columns>

## 完整列表

**渠道：**

- 内置渠道包括 Discord、Google Chat、iMessage（legacy）、IRC、Signal、Slack、Telegram、WebChat 和 WhatsApp
- 捆绑插件渠道包括 BlueBubbles（iMessage）、Feishu、LINE、Matrix、Mattermost、Microsoft Teams、Nextcloud Talk、Nostr、QQ Bot、Synology Chat、Tlon、Twitch、Zalo 和 Zalo Personal
- 可选单独安装的渠道插件包括语音通话和第三方包如微信
- 第三方渠道插件可进一步扩展 Gateway，如微信
- 群聊支持基于提及的激活
- DM 安全与允许列表和配对

**Agent：**

- 带工具流式传输的嵌入式 Agent 运行时
- 带隔离会话的多 Agent 路由（按工作区或发送者）
- 会话：直接聊天合并到共享的 `main`；群组隔离
- 长响应的流式传输和分块

**Auth 和提供商：**

- 35+ 模型提供商（Anthropic、OpenAI、Google 等）
- 通过 OAuth 的订阅 auth（如 OpenAI Codex）
- 支持自定义和自托管提供商（vLLM、SGLang、Ollama，以及任何 OpenAI-compatible 或 Anthropic-compatible 端点）

**媒体：**

- 输入输出的图片、音频、视频和文档
- 共享的图片生成和视频生成能力
- 语音笔记转录
- 多个提供商的文本转语音

**应用和接口：**

- WebChat 和浏览器 Control UI
- macOS 菜单栏配套应用
- iOS 节点：配对、Canvas、摄像头、屏幕录制、位置和语音
- Android 节点：配对、聊天、语音、Canvas、摄像头和设备命令

**工具和自动化：**

- 浏览器自动化、exec、sandboxing
- 网页搜索（Brave、DuckDuckGo、Exa、Firecrawl、Gemini、Grok、Kimi、MiniMax Search、Ollama Web Search、Perplexity、SearXNG、Tavily）
- Cron 任务和心跳调度
- Skills、插件和工作流管道（Lobster）

## 相关

- [实验性功能](/concepts/experimental-features)
- [Agent 运行时](/concepts/agent)
