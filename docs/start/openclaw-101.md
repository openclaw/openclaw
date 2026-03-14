---
summary: "OpenClaw 101 — 从零到第一次 AI 聊天的完整入门指南"
title: "OpenClaw 101"
---

# OpenClaw 101：从零到第一次 AI 聊天

> **目标**：5 分钟内完成安装，发送第一条消息给 AI 助手。

---

## 🦞 什么是 OpenClaw？

OpenClaw 是一个**自托管的 AI 网关**，让你可以通过 WhatsApp、Telegram、Discord、iMessage 等聊天工具，随时与本地运行的 AI 助手对话。

**核心特点**：
- **自托管**：运行在你的设备上，数据不经过第三方
- **多通道**：一个网关同时服务多个聊天平台
- **AI 原生**：内置会话管理、工具调用、多 Agent 路由
- **开源**：MIT 许可，社区驱动

**适用场景**：
- 想在微信/Telegram 里随时召唤 AI 助手
- 需要本地部署的 AI 工作流
- 想要控制自己的数据隐私

---

## ⚡ 快速开始（5 分钟）

### Step 1: 检查前置条件

```bash
node --version
```

**学术级解释**：确认 Node.js 版本 ≥ 22。OpenClaw 基于 Node.js 运行，需要较新版本支持异步特性和性能优化。

**要求**：
- Node.js 22+
- macOS / Linux / Windows
- 5 分钟时间

### Step 2: 安装 OpenClaw

<Tabs>
  <Tab title="macOS / Linux">
    ```bash
    curl -fsSL https://openclaw.ai/install.sh | bash
    ```
  </Tab>
  <Tab title="Windows (PowerShell)">
    ```powershell
    iwr -useb https://openclaw.ai/install.ps1 | iex
    ```
  </Tab>
</Tabs>

**学术级解释**：安装脚本会自动：
1. 下载 OpenClaw npm 包
2. 创建配置文件目录 (`~/.openclaw`)
3. 设置全局 CLI 命令
4. 配置环境变量

### Step 3: 运行引导向导

```bash
openclaw onboard --install-daemon
```

**学术级解释**：`onboard` 向导会交互式配置：
- AI Provider API Key（推荐 Anthropic）
- Gateway 服务端口（默认 18789）
- 可选的聊天通道绑定
- `--install-daemon` 将 Gateway 注册为系统服务（开机自启）

### Step 4: 验证 Gateway 状态

```bash
openclaw gateway status
```

**学术级解释**：检查 Gateway 守护进程是否运行。正常输出应显示 `active (running)` 和监听端口。

**预期输出**：
```
Gateway: active (running)
Port: 18789
PID: 12345
```

### Step 5: 打开控制界面

```bash
openclaw dashboard
```

**学术级解释**：在默认浏览器打开本地 Control UI（`http://127.0.0.1:18789/`），提供：
- 聊天界面（无需配置通道即可测试）
- 会话管理
- 配置面板
- 节点监控

---

## 💬 第一次 AI 对话

### 方式 A：通过 Control UI（最快）

1. 运行 `openclaw dashboard`
2. 在聊天框输入：`你好，介绍一下你自己`
3. 等待 AI 回复

**学术级解释**：Control UI 直接连接本地 Gateway，无需外部通道配置。适合快速测试和调试。

### 方式 B：通过 CLI 发送消息

```bash
openclaw message send --message "你好，OpenClaw！"
```

**学术级解释**：CLI 消息会路由到当前会话的 AI Agent。需要至少配置一个通道才能收到回复。

### 方式 C：通过聊天应用（需要配置通道）

1. 在 Telegram 搜索 `@BotFather`
2. 创建新 Bot，获取 Token
3. 运行 `openclaw onboard` 配置 Telegram 通道
4. 在 Telegram 给你的 Bot 发消息

---

## 🔧 核心命令速查

### Gateway 管理

```bash
# 查看状态
openclaw gateway status

# 启动服务
openclaw gateway start

# 停止服务
openclaw gateway stop

# 重启服务
openclaw gateway restart

# 前台运行（调试用）
openclaw gateway --port 18789
```

**学术级解释**：Gateway 是 OpenClaw 的核心守护进程，负责：
- 通道连接管理
- 会话路由
- Agent 调度
- 消息队列处理

### 消息操作

```bash
# 发送消息
openclaw message send --target "@username" --message "Hello"

# 查看历史
openclaw sessions list --limit 10

# 查看会话详情
openclaw sessions history --sessionKey abc123
```

### 通道配置

```bash
# 列出已配置通道
openclaw channels list

# 添加 Telegram 通道
openclaw channels add telegram --token YOUR_BOT_TOKEN

# 删除通道
openclaw channels remove telegram
```

### Agent 管理

```bash
# 列出可用 Agent
openclaw agents list

# 查看 Agent 状态
openclaw agents status

# 切换默认 Agent
openclaw config set default-agent pi
```

---

## 📁 目录结构

安装后，OpenClaw 会在你的主目录创建以下结构：

```
~/.openclaw/
├── config.json          # 主配置文件
├── state/               # 运行时状态
│   ├── sessions/        # 会话数据
│   ├── memory/          # 长期记忆
│   └── logs/            # 日志文件
├── workspace/           # 工作区（可自定义）
│   ├── AGENTS.md        # Agent 配置
│   ├── SOUL.md          # AI 人格定义
│   ├── USER.md          # 用户信息
│   ├── MEMORY.md        # 长期记忆
│   └── memory/          # 每日记忆日志
└── tools/               # 工具脚本
```

**学术级解释**：
- `config.json`：存储 API Key、通道配置、端口设置
- `state/`：动态数据，可安全删除重置
- `workspace/`：用户可编辑的 AI 人格和记忆文件
- `tools/`：扩展脚本和自定义工具

---

## 🛠️ 常见问题排查

### 问题 1：Gateway 无法启动

```bash
# 检查端口占用
lsof -i :18789

# 查看日志
openclaw logs --tail 100

# 前台运行调试
openclaw gateway --port 18789
```

**学术级解释**：端口冲突是最常见原因。18789 是默认端口，可通过 `--port` 参数修改。

### 问题 2：收不到 AI 回复

```bash
# 检查 API Key 配置
openclaw config get anthropic-api-key

# 测试 API 连接
curl -H "Authorization: Bearer YOUR_KEY" \
     https://api.anthropic.com/v1/messages \
     -d '{"model":"claude-sonnet-4-20250514","max_tokens":10}'
```

**学术级解释**：回复失败通常因为：
1. API Key 无效或过期
2. 账户余额不足
3. 网络防火墙阻止

### 问题 3：通道连接失败

```bash
# Telegram 测试
openclaw channels test telegram

# 查看通道日志
openclaw logs --channel telegram --tail 50
```

**学术级解释**：通道问题可能因为：
- Bot Token 错误
- 权限不足（需要管理员权限的群组）
- 速率限制（Telegram 有 API 调用频率限制）

---

## 🚀 下一步学习路径

完成 101 后，建议按以下顺序深入学习：

1. **通道配置** → [Channels](/channels)
   - 绑定 WhatsApp、Discord、iMessage
   - 配置多通道路由规则

2. **会话管理** → [Sessions](/tools/sessions)
   - 理解会话隔离机制
   - 跨会话消息路由

3. **Agent 定制** → [Agents](/concepts/agents)
   - 自定义 AI 人格（SOUL.md）
   - 配置工具调用权限

4. **记忆系统** → [Memory](/concepts/memory)
   - 长期记忆管理
   - 记忆搜索和召回

5. **节点系统** → [Nodes](/nodes)
   - 配对移动设备
   - Canvas 屏幕共享

6. **高级自动化** → [Automation](/automation)
   - Cron 定时任务
   - 心跳检查
   - 子 Agent 编排

---

## 📚 资源链接

- **官方文档**：https://openclaw101.dev
- **GitHub 源码**：https://github.com/openclaw/openclaw
- **社区 Discord**：https://discord.com/invite/clawd
- **技能市场**：https://clawhub.com

---

## 🎯 小结

完成本教程后，你应该能够：

- ✅ 安装并运行 OpenClaw Gateway
- ✅ 通过 Control UI 与 AI 对话
- ✅ 使用 CLI 管理服务和消息
- ✅ 理解基本目录结构
- ✅ 排查常见问题

**下一步**：配置你的第一个聊天通道，让 AI 助手住进你的 Telegram/WhatsApp！

---

<Info>
**版本**：1.0  
**最后更新**：2026-03-03  
**适用版本**：OpenClaw v25.x+
</Info>
