---
summary: "CLI 设置流程、认证/模型设置、输出和内部工作的完整参考"
read_when:
  - 您需要 `openclaw onboard` 的详细行为
  - 您正在调试入职结果或集成入职客户端
title: "CLI 设置参考"
sidebarTitle: "CLI 参考"
---

# CLI 设置参考

此页面是 `openclaw onboard` 的完整参考。
有关简短指南，请参阅 [入职（CLI）](/start/wizard)。

## 向导的功能

本地模式（默认）引导您完成：

- 模型和认证设置（OpenAI Code 订阅 OAuth、Anthropic Claude CLI 或 API 密钥，以及 MiniMax、GLM、Ollama、Moonshot、StepFun 和 AI Gateway 选项）
- 工作区位置和引导文件
- 网关设置（端口、绑定、认证、tailscale）
- 频道和提供者（Telegram、WhatsApp、Discord、Google Chat、Mattermost、Signal、BlueBubbles 和其他捆绑的频道插件）
- 守护进程安装（LaunchAgent、systemd 用户单元，或带有启动文件夹回退的原生 Windows 计划任务）
- 健康检查
- 技能设置

远程模式配置此机器连接到其他地方的网关。
它不会在远程主机上安装或修改任何内容。

## 本地流程详情

<Steps>
  <Step title="现有配置检测">
    - 如果 `~/.openclaw/openclaw.json` 存在，选择保留、修改或重置。
    - 重新运行向导不会擦除任何内容，除非您明确选择重置（或传递 `--reset`）。
    - CLI `--reset` 默认值为 `config+creds+sessions`；使用 `--reset-scope full` 也会删除工作区。
    - 如果配置无效或包含旧密钥，向导会停止并要求您在继续之前运行 `openclaw doctor`。
    - 重置使用 `trash` 并提供范围：
      - 仅配置
      - 配置 + 凭证 + 会话
      - 完全重置（也会删除工作区）
  </Step>
  <Step title="模型和认证">
    - 完整选项矩阵在 [认证和模型选项](#auth-and-model-options) 中。
  </Step>
  <Step title="工作区">
    - 默认 `~/.openclaw/workspace`（可配置）。
    - 为首次运行引导仪式植入所需的工作区文件。
    - 工作区布局：[代理工作区](/concepts/agent-workspace)。
  </Step>
  <Step title="网关">
    - 提示输入端口、绑定、认证模式和 tailscale 暴露。
    - 推荐：即使对于环回也保持令牌认证启用，以便本地 WS 客户端必须进行身份验证。
    - 在令牌模式下，交互式设置提供：
      - **生成/存储明文令牌**（默认）
      - **使用 SecretRef**（可选）
    - 在密码模式下，交互式设置也支持明文或 SecretRef 存储。
    - 非交互式令牌 SecretRef 路径：`--gateway-token-ref-env <ENV_VAR>`。
      - 要求在入职流程环境中存在非空环境变量。
      - 不能与 `--gateway-token` 组合使用。
    - 仅当您完全信任每个本地进程时才禁用认证。
    - 非环回绑定仍需要认证。
  </Step>
  <Step title="频道">
    - [WhatsApp](/channels/whatsapp)：可选 QR 登录
    - [Telegram](/channels/telegram)：机器人令牌
    - [Discord](/channels/discord)：机器人令牌
    - [Google Chat](/channels/googlechat)：服务账号 JSON + webhook 受众
    - [Mattermost](/channels/mattermost)：机器人令牌 + 基础 URL
    - [Signal](/channels/signal)：可选 `signal-cli` 安装 + 账号配置
    - [BlueBubbles](/channels/bluebubbles)：iMessage 推荐；服务器 URL + 密码 + webhook
    - [iMessage](/channels/imessage)：传统 `imsg` CLI 路径 + DB 访问
    - DM 安全：默认为配对。第一条 DM 发送代码；通过 `openclaw pairing approve <channel> <code>` 批准或使用允许列表。
  </Step>
  <Step title="守护进程安装">
    - macOS：LaunchAgent
      - 需要登录用户会话；对于无头系统，使用自定义 LaunchDaemon（未随附）。
    - Linux 和 Windows via WSL2：systemd 用户单元
      - 向导尝试 `loginctl enable-linger <user>` 以便网关在注销后保持运行。
      - 可能会提示输入 sudo（写入 `/var/lib/systemd/linger`）；它会先尝试不使用 sudo。
    - 原生 Windows：首选计划任务
      - 如果任务创建被拒绝，OpenClaw 会回退到每用户启动文件夹登录项并立即启动网关。
      - 计划任务仍然是首选，因为它们提供更好的监督状态。
    - 运行时选择：Node（推荐；WhatsApp 和 Telegram 必需）。不推荐使用 Bun。
  </Step>
  <Step title="健康检查">
    - 启动网关（如果需要）并运行 `openclaw health`。
    - `openclaw status --deep` 将实时网关健康探测添加到状态输出，包括支持时的频道探测。
  </Step>
  <Step title="技能">
    - 读取可用技能并检查要求。
    - 让您选择节点管理器：npm、pnpm 或 bun。
    - 安装可选依赖项（有些在 macOS 上使用 Homebrew）。
  </Step>
  <Step title="完成">
    - 摘要和后续步骤，包括 iOS、Android 和 macOS 应用选项。
  </Step>
</Steps>

<Note>
如果未检测到 GUI，向导会打印 Control UI 的 SSH 端口转发说明，而不是打开浏览器。
如果缺少 Control UI 资产，向导会尝试构建它们；回退是 `pnpm ui:build`（自动安装 UI 依赖项）。
</Note>

## 远程模式详情

远程模式配置此机器连接到其他地方的网关。

<Info>
远程模式不会在远程主机上安装或修改任何内容。
</Info>

您设置的内容：

- 远程网关 URL（`ws://...`）
- 如果需要远程网关认证（推荐），则提供令牌

<Note>
- 如果网关仅环回，使用 SSH 隧道或 tailnet。
- 发现提示：
  - macOS：Bonjour（`dns-sd`）
  - Linux：Avahi（`avahi-browse`）
</Note>

## 认证和模型选项

<AccordionGroup>
  <Accordion title="Anthropic API 密钥">
    如果存在 `ANTHROPIC_API_KEY` 或提示输入密钥，然后保存以供守护进程使用。
  </Accordion>
  <Accordion title="OpenAI Code 订阅（Codex CLI 重用）">
    如果 `~/.codex/auth.json` 存在，向导可以重用它。
    重用的 Codex CLI 凭证由 Codex CLI 管理；过期时 OpenClaw
    首先重新读取该源，当提供者可以刷新它时，将刷新的凭证写回 Codex 存储，而不是自己接管所有权。
  </Accordion>
  <Accordion title="OpenAI Code 订阅（OAuth）">
    浏览器流程；粘贴 `code#state`。

    当模型未设置或为 `openai/*` 时，将 `agents.defaults.model` 设置为 `openai-codex/gpt-5.4`。

  </Accordion>
  <Accordion title="OpenAI API 密钥">
    如果存在 `OPENAI_API_KEY` 或提示输入密钥，然后将凭证存储在认证配置文件中。

    当模型未设置、为 `openai/*` 或 `openai-codex/*` 时，将 `agents.defaults.model` 设置为 `openai/gpt-5.4`。

  </Accordion>
  <Accordion title="xAI（Grok）API 密钥">
    提示输入 `XAI_API_KEY` 并将 xAI 配置为模型提供者。
  </Accordion>
  <Accordion title="OpenCode">
    提示输入 `OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`）并让您选择 Zen 或 Go 目录。
    设置 URL：[opencode.ai/auth](https://opencode.ai/auth)。
  </Accordion>
  <Accordion title="API 密钥（通用）">
    为您存储密钥。
  </Accordion>
  <Accordion title="Vercel AI Gateway">
    提示输入 `AI_GATEWAY_API_KEY`。
    更多详情：[Vercel AI Gateway](/providers/vercel-ai-gateway)。
  </Accordion>
  <Accordion title="Cloudflare AI Gateway">
    提示输入账号 ID、网关 ID 和 `CLOUDFLARE_AI_GATEWAY_API_KEY`。
    更多详情：[Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)。
  </Accordion>
  <Accordion title="MiniMax">
    配置自动写入。托管默认为 `MiniMax-M2.7`；API 密钥设置使用 `minimax/...`，OAuth 设置使用 `minimax-portal/...`。
    更多详情：[MiniMax](/providers/minimax)。
  </Accordion>
  <Accordion title="StepFun">
    配置自动写入 StepFun 标准或中国或全球端点的 Step Plan。
    标准目前包括 `step-3.5-flash`，Step Plan 还包括 `step-3.5-flash-2603`。
    更多详情：[StepFun](/providers/stepfun)。
  </Accordion>
  <Accordion title="Synthetic（兼容 Anthropic）">
    提示输入 `SYNTHETIC_API_KEY`。
    更多详情：[Synthetic](/providers/synthetic)。
  </Accordion>
  <Accordion title="Ollama（云和本地开放模型）">
    首先提示选择 `Cloud + Local`、`Cloud only` 或 `Local only`。
    `Cloud only` 使用 `OLLAMA_API_KEY` 与 `https://ollama.com`。
    主机支持模式提示输入基础 URL（默认 `http://127.0.0.1:11434`），发现可用模型并建议默认值。
    `Cloud + Local` 还检查该 Ollama 主机是否已登录以进行云访问。
    更多详情：[Ollama](/providers/ollama)。
  </Accordion>
  <Accordion title="Moonshot 和 Kimi Coding">
    Moonshot（Kimi K2）和 Kimi Coding 配置自动写入。
    更多详情：[Moonshot AI（Kimi + Kimi Coding）](/providers/moonshot)。
  </Accordion>
  <Accordion title="自定义提供者">
    适用于兼容 OpenAI 和兼容 Anthropic 的端点。

    交互式入职支持与其他提供者 API 密钥流程相同的 API 密钥存储选择：
    - **现在粘贴 API 密钥**（明文）
    - **使用密钥引用**（环境引用或配置的提供者引用，带有预检验证）

    非交互式标志：
    - `--auth-choice custom-api-key`
    - `--custom-base-url`
    - `--custom-model-id`
    - `--custom-api-key`（可选；回退到 `CUSTOM_API_KEY`）
    - `--custom-provider-id`（可选）
    - `--custom-compatibility <openai|anthropic>`（可选；默认 `openai`）

  </Accordion>
  <Accordion title="跳过">
    保持认证未配置。
  </Accordion>
</AccordionGroup>

模型行为：

- 从检测到的选项中选择默认模型，或手动输入提供者和模型。
- 当入职从提供者认证选择开始时，模型选择器自动优先选择该提供者。对于 Volcengine 和 BytePlus，相同的偏好也匹配其编码计划变体（`volcengine-plan/*`、`byteplus-plan/*`）。
- 如果该首选提供者过滤器为空，选择器会回退到完整目录，而不是不显示模型。
- 向导运行模型检查并在配置的模型未知或缺少认证时发出警告。

凭证和配置文件路径：

- 认证配置文件（API 密钥 + OAuth）：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`
- 传统 OAuth 导入：`~/.openclaw/credentials/oauth.json`

凭证存储模式：

- 默认入职行为将 API 密钥作为明文值存储在认证配置文件中。
- `--secret-input-mode ref` 启用引用模式而不是明文密钥存储。
  在交互式设置中，您可以选择：
  - 环境变量引用（例如 `keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" }`）
  - 配置的提供者引用（`file` 或 `exec`）与提供者别名 + id
- 交互式引用模式在保存前运行快速预检验证。
  - 环境引用：验证当前入职环境中的变量名 + 非空值。
  - 提供者引用：验证提供者配置并解析请求的 id。
  - 如果预检失败，入职会显示错误并让您重试。
- 在非交互式模式下，`--secret-input-mode ref` 仅支持环境。
  - 在入职流程环境中设置提供者环境变量。
  - 内联密钥标志（例如 `--openai-api-key`）要求设置该环境变量；否则入职会快速失败。
  - 对于自定义提供者，非交互式 `ref` 模式将 `models.providers.<id>.apiKey` 存储为 `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`。
  - 在该自定义提供者情况下，`--custom-api-key` 要求设置 `CUSTOM_API_KEY`；否则入职会快速失败。
- 网关认证凭证在交互式设置中支持明文和 SecretRef 选择：
  - 令牌模式：**生成/存储明文令牌**（默认）或 **使用 SecretRef**。
  - 密码模式：明文或 SecretRef。
- 非交互式令牌 SecretRef 路径：`--gateway-token-ref-env <ENV_VAR>`。
- 现有的明文设置继续正常工作。

<Note>
无头和服务器提示：在有浏览器的机器上完成 OAuth，然后复制该代理的 `auth-profiles.json`（例如 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`，或匹配的 `$OPENCLAW_STATE_DIR/...` 路径）到网关主机。`credentials/oauth.json` 只是传统导入源。
</Note>

## 输出和内部

`~/.openclaw/openclaw.json` 中的典型字段：

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers`（如果选择了 Minimax）
- `tools.profile`（本地入职在未设置时默认为 `"coding"`；现有的显式值被保留）
- `gateway.*`（模式、绑定、认证、tailscale）
- `session.dmScope`（本地入职在未设置时默认为 `per-channel-peer`；现有的显式值被保留）
- `channels.telegram.botToken`、`channels.discord.token`、`channels.matrix.*`、`channels.signal.*`、`channels.imessage.*`
- 当您在提示期间选择加入时的频道允许列表（Slack、Discord、Matrix、Microsoft Teams）（名称在可能时解析为 ID）
- `skills.install.nodeManager`
  - `setup --node-manager` 标志接受 `npm`、`pnpm` 或 `bun`。
  - 手动配置以后仍然可以设置 `skills.install.nodeManager: "yarn"`。
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 写入 `agents.list[]` 和可选的 `bindings`。

WhatsApp 凭证位于 `~/.openclaw/credentials/whatsapp/<accountId>/` 下。
会话存储在 `~/.openclaw/agents/<agentId>/sessions/` 下。

<Note>
一些频道作为插件提供。当在设置期间选择时，向导会提示在频道配置之前安装插件（npm 或本地路径）。
</Note>

网关向导 RPC：

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

客户端（macOS 应用和 Control UI）可以渲染步骤而无需重新实现入职逻辑。

Signal 设置行为：

- 下载适当的发布资产
- 将其存储在 `~/.openclaw/tools/signal-cli/<version>/` 下
- 在配置中写入 `channels.signal.cliPath`
- JVM 构建需要 Java 21
- 尽可能使用原生构建
- Windows 使用 WSL2 并在 WSL 内遵循 Linux signal-cli 流程

## 相关文档

- 入职中心：[入职（CLI）](/start/wizard)
- 自动化和脚本：[CLI 自动化](/start/wizard-cli-automation)
- 命令参考：[`openclaw onboard`](/cli/onboard)
