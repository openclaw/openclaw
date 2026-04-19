# 安全政策

如果您认为您在 OpenClaw 中发现了安全问题，请私下报告。

## 报告

直接向问题所在的存储库报告漏洞：

- **核心 CLI 和网关** — [openclaw/openclaw](https://github.com/openclaw/openclaw)
- **macOS 桌面应用** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/macos)
- **iOS 应用** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/ios)
- **Android 应用** — [openclaw/openclaw](https://github.com/openclaw/openclaw) (apps/android)
- **ClawHub** — [openclaw/clawhub](https://github.com/openclaw/clawhub)
- **信任和威胁模型** — [openclaw/trust](https://github.com/openclaw/trust)

对于不适合特定存储库的问题，或者如果您不确定，请发送电子邮件至 **[security@openclaw.ai](mailto:security@openclaw.ai)**，我们将路由它。

有关完整的报告说明，请参阅我们的 [信任页面](https://trust.openclaw.ai)。

### 报告中必需的内容

1. **标题**
2. **严重性评估**
3. **影响**
4. **受影响的组件**
5. **技术重现**
6. **证明的影响**
7. **环境**
8. **补救建议**

没有重现步骤、证明的影响和补救建议的报告将被降级。鉴于 AI 生成的扫描器发现的数量，我们必须确保我们收到来自理解问题的研究人员的经过审查的报告。

### 报告接受门（分类快速路径）

为了最快的分类，请包括以下所有内容：

- 当前修订版上的确切易受攻击路径（`文件`、函数和行范围）。
- 测试版本详细信息（OpenClaw 版本和/或提交 SHA）。
- 针对最新 `main` 或最新发布版本的可重现 PoC。
- 如果声明针对已发布版本，来自该确切版本的已发布标签和已发布工件/包的证据（不仅是 `main`）。
- 与 OpenClaw 记录的信任边界相关的证明影响。
- 对于暴露的秘密报告：证明凭证是 OpenClaw 拥有的（或授予对 OpenClaw 运营的基础设施/服务的访问权限）。
- 明确声明报告不依赖于共享一个网关主机/配置的对抗性操作员。
- 范围检查，解释为什么报告 **不** 被下面的超出范围部分覆盖。
- 对于命令风险/奇偶性报告（例如混淆检测差异），需要具体的边界绕过路径（auth/approval/allowlist/sandbox）。仅奇偶性发现被视为强化，而不是漏洞。

缺少这些要求的报告可能会被关闭为 `invalid` 或 `no-action`。

### 常见误报模式

这些经常被报告，但通常关闭时没有代码更改：

- 没有边界绕过的仅提示注入链（提示注入超出范围）。
- 操作员意图的本地功能（例如 TUI 本地 `!` shell）被呈现为远程注入。
- 将显式操作员控制表面（例如 `canvas.eval`、浏览器评估/脚本执行或直接 `node.invoke` 执行原语）视为漏洞而不展示 auth/policy/sandbox 边界绕过的报告。这些能力在启用时是有意的，是受信任操作员的功能，而不是独立的安全错误。
- 授权用户触发的本地操作被呈现为权限提升。例如：被允许列表/所有者发送者运行 `/export-session /absolute/path.html` 以在主机上写入。在这种信任模型中，授权用户操作是受信任的主机操作，除非您展示 auth/sandbox/边界绕过。
- 仅显示恶意插件在受信任操作员安装/启用后执行特权操作的报告。
- 假设在共享网关主机/配置上进行每用户多租户授权的报告。
- 仅显示来自非允许列表发送者的引用/回复/线程/转发的补充上下文对模型可见，而不展示 auth、policy、approval 或 sandbox 边界绕过的报告。
- 将 Gateway HTTP 兼容性端点（`POST /v1/chat/completions`、`POST /v1/responses`）视为实现了范围化操作员身份验证（`operator.write` vs `operator.admin`）的报告。这些端点验证共享的 Gateway bearer 秘密/密码，并且是记录的完整操作员访问表面，而不是每用户/每范围边界。
- 假设 `x-openclaw-scopes` 可以减少或重新定义 OpenAI 兼容 HTTP 端点上的共享秘密 bearer 身份验证的报告。对于共享秘密身份验证（`gateway.auth.mode="token"` 或 `"password"`），这些端点忽略较窄的 bearer 声明范围，并恢复完整的默认操作员范围集加上所有者语义。
- 将共享秘密 bearer 身份验证（`gateway.auth.mode="token"` 或 `"password"`）下的 `POST /tools/invoke` 视为较窄的每请求/每范围授权表面的报告。该端点被设计为相同的受信任操作员 HTTP 边界：共享秘密 bearer 身份验证在那里是完整的操作员访问，较窄的 `x-openclaw-scopes` 值不会减少该路径，并且仅所有者工具策略遵循共享秘密操作员合同。
- 仅显示启发式检测/奇偶性差异（例如一个执行路径上的混淆模式检测而不是另一个，例如 `node.invoke -> system.run` 奇偶性差距）而不展示 auth、approvals、allowlist 强制执行、sandboxing 或其他记录的信任边界绕过的报告。
- 仅显示 ACP 工具可以间接执行、变异、编排会话或到达另一个工具/运行时而不展示 ACP 提示/批准、allowlist 强制执行、sandboxing 或另一个记录的信任边界绕过的报告。ACP 静默批准故意限于狭窄的只读类；仅奇偶性间接命令发现是强化，不是漏洞。
- 需要受信任操作员配置输入（例如 `sessionFilter` 或 `logging.redactPatterns` 中的灾难性正则表达式）而没有信任边界绕过的 ReDoS/DoS 声明。
- 需要在受信任状态下预先存在的本地文件系统启动（例如在目标目录下种植符号链接/硬链接别名，如 skills/tools 路径）而不显示可以创建/控制该原语的不受信任路径的归档/安装提取声明。
- 依赖于在受信任主机上替换或重写已批准的可执行路径（同路径 inode/内容交换）而不显示执行该写入的不受信任路径的报告。
- 依赖于预先存在的符号链接技能/工作区文件系统状态（例如涉及 `skills/*/SKILL.md` 的符号链接链）而不显示可以创建/控制该状态的不受信任路径的报告。
- 默认本地/环回部署上缺少 HSTS 发现。
- 针对仅测试 harnesses、QA Lab、QE Lab、E2E  fixtures、基准测试 rigs 或维护者专用调试工具的报告，当易受攻击的代码未作为支持的生产表面发货时。
- 当 HTTP 模式已经使用签名秘密验证时的 Slack webhook 签名发现。
- 此存储库的 Discord 集成未使用的路径的 Discord 入站 webhook 签名发现。
- 声称 Microsoft Teams `fileConsent/invoke` `uploadInfo.uploadUrl` 是攻击者控制的，而不展示以下之一：auth 边界绕过、携带攻击者选择的 URL 的真实认证 Teams/Bot Framework 事件，或 Microsoft/Bot 信任路径的妥协。
- 针对过时/不存在路径的仅扫描器声明，或没有工作 repro 的声明。
- 针对后来发布的版本重述已经修复的问题而不显示该易受攻击路径在该后来版本的已发布标签或已发布工件中仍然存在的报告。

### 重复报告处理

- 在提交之前搜索现有的公告。
- 适用时在报告中包含可能的重复 GHSA ID。
- 维护者可能会关闭质量较低/较晚的重复项，以支持最早的高质量规范报告。

## 安全与信任

**Jamieson O'Reilly** ([@theonejvo](https://twitter.com/theonejvo)) 是 OpenClaw 的安全与信任负责人。Jamieson 是 [Dvuln](https://dvuln.com) 的创始人，在进攻性安全、渗透测试和安全计划开发方面拥有丰富经验。

## 漏洞赏金

OpenClaw 是一项爱的劳动。没有漏洞赏金计划，也没有用于付费报告的预算。请仍然负责任地披露，以便我们可以快速修复问题。
现在帮助项目的最佳方式是发送 PR。

## 维护者：通过 CLI 更新 GHSA

通过 `gh api` 修补 GHSA 时，包括 `X-GitHub-Api-Version: 2022-11-28`（或更新版本）。没有它，一些字段（特别是 CVSS）可能不会持久，即使请求返回 200。

## 操作员信任模型（重要）

OpenClaw **不** 将一个网关建模为多租户、对抗性用户边界。

- 经过身份验证的 Gateway 调用者被视为该网关实例的受信任操作员。
- 使用共享网关秘密（`token` / `password`）进行身份验证的直接 localhost/环回 Control UI 和 Gateway WebSocket 会话属于同一个受信任操作员桶。该路径上的本地自动配对设备会话预期保留完整的 localhost 操作员能力；它们不会创建单独的 `operator.write` vs `operator.admin` 安全边界。
- HTTP 兼容性端点（`POST /v1/chat/completions`、`POST /v1/responses`）和直接工具端点（`POST /tools/invoke`）属于同一个受信任操作员桶。在那里传递 Gateway bearer 身份验证等同于该网关的操作员访问；它们不实现较窄的 `operator.write` vs `operator.admin` 信任分离。
- 具体来说，在 OpenAI 兼容的 HTTP 表面上：
  - 共享秘密 bearer 身份验证（`token` / `password`）验证网关操作员秘密的拥有
  - 这些请求接收完整的默认操作员范围集（`operator.admin`、`operator.read`、`operator.write`、`operator.approvals`、`operator.pairing`）
  - 聊天回合端点（`/v1/chat/completions`、`/v1/responses`）也将这些共享秘密调用者视为所有者发送者，用于仅所有者工具策略
  - `POST /tools/invoke` 遵循相同的共享秘密规则，也将这些调用者视为所有者发送者，用于仅所有者工具策略
  - 较窄的 `x-openclaw-scopes` 头对于该共享秘密路径被忽略
  - 只有承载身份的 HTTP 模式（例如受信任的代理身份验证或私有入口上的 `gateway.auth.mode="none"`）才尊重声明的每请求操作员范围
- 会话标识符（`sessionKey`、会话 ID、标签）是路由控制，不是每用户授权边界。
- 如果一个操作员可以在同一个网关上查看另一个操作员的数据，这在这个信任模型中是预期的。
- OpenClaw 在技术上可以在一台机器上运行多个网关实例，但推荐的操作是按信任边界进行干净分离。
- 推荐模式：每台机器/主机（或 VPS）一个用户，该用户一个网关，该网关内一个或多个代理。
- 如果多个用户需要 OpenClaw，请为每个用户使用一个 VPS（或主机/OS 用户边界）。
- 对于高级设置，一台机器上可以有多个网关，但只有严格隔离，不是推荐的默认设置。
- Exec 行为默认以主机为先：`agents.defaults.sandbox.mode` 默认设置为 `off`。
- `tools.exec.host` 默认设置为 `auto`：当会话的 sandbox 运行时处于活动状态时进行 sandbox，否则为 gateway。
- 隐式 exec 调用（工具调用中没有明确的主机）遵循相同的行为。
- 这在 OpenClaw 的单用户受信任操作员模型中是预期的。如果您需要隔离，请启用 sandbox 模式（`non-main`/`all`）并保持严格的工具策略。

## 受信任插件概念（核心）

插件/扩展是 OpenClaw 网关可信计算基础的一部分。

- 安装或启用插件授予它与该网关主机上运行的本地代码相同的信任级别。
- 插件行为，如读取 env/文件或运行主机命令，在此信任边界内是预期的。
- 安全报告必须显示边界绕过（例如未经身份验证的插件加载、allowlist/policy 绕过或 sandbox/path-safety 绕过），而不仅仅是来自受信任安装的插件的恶意行为。

## 超出范围

- 公共互联网暴露
- 以文档建议不要的方式使用 OpenClaw
- 仅测试代码和维护者 harnesses，包括 QA Lab、QE Lab、E2E fixtures、基准测试 rigs、冒烟测试容器和本地调试代理，除非报告证明相同的易受攻击行为可从已发货的 OpenClaw 生产代码或为用户准备的已发布包工件中访问。
- 相互不信任/对抗性操作员共享一个网关主机和配置的部署（例如，期望 `sessions.list`、`sessions.preview`、`chat.history` 或类似控制平面读取的每操作员隔离的报告）
- 仅提示注入攻击（没有 policy/auth/sandbox 边界绕过）
- 需要对受信任本地状态（`~/.openclaw`、工作区文件如 `MEMORY.md` / `memory/*.md`）进行写访问的报告
- 可利用性取决于攻击者控制的受信任本地路径中预先存在的符号链接/硬链接文件系统状态（例如提取/安装目标树）的报告，除非显示创建该状态的单独不受信任边界绕过。
- 唯一声明是通过受信任本地技能/工作区符号链接状态（例如 `skills/*/SKILL.md` 符号链接链）进行 sandbox/工作区读取扩展的报告，除非显示创建/控制该状态的单独不受信任边界绕过。
- 唯一声明是通过同路径文件替换/重写在受信任主机上的批准后可执行身份漂移的报告，除非显示该主机写入原语的单独不受信任边界绕过。
- 唯一演示的影响是已经授权的发送者故意调用本地操作命令（例如 `/export-session` 写入绝对主机路径）而不绕过 auth、sandbox 或另一个记录的边界的报告
- 唯一声明是使用显式受信任操作员控制表面（例如 `canvas.eval`、浏览器评估/脚本执行或直接 `node.invoke` 执行）而不展示 auth、policy、allowlist、approval 或 sandbox 绕过的报告。
- 唯一声明是受信任安装/启用的插件可以使用网关/主机权限执行的报告（记录的信任模型行为）。
- 任何唯一声明是操作员启用的 `dangerous*`/`dangerously*` 配置选项削弱默认值的报告（这些是设计上的显式打破玻璃权衡）
- 依赖受信任操作员提供的配置值来触发可用性影响（例如自定义正则表达式模式）的报告。这些仍可能作为深度防御强化而修复，但不是安全边界绕过。
- 唯一声明是命令风险检测中的启发式/奇偶性漂移（例如混淆模式检查）在执行表面之间，没有展示的信任边界绕过的报告。这些是仅强化发现，不是漏洞；分类可能将它们关闭为 `invalid`/`no-action` 或作为低/信息性强化单独跟踪。
- 唯一声明是 ACP 暴露的工具可以间接执行命令、变异主机状态或到达另一个特权工具/运行时而不展示 ACP 提示/批准、allowlist 强制执行、sandboxing 或另一个记录的信任边界绕过的报告。这些是仅强化发现，不是漏洞。
- 唯一声明是 exec 批准没有语义建模每个解释器/运行时加载器形式、子命令、标志组合、包脚本或传递模块/配置导入的报告。Exec 批准绑定确切的请求上下文和尽力而为的直接本地文件操作数；它们不是运行时可能加载的所有内容的完整语义模型。
- 暴露的秘密是第三方/用户控制的凭证（不是 OpenClaw 拥有的，也不授予对 OpenClaw 运营的基础设施/服务的访问权限）而没有展示的 OpenClaw 影响
- 唯一声明是当 sandbox 运行时被禁用/不可用时的主机端 exec（受信任操作员模型中的记录默认行为），没有边界绕过的报告。
- 唯一声明是平台提供的上传目标 URL 不受信任（例如 Microsoft Teams `fileConsent/invoke` `uploadInfo.uploadUrl`）而不证明在认证生产流程中的攻击者控制的报告。

## 部署假设

OpenClaw 安全指南假设：

- 运行 OpenClaw 的主机在受信任的 OS/管理员边界内。
- 任何可以修改 `~/.openclaw` 状态/配置（包括 `openclaw.json`）的人实际上是受信任的操作员。
- 由相互不信任的人共享的单个 Gateway **不是推荐的设置**。按信任边界使用单独的网关（或至少单独的 OS 用户/主机）。
- 经过身份验证的 Gateway 调用者被视为受信任的操作员。会话标识符（例如 `sessionKey`）是路由控制，不是每用户授权边界。
- 多个网关实例可以在一台机器上运行，但推荐的模型是干净的每用户隔离（每个用户首选一个主机/VPS）。

## 单用户信任模型（个人助手）

OpenClaw 的安全模型是"个人助手"（一个受信任的操作员，可能有多个代理），而不是"共享多租户总线"。

- 如果多个人可以向同一个启用工具的代理发送消息（例如共享的 Slack 工作区），他们都可以在该代理的授予权限范围内引导该代理。
- 非所有者发送者状态仅影响仅所有者工具/命令。如果非所有者仍然可以访问同一代理上的非仅所有者工具（例如 `canvas`），这在授予的工具边界内，除非报告展示 auth、policy、allowlist、approval 或 sandbox 绕过。
- 会话或记忆范围减少上下文泄漏，但 **不** 创建每用户主机授权边界。
- 对于混合信任或对抗性用户，按 OS 用户/主机/网关隔离，并按边界使用单独的凭证。
- 公司共享代理可以是有效的设置，当用户在同一信任边界内并且代理严格限于业务用途时。
- 对于公司共享设置，使用专用机器/VM/容器和专用账户；避免在该运行时混合个人数据。
- 如果该主机/浏览器配置文件登录到个人账户（例如 Apple/Google/个人密码管理器），您已经折叠了边界并增加了个人数据暴露风险。

## 上下文可见性和允许列表

OpenClaw 区分：

- **触发授权**：谁可以触发代理（`dmPolicy`、`groupPolicy`、允许列表、提及门）
- **上下文可见性**：向模型提供什么补充上下文（回复正文、引用文本、线程历史、转发元数据）

在当前版本中，允许列表主要门控触发和所有者风格的命令访问。它们不保证跨每个频道/表面的通用补充上下文编辑。

当前频道行为并不完全一致：

- 一些频道已经按发送者允许列表过滤补充上下文的部分
- 其他频道仍然按接收的方式传递补充上下文

仅显示补充上下文可见性差异的报告通常是强化/一致性发现，除非它们也展示记录的边界绕过（auth、policy、approvals、sandbox 或等效）。

强化路线图可能会添加显式可见性模式（例如 `all`、`allowlist`、`allowlist_quote`），以便操作员可以选择更严格的上下文过滤，具有可预测的权衡。

## 代理和模型假设

- 模型/代理 **不是** 受信任的主体。假设提示/内容注入可以操纵行为。
- 安全边界来自主机/配置信任、auth、工具策略、sandboxing 和 exec 批准。
- 仅提示注入本身不是漏洞报告，除非它跨越这些边界之一。
- 钩子/webhook 驱动的有效载荷应被视为不受信任的内容；保持不安全的绕过标志禁用，除非进行严格范围的调试（`hooks.gmail.allowUnsafeExternalContent`、`hooks.mappings[].allowUnsafeExternalContent`）。
- 弱模型层通常更容易提示注入。对于启用工具或钩子驱动的代理，首选强大的现代模型层和严格的工具策略（例如 `tools.profile: "messaging"` 或更严格），并在可能的情况下加上 sandboxing。

## Gateway 和 Node 信任概念

OpenClaw 分离路由和执行，但两者都保持在同一操作员信任边界内：

- **Gateway** 是控制平面。如果调用者通过 Gateway 身份验证，他们被视为该 Gateway 的受信任操作员。
- **Node** 是 Gateway 的执行扩展。配对节点授予该节点上的操作员级远程能力。
- **Exec 批准**（允许列表/询问 UI）是操作员护栏，以减少意外命令执行，不是多租户授权边界。
- Exec 批准绑定确切的命令/cwd/env 上下文，当 OpenClaw 可以识别一个具体的本地脚本/文件操作数时，也绑定该文件快照。这是尽力而为的完整性强化，不是每个解释器/运行时加载器路径的完整语义模型。
- 执行表面（`gateway`、`node`、`sandbox`）之间的命令风险警告启发式差异本身不构成安全边界绕过。
- 对于不受信任的用户隔离，按信任边界拆分：每个边界使用单独的网关和单独的 OS 用户/主机。

## 工作区记忆信任边界

`MEMORY.md` 和 `memory/*.md` 是纯工作区文件，被视为受信任的本地操作员状态。

- 如果有人可以编辑工作区记忆文件，他们已经跨越了受信任的操作员边界。
- 对这些文件的记忆搜索索引/召回是预期行为，不是 sandbox/安全边界。
- 被视为超出范围的示例报告模式："攻击者将恶意内容写入 `memory/*.md`，然后 `memory_search` 返回它。"
- 如果您需要相互不信任的用户之间的隔离，请按 OS 用户或主机拆分并运行单独的网关。

## 插件信任边界

插件/扩展 **在进程内** 加载到 Gateway 中，被视为受信任的代码。

- 插件可以使用与 OpenClaw 进程相同的 OS 权限执行。
- 运行时助手（例如 `runtime.system.runCommandWithTimeout`）是便利 API，不是 sandbox 边界。
- 仅安装您信任的插件，并且首选 `plugins.allow` 来固定明确受信任的插件 ID。

## 临时文件夹边界（媒体/Sandbox）

OpenClaw 使用专用的临时根目录用于本地媒体交接和 sandbox 相邻的临时工件：

- 首选临时根目录：`/tmp/openclaw`（当在主机上可用且安全时）。
- 回退临时根目录：`os.tmpdir()/openclaw`（或多用户主机上的 `openclaw-<uid>`）。

安全边界说明：

- Sandbox 媒体验证仅允许 OpenClaw 管理的临时根目录下的绝对临时路径。
- 任意主机 tmp 路径不被视为受信任的媒体根目录。
- 插件/扩展代码应使用 OpenClaw 临时助手（`resolvePreferredOpenClawTmpDir`、`buildRandomTempFilePath`、`withTempDownloadPath`）而不是原始的 `os.tmpdir()` 默认值，当处理媒体文件时。
- 执行参考点：
  - 临时根解析器：`src/infra/tmp-openclaw-dir.ts`
  - SDK 临时助手：`src/plugin-sdk/temp-path.ts`
  - 消息传递/频道 tmp 护栏：`scripts/check-no-random-messaging-tmp.mjs`

## 操作指南

有关威胁模型 + 强化指南（包括 `openclaw security audit --deep` 和 `--fix`），请参阅：

- `https://docs.openclaw.ai/gateway/security`

### 工具文件系统强化

- `tools.exec.applyPatch.workspaceOnly: true`（推荐）：将 `apply_patch` 写入/删除保持在配置的工作区目录内。
- `tools.fs.workspaceOnly: true`（可选）：将 `read`/`write`/`edit`/`apply_patch` 路径和原生提示图像自动加载路径限制到工作区目录。
- 避免设置 `tools.exec.applyPatch.workspaceOnly: false`，除非您完全信任谁可以触发工具执行。

### 子代理委派强化

- 保持 `sessions_spawn` 被拒绝，除非您明确需要委派运行。
- 保持 `agents.list[].subagents.allowAgents` 狭窄，并且只包括您信任其 sandbox 设置的代理。
- 当委派必须保持 sandboxed 时，使用 `sandbox: "require"` 调用 `sessions_spawn`（默认为 `inherit`）。
  - `sandbox: "require"` 拒绝生成，除非目标子运行时被 sandboxed。
  - 这防止较少限制的会话错误地将工作委派到未 sandboxed 的子进程。

### Web 界面安全

OpenClaw 的 web 界面（Gateway Control UI + HTTP 端点）仅供 **本地使用**。

- 推荐：保持 Gateway **仅环回**（`127.0.0.1` / `::1`）。
  - 配置：`gateway.bind="loopback"`（默认）。
  - CLI：`openclaw gateway run --bind loopback`。
- `gateway.controlUi.dangerouslyDisableDeviceAuth` 仅用于 localhost 打破玻璃使用。
  - OpenClaw 按设计保持部署灵活性，不硬禁止非本地设置。
  - 非本地和其他风险配置由 `openclaw security audit` 作为危险发现浮出水面。
  - 这种操作员选择的权衡是设计的，本身不是安全漏洞。
- Canvas 主机注意：网络可见的 canvas 对于受信任节点场景（LAN/tailnet）是 **有意的**。
  - 预期设置：非环回绑定 + Gateway 身份验证（token/password/受信任代理）+ 防火墙/tailnet 控制。
  - 预期路由：`/__openclaw__/canvas/`、`/__openclaw__/a2ui/`。
  - 这种部署模型本身不是安全漏洞。
- **不要** 将其暴露给公共互联网（不要直接绑定到 `0.0.0.0`，不要使用公共反向代理）。它没有为公共暴露进行强化。
- 如果您需要远程访问，首选 SSH 隧道或 Tailscale serve/funnel（这样 Gateway 仍然绑定到环回），加上强大的 Gateway 身份验证。
- Gateway HTTP 表面包括 canvas 主机（`/__openclaw__/canvas/`、`/__openclaw__/a2ui/`）。将 canvas 内容视为敏感/不受信任，避免将其暴露到环回之外，除非您理解风险。

## 运行时要求

### Node.js 版本

OpenClaw 需要 **Node.js 22.12.0 或更高版本**（LTS）。此版本包含重要的安全补丁：

- CVE-2025-59466：async_hooks DoS 漏洞
- CVE-2026-21636：权限模型绕过漏洞

验证您的 Node.js 版本：

```bash
node --version  # 应该是 v22.12.0 或更高版本
```

### Docker 安全

在 Docker 中运行 OpenClaw 时：

1. 官方镜像以非 root 用户（`node`）运行，以减少攻击面
2. 尽可能使用 `--read-only` 标志以获得额外的文件系统保护
3. 使用 `--cap-drop=ALL` 限制容器能力

安全 Docker 运行示例：

```bash
docker run --read-only --cap-drop=ALL \
  -v openclaw-data:/app/data \
  openclaw/openclaw:latest
```

## 安全扫描

该项目使用 `detect-secrets` 进行 CI/CD 中的自动秘密检测。
有关配置，请参阅 `.detect-secrets.cfg`，有关基线，请参阅 `.secrets.baseline`。

本地运行：

```bash
pip install detect-secrets==1.5.0
detect-secrets scan --baseline .secrets.baseline
```