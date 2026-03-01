# OpenClaw 常见问题解答 (FAQ)

本文档回答关于 OpenClaw 的常见问题。

---

## 📖 目录

- [一般问题](#一般问题)
- [安装与设置](#安装与设置)
- [渠道与消息](#渠道与消息)
- [模型与 AI](#模型与 -ai)
- [故障排除](#故障排除)
- [贡献与社区](#贡献与社区)

---

## 一般问题

### OpenClaw 是什么？

OpenClaw 是一个**自托管的个人 AI 助手网关**。它连接你的聊天应用（WhatsApp、Telegram、Discord 等）与 AI 智能体，让你随时随地通过消息与 AI 交互。

### 为什么叫 OpenClaw？

"Claw" 来自龙虾（🦞）的爪子。吉祥物是一只太空龙虾，口号是"EXFOLIATE! EXFOLIATE!"（去壳！去壳！）

### OpenClaw 免费吗？

是的，OpenClaw 是**开源免费**的（MIT 许可证）。但使用 AI 模型可能需要支付 API 费用（如 Anthropic、OpenAI 等）。

### 我需要运行在哪里？

OpenClaw 可以运行在：
- **个人电脑**：Windows、macOS、Linux
- **服务器**：VPS、云服务器
- **树莓派**：Raspberry Pi
- **Docker**：容器化部署

### 与 ChatGPT 有什么区别？

| OpenClaw | ChatGPT |
|----------|---------|
| 自托管，你控制数据 | 托管服务，数据在 OpenAI |
| 连接多个聊天渠道 | 仅限 Web/App |
| 可自定义智能体行为 | 固定行为 |
| 免费开源 | 付费订阅 |

---

## 安装与设置

### 系统要求是什么？

- **Node.js** ≥ 22
- **内存**：至少 512MB（推荐 2GB+）
- **存储**：至少 100MB 可用空间
- **网络**：需要访问互联网（用于 AI API）

### 如何安装 OpenClaw？

**推荐方式（一键安装）：**

```bash
# Windows (PowerShell)
iwr -useb https://openclaw.ai/install.ps1 | iex

# macOS/Linux
curl -fsSL https://openclaw.ai/install.sh | bash
```

**使用 npm：**
```bash
npm install -g openclaw@latest
```

**使用 pnpm：**
```bash
pnpm add -g openclaw@latest
```

### 安装后如何设置？

运行新手向导：
```bash
openclaw onboard --install-daemon
```

向导会帮你：
1. 配置 AI 模型认证
2. 设置 Gateway 网关
3. 连接聊天渠道
4. 创建工作区

### 支持哪些 AI 模型？

OpenClaw 支持多种模型提供商：
- **Anthropic**（Claude 系列）⭐ 推荐
- **OpenAI**（GPT 系列）
- **Google**（Gemini）
- **阿里云**（通义千问）
- **智谱 AI**（GLM）
- **月之暗面**（Kimi）
- **Ollama**（本地模型）
- 以及更多...

详见：[模型提供商](https://docs.openclaw.ai/providers)

### 如何配置 WhatsApp？

1. 运行 `openclaw channels whatsapp`
2. 扫描二维码配对
3. 等待连接成功

详见：[WhatsApp 渠道](https://docs.openclaw.ai/channels/whatsapp)

### 如何配置 Telegram？

1. 从 [@BotFather](https://t.me/BotFather) 创建机器人
2. 获取 Bot Token
3. 运行 `openclaw channels telegram --token YOUR_TOKEN`

详见：[Telegram 渠道](https://docs.openclaw.ai/channels/telegram)

### 如何配置 Discord？

1. 在 [Discord Developer Portal](https://discord.com/developers/applications) 创建应用
2. 获取 Bot Token
3. 邀请机器人到你的服务器
4. 运行 `openclaw channels discord --token YOUR_TOKEN`

详见：[Discord 渠道](https://docs.openclaw.ai/channels/discord)

---

## 渠道与消息

### 支持哪些聊天渠道？

**核心渠道：**
- WhatsApp
- Telegram
- Slack
- Discord
- Google Chat
- Signal
- iMessage（通过 BlueBubbles）
- Microsoft Teams
- WebChat

**扩展渠道（插件）：**
- BlueBubbles
- Matrix
- Zalo
- Zalo Personal

详见：[渠道列表](https://docs.openclaw.ai/channels)

### 可以在群组中使用吗？

可以！OpenClaw 支持群组消息：
- **提及机器人**：@机器人 发消息
- **回复机器人**：回复机器人的消息
- **私信机器人**：直接 DM

详见：[群组消息](https://docs.openclaw.ai/channels/groups)

### 如何发送消息？

**通过 CLI：**
```bash
openclaw message send --to +1234567890 --message "Hello!"
```

**通过聊天渠道：**
直接在你连接的渠道（如 WhatsApp）中发消息给机器人。

**通过 Web UI：**
运行 `openclaw dashboard` 打开浏览器控制界面。

### 如何接收图片/文件？

OpenClaw 支持媒体文件：
- 图片（JPG、PNG、GIF 等）
- 音频（语音消息）
- 视频
- 文档

AI 可以"看懂"图片内容并回复。

### 有人发消息时如何通知？

OpenClaw 支持多种通知方式：
- **系统通知**：桌面通知
- **语音唤醒**：听到唤醒词自动响应
- **推送通知**：移动设备推送

详见：[通知](https://docs.openclaw.ai/nodes/notifications)

---

## 模型与 AI

### 推荐用什么模型？

**强烈推荐：Anthropic Claude 系列**
- **Claude Opus 4.6**：最强能力，适合复杂任务
- **Claude Sonnet 4.5**：平衡性能与成本
- **Claude Haiku 4.5**：快速便宜，适合简单任务

**原因：**
- 长上下文能力强（200K tokens）
- 提示注入抗性好
- 代码能力强

### 如何使用自己的 API 密钥？

```bash
openclaw configure --section models
```

然后按照提示输入 API 密钥。

或者编辑配置文件：
```json
{
  "models": {
    "providers": {
      "anthropic": {
        "apiKey": "sk-ant-xxx"
      }
    }
  }
}
```

### 可以使用本地模型吗？

可以！使用 **Ollama** 运行本地模型：

1. 安装 Ollama：https://ollama.ai
2. 拉取模型：`ollama pull llama2`
3. 配置 OpenClaw 使用 Ollama

详见：[Ollama](https://docs.openclaw.ai/providers/ollama)

### 如何切换模型？

**临时切换：**
```bash
openclaw agent --message "Hello" --model anthropic/claude-opus
```

**永久切换：**
编辑配置文件，设置默认模型。

### AI 能访问我的文件吗？

**默认不能。** OpenClaw 有严格的安全沙箱：
- AI 只能访问工作区内的文件
- 系统命令需要明确批准
- 敏感操作需要用户确认

详见：[安全](https://docs.openclaw.ai/gateway/security)

### 如何保护隐私？

OpenClaw 设计为**隐私优先**：
- **自托管**：数据在你自己的设备上
- **本地处理**：消息不经过第三方服务器
- **加密存储**：敏感数据加密保存
- **最小权限**：AI 只有必要的访问权限

最佳实践：
- 不要分享 API 密钥
- 定期更新密码
- 使用配对码保护陌生消息
- 审查 AI 的工具访问权限

---

## 故障排除

### Gateway 无法启动

**检查端口：**
```bash
openclaw gateway --port 18789
```

**查看日志：**
```bash
openclaw logs
```

**常见原因：**
- 端口被占用
- 配置文件错误
- 认证失败

### 渠道连接失败

**检查网络：**
- 确保能访问互联网
- 检查防火墙设置
- 验证 API 密钥/Token

**重新配对：**
```bash
openclaw channels <channel> --reset
```

### AI 不回复消息

**可能原因：**
1. 模型 API 密钥无效
2. 消息被沙箱阻止
3. 会话超时

**解决方法：**
```bash
# 检查模型配置
openclaw models list

# 重启 Gateway
openclaw gateway restart

# 查看日志
openclaw logs --follow
```

### 内存占用过高

**优化建议：**
- 减少并发会话数
- 使用较小的模型（如 Haiku）
- 定期清理旧会话

```bash
# 清理会话
openclaw sessions prune
```

### 如何更新 OpenClaw？

```bash
# npm 安装
npm install -g openclaw@latest

# pnpm 安装
pnpm add -g openclaw@latest

# 检查版本
openclaw --version

# 运行 doctor 检查
openclaw doctor
```

详见：[更新指南](https://docs.openclaw.ai/install/updating)

---

## 贡献与社区

### 如何贡献代码？

1. Fork 项目
2. 创建分支
3. 修改代码
4. 提交 PR

详见：[贡献指南](CONTRIBUTING.md)

### 如何报告 Bug？

在 GitHub 提交 Issue：
https://github.com/openclaw/openclaw/issues

**包含以下信息：**
- 问题描述
- 复现步骤
- 环境信息（OS、Node 版本、OpenClaw 版本）
- 日志/截图

### 在哪里可以获得帮助？

- **Discord 社区**：https://discord.gg/clawd ⭐ 推荐
- **GitHub Issues**：提问和讨论
- **文档**：https://docs.openclaw.ai
- **本 FAQ**：常见问题

### 有中文文档吗？

有！中文文档在这里：
- **贡献指南**：`docs/zh-CN/CONTRIBUTING.md`
- **入门指南**：`docs/zh-CN/start/getting-started.md`
- **完整文档**：`docs/zh-CN/` 目录

欢迎贡献翻译！📚

### 如何推广 OpenClaw？

- ⭐ **Star 项目**：GitHub 上点 Star
- 📢 **分享给朋友**：推荐给需要的人
- 📝 **写博客**：分享使用体验
- 💬 **社区帮助**：在 Discord 回答问题

---

## 📞 还有问题？

如果 FAQ 没解决你的问题：

1. **查文档**：https://docs.openclaw.ai
2. **搜 Issue**：https://github.com/openclaw/openclaw/issues
3. **问社区**：https://discord.gg/clawd
4. **提 Issue**：https://github.com/openclaw/openclaw/issues/new

---

**最后更新：** 2026-03-01

**维护者：** OpenClaw 社区
