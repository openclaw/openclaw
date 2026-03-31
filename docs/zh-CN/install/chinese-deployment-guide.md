---
read_when:
  - 向中国开发者介绍 OpenClaw 国内部署
summary: 针对国内网络环境的保姆级部署指南，支持智谱GLM / 通义千问 / 豆包 + 微信通道接入
title: OpenClaw 中文部署指南
x-i18n:
  generated_at: "2026-03-31T02:00:00Z"
  source_path: chinese-deployment-guide.md
---

# OpenClaw 中文部署指南（2026最新版）

**智谱GLM / 通义千问 / 豆包 + 微信接入 · 保姆级教程**

> 适用版本: OpenClaw ≥ 2026.3.22 | 微信插件: @tencent-weixin/openclaw-weixin 2.0.x
> 最后更新: 2026-03-31 | 数据来源: OpenClaw官方源码 + GitHub Issues + 实测

---

## 1. 前言

OpenClaw 是全球增长最快的开源AI代理框架（34万+ GitHub Stars，870万月npm下载），支持20+聊天通道、56个内置技能、子Agent多智能体。

**本指南针对中国开发者，解决3个核心痛点：**

1. 国内网络环境下的安装与加速
2. 国产大模型（智谱/通义/豆包）的正确接入方式
3. 微信通道的完整配置与已知问题

---

## 2. 环境准备（国内加速）

### 2.1 安装 Node.js

```bash
# 推荐 Node.js 22.16+ 或 24
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash
nvm install 22
nvm use 22
```

### 2.2 配置国内 npm 镜像（必做）

```bash
npm config set registry https://registry.npmmirror.com
npm config set disturl https://npmmirror.com/dist
```

### 2.3 安装 OpenClaw

```bash
npm install -g openclaw@latest
openclaw --version  # 应显示 2026.3.x
```

### 2.4 一键配置向导

```bash
openclaw onboard --install-daemon
```

向导会引导你完成：LLM选择 → 聊天通道 → 技能安装 → Gateway守护进程。

---

## 3. 国产大模型接入

### 核心概念

OpenClaw 通过 **Anthropic兼容接口** 对接大模型。智谱GLM提供了Anthropic兼容端点：

```
https://open.bigmodel.cn/anthropic
```

> ⚠️ **红线：严禁直接调用 `https://open.bigmodel.cn/api/paas/v4`（会消耗余额！）**

### 3.1 智谱GLM（推荐）

在 onboard 向导中选择 Anthropic-compatible 提供商，填入：

```
Base URL: https://open.bigmodel.cn/anthropic
API Key: 你的智谱API Key（从 https://open.bigmodel.cn 获取）
Model: glm-5-turbo（主力推荐）
```

或通过命令行：

```bash
openclaw config set models.providers.anthropic.baseUrl "https://open.bigmodel.cn/anthropic"
openclaw config set models.providers.anthropic.apiKey "你的Key"
openclaw config set models.default "glm5turbo"
```

**推荐模型路由：**

| 用途 | 模型 | 说明 |
|------|------|------|
| 日常对话 | glm-5-turbo | 速度+质量平衡 |
| 写代码 | glm-5.1 | 代码生成最强 |
| 深度推演 | glm-5 | 最强推理 |
| 低优先级任务 | glm-4.7 | 省额度 |

### 3.2 通义千问 / 豆包

通义和豆包如果提供Anthropic兼容接口，配置方式相同。否则可通过 `openclaw config set models` 查看支持的提供商列表。

### 3.3 模型故障转移

```bash
openclaw config set models.failover.enabled true
openclaw config set models.failover.chain "glm5turbo,glm4.7"
```

---

## 4. 微信通道接入（重点）

### 4.1 安装微信插件

微信通道通过独立插件 `@tencent-weixin/openclaw-weixin` 提供（**腾讯官方维护**）。

```bash
# 一键安装（推荐）
npx -y @tencent-weixin/openclaw-weixin-cli install

# 或手动安装
openclaw plugins install "@tencent-weixin/openclaw-weixin"
openclaw config set plugins.entries.openclaw-weixin.enabled true
```

**兼容性要求：**

| 插件版本 | OpenClaw 版本 | 状态 |
|---------|--------------|------|
| 2.0.x+ | ≥ 2026.3.22 | 活跃 |
| 1.0.x | 2026.1.0 - 2026.3.21 | Legacy |

### 4.2 扫码登录

```bash
openclaw channels login --channel openclaw-weixin
```

终端会显示二维码，用手机微信扫码确认。登录凭证自动保存到本地。

支持多账号：
```bash
openclaw channels login --channel openclaw-weixin  # 再扫一次 = 新账号
```

### 4.3 多账号上下文隔离

```bash
openclaw config set agents.mode per-channel-per-peer
```

每个「微信账号 + 发消息用户」组合拥有独立的AI记忆。

### 4.4 启动

```bash
openclaw gateway restart
openclaw channels status --probe  # 检查连接状态
```

### 4.5 已知问题与解决

| 问题 | Issue | 状态 | 说明 |
|------|-------|------|------|
| 子Agent/Cron消息无法送达微信 | [#57619](https://github.com/openclaw/openclaw/issues/57619) | Open | 等待修复，主会话正常 |
| 不支持主动推送(BOOT.md场景) | [#52153](https://github.com/openclaw/openclaw/issues/52153) | Open | reply-only模式限制 |
| QR码获取AbortError | — | Open | 检查网络/重试 |
| 中文文档 | [#52099](https://github.com/openclaw/openclaw/pull/52099) | Open | 正在将微信加入官方文档 |

> **重要：微信插件当前是 reply-only 模式**——只能在用户发消息后回复，不能主动推送。Cron定时任务和BOOT.md启动通知无法送达微信。这是腾讯iLink协议的限制，社区workaround存在封号风险，建议等待官方支持。

---

## 5. 常见问题

### npm install 超时

```bash
npm config set registry https://registry.npmmirror.com
npm config set disturl https://npmmirror.com/dist
```

### Gateway 启动失败

```bash
openclaw gateway status    # 查看状态
openclaw gateway logs      # 查看日志
openclaw gateway restart   # 重启
```

### 微信通道显示OK但不收消息

```bash
openclaw config set plugins.entries.openclaw-weixin.enabled true
openclaw channels list
openclaw gateway restart
```

### 内存占用高

```bash
openclaw config set agents.context.compact.enabled true
```

---

## 6. 首次跑通演示

微信中发送以下消息测试：

```
@机器人 你好，介绍一下你自己
@机器人 帮我查一下今天北京的天气
@机器人 写一个Python快速排序
```

---

## 7. 24小时挂机（VPS/Mac mini）

```bash
# 系统守护进程（onboard已自动安装）
openclaw gateway status  # 应显示 running

# PM2（需额外安装）
npm install -g pm2
pm2 start $(which openclaw) --name openclaw -- gateway --port 18789
pm2 save && pm2 startup

# Docker
docker pull ghcr.io/openclaw/openclaw:latest
```

---

## 8. 推荐技能

| 技能 | 用途 | 安装 |
|------|------|------|
| github | GitHub PR/Issue管理 | `clawhub install github` |
| gh-issues | 自动修复GitHub Issue | `clawhub install gh-issues` |
| healthcheck | 服务器安全巡检 | `clawhub install healthcheck` |
| weather | 天气查询 | `clawhub install weather` |

---

## 参考资料

- 📖 官方文档: https://docs.openclaw.ai
- 📖 中文文档: https://docs.openclaw.ai/zh-CN
- 💬 Discord: https://discord.gg/clawd
- 🐛 报告问题: https://github.com/openclaw/openclaw/issues
- 📦 微信插件中文文档: `~/.openclaw/extensions/openclaw-weixin/README.zh_CN.md`
