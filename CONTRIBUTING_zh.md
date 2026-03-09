# 为 OpenClaw 贡献力量

欢迎来到龙虾池！🦞

## 快速链接

- **GitHub:** https://github.com/openclaw/openclaw
- **愿景:** [`VISION.md`](VISION.md)
- **Discord:** https://discord.gg/qkhbAGHRBT
- **X/Twitter:** [@steipete](https://x.com/steipete) / [@openclaw](https://x.com/openclaw)

## 维护者

- **Peter Steinberger** - 仁慈的独裁者 (Benevolent Dictator)
  - GitHub: [@steipete](https://github.com/steipete) · X: [@steipete](https://x.com/steipete)

- **Shadow** - Discord 子系统, Discord 管理员, Clawhub, 所有社区调节
  - GitHub: [@thewilloftheshadow](https://github.com/thewilloftheshadow) · X: [@4shad0wed](https://x.com/4shad0wed)

- **Vignesh** - 内存 (QMD), 形式建模, TUI, IRC, 以及 Lobster
  - GitHub: [@vignesh07](https://github.com/vignesh07) · X: [@\_vgnsh](https://x.com/_vgnsh)

- **Jos** - Telegram, API, Nix 模式
  - GitHub: [@joshp123](https://github.com/joshp123) · X: [@jjpcodes](https://x.com/jjpcodes)

- **Ayaan Zaidi** - Telegram 子系统, iOS 应用
  - GitHub: [@obviyus](https://github.com/obviyus) · X: [@0bviyus](https://x.com/0bviyus)

- **Tyler Yust** - 代理/子代理, cron, BlueBubbles, macOS 应用
  - GitHub: [@tyler6204](https://github.com/tyler6204) · X: [@tyleryust](https://x.com/tyleryust)

- **Mariano Belinky** - iOS 应用, 安全
  - GitHub: [@mbelinky](https://github.com/mbelinky) · X: [@belimad](https://x.com/belimad)

- **Nimrod Gutman** - iOS 应用, macOS 应用及甲壳类功能
  - GitHub: [@ngutman](https://github.com/ngutman) · X: [@theguti](https://x.com/theguti)

- **Vincent Koc** - 代理, 遥测, 钩子, 安全
  - GitHub: [@vincentkoc](https://github.com/vincentkoc) · X: [@vincent_koc](https://x.com/vincent_koc)

- **Val Alexander** - UI/UX, 文档, 以及代理开发体验 (DevX)
  - GitHub: [@BunsDev](https://github.com/BunsDev) · X: [@BunsDev](https://x.com/BunsDev)

- **Seb Slight** - 文档, 代理可靠性, 运行时加固
  - GitHub: [@sebslight](https://github.com/sebslight) · X: [@sebslig](https://x.com/sebslig)

- **Christoph Nakazawa** - JS 基础设施
  - GitHub: [@cpojer](https://github.com/cpojer) · X: [@cnakazawa](https://x.com/cnakazawa)

- **Gustavo Madeira Santana** - 多代理, CLI, web UI
  - GitHub: [@gumadeiras](https://github.com/gumadeiras) · X: [@gumadeiras](https://x.com/gumadeiras)

- **Onur Solmaz** - 代理, 开发工作流, ACP 集成, MS Teams
  - GitHub: [@onutc](https://github.com/onutc), [@osolmaz](https://github.com/osolmaz) · X: [@onusoz](https://x.com/onusoz)

- **Josh Avant** - 核心, CLI, 网关, 安全, 代理
  - GitHub: [@joshavant](https://github.com/joshavant) · X: [@joshavant](https://x.com/joshavant)

- **Jonathan Taylor** - ACP 子系统, 网关功能/错误, Gog/Mog/Sog CLI's, SEDMAT
  - Github [@visionik](https://github.com/visionik) · X: [@visionik](https://x.com/visionik)
- **Josh Lehman** - 压缩, Tlon/Urbit 子系统
  - Github [@jalehman](https://github.com/jalehman) · X: [@jlehman\_](https://x.com/jlehman_)

## 如何贡献

1. **Bug & 小修复** → 开启一个 PR！
2. **新功能 / 架构** → 先发起一个 [GitHub Discussion](https://github.com/openclaw/openclaw/discussions) 或在 Discord 中询问
3. **问题** → Discord [#help](https://discord.com/channels/1456350064065904867/1459642797895319552) / [#users-helping-users](https://discord.com/channels/1456350064065904867/1459007081603403828)

## 提交 PR 之前

- 在你的 OpenClaw 实例上进行本地测试
- 运行测试: `pnpm build && pnpm check && pnpm test`
- 确保 CI 检查通过
- 保持 PR 专注 (每个 PR 只做一件事；不要混合无关的关注点)
- 描述做了什么以及为什么这么做

## 控制 UI 装饰器 (Decorators)

控制 UI 使用 Lit 以及 **旧版** 装饰器 (目前的 Rollup 解析不支持标准装饰器所需的 `accessor` 字段)。添加响应式字段时，请保持旧版风格：

```ts
@state() foo = "bar";
@property({ type: Number }) count = 0;
```

根目录下的 `tsconfig.json` 已配置为使用旧版装饰器 (`experimentalDecorators: true`) 且 `useDefineForClassFields: false`。除非你同时也更新了支持标准装饰器的 UI 构建工具，否则请避免更改这些设置。

## 欢迎 AI/氛围编码 (Vibe-Coded) 的 PR！🤖

使用 Codex、Claude 或其他 AI 工具构建的？**太棒了 —— 只需标记出来！**

请在你的 PR 中包含：

- [ ] 在 PR 标题或描述中标记为 AI 辅助
- [ ] 注明测试程度 (未测试 / 轻度测试 / 充分测试)
- [ ] 如果可能，请包含提示词 (prompts) 或会话日志 (非常有帮助！)
- [ ] 确认你理解代码的功能

AI PR 在这里是一等公民。我们只是希望保持透明，以便审查者知道该关注什么。

## 当前关注点 & 路线图 🗺

我们目前优先考虑：

- **稳定性**: 修复渠道连接 (WhatsApp/Telegram) 中的边缘情况。
- **用户体验 (UX)**: 改进入门向导和错误消息。
- **技能**: 对于技能贡献，请前往 [ClawHub](https://clawhub.ai/) —— OpenClaw 技能的社区枢纽。
- **性能**: 优化 token 使用和压缩逻辑。

查看 [GitHub Issues](https://github.com/openclaw/openclaw/issues) 中的 "good first issue" 标签！

## 维护者招募

我们正在有选择地扩大维护者团队。
如果你是一位经验丰富的贡献者，并希望帮助塑造 OpenClaw 的发展方向 —— 无论是通过代码、文档还是社区 —— 我们都希望听到你的声音。

成为维护者是一份责任，而不是一个荣誉头衔。我们期望积极、持续的参与 —— 分类问题、审查 PR，并帮助推动项目前进。

还有兴趣吗？发送邮件至 contributing@openclaw.ai，并包含以下内容：

- 你在 OpenClaw 上的 PR 链接 (如果你还没有，请先从那里开始)
- 你维护或积极贡献的开源项目链接
- 你的 GitHub、Discord 和 X/Twitter 账号
- 简短介绍：背景、经验和感兴趣的领域
- 你所说的语言以及你所在地
- 你现实中能投入多少时间

我们欢迎各种技能背景的人才 —— 工程、文档、社区管理等。
我们会仔细审查每一份仅由人类编写的申请，并缓慢而审慎地增加维护者。
请留出几周时间等待回复。

## 报告漏洞

我们认真对待安全报告。请直接向问题所在的存储库报告漏洞：

- **核心 CLI 和网关** —— [openclaw/openclaw](https://github.com/openclaw/openclaw)
- **macOS 桌面应用** —— [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/macos)
- **iOS 应用** —— [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/ios)
- **Android 应用** —— [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/android)
- **ClawHub** —— [openclaw/clawhub](https://github.com/openclaw/clawhub)
- **信任和威胁模型** —— [openclaw/trust](https://github.com/openclaw/trust)

对于不属于特定存储库的问题，或者如果你不确定，请发送邮件至 **security@openclaw.ai**，我们会进行转发。

### 报告中需要包含的内容

1. **标题**
2. **严重性评估**
3. **影响**
4. **受影响的组件**
5. **技术复现步骤**
6. **已证实的影响**
7. **环境**
8. **修复建议**

没有复现步骤、证实的影响和修复建议的报告将被降低优先级。鉴于 AI 生成的扫描发现数量巨大，我们必须确保收到的是来自理解问题的研究人员经过审核的报告。
