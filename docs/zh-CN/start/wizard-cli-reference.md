---
summary: "CLI 入门流程、认证/模型设置、输出和内部机制的完整参考"
read_when:
  - 你需要了解 openclaw onboard 的详细行为
  - 你正在调试入门结果或集成入门客户端
title: "CLI 入门参考"
sidebarTitle: "CLI 参考"
---

# CLI 入门参考

本页是 `openclaw onboard` 的完整参考。
简短指南请参见 [入门向导 (CLI)](/start/wizard)。

## 向导的功能

本地模式（默认）会引导你完成：

- 模型和认证设置（OpenAI Code 订阅 OAuth、Anthropic API 密钥或设置令牌，以及 MiniMax、GLM、Moonshot 和 AI Gateway 选项）
- 工作区位置和引导文件
- Gateway 设置（端口、绑定、认证、tailscale）
- 频道和提供商（Telegram、WhatsApp、Discord、Google Chat、Mattermost 插件、Signal）
- 守护进程安装（LaunchAgent 或 systemd 用户单元）
- 健康检查
- 技能设置

远程模式将本机配置为连接到其他地方的 gateway。
它不会在远程主机上安装或修改任何内容。

## 本地流程详情

<Steps>
  <Step title="现有配置检测">
    - 如果 `~/.openclaw/openclaw.json` 存在，选择保留、修改或重置。
    - 重新运行向导不会清除任何内容，除非你明确选择重置（或传递 `--reset`）。
    - CLI `--reset` 默认为 `config+creds+sessions`；使用 `--reset-scope full` 还可以删除工作区。
    - 如果配置无效或包含遗留密钥，向导会停止并要求你在继续之前运行 `openclaw doctor`。
    - 重置使用 `trash` 并提供范围：
      - 仅配置
      - 配置 + 凭证 + 会话
      - 完全重置（还会删除工作区）
  </Step>
  <Step title="模型和认证">
    - 完整选项矩阵见 [认证和模型选项](#认证和模型选项)。
  </Step>
  <Step title="工作区">
    - 默认 `~/.openclaw/workspace`（可配置）。
    - 为首次运行引导仪式创建工作区文件。
    - 工作区布局：[代理工作区](/concepts/agent-workspace)。
  </Step>
  <Step title="Gateway">
    - 提示输入端口、绑定、认证模式和 tailscale 暴露。
    - 建议：即使对于 loopback 也保持令牌认证启用，以便本地 WS 客户端必须认证。
    - 只有你完全信任每个本地进程时才禁用认证。
    - 非 loopback 绑定仍然需要认证。
  </Step>
  <Step title="频道">
    - [WhatsApp](/channels/whatsapp)：可选 QR 登录
    - [Telegram](/channels/telegram)：机器人令牌
    - [Discord](/channels/discord)：机器人令牌
    - [Google Chat](/channels/googlechat)：服务账号 JSON + webhook 受众
    - [Mattermost](/channels/mattermost) 插件：机器人令牌 + base URL
    - [Signal](/channels/signal)：可选 `signal-cli` 安装 + 账号配置
    - [BlueBubbles](/channels/bluebubbles)：推荐用于 iMessage；服务器 URL + 密码 + webhook
    - [iMessage](/channels/imessage)：遗留 `imsg` CLI 路径 + 数据库访问
    - DM 安全：默认是配对。第一条 DM 发送一个代码；通过 `openclaw pairing approve <channel> <code>` 批准或使用允许列表。
  </Step>
  <Step title="守护进程安装">
    - macOS：LaunchAgent
      - 需要登录用户会话；对于无头环境，使用自定义 LaunchDaemon（未提供）。
    - Linux 和 Windows via WSL2：systemd 用户单元
      - 向导尝试 `loginctl enable-linger <user>` 以便 gateway 在注销后保持运行。
      - 可能会提示输入 sudo（写入 `/var/lib/systemd/linger`）；它会先尝试不使用 sudo。
    - 运行时选择：Node（推荐；WhatsApp 和 Telegram 需要）。不推荐 Bun。
  </Step>
  <Step title="健康检查">
    - 启动 gateway（如果需要）并运行 `openclaw health`。
    - `openclaw status --deep` 将 gateway 健康探测添加到状态输出。
  </Step>
  <Step title="技能">
    - 读取可用技能并检查要求。
    - 让你选择节点管理器：npm 或 pnpm（不推荐 bun）。
    - 安装可选依赖（某些在 macOS 上使用 Homebrew）。
  </Step>
  <Step title="完成">
    - 摘要和后续步骤，包括 iOS、Android 和 macOS 应用选项。
  </Step>
</Steps>

<Note>
如果未检测到 GUI，向导会打印 Control UI 的 SSH 端口转发说明，而不是打开浏览器。
如果 Control UI 资源缺失，向导会尝试构建它们；回退是 `pnpm ui:build`（自动安装 UI 依赖）。
</Note>

## 远程模式详情

远程模式将本机配置为连接到其他地方的 gateway。

<Info>
远程模式不会在远程主机上安装或修改任何内容。
</Info>

你设置的内容：

- 远程 gateway URL (`ws://...`)
- 如果远程 gateway 需要认证，设置令牌（推荐）

<Note>
- 如果 gateway 仅支持 loopback，请使用 SSH 隧道或 tailnet。
- 发现提示：
  - macOS：Bonjour (`dns-sd`)
  - Linux：Avahi (`avahi-browse`)
</Note>

## 认证和模型选项

<AccordionGroup>
  <Accordion title="Anthropic API 密钥">
    如果存在则使用 `ANTHROPIC_API_KEY`，否则提示输入密钥，然后保存以供守护进程使用。
  </Accordion>
  
  <Accordion title="Anthropic OAuth (Claude Code CLI)">
    - macOS：检查 Keychain 项目 "Claude Code-credentials"
    - Linux 和 Windows：如果存在则重用 `~/.claude/.credentials.json`

    在 macOS 上，选择 "Always Allow" 以便 launchd 启动不会阻塞。

  </Accordion>
  
  <Accordion title="Anthropic 令牌（setup-token 粘贴）">
    在任何机器上运行 `claude setup-token`，然后粘贴令牌。
    你可以命名它；留空使用默认值。
  </Accordion>
  
  <Accordion title="OpenAI Code 订阅（Codex CLI 重用）">
    如果 `~/.codex/auth.json` 存在，向导可以重用它。
  </Accordion>
  
  <Accordion title="OpenAI Code 订阅（OAuth）">
    浏览器流程；粘贴 `code#state`。

    当模型未设置或为 `openai/*` 时，将 `agents.defaults.model` 设置为 `openai-codex/gpt-5.3-codex`。

  </Accordion>
  
  <Accordion title="OpenAI API 密钥">
    如果存在则使用 `OPENAI_API_KEY`，否则提示输入密钥，然后将凭证存储在 auth profiles 中。

    当模型未设置、`openai/*` 或 `openai-codex/*` 时，将 `agents.defaults.model` 设置为 `openai/gpt-5.1-codex`。

  </Accordion>
  
  <Accordion title="xAI (Grok) API 密钥">
    提示输入 `XAI_API_KEY` 并将 xAI 配置为模型提供商。
  </Accordion>
  
  <Accordion title="OpenCode Zen">
    提示输入 `OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`）。
    设置 URL：[opencode.ai/auth](https://opencode.ai/auth)。
  </Accordion>
  
  <Accordion title="API 密钥（通用）">
    为你存储密钥。
  </Accordion>
  
  <Accordion title="Vercel AI Gateway">
    提示输入 `AI_GATEWAY_API_KEY`。
    更多详情：[Vercel AI Gateway](/providers/vercel-ai-gateway)。
  </Accordion>
  
  <Accordion title="Cloudflare AI Gateway">
    提示输入账号 ID、gateway ID 和 `CLOUDFLARE_AI_GATEWAY_API_KEY`。
    更多详情：[Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)。
  </Accordion>
  
  <Accordion title="MiniMax M2.5">
    配置自动写入。
    更多详情：[MiniMax](/providers/minimax)。
  </Accordion>
  
  <Accordion title="Synthetic (Anthropic-compatible)">
    提示输入 `SYNTHETIC_API_KEY`。
    更多详情：[Synthetic](/providers/synthetic)。
  </Accordion>
  
  <Accordion title="Moonshot 和 Kimi Coding">
    Moonshot (Kimi K2) 和 Kimi Coding 配置自动写入。
    更多详情：[Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)。
  </Accordion>
  
  <Accordion title="自定义提供商">
    适用于 OpenAI 兼容和 Anthropic 兼容的端点。

    交互式入门支持与提供商 API 密钥流程相同的 API 密钥存储选择：
    - **立即粘贴 API 密钥**（明文）
    - **使用密钥引用**（环境变量引用或配置的 provider 引用，带预检验证）

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

- 从检测到的选项中选择默认模型，或手动输入提供商和模型。
- 向导运行模型检查，如果配置的模型未知或缺少认证，会发出警告。

凭证和配置文件路径：

- OAuth 凭证：`~/.openclaw/credentials/oauth.json`
- Auth profiles（API 密钥 + OAuth）：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

API 密钥存储模式：

- 默认入门行为是将 API 密钥作为明文值持久化在 auth profiles 中。
- `--secret-input-mode ref` 启用引用模式而不是明文密钥存储。
  在交互式入门中，你可以选择：
  - 环境变量引用（例如 `keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" }`）
  - 配置的 provider 引用（`file` 或 `exec`）带提供商别名 + id
- 交互式引用模式在保存前运行快速预检验证。
  - 环境变量引用：在当前入门环境中验证变量名 + 非空值。
  - Provider 引用：验证提供商配置并解析请求的 id。
  - 如果预检失败，入门会显示错误并让你重试。
- 在非交互式模式下，`--secret-input-mode ref` 仅支持环境变量。
  - 在入门进程环境中设置提供商环境变量。
  - 内联密钥标志（例如 `--openai-api-key`）要求设置该环境变量；否则入门会快速失败。
  - 对于自定义提供商，非交互式 `ref` 模式将 `models.providers.<id>.apiKey` 存储为 `{ source: "env", provider: "default", id: "CUSTOM_API_KEY" }`。
  - 在该自定义提供商情况下，`--custom-api-key` 要求设置 `CUSTOM_API_KEY`；否则入门会快速失败。
- 现有的明文设置继续不变工作。

<Note>
无头环境和服务器提示：在带浏览器的机器上完成 OAuth，然后复制
`~/.openclaw/credentials/oauth.json`（或 `$OPENCLAW_STATE_DIR/credentials/oauth.json`）
到 gateway 主机。
</Note>

## 输出和内部机制

`~/.openclaw/openclaw.json` 中的典型字段：

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers`（如果选择了 Minimax）
- `tools.profile`（本地入门在未设置时默认为 `"messaging"`；保留现有的显式值）
- `gateway.*`（模式、绑定、认证、tailscale）
- `session.dmScope`（本地入门在未设置时默认为 `per-channel-peer`；保留现有的显式值）
- `channels.telegram.botToken`、`channels.discord.token`、`channels.signal.*`、`channels.imessage.*`
- 频道允许列表（Slack、Discord、Matrix、Microsoft Teams）当你在提示期间选择加入时（尽可能将名称解析为 ID）
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 写入 `agents.list[]` 和可选的 `bindings`。

WhatsApp 凭证存储在 `~/.openclaw/credentials/whatsapp/<accountId>/` 下。
会话存储在 `~/.openclaw/agents/<agentId>/sessions/` 下。

<Note>
某些频道作为插件提供。在入门期间选择时，向导
会在频道配置前提示安装插件（npm 或本地路径）。
</Note>

Gateway 向导 RPC：

- `wizard.start`
- `wizard.next`
- `wizard.cancel`
- `wizard.status`

客户端（macOS 应用和 Control UI）可以渲染步骤而无需重新实现入门逻辑。

Signal 设置行为：

- 下载适当的发布资源
- 存储在 `~/.openclaw/tools/signal-cli/<version>/` 下
- 在配置中写入 `channels.signal.cliPath`
- JVM 构建需要 Java 21
- 原生构建在可用时使用
- Windows 使用 WSL2 并在 WSL 内部遵循 Linux signal-cli 流程

## 相关文档

- 入门中心：[入门向导 (CLI)](/start/wizard)
- 自动化和脚本：[CLI 自动化](/start/wizard-cli-automation)
- 命令参考：[`openclaw onboard`](/cli/onboard)
