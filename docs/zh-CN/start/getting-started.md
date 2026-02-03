---
read_when:
  - 从零开始首次设置
  - 你想要从安装 → 新手引导 → 第一条消息的最快路径
summary: 新手指南：从零到第一条消息（向导、认证、渠道、配对）
title: 入门指南
x-i18n:
  generated_at: "2026-02-03T07:54:14Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: 78cfa02eb2e4ea1a83e18edd99d142dbae707ec063e8d74c9a54f94581aa067f
  source_path: start/getting-started.md
  workflow: 15
---

# 入门指南

目标：尽快从**零**到**第一个可用聊天**（使用合理的默认值）。

最快聊天：打开 Control UI（无需渠道设置）。运行 `openclaw dashboard` 并在浏览器中聊天，或在 Gateway 网关主机上打开 `http://127.0.0.1:18789/`。文档：[Dashboard](/web/dashboard) 和 [Control UI](/web/control-ui)。

推荐路径：使用 **CLI 新手引导向导**（`openclaw onboard`）。它设置：

- 模型/认证（推荐 OAuth）
- Gateway 网关设置
- 渠道（WhatsApp/Telegram/Discord/Mattermost（插件）/...）
- 配对默认值（安全私信）
- 工作区引导 + Skills
- 可选的后台服务

如果你想要更深入的参考页面，跳转到：[向导](/start/wizard)、[设置](/start/setup)、[配对](/start/pairing)、[安全](/gateway/security)。

沙箱注意事项：`agents.defaults.sandbox.mode: "non-main"` 使用 `session.mainKey`（默认 `"main"`），因此群组/渠道会话会被沙箱隔离。如果你想要主智能体始终在主机上运行，设置显式的每智能体覆盖：

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

## 0) 前置条件

- Node `>=22`
- `pnpm`（可选；如果从源代码构建则推荐）
- **推荐：**Brave Search API 密钥用于网页搜索。最简单的方式：`openclaw configure --section web`（存储 `tools.web.search.apiKey`）。参见 [Web 工具](/tools/web)。

macOS：如果你计划构建应用，安装 Xcode / CLT。仅用于 CLI + Gateway 网关的话，Node 就足够了。
Windows：使用 **WSL2**（推荐 Ubuntu）。强烈推荐 WSL2；原生 Windows 未经测试，问题更多，工具兼容性更差。先安装 WSL2，然后在 WSL 内运行 Linux 步骤。参见 [Windows (WSL2)](/platforms/windows)。

## 1) 安装 CLI（推荐）

```bash
curl -fsSL https://openclaw.ai/install.sh | bash
```

安装程序选项（安装方法、非交互式、从 GitHub）：[安装](/install)。

Windows (PowerShell)：

```powershell
iwr -useb https://openclaw.ai/install.ps1 | iex
```

替代方案（全局安装）：

```bash
npm install -g openclaw@latest
```

```bash
pnpm add -g openclaw@latest
```

## 2) 运行新手引导向导（并安装服务）

```bash
openclaw onboard --install-daemon
```

你将选择：

- **本地 vs 远程** Gateway 网关
- **认证**：OpenAI Code (Codex) 订阅（OAuth）或 API 密钥。对于 Anthropic 我们推荐 API 密钥；也支持 `claude setup-token`。
- **提供商**：WhatsApp QR 登录、Telegram/Discord 机器人令牌、Mattermost 插件令牌等。
- **守护进程**：后台安装（launchd/systemd；WSL2 使用 systemd）
  - **运行时**：Node（推荐；WhatsApp/Telegram 必需）。**不推荐** Bun。
- **Gateway 网关令牌**：向导默认生成一个（即使在 loopback 上）并存储在 `gateway.auth.token`。

向导文档：[向导](/start/wizard)

### 凭证：存储位置（重要）

- **推荐的 Anthropic 路径：**设置 API 密钥（向导可以为服务使用存储它）。如果你想复用 Claude Code 凭证，也支持 `claude setup-token`。

- OAuth 凭证（旧版导入）：`~/.openclaw/credentials/oauth.json`
- 认证配置文件（OAuth + API 密钥）：`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`

无头/服务器提示：先在普通机器上完成 OAuth，然后将 `oauth.json` 复制到 Gateway 网关主机。

## 3) 启动 Gateway 网关

如果你在新手引导期间安装了服务，Gateway 网关应该已经在运行：

```bash
openclaw gateway status
```

手动运行（前台）：

```bash
openclaw gateway --port 18789 --verbose
```

Dashboard（local loopback）：`http://127.0.0.1:18789/`
如果配置了令牌，将其粘贴到 Control UI 设置中（存储为 `connect.params.auth.token`）。

⚠️ **Bun 警告（WhatsApp + Telegram）：**Bun 与这些渠道存在已知问题。如果你使用 WhatsApp 或 Telegram，请使用 **Node** 运行 Gateway 网关。

## 3.5) 快速验证（2 分钟）

```bash
openclaw status
openclaw health
openclaw security audit --deep
```

## 4) 配对 + 连接你的第一个聊天界面

### WhatsApp（QR 登录）

```bash
openclaw channels login
```

通过 WhatsApp → 设置 → 链接设备扫描。

WhatsApp 文档：[WhatsApp](/channels/whatsapp)

### Telegram / Discord / 其他

向导可以为你写入令牌/配置。如果你更喜欢手动配置，从这里开始：

- Telegram：[Telegram](/channels/telegram)
- Discord：[Discord](/channels/discord)
- Mattermost（插件）：[Mattermost](/channels/mattermost)

**Telegram 私信提示：**你的第一条私信会返回配对码。批准它（见下一步），否则机器人不会响应。

## 5) 私信安全（配对审批）

默认姿态：未知私信会获得一个短代码，消息在批准之前不会被处理。如果你的第一条私信没有收到回复，批准配对：

```bash
openclaw pairing list whatsapp
openclaw pairing approve whatsapp <code>
```

配对文档：[配对](/start/pairing)

## 从源代码（开发）

如果你正在开发 OpenClaw 本身，从源代码运行：

```bash
git clone https://github.com/openclaw/openclaw.git
cd openclaw
pnpm install
pnpm ui:build # 首次运行时自动安装 UI 依赖
pnpm build
openclaw onboard --install-daemon
```

如果你还没有全局安装，从仓库通过 `pnpm openclaw ...` 运行新手引导步骤。`pnpm build` 也会打包 A2UI 资源；如果你只需要运行那个步骤，使用 `pnpm canvas:a2ui:bundle`。

Gateway 网关（从此仓库）：

```bash
node openclaw.mjs gateway --port 18789 --verbose
```

## 7) 验证端到端

在新终端中，发送测试消息：

```bash
openclaw message send --target +15555550123 --message "Hello from OpenClaw"
```

如果 `openclaw health` 显示"未配置认证"，回到向导设置 OAuth/密钥认证——没有它智能体将无法响应。

提示：`openclaw status --all` 是最佳的可粘贴、只读调试报告。
健康探测：`openclaw health`（或 `openclaw status --deep`）向运行中的 Gateway 网关请求健康快照。

## 下一步（可选，但很棒）

- macOS 菜单栏应用 + 语音唤醒：[macOS 应用](/platforms/macos)
- iOS/Android 节点（Canvas/相机/语音）：[节点](/nodes)
- 远程访问（SSH 隧道 / Tailscale Serve）：[远程访问](/gateway/remote) 和 [Tailscale](/gateway/tailscale)
- 常开 / VPN 设置：[远程访问](/gateway/remote)、[exe.dev](/platforms/exe-dev)、[Hetzner](/platforms/hetzner)、[macOS 远程](/platforms/mac/remote)
