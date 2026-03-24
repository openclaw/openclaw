
# OpenClaw 🦞 中文版

> **你的私人 AI 助手** — 任何系统、任何平台、龙虾之道 🦞

---

## 🦞 这是什么？

OpenClaw 是一个**本地优先**的个人 AI 助手框架。

它可以在你已经使用的聊天渠道上回答你（WhatsApp、Telegram、Slack、Discord、飞书、微信、Signal、iMessage 等 20+ 平台），支持 macOS/iOS/Android 语音交互，还能渲染你控制的实时 Canvas 界面。

**如果你想要一个私人的、单用户的、感觉本地化、快速且永远在线的助手——这就是了。**

---

## ✨ 核心特性

| 特性 | 说明 |
|------|------|
| 🏠 **本地优先** | Gateway 完全本地运行，数据在你手中 |
| 💬 **多渠道支持** | WhatsApp / Telegram / Slack / Discord / 飞书 / 微信 / Signal / iMessage 等 20+ |
| 🗣️ **语音交互** | macOS/iOS 唤醒词 + Android 连续语音对话 |
| 🎨 **Canvas 界面** | AI 驱动的可视化工作空间 |
| 📱 **伴侣应用** | macOS 菜单栏 + iOS/Android 节点应用 |
| 🔧 **Skills 技能** | 可扩展的技能系统，按需加载 |
| ⏰ **自动化** | Cron 定时任务 + Webhooks + Gmail 触发 |
| 🔒 **安全可控** | 配对机制、沙箱模式、权限管理 |

---

## 🚀 快速开始

### 安装

```bash
# 使用 npm
npm install -g openclaw@latest

# 或使用 pnpm
pnpm add -g openclaw@latest
```

### 初始化

```bash
openclaw onboard --install-daemon
```

### 启动

```bash
openclaw gateway --port 18789 --verbose
```

### 与助手对话

```bash
openclaw agent --message "帮我整理今天的任务" --thinking high
```

---

## 📚 支持的渠道

| 渠道 | 状态 | 渠道 | 状态 |
|------|------|------|------|
| WhatsApp | ✅ | Telegram | ✅ |
| Slack | ✅ | Discord | ✅ |
| 飞书 | ✅ | 微信 | ✅ |
| Signal | ✅ | iMessage | ✅ |
| Google Chat | ✅ | Microsoft Teams | ✅ |
| Matrix | ✅ | LINE | ✅ |

---

## 🏗️ 架构

```
消息渠道 (WhatsApp/Telegram/飞书/...)
     │
     ▼
┌─────────────────────────┐
│      Gateway            │
│   (控制平面)             │
│   ws://127.0.0.1:18789  │
└───────────┬─────────────┘
            │
    ┌───────┼───────┬───────────┐
    │       │       │           │
    ▼       ▼       ▼           ▼
  Pi Agent  CLI   WebChat   iOS/Android
  (RPC)           UI        Nodes
```

---

## 📖 文档

- 🌐 [官网](https://openclaw.ai)
- 📚 [文档](https://docs.openclaw.ai)
- ❓ [FAQ](https://docs.openclaw.ai/help/faq)
- 💬 [Discord 社区](https://discord.gg/clawd)

---

## 🛡️ 安全

OpenClaw 连接真实的消息平台，请将收到的消息视为**不可信输入**。

默认行为：
- 私聊需要**配对** (`dmPolicy="pairing"`)
- 未知发送者会收到配对码

详见：[安全指南](https://docs.openclaw.ai/gateway/security)

---

## 🤝 贡献

我们欢迎所有形式的贡献！

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)

---

## 📜 许可证

MIT License

---

## 🦞 关于

OpenClaw 最初为 **Molty** 构建——一只太空龙虾 AI 助手。🦞

由 [Peter Steinberger](https://steipete.me) 和社区共同打造。

---

<div align="center">

**游在数据流中的赛博龙虾，随叫随到，偶尔还会蹦跶两下。** 🦞

[官网](https://openclaw.ai) · [文档](https://docs.openclaw.ai) · [Discord](https://discord.gg/clawd)

</div>
```

4. **提交更改**

---

修复完成后告诉我，我帮你检查！🦞
