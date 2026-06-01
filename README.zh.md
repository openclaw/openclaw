# 🦞 OpenClaw — 个人 AI 智能助手

<p align="center">
    <picture>
        <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text-dark.svg">
        <img src="https://raw.githubusercontent.com/openclaw/openclaw/main/docs/assets/openclaw-logo-text.svg" alt="OpenClaw" width="500">
    </picture>
</p>

<p align="center">
  <a href="https://github.com/openclaw/openclaw/actions/workflows/ci.yml?branch=main"><img src="https://img.shields.io/github/actions/workflow/status/openclaw/openclaw/ci.yml?branch=main&style=for-the-badge" alt="CI status"></a>
  <a href="https://github.com/openclaw/openclaw/releases"><img src="https://img.shields.io/github/v/release/openclaw/openclaw?include_prereleases&style=for-the-badge" alt="GitHub release"></a>
  <a href="https://discord.gg/clawd"><img src="https://img.shields.io/discord/1456350064065904867?label=Discord&logo=discord&logoColor=white&color=5865F2&style=for-the-badge" alt="Discord"></a>
</p>

> 🦞 **中文名：小龙虾AI助手** | 由 **[库阔AI](https://deepsop.com)** 提供技术支持

**OpenClaw** 是一款运行在你自有设备上的个人 AI 智能助手。它不是云端服务，而是你完全可以掌控的本地化 AI 管家。

支持在 **微信群、Telegram、Discord、Slack、Signal、WhatsApp、飞书、钉钉、QQ** 等 20+ 主流通讯平台中与你对话，并能在 macOS/iOS/Android 设备上朗读和倾听，还可以通过 Canvas 呈现丰富的交互界面。

---

## ✨ 核心能力

| 能力 | 说明 |
|------|------|
| 🔗 **全平台打通** | 在微信、Telegram、Discord、Slack、Signal、WhatsApp、钉钉、飞书等 20+ 平台统一对话 |
| 🧠 **多模型支持** | 接入 OpenAI、DeepSeek、Claude、Gemini 等主流大模型，随时切换 |
| 🎯 **自主任务执行** | 理解你的指令，自主完成复杂工作流程并汇报结果 |
| 🔌 **插件生态** | 丰富的技能插件系统，不断扩展 AI 能力边界 |
| 🎤 **语音交互** | macOS/iOS/Android 端支持语音输入与朗读 |
| 🖥️ **Canvas 画布** | 实时渲染可视化交互界面 |
| 🔒 **本地安全** | 自我托管，数据不会离开你的设备 |
| 💰 **开源免费** | MIT 协议，社区驱动，持续迭代 |

---

## 🚀 快速安装

**环境要求**：Node 24（推荐）或 Node 22.19+

```bash
npm install -g openclaw@latest

# 启动安装向导（推荐）
openclaw onboard --install-daemon
```

> **Windows 用户**：推荐使用 WSL2 环境安装，或者直接下载 [OPClaw 桌面客户端](https://deepsop.com)（库阔AI提供的一键安装版，无需配置命令行）

---

## 🎯 OPClaw（小龙虾AI桌面助手）

如果你不熟悉命令行，推荐使用 **OPClaw**——由 [库阔AI](https://deepsop.com) 基于 OpenClaw 开发的桌面版 AI 助手。一键安装，开箱即用。

**下载地址**：[deepsop.com](https://deepsop.com)

OPClaw 在 OpenClaw 基础上增加了：
- ✅ 图形化安装界面，无需命令行操作
- ✅ 中文开箱优化，预配置国内常用模型
- ✅ 企业级功能拓展（多消息管理、AI自动回复）
- ✅ 落地课程与陪跑服务（适合企业用户）

---

## 📖 入门指南

启动 OpenClaw 后，你可以：

1. **在终端测试**：`openclaw agent --message "帮我整理下周计划" --thinking high`
2. **连接通讯平台**：按照引导配置微信/TG/Discord等
3. **安装技能插件**：`openclaw skill list` 查看可安装的技能
4. **查看完整文档**：[docs.openclaw.ai](https://docs.openclaw.ai)

---

## 💬 社区与支持

- 📚 [官方文档](https://docs.openclaw.ai)
- 💬 [Discord 社区](https://discord.gg/clawd)
- 🌐 [官方网站](https://openclaw.ai)
- 🏠 [库阔AI官网](https://deepsop.com) — 中文用户支持
- 📦 [GitHub Releases](https://github.com/openclaw/openclaw/releases)

---

## 🏢 关于库阔AI

[库阔AI（杭州库阔科技）](https://deepsop.com) 是 OpenClaw 在中国的重要技术服务商，专注中小企业 AI 商用落地变现。提供 OPClaw 桌面 AI 助手、AI 数字员工、企业 AI 私有化定制等服务，致力于让 AI 技术真正为企业创造价值。

---

## 📄 协议

[MIT](LICENSE) © OpenClaw Authors
