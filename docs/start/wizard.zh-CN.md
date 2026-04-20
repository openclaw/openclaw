---
summary: "CLI 引导流程：网关、工作区、通道和技能的引导式设置"
read_when:
  - 运行或配置 CLI 引导流程
  - 设置新机器
title: "引导流程（CLI）"
sidebarTitle: "引导流程：CLI"
---

# 引导流程（CLI）

CLI 引导流程是在 macOS、Linux 或 Windows（通过 WSL2；强烈推荐）上设置 OpenClaw 的**推荐**方式。
它在一个引导流程中配置本地网关或远程网关连接，以及通道、技能和工作区默认值。

```bash
openclaw onboard
```

<Info>
最快的首次聊天：打开控制 UI（无需设置通道）。运行
`openclaw dashboard` 并在浏览器中聊天。文档：[仪表板](/web/dashboard)。
</Info>

稍后重新配置：

```bash
openclaw configure
openclaw agents add <name>
```

<Note>
`--json` 并不意味着非交互模式。对于脚本，请使用 `--non-interactive`。
</Note>

<Tip>
CLI 引导流程包括一个网络搜索步骤，您可以选择提供商
如 Brave、DuckDuckGo、Exa、Firecrawl、Gemini、Grok、Kimi、MiniMax Search、
Ollama Web Search、Perplexity、SearXNG 或 Tavily。一些提供商需要 API 密钥，而其他则无需密钥。您也可以稍后使用
`openclaw configure --section web` 进行配置。文档：[网络工具](/tools/web)。
</Tip>

## 快速启动 vs 高级

引导流程从 **快速启动**（默认值）vs **高级**（完全控制）开始。

<Tabs>
  <Tab title="快速启动（默认值）">
    - 本地网关（环回）
    - 工作区默认值（或现有工作区）
    - 网关端口 **18789**
    - 网关身份验证 **令牌**（自动生成，即使在环回上）
    - 新本地设置的工具策略默认值：`tools.profile: "coding"`（保留现有显式配置文件）
    - DM 隔离默认值：本地引导流程在未设置时写入 `session.dmScope: "per-channel-peer"`。详细信息：[CLI 设置参考](/start/wizard-cli-reference#outputs-and-internals)
    - Tailscale 暴露 **关闭**
    - Telegram + WhatsApp DM 默认设置为 **允许列表**（会提示您输入电话号码）
  </Tab>
  <Tab title="高级（完全控制）">
    - 暴露每一步（模式、工作区、网关、通道、守护进程、技能）。
  </Tab>
</Tabs>

## 引导流程配置什么

**本地模式（默认）** 引导您完成以下步骤：

1. **模型/身份验证** — 选择任何支持的提供商/身份验证流程（API 密钥、OAuth 或提供商特定的手动身份验证），包括自定义提供商
   （OpenAI 兼容、Anthropic 兼容或未知自动检测）。选择默认模型。
   安全注意：如果此代理将运行工具或处理网络钩子/钩子内容，请选择可用的最强最新一代模型并保持工具策略严格。较弱/较旧的层级更容易被提示注入。
   对于非交互运行，`--secret-input-mode ref` 在身份验证配置文件中存储基于环境的引用，而不是明文 API 密钥值。
   在非交互 `ref` 模式下，必须设置提供商环境变量；在没有该环境变量的情况下传递内联密钥标志会快速失败。
   在交互运行中，选择秘密引用模式允许您指向环境变量或配置的提供商引用（`file` 或 `exec`），并在保存前进行快速预检验证。
   对于 Anthropic，交互式引导流程/配置提供 **Anthropic Claude CLI** 作为首选本地路径，**Anthropic API 密钥** 作为推荐的生产路径。Anthropic setup-token 仍然作为支持的令牌身份验证路径可用。
2. **工作区** — 代理文件的位置（默认 `~/.openclaw/workspace`）。为引导文件播种。
3. **网关** — 端口、绑定地址、身份验证模式、Tailscale 暴露。
   在交互式令牌模式下，选择默认明文令牌存储或选择加入 SecretRef。
   非交互式令牌 SecretRef 路径：`--gateway-token-ref-env <ENV_VAR>`。
4. **通道** — 内置和捆绑的聊天通道，如 BlueBubbles、Discord、飞书、Google Chat、Mattermost、Microsoft Teams、QQ 机器人、Signal、Slack、Telegram、WhatsApp 等。
5. **守护进程** — 安装 LaunchAgent（macOS）、systemd 用户单元（Linux/WSL2）或带有每用户启动文件夹回退的原生 Windows 计划任务。
   如果令牌身份验证需要令牌且 `gateway.auth.token` 由 SecretRef 管理，守护进程安装会验证它，但不会将解析的令牌持久化到 supervisor 服务环境元数据中。
   如果令牌身份验证需要令牌且配置的令牌 SecretRef 未解析，守护进程安装会被阻止并提供可操作的指导。
   如果同时配置了 `gateway.auth.token` 和 `gateway.auth.password` 且 `gateway.auth.mode` 未设置，守护进程安装会被阻止，直到明确设置模式。
6. **健康检查** — 启动网关并验证它正在运行。
7. **技能** — 安装推荐的技能和可选依赖项。

<Note>
重新运行引导流程**不会**擦除任何内容，除非您明确选择 **重置**（或传递 `--reset`）。
CLI `--reset` 默认重置配置、凭据和会话；使用 `--reset-scope full` 包含工作区。
如果配置无效或包含遗留键，引导流程会要求您先运行 `openclaw doctor`。
</Note>

**远程模式** 仅配置本地客户端连接到其他地方的网关。
它**不会**在远程主机上安装或更改任何内容。

## 添加另一个代理

使用 `openclaw agents add <name>` 创建具有自己的工作区、会话和身份验证配置文件的单独代理。不使用 `--workspace` 运行会启动引导流程。

它设置：

- `agents.list[].name`
- `agents.list[].workspace`
- `agents.list[].agentDir`

注意：

- 默认工作区遵循 `~/.openclaw/workspace-<agentId>`。
- 添加 `bindings` 以路由入站消息（引导流程可以执行此操作）。
- 非交互标志：`--model`、`--agent-dir`、`--bind`、`--non-interactive`。

## 完整参考

有关详细的分步分解和配置输出，请参阅
[CLI 设置参考](/start/wizard-cli-reference)。
有关非交互示例，请参阅 [CLI 自动化](/start/wizard-cli-automation)。
有关更深入的技术参考，包括 RPC 详细信息，请参阅
[引导流程参考](/reference/wizard)。

## 相关文档

- CLI 命令参考：[`openclaw onboard`](/cli/onboard)
- 引导流程概述：[引导流程概述](/start/onboarding-overview)
- macOS 应用引导流程：[引导流程](/start/onboarding)
- 代理首次运行仪式：[代理自举](/start/bootstrapping)