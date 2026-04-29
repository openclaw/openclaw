# 为 OpenClaw 做贡献

欢迎来到龙虾池！🦞

## Quick Links（快速链接）

- **GitHub：** https://github.com/openclaw/openclaw
- **Vision（愿景）：** [`VISION.md`](VISION.md)
- **Discord：** https://discord.gg/clawd
- **X/Twitter：** [@steipete](https://x.com/steipete) / [@openclaw](https://x.com/openclaw)

## Maintainers（维护者）

- **Peter Steinberger** - Benevolent Dictator（仁慈的独裁者）
  - GitHub: [@steipete](https://github.com/steipete) · X: [@steipete](https://x.com/steipete)

- **Shadow** - Discord 子系统、Dicsord 管理员、Clawhub、所有社区管理
  - GitHub: [@thewilloftheshadow](https://github.com/thewilloftheshadow) · X: [@4shadowed](https://x.com/4shadowed)

- **Vignesh** - Memory（QMD）、形式建模、TUI、IRC 和 Lobster
  - GitHub: [@vignesh07](https://github.com/vignesh07) · X: [@\_vgnsh](https://x.com/_vgnsh)

- **Jos** - Telegram、API、Nix mode
  - GitHub: [@joshp123](https://github.com/joshp123) · X: [@jjpcodes](https://x.com/jjpcodes)

- **Ayaan Zaidi** - Telegram 子系统、Android 应用
  - GitHub: [@obviyus](https://github.com/obviyus) · X: [@obviyus](https://x.com/obviyus)

- **Tyler Yust** - Agents/subagents、cron、BlueBubbles、macOS 应用
  - GitHub: [@tyler6204](https://github.com/tyler6204) · X: [@tyleryust](https://x.com/tyleryust)

- **Mariano Belinky** - iOS 应用、安全
  - GitHub: [@mbelinky](https://github.com/mbelinky) · X: [@belimad](https://x.com/belimad)

- **Nimrod Gutman** - iOS 应用、macOS 应用和甲壳类功能
  - GitHub: [@ngutman](https://github.com/ngutman) · X: [@theguti](https://x.com/theguti)

- **Vincent Koc** - Agents、遥测、Hooks、安全
  - GitHub: [@vincentkoc](https://github.com/vincentkoc) · X: [@vincent_koc](https://x.com/vincent_koc)

- **Val Alexander** - UI/UX、文档和 Agent DevX
  - GitHub: [@BunsDev](https://github.com/BunsDev) · X: [@BunsDev](https://x.com/BunsDev)

- **Seb Slight** - 文档、Agent 可靠性、运行时加固
  - GitHub: [@sebslight](https://github.com/sebslight) · X: [@sebslig](https://x.com/sebslig)

- **Christoph Nakazawa** - JS 基础设施
  - GitHub: [@cpojer](https://github.com/cpojer) · X: [@cnakazawa](https://x.com/cnakazawa)

- **Gustavo Madeira Santana** - Multi-agents、CLI、性能、Plugins、Matrix
  - GitHub: [@gumadeiras](https://github.com/gumadeiras) · X: [@gumadeiras](https://x.com/gumadeiras)

- **Onur Solmaz** - Agents、开发工作流、ACP 集成、MS Teams
  - GitHub: [@onutc](https://github.com/onutc)、[@osolmaz](https://github.com/osolmaz) · X: [@onusoz](https://x.com/onusoz)

- **Josh Avant** - Core、CLI、Gateway、安全、Agents
  - GitHub: [@joshavant](https://github.com/joshavant) · X: [@joshavant](https://x.com/joshavant)

- **Jonathan Taylor** - ACP 子系统、Gateway 功能/bugs、Gog/Mog/Sog CLI's、SEDMAT
  - GitHub [@visionik](https://github.com/visionik) · X: [@visionik](https://x.com/visionik)

- **Josh Lehman** - Compaction、Context Engine
  - GitHub [@jalehman](https://github.com/jalehman) · X: [@jlehman\_](https://x.com/jlehman_)

- **Radek Sienkiewicz** - 文档、Control UI
  - GitHub [@velvet-shark](https://github.com/velvet-shark) · X: [@velvet_shark](https://twitter.com/velvet_shark)

- **Muhammed Mukhthar** - Mattermost、CLI
  - GitHub [@mukhtharcm](https://github.com/mukhtharcm) · X: [@mukhtharcm](https://x.com/mukhtharcm)

- **Altay** - Agents、CLI、错误处理
  - GitHub [@altaywtf](https://github.com/altaywtf) · X: [@altaywtf](https://x.com/altaywtf)

- **Robin Waslander** - 安全、PR 分类、bug 修复
  - GitHub: [@hydro13](https://github.com/hydro13) · X: [@Robin_waslander](https://x.com/Robin_waslander)

- **Tengji (George) Zhang** - 中国模型 API、云、pi
  - GitHub: [@odysseus0](https://github.com/odysseus0) · X: [@odysseus0z](https://x.com/odysseus0z)

- **Sliverp** - 中国渠道：QQ、微信、企业微信、源宝、钉钉、飞书
  - GitHub: [@sliverp](https://github.com/sliverp) · X: [@sliverp](https://x.com/sliverp)

- **Mason Huang** - 稳定性、安全、速度
  - GitHub: [@hxy91819](https://github.com/hxy91819) · X: [@chenjingtalk](https://x.com/chenjingtalk)

## How to Contribute（如何贡献）

1. **Bugs & small fixes（Bug 和小修复）** → 开一个 PR！
2. **New features / architecture（新功能/架构）** → 先在 [GitHub Issue](https://github.com/openclaw/openclaw/issues/new/choose) 或 Discord 询问。大多数功能不会被接受，应该使用我们的 plugin SDK 作为第三方插件。
3. **Refactor-only PRs（仅重构的 PR）** → 不要开 PR。除非维护者作为具体修复的一部分明确要求，否则我们不接受仅重构的更改。
4. **针对已知 `main` 故障的 Test/CI-only PRs** → 不要开 PR。维护者团队已经在跟踪这些故障，仅调整测试或 CI 以追赶它们的 PR 将被关闭，除非它们是验证新修复所必需的。
5. **Questions（问题）** → Discord [#help](https://discord.com/channels/1456350064065904867/1459642797895319552) / [#users-helping-users](https://discord.com/channels/1456350064065904867/1459007081603403828)

## PR Limits（PR 限制）

我们限制**每个作者最多 10 个 open PR**。如果您超过此限制，将添加 `r: too-many-prs` 标签，您的 PR 将被自动关闭。这是硬限制。

对于确实需要超过 10 个 PR 的协调变更集，请加入 Discord 的 **#clawtributors** 频道并先与维护者交谈。

## Before You PR（PR 前）

- 使用您的 OpenClaw 实例在本地测试
- 运行测试：`pnpm build && pnpm check && pnpm test`
- 对于迭代性本地提交，`scripts/committer --fast "message" <files...>` 将 `FAST_COMMIT=1` 传递到 pre-commit hook，因此它跳过 repo 范围的 `pnpm check`。仅在您已对触及的表面运行了等效的针对性验证时才使用它。
- 对于扩展/plugin 更改，首先运行快速本地 lane：
  - `pnpm test:extension <extension-name>`
  - `pnpm test:extension --list` 查看有效的扩展 id
  - 如果您更改了共享 plugin 或 channel surface，运行 `pnpm test:contracts`
  - 对于针对性的共享 surface 工作，使用 `pnpm test:contracts:channels` 或 `pnpm test:contracts:plugins`
  - 这些命令还覆盖了默认单元 lane 跳过的共享 seam/smoke 文件
  - 如果您更改了更广泛的运行时行为，仍需在请求审查前运行相关更广泛的 lanes（`pnpm test:extensions`、`pnpm test:channels` 或 `pnpm test`）
- 如果您在共享代码中触及了捆绑 plugin 边界，运行匹配的 inventories：
  - `node scripts/check-src-extension-import-boundary.mjs --json` 用于 `src/**`
  - `node scripts/check-sdk-package-extension-import-boundary.mjs --json` 用于 `src/plugin-sdk/**` 和 `packages/**`
  - `node scripts/check-test-helper-extension-import-boundary.mjs --json` 用于 `test/helpers/**`
- 共享测试辅助函数必须使用 `src/test-utils/bundled-plugin-public-surface.ts` 而非 repo 相对的 `extensions/**` 导入。将 plugin 本地深层 mock 保留在拥有的捆绑 plugin 包内。
- 如果您有 Codex 访问权限，在开 PR 或更新 PR 前在本地运行 `codex review --base origin/main`。将这视为当前 AI 审查的最高标准，即使 GitHub Codex review 也会运行。
- 除非维护者明确要求作为 active fix 或 deliverable 的一部分，否则不要提交仅重构的 PR。
- 不要为已在 `main` CI 上红色的已知故障提交仅测试或 CI 配置的修复。如果失败已在 [main branch CI runs](https://github.com/openclaw/openclaw/actions) 中可见，则是维护者团队正在跟踪的已知问题，仅解决这些故障的 PR 将被自动关闭。如果您发现 _new_ 回归（main CI 中尚未显示），请先作为 issue 报告。
- 不要提交仅试图使已知 `main` CI 故障通过的仅测试 PR。当它们是验证同一 PR 中的新修复或覆盖新行为所必需时，测试更改是可以接受的。
- 确保 CI 检查通过
- 保持 PR focused（一件事一个 PR；不要混合不相关的关注点）
- 描述 what & why（什么和为什么）
- 回复或解决您在再次请求审查前已解决的 bot review 对话
- **包含截图** — 一张显示问题/before，一张显示修复/after（用于 UI 或视觉更改）
- 在代码、注释、文档和 UI 字符串中使用美式英语拼写和语法
- 不要编辑 `CODEOWNERS` 安全所有权涵盖的文件，除非列出的所有者明确要求更改或已经在与您一起审查。將这些路径视为受限审查 surface，而非机会主义清理目标。

## Review Conversations Are Author-Owned（审查对话由作者负责）

如果 review bot 在您的 PR 上留下审查对话，您需要负责跟进：

- 一旦代码或解释完全解决 bot 的顾虑，自行解决对话
- 仅在需要维护者或审查者判断时才回复并保持开放
- 不要留下 "fixed" bot review 对话让维护者为您清理
- 如果 Codex 留下评论，解决每一个相关的评论，或者当它不适用于您的更改时用简短解释解决它
- 如果 GitHub Codex review 由于某种原因没有触发，仍然在本地运行 `codex review --base origin/main` 并将输出视为必需的审查工作

这适用于人工撰写和 AI 辅助的 PR。

## Control UI Decorators

Control UI 使用 Lit 和 **legacy** decorators（当前 Rollup 解析不支持标准 decorators 所需的 `accessor` 字段）。添加 reactive fields 时，保持 legacy 风格：

```ts
@state() foo = "bar";
@property({ type: Number }) count = 0;
```

根 `tsconfig.json` 配置为 legacy decorators（`experimentalDecorators: true`）和 `useDefineForClassFields: false`。除非您也在更新 UI 构建工具以支持标准 decorators，否则不要翻转这些设置。

## AI/Vibe-Coded PRs Welcome! 🤖（欢迎 AI/Vibe-Coded PR！）

使用 Codex、Claude 或其他 AI 工具构建？**太棒了 — 只需标记它！**

请在您的 PR 中包含：

- [ ] 在 PR 标题或描述中标记为 AI-assisted
- [ ] 说明测试程度（未测试/轻测/完全测试）
- [ ] 如果可能，包括 prompts 或 session logs（非常有帮助！）
- [ ] 确认您理解代码的作用
- [ ] 如果您有 Codex 访问权限，在请求审查前在本地运行 `codex review --base origin/main` 并解决发现的问题
- [ ] 在您解决它们后，解决或回复 bot review 对话

AI PR 在这里是头等公民。我们只想要透明度，以便审查者知道要查找什么。如果您使用 LLM 编码 agent，请指示它解决它已处理的 bot review 对话，而不是为维护者留下它们。

## Current Focus & Roadmap 🗺（当前重点和路线图）

我们目前优先考虑：

- **Stability（稳定性）**：修复渠道连接（WhatsApp/Telegram）中的边缘情况。
- **UX**：改进引导向导和错误消息。
- **Skills**：对于技能贡献，请前往 [ClawHub](https://clawhub.ai/) — OpenClaw 技能的中心社区。
- **Performance（性能）**：优化 token 使用和压缩逻辑。

查看 [GitHub Issues](https://github.com/openclaw/openclaw/issues) 中的
["good first issue"](https://github.com/openclaw/openclaw/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
标签。如果没有开放的，请选择一个小型的文档或 bug issue 并留下快速评论说明您想处理它。

## Maintainers（维护者）

我们正在选择性扩展维护者团队。
如果您是一位想要帮助塑造 OpenClaw 方向的经验丰富的贡献者 — 无论是通过代码、文档还是社区 — 我们希望收到您的来信。

成为维护者是一种责任，而不是荣誉称号。我们期望积极的、持续的参与 — 分类 issue、审查 PR 并帮助推动项目向前发展。

仍然感兴趣？发送电子邮件至 contributing@openclaw.ai，包括：

- 您在 OpenClaw 上的 PR 链接（如果您没有任何，请先从那里开始）
- 您维护或积极贡献的开源项目链接
- 您的 GitHub、Discord 和 X/Twitter 句柄
- 简短的自我介绍：背景、经验和兴趣领域
- 您使用的语言和所在地区
- 您可以真实投入的时间

我们欢迎各种技能的人 — 工程、文档、社区管理等。
我们仔细审查每一份仅人工撰写的申请，并缓慢而谨慎地添加维护者。
请等待几周的回复。

## Report a Vulnerability（报告漏洞）

我们认真对待安全报告。请直接将漏洞报告到问题所在的仓库：

- **Core CLI 和 gateway** — [openclaw/openclaw](https://github.com/openclaw/openclaw)
- **macOS 桌面应用** — [openclaw/openclaw](https://github.com/openclaw/openclaw)（apps/macos）
- **iOS 应用** — [openclaw/openclaw](https://github.com/openclaw/openclaw)（apps/ios）
- **Android 应用** — [openclaw/openclaw](https://github.com/openclaw/openclaw)（apps/android）
- **ClawHub** — [openclaw/clawhub](https://github.com/openclaw/clawhub)
- **信任和威胁模型** — [openclaw/trust](https://github.com/openclaw/trust)

对于不适合特定仓库的问题，或者如果您不确定，请发送电子邮件至 **security@openclaw.ai**，我们会为其路由。

### Required in Reports（报告中必需的内容）

1. **Title（标题）**
2. **Severity Assessment（严重程度评估）**
3. **Impact（影响）**
4. **Affected Component（受影响的组件）**
5. **Technical Reproduction（技术复现步骤）**
6. **Demonstrated Impact（证明的影响）**
7. **Environment（环境）**
8. **Remediation Advice（修复建议）**

没有复现步骤、证明的影响和修复建议的报告将被降低优先级。鉴于 AI 生成的扫描器结果的数量，我们必须确保收到来自理解这些问题的研究人员的经过审查的报告。
