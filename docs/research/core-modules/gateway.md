# Gateway 核心模块详解

> Gateway 是 OpenClaw 的心脏，负责消息路由、Agent 管理、认证授权等核心功能。

## 目录

1. [Gateway 概述](#gateway-概述)
2. [核心架构](#核心架构)
3. [消息处理流程](#消息处理流程)
4. [认证与授权](#认证与授权)
5. [Agent 管理](#agent-管理)
6. [Channel 健康监控](#channel-健康监控)
7. [配置与启动](#配置与启动)

---

## Gateway 概述

### 什么是 Gateway？

**Gateway = OpenClaw 的核心服务**

它是：
- 📨 **消息中枢**：所有消息的进出通道
- 🤖 **Agent 管理器**：管理多个 AI Agent 实例
- 🔐 **安全网关**：认证、授权、限流
- 📊 **监控中心**：健康检查、状态报告

### Gateway 的位置

```
┌─────────────────────────────────────────────────────────┐
│                    外部世界                              │
│    (QQ/微信/Telegram/Discord/...)                       │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│                   Gateway (核心服务)                     │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐          │
│  │ 消息路由  │  │ Agent 管理 │  │ 认证授权  │          │
│  └───────────┘  └───────────┘  └───────────┘          │
│  ┌───────────┐  ┌───────────┐  ┌───────────┐          │
│  │ Channel   │  │ 会话管理  │  │ 监控日志  │          │
│  │ 健康监控  │  │           │  │           │          │
│  └───────────┘  └───────────┘  └───────────┘          │
└────────────────────┬────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────┐
│                    AI Agents                             │
│    (main/support/family/...)                            │
└─────────────────────────────────────────────────────────┘
```

---

## 核心架构

### Gateway 组件图

```
Gateway
│
├── Server (HTTP/WebSocket 服务器)
│   ├── RPC Methods (远程调用)
│   ├── WebSocket (实时通信)
│   └── Health Check (健康检查)
│
├── Routing Engine (路由引擎)
│   ├── Binding Matcher (绑定匹配)
│   ├── Session Resolver (会话解析)
│   └── Account Lookup (账号查找)
│
├── Agent Manager (Agent 管理器)
│   ├── Spawn (启动 Agent)
│   ├── Lifecycle (生命周期管理)
│   └── Concurrency (并发控制)
│
├── Auth System (认证系统)
│   ├── API Key (API 密钥)
│   ├── OAuth (OAuth 认证)
│   ├── Rate Limit (限流)
│   └── Allowlist (白名单)
│
├── Channel Monitor (Channel 监控)
│   ├── Health Check (健康检查)
│   ├── Auto Restart (自动重启)
│   └── Status Report (状态报告)
│
└── Session Store (会话存储)
    ├── In-Memory (内存)
    ├── Disk-Backed (磁盘持久化)
    └── Compaction (压缩)
```

### 核心文件结构

```
src/gateway/
├── boot.ts                    # 启动引导
├── call.ts                    # RPC 调用处理
├── auth.ts                    # 认证系统
├── auth-rate-limit.ts         # 限流策略
├── agent-list.ts              # Agent 列表管理
├── agent-prompt.ts            # Agent 提示词
├── assistant-identity.ts      # 助手身份
├── channel-health-monitor.ts  # Channel 健康监控
├── channel-health-policy.ts   # 健康策略
├── server-methods/            # RPC 方法
│   ├── agent-*.ts             # Agent 相关方法
│   ├── channel-*.ts           # Channel 相关方法
│   ├── session-*.ts           # 会话相关方法
│   └── ...
└── server.ts                  # 服务器主逻辑
```

---

## 消息处理流程

### Inbound 消息流程

```
1. Channel 接收消息
       │
       ▼
2. 构建 Inbound Envelope
       │
       ▼
3. Gateway 接收 (call.ts)
       │
       ▼
4. 认证检查 (auth.ts)
   ├─ API Key 验证
   ├─ 限流检查
   └─ Allowlist 检查
       │
       ▼
5. 路由解析 (Routing Engine)
   ├─ 匹配 Binding
   ├─ 确定 Agent
   └─ 构建 Session Key
       │
       ▼
6. Agent 处理
   ├─ 加载会话上下文
   ├─ 调用 AI 模型
   └─ 生成回复
       │
       ▼
7. 回复发送
   ├─ 通过 Channel 发送
   └─ 记录会话历史
```

---

## 认证与授权

### 认证方式

| 方式 | 说明 | 适用场景 |
|------|------|----------|
| **API Key** | 静态密钥 | 服务间调用 |
| **OAuth** | OAuth 2.0 流程 | 用户授权 |
| **Session Token** | 会话令牌 | 短期访问 |
| **mTLS** | 双向 TLS | 高安全场景 |

### Allowlist 配置

```json5
{
  "channels": {
    "qqbot": {
      "enabled": true,
      "allowFrom": [
        "916B305E4F4944B5FD434D62EBC439CF",
        "FAMILY_GROUP_ID"
      ]
    }
  }
}
```

---

## Agent 管理

### Agent 生命周期

```
启动 → 初始化 → 就绪 → 处理消息 → 健康检查 → [重启/停止]
```

### 并发控制配置

```json5
{
  "agents": {
    "maxConcurrent": 4,
    "defaults": { "maxConcurrent": 2 },
    "list": [
      { "id": "main", "maxConcurrent": 4 },
      { "id": "support", "maxConcurrent": 8 }
    ]
  }
}
```

---

## Channel 健康监控

### 监控指标

| 指标 | 说明 | 告警阈值 |
|------|------|----------|
| Connection Status | 连接状态 | Disconnected |
| Message Latency | 消息延迟 | > 5s |
| Error Rate | 错误率 | > 5% |
| Last Activity | 最后活动 | > 5min |

---

## 配置与启动

### 启动命令

```bash
# 启动
openclaw gateway start

# 查看状态
openclaw gateway status

# 重启
openclaw gateway restart

# 查看日志
openclaw gateway logs --tail 100
```

---

*文档版本：1.0 | 更新时间：2026-03-22*
