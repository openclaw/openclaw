## OpenClaw Vision（OpenClaw 愿景）

OpenClaw 是真正能做事的 AI。
它运行在您的设备上，通过您的渠道，遵守您的规则。

本文档解释了项目的当前状态和方向。
我们仍处于早期阶段，因此迭代很快。
项目概述和开发者文档：[`README.md`](README.md)
贡献指南：[`CONTRIBUTING.md`](CONTRIBUTING.md)

OpenClaw 最初是一个个人 playground，用于学习 AI 和构建真正有用的东西：一个能在真实计算机上运行真实任务的助手。
它经历了几个名称和 shell：Warelay -> Clawdbot -> Moltbot -> OpenClaw。

目标：一个易于使用、支持广泛平台、尊重隐私和安全的个人助手。

当前重点：

Priority（优先）：

- Security and safe defaults（安全和安全的默认值）
- Bug fixes and stability（Bug 修复和稳定性）
- Setup reliability and first-run UX（设置可靠性和首次运行用户体验）

Next priorities（下一优先级）：

- Supporting all major model providers（支持所有主要模型提供商）
- Improving support for major messaging channels（and adding a few high-demand ones）（改进对主要消息渠道的支持，并添加一些高需求的渠道）
- Performance and test infrastructure（性能和测试基础设施）
- Better computer-use and agent harness capabilities（更好的计算机使用和 agent 工具能力）
- Ergonomics across CLI and web frontend（CLI 和 Web 前端的人体工程学）
- Companion apps on macOS, iOS, Android, Windows, and Linux（macOS、iOS、Android、Windows 和 Linux 上的配套应用）

Contribution rules（贡献规则）：

- One PR = one issue/topic. Do not bundle multiple unrelated fixes/features.（一个 PR = 一个 issue/topic。不要将多个不相关的修复/功能捆绑在一起。）
- PRs over ~5,000 changed lines are reviewed only in exceptional circumstances.（超过约 5,000 行更改的 PR 仅在特殊情况下审查。）
- Do not open large batches of tiny PRs at once; each PR has review cost.（不要一次开大量微小的 PR；每个 PR 都有审查成本。）
- For very small related fixes, grouping into one focused PR is encouraged.（对于非常小的相关修复，鼓励合并到一个有重点的 PR 中。）

## Security（安全）

OpenClaw 的安全是一种深思熟虑的权衡：强大的默认值而不损害能力。
目标是保持强大的真实工作能力，同时使风险路径明确且由操作员控制。

规范的安全策略和报告：

- [`SECURITY.md`](SECURITY.md)

我们优先考虑安全默认值，但也为受信任的高能力工作流暴露明确的旋钮。

## Plugins & Memory（插件和内存）

OpenClaw 拥有广泛的 plugin API。
Core 保持精简；可选能力通常应作为 plugins 发布。
我们正在总体精简 core，同时扩展 plugins 可以做什么。
如果一个有用的功能目前无法作为 plugin 构建，我们欢迎扩展 plugin API 的 PR 和设计讨论，而不是添加一次性的 core 行为。

有两种广泛的 plugin 样式：

- Code plugins（代码插件）运行 OpenClaw plugin 代码，适用于更深入的运行时扩展。
- Bundle-style plugins（捆绑式插件）打包稳定的外部 surface，如 skills、MCP servers 和相关配置。

当 bundle-style plugins 能够表达能力时优先使用它们。
它们具有更小、更稳定的接口和更好的安全边界。
当能力需要运行时钩子、提供商、渠道、工具或其他进程内扩展点时，使用 code plugins。

首选 plugin 路径是 npm 包分发加上用于开发的本地扩展加载。
如果您构建一个 plugin，请在您自己的仓库中托管和维护它。
向 core 添加可选 plugins 的门槛有意很高。
Plugin 文档：[`docs/tools/plugin.md`](docs/tools/plugin.md)
Plugin 发现、官方发布者状态、出处和安全审查位于 [ClawHub](https://clawhub.ai/)。
OpenClaw 文档应记录 core 扩展点；plugin 推广属于 ClawHub，优选在经过审查的组织发布者下用于官方 plugins。

Memory 是一个特殊的 plugin slot，一次只能有一个 memory plugin 处于活动状态。
今天我们发布多个 memory 选项；随着时间的推移，我们计划收敛到一条推荐的默认路径。

### Skills（技能）

我们仍然发布一些捆绑的 skills 以获得基线用户体验。
新 skills 应首先通过 [ClawHub](https://clawhub.ai/) 发布，而不是默认添加到 core。
官方或捆绑推广需要明确的产品、安全或维护者所有权原因。

### MCP Support（MCP 支持）

OpenClaw 支持 MCP 作为 server 和运行时集成 surface。
MCP 详细信息位于 [`docs/cli/mcp.md`](docs/cli/mcp.md)。

项目目标是务实的 MCP 支持，而不复制现有的 agent、
tool、ACPX、plugin 或 ClawHub 路径。

### Setup（设置）

OpenClaw 目前在设计上是终端优先的。
这保持了设置的明确性：用户预先看到文档、auth、权限和安全态势。

从长远来看，随着 hardening 的成熟，我们想要更简单的 onboarding flows。
我们不想要隐藏关键安全决策的便利包装。

### Why TypeScript？（为什么使用 TypeScript？）

OpenClaw 主要是一个编排系统：prompts、tools、protocols 和集成。
选择 TypeScript 是为了让 OpenClaw 默认可 hack。
它被广泛知晓、迭代快速、易于阅读、修改和扩展。

## What We Will Not Merge (For Now)（我们不会合并的内容（暂时））

- 当它们可以放在 [ClawHub](https://clawhub.ai/) 时的新 core skills
- 所有文档的完整翻译集（推迟；我们计划稍后进行 AI 生成的翻译）
- 不明确符合 model-provider 类别的商业服务集成
- 在没有明确能力或安全差距的情况下，围绕已支持渠道的包装渠道
- 在没有明确产品或安全差距的情况下，复制现有 MCP、ACPX、plugin 或 ClawHub 路径的 MCP 工作
- 作为默认架构的 Agent-hierarchy 框架（manager-of-managers / 嵌套 planner trees）
- 复制现有 agent 和 tool 基础设施的重型编排层

此列表是路线图护栏，而非物理定律。
强烈的用户需求和强有力的技术理由可以改变它。
