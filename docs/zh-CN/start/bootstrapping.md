---
summary: 智能体初始化流程：首次运行时如何初始化工作区与身份文件
read_when:
  - 了解首次运行智能体时会发生什么
  - 说明引导文件存放位置
  - 调试入职身份设置
title: 智能体初始化
sidebarTitle: 初始化
---

# Agent 引导

初始化是在**首次运行**时运行的一个程序，用于准备智能体工作空间并收集身份详细信息。它在配置流程之后、智能体首次启动时发生。

## 引导的作用

在首次运行智能体时，OpenClaw 会初始化工作空间（默认为 `~/.openclaw/workspace`）：

- 创建 `AGENTS.md`、`BOOTSTRAP.md`、`IDENTITY.md`、`USER.md` 文件。
- 执行简短的问答流程（一次一个问题）。
- 将身份信息和偏好设置写入 `IDENTITY.md`、`USER.md`、`SOUL.md` 文件。
- 完成后删除 `BOOTSTRAP.md`，确保仅运行一次。

## 运行位置

初始化始终在**网关主机**上运行。如果 macOS 应用连接到远程网关，工作空间和初始化文件将存放在该远程机器上。

<Note>
当网关在其他主机上运行时，请在网关主机上编辑工作空间文件（例如：`user@gateway-host:~/.openclaw/workspace`）。
</Note>

## 相关文档

- macOS 应用配置：[新手引导](/zh-CN/start/onboarding)
- 工作空间结构：[智能体工作区](/zh-CN/concepts/agent-workspace)
