---
summary: "Per-agent sandbox + tool restrictions, precedence, and examples"
title: Multi-Agent Sandbox & Tools
read_when: >-
  You want per-agent sandboxing or per-agent tool allow/deny policies in a
  multi-agent gateway.
status: active
---

# 多代理沙盒與工具設定

## 概覽

多代理架構中的每個代理現在都可以擁有自己的：

- **沙盒設定** (`agents.list[].sandbox` 會覆蓋 `agents.defaults.sandbox`)
- **工具限制** (`tools.allow` / `tools.deny`，以及 `agents.list[].tools`)

這讓你能夠以不同的安全設定執行多個代理：

- 擁有完整存取權的個人助理
- 工具受限的家庭／工作代理
- 在沙盒中執行的公開代理

`setupCommand` 應該放在 `sandbox.docker`（全域或每個代理）底下，並且在容器建立時執行一次。

認證是以代理為單位：每個代理從自己的 `agentDir` 認證存儲讀取，位置為：

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

憑證**不會**在代理間共享。切勿跨代理重複使用 `agentDir`。
如果你想共享憑證，請將 `auth-profiles.json` 複製到其他代理的 `agentDir`。

關於沙盒在執行時的行為，請參考 [Sandboxing](/gateway/sandboxing)。
若要除錯「為什麼被封鎖？」，請參考 [Sandbox vs Tool Policy vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) 以及 `openclaw sandbox explain`。

---

## 設定範例

### 範例 1：個人 + 受限家庭代理

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

- `main` 代理人：在主機上執行，擁有完整工具存取權限
- `family` 代理人：在 Docker 中執行（每個代理人一個容器），僅限 `read` 工具

---

### 範例 2：具有共用沙盒的工作代理人

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

### 範例 2b：全域程式碼設定檔 + 僅限訊息代理人

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

- 預設代理人會取得程式碼工具
- `support` 代理人僅限訊息功能（+ Slack 工具）

---

### 範例 3：每個代理人的不同沙盒模式

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

當同時存在全域 (`agents.defaults.*`) 和代理專屬 (`agents.list[].*`) 設定時：

### 沙盒設定

代理專屬設定會覆蓋全域設定：

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

- `agents.list[].sandbox.{docker,browser,prune}.*` 會覆蓋該代理的 `agents.defaults.sandbox.{docker,browser,prune}.*`（當沙盒範圍解析為 `"shared"` 時則忽略）。

### 工具限制

過濾順序如下：

1. **工具設定檔** (`tools.profile` 或 `agents.list[].tools.profile`)
2. **供應商工具設定檔** (`tools.byProvider[provider].profile` 或 `agents.list[].tools.byProvider[provider].profile`)
3. **全域工具政策** (`tools.allow` / `tools.deny`)
4. **供應商工具政策** (`tools.byProvider[provider].allow/deny`)
5. **代理專屬工具政策** (`agents.list[].tools.allow/deny`)
6. **代理供應商政策** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **沙盒工具政策** (`tools.sandbox.tools` 或 `agents.list[].tools.sandbox.tools`)
8. **子代理工具政策** (`tools.subagents.tools`，如適用)

每個層級都可以進一步限制工具，但無法恢復先前層級已拒絕的工具。
若設定了 `agents.list[].tools.sandbox.tools`，則會取代該代理的 `tools.sandbox.tools`。
若設定了 `agents.list[].tools.profile`，則會覆蓋該代理的 `tools.profile`。
供應商工具鍵可接受 `provider`（例如 `google-antigravity`）或 `provider/model`（例如 `openai/gpt-5.2`）。

### 工具群組（簡寫）

工具政策（全域、代理、沙盒）支援 `group:*` 條目，可展開為多個具體工具：

- `group:runtime`：`exec`、`bash`、`process`
- `group:fs`：`read`、`write`、`edit`、`apply_patch`
- `group:sessions`：`sessions_list`、`sessions_history`、`sessions_send`、`sessions_spawn`、`session_status`
- `group:memory`：`memory_search`、`memory_get`
- `group:ui`：`browser`、`canvas`
- `group:automation`：`cron`、`gateway`
- `group:messaging`：`message`
- `group:nodes`：`nodes`
- `group:openclaw`：所有內建 OpenClaw 工具（不包含供應商外掛）

### 提升模式

`tools.elevated` 是全域基準（基於發送者的允許清單）。`agents.list[].tools.elevated` 可進一步限制特定代理的提升權限（兩者皆須允許）。

緩解模式：

- 拒絕 `exec` 不受信任的代理 (`agents.list[].tools.deny: ["exec"]`)
- 避免允許清單中包含會路由到受限代理的發送者
- 如果只想要沙盒執行，請全域停用提升權限 (`tools.elevated.enabled: false`)
- 對敏感設定檔，請針對每個代理停用提升權限 (`agents.list[].tools.elevated.enabled: false`)

---

## 從單一代理遷移

**之前（單一代理）：**

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

**之後（多代理搭配不同設定檔）：**

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

舊版 `agent.*` 設定由 `openclaw doctor` 遷移；未來建議使用 `agents.defaults` + `agents.list`。

---

## 工具限制範例

### 只讀代理

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### 安全執行代理（不修改檔案）

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### 僅通訊代理

```json
{
  "tools": {
    "sessions": { "visibility": "tree" },
    "allow": ["sessions_list", "sessions_send", "sessions_history", "session_status"],
    "deny": ["exec", "write", "edit", "apply_patch", "read", "browser"]
  }
}
```

---

## 常見陷阱：「非主要」

`agents.defaults.sandbox.mode: "non-main"` 是基於 `session.mainKey`（預設為 `"main"`），
而非代理 ID。群組/頻道會話總是會有自己的金鑰，因此
它們會被視為非主要並被沙箱隔離。如果你希望代理永遠不被
沙箱隔離，請設定 `agents.list[].sandbox.mode: "off"`。

---

## 測試

在設定多代理沙箱與工具後：

1. **檢查代理解析：**

```exec
   openclaw agents list --bindings
```

2. **確認沙箱容器：**

```exec
   docker ps --filter "name=openclaw-sbx-"
```

3. **測試工具限制：**
   - 傳送需要受限工具的訊息
   - 確認代理無法使用被拒絕的工具

4. **監控日誌：**

```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
```

---

## 疑難排解

### 雖然有 `mode: "all"`，代理仍未被沙箱隔離

- 檢查是否有全域 `agents.defaults.sandbox.mode` 覆蓋設定
- 代理專屬設定優先，請設定 `agents.list[].sandbox.mode: "all"`

### 儘管有拒絕清單，工具仍可使用

- 檢查工具過濾順序：全域 → 代理 → 沙箱 → 子代理
- 每個層級只能進一步限制，無法恢復權限
- 透過日誌確認：`[tools] filtering tools for agent:${agentId}`

### 容器未依代理隔離

- 在代理專屬沙箱設定中設置 `scope: "agent"`
- 預設為 `"session"`，會為每個會話建立一個容器

---

## 參考資料

- [多代理路由](/concepts/multi-agent)
- [沙箱設定](/gateway/configuration#agentsdefaults-sandbox)
- [會話管理](/concepts/session)
