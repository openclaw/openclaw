# 变更日志

文档：https://docs.openclaw.ai

## 未发布

### 变更

### 修复

- Control UI/cron：当创建或编辑作业时，保持运行时专用的 `last` 交付标记不会被实化为持久化的 cron 交付和失败警报通道配置。 (#68829) 感谢 @tianhaocui。
- OpenAI/响应：在出站响应 API 调用之前剥离孤立的推理块，以便压缩或恢复的历史记录不再因独立的推理项而失败。 (#55787) 感谢 @suboss87。

## 2026.4.19-beta.2

### 修复

- Agents/openai-completions：在流式请求上始终发送 `stream_options.include_usage`，以便本地和自定义 OpenAI 兼容后端报告真实的上下文使用情况，而不是显示 0%。 (#68746) 感谢 @kagura-agent。
- Agents/嵌套通道：为每个目标会话划分嵌套代理工作，以便一个会话上的长时间运行的嵌套运行不再跨网关阻塞无关会话的头线。 (#67785) 感谢 @stainlu。
- Agents/状态：为省略使用元数据的提供商保留结转的会话令牌总数，以便 `/status` 和 `openclaw sessions` 在提供商省略使用元数据时保持显示最后已知的上下文使用情况，而不是回退到未知/0%。 (#67695) 感谢 @stainlu。
- 安装/更新：保持旧版更新验证与 QA Lab 运行时 shim 兼容，以便在 npm 成功安装包后，将较旧的全局安装更新到 beta 版本不再失败。

## 2026.4.19-beta.1

### 修复

- Agents/通道：通过目标代理的绑定通道账户路由跨代理子代理生成，同时保留对等和工作区/角色范围的绑定，以便子会话不再在共享房间、工作区或多账户设置中继承调用者的账户。 (#67508) 感谢 @lukeboyett 和 @gumadeiras。
- Telegram/回调：将永久性回调编辑错误视为已完成的更新，以便过时的命令分页按钮不再阻塞更新水印并阻止较新的 Telegram 更新。 (#68588) 感谢 @Lucenx9。
- Browser/CDP：允许为 CDP 健康和控制检查选择的远程 CDP 配置文件主机，而不扩大浏览器导航 SSRF 策略，以便 WSL 到 Windows Chrome 端点在严格默认值下不再显示为离线。修复 #68108。 (#68207) 感谢 @Mlightsnow。
- Codex：停止将累积的应用服务器令牌总数视为新的上下文使用，以便会话状态在长 Codex 线程后不再报告膨胀的上下文百分比。 (#64669) 感谢 @cyrusaf。
- Browser/CDP：添加阶段特定的 CDP 就绪诊断并标准化环回 WebSocket 主机别名，以便 Windows 浏览器启动失败显示 HTTP 发现、WebSocket 发现、SSRF 验证或 `Browser.getVersion` 健康检查是否失败。

## 2026.4.18

### 变更

- Anthropic/模型：添加 Claude Opus 4.7 `xhigh` 推理努力支持，并将其与自适应思考分开。
- Control UI/设置：通过更快的预设、快速创建流程和刷新的命令发现，彻底改革设置和斜杠命令体验。 (#67819) 感谢 @BunsDev。
- macOS/网关：为 macOS 应用节点添加 `screen.snapshot` 支持，包括运行时管道、默认 macOS 允许列表和监视器预览流程的文档。 (#67954) 感谢 @BunsDev。

### 修复

- Codex/网关：修复当 codex-acp 子进程突然终止时的网关崩溃；待处理请求现在优雅地关闭，而不是通过网关守护进程和连接的通道传播未捕获的 EPIPE。修复 #67886。 (#67947) 感谢 @openperf。
- Agents/引导：从工作区真相而不是过时的会话记录标记解析引导，在隐藏的用户上下文前奏上保持嵌入的引导指令，在 `BOOTSTRAP.md` 仍待处理时抑制正常的 `/new` 和 `/reset` 问候语，并使嵌入的运行器在正常回复之前读取引导仪式。
- Agents/引导： deduplicate 重复的引导截断警告，使启动日志保持可操作。 (#67906) 感谢 @rubencu。
- WhatsApp/多账户：集中命名账户入站策略，隔离每个账户的组激活和范围会话密钥，保留遗留激活回填，并保持 `accounts.default` 共享默认值在运行时、设置和兼容迁移路径之间保持一致。感谢 @mcaxtr。
- Cron/交付：当 `deleteAfterRun` 启用时，在直接交付后清理隔离的会话，覆盖之前绕过清理的结构化和线程分支。 (#67807) 感谢 @MonkeyLeeT。
- Gateway/hello-ok：在成功的共享身份验证握手时始终报告协商的身份验证元数据并保留重用设备令牌的范围，包括在不颁发设备令牌时的 control-ui 旁路覆盖。 (#67810, #68039) 感谢 @BunsDev。
- 入职/非交互式：在重新入职期间保留现有的网关身份验证令牌，以便活动的本地网关客户端不会因隐式令牌轮换而断开连接。 (#67821) 感谢 @BKF-Gitty。
- OpenAI Codex/响应：统一原生响应 API 能力检测，以便 Codex OAuth 请求在原生响应路径上发出所需的 `store: false` 字段。 (#67918) 感谢 @obviyus。
- WhatsApp/设置：保护个人电话和允许列表提示值，以便设置在未定义提示文本时因清晰的验证错误而失败，而不是崩溃。 (#67895) 感谢 @lawrence3699。
- Models/配置：在合并模式再生期间保留现有的 `models.json` 提供商 `baseUrl`，以便自定义端点在重启时不会被重置。 (#67893) 感谢 @lawrence3699。
- 插件 SDK：在发布的构建中保留 `secret-input-runtime` 函数导出，以便提供商插件可以读取 SecretRef 支持的设置输入。
- 插件/发现：在工作区缓存未命中时重用捆绑和全局插件发现结果，以便 Windows 多工作区启动停止在共享同步扫描时重做。 (#67940) 感谢 @obviyus。
- 捆绑插件/安装：保持分阶段的捆绑插件运行时导入通过打包的插件 SDK 解析，同时从 dist 清单中省略仅检出别名，以便发布的安装不会在 repo 本地路径上失败。
- 插件/webhooks：通过完整回滚失败的插件副作用来强制同步插件注册，并按路由缓存 SecretRef 支持的 webhook 身份验证，以便插件启动和入站 webhook 身份验证保持确定性。 (#67941) 感谢 @obviyus。
- Telegram/ACP 绑定：在重启时删除仍然指向缺失或失败的 ACP 会话的持久 DM 绑定，同时保留插件拥有的绑定和不确定的存储读取。 (#67822) 感谢 @chinar-amrutkar。
- Telegram/流式：当自动压缩重试进行中的答案时，在同一 Telegram 消息上保持临时预览，以便流式回复在压缩后不再显示为重复。 (#66939) 感谢 @rubencu。
- Memory/sqlite-vec：在每个降级情节中发出降级的 sqlite-vec 警告一次，而不是在每次文件写入时重复，同时在安全重新索引回滚期间保留锁，并在矢量状态真正重建时重置它。 (#67898) 感谢 @rubencu。
- Memory-core：在只读恢复期间保留存储的矢量维度，以便内存索引在修复只读状态时不会丢失矢量元数据。
- Reply/块流式：在块流式已经发出内容后保留流后不完整回合错误有效负载，以便用户获得警告而不是沉默。 (#67991) 感谢 @obviyus。
- Telegram/流式：在可见的非最终边界后清除压缩重放保护，以便工具后的助手回复旋转到新的预览，而不是编辑压缩前的消息。 (#67993) 感谢 @obviyus。
- Matrix：修复 `sessions_spawn --thread` 子代理会话生成 — 线程绑定创建、会话结束时的清理以及完成消息传递目标解析现在端到端工作。 (#67643) 感谢 @eejohnso-ops 和 @gumadeiras。
- Slack/流式：当可用时，从入站用户解析原生流式接收者团队，带有监视器团队回退，以便 DM 和共享工作区流更可靠地瞄准正确的接收者。
- macOS/webchat：通过开启原生 `NSTextView` 撤销管理器，在编辑器文本输入中启用撤销和重做。 (#34962) 感谢 @tylerbittner。
- macOS/远程 SSH：通过将 `StrictHostKeyChecking=accept-new` 切换到 `StrictHostKeyChecking=yes` 并在 `CommandResolver` 中集中共享的 SSH 选项片段，要求 macOS 远程命令、网关探测、端口隧道和配对探测路径上已经受信任的主机密钥，以便首次 macOS 远程连接不再静默接受未知主机密钥，必须提前通过 `~/.ssh/known_hosts` 信任。 (#68199)
- CLI/configure：在探测状态之前显示通道选择器，并让删除模式直接从配置中删除配置的通道块。 (#68007) 感谢 @gumadeiras。
- Control UI/设置：切换设置页面时重置滚动位置并对齐详细信息标题。 (#68150) 感谢 @BunsDev。
- OpenAI Codex/OAuth：将 OpenClaw 保持为导入的 Codex CLI OAuth 会话的规范所有者，停止将刷新的凭证写回 `.codex`，并优先使用更新的 OpenClaw 凭证而不是过时的导入 CLI 状态，以便刷新恢复保持稳定。感谢 @vincentkoc。
- OpenAI Codex/OAuth：将 OpenAI TLS 先决条件探测视为建议性的，而不是硬性阻止，以便当推测性的 Node/OpenSSL 预检查失败但实际 OAuth 流程仍然工作时，Codex 登录仍然可以进行。感谢 @vincentkoc。
- 模型状态/OAuth 健康：将 OAuth 健康报告与运行时使用的相同有效凭证视图对齐，以便过期的可刷新会话停止默认显示为健康，并且更新的导入 Codex CLI 凭证在 `models status`、doctor 和网关身份验证状态中正确显示。感谢 @vincentkoc。
- OpenAI Codex/OAuth：通过覆盖更新的 Codex CLI 凭证而不改变 `auth-profiles.json`，保持外部 CLI OAuth 导入运行时专用，以便 `.codex` 保持作为引导/运行时输入，而不是成为持久的 OpenClaw 状态。感谢 @vincentkoc。
- OpenAI Codex/OAuth：从剩余的引导路径中删除遗留的 CLI 管理器路由，以便 Codex 和 MiniMax CLI 导入通过其规范的 OpenClaw 配置文件 ID 而不是过时的 `managedBy` 元数据进行匹配。感谢 @vincentkoc。
- OpenAI Codex/OAuth：仅当本地 OpenClaw 配置文件缺失或不可用时才从外部 CLI OAuth 引导，以便健康的本地会话不再被更新的 `.codex` 令牌覆盖。感谢 @vincentkoc。
- OpenAI Codex/OAuth：重命名外部 CLI 引导助手，在运行时回退路径中重用相同的可用 OAuth 检查，并添加调试日志和健康覆盖，以便引导决策保持清晰。感谢 @vincentkoc。
- Twitch/设置：通过捆绑的设置入口发现路径加载 Twitch，并保持设置/状态账户检测与运行时配置对齐。 (#68008) 感谢 @gumadeiras。
- Feishu/卡片操作：当存储的上下文缺失时，从 Feishu 聊天 API 解析卡片操作聊天类型，优先使用 `chat_mode` 而不是 `chat_type`，以便 DM 发起的卡片操作不再通过回退到组处理路径而绕过 `dmPolicy`。 (#68201)
- Cron/隔离代理：在镜像到主会话的隔离 cron 感知事件上保留 `trusted: false`，并通过网关 cron 包装器转发可选的 `trusted` 标志，以便显式信任降级在会话密钥范围内存活。 (#68210)
- Agents/回退：识别裸前导 ZenMux `402 ...` 配额刷新错误，而不将纯数字 `402 ...` 文本错误分类，保持嵌入式回退回归覆盖稳定。 (#47579) 感谢 @bwjoke。
- 故障转移/google：仅当 `INTERNAL` 状态有效负载也携带 `500` 代码时，才将其视为可重试的超时，以便格式错误的非 500 有效负载不会进入重试路径。 (#68238) 感谢 @altaywtf 和 @Openbling。
- Agents/工具：在将捆绑的 MCP/LSP 工具合并到有效工具列表后，通过最终的仅所有者和工具策略管道过滤它们，以便现有的允许列表、拒绝规则、沙箱策略、子代理策略和仅所有者限制对捆绑工具的应用方式与对核心工具的应用方式相同。 (#68195)
- Gateway/助手媒体：要求 `operator.read` 范围用于助手媒体文件和身份承载 HTTP 身份验证路径上的元数据请求，以便没有读取范围的调用者不再可以访问助手媒体。 (#68175) 感谢 @eleqtrizit。
- Gateway/web：在 Permissions-Policy 头中允许同源麦克风访问，以便浏览器语音捕获可以从 Control UI 和 webchat 源工作。 (#68368)
- Exec 批准/显示：在共享和 macOS 批准提示命令清理器中转义原始控制字符（包括换行和回车），以便尾随命令有效负载不再在批准 UI 中的隐藏额外行上渲染。 (#68198)
- Telegram/流式：在中止后围栏同会话过时预览和最终化工作，以便 Telegram 不再在中止确认着陆后重放旧回复或刷新隐藏的短预览。 (#68100) 感谢 @rubencu。
- OpenAI Codex/OAuth + Pi：保持导入的 Codex CLI OAuth 引导、Pi 身份验证导出和运行时覆盖处理对齐，以便 Codex 会话在刷新和健康检查中存活，而不会将临时 CLI 状态泄漏到保存的身份验证文件中。感谢 @vincentkoc。
- OpenAI Codex/OAuth：将 Codex 特定的身份验证桥接保持在拥有的插件内部，保留规范的导入 CLI 配置文件，并允许遗留的无身份主存储 OAuth 会话在刷新镜像期间升级。 (#68284) 感谢 @vincentkoc。
- 配置/编辑：将 `browser.cdpUrl` 和 `browser.profiles.*.cdpUrl` 添加到敏感 URL 配置路径，以便嵌入式凭证（查询令牌和 HTTP 基本身份验证）在 `config.get` API 响应和可用性错误消息中正确编辑。 (#67679) 感谢 @Ziy1-Tan。
- Agents/TTS：将失败的语音合成报告为真实的工具错误，以便未配置的提供商不再将成功的 TTS 失败输出反馈回代理循环。 (#67980) 感谢 @lawrence3699。
- Gateway/唤醒：允许唤醒有效负载上的未知属性，以便像 Paperclip 这样的外部发送者可以附加不透明的元数据，而不会失败模式验证。 (#68355) 感谢 @kagura-agent。
- Matrix：在为私有网络 homeserver 创建客户端时，遵守 `channels.matrix.network.dangerouslyAllowPrivateNetwork`。 (#68332) 感谢 @kagura-agent。
- Cron/消息工具：将具有 `delivery.mode: "none"` 的 cron 拥有的运行保持在正常的消息工具路径上，以便它们仍然可以发送显式消息、创建线程和在没有运行器拥有的交付目标活跃时有条件地路由。 (#68482) 感谢 @obviyus。
- Agents/故障转移：避免将裸前导 `402 ...` 散文视为计费错误，同时仍然识别代理订阅失败。 (#45827) 感谢 @junyuc25。
- 配置/$schema：在部分配置重写期间保留根编写的 `$schema`，而不将仅包含的模式 URL 注入到根配置中。 (#47322) 感谢 @EfeDurmaz16。
- Agents/CLI 交付：在发送 `openclaw agent --deliver` 有效负载之前，运行自动回复流程使用的相同回复媒体路径规范化器，以便相对 `MEDIA:./out/photo.png` 令牌解析相对于代理工作区，而不是在下游被 `LocalMediaAccessError: Local media path is not under an allowed directory` 拒绝。感谢 @frankekn。
- Agents/Google：为嵌入式运行器和原生 Google 有效负载中的思考要求 `gemini-2.5-pro` 模型剥离 `thinkingBudget=0`，以便请求不再因 `Budget 0 is invalid. This model only works in thinking mode.` 而失败，并且 API 使用其默认思考行为。 (#68607) 感谢 @josmithiii。
- Slack/线程：以详细级别记录失败的线程启动器和历史获取，同时保留尽力而为的回退行为，以便缺少 Slack 线程上下文在不中断入站处理的情况下可诊断。 (#68594) 感谢 @martingarramon。
- Gateway/重启：保持过时网关清理不会终止当前进程的父级或祖先，以便像微信这样的插件侧车不再杀死活动网关并触发无限的监督器重启循环。修复 #68451。 (#68517) 感谢 @openperf。
- Gateway/身份验证：在启动和秘密重新加载时拒绝与已发布示例占位符匹配的网关身份验证凭证，并保持云安装片段不会发布复制粘贴的网关/密钥环秘密。 (#68404) 感谢 @coygeek。
- CLI/更新：在更新重启日志中保留 macOS 重启助手 launchctl 失败，而不让日志设置阻塞重启路径。 (#68492) 感谢 @hclsys。
- Slack/线程：将仅文件的根消息保持为启动上下文，以便第一个线程回复仍然可以水合启动媒体。 (#68594) 感谢 @martingarramon。
- Google/Antigravity：从捆绑的 Google 插件模板解析前向兼容的 Gemini 3.1 Pro 自定义工具和 Flash 变体，以便 `google-antigravity/gemini-3.1-pro-preview-customtools` 不再回退到未知模型错误。修复 #35512。
- Active Memory：将阻塞召回超时上限提高到 120 秒，并在插件模式验证期间拒绝较大的配置值。修复 #68410。 (#68480) 感谢 @Bartok9。
- Control UI/聊天：在聊天重新加载后保持历史支持的用户图像上传可见，同时过滤阻塞或非图像记录媒体路径。 (#68415) 感谢 @mraleko。

## 2026.4.15

### 变更

- Anthropic/模型：默认 Anthropic 选择、`opus` 别名、Claude CLI 默认值和捆绑的图像理解到 Claude Opus 4.7。
- Google/TTS：为捆绑的 `google` 插件添加 Gemini 文本到语音支持，包括提供商注册、语音选择、WAV 回复输出、PCM 电话输出和设置/文档指南。 (#67515) 感谢 @barronlroth。
- Control UI/概述：添加一个模型身份验证状态卡，一目了然地显示 OAuth 令牌健康和提供商速率限制压力，当 OAuth 令牌过期或即将过期时带有注意标注。由一个新的 `models.authStatus` 网关方法支持，该方法剥离凭证并缓存 60 秒。 (#66211) 感谢 @omarshahine。
- Memory/LanceDB：为 `memory-lancedb` 添加云存储支持，以便持久内存索引可以在远程对象存储上运行，而不仅仅是本地磁盘。 (#63502) 感谢 @rugvedS07。
- GitHub Copilot/内存搜索：为内存搜索添加 GitHub Copilot 嵌入提供商，并公开专用的 Copilot 嵌入主机助手，以便插件可以在遵守远程覆盖、令牌刷新和更安全的有效负载验证的同时重用传输。 (#61718) 感谢 @feiskyer 和 @vincentkoc。
- Agents/本地模型：添加实验性 `agents.defaults.experimental.localModelLean: true` 以删除重量级默认工具，如 `browser`、`cron` 和 `message`，为较弱的本地模型设置减少提示大小，而不改变正常路径。 (#66495) 感谢 @ImLukeF。
- 打包/插件：将捆绑的插件运行时依赖项本地化到其拥有的扩展，修剪已发布的文档有效负载，并收紧安装/包管理器护栏，以便已发布的构建保持更精简，核心不再携带扩展拥有的运行时包袱。 (#67099) 感谢 @vincentkoc。
- QA/Matrix：将 Matrix 实时 QA 拆分为源链接的 `qa-matrix` 运行器，并将仓库私有的 `qa-*` 表面保持在打包和发布的构建之外。 (#66723) 感谢 @gumadeiras。
- 文档/展示：为社区示例添加可扫描的英雄、完整的部分跳转链接和响应式视频网格。 (#48493) 感谢 @jchopard69。

### 修复

- Gateway/工具：将受信任的本地 `MEDIA:` 工具结果传递锚定在此运行的已注册内置工具的确切原始名称上，并拒绝名称在同一请求中与内置工具或另一个客户端工具规范化冲突的客户端工具定义（JSON 和 SSE 路径上的 `400 invalid_request_error`），以便名为内置工具的客户端提供工具不能再继承其本地媒体信任。 (#67303)
- Agents/重放恢复：将提供商措辞 `401 input item ID does not belong to this connection` 分类为重放无效，以便用户获得现有的 `/new` 会话重置指导，而不是原始的 401 风格失败。 (#66475) 感谢 @dallylee。
- Gateway/webchat：在 webchat 音频嵌入路径上强制执行 localRoots 包含 [AI 辅助]。 (#67298) 感谢 @pgondhi987。
- Matrix/配对：阻止 DM 配对存储条目授权房间控制命令 [AI 辅助]。 (#67294) 感谢 @pgondhi987。
- Docker/构建：使用 `node_modules` 下的 `find` 验证 `@matrix-org/matrix-sdk-crypto-nodejs` 原生绑定，而不是硬编码的 `.pnpm/...` 路径，以便 pnpm v10+ 虚拟存储布局不再使镜像构建失败。 (#67143) 感谢 @ly85206559。
- Matrix/E2EE：为无密码令牌身份验证机器人保持启动引导保守，仍然尝试有保护的修复通过，而不需要 `channels.matrix.password`，并记录剩余的密码-UIA 限制。 (#66228) 感谢 @SARAMALI15792。
- Cron/公告交付：抑制以 `NO_REPLY` 结尾的混合内容隔离 cron 公告回复，以便尾随的静默标记不再泄漏摘要文本到目标通道。 (#65004) 感谢 @neo1027144-creator。
- 插件/捆绑通道：按活动捆绑根分区捆绑通道惰性缓存，以便 `OPENCLAW_BUNDLED_PLUGINS_DIR` 翻转停止重用过时的插件、设置、秘密和运行时状态。 (#67200) 感谢 @gumadeiras。
- 打包/插件：从捆绑的插件运行时依赖项中修剪常见的测试/规范货物，并在打包的测试货物重新出现时失败 npm 发布验证，保持发布的 tarball 更精简，没有插件特定的特殊情况。 (#67275) 感谢 @gumadeiras。
- Agents/上下文 + 内存：修剪默认启动/技能提示预算，默认通过显式继续元数据限制 `memory_get` 摘录，并保持 QMD 读取与相同的有界摘录合同对齐，以便长会话默认拉取更少的上下文，而不会失去确定性的后续读取。
- Matrix/命令：在房间流量上跳过 DM 配对存储读取，现在房间控制命令授权忽略配对存储条目，保持房间路径更窄，而不改变房间身份验证行为。 (#67325) 感谢 @gumadeiras。
- Memory-core/做梦：在引导记录着陆之前，从会话存储元数据中跳过做梦叙事记录，以便梦境日记提示/散文行不会污染会话摄取。 (#67315) 感谢 @jalehman。
- Agents/本地模型：为自托管模型澄清低上下文预检提示，将配置支持的上限指向相关的 OpenClaw 设置，并在 `agents.defaults.contextTokens` 是实际限制时停止建议更大的模型。 (#66236) 感谢 @ImLukeF。
- 做梦/memory-core：将默认 `dreaming.storage.mode` 从 `inline` 更改为 `separate`，以便做梦阶段块（`## Light Sleep`、`## REM Sleep`）落在 `memory/dreaming/{phase}/YYYY-MM-DD.md` 中，而不是注入到 `memory/YYYY-MM-DD.md` 中。每日内存文件不再被结构化候选输出主导，并且已经剥离梦想标记块的每日摄取扫描器不再需要在每次运行时与数百个阶段块行竞争。希望以前行为的操作员可以通过设置 `plugins.entries.memory-core.config.dreaming.storage.mode: "inline"` 来选择加入。 (#66412) 感谢 @mjamiv。
- Control UI/概述：修复模型身份验证状态卡上针对别名提供商、带有 auth.profiles 的环境支持的 OAuth 和不可解析的环境 SecretRef 的误报"缺失"警报。 (#67253) 感谢 @omarshahine。
- 仪表板：在桌面上约束 exec 批准模态溢出，以便长命令内容不再将操作按钮推出视图。 (#67082) 感谢 @Ziy1-Tan。
- Agents/CLI 记录：将成功的 CLI 支持的回合持久化到 OpenClaw 会话记录中，以便 google-gemini-cli 回复再次出现在会话历史和 Control UI 中。 (#67490) 感谢 @obviyus。
- Discord/工具调用文本：从可见的助手文本中剥离独立的 Gemma 风格 `<function>...</function>` 工具调用有效负载，而不截断散文示例或尾随回复。 (#67318) 感谢 @joelnishanth。
- WhatsApp/web-session：在重新打开套接字之前排空每个身份验证凭证保存队列，以便重连时身份验证引导不再与进行中的 `creds.json` 写入竞争并错误地从备份恢复。 (#67464) 感谢 @neeravmakwana。
- BlueBubbles/追赶：添加每条消息重试上限（`catchup.maxFailureRetries`，默认 10），以便带有格式错误有效负载的持续失败消息不再永远阻塞追赶光标。在对同一 GUID 连续 N 次 `processMessage` 失败后，追赶记录警告，在后续扫描中跳过该消息，并让光标前进超过它。瞬态失败仍然从同一点重试。还修复了持久去重文件锁中静默丢失入站 GUID 的丢失更新竞争、版本升级时的去重文件命名迁移差距，以及让追赶重放去抖动器合并的事件作为独立消息的气球事件旁路。 (#67426, #66870) 感谢 @omarshahine。
- Ollama/聊天：从 Ollama 聊天请求模型 ID 中剥离 `ollama/` 提供商前缀，以便像 `ollama/qwen3:14b-q8_0` 这样的配置引用不会在 Ollama API 上 404。 (#67457) 感谢 @suboss87。
- Agents/工具：将非工作区主机波浪号路径解析为 OS 主目录，并保持编辑恢复与该相同路径目标对齐，以便 `~/...` 主机编辑/写入操作在 `OPENCLAW_HOME` 不同时停止失败或读回错误文件。 (#62804) 感谢 @stainlu。
- Speech/TTS：自动启用捆绑的 Microsoft 和 ElevenLabs 语音提供商，并通过显式或活动提供商首先路由通用 TTS 指令令牌，以便像 `[[tts:speed=1.2]]` 这样的覆盖不再静默地落在错误的提供商上。 (#62846) 感谢 @stainlu。
- OpenAI Codex/模型：在运行时解析和发现/列出中规范化过时的原生传输元数据，以便带有缺失 `api` 或 `https://chatgpt.com/backend-api/v1` 的遗留 `openai-codex` 行自愈到规范的 Codex 传输，而不是通过损坏的 HTML/Cloudflare 路径路由请求，结合了 #66969 (saamuelng601-pixel) 和 #67159 (hclsys) 中提出的原始修复。 (#67635)
- Agents/故障转移：将 HTML 提供商错误页面视为 CDN 风格 5xx 响应的上游传输失败，而不将嵌入的正文文本错误分类为 API 速率限制，同时仍然保留 HTML 401/403 页面的身份验证补救和 HTML 407 页面的代理补救。 (#67642) 感谢 @stainlu。
- Gateway/技能：每当配置写入触及 `skills.*` 时（例如 `skills.allowBundled`、`skills.entries.<id>.enabled` 或 `skills.profile`），增加缓存的技能快照版本。现有的代理会话在 `sessions.json` 中保留 `skillsSnapshot`，该快照重用会话创建时冻结的技能列表；没有此失效，从允许列表中删除捆绑技能会使旧快照保持活跃，模型继续调用禁用的工具，产生 `Tool <name> not found` 循环，直到嵌入式运行超时。 (#67401) 感谢 @xantorres。
- Agents/工具循环：默认启用未知工具流保护。以前 `resolveUnknownToolGuardThreshold` 仅在 `tools.loopDetection.enabled` 显式设置为 `true` 时返回 `undefined`，这在默认配置中关闭了保护。一个幻觉或删除的工具（例如从 `skills.allowBundled` 中删除的 `himalaya`）会循环 "Tool X not found" 尝试，直到完整的嵌入式运行超时。保护没有误报表面，因为它只在运行中客观上未注册的工具上触发，所以现在它保持开启，无论 `tools.loopDetection.enabled` 如何，并且仍然接受 `tools.loopDetection.unknownToolThreshold` 作为每运行覆盖（默认 10）。 (#67401) 感谢 @xantorres。
- TUI/流式：在 `tui-event-handlers` 中添加客户端流式监视狗，以便 `streaming · Xm Ys` 活动指示器在活动运行上 30 秒的增量沉默后重置为 `idle`。防止丢失或延迟的 `state: "final"` 聊天事件（WS 重新连接、网关重启等）使 TUI 无限期卡在 `streaming` 上；新的系统日志行显示重置，以便用户知道发送新消息以重新同步。窗口可通过新的 `streamingWatchdogMs` 上下文选项配置（设置为 `0` 禁用），并且处理程序现在公开 `dispose()` 以在关闭时清除待处理的计时器。 (#67401) 感谢 @xantorres。
- 扩展/lmstudio：为推理预加载包装器添加指数退避，以便 LM Studio 模型加载失败（例如内置内存护栏因交换饱和而拒绝加载）不再为每个聊天请求每 ~2s 产生一条 WARN 行。包装器现在按 `(baseUrl, modelKey, contextLength)` 元组记录连续预加载失败，带有 5s → 10s → 20s → … → 5min 冷却，并在冷却活跃时完全跳过预加载步骤，让聊天请求直接进入流（模型通常已经通过 LM Studio UI 加载）。组合的 `preload failed` 日志行现在报告连续失败计数和剩余冷却，以便操作员可以对实际问题采取行动，而不是被重复的警告淹没。 (#67401) 感谢 @xantorres。
- Agents/重放：在出站请求上严格重放工具调用 ID 清理后重新运行工具/结果配对，以便像 MiniMax 这样的 Anthropic 兼容提供商在压缩和重试流程期间不再收到格式错误的孤立工具结果 ID，例如 `...toolresult1`。 (#67620) 感谢 @stainlu。
- Gateway/启动：修复 Linux/systemd 上插件自动启用是唯一启动配置写入时的虚假 SIGUSR1 重启循环；配置哈希保护未为该写入路径捕获，导致 chokidar 将每次引导写入视为外部更改并触发重新加载 → 重启循环，在重复循环后损坏 manifest.db。修复 #67436。 (#67557) 感谢 @openperf
- Codex/harness：当 `codex` 被选为嵌入式代理 harness 运行时时，自动启用 Codex 插件，包括强制默认、每代理和 `OPENCLAW_AGENT_RUNTIME` 路径。 (#67474) 感谢 @duqaXxX。
- OpenAI Codex/CLI：保持恢复的 `codex exec resume` 运行在安全的非交互式路径上，而不通过传递支持的 `--skip-git-repo-check` 恢复参数加上 Codex 的原生 `sandbox_mode="workspace-write"` 配置覆盖重新引入已删除的危险旁路标志。 (#67666) 感谢 @plgonzalezrx8。
- Codex/app-server：解析 Desktop 起源的应用服务器用户代理，例如 `Codex Desktop/0.118.0`，当 Codex CLI 继承多词起源器时保持版本门工作。 (#64666) 感谢 @cyrusaf。
- Cron/公告交付：保持隔离公告 `NO_REPLY` 剥离在直接和文本交付中不区分大小写，在标题剥离静默时保留结构化仅媒体发送，并从清理的有效负载中派生主会话感知，以便静默标题不再泄漏过时的 `NO_REPLY` 文本。 (#65016) 感谢 @BKF-Gitty。
- 会话/Codex：仅当最新的助手消息具有相同的可见文本时，跳过冗余的 `delivery-mirror` 记录追加，防止 Codex 支持的回合上的重复可见回复，而不抑制跨回合的重复答案。 (#67185) 感谢 @andyylin。
- 自动回复/提示缓存：将易变的入站聊天 ID 从稳定的系统提示中保持，以便任务范围的适配器可以跨运行重用提示缓存，同时保留用户回合和仅媒体消息的对话元数据。 (#65071) 感谢 @MonkeyLeeT。
- BlueBubbles/入站：通过从非 SSRF fetch 路径中剥离不兼容的捆绑 undici 调度器，在 Node 22+ 上恢复入站图像附件下载，接受带有附件的 `updated-message` webhook，使用事件类型感知的去重键，以便附件后续不会被拒绝为重复，并在初始 webhook 以空数组到达时从 BB API 重试附件获取。 (#64105, #61861, #65430, #67510) 感谢 @omarshahine。
- Agents/技能：在合并源后按技能名称排序面向提示的 `available_skills` 条目，以便 `skills.load.extraDirs` 顺序不再更改提示缓存前缀。 (#64198) 感谢 @Bartok9。
- Agents/OpenAI 响应：添加 `models.providers.*.models.*.compat.supportsPromptCacheKey`，以便转发 `prompt_cache_key` 的 OpenAI 兼容代理可以保持启用提示缓存，而不兼容的端点仍然可以强制剥离。 (#67427) 感谢 @damselem。
- Agents/上下文引擎：保持循环钩子和最终 `afterTurn` 提示缓存触摸元数据与当前助手回合对齐，以便缓存感知的上下文引擎在工具循环期间保留准确的缓存 TTL 状态。 (#67767) 感谢 @jalehman。
- Memory/做梦：在规范化之前从会话语料库用户回合中剥离 AI 面向的入站元数据信封，以便 REM 主题提取看到用户的实际消息文本，包括数组形状的拆分信封。 (#66548) 感谢 @zqchris。
- Agents/错误：在传输 DNS 分类之前检测独立的 Cloudflare/CDN HTML 挑战页面，以便提供商阻止页面不再显示为本地 DNS 查找失败。 (#67704) 感谢 @chris-yyau。
- 安全/批准：在 exec 批准提示中编辑秘密，以便内联批准审查不再在呈现的提示内容中泄漏凭证材料。 (#61077, #64790)
- CLI/configure：在写入后重新读取持久化的配置哈希，以便配置更新不再因过时哈希竞争而失败。 (#64188, #66528)
- CLI/更新：在 npm 升级后修剪过时的打包 `dist` 块，并保持降级/验证库存检查兼容安全，以便全局升级不再在过时的块导入上失败。 (#66959) 感谢 @obviyus。
- 入职/CLI：修复全局安装的 CLI 设置在入职期间的通道选择崩溃。 (#66736)
- 视频生成/实时测试：绑定提供商轮询以进行实时视频烟雾，默认为快速非 FAL 文本到视频路径，并使用一秒钟的龙虾提示，以便发布验证不再在缓慢的提供商队列上无限期等待。
- Memory-core/QMD `memory_get`：拒绝读取任意工作区 markdown 路径，只允许规范内存文件（`MEMORY.md`、`memory.md`、`DREAMS.md`、`dreams.md`、`memory/**`）加上活动索引的 QMD 工作区文档的确切路径，以便 QMD 内存后端不能再用作通用工作区文件读取 shim，绕过 `read` 工具策略拒绝。 (#66026) 感谢 @eleqtrizit。
- Cron/代理：将嵌入式运行工具策略和内部事件参数转发到尝试层，以便 `--tools` 允许列表、cron 拥有的消息工具抑制、显式消息目标和命令路径内部事件在运行时再次生效。 (#62675) 感谢 @hexsprite。
- 设置/提供商：在设置期间保护首选提供商查找，以便带有缺失提供商 ID 的格式错误的插件元数据不再使向导崩溃，出现 `Cannot read properties of undefined (reading 'trim')`。 (#66649) 感谢 @Tianworld。
- Matrix/安全：规范化沙盒配置文件头像参数，保留 `mxc://` 头像 URL，并在重新加载期间显示 gmail 观察器停止失败。 (#64701) 感谢 @slepybear。
- Telegram/文档：从入站 Telegram 文本处理中删除泄漏的二进制标题字节，以便像 `.mobi` 或 `.epub` 这样的文档上传不再爆炸提示令牌计数。 (#66663) 感谢 @joelnishanth。
- Gateway/身份验证：通过 `getResolvedAuth()` 解析 HTTP 服务器和 HTTP 升级处理程序上的活动网关 bearer 每请求，镜像 WebSocket 路径，以便通过 `secrets.reload` 或配置热重载轮换的秘密在 `/v1/*`、`/tools/invoke`、插件 HTTP 路由和画布升级路径上立即停止认证，而不是在 HTTP 上保持有效直到网关重启。 (#66651) 感谢 @mmaps。
- Agents/压缩：将压缩保留令牌下限限制到模型上下文窗口，以便小上下文本地模型（例如具有 16K 令牌的 Ollama）不再在每个提示上触发上下文溢出错误或无限压缩循环。 (#65671) 感谢 @openperf。
- Agents/OpenAI 响应：将确切的 `Unknown error (no error details in response)` 传输失败分类为故障转移原因 `unknown`，以便助手/模型故障转移仍然为该无详细信息失败路径运行。 (#65254) 感谢 @OpenCodeEngineer。
- 模型/探测：在 `models list --probe` 中将无效模型探测失败显示为 `format` 而不是 `unknown`，并锁定无效模型故障转移路径与回归覆盖。 (#50028) 感谢 @xiwuqi。
- Agents/故障转移：将 OpenAI 兼容的 `finish_reason: network_error` 流失败分类为超时，以便模型故障转移重试继续，而不是以未知故障转移原因停止。 (#61784) 感谢 @lawrence3699。
- 入职/通道：在发现和验证之前规范化通道设置元数据，以便格式错误或混合形状的通道插件元数据不再破坏设置和入职通道列表。 (#66706) 感谢 @darkamenosa。
- Slack/原生命令：通过为每个按钮提供唯一的操作 ID，同时仍将它们路由通过共享的 `openclaw_cmdarg*` 监听器，修复 Slack 呈现原生按钮时的斜杠命令（如 `/verbose`）的选项菜单。感谢 @Wangmerlyn。
- Feishu/webhook：硬化 webhook 传输和卡片操作重放保护，在缺失 `encryptKey` 和空白回调令牌时失败关闭 — 在没有 `encryptKey` 的情况下拒绝启动 webhook 传输，在没有密钥存在时拒绝未签名的请求，而不是接受它们，并在去重声明和调度器之前删除空白卡片操作令牌。防御深度超过已经关闭的监视器账户层。 (#66707) 感谢 @eleqtrizit。
- Agents/工作区文件：通过共享的 `fs-safe` 助手（`openFileWithinRoot`/`readFileWithinRoot`/`writeFileWithinRoot`）路由 `agents.files.get`、`agents.files.set` 和工作区列表，拒绝允许的代理文件的符号链接别名，并让 `fs-safe` 从文件描述符解析打开的文件真实路径，然后回退到基于路径的 `realpath`，以便 `open` 和 `realpath` 之间的符号链接交换不再将验证的路径重定向到预期的 inode 之外。 (#66636) 感谢 @eleqtrizit。
- Gateway/MCP 环回：将 `/mcp` bearer 比较从纯 `!==` 切换到恒定时间 `safeEqualSecret`（与代码库中每个其他身份验证表面使用的约定匹配），并在身份验证门运行之前通过 `checkBrowserOrigin` 拒绝非环回浏览器源请求。环回源（`127.0.0.1:*`、`localhost:*`、同源）仍然通过，包括浏览器标记为 `Sec-Fetch-Site: cross-site` 的 `localhost`↔`127.0.0.1` 主机不匹配。 (#66665) 感谢 @eleqtrizit。
- 自动回复/计费：从结构化故障转移原因分类纯计费冷却故障转移摘要，以便用户看到计费指导而不是通用失败回复。 (#66363) 感谢 @Rohan5commit。
- Agents/故障转移：在会话历史的模型故障转移重试上保留原始提示正文，以便重试模型保持活动任务，而不仅仅看到通用的继续消息。 (#66029) 感谢 @WuKongAI-CMU。
- Reply/秘密：在回复运行消息操作发现之前解析活动回复通道/账户 SecretRef，以便通道令牌 SecretRef（例如 Discord）不会降级为发现时未解析的秘密失败。 (#66796) 感谢 @joshavant。
- Agents/Anthropic：忽略非正 Anthropic Messages 令牌覆盖，并在没有正令牌预算剩余时本地失败，以便无效的 `max_tokens` 值不再到达提供商 API。 (#66664) 感谢 @jalehman
- Agents/上下文引擎：在延迟维护重用回合后运行时上下文时，保留仅提示令牌计数，而不是完整请求总计，以便后台压缩簿记与活动提示窗口匹配。 (#66820) 感谢 @jalehman。
- BlueBubbles/入站：通过持久的每账户光标和 `/api/v1/message/query?after=<ts>` 传递，在网关重启后重放错过的 webhook 消息，以便网关关闭时传递的消息不再消失。使用现有的 `processMessage` 路径，并通过 #66816 的入站 GUID 缓存去重。 (#66857, #66721) 感谢 @omarshahine。
- Secrets/插件/状态：在插件预加载、只读状态/代理表面和运行时身份验证路径之间对齐 SecretRef 检查与严格处理，以便未解析的引用不再使只读 CLI 流程崩溃，而运行时所需的非环境引用保持严格。 (#66818) 感谢 @joshavant。
- Memory/做梦：停止仅引用梦境日记提示的普通记录被分类为内部做梦运行并从会话召回摄取中静默删除。 (#66852) 感谢 @gumadeiras。
- Telegram/文档：清理二进制回复上下文和类似 ZIP 的存档提取，以便 `.epub` 和 `.mobi` 上传不再通过回复元数据或存档到 `text/plain` 强制将原始二进制泄漏到提示上下文中。 (#66877) 感谢 @martinfrancois。
- Telegram/原生命令：恢复插件注册表支持的原生命令和原生技能的自动默认值，以便当 `commands.native` 和 `commands.nativeSkills` 保持为 `auto` 时，Telegram 斜杠命令继续注册。 (#66843) 感谢 @kashevk0。
- OpenRouter/Qwen3：解析 `reasoning_details` 流增量作为思考内容，而不跳过同块工具调用，以便 Qwen3 回复在 OpenRouter 上不再失败为空，混合推理/工具调用块仍然正常执行。 (#66905) 感谢 @bladin。
- BlueBubbles/追赶：通过持久的每账户光标和 `/api/v1/message/query?after=<ts>` 传递，在网关重启后重放错过的 webhook 消息，以便网关关闭时传递的消息不再消失。使用现有的 `processMessage` 路径，并通过 #66816 的入站 GUID 缓存去重。 (#66857, #66721) 感谢 @omarshahine。
- Telegram/原生命令：保持 Telegram 命令同步缓存进程本地，以便网关重启重新注册菜单，而不是在 Telegram 带外清除命令后信任过时的磁盘同步状态。 (#66730) 感谢 @nightq。
- 音频/自托管 STT：为音频转录恢复 `models.providers.*.request.allowPrivateNetwork`，以便在 v2026.4.14 回归后，私有或 LAN 语音到文本端点不再触发 SSRF 块。 (#66692) 感谢 @jhsmith409。
- 自动回复/媒体：在自动回复发送流程中允许工作区根绝对媒体路径，以便有效的本地媒体引用不再失败路径验证。 (#66689)
- WhatsApp/Baileys 媒体上传：硬化加密上传处理，以便大型出站媒体发送避免缓冲区峰值和可靠性回归。 (#65966) 感谢 @frankekn。
- QQBot/cron：在 `parseFaceTags` 和 `filterInternalMarkers` 中防御未定义的 `event.content`，以便带有无内容有效负载的 cron 触发代理回合不再崩溃，出现 `TypeError: Cannot read properties of undefined (reading 'startsWith')`。 (#66302) 感谢 @xinmotlanthua。
- CLI/插件：停止 `--dangerously-force-unsafe-install` 插件安装在安全扫描失败后回退到钩子包安装，同时仍然为真实的钩子包保留非安全回退行为。 (#58909) 感谢 @hxy91819。
- Claude CLI/会话：将 `No conversation found with session ID` 分类为 `session_expired`，以便过期的 CLI 支持的对话清除过时的绑定并在下一回合恢复。 (#65028) 感谢 @Ivan-Fn。
- 上下文引擎：当第三方上下文引擎插件在解析时失败（未注册 ID、工厂抛出或合同违反）时，优雅地回退到遗留引擎，防止每个通道的完全网关中断。 (#66930) 感谢 @openperf。
- Control UI/聊天：通过将同会话历史重新加载推迟到活动运行结束（包括中止和错误运行），在活动发送期间保持乐观的用户消息卡片可见。 (#66997) 感谢 @scotthuang 和 @vincentkoc。
- 媒体/Slack：仅当回退缓冲区实际解码为文本时，才允许主机本地 CSV 和 Markdown 上传，以便真正的纯文本文件工作，而不会让重命名为 `.csv` 或 `.md` 的不透明非文本 blob 滑过主机读取保护。 (#67047) 感谢 @Unayung。
- Ollama/入职：将设置分为 `Cloud + Local`、`Cloud only` 和 `Local only`，支持没有本地守护程序的直接 `OLLAMA_API_KEY` 云设置，并将 Ollama 网络搜索保持在本地主机路径上。 (#67005) 感谢 @obviyus。
- Webchat/安全：在媒体嵌入路径中拒绝远程主机 `file://` URL。 (#67293) 感谢 @pgondhi987。
- 做梦/memory-core：使用摄取日，而不是源文件日，进行每日召回去重，以便同一每日笔记的重复扫描可以跨天增加 `dailyCount`，而不是在 `1` 处停滞。 (#67091) 感谢 @Bartok9。
- Node-host/tools.exec：让批准绑定区分已知的原生二进制文件和可变的 shell 有效负载文件，同时仍然失败关闭未知或竞争文件探测，以便像 `/usr/bin/whoami` 这样的绝对路径 node-host 命令不再被拒绝为不安全的解释器/运行时命令。 (#66731) 感谢 @tmimmanuel。
- Codex/网关：修复当 codex-acp 子进程突然终止时的网关崩溃；子 stdin 流上的未处理 EPIPE 现在通过优雅的客户端关闭路由，拒绝待处理请求，而不是作为未捕获的异常传播，导致整个网关守护程序和所有连接的通道崩溃。修复 #67886。 (#67947) 感谢 @openperf
- Slack/流式：当可用时，从入站用户解析原生流式接收者团队，带有监视器团队回退，以便 DM 和共享工作区流更可靠地瞄准正确的接收者。
- OpenRouter/流式：在 OpenRouter 兼容的完成流上将 `reasoning_details.response.output_text` 和 `reasoning_details.response.text` 视为可见的助手输出，同时保持 `reasoning.text` 隐藏并默认拒绝显示模棱两可的裸 `text` 项，以便可见回复、思考块和工具调用可以在同一块中共存。 (#67410) 感谢 @neeravmakwana。
- 模型/OpenRouter 别名：将 `openrouter:auto` 解析为规范的 `openrouter/auto` 模型，并将 `openrouter:free` 映射到第一个配置的具体 `openrouter/...:free` 模型，而不是在默认提供商下错误解析这些兼容别名。 (#57066) 感谢 @sumiisiaran。
- OpenRouter/Arcee：在提供商配置规范化和运行时模型/传输解析期间规范化过时的 OpenRouter `https://openrouter.ai/v1` 基础 URL，以便新鲜的 `models.json` 写入和以前发现的行自愈回 `https://openrouter.ai/api/v1`，而不是破坏 OpenRouter 路由的请求。 (#67295) 感谢 @achalkov。

## 2026.4.14

### 变更

- OpenAI Codex/模型：添加 `gpt-5.4-pro` 的前向兼容支持，包括 Codex 定价/限制和列表/状态可见性，在上游目录赶上之前。 (#66453) 感谢 @jepson-liu。
- Telegram/论坛主题：通过从 Telegram 论坛服务消息学习名称，在代理上下文、提示元数据和插件钩子元数据中显示人类主题名称。 (#65973) 感谢 @ptahdunbar。

### 修复

- Agents/Ollama：将配置的嵌入式运行超时转发到全局 undici 流超时调整，以便慢速本地 Ollama 运行不再继承默认流截止，而是操作员设置的运行超时。 (#63175) 感谢 @mindcraftreader 和 @vincentkoc。
- 模型/Codex：在 codex 提供商目录输出中包含 `apiKey`，以便 Pi ModelRegistry 验证器不再拒绝条目并从 `models.json` 中的每个提供商静默删除所有自定义模型。 (#66180) 感谢 @hoyyeva。
- 工具/图像+pdf：在媒体工具注册表查找之前规范化配置的提供商/模型引用，以便图像和 PDF 工具运行停止仅因为工具路径跳过通常的模型引用规范化步骤而拒绝有效的 Ollama 视觉模型为未知。 (#59943) 感谢 @yqli2420 和 @vincentkoc。
- Slack/交互：将配置的全局 `allowFrom` 所有者允许列表应用于通道块操作和模态交互事件，要求预期的发送者 ID 进行交叉验证，并拒绝模棱两可的通道类型，以便交互触发器不再可以在没有 `users` 列表的通道中绕过文档允许列表意图。当没有配置允许列表时，保持默认开放行为。 (#66028) 感谢 @eleqtrizit。
- 媒体理解/附件：当本地附件路径无法通过 `realpath` 规范解析时失败关闭，以便 `realpath` 错误不能再将规范根允许列表检查降级为非规范比较；也有 URL 的附件仍然回退到网络获取路径。 (#66022) 感谢 @eleqtrizit。
- Agents/网关工具：当 `config.patch` 和 `config.apply` 调用将新启用 `openclaw security audit` 枚举的任何标志时（例如 `dangerouslyDisableDeviceAuth`、`allowInsecureAuth`、`dangerouslyAllowHostHeaderOriginFallback`、`hooks.gmail.allowUnsafeExternalContent`、`tools.exec.applyPatch.workspaceOnly: false`），拒绝模型面向的网关工具的这些调用；已经启用的标志保持不变，以便同一补丁中的非危险编辑仍然应用，直接认证的操作员 RPC 行为不变。 (#62006) 感谢 @eleqtrizit。
- Google 图像生成：仅在调用原生 Gemini 图像 API 时从配置的 Google 基础 URL 中剥离尾随的 `/openai` 后缀，以便 Gemini 图像请求不再 404，而不破坏显式的 OpenAI 兼容 Google 端点。 (#66445) 感谢 @dapzthelegend。
- Telegram/论坛主题：将学习的主题名称持久化到 Telegram 会话侧车存储，以便代理上下文可以在重启后继续使用人类主题名称，而不是从未来的服务元数据中重新学习。 (#66107) 感谢 @obviyus。
- Doctor/systemd：保持 `openclaw doctor --repair` 和服务重新安装不会在用户 systemd 单元中重新嵌入 dotenv 支持的秘密，同时保留较新的内联覆盖而不是过时的状态目录 `.env` 值。 (#66249) 感谢 @tmimmanuel。
- Ollama/OpenAI 兼容：为 Ollama 流式完成发送 `stream_options.include_usage`，以便本地 Ollama 运行报告真实使用情况，而不是回退到触发过早压缩的虚假提示令牌计数。 (#64568) 感谢 @xchunzhao 和 @vincentkoc。
- Doctor/插件：在每个插件自动启用传递中缓存外部 `preferOver` 目录查找，以便大型 `agents.list` 配置不再固定 CPU 并在 doctor/插件解析期间重复重新读取插件目录。 (#66246) 感谢 @yfge。
- GitHub Copilot/思考：允许 `github-copilot/gpt-5.4` 使用 `xhigh` 推理，以便 Copilot GPT-5.4 与 GPT-5.4 系列的其余部分匹配。 (#50168) 感谢 @jakepresent 和 @vincentkoc。
- Memory/嵌入：在规范化 OpenAI 兼容嵌入模型引用时保留非 OpenAI 提供商前缀，以便代理支持的内存提供商停止因 `Unknown memory embedding provider` 而失败。 (#66452) 感谢 @jlapenna。
- Agents/本地模型：为自托管模型澄清低上下文预检提示，将配置支持的上限指向相关的 OpenClaw 设置，并在 `agents.defaults.contextTokens` 是实际限制时停止建议更大的模型。 (#66236) 感谢 @ImLukeF。
- Browser/SSRF：在默认浏览器 SSRF 策略下恢复主机名导航，同时保持从配置可达到的显式严格模式，并保持管理的环回 CDP `/json/new` 回退请求在本地 CDP 控制策略上，以便浏览器后续修复停止回归正常导航或自阻塞本地 CDP 控制。 (#66386) 感谢 @obviyus。