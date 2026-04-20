---
summary: "每个代理的沙箱 + 工具限制、优先级和示例"
title: 多代理沙箱与工具
read_when: "您希望在多代理网关中使用每个代理的沙箱或每个代理的工具允许/拒绝策略。"
status: active
---

# 多代理沙箱与工具配置

多代理设置中的每个代理都可以覆盖全局沙箱和工具策略。本页面涵盖了每个代理的配置、优先级规则和示例。

- **沙箱后端和模式**：请参阅 [沙箱](/gateway/sandboxing)。
- **调试被阻止的工具**：请参阅 [沙箱 vs 工具策略 vs 提升模式](/gateway/sandbox-vs-tool-policy-vs-elevated) 和 `openclaw sandbox explain`。
- **提升执行**：请参阅 [提升模式](/tools/elevated)。

身份验证是每个代理的：每个代理从其自己的 `agentDir` 身份验证存储中读取，位于 `~/.openclaw/agents/<agentId>/agent/auth-profiles.json`。
凭据**不会**在代理之间共享。切勿在代理之间重用 `agentDir`。
如果您想共享凭据，请将 `auth-profiles.json` 复制到另一个代理的 `agentDir` 中。

---

## 配置示例

### 示例 1：个人 + 受限制的家庭代理

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

- `main` 代理：在主机上运行，完全工具访问权限
- `family` 代理：在 Docker 中运行（每个代理一个容器），仅 `read` 工具

---

### 示例 2：带有共享沙箱的工作代理

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

### 示例 2b：全局编码配置文件 + 仅消息代理

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

- 默认代理获得编码工具
- `support` 代理仅消息传递（+ Slack 工具）

---

### 示例 3：每个代理不同的沙箱模式

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // 全局默认
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // 覆盖：main 永远不沙箱
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // 覆盖：public 始终沙箱
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

当全局（`agents.defaults.*`）和代理特定（`agents.list[].*`）配置都存在时：

### 沙箱配置

代理特定设置覆盖全局：

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**注意：**

- `agents.list[].sandbox.{docker,browser,prune}.*` 覆盖该代理的 `agents.defaults.sandbox.{docker,browser,prune}.*`（当沙箱范围解析为 `"shared"` 时忽略）。

### 工具限制

过滤顺序为：

1. **工具配置文件**（`tools.profile` 或 `agents.list[].tools.profile`）
2. **提供者工具配置文件**（`tools.byProvider[provider].profile` 或 `agents.list[].tools.byProvider[provider].profile`）
3. **全局工具策略**（`tools.allow` / `tools.deny`）
4. **提供者工具策略**（`tools.byProvider[provider].allow/deny`）
5. **代理特定工具策略**（`agents.list[].tools.allow/deny`）
6. **代理提供者策略**（`agents.list[].tools.byProvider[provider].allow/deny`）
7. **沙箱工具策略**（`tools.sandbox.tools` 或 `agents.list[].tools.sandbox.tools`）
8. **子代理工具策略**（`tools.subagents.tools`，如适用）

每个级别可以进一步限制工具，但不能从早期级别授予已拒绝的工具。
如果设置了 `agents.list[].tools.sandbox.tools`，它会替换该代理的 `tools.sandbox.tools`。
如果设置了 `agents.list[].tools.profile`，它会覆盖该代理的 `tools.profile`。
提供者工具键接受 `provider`（例如 `google-antigravity`）或 `provider/model`（例如 `openai/gpt-5.4`）。

工具策略支持扩展为多个工具的 `group:*` 简写。有关完整列表，请参阅 [工具组](/gateway/sandbox-vs-tool-policy-vs-elevated#tool-groups-shorthands)。

每个代理的提升覆盖（`agents.list[].tools.elevated`）可以进一步限制特定代理的提升执行。有关详细信息，请参阅 [提升模式](/tools/elevated)。

---

## 从单代理迁移

**之前（单代理）：**

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

**之后（具有不同配置文件的多代理）：**

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

旧版 `agent.*` 配置由 `openclaw doctor` 迁移；未来请使用 `agents.defaults` + `agents.list`。

---

## 工具限制示例

### 只读代理

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### 安全执行代理（无文件修改）

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### 仅通信代理

```json
{
  "tools": {
    "sessions": { "visibility": "tree" },
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

此配置文件中的 `sessions_history` 仍然返回有界、经过清理的回忆视图，而不是原始转录转储。助手回忆在编辑/截断之前会去除思考标签、`<relevant-memories>` 脚手架、纯文本工具调用 XML 有效载荷（包括 `<tool_call>...</tool_call>`、`<function_call>...</function_call>`、`<tool_calls>...</tool_calls>`、`<function_calls>...</function_calls>` 和截断的工具调用块）、降级的工具调用脚手架、泄漏的 ASCII/全宽模型控制令牌以及格式错误的 MiniMax 工具调用 XML。

---

## 常见陷阱："non-main"

`agents.defaults.sandbox.mode: "non-main"` 基于 `session.mainKey`（默认 `"main"`），而不是代理 ID。群组/通道会话总是获得自己的键，因此它们被视为非主会话并将被沙箱。如果您希望代理永远不沙箱，请设置 `agents.list[].sandbox.mode: "off"`。

---

## 测试

配置多代理沙箱和工具后：

1. **检查代理解析：**

   ```exec
   openclaw agents list --bindings
   ```

2. **验证沙箱容器：**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **测试工具限制：**
   - 发送需要受限制工具的消息
   - 验证代理不能使用被拒绝的工具

4. **监控日志：**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## 故障排除

### 尽管设置了 `mode: "all"`，代理仍未沙箱

- 检查是否存在覆盖它的全局 `agents.defaults.sandbox.mode`
- 代理特定配置优先，因此设置 `agents.list[].sandbox.mode: "all"`

### 尽管有拒绝列表，工具仍然可用

- 检查工具过滤顺序：全局 → 代理 → 沙箱 → 子代理
- 每个级别只能进一步限制，不能授予回
- 用日志验证：`[tools] filtering tools for agent:${agentId}`

### 容器未按代理隔离

- 在代理特定沙箱配置中设置 `scope: "agent"`
- 默认是 `"session"`，每个会话创建一个容器

---

## 另请参阅

- [沙箱](/gateway/sandboxing) -- 完整沙箱参考（模式、范围、后端、镜像）
- [沙箱 vs 工具策略 vs 提升模式](/gateway/sandbox-vs-tool-policy-vs-elevated) -- 调试 "为什么这被阻止？"
- [提升模式](/tools/elevated)
- [多代理路由](/concepts/multi-agent)
- [沙箱配置](/gateway/configuration-reference#agentsdefaultssandbox)
- [会话管理](/concepts/session)