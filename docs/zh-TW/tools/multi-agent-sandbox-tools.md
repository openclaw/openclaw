---
summary: "每個代理程式的沙箱與工具限制、優先順序與範例"
title: 多代理程式沙箱與工具
read_when: "You want per-agent sandboxing or per-agent tool allow/deny policies in a multi-agent gateway."
status: active
---

# 多代理程式沙箱與工具設定

## 概覽

在多代理程式設定中，每個代理程式現在都可以擁有自己的：

- **沙箱設定**（`agents.list[].sandbox` 會覆寫 `agents.defaults.sandbox`）
- **工具限制**（`tools.allow` / `tools.deny`，以及 `agents.list[].tools`）

這讓你能以不同的安全設定檔執行多個代理程式：

- 具備完整存取權的個人助理
- 僅允許受限工具的家庭／工作代理程式
- 在沙箱中執行的公開代理程式

`setupCommand` 屬於 `sandbox.docker`（全域或每個代理程式），並且只會在容器建立時執行一次。

身分驗證是以代理程式為單位：每個代理程式都會從各自的 `agentDir` 驗證儲存區讀取，位置在：

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

Credentials are **not** shared between agents. Never reuse `agentDir` across agents.
認證資訊**不會**在代理程式之間共用。請勿在多個代理程式之間重複使用 `agentDir`。
如果你想要共用認證，請將 `auth-profiles.json` 複製到另一個代理程式的 `agentDir` 中。

For how sandboxing behaves at runtime, see [Sandboxing](/gateway/sandboxing).
關於沙箱在執行階段的行為，請參閱 [Sandboxing](/gateway/sandboxing)。
若要除錯「為什麼這個被封鎖？」，請參閱 [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) 與 `openclaw sandbox explain`。

---

## 設定範例

### 範例 1：個人 + 受限的家庭代理程式

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

**結果：**

- `main` 代理程式：在主機上執行，具備完整工具存取權
- `family` 代理程式：在 Docker 中執行（每個代理程式一個容器），僅允許 `read` 工具

---

### 範例 2：共用沙箱的工作代理程式

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

### 範例 2b：全域程式設計設定檔 + 僅限訊息的代理程式

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

**結果：**

- default agents get coding tools
- `support` 代理程式僅限訊息（加上 Slack 工具）

---

### 範例 3：每個代理程式使用不同的沙箱模式

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // Global default
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // Override: main never sandboxed
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // Override: public always sandboxed
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

## 設定優先順序

當同時存在全域（`agents.defaults.*`）與代理程式專屬（`agents.list[].*`）設定時：

### 沙箱設定

代理程式專屬設定會覆寫全域設定：

```
agents.list[].sandbox.mode > agents.defaults.sandbox.mode
agents.list[].sandbox.scope > agents.defaults.sandbox.scope
agents.list[].sandbox.workspaceRoot > agents.defaults.sandbox.workspaceRoot
agents.list[].sandbox.workspaceAccess > agents.defaults.sandbox.workspaceAccess
agents.list[].sandbox.docker.* > agents.defaults.sandbox.docker.*
agents.list[].sandbox.browser.* > agents.defaults.sandbox.browser.*
agents.list[].sandbox.prune.* > agents.defaults.sandbox.prune.*
```

**注意事項：**

- 對該代理程式而言，`agents.list[].sandbox.{docker,browser,prune}.*` 會覆寫 `agents.defaults.sandbox.{docker,browser,prune}.*`（當沙箱範圍解析為 `"shared"` 時會被忽略）。

### 工具限制

篩選順序如下：

1. **工具設定檔**（`tools.profile` 或 `agents.list[].tools.profile`）
2. **提供者工具設定檔**（`tools.byProvider[provider].profile` 或 `agents.list[].tools.byProvider[provider].profile`）
3. **全域工具政策**（`tools.allow` / `tools.deny`）
4. **提供者工具政策**（`tools.byProvider[provider].allow/deny`）
5. **代理程式專屬工具政策**（`agents.list[].tools.allow/deny`）
6. **代理程式提供者政策**（`agents.list[].tools.byProvider[provider].allow/deny`）
7. **沙箱工具政策**（`tools.sandbox.tools` 或 `agents.list[].tools.sandbox.tools`）
8. **子代理程式工具政策**（`tools.subagents.tools`，若適用）

Each level can further restrict tools, but cannot grant back denied tools from earlier levels.
If `agents.list[].tools.sandbox.tools` is set, it replaces `tools.sandbox.tools` for that agent.
If `agents.list[].tools.profile` is set, it overrides `tools.profile` for that agent.
`/exec` 只會改變已授權寄件者的工作階段預設值；它不會授予工具存取權。
Provider 工具鍵可接受 `provider`（例如 `google-antigravity`）或 `provider/model`（例如 `openai/gpt-5.2`）。

### 工具群組（捷徑）

工具政策（全域、代理程式、沙箱）支援 `group:*` 項目，會展開為多個具體工具：

- `group:runtime`：`exec`、`bash`、`process`
- `group:fs`：`read`、`write`、`edit`、`apply_patch`
- `group:sessions`：`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- `group:memory`：`memory_search`、`memory_get`
- `group:ui`：`browser`、`canvas`
- `group:automation`：`cron`、`gateway`
- `group:messaging`：`message`
- `group:nodes`：`nodes`
- `group:openclaw`：所有內建的 OpenClaw 工具（不包含提供者外掛）

### Elevated 模式

`tools.elevated` is the global baseline (sender-based allowlist). `agents.list[].tools.elevated` can further restrict elevated for specific agents (both must allow).

緩解模式：

- 對不受信任的代理程式拒絕 `exec`（`agents.list[].tools.deny: ["exec"]`）
- 避免將會路由到受限代理程式的寄件者加入允許清單
- 若只想要沙箱化執行，請全域停用 Elevated（`tools.elevated.enabled: false`）
- 針對敏感設定檔，對個別代理程式停用 Elevated（`agents.list[].tools.elevated.enabled: false`）

---

## 從單一代理程式遷移

**之前（單一代理程式）：**

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

**之後（具有不同設定檔的多代理程式）：**

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

舊版的 `agent.*` 設定會由 `openclaw doctor` 進行遷移；後續請優先使用 `agents.defaults` + `agents.list`。

---

## 工具限制範例

### Read-only Agent

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### 安全執行代理程式（不修改檔案）

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### Communication-only Agent

```json
{
  "tools": {
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## 常見陷阱：「non-main」

`agents.defaults.sandbox.mode: "non-main"` 是基於 `session.mainKey`（預設為 `"main"`），
而不是代理程式 id。群組／頻道工作階段一律會取得自己的金鑰，
因此會被視為 non-main 並套用沙箱。若你希望某個代理程式永遠不使用沙箱，請設定 `agents.list[].sandbox.mode: "off"`。 Group/channel sessions always get their own keys, so they
are treated as non-main and will be sandboxed. If you want an agent to never
sandbox, set `agents.list[].sandbox.mode: "off"`.

---

## 測試

在設定多代理程式沙箱與工具之後：

1. **檢查代理程式解析：**

   ```exec
   openclaw agents list --bindings
   ```

2. **驗證沙箱容器：**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **測試工具限制：**
   - 傳送需要使用受限工具的訊息
   - 驗證代理程式無法使用被拒絕的工具

4. **監控日誌：**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## Troubleshooting

### 儘管設定了 `mode: "all"`，代理程式仍未進入沙箱

- 檢查是否存在會覆寫它的全域 `agents.defaults.sandbox.mode`
- 代理程式專屬設定具有較高優先順序，因此請設定 `agents.list[].sandbox.mode: "all"`

### 儘管有拒絕清單，工具仍然可用

- 檢查工具篩選順序：全域 → 代理程式 → 沙箱 → 子代理程式
- 每一層只能進一步限制，不能重新授權
- 透過日誌驗證：`[tools] filtering tools for agent:${agentId}`

### 容器未依代理程式進行隔離

- 在代理程式專屬沙箱設定中設定 `scope: "agent"`
- 預設為 `"session"`，會為每個工作階段建立一個容器

---

## See Also

- [Multi-Agent Routing](/concepts/multi-agent)
- [Sandbox Configuration](/gateway/configuration#agentsdefaults-sandbox)
- [Session Management](/concepts/session)
