---
read_when:
  - 编辑系统提示词文本、工具列表或时间/心跳部分
  - 更改工作区引导或 Skills 注入行为
summary: OpenClaw 系统提示词的内容及其组装方式
title: 系统提示词
x-i18n:
  generated_at: "2026-02-01T20:24:17Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: bef4b2674ba0414ce28fd08a4c3ead0e0ebe989e7df3c88ca8a0b2abfec2a50b
  source_path: concepts/system-prompt.md
  workflow: 14
---

# 系统提示词

OpenClaw 为每次智能体运行构建自定义系统提示词。该提示词由 **OpenClaw 自有**，不使用 p-coding-agent 的默认提示词。

提示词由 OpenClaw 组装并注入到每次智能体运行中。

## 结构

提示词有意保持紧凑，使用固定的部分：

- **工具**：当前工具列表及简短描述。
- **安全**：简短的护栏提醒，避免模型追求权力或绕过监督。
- **Skills**（可用时）：告诉模型如何按需加载 Skills 指令。
- **OpenClaw 自更新**：如何运行 `config.apply` 和 `update.run`。
- **工作区**：工作目录（`agents.defaults.workspace`）。
- **文档**：OpenClaw 文档的本地路径（仓库或 npm 包）及查阅时机。
- **工作区文件（注入的）**：表明引导文件包含在下方。
- **沙箱**（启用时）：表明沙箱隔离运行时、沙箱路径，以及是否可用提权执行。
- **当前日期和时间**：用户本地时间、时区和时间格式。
- **回复标签**：支持的提供商的可选回复标签语法。
- **心跳**：心跳提示和确认行为。
- **运行时**：主机、操作系统、Node、模型、仓库根目录（检测到时）、思考级别（一行）。
- **推理**：当前可见性级别及 /reasoning 切换提示。

系统提示词中的安全护栏是建议性的。它们引导模型行为但不强制执行策略。请使用工具策略、执行审批、沙箱隔离和渠道白名单进行硬性执行；操作人员可以按设计禁用这些功能。

## 提示词模式

OpenClaw 可以为子智能体渲染更小的系统提示词。运行时为每次运行设置一个 `promptMode`（非用户可配置项）：

- `full`（默认）：包含上述所有部分。
- `minimal`：用于子智能体；省略**Skills**、**记忆召回**、**OpenClaw 自更新**、**模型别名**、**用户身份**、**回复标签**、**消息**、**静默回复**和**心跳**。工具、**安全**、工作区、沙箱、当前日期和时间（已知时）、运行时和注入的上下文仍然可用。
- `none`：仅返回基础身份行。

当 `promptMode=minimal` 时，额外注入的提示词标记为**子智能体上下文**而非**群聊上下文**。

## 工作区引导注入

引导文件经过裁剪后附加在**项目上下文**下，使模型无需显式读取即可看到身份和配置上下文：

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（仅在全新工作区时）

大文件会被截断并附加标记。每个文件的最大大小由 `agents.defaults.bootstrapMaxChars` 控制（默认：20000）。缺失的文件会注入一个简短的缺失文件标记。

内部钩子可以通过 `agent:bootstrap` 拦截此步骤，以修改或替换注入的引导文件（例如将 `SOUL.md` 替换为备选人格）。

要查看每个注入文件的贡献量（原始 vs 注入、截断情况，以及工具模式开销），请使用 `/context list` 或 `/context detail`。参见[上下文](/concepts/context)。

## 时间处理

当用户时区已知时，系统提示词包含专门的**当前日期和时间**部分。为保持提示词缓存稳定，现在仅包含**时区**（不含动态时钟或时间格式）。

当智能体需要当前时间时，请使用 `session_status`；状态卡片包含时间戳行。

配置方式：

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat`（`auto` | `12` | `24`）

详见[日期和时间](/date-time)了解全部行为细节。

## Skills

当存在符合条件的 Skills 时，OpenClaw 会注入一个紧凑的**可用 Skills 列表**（`formatSkillsForPrompt`），其中包含每个 Skills 的**文件路径**。提示词指示模型使用 `read` 加载位于所列位置（工作区、托管或捆绑）的 SKILL.md。如果没有符合条件的 Skills，则省略 Skills 部分。

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

这样可以保持基础提示词精简，同时仍然支持有针对性的 Skills 使用。

## 文档

当可用时，系统提示词包含一个**文档**部分，指向本地 OpenClaw 文档目录（仓库工作区中的 `docs/` 或捆绑的 npm 包文档），并注明公共镜像、源代码仓库、社区 Discord 和 ClawHub (https://clawhub.com) 用于 Skills 发现。提示词指示模型在查询 OpenClaw 行为、命令、配置或架构时优先查阅本地文档，并在可能时自行运行 `openclaw status`（仅在无法访问时才询问用户）。
