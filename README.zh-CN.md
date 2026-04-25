# 🦞 OpenClaw — 个人 AI 助手（简体中文）

OpenClaw 是一个你可以**自己部署/自己掌控**的个人 AI 助手与网关（Gateway）：它把你常用的聊天渠道（如 Telegram、WhatsApp、Slack、Discord 等）连接到 AI 智能体，并提供 CLI 与 Web 控制台。

- **官方文档（英文站点）**: `https://docs.openclaw.ai`
- **仓库内中文文档入口**: [`docs/zh-CN/index.md`](docs/zh-CN/index.md)

## 最快可用路径（推荐）

> 目标：不要求你先配置任何聊天渠道，先把 Gateway 跑起来并能在浏览器里聊天。

### 1) 安装

运行环境：**Node 24（推荐）** 或 **Node 22.16+**。

```bash
npm install -g openclaw@latest
# 或：pnpm add -g openclaw@latest
```

### 2) 跑新手引导（安装后台服务）

```bash
openclaw onboard --install-daemon
```

### 3) 打开控制台（Control UI / Dashboard）

```bash
openclaw dashboard
```

如果你想手动前台启动（便于看日志）：

```bash
openclaw gateway --port 18789 --verbose
```

本地默认地址通常是：`http://127.0.0.1:18789/`

## 下一步（中文文档，按任务走）

- **入门（从零到第一次聊天）**: [`docs/zh-CN/start/getting-started.md`](docs/zh-CN/start/getting-started.md)
- **快速开始**: [`docs/zh-CN/start/quickstart.md`](docs/zh-CN/start/quickstart.md)
- **新手引导（Wizard / Onboard）**: [`docs/zh-CN/start/wizard.md`](docs/zh-CN/start/wizard.md)
- **安装方式总览（Docker/Nix/更新/卸载等）**: [`docs/zh-CN/install/index.md`](docs/zh-CN/install/index.md)
- **Web 控制界面**: [`docs/zh-CN/web/control-ui.md`](docs/zh-CN/web/control-ui.md)
- **常见问题**: [`docs/zh-CN/help/faq.md`](docs/zh-CN/help/faq.md)

## 我只会中文，想用“聊天软件里直接聊”

建议优先用 **Telegram**（通常最快），然后再按需接入 WhatsApp / Slack / Discord 等：

- Telegram: [`docs/zh-CN/channels/telegram.md`](docs/zh-CN/channels/telegram.md)
- 渠道总览: [`docs/zh-CN/channels/index.md`](docs/zh-CN/channels/index.md)

## 安全提示（强烈建议先看）

OpenClaw 会连接真实聊天入口，把外部消息当作**不可信输入**来处理。

- 中文安全指南: [`docs/zh-CN/gateway/security/index.md`](docs/zh-CN/gateway/security/index.md)

