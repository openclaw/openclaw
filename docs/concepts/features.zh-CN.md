---
summary: "OpenClaw在频道、路由、媒体和用户体验方面的功能。"
read_when:
  - 你想要OpenClaw支持的完整列表
title: "功能"
---

# 功能

## 亮点

<Columns>
  <Card title="频道" icon="message-square">
    Discord、iMessage、Signal、Slack、Telegram、WhatsApp、WebChat等，使用单一网关。
  </Card>
  <Card title="插件" icon="plug">
    捆绑插件添加Matrix、Nextcloud Talk、Nostr、Twitch、Zalo等，在当前正常版本中无需单独安装。
  </Card>
  <Card title="路由" icon="route">
    具有隔离会话的多代理路由。
  </Card>
  <Card title="媒体" icon="image">
    图像、音频、视频、文档以及图像/视频生成。
  </Card>
  <Card title="应用和界面" icon="monitor">
    Web控制界面和macOS companion应用。
  </Card>
  <Card title="移动节点" icon="smartphone">
    iOS和Android节点，支持配对、语音/聊天和丰富的设备命令。
  </Card>
</Columns>

## 完整列表

**频道：**

- 内置频道包括Discord、Google Chat、iMessage（传统）、IRC、Signal、Slack、Telegram、WebChat和WhatsApp
- 捆绑插件频道包括用于iMessage的BlueBubbles、Feishu、LINE、Matrix、Mattermost、Microsoft Teams、Nextcloud Talk、Nostr、QQ Bot、Synology Chat、Tlon、Twitch、Zalo和Zalo个人
- 可选的单独安装频道插件包括Voice Call和第三方包，如微信
- 第三方频道插件可以进一步扩展网关，如微信
- 支持带有提及激活的群聊
- 带有允许列表和配对的DM安全

**代理：**

- 具有工具流的嵌入式代理运行时
- 具有每个工作区或发送者隔离会话的多代理路由
- 会话：直接聊天折叠到共享的`main`；群组是隔离的
- 长响应的流和分块

**身份验证和提供者：**

- 35+ 模型提供者（Anthropic、OpenAI、Google等）
- 通过OAuth的订阅身份验证（例如OpenAI Codex）
- 自定义和自托管提供者支持（vLLM、SGLang、Ollama以及任何OpenAI兼容或Anthropic兼容的端点）

**媒体：**

- 输入和输出的图像、音频、视频和文档
- 共享的图像生成和视频生成能力表面
- 语音笔记转录
- 具有多个提供者的文本转语音

**应用和界面：**

- WebChat和浏览器控制界面
- macOS菜单栏companion应用
- 具有配对、Canvas、相机、屏幕录制、位置和语音的iOS节点
- 具有配对、聊天、语音、Canvas、相机和设备命令的Android节点

**工具和自动化：**

- 浏览器自动化、执行、沙箱
- 网络搜索（Brave、DuckDuckGo、Exa、Firecrawl、Gemini、Grok、Kimi、MiniMax搜索、Ollama网络搜索、Perplexity、SearXNG、Tavily）
- Cron作业和心跳调度
- 技能、插件和工作流管道（Lobster）
