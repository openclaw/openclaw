# 贡献指南 (中文版)

欢迎来到龙虾池！🦞

## 快速链接

- **GitHub:** https://github.com/openclaw/openclaw
- **愿景:** [`VISION.md`](VISION.md)
- **Discord:** https://discord.gg/clawd
- **X/Twitter:** [@steipete](https://x.com/steipete) / [@openclaw](https://x.com/openclaw)

## 如何贡献

1. **Bug 和小修复** → 提交 PR！
2. **新功能 / 架构** → 先创建 [GitHub Issue](https://github.com/openclaw/openclaw/issues/new/choose) 或在 Discord 中讨论。大多数功能不被接受，应该使用我们的插件 SDK 开发为第三方插件。
3. **纯重构 PR** → 不要提交 PR。除非维护者明确要求，否则我们不接受纯重构更改。
4. **测试/CI 修复** → 不要提交 PR。维护团队已经在跟踪这些失败，仅修改测试或 CI 的 PR 将被关闭，除非它们需要验证新修复。
5. **问题** → Discord [#help](https://discord.com/channels/1456350064065904867/1459642797895319552) / [#users-helping-users](https://discord.com/channels/1456350064065904867/1459007081603403828)

## PR 限制

每个作者最多 **20 个 open PR**。如果超过此限制，将添加 `r: too-many-prs` 标签，您的 PR 将被自动关闭。这是一个硬限制。

对于确实需要超过 20 个 PR 的协调更改集，请先在 Discord 的 **#clawtributors** 频道与维护者沟通。

## 提交 PR 前

- 使用您的 OpenClaw 实例进行本地测试
- 外部 PR 必须在 **What Problem This Solves** 中描述用户、产品或运营问题，并在 **Evidence** 中包含有用的验证。聚焦的测试、CI 结果、截图、录制、终端输出、实时观察、脱敏日志和工件链接都算作验证。审查者将检查代码、测试和 CI；使用 PR 正文来解释意图并使验证易于理解。
- 当 ClawSweeper、Codex、Barnacle 或维护者要求更多上下文或证据时，编辑 PR 描述而不是仅在新评论中回复。保持 **What Problem This Solves**、**Why This Change Was Made**、**User Impact** 和 **Evidence** 为最新；简短的评论可以指出审查者查看更新，但 PR 正文应始终是维护者和机器人的持久解释。
- 保持 PR 可接管：从维护者可以推送的分支打开它们。对于 fork PR，请启用 GitHub 的 **Allow edits by maintainers** 选项，以便维护者可以在需要时完成紧急修复、更新日志条目或合并准备。如果 GitHub 显示 **Allow edits and access to secrets by maintainers**，仅当该工作流/密钥访问可接受时才启用它，并在 PR 中说明。
- 不要在贡献者 PR 中编辑 `CHANGELOG.md`。维护者或 ClawSweeper 会在合并面向用户的更改时添加更新日志条目。
- 运行测试：`pnpm build && pnpm check && pnpm test`
- 对于迭代的本地提交，`scripts/committer --fast "message" <files...>` 跳过提交钩子。仅当您已经为接触的表面运行了等效的目标验证时才使用它。

## 代码风格

- 使用美国英语拼写和语法（代码、注释、文档和 UI 字符串）
- 遵循现有代码风格
- 保持 PR 聚焦（每个 PR 一件事；不要混合不相关的关注点）
- 描述什么和为什么

## AI/辅助编码 PR 欢迎！🤖

使用 Codex、Claude 或其他 AI 工具构建？**很棒 - 只需标记它！**

请在您的 PR 中包含：

- [ ] 在 PR 标题或描述中标记为 AI 辅助
- [ ] 包含最有用的验证的简洁 **Evidence** 部分
- [ ] 如果可能，包含提示或会话日志（超级有帮助！）
- [ ] 确认您理解代码的作用
- [ ] 如果您有 Codex 访问权限，在请求审查前本地运行 `codex review --base origin/main` 并处理发现
- [ ] 在您处理完后解决或回复机器人审查对话

AI PR 在这里是一等公民。我们只是希望透明度，以便审查者知道要查看什么。

## 当前重点和路线图 🗺

我们目前优先考虑：

- **稳定性**：修复频道连接中的边缘情况（WhatsApp/Telegram）。
- **用户体验**：改进入门向导和错误消息。
- **技能**：对于技能贡献，请前往 [ClawHub](https://clawhub.ai/) — OpenClaw 技能的社区中心。
- **性能**：优化 token 使用和压缩逻辑。

查看 [GitHub Issues](https://github.com/openclaw/openclaw/issues) 中的
["good first issue"](https://github.com/openclaw/openclaw/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22)
标签。如果没有开放的 issue，请选择一个小型文档或 bug issue，并留下简短评论说明您想处理它。

## 维护者

我们正在选择性地扩展维护团队。
如果您是一位经验丰富的贡献者，希望帮助塑造 OpenClaw 的方向——无论是通过代码、文档还是社区——我们很乐意听取您的意见。

成为维护者是一种责任，而不是荣誉头衔。我们期望积极、持续的参与——分类问题、审查 PR 和帮助推动项目前进。
