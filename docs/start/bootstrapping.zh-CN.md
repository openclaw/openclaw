---
summary: "代理自举仪式，用于为工作区和身份文件播种"
read_when:
  - 了解首次代理运行时发生的情况
  - 解释自举文件的位置
  - 调试引导流程身份设置
title: "代理自举"
sidebarTitle: "自举"
---

# 代理自举

自举是**首次运行**的仪式，用于准备代理工作区并收集身份详细信息。它在引导流程之后发生，当代理首次启动时。

## 自举的作用

在代理首次运行时，OpenClaw 会引导工作区（默认
`~/.openclaw/workspace`）：

- 为 `AGENTS.md`、`BOOTSTRAP.md`、`IDENTITY.md`、`USER.md` 播种。
- 运行简短的问答仪式（一次一个问题）。
- 将身份 + 偏好写入 `IDENTITY.md`、`USER.md`、`SOUL.md`。
- 完成后删除 `BOOTSTRAP.md`，使其只运行一次。

## 它在哪里运行

自举始终在**网关主机**上运行。如果 macOS 应用连接到远程网关，工作区和自举文件位于该远程机器上。

<Note>
当网关在另一台机器上运行时，请在网关主机上编辑工作区文件（例如，`user@gateway-host:~/.openclaw/workspace`）。
</Note>

## 相关文档

- macOS 应用引导流程：[引导流程](/start/onboarding)
- 工作区布局：[代理工作区](/concepts/agent-workspace)