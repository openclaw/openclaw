---
read_when:
  - 你需要了解 `openclaw onboard` 的详细行为
  - 你正在调试新手引导结果或集成新手引导客户端
sidebarTitle: CLI reference
summary: CLI 设置流程、身份验证/模型设置、输出和内部机制的完整参考
title: CLI 设置参考
x-i18n:
  generated_at: "2026-03-16T06:28:34Z"
  model: gpt-5.4
  provider: openai
  source_hash: 6b9460013b6a0fbd59f639ade6b255c8d7f7412238495e78b942859ade695e86
  source_path: start/wizard-cli-reference.md
  workflow: 15
---

# CLI 设置参考

本页是 `openclaw onboard` 的完整参考。
简短指南请参见 [设置向导（CLI）](/start/wizard)。

## 向导会执行什么

本地模式（默认）会引导你完成以下内容：

- 模型和身份验证设置（OpenAI Code 订阅 OAuth、Anthropic API 密钥或 setup token，以及 MiniMax、GLM、Ollama、Moonshot 和 AI Gateway 选项）
- 工作区位置和 bootstrap 文件
- Gateway 网关设置（端口、绑定、身份验证、tailscale）
- 渠道和提供商（Telegram、WhatsApp、Discord、Google Chat、Mattermost 插件、Signal）
- 守护进程安装（LaunchAgent 或 systemd 用户单元）
- 健康检查
- Skills 设置

远程模式会将此机器配置为连接到其他位置的网关。
它不会在远程主机上安装或修改任何内容。

## 本地流程详情

<Steps>
  <Step title="现有配置检测">
    - 如果 `~/.openclaw/openclaw.json` 存在，可选择 Keep、Modify 或 Reset。
    - 重新运行向导不会清除任何内容，除非你明确选择 Reset（或传递 `--reset`）。
    - CLI `--reset` 默认作用于 `config+creds+sessions`；使用 `--reset-scope full` 还会删除工作区。
    - 如果配置无效或包含旧版键，向导会停止，并要求你先运行 `openclaw doctor` 再继续。
    - Reset 使用 `trash`，并提供以下范围：
      - 仅配置
      - 配置 + 凭证 + 会话
      - 完全重置（也会删除工作区）
  </Step>
  <Step title="模型和身份验证">
    - 完整选项矩阵见 [身份验证和模型选项](#auth-and-model-options)。
  </Step>
  <Step title="工作区">
    - 默认值为 `~/.openclaw/workspace`（可配置）。
    - 会植入首次运行 bootstrap 仪式所需的工作区文件。
    - 工作区布局：[智能体工作区](/concepts/agent-workspace)。
  </Step>
  <Step title="Gateway 网关">
    - 会提示你输入端口、绑定、身份验证模式和 tailscale 暴露设置。
    - 建议：即使仅用于 loopback，也保持启用令牌身份验证，这样本地 WS 客户端也必须进行身份验证。
    - 在令牌模式下，交互式设置提供：
      - **生成/存储明文令牌**（默认）
      - **使用 SecretRef**（可选）
    - 在密码模式下，交互式设置也支持明文或 SecretRef 存储。
    - 非交互式令牌 SecretRef 路径：`--gateway-token-ref-env <ENV_VAR>`。
      - 要求在新手引导进程环境中存在一个非空环境变量。
      - 不能与 `--gateway-token` 组合使用。
    - 仅当你完全信任每个本地进程时才禁用身份验证。
    - 非 loopback 绑定仍然需要身份验证。
  </Step>
  <Step title="渠道">
    - [WhatsApp](/channels/whatsapp)：可选 QR 登录
    - [Telegram](/channels/telegram)：bot 令牌
    - [Discord](/channels/discord)：bot 令牌
    - [Google Chat](/channels/googlechat)：服务账号 JSON + webhook audience
    - [Mattermost](/channels/mattermost) 插件：bot 令牌 + 基础 URL
    - [Signal](/channels/signal)：可选 `signal-cli` 安装 + 账户配置
    - [BlueBubbles](/channels/bluebubbles)：推荐用于 iMessage；服务器 URL + 密码 + webhook
    - [iMessage](/channels/imessage)：旧版 `imsg` CLI 路径 + 数据库访问
    - 私信安全：默认是配对。首次私信会发送一个代码；通过
      `openclaw pairing approve <channel> <code>` 批准，或使用 allowlist。
  </Step>
  <Step title="守护进程安装">
    - macOS：LaunchAgent
      - 需要已登录的用户会话；对于无头环境，请使用自定义 LaunchDaemon（未随附）。
    - Linux 和通过 WSL2 的 Windows：systemd 用户单元
      - 向导会尝试执行 `loginctl enable-linger <user>`，使网关在注销后仍保持运行。
      - 可能会提示输入 sudo（写入 `/var/lib/systemd/linger`）；会先尝试不使用 sudo。
    - 运行时选择：Node（推荐；WhatsApp 和 Telegram 必需）。不建议使用 Bun。
  </Step>
  <Step title="健康检查">
    - 启动 Gateway 网关（如有需要），并运行 `openclaw health`。
    - `openclaw status --deep` 会在状态输出中添加 Gateway 网关健康探测。
  </Step>
  <Step title="Skills">
    - 读取可用的 Skills 并检查要求。
    - 让你选择 node 管理器：npm 或 pnpm（不建议使用 bun）。
    - 安装可选依赖（部分依赖在 macOS 上使用 Homebrew）。
  </Step>
  <Step title="完成">
    - 显示摘要和后续步骤，包括 iOS、Android 和 macOS 应用选项。
  </Step>
</Steps>

<Note>
如果未检测到 GUI，向导会打印用于控制 UI 的 SSH 端口转发说明，而不是打开浏览器。
如果缺少控制 UI 资源，向导会尝试构建它们；回退命令为 `pnpm ui:build`（首次运行会自动安装 UI 依赖）。
</Note>

## 远程模式详情

远程模式会将此机器配置为连接到其他位置的网关。

<Info>
远程模式不会在远程主机上安装或修改任何内容。
</Info>

你需要设置的内容：

- 远程 Gateway 网关 URL（`ws://...`）
- 如果远程 Gateway 网关需要身份验证，则设置令牌（推荐）

<Note>
- 如果网关仅绑定到 loopback，请使用 SSH 隧道或 tailnet。
- 发现提示：
  - macOS：Bonjour（`dns-sd`）
  - Linux：Avahi（`avahi-browse`）
</Note>

## 身份验证和模型选项

<AccordionGroup>
  <Accordion title="Anthropic API 密钥">
    如果存在 `ANTHROPIC_API_KEY` 则使用它，否则提示输入密钥，然后保存以供守护进程使用。
  </Accordion>
  <Accordion title="Anthropic OAuth（Claude Code CLI）">
    - macOS：检查 Keychain 条目 “Claude Code-credentials”
    - Linux 和 Windows：如果存在，则复用 `~/.claude/.credentials.json`

    在 macOS 上，请选择 “Always Allow”，以免 launchd 启动被阻塞。

  </Accordion>
  <Accordion title="Anthropic token（粘贴 setup token）">
    在任意机器上运行 `claude setup-token`，然后粘贴该令牌。
    你可以为其命名；留空则使用默认值。
  </Accordion>
  <Accordion title="OpenAI Code 订阅（复用 Codex CLI）">
    如果存在 `~/.codex/auth.json`，向导可以复用它。
  </Accordion>
  <Accordion title="OpenAI Code 订阅（OAuth）">
    浏览器流程；粘贴 `code#state`。

    当模型未设置或为 `openai/*` 时，将 `agents.defaults.model` 设置为 `openai-codex/gpt-5.4`。

  </Accordion>
  <Accordion title="OpenAI API 密钥">
    如果存在 `OPENAI_API_KEY` 则使用它，否则提示输入密钥，然后将该凭证存储在 auth profile 中。

    当模型未设置、为 `openai/*` 或 `openai-codex/*` 时，将 `agents.defaults.model` 设置为 `openai/gpt-5.1-codex`。

  </Accordion>
  <Accordion title="xAI（Grok）API 密钥">
    提示输入 `XAI_API_KEY`，并将 xAI 配置为模型提供商。
  </Accordion>
  <Accordion title="OpenCode">
    提示输入 `OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`），并让你选择 Zen 或 Go 目录。
    设置 URL：[opencode.ai/auth](https://opencode.ai/auth)。
  </Accordion>
  <Accordion title="API 密钥（通用）">
    会为你存储该密钥。
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    提示输入 `AI_GATEWAY_API_KEY`。
    更多详情：[Vercel AI Gateway](/providers/vercel-ai-gateway)。
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    提示输入账户 ID、Gateway ID 和 `CLOUDFLARE_AI_GATEWAY_API_KEY`。
    更多详情：[Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)。
  </Accordion>
  <Accordion title="MiniMax M2.5">
    配置会自动写入。
    更多详情：[MiniMax](/providers/minimax)。
  </Accordion>
  <Accordion title="Synthetic（兼容 Anthropic）">
    提示输入 `SYNTHETIC_API_KEY`。
    更多详情：[Synthetic](/providers/synthetic)。
  </Accordion>
  <Accordion title="Ollama（Cloud 和本地开放模型）">
    提示输入基础 URL（默认 `http://127.0.0.1:11434`），然后提供 Cloud + Local 或 Local 模式。
    会发现可用模型并建议默认值。
    更多详情：[Ollama](/providers/ollama)。
  </Accordion>
  <Accordion title="Moonshot 和 Kimi Coding">
    Moonshot（Kimi K2）和 Kimi Coding 配置会自动写入。
    更多详情：[Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)。
  </Accordion>
  <Accordion title="自定义提供商">
    适用于兼容 OpenAI 和兼容 Anthropic 的端点。

    交互式新手引导支持与其他提供商 API 密钥流程相同的 API 密钥存储选项：
    - **现在粘贴 API 密钥**（明文）
    - **使用密钥引用**（环境变量引用或已配置提供商引用，并带有预检验证）

    非交互式标志：
    - `--auth-choice custom-api-key`
    - `--custom-base-url`
    - `--custom-model-id`
    - `--custom-api-key`（可选；回退到 `CUSTOM_API_KEY`）
    - `--custom-provider-id`（可选）
    - `--custom-compatibility <openai|anthropic>`（可选；默认 `openai`）

  </Accordion>
  <Accordion title="跳过">
    保持身份验证未配置。
  </Accordion>
</AccordionGroup>

模型行为：

- 从检测到的选项中选择默认模型，或手动输入提供商和模型。
- 向导会执行模型检查，并在配置的模型未知或缺少身份验证时发出警告。

凭证和配置档案路径：

- OAuth 凭证：`~/.openclaw/credentials/oauth.json`
- Auth profile（API 密钥 + OAuth）：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

凭证存储模式：

- 默认新手引导行为会将 API 密钥作为明文值持久化到 auth profile 中。
- `--secret-input-mode ref` 会启用引用模式，而不是明文密钥存储。
  在交互式设置中，你可以选择：
  - 环境变量引用（例如 `keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" }`）
  - 已配置提供商引用（`file` 或 `exec`），带提供商别名 + id
- 交互式引用模式会在保存前运行快速预检验证。
  - 环境变量引用：验证变量名 + 当前新手引导环境中的非空值。
  - 提供商引用：验证提供商配置并解析所请求的 id。
  - 如果预检失败，新手引导会显示错误并让你重试。
- 在非交互式模式下，`--secret-input-mode ref` 仅支持由环境变量支持的引用。
  - 在新手引导进程环境中设置提供商环境变量。
  - 内联密钥标志（例如 `--openai-api-key`）要求设置该环境变量；否则新手引导会快速失败。
  - 对于自定义提供商，非交互式 `ref` 模式会将 `models.providers.<id>.apiKey` 存储为 `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`。
  - 在这种自定义提供商场景下，`--custom-api-key` 要求设置 `CUSTOM_API_KEY`；否则新手引导会快速失败。
- Gateway 网关身份验证凭证在交互式设置中支持明文和 SecretRef 选项：
  - 令牌模式：**生成/存储明文令牌**（默认）或 **使用 SecretRef**。
  - 密码模式：明文或 SecretRef。
- 非交互式令牌 SecretRef 路径：`--gateway-token-ref-env <ENV_VAR>`。
- 现有的明文设置会继续保持不变并正常工作。

<Note>
无头和服务器提示：在有浏览器的机器上完成 OAuth，然后复制
`~/.openclaw/credentials/oauth.json`（或 `$OPENCLAW_STATE_DIR/credentials/oauth.json`）
到 Gateway 网关主机。
</Note>

## 输出和内部机制

`~/.openclaw/openclaw.json` 中的典型字段：

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers`（如果选择了 Minimax）
- `tools.profile`（本地新手引导在未设置时默认设为 `"coding"`；现有显式值会保留）
- `gateway.*`（模式、绑定、身份验证、tailscale）
- `session.dmScope`（本地新手引导在未设置时默认设为 `per-channel-peer`；现有显式值会保留）
- `channels.telegram.botToken`、`channels.discord.token`、`channels.signal.*`、`channels.imessage.*`
- 当你在提示中选择加入时的渠道 allowlist（Slack、Discord、Matrix、Microsoft Teams）（如果可能，名称会解析为 ID）
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 会写入 `agents.list[]` 和可选的 `bindings`。

WhatsApp 凭证位于 `~/.openclaw/credentials/whatsapp/<accountId>/`。
会话存储在 `~/.openclaw/agents/<agentId>/sessions/` 下。

<Note>
某些渠道以插件形式交付。在设置期间选择这些渠道时，向导
会先提示安装插件（npm 或本地路径），然后再进行渠道配置。
</Note>

Gateway 网关向导 RPC：

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

客户端（macOS 应用和控制 UI）可以在不重新实现新手引导逻辑的情况下渲染步骤。

Signal 设置行为：

- 下载适当的发布资源
- 将其存储在 `~/.openclaw/tools/signal-cli/<version>/`
- 在配置中写入 `channels.signal.cliPath`
- JVM 构建需要 Java 21
- 在可用时使用原生构建
- Windows 使用 WSL2，并在 WSL 内遵循 Linux 的 signal-cli 流程

## 相关文档

- 新手引导中心：[设置向导（CLI）](/start/wizard)
- 自动化和脚本：[CLI 自动化](/start/wizard-cli-automation)
- 命令参考：[`openclaw onboard`](/cli/onboard)
