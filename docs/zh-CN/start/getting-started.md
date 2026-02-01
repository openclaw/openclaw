---
read_when:
  - 从零开始的首次设置
  - 您希望找到从安装 → 上手引导 → 发送第一条消息的最快路径
summary: 新手指南：从零开始到发送第一条消息（向导、认证、渠道、配对）
x-i18n:
  generated_at: "2026-02-01T13:38:44Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: d0ebc83c10efc569eaf6fb32368a29ef75a373f15da61f3499621462f08aff63
  source_path: start/getting-started.md
  workflow: 9
---

# 快速入门

目标：从 **零开始** → **第一次成功聊天** （使用合理的默认配置）尽可能快地完成。

最快聊天方式：打开控制界面（无需设置渠道）。运行 `openclaw dashboard`
然后在浏览器中聊天，或打开 `http://127.0.0.1:18789/` （在 Gateway 主机上）。
文档： [仪表盘](/web/dashboard) 和 [控制界面](/web/control-ui)。

推荐路径：使用 **CLI 上手引导向导** （`openclaw onboard`）。它会设置：

- 模型/认证（推荐使用 OAuth）
- Gateway 设置
- 渠道（WhatsApp/Telegram/Discord/Mattermost（插件）/...）
- 配对默认设置（安全私信）
- 工作区引导 + 技能
- 可选的后台服务

如果您需要更详细的参考页面，请跳转至： [向导](/start/wizard), [设置](/start/setup), [配对](/start/pairing), [安全](/gateway/security)。

沙箱注意事项： `agents.defaults.sandbox.mode: "non-main"` 使用 `session.mainKey` （默认 `"main"`），因此群组/渠道会话是沙箱化的。如果您希望主智能体始终在主机上运行，请设置显式的逐智能体覆盖：

```json
{
  "routing": {
    "agents": {
      "main": {
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      }
    }
  }
}
```

## 0）前提条件

- Node `>=22`
- `pnpm` （可选；如果从源码构建则推荐安装）
- **推荐：** Brave Search API 密钥用于网络搜索。最简单的方式：
  `openclaw configure --section web` （存储 `tools.web.search.apiKey`）。
  参见 [网络工具](/tools/web)。

macOS：如果您计划构建应用程序，请安装 Xcode / CLT。如果仅使用 CLI + Gateway，Node 就足够了。
Windows：使用 **WSL2** （推荐 Ubuntu）。强烈推荐使用 WSL2；原生 Windows 未经测试，问题较多，且工具兼容性较差。请先安装 WSL2，然后在 WSL 内执行 Linux 步骤。参见 [Windows (WSL2)](/platforms/windows)。

## 1）安装 CLI（推荐）

```bash
curl -fsSL https://openclaw.bot/install.sh | bash
```

安装选项（安装方式、非交互式、从 GitHub 安装）： [安装](/install)。

Windows (PowerShell)：

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

替代方式（全局安装）：

```bash
npm install -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

## 2）运行上手引导向导（并安装服务）

```bash
openclaw onboard --install-daemon
```

您需要选择的内容：

- **本地 vs 远程** Gateway
- **认证**：OpenAI Code (Codex) 订阅（OAuth）或 API 密钥。对于 Anthropic，我们推荐使用 API 密钥； `claude setup-token` 也受支持。
- **提供商**：WhatsApp 二维码登录、Telegram/Discord 机器人令牌、Mattermost 插件令牌等。
- **守护进程**：后台安装（launchd/systemd；WSL2 使用 systemd）
  - **运行时**：Node（推荐；WhatsApp/Telegram 必需）。Bun 为 **不推荐**。
- **Gateway 令牌**：向导默认会生成一个（即使在回环地址上）并将其存储在 `gateway.auth.token`。

向导文档： [向导](/start/wizard)

### 认证：存储位置（重要）

- **推荐的 Anthropic 路径：** 设置 API 密钥（向导可以将其存储以供服务使用）。 `claude setup-token` 如果您想复用 Claude Code 凭据，也受支持。

- OAuth 凭据（旧版导入）： `~/.openclaw/credentials/oauth.json`
- 认证配置文件（OAuth + API 密钥）： `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

无头/服务器提示：先在普通机器上完成 OAuth，然后复制 `oauth.json` 到 Gateway 主机上。

## 3）启动 Gateway

如果您在上手引导过程中安装了服务，Gateway 应该已经在运行：

```bash
openclaw gateway status
```

手动运行（前台）：

```bash
openclaw gateway --port 18789 --verbose
```

仪表盘（本地回环）： `http://127.0.0.1:18789/`
如果配置了令牌，请将其粘贴到控制界面设置中（存储为 `connect.params.auth.token`）。

⚠️ **Bun 警告（WhatsApp + Telegram）：** Bun 在这些渠道上存在已知问题。如果您使用 WhatsApp 或 Telegram，请使用 **Node **。

## 3.5）快速验证（2 分钟）

```bash
openclaw status
openclaw health
openclaw security audit --deep
```

## 4）配对 + 连接您的第一个聊天界面

### WhatsApp（二维码登录）

```bash
openclaw channels login
```

通过 WhatsApp → 设置 → 已关联设备 进行扫描。

WhatsApp 文档： [WhatsApp](/channels/whatsapp)

### Telegram / Discord / 其他

向导可以为您写入令牌/配置。如果您更喜欢手动配置，请从以下内容开始：

- Telegram： [Telegram](/channels/telegram)
- Discord： [Discord](/channels/discord)
- Mattermost（插件）： [Mattermost](/channels/mattermost)

**Telegram 私信提示：** 您的第一条私信会返回一个配对码。请批准它（参见下一步），否则机器人将不会响应。

## 5）私信安全（配对审批）

默认策略：未知私信会收到一个短码，消息在批准之前不会被处理。
如果您的第一条私信没有收到回复，请批准配对：

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <code>
```

配对文档： [配对](/start/pairing)

## 从源码安装（开发）

如果您正在开发 OpenClaw 本身，请从源码运行：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # auto-installs UI deps on first run
pnpm build
openclaw onboard --install-daemon
```

如果您尚未进行全局安装，请通过以下方式运行上手引导步骤 `pnpm openclaw ...` （从仓库中）。
`pnpm build` 也会打包 A2UI 资源；如果您只需要运行该步骤，请使用 `pnpm canvas:a2ui:bundle`。

Gateway（从此仓库）：

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## 7）端到端验证

在新终端中，发送一条测试消息：

```bash
openclaw message send --target +15555550123 --message "Hello from OpenClaw"
```

如果 `openclaw health` 显示"未配置认证"，请返回向导设置 OAuth/密钥认证——智能体在没有认证的情况下将无法响应。

提示： `openclaw status --all` 是最佳的可粘贴只读调试报告。
健康探针： `openclaw health` （或 `openclaw status --deep`）向运行中的 Gateway 请求健康快照。

## 后续步骤（可选，但强烈推荐）

- macOS 菜单栏应用 + 语音唤醒： [macOS 应用](/platforms/macos)
- iOS/Android 节点（Canvas/相机/语音）： [节点](/nodes)
- 远程访问（SSH 隧道 / Tailscale Serve）： [远程访问](/gateway/remote) 和 [Tailscale](/gateway/tailscale)
- 常驻运行 / VPN 设置： [远程访问](/gateway/remote), [exe.dev](/platforms/exe-dev), [Hetzner](/platforms/hetzner), [macOS 远程](/platforms/mac/remote)
