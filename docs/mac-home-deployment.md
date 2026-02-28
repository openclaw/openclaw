# MacBook Pro M1 家庭部署方案评估

## 概述

OpenClaw 是一个 Node.js 22+ 的多渠道 AI 网关，完全支持在 MacBook Pro M1 上长期运行。本文档评估在国内家庭网络环境下的可行性。

---

## 硬件可行性

### 资源需求

| 项目 | 服务器方案（当前） | MacBook Pro M1 |
|------|-------------------|----------------|
| CPU | 2 核 | 8 核（性能远超） |
| 内存 | 3.7G（Node 堆限制 768MB） | 8G/16G（绰绰有余） |
| 磁盘 | 50G | 256G+（足够） |
| 功耗 | 服务器 24h 约 30-50W | M1 空闲约 3-5W，能效比极高 |

### ARM64 兼容性

纯 Node.js/TypeScript 项目，不依赖 x86 原生代码，M1 零兼容问题。

### 长期运行评估

| 方面 | 评估 |
|------|------|
| **功耗** | 空闲时几乎不耗电，Node.js 待命态 CPU 占用极低 |
| **内存** | 常驻约 200-500MB（视插件/渠道数量） |
| **发热** | 空闲不发热，仅处理消息时短暂占用 CPU |
| **稳定性** | 自带 launchd daemon 管理，崩溃自动重启 |

---

## 网络环境分析

### 动态 IP 影响

**结论：主流通道全部无影响。**

所有主流消息通道默认使用**出站连接**（客户端主动连服务器），不需要固定公网 IP。

| 通道 | 连接方式 | 方向 | 动态 IP 影响 |
|------|----------|------|-------------|
| **Telegram** | Long Polling（默认） | 出站 | 无 |
| **Discord** | WebSocket Gateway | 出站 | 无 |
| **Slack** | Socket Mode（默认） | 出站 | 无 |
| **WhatsApp (Baileys)** | WebSocket | 出站 | 无 |
| **Signal** | 本地 daemon + SSE | 本地 | 无 |
| **iMessage** | 本地 RPC 子进程 | 本地 | 无 |
| **飞书** | WebSocket | 出站 | 无 |
| **Web UI** | 浏览器连 Gateway | 局域网 | 无（localhost 访问） |
| **LINE** | Webhook（仅入站） | 入站 | **有影响**（需公网地址） |

### 与 QQ 通道的对比

| | QQ 机器人 | Telegram 机器人 |
|---|-----------|-----------------|
| 连接模式 | Webhook 回调（腾讯推消息给你） | Long Polling（你主动拉消息） |
| 需要公网 IP | 是 | 否 |
| 需要服务器白名单 | 是（腾讯开放平台要求） | 否 |
| 国内直连 | 是 | 否（需代理） |

### GFW 代理需求

以下服务在国内被墙，需要代理：

- **Anthropic (Claude)** — AI 模型调用
- **Telegram** — 消息通道
- **Discord** — 消息通道
- **Signal** — 消息通道

以下服务国内可直连：

- **OpenRouter** — AI 模型中转（未被墙）
- **飞书** — 消息通道
- **WhatsApp (Baileys)** — 视网络环境而定

代理配置示例（`openclaw.json`）：

```json
{
  "channels": {
    "telegram": {
      "accounts": {
        "default": {
          "token": "<Bot Token>",
          "proxy": "http://127.0.0.1:7890"
        }
      }
    }
  }
}
```

代理指向本地梯子（Clash/V2Ray 等）的 HTTP 代理端口即可。

---

## 安装方式

### 推荐：npm 全局安装 + launchd 守护进程

```bash
# 安装
npm install -g openclaw@latest

# 运行向导（自动配置 launchd 开机自启）
openclaw onboard --install-daemon
```

### launchd 守护进程特性

- 开机自动启动 Gateway
- 崩溃自动重启
- 后台静默运行
- 无需手动管理进程

---

## 需要注意的问题

### 1. 休眠断连

MacBook 合盖后网络会断开，Gateway 掉线。解决方案：

| 方案 | 说明 |
|------|------|
| 外接显示器 | 合盖不休眠（推荐，散热好） |
| 系统设置 | 电池 → 永不休眠 |
| `caffeinate` | 终端运行 `caffeinate -s` 阻止休眠 |
| `pmset` | `sudo pmset -a sleep 0` 禁用休眠 |

### 2. 远程访问 Web UI

如果需要从外部网络访问家里 Mac 上的 Web UI：

| 方案 | 说明 |
|------|------|
| **Tailscale**（推荐） | Gateway 原生支持 `--bind tailnet`，零配置 VPN |
| DDNS | 传统方案，需路由器支持 + 端口映射 |
| 不需要 | 消息走各渠道 App，不一定需要 Web UI |

### 3. 代理稳定性

长期运行需要代理服务本身稳定。建议：

- 使用稳定的代理服务
- 配置 fallback 模型（如 OpenRouter 直连作为备选）
- Telegram 断连后会自动重试（内置指数退避）

---

## 对比：家庭 Mac vs 云服务器

| 维度 | MacBook Pro M1（家庭） | 云服务器（当前 c.leot.fun） |
|------|----------------------|---------------------------|
| 性能 | 远超（8 核 / 8G+） | 2 核 / 3.7G |
| 成本 | 电费 ≈ ¥5/月 | 服务器月租 |
| 网络 | 动态 IP，需本地代理 | 固定 IP，代理已配好 |
| 稳定性 | 依赖家庭网络和电力 | IDC 级别 |
| 维护 | 本地直接操作 | SSH 远程 |
| 公网可达 | 需 Tailscale/DDNS | 天然可达 |

**总结**：如果主要用 Telegram/飞书/WhatsApp 等出站通道，家庭 Mac 方案完全可行且性能更强、成本更低。如果需要 LINE/QQ 等入站 Webhook 通道或稳定的公网访问，云服务器更合适。两者也可以并存互补。
