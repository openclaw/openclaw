---
summary: "智能体引导流程：初始化工作区并写入身份文件的首次运行仪式"
read_when:
  - 了解智能体首次运行时会发生什么
  - 说明引导文件存放在哪里
  - 调试 onboarding 身份初始化
title: "智能体引导"
sidebarTitle: "引导"
---

# 智能体引导

引导是智能体的**首次运行**仪式，用来准备工作区并收集身份信息。它发生在 onboarding 之后，也就是智能体第一次启动时。

## 引导会做什么

在智能体第一次运行时，OpenClaw 会对工作区进行引导（默认是 `~/.openclaw/workspace`）：

- 初始化 `AGENTS.md`、`BOOTSTRAP.md`、`IDENTITY.md`、`USER.md`
- 运行一个简短的问答流程（一次只问一个问题）
- 将身份信息和偏好写入 `IDENTITY.md`、`USER.md`、`SOUL.md`
- 完成后删除 `BOOTSTRAP.md`，确保这个流程只运行一次

## 它在哪里运行

引导始终运行在**网关主机**上。如果 macOS app 连接到远程 Gateway，那么工作区和引导文件也会位于那台远程机器上。

<Note>
当 Gateway 运行在另一台机器上时，请在网关主机上编辑工作区文件，例如 `user@gateway-host:~/.openclaw/workspace`。
</Note>

## 相关文档

- macOS app onboarding：[Onboarding](/start/onboarding)
- 工作区布局：[Agent workspace](/concepts/agent-workspace)
