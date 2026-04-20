---
summary: "向多个代理广播 WhatsApp 消息"
read_when:
  - 配置广播群组
  - 调试 WhatsApp 中的多代理回复
status: experimental
title: "广播群组"
---

# 广播群组

**状态：** 实验性  
**版本：** 2026.1.9 中添加

## 概述

广播群组使多个代理能够同时处理和响应同一条消息。这允许你创建专门的代理团队，在单个 WhatsApp 群组或 DM 中一起工作 — 全部使用一个电话号码。

当前范围：**仅 WhatsApp**（网络通道）。

广播群组在通道允许列表和群组激活规则之后评估。在 WhatsApp 群组中，这意味着当 OpenClaw 通常会回复时（例如：根据你的群组设置，在被提及时）会发生广播。

## 用例

### 1. 专门的代理团队

部署具有原子、专注职责的多个代理：

```
群组："开发团队"
代理：
  - CodeReviewer（审查代码片段）
  - DocumentationBot（生成文档）
  - SecurityAuditor（检查漏洞）
  - TestGenerator（建议测试用例）
```

每个代理处理相同的消息并提供其专门的视角。

### 2. 多语言支持

```
群组："国际支持"
代理：
  - Agent_EN（用英语响应）
  - Agent_DE（用德语响应）
  - Agent_ES（用西班牙语响应）
```

### 3. 质量保证工作流

```
群组："客户支持"
代理：
  - SupportAgent（提供答案）
  - QAAgent（审查质量，仅在发现问题时响应）
```

### 4. 任务自动化

```
群组："项目管理"
代理：
  - TaskTracker（更新任务数据库）
  - TimeLogger（记录花费的时间）
  - ReportGenerator（创建摘要）
```

## 配置

### 基本设置

添加顶级 `broadcast` 部分（与 `bindings` 相邻）。键是 WhatsApp 对等 ID：

- 群组聊天：群组 JID（例如 `120363403215116621@g.us`）
- DMs：E.164 电话号码（例如 `+15551234567`）

```json
{
  "broadcast": {
    "120363403215116621@g.us": ["alfred", "baerbel", "assistant3"]
  }
}
```

**结果：** 当 OpenClaw 在这个聊天中回复时，它将运行所有三个代理。

### 处理策略

控制代理如何处理消息：

#### 并行（默认）

所有代理同时处理：

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

#### 顺序

代理按顺序处理（一个等待前一个完成）：

```json
{
  "broadcast": {
    "strategy": "sequential",
    "120363403215116621@g.us": ["alfred", "baerbel"]
  }
}
```

### 完整示例

```json
{
  "agents": {
    "list": [
      {
        "id": "code-reviewer",
        "name": "Code Reviewer",
        "workspace": "/path/to/code-reviewer",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "security-auditor",
        "name": "Security Auditor",
        "workspace": "/path/to/security-auditor",
        "sandbox": { "mode": "all" }
      },
      {
        "id": "docs-generator",
        "name": "Documentation Generator",
        "workspace": "/path/to/docs-generator",
        "sandbox": { "mode": "all" }
      }
    ]
  },
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": ["code-reviewer", "security-auditor", "docs-generator"],
    "120363424282127706@g.us": ["support-en", "support-de"],
    "+15555550123": ["assistant", "logger"]
  }
}
```

## 工作原理

### 消息流

1. **传入消息** 到达 WhatsApp 群组
2. **广播检查**：系统检查对等 ID 是否在 `broadcast` 中
3. **如果在广播列表中**：
   - 所有列出的代理处理消息
   - 每个代理有自己的会话密钥和隔离的上下文
   - 代理并行（默认）或顺序处理
4. **如果不在广播列表中**：
   - 应用正常路由（第一个匹配的绑定）

注意：广播群组不会绕过通道允许列表或群组激活规则（提及/命令等）。它们只会改变当消息符合处理条件时*哪些代理运行*。

### 会话隔离

广播群组中的每个代理保持完全独立的：

- **会话密钥**（`agent:alfred:whatsapp:group:120363...` vs `agent:baerbel:whatsapp:group:120363...`）
- **对话历史**（代理看不到其他代理的消息）
- **工作区**（如果配置，单独的沙箱）
- **工具访问**（不同的允许/拒绝列表）
- **记忆/上下文**（单独的 IDENTITY.md、SOUL.md 等）
- **群组上下文缓冲区**（用于上下文的最近群组消息）按对等共享，因此所有广播代理在被触发时看到相同的上下文

这允许每个代理具有：

- 不同的个性
- 不同的工具访问（例如，只读 vs. 读写）
- 不同的模型（例如，opus vs. sonnet）
- 安装的不同技能

### 示例：隔离会话

在群组 `120363403215116621@g.us` 中，代理为 `["alfred", "baerbel"]`：

**Alfred 的上下文：**

```
会话：agent:alfred:whatsapp:group:120363403215116621@g.us
历史：[用户消息，alfred 的之前响应]
工作区：/Users/user/openclaw-alfred/
工具：read, write, exec
```

**Bärbel 的上下文：**

```
会话：agent:baerbel:whatsapp:group:120363403215116621@g.us
历史：[用户消息，baerbel 的之前响应]
工作区：/Users/user/openclaw-baerbel/
工具：read only
```

## 最佳实践

### 1. 保持代理专注

为每个代理设计单一、明确的责任：

```json
{
  "broadcast": {
    "DEV_GROUP": ["formatter", "linter", "tester"]
  }
}
```

✅ **好：** 每个代理有一个工作  
❌ **坏：** 一个通用的 "dev-helper" 代理

### 2. 使用描述性名称

明确每个代理的作用：

```json
{
  "agents": {
    "security-scanner": { "name": "Security Scanner" },
    "code-formatter": { "name": "Code Formatter" },
    "test-generator": { "name": "Test Generator" }
  }
}
```

### 3. 配置不同的工具访问

仅授予代理所需的工具：

```json
{
  "agents": {
    "reviewer": {
      "tools": { "allow": ["read", "exec"] } // 只读
    },
    "fixer": {
      "tools": { "allow": ["read", "write", "edit", "exec"] } // 读写
    }
  }
}
```

### 4. 监控性能

对于许多代理，考虑：

- 使用 `"strategy": "parallel"`（默认）以提高速度
- 将广播群组限制为 5-10 个代理
- 为更简单的代理使用更快的模型

### 5. 优雅处理失败

代理独立失败。一个代理的错误不会阻止其他代理：

```
消息 → [Agent A ✓, Agent B ✗ 错误, Agent C ✓]
结果：Agent A 和 C 响应，Agent B 记录错误
```

## 兼容性

### 提供者

广播群组目前适用于：

- ✅ WhatsApp（已实现）
- 🚧 Telegram（计划中）
- 🚧 Discord（计划中）
- 🚧 Slack（计划中）

### 路由

广播群组与现有路由一起工作：

```json
{
  "bindings": [
    {
      "match": { "channel": "whatsapp", "peer": { "kind": "group", "id": "GROUP_A" } },
      "agentId": "alfred"
    }
  ],
  "broadcast": {
    "GROUP_B": ["agent1", "agent2"]
  }
}
```

- `GROUP_A`：只有 alfred 响应（正常路由）
- `GROUP_B`：agent1 和 agent2 响应（广播）

**优先级：** `broadcast` 优先于 `bindings`。

## 故障排除

### 代理不响应

**检查：**

1. 代理 ID 在 `agents.list` 中存在
2. 对等 ID 格式正确（例如 `120363403215116621@g.us`）
3. 代理不在拒绝列表中

**调试：**

```bash
tail -f ~/.openclaw/logs/gateway.log | grep broadcast
```

### 只有一个代理响应

**原因：** 对等 ID 可能在 `bindings` 中但不在 `broadcast` 中。

**修复：** 添加到广播配置或从绑定中删除。

### 性能问题

**如果有许多代理时速度慢：**

- 减少每个群组的代理数量
- 使用更轻的模型（sonnet 而不是 opus）
- 检查沙箱启动时间

## 示例

### 示例 1：代码审查团队

```json
{
  "broadcast": {
    "strategy": "parallel",
    "120363403215116621@g.us": [
      "code-formatter",
      "security-scanner",
      "test-coverage",
      "docs-checker"
    ]
  },
  "agents": {
    "list": [
      {
        "id": "code-formatter",
        "workspace": "~/agents/formatter",
        "tools": { "allow": ["read", "write"] }
      },
      {
        "id": "security-scanner",
        "workspace": "~/agents/security",
        "tools": { "allow": ["read", "exec"] }
      },
      {
        "id": "test-coverage",
        "workspace": "~/agents/testing",
        "tools": { "allow": ["read", "exec"] }
      },
      { "id": "docs-checker", "workspace": "~/agents/docs", "tools": { "allow": ["read"] } }
    ]
  }
}
```

**用户发送：** 代码片段  
**响应：**

- code-formatter: "修复了缩进并添加了类型提示"
- security-scanner: "⚠️ 第 12 行存在 SQL 注入漏洞"
- test-coverage: "覆盖率为 45%，缺少错误案例的测试"
- docs-checker: "缺少函数 `process_data` 的文档字符串"

### 示例 2：多语言支持

```json
{
  "broadcast": {
    "strategy": "sequential",
    "+15555550123": ["detect-language", "translator-en", "translator-de"]
  },
  "agents": {
    "list": [
      { "id": "detect-language", "workspace": "~/agents/lang-detect" },
      { "id": "translator-en", "workspace": "~/agents/translate-en" },
      { "id": "translator-de", "workspace": "~/agents/translate-de" }
    ]
  }
}
```

## API 参考

### 配置架构

```typescript
interface OpenClawConfig {
  broadcast?: {
    strategy?: "parallel" | "sequential";
    [peerId: string]: string[];
  };
}
```

### 字段

- `strategy`（可选）：如何处理代理
  - `"parallel"`（默认）：所有代理同时处理
  - `"sequential"`：代理按数组顺序处理
- `[peerId]`：WhatsApp 群组 JID、E.164 号码或其他对等 ID
  - 值：应该处理消息的代理 ID 数组

## 限制

1. **最大代理数：** 没有硬限制，但 10+ 个代理可能会很慢
2. **共享上下文：** 代理看不到彼此的响应（设计如此）
3. **消息顺序：** 并行响应可能以任何顺序到达
4. **速率限制：** 所有代理都计入 WhatsApp 速率限制

## 未来增强

计划的功能：

- [ ] 共享上下文模式（代理看到彼此的响应）
- [ ] 代理协调（代理可以相互发信号）
- [ ] 动态代理选择（根据消息内容选择代理）
- [ ] 代理优先级（一些代理比其他代理先响应）

## 另请参阅

- [多代理配置](/tools/multi-agent-sandbox-tools)
- [路由配置](/channels/channel-routing)
- [会话管理](/concepts/session)