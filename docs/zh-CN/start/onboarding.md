---
read_when:
  - 设计 macOS 新手引导助手
  - 实现认证或身份设置
summary: OpenClaw 的首次运行设置流程（macOS 应用）
title: 新手引导（macOS 应用）
sidebarTitle: 新手引导：macOS 应用
x-i18n:
  generated_at: "2026-03-19T09:20:40Z"
  model: gpt-5.4
  provider: openai
  source_hash: 6556aef83f3fcb5bcc28b5e1d1be189c6e861cdca1594bfe72c4394f85c3e6b6
  source_path: start/onboarding.md
  workflow: 15
---

# 新手引导（macOS 应用）

本文档描述**当前**的首次运行设置流程。目标是提供顺畅的“第 0 天”体验：选择 Gateway 网关运行位置、连接认证、运行向导，然后让智能体自行完成初始引导。
如需了解各类新手引导路径的整体概览，请参阅 [新手引导概览](/zh-CN/start/onboarding-overview)。

<Steps>
<Step title="确认 macOS 警告">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="允许发现本地网络">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="欢迎页与安全提示">
<Frame caption="阅读显示的安全提示，并据此做出选择。">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>

安全信任模型：

- 默认情况下，OpenClaw 是一个个人智能体，围绕单一受信任操作员边界设计。
- 共享或多用户部署需要额外收紧：拆分信任边界、尽量减少工具访问，并遵循 [安全性](/zh-CN/gateway/security)。
- 本地新手引导现在默认将新配置写为 `tools.profile: "coding"`，这样新的本地安装会保留文件系统和运行时工具，而不必直接启用不受限制的 `full` 配置。
- 如果启用了 hooks、webhooks 或其他不受信任的内容源，请使用更强的现代模型档位，并保持严格的工具策略和沙箱隔离。

</Step>
<Step title="本地还是远程">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**Gateway 网关**运行在哪里？

- **此 Mac（仅本地）：** 新手引导可以在本地配置认证并写入凭据。
- **远程（通过 SSH/Tailnet）：** 新手引导**不会**配置本地认证；凭据必须已经存在于 Gateway 网关主机上。
- **稍后配置：** 跳过设置，并让应用保持未配置状态。

<Tip>
**Gateway 认证提示：**

- 向导现在即使在 loopback 上也会生成 **token**，因此本地 WS 客户端也必须通过认证。
- 如果你禁用认证，任何本地进程都可以连接；这只适用于完全受信任的机器。
- 对多机器访问或非 loopback 绑定，请使用 **token**。

</Tip>
</Step>
<Step title="权限">
<Frame caption="选择你希望授予 OpenClaw 的权限。">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

新手引导会请求以下场景所需的 TCC 权限：

- 自动化（AppleScript）
- 通知
- 辅助功能
- 屏幕录制
- 麦克风
- 语音识别
- 相机
- 位置

</Step>
<Step title="CLI">
  <Info>此步骤为可选项。</Info>
  应用可以通过 npm/pnpm 安装全局 `openclaw` CLI，让终端工作流和 launchd 任务开箱即用。
</Step>
<Step title="新手引导聊天（专用会话）">
  设置完成后，应用会打开一个专用的新手引导聊天会话，让智能体先自我介绍并引导后续步骤。这会将首次运行指导与你的日常对话分开。关于首次智能体运行时 Gateway 网关主机上会发生什么，请参阅 [智能体引导](/zh-CN/start/bootstrapping)。
</Step>
</Steps>
