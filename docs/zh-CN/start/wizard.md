---
read_when:
  - 运行或配置设置向导
  - 设置一台新机器
sidebarTitle: "Onboarding: CLI"
summary: CLI 设置向导：用于 Gateway 网关、工作区、渠道和 Skills 的引导式设置
title: 设置向导（CLI）
x-i18n:
  generated_at: "2026-03-16T06:28:38Z"
  model: gpt-5.4
  provider: openai
  source_hash: 99fd87dddd78798eb0087ad9433e5a32de2af110b6e65ee351b1a194a11c7df3
  source_path: start/wizard.md
  workflow: 15
---

# 设置向导（CLI）

设置向导是在 macOS、
Linux 或 Windows（通过 WSL2；强烈推荐）上设置 OpenClaw 的**推荐**方式。
它可在一次引导式流程中配置本地 Gateway 网关或远程 Gateway 网关连接，以及渠道、Skills
和工作区默认值。

```bash
openclaw onboard
```

<Info>
最快的首次聊天方式：打开 Control UI（无需设置渠道）。运行
`openclaw dashboard` 并在浏览器中聊天。文档：[Dashboard](/web/dashboard)。
</Info>

若要稍后重新配置：

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` 并不意味着非交互模式。对于脚本，请使用 `--non-interactive`。
</Note>

<Tip>
设置向导包含一个 web search 步骤，你可以选择一个提供商
（Perplexity、Brave、Gemini、Grok 或 Kimi），并粘贴你的 API 密钥，以便智能体
可以使用 `web_search`。你也可以稍后通过
`openclaw configure --section web` 进行配置。文档：[Web 工具](/tools/web)。
</Tip>

## 快速开始与高级模式

向导开始时会让你选择**快速开始**（默认值）或**高级模式**（完全控制）。

<Tabs>
  <Tab title="快速开始（默认值）">
    - 本地网关（loopback）
    - 默认工作区（或现有工作区）
    - Gateway 网关端口 **18789**
    - Gateway 网关认证 **Token**（即使在 loopback 上也会自动生成）
    - 新本地设置的默认工具策略：`tools.profile: "coding"`（会保留现有显式配置文件）
    - 私信隔离默认值：本地新手引导会在未设置时写入 `session.dmScope: "per-channel-peer"`。详情见：[CLI 设置参考](/start/wizard-cli-reference#outputs-and-internals)
    - Tailscale 暴露 **关闭**
    - Telegram + WhatsApp 私信默认使用 **allowlist**（系统会提示你输入电话号码）
  </Tab>
  <Tab title="高级模式（完全控制）">
    - 暴露每一个步骤（模式、工作区、Gateway 网关、渠道、守护进程、Skills）。
  </Tab>
</Tabs>

## 向导会配置什么

**本地模式（默认）**会引导你完成以下步骤：

1. **模型/认证** —— 选择任意受支持的提供商/认证流程（API 密钥、OAuth 或 setup-token），包括自定义提供商
   （兼容 OpenAI、兼容 Anthropic，或未知自动检测）。选择一个默认模型。
   安全说明：如果这个智能体将运行工具或处理 webhook/hooks 内容，请优先选择当前可用的最强最新一代模型，并保持严格的工具策略。较弱/较旧的层级更容易被 prompt 注入。
   对于非交互式运行，`--secret-input-mode ref` 会在认证配置文件中存储基于环境变量的引用，而不是明文 API 密钥值。
   在非交互式 `ref` 模式下，必须设置提供商环境变量；如果传入内联密钥标志但缺少该环境变量，则会快速失败。
   在交互式运行中，选择 secret reference 模式后，你可以指向环境变量或已配置的 provider ref（`file` 或 `exec`），并在保存前进行快速预检校验。
2. **工作区** —— 智能体文件的位置（默认 `~/.openclaw/workspace`）。会植入引导文件。
3. **Gateway 网关** —— 端口、绑定地址、认证模式、Tailscale 暴露。
   在交互式 token 模式中，你可以选择默认的明文 token 存储，或选择启用 SecretRef。
   非交互式 token SecretRef 路径：`--gateway-token-ref-env <ENV_VAR>`。
4. **渠道** —— WhatsApp、Telegram、Discord、Google Chat、Mattermost、Signal、BlueBubbles 或 iMessage。
5. **守护进程** —— 安装 LaunchAgent（macOS）或 systemd 用户单元（Linux/WSL2）。
   如果 token 认证需要 token，且 `gateway.auth.token` 由 SecretRef 管理，守护进程安装会验证它，但不会将已解析的 token 持久化到监督服务的环境元数据中。
   如果 token 认证需要 token，而已配置的 token SecretRef 无法解析，守护进程安装会被阻止，并提供可执行的指导。
   如果同时配置了 `gateway.auth.token` 和 `gateway.auth.password`，而 `gateway.auth.mode` 未设置，守护进程安装会被阻止，直到显式设置 mode。
6. **健康检查** —— 启动 Gateway 网关并验证其正在运行。
7. **Skills** —— 安装推荐的 Skills 和可选依赖项。

<Note>
重新运行向导**不会**清除任何内容，除非你显式选择 **Reset**（或传入 `--reset`）。
CLI `--reset` 默认会重置配置、凭证和会话；如需包含工作区，请使用 `--reset-scope full`。
如果配置无效或包含旧版键，向导会先要求你运行 `openclaw doctor`。
</Note>

**远程模式**只会配置本地客户端以连接到其他地方的 Gateway 网关。
它**不会**在远程主机上安装或更改任何内容。

## 添加另一个智能体

使用 `openclaw agents add <name>` 创建一个单独的智能体，它拥有自己的工作区、
会话和认证配置文件。不带 `--workspace` 运行会启动向导。

它会设置：

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

说明：

- 默认工作区遵循 `~/.openclaw/workspace-<agentId>`。
- 添加 `bindings` 以路由入站消息（向导可以完成这项操作）。
- 非交互式标志：`--model`、`--agent-dir`、`--bind`、`--non-interactive`。

## 完整参考

有关详细的分步骤拆解和配置输出，请参见
[CLI 设置参考](/start/wizard-cli-reference)。
有关非交互式示例，请参见 [CLI 自动化](/start/wizard-cli-automation)。
有关更深入的技术参考（包括 RPC 细节），请参见
[向导参考](/reference/wizard)。

## 相关文档

- CLI 命令参考：[`openclaw onboard`](/cli/onboard)
- 新手引导概览：[Onboarding Overview](/start/onboarding-overview)
- macOS 应用新手引导：[新手引导](/start/onboarding)
- 智能体首次运行仪式：[智能体引导](/start/bootstrapping)
