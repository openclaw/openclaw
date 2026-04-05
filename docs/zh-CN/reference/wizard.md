---
read_when:
  - 查找特定的向导步骤或标志
  - 使用非交互模式自动执行新手引导
  - 调试向导行为
sidebarTitle: Wizard Reference
summary: CLI 设置向导的完整参考：每个步骤、标志和配置字段
title: 设置向导参考
x-i18n:
  generated_at: "2026-03-16T06:28:28Z"
  model: gpt-5.4
  provider: openai
  source_hash: f6560ef9921e58e4fe7f9b23872c0f8bbf3a0a3c4449d686752fc5b5b50bb216
  source_path: reference/wizard.md
  workflow: 15
---

# 设置向导参考

这是 `openclaw onboard` CLI 向导的完整参考。
有关高层概览，请参阅 [设置向导](/start/wizard)。

## 流程详情（本地模式）

<Steps>
  <Step title="现有配置检测">
    - 如果 `~/.openclaw/openclaw.json` 存在，请选择 **Keep / Modify / Reset**。
    - 重新运行向导**不会**清除任何内容，除非你明确选择 **Reset**
      （或传入 `--reset`）。
    - CLI `--reset` 默认值为 `config+creds+sessions`；使用 `--reset-scope full`
      可额外移除工作区。
    - 如果配置无效或包含旧版键，向导会停止，并要求
      你先运行 `openclaw doctor` 再继续。
    - 重置会使用 `trash`（绝不使用 `rm`），并提供以下范围：
      - 仅配置
      - 配置 + 凭证 + 会话
      - 完整重置（也会移除工作区）
  </Step>
  <Step title="模型/认证">
    - **Anthropic API key**：如果存在则使用 `ANTHROPIC_API_KEY`，否则提示输入 key，然后保存以供守护进程使用。
    - **Anthropic OAuth（Claude Code CLI）**：在 macOS 上，向导会检查钥匙串项目 “Claude Code-credentials”（请选择 “Always Allow”，这样 launchd 启动时就不会被阻塞）；在 Linux/Windows 上，如果存在，则会重用 `~/.claude/.credentials.json`。
    - **Anthropic token（粘贴 setup-token）**：在任意机器上运行 `claude setup-token`，然后粘贴该 token（你可以为其命名；留空 = default）。
    - **OpenAI Code (Codex) 订阅（Codex CLI）**：如果 `~/.codex/auth.json` 存在，向导可以重用它。
    - **OpenAI Code (Codex) 订阅（OAuth）**：浏览器流程；粘贴 `code#state`。
      - 当模型未设置或为 `openai/*` 时，将 `agents.defaults.model` 设置为 `openai-codex/gpt-5.4`。
    - **OpenAI API key**：如果存在则使用 `OPENAI_API_KEY`，否则提示输入 key，然后将其存储到凭证配置文件中。
    - **xAI（Grok）API key**：提示输入 `XAI_API_KEY`，并将 xAI 配置为模型提供商。
    - **OpenCode**：提示输入 `OPENCODE_API_KEY`（或 `OPENCODE_ZEN_API_KEY`，可从 https://opencode.ai/auth 获取），并让你选择 Zen 或 Go 目录。
    - **Ollama**：提示输入 Ollama base URL，提供 **Cloud + Local** 或 **Local** 模式，发现可用模型，并在需要时自动拉取所选本地模型。
    - 更多细节： [Ollama](/providers/ollama)
    - **API key**：为你存储该 key。
    - **Vercel AI Gateway（多模型代理）**：提示输入 `AI_GATEWAY_API_KEY`。
    - 更多细节： [Vercel AI Gateway](/providers/vercel-ai-gateway)
    - **Cloudflare AI Gateway**：提示输入 Account ID、Gateway ID 和 `CLOUDFLARE_AI_GATEWAY_API_KEY`。
    - 更多细节： [Cloudflare AI Gateway](/providers/cloudflare-ai-gateway)
    - **MiniMax M2.5**：自动写入配置。
    - 更多细节： [MiniMax](/providers/minimax)
    - **Synthetic（Anthropic 兼容）**：提示输入 `SYNTHETIC_API_KEY`。
    - 更多细节： [Synthetic](/providers/synthetic)
    - **Moonshot（Kimi K2）**：自动写入配置。
    - **Kimi Coding**：自动写入配置。
    - 更多细节： [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
    - **Skip**：暂不配置认证。
    - 从已检测到的选项中选择默认模型（或手动输入 `provider/model`）。为了获得最佳质量并降低 prompt injection 风险，请选择你在提供商栈中可用的最强最新一代模型。
    - 向导会运行模型检查，并在所配置模型未知或缺少认证时发出警告。
    - API key 存储模式默认为明文 auth-profile 值。使用 `--secret-input-mode ref` 可改为存储基于环境变量的引用（例如 `keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" }`）。
    - OAuth 凭证保存在 `~/.openclaw/credentials/oauth.json`；auth-profile 保存在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`（API key + OAuth）。
    - 更多细节： [/concepts/oauth](/concepts/oauth)
    <Note>
    无头/服务器提示：在有浏览器的机器上完成 OAuth，然后将
    `~/.openclaw/credentials/oauth.json`（或 `$OPENCLAW_STATE_DIR/credentials/oauth.json`）复制到
    Gateway 网关主机上。
    </Note>
  </Step>
  <Step title="工作区">
    - 默认为 `~/.openclaw/workspace`（可配置）。
    - 为工作区植入智能体引导仪式所需的文件。
    - 完整工作区布局 + 备份指南： [智能体工作区](/concepts/agent-workspace)
  </Step>
  <Step title="Gateway 网关">
    - Port、bind、auth mode、tailscale 暴露方式。
    - 认证建议：即使是 loopback，也保留 **Token**，这样本地 WS 客户端也必须进行认证。
    - 在 token 模式下，交互式设置提供：
      - **生成/存储明文 token**（默认）
      - **使用 SecretRef**（可选启用）
      - 快速开始会在新手引导探测/dashboard 引导期间，跨 `env`、`file` 和 `exec` 提供商重用现有的 `gateway.auth.token` SecretRef。
      - 如果该 SecretRef 已配置但无法解析，则新手引导会提前失败，并给出明确修复信息，而不是静默降级运行时认证。
    - 在 password 模式下，交互式设置也支持明文或 SecretRef 存储。
    - 非交互式 token SecretRef 路径：`--gateway-token-ref-env <ENV_VAR>`。
      - 要求新手引导进程环境中存在非空环境变量。
      - 不能与 `--gateway-token` 组合使用。
    - 仅当你完全信任每个本地进程时，才禁用认证。
    - 非 loopback 绑定仍然需要认证。
  </Step>
  <Step title="渠道">
    - [WhatsApp](/channels/whatsapp)：可选 QR 登录。
    - [Telegram](/channels/telegram)：bot token。
    - [Discord](/channels/discord)：bot token。
    - [Google Chat](/channels/googlechat)：服务账号 JSON + webhook audience。
    - [Mattermost](/channels/mattermost)（插件）：bot token + base URL。
    - [Signal](/channels/signal)：可选安装 `signal-cli` + 账号配置。
    - [BlueBubbles](/channels/bluebubbles)：**iMessage 推荐方案**；server URL + password + webhook。
    - [iMessage](/channels/imessage)：旧版 `imsg` CLI 路径 + 数据库访问。
    - 私信安全：默认为 pairing。首次私信会发送一个代码；通过 `openclaw pairing approve <channel> <code>` 批准，或使用允许列表。
  </Step>
  <Step title="Web 搜索">
    - 选择一个提供商：Perplexity、Brave、Gemini、Grok 或 Kimi（也可跳过）。
    - 粘贴你的 API key（QuickStart 会自动从环境变量或现有配置中检测 key）。
    - 使用 `--skip-search` 跳过。
    - 之后再配置：`openclaw configure --section web`。
  </Step>
  <Step title="守护进程安装">
    - macOS：LaunchAgent
      - 需要已登录的用户会话；无头场景请使用自定义 LaunchDaemon（未随产品提供）。
    - Linux（以及通过 WSL2 的 Windows）：systemd 用户单元
      - 向导会尝试启用 lingering：`loginctl enable-linger <user>`，以便 Gateway 网关在注销后仍保持运行。
      - 可能会提示输入 sudo（会写入 `/var/lib/systemd/linger`）；它会先尝试不使用 sudo。
    - **运行时选择：** Node（推荐；WhatsApp/Telegram 必需）。**不推荐** Bun。
    - 如果 token 认证需要 token，并且 `gateway.auth.token` 由 SecretRef 管理，则守护进程安装会验证它，但不会将解析出的明文 token 值持久化到 supervisor 服务环境元数据中。
    - 如果 token 认证需要 token，但配置的 token SecretRef 尚未解析，则会阻止守护进程安装，并给出可执行指导。
    - 如果同时配置了 `gateway.auth.token` 和 `gateway.auth.password`，且 `gateway.auth.mode` 未设置，则会阻止守护进程安装，直到显式设置 mode。
  </Step>
  <Step title="健康检查">
    - 启动 Gateway 网关（如果需要）并运行 `openclaw health`。
    - 提示：`openclaw status --deep` 会在状态输出中添加 Gateway 网关健康探测（需要能访问到 Gateway 网关）。
  </Step>
  <Step title="Skills（推荐）">
    - 读取可用的 Skills 并检查要求。
    - 让你选择一个 node manager：**npm / pnpm**（不推荐 bun）。
    - 安装可选依赖（某些在 macOS 上使用 Homebrew）。
  </Step>
  <Step title="完成">
    - 摘要 + 后续步骤，包括可提供额外功能的 iOS/Android/macOS 应用。
  </Step>
</Steps>

<Note>
如果未检测到 GUI，向导会打印用于访问 Control UI 的 SSH 端口转发说明，而不是打开浏览器。
如果缺少 Control UI 资源，向导会尝试构建它们；回退方式是 `pnpm ui:build`（会自动安装 UI 依赖）。
</Note>

## 非交互模式

使用 `--non-interactive` 自动化或脚本化新手引导：

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice apiKey \
  --anthropic-api-key "$ANTHROPIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback \
  --install-daemon \
  --daemon-runtime node \
  --skip-skills
```

添加 `--json` 可获得机器可读摘要。

在非交互模式中使用 Gateway token SecretRef：

```bash
export OPENCLAW_GATEWAY_TOKEN="your-token"
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice skip \
  --gateway-auth token \
  --gateway-token-ref-env OPENCLAW_GATEWAY_TOKEN
```

`--gateway-token` 和 `--gateway-token-ref-env` 互斥。

<Note>
`--json` **并不**意味着非交互模式。脚本中请使用 `--non-interactive`（以及 `--workspace`）。
</Note>

特定提供商的命令示例位于 [CLI Automation](/start/wizard-cli-automation#provider-specific-examples)。
本参考页用于说明标志语义和步骤顺序。

### 添加智能体（非交互）

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.4 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway 网关向导 RPC

Gateway 网关通过 RPC 暴露向导流程（`wizard.start`、`wizard.next`、`wizard.cancel`、`wizard.status`）。
客户端（macOS 应用、Control UI）可以渲染这些步骤，而无需重新实现新手引导逻辑。

## Signal 设置（signal-cli）

向导可以从 GitHub releases 安装 `signal-cli`：

- 下载适合的发布资源。
- 将其存储到 `~/.openclaw/tools/signal-cli/<version>/` 下。
- 将 `channels.signal.cliPath` 写入你的配置。

说明：

- JVM 构建需要 **Java 21**。
- 在可用时会使用原生构建。
- Windows 使用 WSL2；`signal-cli` 安装会在 WSL 中遵循 Linux 流程。

## 向导会写入的内容

`~/.openclaw/openclaw.json` 中的典型字段：

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers`（如果选择了 Minimax）
- `tools.profile`（本地新手引导在未设置时默认为 `"coding"`；已有的显式值会被保留）
- `gateway.*`（mode、bind、auth、tailscale）
- `session.dmScope`（行为细节： [CLI 设置参考](/start/wizard-cli-reference#outputs-and-internals)）
- `channels.telegram.botToken`、`channels.discord.token`、`channels.signal.*`、`channels.imessage.*`
- 当你在提示中选择启用时，渠道允许列表（Slack/Discord/Matrix/Microsoft Teams）（名称会在可能时解析为 ID）。
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 会写入 `agents.list[]` 和可选的 `bindings`。

WhatsApp 凭证位于 `~/.openclaw/credentials/whatsapp/<accountId>/` 下。
会话存储在 `~/.openclaw/agents/<agentId>/sessions/` 下。

某些渠道以插件形式提供。当你在设置期间选择其中一个时，向导
会提示先安装它（npm 或本地路径），然后才能配置。

## 相关文档

- 向导概览： [设置向导](/start/wizard)
- macOS 应用新手引导： [新手引导](/start/onboarding)
- 配置参考： [Gateway 配置](/gateway/configuration)
- 提供商： [WhatsApp](/channels/whatsapp)、[Telegram](/channels/telegram)、[Discord](/channels/discord)、[Google Chat](/channels/googlechat)、[Signal](/channels/signal)、[BlueBubbles](/channels/bluebubbles)（iMessage）、[iMessage](/channels/imessage)（旧版）
- Skills： [Skills](/tools/skills)、[Skills 配置](/tools/skills-config)
