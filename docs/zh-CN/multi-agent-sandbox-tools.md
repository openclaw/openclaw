---
read_when: You want per-agent sandboxing or per-agent tool allow/deny policies in a multi-agent gateway.
status: active
summary: 每个智能体的沙箱与工具限制、优先级及示例
title: 多智能体沙箱与工具
x-i18n:
  generated_at: "2026-02-01T21:17:27Z"
  model: claude-opus-4-5
  provider: pi
  source_hash: f602cb6192b84b404cd7b6336562888a239d0fe79514edd51bd73c5b090131ef
  source_path: multi-agent-sandbox-tools.md
  workflow: 15
---

# 多智能体沙箱与工具配置

## 概述

在多智能体设置中，每个智能体现在可以拥有独立的：

- **沙箱配置**（`agents.list[].sandbox` 覆盖 `agents.defaults.sandbox`）
- **工具限制**（`tools.allow` / `tools.deny`，以及 `agents.list[].tools`）

这允许你运行具有不同安全配置的多个智能体：

- 拥有完全访问权限的个人助手
- 工具受限的家庭/工作智能体
- 在沙箱中运行的面向公众的智能体

`setupCommand` 属于 `sandbox.docker`（全局或每个智能体），在容器创建时运行一次。

认证是按智能体隔离的：每个智能体从其自己的 `agentDir` 认证存储中读取：

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

凭据**不会**在智能体之间共享。切勿在智能体之间复用 `agentDir`。
如果你想共享凭据，请将 `auth-profiles.json` 复制到其他智能体的 `agentDir` 中。

有关沙箱在运行时的行为，请参阅[沙箱](/gateway/sandboxing)。
有关调试"为什么被阻止了？"，请参阅[沙箱 vs 工具策略 vs 提权](/gateway/sandbox-vs-tool-policy-vs-elevated)和 `openclaw sandbox explain`。

---

## 配置示例

### 示例 1：个人助手 + 受限家庭智能体

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "Personal Assistant",
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "family",
        "name": "Family Bot",
        "workspace": "~/.openclaw/workspace-family",
        "sandbox": {
          "mode": "all",
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch", "process", "browser"]
        }
      }
    ]
  },
  "bindings": [
    {
      "agentId": "family",
      "match": {
        "provider": "whatsapp",
        "accountId": "*",
        "peer": {
          "kind": "group",
          "id": "120363424282127706@g.us"
        }
      }
    }
  ]
}
```

**结果：**

- `main` 智能体：在宿主机上运行，拥有完全工具访问权限
- `family` 智能体：在 Docker 中运行（每个智能体一个容器），仅有 `read` 工具

---

### 示例 2：使用共享沙箱的工作智能体

```json
{
  "agents": {
    "list": [
      {
        "id": "personal",
        "workspace": "~/.openclaw/workspace-personal",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "work",
        "workspace": "~/.openclaw/workspace-work",
        "sandbox": {
          "mode": "all",
          "scope": "shared",
          "workspaceRoot": "/tmp/work-sandboxes"
        },
        "tools": {
          "allow": ["read", "write", "apply_patch", "exec"],
          "deny": ["browser", "gateway", "discord"]
        }
      }
    ]
  }
}
```

---

### 示例 2b：全局编程配置 + 仅消息传递的智能体

```json
{
  "tools": { "profile": "coding" },
  "agents": {
    "list": [
      {
        "id": "support",
        "tools": { "profile": "messaging", "allow": ["slack"] }
      }
    ]
  }
}
```

**结果：**

- 默认智能体获得编程工具
- `support` 智能体仅限消息传递（+ Slack 工具）

---

### 示例 3：每个智能体不同的沙箱模式

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // 全局默认值
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // 覆盖：main 永不沙箱隔离
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // 覆盖：public 始终沙箱隔离
          "scope": "agent"
        },
        "tools": {
          "allow": ["read"],
          "deny": ["exec", "write", "edit", "apply_patch"]
        }
      }
    ]
  }
}
```

---

## 配置优先级

当全局配置（`agents.defaults.*`）和智能体特定配置（`agents.list[].*`）同时存在时：

### 沙箱配置

智能体特定设置覆盖全局设置：

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**注意事项：**

- `agents.list[].sandbox.{docker,browser,prune}.*` 会覆盖该智能体的 `agents.defaults.sandbox.{docker,browser,prune}.*`（当沙箱范围解析为 `"shared"` 时忽略）。

### 工具限制

过滤顺序为：

1. **工具配置**（`tools.profile` 或 `agents.list[].tools.profile`）
2. **提供商工具配置**（`tools.byProvider[provider].profile` 或 `agents.list[].tools.byProvider[provider].profile`）
3. **全局工具策略**（`tools.allow` / `tools.deny`）
4. **提供商工具策略**（`tools.byProvider[provider].allow/deny`）
5. **智能体特定工具策略**（`agents.list[].tools.allow/deny`）
6. **智能体提供商策略**（`agents.list[].tools.byProvider[provider].allow/deny`）
7. **沙箱工具策略**（`tools.sandbox.tools` 或 `agents.list[].tools.sandbox.tools`）
8. **子智能体工具策略**（`tools.subagents.tools`，如适用）

每一层可以进一步限制工具，但不能恢复在前面层级中已被拒绝的工具。
如果设置了 `agents.list[].tools.sandbox.tools`，它会替换该智能体的 `tools.sandbox.tools`。
如果设置了 `agents.list[].tools.profile`，它会覆盖该智能体的 `tools.profile`。
提供商工具键接受 `provider`（例如 `google-antigravity`）或 `provider/model`（例如 `openai/gpt-5.2`）。

### 工具组（简写）

工具策略（全局、智能体、沙箱）支持 `group:*` 条目，它们会展开为多个具体工具：

- `group:runtime`：`exec`、`bash`、`process`
- `group:fs`：`read`、`write`、`edit`、`apply_patch`
- `group:sessions`：`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- `group:memory`：`memory_search`、`memory_get`
- `group:ui`：`browser`、`canvas`
- `group:automation`：`cron`、`gateway`
- `group:messaging`：`message`
- `group:nodes`：`nodes`
- `group:openclaw`：所有内置 OpenClaw 工具（不包括提供商插件）

### 提权模式

`tools.elevated` 是全局基线（基于发送者的允许列表）。`agents.list[].tools.elevated` 可以进一步限制特定智能体的提权（两者都必须允许）。

缓解模式：

- 对不受信任的智能体拒绝 `exec`（`agents.list[].tools.deny: ["exec"]`）
- 避免将发送者加入允许列表后路由到受限智能体
- 如果你只需要沙箱隔离执行，可全局禁用提权（`tools.elevated.enabled: false`）
- 对敏感配置按智能体禁用提权（`agents.list[].tools.elevated.enabled: false`）

---

## 从单智能体迁移

**之前（单智能体）：**

```json
{
  "agents": {
    "defaults": {
      "workspace": "~/.openclaw/workspace",
      "sandbox": {
        "mode": "non-main"
      }
    }
  },
  "tools": {
    "sandbox": {
      "tools": {
        "allow": ["read", "write", "apply_patch", "exec"],
        "deny": []
      }
    }
  }
}
```

**之后（具有不同配置的多智能体）：**

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      }
    ]
  }
}
```

旧版 `agent.*` 配置会由 `openclaw doctor` 迁移；今后请优先使用 `agents.defaults` + `agents.list`。

---

## 工具限制示例

### 只读智能体

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### 安全执行智能体（无文件修改）

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### 仅通信智能体

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## 常见陷阱："non-main"

`agents.defaults.sandbox.mode: "non-main"` 基于 `session.mainKey`（默认为 `"main"`），
而不是智能体 ID。群组/渠道会话总是获得自己的键，因此它们被视为非主会话并将被沙箱隔离。如果你希望某个智能体永不沙箱隔离，请设置 `agents.list[].sandbox.mode: "off"`。

---

## 测试

配置多智能体沙箱和工具后：

1. **检查智能体路由解析：**

   ```exec
   openclaw agents list --bindings
   ```

2. **验证沙箱容器：**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **测试工具限制：**
   - 发送一条需要受限工具的消息
   - 验证智能体无法使用被拒绝的工具

4. **监控日志：**
   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## 故障排除

### 尽管设置了 `mode: "all"`，智能体未被沙箱隔离

- 检查是否有全局 `agents.defaults.sandbox.mode` 覆盖了它
- 智能体特定配置优先级更高，因此请设置 `agents.list[].sandbox.mode: "all"`

### 尽管设置了拒绝列表，工具仍然可用

- 检查工具过滤顺序：全局 → 智能体 → 沙箱 → 子智能体
- 每一层只能进一步限制，不能恢复已拒绝的工具
- 通过日志验证：`[tools] filtering tools for agent:${agentId}`

### 容器未按智能体隔离

- 在智能体特定沙箱配置中设置 `scope: "agent"`
- 默认值为 `"session"`，即每个会话创建一个容器

---

## 另请参阅

- [多智能体路由](/concepts/multi-agent)
- [沙箱配置](/gateway/configuration#agentsdefaults-sandbox)
- [会话管理](/concepts/session)
