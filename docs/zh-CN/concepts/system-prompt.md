---
read_when:
  - 编辑系统提示词文本、工具列表或时间/心跳部分
  - 更改工作区引导或 Skills 注入行为
summary: OpenClaw 系统提示词包含的内容及其组装方式
title: 系统提示词
x-i18n:
  generated_at: "2026-02-03T07:46:58Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: bef4b2674ba0414ce28fd08a4c3ead0e0ebe989e7df3c88ca8a0b2abfec2a50b
  source_path: concepts/system-prompt.md
  workflow: 15
---

# 系统提示词

OpenClaw 为每次智能体运行构建自定义系统提示词。该提示词由 **OpenClaw 拥有**，不使用 pi-coding-agent 默认提示词。

该提示词由 OpenClaw 组装并注入到每次智能体运行中。

## 结构

该提示词设计紧凑，使用固定部分：

- **Tooling**：当前工具列表 + 简短描述。
- **Safety**：简短的防护提醒，避免追求权力的行为或绕过监督。
- **Skills**（如果可用）：告诉模型如何按需加载 Skill 指令。
- **OpenClaw Self-Update**：如何运行 `config.apply` 和 `update.run`。
- **Workspace**：工作目录（`agents.defaults.workspace`）。
- **Documentation**：OpenClaw 文档的本地路径（仓库或 npm 包）以及何时阅读它们。
- **Workspace Files (injected)**：表示下方包含引导文件。
- **Sandbox**（启用时）：表示沙箱隔离运行时、沙箱路径，以及是否可用提权执行。
- **Current Date & Time**：用户本地时间、时区和时间格式。
- **Reply Tags**：支持的提供商的可选回复标签语法。
- **Heartbeats**：心跳提示词和确认行为。
- **Runtime**：主机、操作系统、node、模型、仓库根目录（检测到时）、思考级别（一行）。
- **Reasoning**：当前可见性级别 + /reasoning 切换提示。

系统提示词中的安全防护是建议性的。它们指导模型行为但不强制执行策略。使用工具策略、执行审批、沙箱隔离和渠道允许列表进行硬性执行；运维人员可以按设计禁用这些。

## 提示词模式

OpenClaw 可以为子智能体渲染更小的系统提示词。运行时为每次运行设置一个 `promptMode`（不是面向用户的配置）：

- `full`（默认）：包含上述所有部分。
- `minimal`：用于子智能体；省略 **Skills**、**Memory Recall**、**OpenClaw Self-Update**、**Model Aliases**、**User Identity**、**Reply Tags**、**Messaging**、**Silent Replies** 和 **Heartbeats**。Tooling、**Safety**、Workspace、Sandbox、Current Date & Time（已知时）、Runtime 和注入的上下文仍然可用。
- `none`：仅返回基本身份行。

当 `promptMode=minimal` 时，额外注入的提示词标记为 **Subagent Context** 而不是 **Group Chat Context**。

## 工作区引导注入

引导文件被修剪后附加在 **Project Context** 下，这样模型无需显式读取即可看到身份和配置上下文：

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（仅在全新工作区上）

大文件会带截断标记被截断。每个文件的最大大小由 `agents.defaults.bootstrapMaxChars` 控制（默认：20000）。缺失的文件会注入一个简短的缺失文件标记。

内部钩子可以通过 `agent:bootstrap` 拦截此步骤以修改或替换注入的引导文件（例如将 `SOUL.md` 替换为其他角色）。

要检查每个注入文件贡献了多少（原始 vs 注入、截断，加上工具 schema 开销），使用 `/context list` 或 `/context detail`。参见[上下文](/concepts/context)。

## 时间处理

当用户时区已知时，系统提示词包含专用的 **Current Date & Time** 部分。为保持提示词缓存稳定，它现在只包含**时区**（没有动态时钟或时间格式）。

当智能体需要当前时间时使用 `session_status`；状态卡片包含时间戳行。

配置方式：

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat`（`auto` | `12` | `24`）

完整行为详情参见[日期和时间](/date-time)。

## Skills

当存在符合条件的 Skills 时，OpenClaw 注入一个紧凑的**可用 Skills 列表**（`formatSkillsForPrompt`），其中包含每个 Skill 的**文件路径**。提示词指示模型使用 `read` 加载列出位置（工作区、托管或内置）的 SKILL.md。如果没有符合条件的 Skills，则省略 Skills 部分。

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

这使基础提示词保持小巧，同时仍然支持有针对性的 Skill 使用。

## 文档

如果可用，系统提示词包含一个 **Documentation** 部分，指向本地 OpenClaw 文档目录（仓库工作区中的 `docs/` 或打包的 npm 包文档），并注明公共镜像、源仓库、社区 Discord 和 ClawHub (https://clawhub.com) 用于 Skills 发现。提示词指示模型首先查阅本地文档了解 OpenClaw 行为、命令、配置或架构，并尽可能自己运行 `openclaw status`（仅在无法访问时询问用户）。
