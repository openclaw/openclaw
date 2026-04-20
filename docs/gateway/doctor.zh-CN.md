---
summary: "Doctor 命令：健康检查、配置迁移和修复步骤"
read_when:
  - 添加或修改 doctor 迁移
  - 引入破坏性配置更改
title: "Doctor"
---

# Doctor

`openclaw doctor` 是 OpenClaw 的修复 + 迁移工具。它修复过时的配置/状态，检查健康状况，并提供可操作的修复步骤。

## 快速开始

```bash
openclaw doctor
```

### 无头 / 自动化

```bash
openclaw doctor --yes
```

接受默认值而不提示（包括适用时的重启/服务/沙箱修复步骤）。

```bash
openclaw doctor --repair
```

应用推荐的修复而不提示（安全的修复 + 重启）。

```bash
openclaw doctor --repair --force
```

也应用激进的修复（覆盖自定义监督程序配置）。

```bash
openclaw doctor --non-interactive
```

运行时不提示，仅应用安全迁移（配置规范化 + 磁盘状态移动）。跳过需要人工确认的重启/服务/沙箱操作。
遗留状态迁移在检测到时自动运行。

```bash
openclaw doctor --deep
```

扫描系统服务以查找额外的网关安装（launchd/systemd/schtasks）。

如果您想在写入前查看更改，请先打开配置文件：

```bash
cat ~/.openclaw/openclaw.json
```

## 它做什么（摘要）

- 可选的 git 安装预检更新（仅交互式）。
- UI 协议新鲜度检查（当协议架构更新时重建 Control UI）。
- 健康检查 + 重启提示。
- 技能状态摘要（合格/缺失/阻塞）和插件状态。
- 旧值的配置规范化。
- 从旧版平面 `talk.*` 字段到 `talk.provider` + `talk.providers.<provider>` 的 Talk 配置迁移。
- 旧版 Chrome 扩展配置和 Chrome MCP 就绪的浏览器迁移检查。
- OpenCode 提供商覆盖警告（`models.providers.opencode` / `models.providers.opencode-go`）。
- Codex OAuth 影子警告（`models.providers.openai-codex`）。
- OpenAI Codex OAuth 配置文件的 OAuth TLS 先决条件检查。
- 旧版磁盘状态迁移（会话/代理目录/WhatsApp 身份验证）。
- 旧版插件清单合约密钥迁移（`speechProviders`、`realtimeTranscriptionProviders`、`realtimeVoiceProviders`、`mediaUnderstandingProviders`、`imageGenerationProviders`、`videoGenerationProviders`、`webFetchProviders`、`webSearchProviders` → `contracts`）。
- 旧版 cron 存储迁移（`jobId`、`schedule.cron`、顶级传递/有效负载字段、有效负载 `provider`、简单的 `notify: true` webhook 回退作业）。
- 会话锁定文件检查和过时锁定清理。
- 状态完整性和权限检查（会话、转录、状态目录）。
- 本地运行时的配置文件权限检查（chmod 600）。
- 模型身份验证健康：检查 OAuth 过期，可刷新过期令牌，并报告身份验证配置文件冷却/禁用状态。
- 额外工作区目录检测（`~/openclaw`）。
- 启用沙箱时的沙箱镜像修复。
- 旧版服务迁移和额外网关检测。
- Matrix 通道旧版状态迁移（在 `--fix` / `--repair` 模式下）。
- 网关运行时检查（服务已安装但未运行；缓存的 launchd 标签）。
- 通道状态警告（从运行的网关探测）。
- 监督程序配置审计（launchd/systemd/schtasks），可选择修复。
- 网关运行时最佳实践检查（Node vs Bun、版本管理器路径）。
- 网关端口冲突诊断（默认 `18789`）。
- 开放 DM 策略的安全警告。
- 本地令牌模式的网关身份验证检查（当无令牌源存在时提供令牌生成；不覆盖令牌 SecretRef 配置）。
- 设备配对故障检测（待处理的首次配对请求、待处理的角色/范围升级、过时的本地设备令牌缓存漂移、配对记录身份验证漂移）。
- Linux 上的 systemd linger 检查。
- 工作区引导文件大小检查（上下文文件的截断/接近限制警告）。
- Shell 补全状态检查和自动安装/升级。
- 内存搜索嵌入提供商就绪检查（本地模型、远程 API 密钥或 QMD 二进制文件）。
- 源代码安装检查（pnpm 工作区不匹配、缺少 UI 资产、缺少 tsx 二进制文件）。
- 写入更新的配置 + 向导元数据。

## Dreams UI 回填和重置

Control UI Dreams 场景包括**回填**、**重置**和**清除基础**操作，用于基础梦想工作流程。这些操作使用网关 doctor 风格的 RPC 方法，但它们**不是** `openclaw doctor` CLI 修复/迁移的一部分。

它们做什么：

- **回填** 扫描活动工作区中的历史 `memory/YYYY-MM-DD.md` 文件，运行基础 REM 日记传递，并将可逆回填条目写入 `DREAMS.md`。
- **重置** 仅从 `DREAMS.md` 中删除那些标记的回填日记条目。
- **清除基础** 仅删除来自历史回放且尚未积累实时回忆或日常支持的阶段性基础短期条目。

它们**不**单独做什么：

- 它们不编辑 `MEMORY.md`
- 它们不运行完整的 doctor 迁移
- 它们不会自动将基础候选者阶段性地放入实时短期晋升存储，除非您先显式运行阶段性 CLI 路径

如果您希望基础历史回放影响正常的深度晋升通道，请改用 CLI 流程：

```bash
openclaw memory rem-backfill --path ./memory --stage-short-term
```

这会将基础持久候选者阶段性地放入短期梦想存储，同时保持 `DREAMS.md` 作为审查表面。

## 详细行为和原理

### 0) 可选更新（git 安装）

如果这是 git 检出并且 doctor 以交互方式运行，它会在运行 doctor 之前提供更新（获取/变基/构建）。

### 1) 配置规范化

如果配置包含旧值形状（例如没有通道特定覆盖的 `messages.ackReaction`），doctor 会将它们规范化为当前架构。

这包括旧版 Talk 平面字段。当前公共 Talk 配置是 `talk.provider` + `talk.providers.<provider>`。Doctor 将旧的 `talk.voiceId` / `talk.voiceAliases` / `talk.modelId` / `talk.outputFormat` / `talk.apiKey` 形状重写为提供商映射。

### 2) 旧版配置密钥迁移

当配置包含已弃用的密钥时，其他命令会拒绝运行并要求您运行 `openclaw doctor`。

Doctor 将：

- 解释发现了哪些旧版密钥。
- 显示它应用的迁移。
- 用更新的架构重写 `~/.openclaw/openclaw.json`。

网关在检测到旧版配置格式时也会在启动时自动运行 doctor 迁移，因此过时的配置会在无需手动干预的情况下得到修复。Cron 作业存储迁移由 `openclaw doctor --fix` 处理。

当前迁移：

- `routing.allowFrom` → `channels.whatsapp.allowFrom`
- `routing.groupChat.requireMention` → `channels.whatsapp/telegram/imessage.groups."*".requireMention`
- `routing.groupChat.historyLimit` → `messages.groupChat.historyLimit`
- `routing.groupChat.mentionPatterns` → `messages.groupChat.mentionPatterns`
- `routing.queue` → `messages.queue`
- `routing.bindings` → 顶级 `bindings`
- `routing.agents`/`routing.defaultAgentId` → `agents.list` + `agents.list[].default`
- 旧版 `talk.voiceId`/`talk.voiceAliases`/`talk.modelId`/`talk.outputFormat`/`talk.apiKey` → `talk.provider` + `talk.providers.<provider>`
- `routing.agentToAgent` → `tools.agentToAgent`
- `routing.transcribeAudio` → `tools.media.audio.models`
- `messages.tts.<provider>`（`openai`/`elevenlabs`/`microsoft`/`edge`）→ `messages.tts.providers.<provider>`
- `channels.discord.voice.tts.<provider>`（`openai`/`elevenlabs`/`microsoft`/`edge`）→ `channels.discord.voice.tts.providers.<provider>`
- `channels.discord.accounts.<id>.voice.tts.<provider>`（`openai`/`elevenlabs`/`microsoft`/`edge`）→ `channels.discord.accounts.<id>.voice.tts.providers.<provider>`
- `plugins.entries.voice-call.config.tts.<provider>`（`openai`/`elevenlabs`/`microsoft`/`edge`）→ `plugins.entries.voice-call.config.tts.providers.<provider>`
- `plugins.entries.voice-call.config.provider: "log"` → `"mock"`
- `plugins.entries.voice-call.config.twilio.from` → `plugins.entries.voice-call.config.fromNumber`
- `plugins.entries.voice-call.config.streaming.sttProvider` → `plugins.entries.voice-call.config.streaming.provider`
- `plugins.entries.voice-call.config.streaming.openaiApiKey|sttModel|silenceDurationMs|vadThreshold`
  → `plugins.entries.voice-call.config.streaming.providers.openai.*`
- `bindings[].match.accountID` → `bindings[].match.accountId`
- 对于具有命名 `accounts` 但仍有单个账户顶级通道值的通道，将这些账户范围的值移动到为该通道选择的提升账户中（大多数通道为 `accounts.default`；Matrix 可以保留现有的匹配命名/默认目标）
- `identity` → `agents.list[].identity`
- `agent.*` → `agents.defaults` + `tools.*`（tools/elevated/exec/sandbox/subagents）
- `agent.model`/`allowedModels`/`modelAliases`/`modelFallbacks`/`imageModelFallbacks`
  → `agents.defaults.models` + `agents.defaults.model.primary/fallbacks` + `agents.defaults.imageModel.primary/fallbacks`
- `browser.ssrfPolicy.allowPrivateNetwork` → `browser.ssrfPolicy.dangerouslyAllowPrivateNetwork`
- `browser.profiles.*.driver: "extension"` → `"existing-session"`
- 移除 `browser.relayBindHost`（旧版扩展中继设置）

Doctor 警告还包括多账户通道的账户默认指导：

- 如果配置了两个或更多 `channels.<channel>.accounts` 条目而没有 `channels.<channel>.defaultAccount` 或 `accounts.default`，doctor 会警告回退路由可能会选择意外的账户。
- 如果 `channels.<channel>.defaultAccount` 设置为未知的账户 ID，doctor 会警告并列出已配置的账户 ID。

### 2b) OpenCode 提供商覆盖

如果您手动添加了 `models.providers.opencode`、`opencode-zen` 或 `opencode-go`，它会覆盖来自 `@mariozechner/pi-ai` 的内置 OpenCode 目录。这可能会强制模型使用错误的 API 或零成本。Doctor 会警告您，以便您可以删除覆盖并恢复每个模型的 API 路由 + 成本。

### 2c) 浏览器迁移和 Chrome MCP 就绪

如果您的浏览器配置仍然指向已移除的 Chrome 扩展路径，doctor 会将其规范化为当前的主机本地 Chrome MCP 附加模型：

- `browser.profiles.*.driver: "extension"` 变为 `"existing-session"`
- `browser.relayBindHost` 被移除

当您使用 `defaultProfile: "user"` 或配置的 `existing-session` 配置文件时，doctor 还会审计主机本地 Chrome MCP 路径：

- 检查默认自动连接配置文件是否在同一主机上安装了 Google Chrome
- 检查检测到的 Chrome 版本，并在低于 Chrome 144 时发出警告
- 提醒您在浏览器检查页面启用远程调试（例如 `chrome://inspect/#remote-debugging`、`brave://inspect/#remote-debugging` 或 `edge://inspect/#remote-debugging`）

Doctor 无法为您启用 Chrome 端设置。主机本地 Chrome MCP 仍然需要：

- 网关/节点主机上的 Chromium 浏览器 144+
- 浏览器在本地运行
- 该浏览器中启用了远程调试
- 批准浏览器中的第一个附加同意提示

这里的就绪仅与本地附加先决条件有关。现有会话保持当前 Chrome MCP 路由限制；高级路由如 `responsebody`、PDF 导出、下载拦截和批处理操作仍然需要托管浏览器或原始 CDP 配置文件。

此检查**不适用于** Docker、沙箱、远程浏览器或其他无头流程。这些继续使用原始 CDP。

### 2d) OAuth TLS 先决条件

当配置了 OpenAI Codex OAuth 配置文件时，doctor 会探测 OpenAI 授权端点，以验证本地 Node/OpenSSL TLS 堆栈是否可以验证证书链。如果探测失败并出现证书错误（例如 `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`、过期证书或自签名证书），doctor 会打印特定于平台的修复指导。在带有 Homebrew Node 的 macOS 上，修复通常是 `brew postinstall ca-certificates`。使用 `--deep` 时，即使网关健康，探测也会运行。

### 2c) Codex OAuth 提供商覆盖

如果您之前在 `models.providers.openai-codex` 下添加了旧版 OpenAI 传输设置，它们会影响较新版本自动使用的内置 Codex OAuth 提供商路径。当 Doctor 看到这些旧传输设置与 Codex OAuth 一起使用时，会发出警告，以便您可以删除或重写过时的传输覆盖并恢复内置路由/回退行为。自定义代理和仅标头覆盖仍然受支持，不会触发此警告。

### 3) 旧版状态迁移（磁盘布局）

Doctor 可以将较旧的磁盘布局迁移到当前结构：

- 会话存储 + 转录：
  - 从 `~/.openclaw/sessions/` 到 `~/.openclaw/agents/<agentId>/sessions/`
- 代理目录：
  - 从 `~/.openclaw/agent/` 到 `~/.openclaw/agents/<agentId>/agent/`
- WhatsApp 身份验证状态（Baileys）：
  - 从旧版 `~/.openclaw/credentials/*.json`（`oauth.json` 除外）
  - 到 `~/.openclaw/credentials/whatsapp/<accountId>/...`（默认账户 ID：`default`）

这些迁移是尽力而为且幂等的；当 doctor 将任何旧文件夹作为备份留下时，会发出警告。网关/CLI 也会在启动时自动迁移旧版会话 + 代理目录，以便历史/身份验证/模型在无需手动 doctor 运行的情况下进入每个代理路径。WhatsApp 身份验证有意仅通过 `openclaw doctor` 迁移。Talk 提供商/提供商映射规范化现在通过结构相等性进行比较，因此仅键顺序差异不再触发重复的无操作 `doctor --fix` 更改。

### 3a) 旧版插件清单迁移

Doctor 扫描所有已安装的插件清单，查找已弃用的顶级功能键（`speechProviders`、`realtimeTranscriptionProviders`、`realtimeVoiceProviders`、`mediaUnderstandingProviders`、`imageGenerationProviders`、`videoGenerationProviders`、`webFetchProviders`、`webSearchProviders`）。找到时，它会提供将它们移动到 `contracts` 对象并就地重写清单文件。此迁移是幂等的；如果 `contracts` 键已经具有相同的值，则旧键会被删除而不会复制数据。

### 3b) 旧版 cron 存储迁移

Doctor 还检查 cron 作业存储（默认为 `~/.openclaw/cron/jobs.json`，或覆盖时的 `cron.store`），查找调度程序仍为兼容性而接受的旧作业形状。

当前 cron 清理包括：

- `jobId` → `id`
- `schedule.cron` → `schedule.expr`
- 顶级有效负载字段（`message`、`model`、`thinking`，...）→ `payload`
- 顶级传递字段（`deliver`、`channel`、`to`、`provider`，...）→ `delivery`
- 有效负载 `provider` 传递别名 → 显式 `delivery.channel`
- 简单的旧版 `notify: true` webhook 回退作业 → 显式 `delivery.mode="webhook"` 与 `delivery.to=cron.webhook`

Doctor 仅在可以在不更改行为的情况下自动迁移 `notify: true` 作业。如果作业将旧版通知回退与现有的非 webhook 传递模式结合使用，doctor 会警告并将该作业留作手动审查。

### 3c) 会话锁定清理

Doctor 扫描每个代理会话目录以查找过时的写入锁定文件 — 会话异常退出时留下的文件。对于找到的每个锁定文件，它会报告：路径、PID、PID 是否仍然存在、锁定年龄，以及是否被视为过时（PID 已死或超过 30 分钟）。在 `--fix` / `--repair` 模式下，它会自动删除过时的锁定文件；否则，它会打印注释并指示您使用 `--fix` 重新运行。

### 4) 状态完整性检查（会话持久性、路由和安全性）

状态目录是操作的脑干。如果它消失，您将丢失会话、凭据、日志和配置（除非您在其他地方有备份）。

Doctor 检查：

- **状态目录缺失**：警告灾难性状态丢失，提示重新创建目录，并提醒您它无法恢复丢失的数据。
- **状态目录权限**：验证可写性；提供修复权限（当检测到所有者/组不匹配时发出 `chown` 提示）。
- **macOS 云同步状态目录**：当状态解析到 iCloud Drive（`~/Library/Mobile Documents/com~apple~CloudDocs/...`）或 `~/Library/CloudStorage/...` 下时发出警告，因为同步支持的路径可能导致较慢的 I/O 和锁定/同步竞争。
- **Linux SD 或 eMMC 状态目录**：当状态解析到 `mmcblk*` 挂载源时发出警告，因为 SD 或 eMMC 支持的随机 I/O 在会话和凭据写入下可能更慢且磨损更快。
- **会话目录缺失**：`sessions/` 和会话存储目录是持久化历史记录和避免 `ENOENT` 崩溃所必需的。
- **转录不匹配**：当最近的会话条目缺少转录文件时发出警告。
- **主会话 "1 行 JSONL"**：当主转录只有一行时标记（历史未累积）。
- **多个状态目录**：当多个 `~/.openclaw` 文件夹存在于主目录中或 `OPENCLAW_STATE_DIR` 指向其他地方时发出警告（历史可能在安装之间拆分）。
- **远程模式提醒**：如果 `gateway.mode=remote`，doctor 提醒您在远程主机上运行它（状态存在于那里）。
- **配置文件权限**：如果 `~/.openclaw/openclaw.json` 对组/世界可读，发出警告并提供收紧到 `600`。

### 5) 模型身份验证健康（OAuth 过期）

Doctor 检查身份验证存储中的 OAuth 配置文件，当令牌即将过期/已过期时发出警告，并在安全时刷新它们。如果 Anthropic OAuth/令牌配置文件过时，它会建议 Anthropic API 密钥或 Anthropic 设置令牌路径。
刷新提示仅在交互式运行时（TTY）出现；`--non-interactive` 跳过刷新尝试。

当 OAuth 刷新永久失败时（例如 `refresh_token_reused`、`invalid_grant` 或提供商要求您重新登录），doctor 报告需要重新身份验证并打印要运行的确切 `openclaw models auth login --provider ...` 命令。

Doctor 还报告由于以下原因暂时不可用的身份验证配置文件：

- 短期冷却（速率限制/超时/身份验证失败）
- 更长时间的禁用（计费/信用失败）

### 6) Hooks 模型验证

如果设置了 `hooks.gmail.model`，doctor 会根据目录和允许列表验证模型引用，并在它无法解析或被禁止时发出警告。

### 7) 沙箱镜像修复

当启用沙箱时，doctor 检查 Docker 镜像并在当前镜像缺失时提供构建或切换到旧版名称。

### 7b) 捆绑插件运行时依赖项

Doctor 验证捆绑插件运行时依赖项（例如 Discord 插件运行时包）是否存在于 OpenClaw 安装根目录中。如果有任何缺失，doctor 会报告包并在 `openclaw doctor --fix` / `openclaw doctor --repair` 模式下安装它们。

### 8) 网关服务迁移和清理提示

Doctor 检测旧版网关服务（launchd/systemd/schtasks）并提供删除它们并使用当前网关端口安装 OpenClaw 服务。它还可以扫描额外的类似网关的服务并打印清理提示。配置文件命名的 OpenClaw 网关服务被视为一等公民，不会被标记为"额外"。

### 8b) 启动 Matrix 迁移

当 Matrix 通道账户有待处理或可操作的旧版状态迁移时，doctor（在 `--fix` / `--repair` 模式下）创建迁移前快照，然后运行尽力而为的迁移步骤：旧版 Matrix 状态迁移和旧版加密状态准备。两个步骤都是非致命的；错误会被记录，启动继续。在只读模式（`openclaw doctor` 不带 `--fix`）中，此检查完全跳过。

### 8c) 设备配对和身份验证漂移

Doctor 现在将设备配对状态作为正常健康检查的一部分进行检查。

它报告：

- 待处理的首次配对请求
- 已配对设备的待处理角色升级
- 已配对设备的待处理范围升级
- 设备 ID 仍然匹配但设备身份不再匹配已批准记录的公钥不匹配修复
- 缺少已批准角色的活动令牌的配对记录
- 其范围漂移超出已批准配对基线的配对令牌
- 当前机器的本地缓存设备令牌条目，这些条目早于网关端令牌轮换或携带过时的范围元数据

Doctor 不会自动批准配对请求或自动轮换设备令牌。它会打印确切的后续步骤：

- 使用 `openclaw devices list` 检查待处理请求
- 使用 `openclaw devices approve <requestId>` 批准确切请求
- 使用 `openclaw devices rotate --device <deviceId> --role <role>` 轮换新令牌
- 使用 `openclaw devices remove <deviceId>` 删除并重新批准过时记录

这关闭了常见的"已配对但仍然需要配对"的漏洞：doctor 现在区分首次配对、待处理的角色/范围升级以及过时的令牌/设备身份漂移。

### 9) 安全警告

当提供商对 DM 开放而无允许列表，或策略配置为危险方式时，doctor 会发出警告。

### 10) systemd linger（Linux）

如果作为 systemd 用户服务运行，doctor 确保启用了 linger，以便网关在注销后保持活动状态。

### 11) 工作区状态（技能、插件和旧版目录）

Doctor 打印默认代理的工作区状态摘要：

- **技能状态**：计算合格、缺少要求和允许列表阻塞的技能。
- **旧版工作区目录**：当 `~/openclaw` 或其他旧版工作区目录与当前工作区一起存在时发出警告。
- **插件状态**：计算已加载/已禁用/已错误的插件；列出任何错误的插件 ID；报告捆绑插件功能。
- **插件兼容性警告**：标记与当前运行时存在兼容性问题的插件。
- **插件诊断**：显示插件注册表发出的任何加载时警告或错误。

### 11b) 引导文件大小

Doctor 检查工作区引导文件（例如 `AGENTS.md`、`CLAUDE.md` 或其他注入的上下文文件）是否接近或超过配置的字符预算。它报告每个文件的原始 vs 注入字符计数、截断百分比、截断原因（`max/file` 或 `max/total`），以及总注入字符占总预算的比例。当文件被截断或接近限制时，doctor 会打印调优 `agents.defaults.bootstrapMaxChars` 和 `agents.defaults.bootstrapTotalMaxChars` 的提示。

### 11c) Shell 补全

Doctor 检查当前 shell（zsh、bash、fish 或 PowerShell）是否安装了制表符补全：

- 如果 shell 配置文件使用缓慢的动态补全模式（`source <(openclaw completion ...)`），doctor 会将其升级为更快的缓存文件变体。
- 如果配置文件中配置了补全但缓存文件缺失，doctor 会自动重新生成缓存。
- 如果根本没有配置补全，doctor 会提示安装它（仅交互模式；使用 `--non-interactive` 跳过）。

运行 `openclaw completion --write-state` 手动重新生成缓存。

### 12) 网关身份验证检查（本地令牌）

Doctor 检查本地网关令牌身份验证就绪状态。

- 如果令牌模式需要令牌且无令牌源存在，doctor 会提供生成一个。
- 如果 `gateway.auth.token` 由 SecretRef 管理但不可用，doctor 会警告并不会用明文覆盖它。
- `openclaw doctor --generate-gateway-token` 仅在无令牌 SecretRef 配置时强制生成。

### 12b) 只读 SecretRef 感知修复

一些修复流程需要检查配置的凭据，而不削弱运行时快速失败行为。

- `openclaw doctor --fix` 现在对目标配置修复使用与状态系列命令相同的只读 SecretRef 摘要模型。
- 示例：Telegram `allowFrom` / `groupAllowFrom` `@username` 修复尝试在可用时使用配置的机器人凭据。
- 如果 Telegram 机器人令牌通过 SecretRef 配置但在当前命令路径中不可用，doctor 会报告该凭据已配置但不可用，并跳过自动解析，而不是崩溃或错误报告令牌缺失。

### 13) 网关健康检查 + 重启

Doctor 运行健康检查，并在网关看起来不健康时提供重启它。

### 13b) 内存搜索就绪

Doctor 检查配置的内存搜索嵌入提供商是否为默认代理就绪。行为取决于配置的后端和提供商：

- **QMD 后端**：探测 `qmd` 二进制文件是否可用且可启动。如果不可用，打印修复指导，包括 npm 包和手动二进制路径选项。
- **显式本地提供商**：检查本地模型文件或识别的远程/可下载模型 URL。如果缺失，建议切换到远程提供商。
- **显式远程提供商**（`openai`、`voyage` 等）：验证环境或身份验证存储中是否存在 API 密钥。如果缺失，打印可操作的修复提示。
- **自动提供商**：首先检查本地模型可用性，然后按自动选择顺序尝试每个远程提供商。

当网关探测结果可用时（检查时网关健康），doctor 会将其结果与 CLI 可见配置交叉引用，并注意任何差异。

使用 `openclaw memory status --deep` 在运行时验证嵌入就绪状态。

### 14) 通道状态警告

如果网关健康，doctor 会运行通道状态探测并报告警告和建议的修复。

### 15) 监督程序配置审计 + 修复

Doctor 检查已安装的监督程序配置（launchd/systemd/schtasks）是否缺少或过时的默认值（例如，systemd network-online 依赖项和重启延迟）。当发现不匹配时，它会建议更新并可以将服务文件/任务重写为当前默认值。

注意：

- `openclaw doctor` 在重写监督程序配置前提示。
- `openclaw doctor --yes` 接受默认修复提示。
- `openclaw doctor --repair` 应用推荐的修复而不提示。
- `openclaw doctor --repair --force` 覆盖自定义监督程序配置。
- 如果令牌身份验证需要令牌且 `gateway.auth.token` 由 SecretRef 管理，doctor 服务安装/修复会验证 SecretRef 但不会将解析的明文令牌值持久化到监督程序服务环境元数据中。
- 如果令牌身份验证需要令牌且配置的令牌 SecretRef 未解析，doctor 会阻止安装/修复路径并提供可操作的指导。
- 如果同时配置了 `gateway.auth.token` 和 `gateway.auth.password` 且未设置 `gateway.auth.mode`，doctor 会阻止安装/修复，直到明确设置模式。
- 对于 Linux 用户 systemd 单元，doctor 令牌漂移检查现在在比较服务身份验证元数据时包括 `Environment=` 和 `EnvironmentFile=` 源。
- 您始终可以通过 `openclaw gateway install --force` 强制完全重写。

### 16) 网关运行时 + 端口诊断

Doctor 检查服务运行时（PID、最后退出状态），并在服务已安装但实际未运行时发出警告。它还检查网关端口（默认 `18789`）上的端口冲突，并报告可能的原因（网关已运行、SSH 隧道）。

### 17) 网关运行时最佳实践

当网关服务在 Bun 或版本管理的 Node 路径（`nvm`、`fnm`、`volta`、`asdf` 等）上运行时，doctor 会发出警告。WhatsApp + Telegram 通道需要 Node，并且版本管理器路径在升级后可能会中断，因为服务不会加载您的 shell 初始化。当系统 Node 安装可用时（Homebrew/apt/choco），doctor 会提供迁移到系统 Node 安装。

### 18) 配置写入 + 向导元数据

Doctor 持久化任何配置更改并标记向导元数据以记录 doctor 运行。

### 19) 工作区提示（备份 + 内存系统）

当缺少工作区内存系统时，doctor 会建议一个，并在工作区尚未在 git 下时打印备份提示。

有关工作区结构和 git 备份的完整指南，请参阅 [/concepts/agent-workspace](/concepts/agent-workspace)（推荐私人 GitHub 或 GitLab）。
