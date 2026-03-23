# Agents 核心模块详解

> Agent 是 OpenClaw 的"大脑"，负责理解消息、调用工具、生成回复。

## 目录

1. [Agent 概述](#agent-概述)
2. [Agent 架构](#agent-架构)
3. [工具系统](#工具系统)
4. [会话管理](#会话管理)
5. [上下文压缩](#上下文压缩)
6. [认证管理](#认证管理)

---

## Agent 概述

### 什么是 Agent？

**Agent = AI 智能体**

每个 Agent 是：
- 🧠 **独立思考**：有自己的会话和上下文
- 🛠️ **工具使用者**：可以调用各种工具
- 📝 **记忆存储**：维护对话历史
- 🔐 **独立认证**：有自己的 API 密钥

### Agent 类型

| 类型 | 说明 | 适用场景 |
|------|------|----------|
| **Main** | 主 Agent | 个人使用 |
| **Support** | 客服 Agent | 客户服务 |
| **Family** | 家庭 Agent | 家人使用（权限受限） |
| **Dev** | 开发 Agent | 编程辅助 |

---

## Agent 架构

### 组件图

```
Agent
│
├── Core (核心)
│   ├── Message Processor (消息处理)
│   ├── Tool Executor (工具执行)
│   └── Response Generator (回复生成)
│
├── Tools (工具)
│   ├── read/write/edit (文件操作)
│   ├── exec/process (命令执行)
│   ├── browser (浏览器)
│   ├── web_search (网络搜索)
│   └── ... (其他工具)
│
├── Memory (记忆)
│   ├── Session Store (会话存储)
│   ├── Context Buffer (上下文缓冲)
│   └── Compaction (压缩)
│
└── Auth (认证)
    ├── API Keys (API 密钥)
    ├── OAuth Tokens (OAuth 令牌)
    └── Secrets (密钥)
```

---

## 工具系统

### 工具分类

```
工具
│
├── 文件操作
│   ├── read - 读取文件
│   ├── write - 写入文件
│   ├── edit - 编辑文件
│   └── apply_patch - 应用补丁
│
├── 命令执行
│   ├── exec - 执行命令
│   ├── process - 进程管理
│   └── sandbox - 沙箱执行
│
├── 网络
│   ├── browser - 浏览器自动化
│   ├── web_search - 网络搜索
│   └── web_fetch - 网页抓取
│
├── 通信
│   ├── message - 发送消息
│   ├── tts - 语音合成
│   └── email - 邮件
│
└── 其他
    ├── image - 图像分析
    ├── pdf - PDF 处理
    └── cron - 定时任务
```

### 工具权限配置

```json5
{
  "agents": {
    "list": [
      {
        "id": "family",
        "tools": {
          "profile": "messaging",
          "allow": ["read", "web_search"],
          "deny": ["exec", "write", "browser", "process"]
        }
      }
    ]
  }
}
```

---

## 会话管理

### Session Key 结构

```
agent:{agentId}:{channel}:{peerKind}:{peerId}[:thread:{threadId}]

示例：
- agent:main:main                 (DM 默认)
- agent:main:qqbot:direct:123     (QQ 私聊)
- agent:main:qqbot:group:456      (QQ 群)
- agent:main:discord:channel:789:thread:012  (Discord 线程)
```

### 会话存储位置

```
~/.openclaw/
└── agents/
    └── {agentId}/
        └── sessions/
            ├── sessions.json        # 会话列表
            └── transcripts/         # 对话记录
                └── {sessionKey}.jsonl
```

---

## 上下文压缩

### 为什么需要压缩？

- Token 有限制（如 100 万 tokens）
- 对话历史会不断增长
- 压缩可以保留重要信息，删除冗余

### 压缩策略

| 策略 | 说明 | 触发条件 |
|------|------|----------|
| **Safeguard** | 保护性压缩 | 接近上限时 |
| **Auto** | 自动压缩 | 定期执行 |
| **Manual** | 手动压缩 | 用户触发 |

### 压缩配置

```json5
{
  "agents": {
    "defaults": {
      "compaction": {
        "mode": "safeguard",
        "threshold": 0.8,    // 80% 时触发
        "target": 0.5        // 压缩到 50%
      }
    }
  }
}
```

---

## 认证管理

### 认证存储

```
~/.openclaw/agents/{agentId}/agent/
└── auth-profiles.json         # 认证配置
```

### 认证类型

| 类型 | 存储位置 | 说明 |
|------|----------|------|
| **API Key** | auth-profiles.json | 模型 API 密钥 |
| **OAuth** | ~/.openclaw/oauth/ | OAuth 令牌 |
| **Secret** | ~/.openclaw/secrets/ | 敏感信息 |

### 认证隔离

⚠️ **重要**：每个 Agent 的认证是**独立**的！

```
Agent A 的认证 ≠ Agent B 的认证
```

---

*文档版本：1.0 | 更新时间：2026-03-22*
