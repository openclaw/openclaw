---
summary: "CLI 入门流程、认证/模型设置、输出和内部机制的完整参考"
read_when:
  - 你需要 openclaw onboard 的详细行为说明
  - 你正在调试入门结果或集成入门客户端
title: "CLI 入门参考"
sidebarTitle: "CLI 参考"
---

# CLI 入门参考

本页是 `openclaw onboard` 的完整参考。
简短指南请参阅 [入门向导 (CLI)](/start/wizard)。

## 向导功能

本地模式（默认）会引导你完成：

- 模型和认证设置（OpenAI Code 订阅 OAuth、Anthropic API 密钥或 setup token，以及 MiniMax、GLM、Moonshot 和 AI Gateway 选项）
- 工作空间位置和引导文件
- Gateway 设置（端口、绑定、认证、tailscale）
- 渠道和服务商（Telegram、WhatsApp、Discord、Google Chat、Mattermost 插件、Signal）
- 守护进程安装（LaunchAgent 或 systemd 用户单元）
- 健康检查
- Skills 配置

远程模式配置本机连接到其他位置的 gateway。
它不会在远程主机上安装或修改任何内容。

## 本地流程详情

<Steps>
  <Step title="现有配置检测">
    - 如果 `~/.openclaw/openclaw.json` 存在，选择保留、修改或重置。
    - 重新运行向导不会清除任何内容，除非你明确选择重置（或传入 `--reset`）。
    - 如果配置无效或包含遗留键，向导会停止并要求你运行 `openclaw doctor` 后再继续。
    - 重置使用 `trash` 并提供范围选项：
      - 仅配置
      - 配置 + 凭证 + 会话
      - 完全重置（也删除工作空间）
  </Step>
  <Step title="模型和认证">
    - 完整选项矩阵见 [认证和模型选项](#认证和模型选项)。
  </Step>
  <Step title="工作空间">
    - 默认 `~/.openclaw/workspace`（可配置）。
    - 创建首次运行引导仪式所需的工作空间文件。
    - 工作空间布局：[Agent 工作空间](/concepts/agent-workspace)。
  </Step>
  <Step title="Gateway">
    - 提示输入端口、绑定、认证模式和 tailscale 暴露。
    - 建议：即使对于 loopback 也保持 token 认证启用，以便本地 WS 客户端必须认证。
    - 仅在完全信任每个本地进程时禁用认证。
    - 非 loopback 绑定仍需要认证。
  </Step>
  <Step title="渠道">
    - [WhatsApp](/channels/whatsapp)：可选 QR 登录
    - [Telegram](/channels/telegram)：bot token
    - [Discord](/channels/discord)：bot token
    - [Google Chat](/channels/googlechat)：服务账号 JSON + webhook audience
    - [Mattermost](/channels/mattermost) 插件：bot token + base URL
    - [Signal](/channels/signal)：可选 `signal-cli` 安装 + 账号配置
    - [BlueBubbles](/channels/bluebubbles)：推荐用于 iMessage；服务器 URL + 密码 + webhook
    - [iMessage](/channels/imessage)：旧版 `imsg` CLI 路径 + 数据库访问
    - DM 安全：默认为配对模式。首次 DM 发送验证码；通过 `openclaw pairing approve <channel> <code>` 批准或使用白名单。
  </Step>
  <Step title="守护进程安装">
    - macOS：LaunchAgent
      - 需要用户登录会话；对于无头服务器，使用自定义 LaunchDaemon（未附带）。
    - Linux 和 Windows（通过 WSL2）：systemd 用户单元
      - 向导尝试 `loginctl enable-linger <user>` 以便注销后 gateway 保持运行。
      - 可能需要 sudo（写入 `/var/lib/systemd/linger`）；会先尝试不使用 sudo。
    - 运行时选择：Node（推荐；WhatsApp 和 Telegram 必需）。不推荐 Bun。
  </Step>
  <Step title="健康检查">
    - 启动 gateway（如需要）并运行 `openclaw health`。
    - `openclaw status --deep` 在状态输出中添加 gateway 健康探测。
  </Step>
  <Step title="Skills">
    - 读取可用 skills 并检查依赖。
    - 让你选择 node 管理器：npm 或 pnpm（不推荐 bun）。
    - 安装可选依赖（部分在 macOS 上使用 Homebrew）。
  </Step>
  <Step title="完成">
    - 摘要和后续步骤，包括 iOS、Android 和 macOS 应用选项。
  </Step>
</Steps>

<Note>
如果未检测到 GUI，向导会打印用于 Control UI 的 SSH 端口转发指令，而不是打开浏览器。
如果 Control UI 资源缺失，向导会尝试构建它们；备用方案是 `pnpm ui:build`（自动安装 UI 依赖）。
</Note>

## 远程模式详情

远程模式配置本机连接到其他位置的 gateway。

<Info>
远程模式不会在远程主机上安装或修改任何内容。
</Info>

设置的内容：

- 远程 gateway URL（`ws://...`）
- Token（如果远程 gateway 需要认证，推荐）

<Note>
- 如果 gateway 仅限 loopback，使用 SSH 隧道或 tailnet。
- 发现提示：
  - macOS：Bonjour（`dns-sd`）
  - Linux：Avahi（`avahi-browse`）
</Note>

## 认证和模型选项

<AccordionGroup>
  <Accordion title="Anthropic API 密钥（推荐）">
    使用 `ANTHROPIC_API_KEY`（如存在）或提示输入密钥，然后保存供守护进程使用。
  </Accordion>
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS：检查 Keychain 项 "Claude Code-credentials"
    - Linux 和 Windows：重用 `~/.claude/.credentials.json`（如存在）

    在 macOS 上，选择"始终允许"以便 launchd 启动不会阻塞。

  </Accordion>
  <Accordion title="Anthropic token (setup-token 粘贴)">
    在任何机器上运行 `claude setup-token`，然后粘贴 token。
    可以命名；留空使用默认值。
  </Accordion>
  <Accordion title="OpenAI Code 订阅 (Codex CLI 重用)">
    如果 `~/.codex/auth.json` 存在，向导可以重用它。
  </Accordion>
  <Accordion title="OpenAI Code 订阅 (OAuth)">
    浏览器流程；粘贴 `code#state`。

    当模型未设置或为 `openai/*` 时，设置 `agents.defaults.model` 为 `openai-codex/gpt-5.3-codex`。

  </Accordion>
  <Accordion title="OpenAI API 密钥">
    使用 `OPENAI_API_KEY`（如存在）或提示输入密钥，然后保存到
    `~/.openclaw/.env` 以便 launchd 可以读取。

    当模型未设置、为 `openai/*` 或 `openai-codex/*` 时，设置 `agents.defaults.model` 为 `openai/gpt-5.1-codex`。

  </Accordion>
  <Accordion title="xAI (Grok) API 密钥">
    提示输入 `XAI_API_KEY` 并配置 xAI 作为模型服务商。
  </Accordion>
  <Accordion title="OpenCode Zen">
    提示输入 `OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`）。
    配置 URL：[opencode.ai/auth](https://opencode.ai/auth)。
  </Accordion>
  <Accordion title="API 密钥（通用）">
    为你保存密钥。
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    提示输入 `AI_GATEWAY_API_KEY`。
    更多详情：[Vercel AI Gateway](/providers/vercel-ai-gateway)。
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    提示输入账户 ID、网关 ID 和 `CLOUDFLARE_AI_GATEWAY_API_KEY`。
    更多详情：[Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)。
  </Accordion>
  <Accordion title="MiniMax M2.1">
    配置自动写入。
    更多详情：[MiniMax](/providers/minimax)。
  </Accordion>
  <Accordion title="Synthetic (Anthropic 兼容)">
    提示输入 `SYNTHETIC_API_KEY`。
    更多详情：[Synthetic](/providers/synthetic)。
  </Accordion>
  <Accordion title="Moonshot 和 Kimi Coding">
    Moonshot (Kimi K2) 和 Kimi Coding 配置自动写入。
    更多详情：[Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)。
  </Accordion>
  <Accordion title="跳过">
    保持认证未配置。
  </Accordion>
</AccordionGroup>

模型行为：

- 从检测到的选项中选择默认模型，或手动输入服务商和模型。
- 向导运行模型检查，如果配置的模型未知或缺少认证会发出警告。

凭证和配置文件路径：

- OAuth 凭证：`~/.openclaw/credentials/oauth.json`
- 认证配置文件（API 密钥 + OAuth）：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

<Note>
无头服务器提示：在有浏览器的机器上完成 OAuth，然后将
`~/.openclaw/credentials/oauth.json`（或 `$OPENCLAW_STATE_DIR/credentials/oauth.json`）
复制到 gateway 主机。
</Note>

## 输出和内部机制

`~/.openclaw/openclaw.json` 中的典型字段：

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers`（如果选择了 Minimax）
- `gateway.*`（mode、bind、auth、tailscale）
- `channels.telegram.botToken`、`channels.discord.token`、`channels.signal.*`、`channels.imessage.*`
- 渠道白名单（Slack、Discord、Matrix、Microsoft Teams），在提示时选择加入（名称尽可能解析为 ID）
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 写入 `agents.list[]` 和可选的 `bindings`。

WhatsApp 凭证存放在 `~/.openclaw/credentials/whatsapp/<accountId>/`。
会话存储在 `~/.openclaw/agents/<agentId>/sessions/`。

<Note>
部分渠道作为插件提供。入门时选择后，向导会提示安装插件（npm 或本地路径），然后再进行渠道配置。
</Note>

Gateway 向导 RPC：

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

客户端（macOS 应用和 Control UI）可以渲染步骤而无需重新实现入门逻辑。

Signal 配置行为：

- 下载相应的发布资源
- 存储在 `~/.openclaw/tools/signal-cli/<version>/`
- 在配置中写入 `channels.signal.cliPath`
- JVM 构建需要 Java 21
- 可用时使用原生构建
- Windows 使用 WSL2，在 WSL 内遵循 Linux signal-cli 流程

## 相关文档

- 入门中心：[入门向导 (CLI)](/start/wizard)
- 自动化和脚本：[CLI 自动化](/start/wizard-cli-automation)
- 命令参考：[`openclaw onboard`](/cli/onboard)
