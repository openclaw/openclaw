---
read_when:
  - 运行或配置新手引导向导
  - 设置新机器
summary: CLI 新手引导向导：Gateway网关、工作区、渠道和 Skills 的引导式设置
title: 新手引导向导
x-i18n:
  generated_at: "2026-02-01T13:49:20Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 571302dcf63a0c700cab6b54964e524d75d98315d3b35fafe7232d2ce8199e83
  source_path: start/wizard.md
  workflow: 9
---

# 新手引导向导 (CLI)

新手引导向导是 **推荐的** 在 macOS、Linux 或 Windows（通过 WSL2；强烈推荐）上设置 OpenClaw 的方式。它通过一个引导式流程配置本地 Gateway网关或远程 Gateway网关连接，以及渠道、Skills 和工作区默认设置。

主要入口：

```bash
openclaw onboard
```

最快的首次对话方式：打开 Control UI（无需设置渠道）。运行
`openclaw dashboard` 然后在浏览器中对话。文档： [仪表盘](/web/dashboard)。

后续重新配置：

```bash
openclaw configure
```

推荐：设置 Brave Search API 密钥，以便智能体可以使用 `web_search`
（`web_fetch` 无需密钥也可使用）。最简单的方式： `openclaw configure --section web`
它会将 `tools.web.search.apiKey`存储。文档： [网页工具](/tools/web)。

## 快速入门与高级模式

向导以 **快速入门** （默认设置）与 **高级** （完全控制）模式开始。

**快速入门** 保留默认设置：

- 本地 Gateway网关（local loopback）
- 默认工作区（或现有工作区）
- Gateway网关端口 **18789**
- Gateway网关认证 **令牌** （自动生成，即使在 local loopback 上也是如此）
- Tailscale 暴露 **关闭**
- Telegram + WhatsApp 私信默认为 **允许名单** （系统会提示你输入手机号码）

**高级** 展示每个步骤（模式、工作区、Gateway网关、渠道、守护进程、Skills）。

## 向导的功能

**本地模式（默认）** 引导你完成：

- 模型/认证（OpenAI Code (Codex) 订阅 OAuth、Anthropic API 密钥（推荐）或 setup-token（粘贴），以及 MiniMax/GLM/Moonshot/AI Gateway 选项）
- 工作区位置 + 引导文件
- Gateway网关设置（端口/绑定/认证/Tailscale）
- 提供商（Telegram、WhatsApp、Discord、Google Chat、Mattermost（插件）、Signal）
- 守护进程安装（LaunchAgent / systemd 用户单元）
- 健康检查
- Skills（推荐）

**远程模式** 仅配置本地客户端以连接到其他位置的 Gateway网关。它 **不会** 在远程主机上安装或更改任何内容。

要添加更多隔离的智能体（独立的工作区 + 会话 + 认证），请使用：

```bash
openclaw agents add <name>
```

提示： `--json` 会 **不会** 意味着非交互模式。请使用 `--non-interactive` （以及 `--workspace`）用于脚本。

## 流程详情（本地）

1. **现有配置检测**
   - 如果 `~/.openclaw/openclaw.json` 存在，请选择 **保留 / 修改 / 重置**。
   - 重新运行向导 **不会** 不会删除任何内容，除非你明确选择 **重置**
     （或传入 `--reset`）。
   - 如果配置无效或包含遗留键，向导会停止并要求你运行 `openclaw doctor` 后再继续。
   - 重置使用 `trash` （绝不使用 `rm`）并提供作用域：
     - 仅配置
     - 配置 + 凭据 + 会话
     - 完全重置（同时移除工作区）

2. **模型/认证**
   - **Anthropic API 密钥（推荐）**：使用 `ANTHROPIC_API_KEY` （如果存在）或提示输入密钥，然后保存供守护进程使用。
   - **Anthropic OAuth (Claude Code CLI)**：在 macOS 上，向导会检查钥匙串项 "Claude Code-credentials"（请选择"始终允许"以避免 launchd 启动时被阻止）；在 Linux/Windows 上，它会复用 `~/.claude/.credentials.json` （如果存在）。
   - **Anthropic 令牌（粘贴 setup-token）**：运行 `claude setup-token` 在任意机器上执行，然后粘贴令牌（可以命名；留空 = 默认）。
   - **OpenAI Code (Codex) 订阅 (Codex CLI)**：如果 `~/.codex/auth.json` 存在，向导可以复用它。
   - **OpenAI Code (Codex) 订阅 (OAuth)**：浏览器流程；粘贴 `code#state`。
     - 设置 `agents.defaults.model` 为 `openai-codex/gpt-5.2` （当模型未设置或为 `openai/*`。
   - **OpenAI API 密钥**：使用 `OPENAI_API_KEY` （如果存在）或提示输入密钥，然后保存到 `~/.openclaw/.env` 以便 launchd 可以读取。
   - **OpenCode Zen（多模型代理）**：提示输入 `OPENCODE_API_KEY` （或 `OPENCODE_ZEN_API_KEY`，请在 https://opencode.ai/auth)。
   - **API 密钥**：为你存储密钥。
   - **Vercel AI Gateway（多模型代理）**：提示输入 `AI_GATEWAY_API_KEY`。
   - 更多详情： [Vercel AI Gateway](/providers/vercel-ai-gateway)
   - **MiniMax M2.1**：配置会自动写入。
   - 更多详情： [MiniMax](/providers/minimax)
   - **Synthetic（Anthropic 兼容）**：提示输入 `SYNTHETIC_API_KEY`。
   - 更多详情： [Synthetic](/providers/synthetic)
   - **Moonshot (Kimi K2)**：配置会自动写入。
   - **Kimi Coding**：配置会自动写入。
   - 更多详情： [Moonshot AI (Kimi + Kimi Coding)](/providers/moonshot)
   - **跳过**：暂不配置认证。
   - 从检测到的选项中选择默认模型（或手动输入提供商/模型）。
   - 向导会运行模型检查，如果配置的模型未知或缺少认证则发出警告。

- OAuth 凭据存储在 `~/.openclaw/credentials/oauth.json`；认证配置存储在 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json` （API 密钥 + OAuth）。
- 更多详情： [/concepts/oauth](/concepts/oauth)

3. **工作区**
   - 默认 `~/.openclaw/workspace` （可配置）。
   - 生成智能体引导启动仪式所需的工作区文件。
   - 完整工作区布局 + 备份指南： [智能体工作区](/concepts/agent-workspace)

4. **Gateway网关**
   - 端口、绑定、认证模式、网关仪表板暴露。
   - 认证建议：保持 **令牌** 即使在 local loopback 上也使用，以确保本地 WS 客户端必须进行认证。
   - 仅在你完全信任每个本地进程时才禁用认证。
   - 非 local loopback 绑定仍需认证。

5. **渠道**
   - [WhatsApp](/channels/whatsapp)：可选二维码登录。
   - [Telegram](/channels/telegram)：机器人令牌。
   - [Discord](/channels/discord)：机器人令牌。
   - [Google Chat](/channels/googlechat)：服务账户 JSON + webhook 受众。
   - [Mattermost](/channels/mattermost) （插件）：机器人令牌 + 基础 URL。
   - [Signal](/channels/signal)：可选 `signal-cli` 安装 + 账户配置。
   - [iMessage](/channels/imessage)：本地 `imsg` CLI 路径 + 数据库访问。
   - 私信安全：默认为配对模式。首次私信会发送一个验证码；通过 `openclaw pairing approve <channel> <code>` 批准，或使用允许名单。

6. **守护进程安装**
   - macOS：LaunchAgent
     - 需要已登录的用户会话；对于无头模式，请使用自定义 LaunchDaemon（未随附）。
   - Linux（以及通过 WSL2 的 Windows）：systemd 用户单元
     - 向导会尝试通过 `loginctl enable-linger <user>` 启用驻留，以便在注销后 Gateway网关保持运行。
     - 可能会提示输入 sudo（写入 `/var/lib/systemd/linger`）；它会先尝试不使用 sudo。
   - **运行时选择：** Node（推荐；WhatsApp/Telegram 需要）。Bun **不推荐**。

7. **健康检查**
   - 启动 Gateway网关（如需）并运行 `openclaw health`。
   - 提示： `openclaw status --deep` 将 Gateway网关健康探测添加到状态输出中（需要可达的 Gateway网关）。

8. **Skills（推荐）**
   - 读取可用 Skills 并检查依赖条件。
   - 让你选择一个 Node 管理器： **npm / pnpm** （不推荐 bun）。
   - 安装可选依赖项（部分在 macOS 上使用 Homebrew）。

9. **完成**
   - 摘要 + 后续步骤，包括 iOS/Android/macOS 应用以获取额外功能。

- 如果未检测到 GUI，向导会打印 Control UI 的 SSH 端口转发说明，而不是打开浏览器。
- 如果 Control UI 资源文件缺失，向导会尝试构建它们；后备方案是 `pnpm ui:build` （自动安装 UI 依赖项）。

## 远程模式

远程模式配置本地客户端以连接到其他位置的 Gateway网关。

你需要设置的内容：

- 远程 Gateway网关 URL（`ws://...`）
- 如果远程 Gateway网关需要认证，则需提供令牌（推荐）

注意事项：

- 不会执行远程安装或守护进程更改。
- 如果 Gateway网关仅绑定 local loopback，请使用 SSH 隧道或 tailnet。
- 发现提示：
  - macOS：Bonjour（`dns-sd`）
  - Linux：Avahi（`avahi-browse`）

## 添加另一个智能体

使用 `openclaw agents add <name>` 创建一个拥有独立工作区、会话和认证配置的单独智能体。不使用 `--workspace` 运行会启动向导。

它会设置：

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

注意事项：

- 默认工作区遵循 `~/.openclaw/workspace-<agentId>`。
- 添加 `bindings` 以路由入站消息（向导可以执行此操作）。
- 非交互标志： `--model`， `--agent-dir`， `--bind`， `--non-interactive`。

## 非交互模式

使用 `--non-interactive` 用于自动化或脚本化新手引导：

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

添加 `--json` 以获取机器可读的摘要。

Gemini 示例：

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice gemini-api-key \
  --gemini-api-key "$GEMINI_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback
```

Z.AI 示例：

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice zai-api-key \
  --zai-api-key "$ZAI_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback
```

Vercel AI Gateway 示例：

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice ai-gateway-api-key \
  --ai-gateway-api-key "$AI_GATEWAY_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback
```

Moonshot 示例：

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice moonshot-api-key \
  --moonshot-api-key "$MOONSHOT_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback
```

Synthetic 示例：

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice synthetic-api-key \
  --synthetic-api-key "$SYNTHETIC_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback
```

OpenCode Zen 示例：

```bash
openclaw onboard --non-interactive \
  --mode local \
  --auth-choice opencode-zen \
  --opencode-zen-api-key "$OPENCODE_API_KEY" \
  --gateway-port 18789 \
  --gateway-bind loopback
```

添加智能体（非交互）示例：

```bash
openclaw agents add work \
  --workspace ~/.openclaw/workspace-work \
  --model openai/gpt-5.2 \
  --bind whatsapp:biz \
  --non-interactive \
  --json
```

## Gateway网关向导 RPC

Gateway网关通过 RPC 暴露向导流程（`wizard.start`， `wizard.next`， `wizard.cancel`， `wizard.status`）。客户端（macOS 应用、Control UI）可以渲染步骤而无需重新实现新手引导逻辑。

## Signal 设置 (signal-cli)

向导可以安装 `signal-cli` （从 GitHub 发布版本）：

- 下载相应的发布资源。
- 将其存储在 `~/.openclaw/tools/signal-cli/<version>/`。
- 写入 `channels.signal.cliPath` 到你的配置中。

注意事项：

- JVM 构建需要 **Java 21**。
- 如有原生构建则优先使用。
- Windows 使用 WSL2；signal-cli 安装遵循 WSL 内的 Linux 流程。

## 向导写入的内容

中的典型字段 `~/.openclaw/openclaw.json`：

- `agents.defaults.workspace`
- `agents.defaults.model` / `models.providers` （如果选择了 Minimax）
- `gateway.*` （模式、绑定、认证、Tailscale）
- `channels.telegram.botToken`， `channels.discord.token`， `channels.signal.*`， `channels.imessage.*`
- 渠道允许名单（Slack/Discord/Matrix/Microsoft Teams），在提示期间选择启用时生效（名称会尽可能解析为 ID）。
- `skills.install.nodeManager`
- `wizard.lastRunAt`
- `wizard.lastRunVersion`
- `wizard.lastRunCommit`
- `wizard.lastRunCommand`
- `wizard.lastRunMode`

`openclaw agents add` 写入 `agents.list[]` 和可选的 `bindings`。

WhatsApp 凭据存储在 `~/.openclaw/credentials/whatsapp/<accountId>/`下。会话存储在 `~/.openclaw/agents/<agentId>/sessions/`。

部分渠道以插件形式提供。当你在新手引导期间选择某个渠道时，向导会提示先安装它（通过 npm 或本地路径），然后才能进行配置。

## 相关文档

- macOS 应用新手引导： [新手引导](/start/onboarding)
- 配置参考： [Gateway网关配置](/gateway/configuration)
- 提供商： [WhatsApp](/channels/whatsapp)， [Telegram](/channels/telegram)， [Discord](/channels/discord)， [Google Chat](/channels/googlechat)， [Signal](/channels/signal)， [iMessage](/channels/imessage)
- Skills： [Skills](/tools/skills)， [Skills配置](/tools/skills-config)
