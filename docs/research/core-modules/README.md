# OpenClaw 核心模块文档

> 本文档集合深入解析 OpenClaw 的核心模块，适合开发者和高级用户。

## 文档列表

### 📚 已完成的文档

| 模块 | 文档 | 说明 |
|------|------|------|
| **Gateway** | [gateway.md](./gateway.md) | 核心服务，消息路由、Agent 管理、认证授权 |
| **Agents** | [agents.md](./agents.md) | AI 智能体，工具系统、会话管理、上下文压缩 |
| **Commands** | [commands.md](./commands.md) | 命令系统，CLI 命令、聊天命令、命令解析 |
| **Cron** | [cron.md](./cron.md) | 定时任务，一次性提醒、周期性任务 |
| **Browser** | [browser.md](./browser.md) | 浏览器自动化，导航、操作、截图 |
| **Memory** | [memory.md](./memory.md) | 长期记忆，向量存储、语义搜索 |
| **Infra** | [infra.md](./infra.md) | 基础设施，备份、归档、发现 |

---

## 模块关系图

```
┌─────────────────────────────────────────────────────────┐
│                      OpenClaw System                     │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────┐                                       │
│  │   Commands   │ ← 用户交互入口                        │
│  └──────┬───────┘                                       │
│         │                                                │
│         ▼                                                │
│  ┌──────────────┐                                       │
│  │   Gateway    │ ← 核心服务（心脏）                     │
│  │              │                                        │
│  │  ┌────────┐  │                                       │
│  │  │ Routing│  │                                       │
│  │  └────────┘  │                                       │
│  │  ┌────────┐  │                                       │
│  │  │  Auth  │  │                                       │
│  │  └────────┘  │                                       │
│  │  ┌────────┐  │                                       │
│  │  │ Monitor│  │                                       │
│  │  └────────┘  │                                       │
│  └──────┬───────┘                                       │
│         │                                                │
│    ┌────┴────┐                                          │
│    │         │                                          │
│    ▼         ▼                                          │
│ ┌──────┐  ┌──────┐                                     │
│ │Agents│  │ Cron │                                     │
│ │      │  │      │                                     │
│ │ Tools│  │Tasks │                                     │
│ └──┬───┘  └──────┘                                     │
│    │                                                    │
│    ├──────────┬──────────┬──────────┐                  │
│    │          │          │          │                  │
│    ▼          ▼          ▼          ▼                  │
│ ┌──────┐  ┌──────┐  ┌──────┐  ┌──────┐                │
│ │Browser│  │Memory│  │ Infra │  │Channels│             │
│ │      │  │      │  │       │  │       │              │
│ │自动化 │  │记忆  │  │备份归档│  │消息渠道│             │
│ └──────┘  └──────┘  └──────┘  └──────┘                │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## 快速导航

### 按功能查找

#### 📨 消息处理
- [Gateway](./gateway.md) - 消息路由
- [Channels](../channels-architecture.md) - 渠道接入
- [Agents](./agents.md) - 消息处理

#### 🤖 AI 功能
- [Agents](./agents.md) - AI 智能体
- [Memory](./memory.md) - 长期记忆
- [Browser](./browser.md) - 浏览器自动化

#### ⏰ 定时任务
- [Cron](./cron.md) - 定时任务系统

#### 🛠️ 工具使用
- [Commands](./commands.md) - 命令系统
- [Browser](./browser.md) - 浏览器工具
- [Agents](./agents.md) - 工具系统

#### 💾 数据管理
- [Memory](./memory.md) - 记忆存储
- [Infra](./infra.md) - 备份归档

#### 🔐 安全认证
- [Gateway](./gateway.md) - 认证授权

---

## 学习路径

### 初学者
```
1. 阅读 beginners-guide.md（零基础入门）
2. 了解 Gateway 和 Agents 基本概念
3. 学习配置和使用
```

### 进阶用户
```
1. 阅读 multi-agent-routing.md（路由详解）
2. 阅读 channels-architecture.md（渠道架构）
3. 学习核心模块文档
```

### 开发者
```
1. 阅读所有核心模块文档
2. 阅读 advanced 系列文档
3. 查看源码和 API 文档
```

---

## 相关文档

### 入门系列
- [beginners-guide.md](../beginners-guide.md) - 零基础入门

### 架构系列
- [multi-agent-routing.md](../multi-agent-routing.md) - 路由基础
- [multi-agent-routing-advanced.md](../multi-agent-routing-advanced.md) - 路由高级
- [channels-architecture.md](../channels-architecture.md) - 渠道架构
- [channels-advanced.md](../channels-advanced.md) - 渠道高级

### 核心模块系列
- [gateway.md](./gateway.md)
- [agents.md](./agents.md)
- [commands.md](./commands.md)
- [cron.md](./cron.md)
- [browser.md](./browser.md)
- [memory.md](./memory.md)
- [infra.md](./infra.md)

---

## 贡献指南

### 添加新文档

1. 在对应目录创建 `.md` 文件
2. 遵循文档模板格式
3. 更新此索引文件

### 文档模板

```markdown
# 模块名 核心模块详解

> 一句话说明模块功能

## 目录
1. [概述](#概述)
2. [架构](#架构)
3. [使用](#使用)
4. [配置](#配置)

---

## 概述
...

## 架构
...

## 使用
...

## 配置
...
```

---

## 更新日志

| 日期 | 更新内容 |
|------|----------|
| 2026-03-22 | 初始版本，添加 7 个核心模块文档 |

---

*文档集合版本：1.0*
*更新时间：2026-03-22*
