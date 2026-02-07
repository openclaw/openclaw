---
summary: "Agent 引导仪式，用于创建工作空间和身份文件"
read_when:
  - 了解首次运行 agent 时发生的事情
  - 了解引导文件的存放位置
  - 调试入门身份设置
title: "Agent 引导"
sidebarTitle: "引导"
---

# Agent 引导

引导（Bootstrapping）是**首次运行**时的仪式，用于准备 agent 工作空间并收集身份信息。它在入门配置完成后、agent 首次启动时进行。

## 引导做什么

首次运行 agent 时，OpenClaw 会引导工作空间（默认 `~/.openclaw/workspace`）：

- 创建 `AGENTS.md`、`BOOTSTRAP.md`、`IDENTITY.md`、`USER.md`。
- 运行简短的问答仪式（每次一个问题）。
- 将身份和偏好写入 `IDENTITY.md`、`USER.md`、`SOUL.md`。
- 完成后删除 `BOOTSTRAP.md`，确保只运行一次。

## 运行位置

引导始终在 **gateway 主机** 上运行。如果 macOS 应用连接到远程 Gateway，工作空间和引导文件将位于该远程机器上。

<Note>
当 Gateway 运行在另一台机器上时，请在 gateway 主机上编辑工作空间文件（例如 `user@gateway-host:~/.openclaw/workspace`）。
</Note>

## 相关文档

- macOS 应用入门：[入门配置](/start/onboarding)
- 工作空间布局：[Agent 工作空间](/concepts/agent-workspace)
