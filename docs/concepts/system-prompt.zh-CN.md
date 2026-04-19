---
summary: "OpenClaw 系统提示包含的内容及其组装方式"
read_when:
  - 编辑系统提示文本、工具列表或时间/心跳部分
  - 更改工作区引导或技能注入行为
---

# 系统提示

OpenClaw 为每次代理运行构建自定义系统提示。该提示是 **OpenClaw 所有**的，不使用 pi-coding-agent 默认提示。

提示由 OpenClaw 组装并注入到每次代理运行中。

提供者插件可以贡献缓存感知的提示指导，而无需替换完整的 OpenClaw 所有提示。提供者运行时可以：

- 替换一小组命名核心部分（`interaction_style`、`tool_call_style`、`execution_bias`）
- 在提示缓存边界上方注入 **稳定前缀**
- 在提示缓存边界下方注入 **动态后缀**

使用提供者所有的贡献进行模型系列特定的调整。保留遗留的 `before_prompt_build` 提示变异用于兼容性或真正的全局提示更改，而不是正常的提供者行为。

## 结构

提示故意紧凑并使用固定部分：

- **工具**：结构化工具真实来源提醒加上运行时工具使用指导。
- **安全**：简短的护栏提醒，避免权力寻求行为或绕过监督。
- **技能**（可用时）：告诉模型如何按需加载技能指令。
- **OpenClaw 自我更新**：如何安全地使用 `config.schema.lookup` 检查配置，使用 `config.patch` 修补配置，使用 `config.apply` 替换完整配置，以及仅在用户明确请求时运行 `update.run`。仅所有者的 `gateway` 工具也拒绝重写 `tools.exec.ask` / `tools.exec.security`，包括规范化到这些受保护执行路径的遗留 `tools.bash.*` 别名。
- **工作区**：工作目录（`agents.defaults.workspace`）。
- **文档**：OpenClaw 文档的本地路径（仓库或 npm 包）以及何时阅读它们。
- **工作区文件（注入）**：表示引导文件包含在下方。
- **沙盒**（启用时）：表示沙盒运行时、沙盒路径以及是否可用提升执行。
- **当前日期和时间**：用户本地时间、时区和时间格式。
- **回复标签**：支持的提供者的可选回复标签语法。
- **心跳**：心跳提示和确认行为，当默认代理启用心跳时。
- **运行时**：主机、操作系统、节点、模型、仓库根目录（检测到时）、思考级别（一行）。
- **推理**：当前可见性级别 + /reasoning 切换提示。

工具部分还包括长期运行工作的运行时指导：

- 使用 cron 进行未来跟进（`稍后检查`、提醒、重复工作）
  而不是 `exec` 睡眠循环、`yieldMs` 延迟技巧或重复的 `process`
  轮询
- 仅对现在开始并在后台继续运行的命令使用 `exec` / `process`
- 当启用自动完成唤醒时，启动命令一次并在其发出输出或失败时依赖基于推送的唤醒路径
- 当需要检查正在运行的命令时，使用 `process` 进行日志、状态、输入或干预
- 如果任务更大，首选 `sessions_spawn`；子代理完成是基于推送的，并自动向请求者宣布
- 不要在循环中轮询 `subagents list` / `sessions_list` 只是为了等待完成

当启用实验性 `update_plan` 工具时，工具还告诉模型仅将其用于非平凡的多步骤工作，保持恰好一个 `in_progress` 步骤，并避免在每次更新后重复整个计划。

系统提示中的安全护栏是建议性的。它们指导模型行为但不执行政策。使用工具政策、执行批准、沙盒和通道允许列表进行硬执行；操作员可以通过设计禁用这些。

在具有原生批准卡/按钮的通道上，运行时提示现在告诉代理首先依赖该原生批准 UI。只有当工具结果表明聊天批准不可用或手动批准是唯一路径时，它才应包含手动 `/approve` 命令。

## 提示模式

OpenClaw 可以为子代理渲染更小的系统提示。运行时为每次运行设置 `promptMode`（不是用户面向的配置）：

- `full`（默认）：包括上面的所有部分。
- `minimal`：用于子代理；省略 **技能**、**内存回忆**、**OpenClaw
  自我更新**、**模型别名**、**用户身份**、**回复标签**、**消息传递**、**静默回复** 和 **心跳**。工具、**安全**、工作区、沙盒、当前日期和时间（已知时）、运行时和注入上下文保持可用。
- `none`：仅返回基本身份行。

当 `promptMode=minimal` 时，额外注入的提示被标记为 **子代理上下文** 而不是 **群聊上下文**。

## 工作区引导注入

引导文件被修剪并附加在 **项目上下文** 下，这样模型可以看到身份和配置文件上下文，而无需显式读取：

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（仅在全新工作区）
- `MEMORY.md`（存在时），否则 `memory.md` 作为小写回退

所有这些文件在每轮都 **注入到上下文窗口** 中，除非应用了特定于文件的门控。当默认代理禁用心跳或 `agents.defaults.heartbeat.includeSystemPromptSection` 为 false 时，正常运行会省略 `HEARTBEAT.md`。保持注入文件简洁 — 尤其是 `MEMORY.md`，它会随着时间增长并导致意外的高上下文使用和更频繁的压缩。

> **注意：** `memory/*.md` 每日文件 **不是** 正常引导项目上下文的一部分。在普通轮次中，它们通过 `memory_search` 和 `memory_get` 工具按需访问，因此除非模型显式读取它们，否则它们不会计入上下文窗口。裸露的 `/new` 和 `/reset` 轮次是例外：运行时可以为该第一轮前置最近的每日记忆作为一次性启动上下文块。

大文件会用标记截断。每个文件的最大大小由 `agents.defaults.bootstrapMaxChars` 控制（默认：12000）。跨文件的总注入引导内容由 `agents.defaults.bootstrapTotalMaxChars` 限制（默认：60000）。缺失的文件会注入简短的缺失文件标记。当发生截断时，OpenClaw 可以在项目上下文中注入警告块；通过 `agents.defaults.bootstrapPromptTruncationWarning` 控制（`off`、`once`、`always`；默认：`once`）。

子代理会话仅注入 `AGENTS.md` 和 `TOOLS.md`（其他引导文件被过滤掉以保持子代理上下文小）。

内部钩子可以通过 `agent:bootstrap` 拦截此步骤，以变异或替换注入的引导文件（例如将 `SOUL.md` 交换为替代角色）。

如果你想让代理听起来不那么通用，从 [SOUL.md 个性指南](/concepts/soul) 开始。

要检查每个注入文件的贡献量（原始 vs 注入、截断，加上工具模式开销），使用 `/context list` 或 `/context detail`。请参阅 [上下文](/concepts/context)。

## 时间处理

当用户时区已知时，系统提示包含专门的 **当前日期和时间** 部分。为了保持提示缓存稳定，它现在仅包含 **时区**（无动态时钟或时间格式）。

当代理需要当前时间时使用 `session_status`；状态卡包含时间戳行。同一工具可以选择性地设置每个会话的模型覆盖（`model=default` 清除它）。

配置：

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat`（`auto` | `12` | `24`）

请参阅 [日期和时间](/date-time) 了解完整行为详情。

## 技能

当存在合格技能时，OpenClaw 注入紧凑的 **可用技能列表**（`formatSkillsForPrompt`），其中包含每个技能的 **文件路径**。提示指示模型使用 `read` 加载列出位置（工作区、托管或捆绑）的 SKILL.md。如果没有合格技能，则省略技能部分。

资格包括技能元数据门控、运行时环境/配置检查以及当配置 `agents.defaults.skills` 或 `agents.list[].skills` 时的有效代理技能允许列表。

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

这保持基础提示小，同时仍然启用有针对性的技能使用。

技能列表预算由技能子系统拥有：

- 全局默认：`skills.limits.maxSkillsPromptChars`
- 每个代理覆盖：`agents.list[].skillsLimits.maxSkillsPromptChars`

通用有界运行时摘录使用不同的表面：

- `agents.defaults.contextLimits.*`
- `agents.list[].contextLimits.*`

这种分离使技能大小与运行时读取/注入大小（如 `memory_get`、实时工具结果和压缩后 AGENTS.md 刷新）分开。

## 文档

当可用时，系统提示包含 **文档** 部分，指向本地 OpenClaw 文档目录（仓库工作区中的 `docs/` 或捆绑的 npm 包文档），并注明公共镜像、源仓库、社区 Discord 和 ClawHub（[https://clawhub.ai](https://clawhub.ai)）用于技能发现。提示指示模型首先查阅本地文档了解 OpenClaw 行为、命令、配置或架构，并在可能的情况下自己运行 `openclaw status`（仅在缺乏访问权限时询问用户）。
