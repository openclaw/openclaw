---
summary: "OpenClaw 的首次运行设置流程（macOS 应用）"
read_when:
  - 设计 macOS 引导助手
  - 实现身份验证或身份设置
title: "引导流程（macOS 应用）"
sidebarTitle: "引导流程：macOS 应用"
---

# 引导流程（macOS 应用）

本文档描述了**当前**的首次运行设置流程。目标是提供流畅的 "第 0 天" 体验：选择网关运行位置、连接身份验证、运行向导，让代理自举。
有关引导路径的一般概述，请参阅 [引导流程概述](/start/onboarding-overview)。

<Steps>
<Step title="批准 macOS 警告">
<Frame>
<img src="/assets/macos-onboarding/01-macos-warning.jpeg" alt="" />
</Frame>
</Step>
<Step title="批准查找本地网络">
<Frame>
<img src="/assets/macos-onboarding/02-local-networks.jpeg" alt="" />
</Frame>
</Step>
<Step title="欢迎和安全通知">
<Frame caption="阅读显示的安全通知并做出相应决定">
<img src="/assets/macos-onboarding/03-security-notice.png" alt="" />
</Frame>

安全信任模型：

- 默认情况下，OpenClaw 是个人代理：一个受信任的操作者边界。
- 共享/多用户设置需要锁定（分离信任边界，保持工具访问最小化，并遵循 [安全](/gateway/security)）。
- 本地引导现在默认将新配置设置为 `tools.profile: "coding"`，因此全新的本地设置可以保留文件系统/运行时工具，而无需强制使用无限制的 `full` 配置文件。
- 如果启用了钩子/网络钩子或其他不受信任的内容源，请使用强大的现代模型层级并保持严格的工具策略/沙箱。

</Step>
<Step title="本地 vs 远程">
<Frame>
<img src="/assets/macos-onboarding/04-choose-gateway.png" alt="" />
</Frame>

**网关**在哪里运行？

- **这台 Mac（仅限本地）**：引导流程可以在本地配置身份验证并写入凭据。
- **远程（通过 SSH/Tailnet）**：引导流程**不会**配置本地身份验证；凭据必须存在于网关主机上。
- **稍后配置**：跳过设置并保持应用未配置状态。

<Tip>
**网关身份验证提示：**

- 向导现在即使对于环回也会生成**令牌**，因此本地 WS 客户端必须进行身份验证。
- 如果禁用身份验证，任何本地进程都可以连接；仅在完全受信任的机器上使用。
- 对于多机器访问或非环回绑定，请使用**令牌**。

</Tip>
</Step>
<Step title="权限">
<Frame caption="选择您要授予 OpenClaw 的权限">
<img src="/assets/macos-onboarding/05-permissions.png" alt="" />
</Frame>

引导流程请求所需的 TCC 权限：

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
  <Info>此步骤是可选的</Info>
  应用可以通过 npm、pnpm 或 bun 安装全局 `openclaw` CLI。
  它优先使用 npm，然后是 pnpm，如果这是唯一检测到的包管理器，则使用 bun。对于网关运行时，Node 仍然是推荐的路径。
</Step>
<Step title="引导聊天（专用会话）">
  设置后，应用会打开一个专用的引导聊天会话，以便代理可以
  介绍自己并指导后续步骤。这将首次运行指导与您的正常对话分开。有关网关主机在首次代理运行期间发生的情况，请参阅 [自举](/start/bootstrapping)。
</Step>
</Steps>