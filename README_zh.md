# 🦞 OpenClaw — 你的私人 AI 助手

<p align="center">
  <strong>EXFOLIATE! EXFOLIATE!</strong>
</p>

**OpenClaw** 是一个运行在你个人设备上的*私人 AI 助手*。
它可以在你日常使用的各种聊天软件（WhatsApp、Telegram、Slack、Discord、飞书等）中回答你。它支持在 macOS/iOS/Android 上进行语音对话，并能渲染你可控的实时 Canvas 界面。Gateway 只是它的控制平面——这个助手本身才是真正的核心。

如果你想要一个私人的、单用户的、感觉像本地运行一样快且永远在线的助手，那么就是它了。

> **注意：** 这是一个由 @Ciward 独立维护的社区魔改分支 (**CiwardClaw**)。它包含了一些重要的新功能以及底层的稳定性修复（从新到旧排列）：
>
> - ♊ **Gemini CLI 集成**: 改用 Gemini CLI 的请求方式，有效避免短时间的 API 请求限额（Rate Limit）问题。
> - 🔄 **Codex 多账号轮换自动降级**: 增加了对多个 Codex 账号配置的健壮支持，实现无缝轮换和自动 Fallback。
> - ⚡ **Steer Mode (接管模式) 消息直接注入**: 在各通道引入了 Steer Mode 新功能，允许你在 Agent 运行时直接插入指令进行接管，而无需排队等待。
> - 🛡️ **Gateway 重启恢复 (Restart Recovery)**: 实现了无痛的服务重启，重启后可无缝恢复进行中的 Agent 任务——再也不会丢失会话上下文。
> - 🌐 **更健壮的浏览器自动化 (Browser Automation)**: 增强了目标查找恢复能力，并严格对齐了路由超时预算，消除了很多误导性的浏览器调用失败错误。
>
> _有关上游更新和更详细的官方文档，请参考 [OpenClaw 官方仓库](https://github.com/openclaw/openclaw)。_

[英文原版 (README.md)](README.md) · [官方网站](https://openclaw.ai) · [官方文档](https://docs.openclaw.ai) · [Discord](https://discord.gg/clawd)

## 安装方式（推荐）

推荐的配置方式是在终端中运行新手向导 (`openclaw onboard`)。
向导会一步步引导你配置 Gateway、工作区、通信通道以及各项技能。向导支持 **macOS、Linux 以及 Windows (建议通过 WSL2)**。
支持 npm, pnpm 或 bun。

```bash
npx openclaw onboard
```
