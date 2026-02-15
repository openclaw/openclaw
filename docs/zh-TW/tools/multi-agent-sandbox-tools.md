---
summary: "個別智慧代理沙箱與工具限制、優先順序及範例"
title: 多智慧代理沙箱與工具
read_when: "當你想在多智慧代理 Gateway 中針對個別智慧代理進行沙箱隔離或工具允許/拒絕政策設定時。"
status: active
---

# 多智慧代理沙箱與工具設定

## 總覽

多智慧代理設定中的每個智慧代理現在都可以擁有各自的：

- **沙箱設定** (`agents.list[].sandbox` 會覆寫 `agents.defaults.sandbox`)
- **工具限制** (`tools.allow` / `tools.deny`，加上 `agents.list[].tools`)

這讓你可以執行具有不同安全層級的多個智慧代理：

- 具有完整權限的個人助理
- 工具受限的家庭/工作智慧代理
- 在沙箱中執行的公開智慧代理

`setupCommand` 屬於 `sandbox.docker` 之下（全域或個別智慧代理），並在容器建立時執行一次。

驗證是針對個別智慧代理的：每個智慧代理都會從其各自 `agentDir` 的憑證儲存庫讀取：

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

憑證**不會**在智慧代理之間共用。切勿在智慧代理之間重複使用 `agentDir`。
如果你想共用憑證，請將 `auth-profiles.json` 複製到另一個智慧代理的 `agentDir` 中。

關於沙箱在執行時期的行為，請參閱 [沙箱隔離](/gateway/sandboxing)。
若要調試「為什麼這個被封鎖了？」，請參閱 [沙箱 vs 工具政策 vs Elevated](/gateway/sandbox-vs-tool-policy-vs-elevated) 以及 `openclaw sandbox explain`。

---

## 設定範例

### 範例 1：個人 + 受限的家庭智慧代理

```json
{
  "agents": {
    "list": [
      {
        "id": "main",
        "default": true,
        "name": "個人助理",
        "workspace": "~/.openclaw/workspace",
        "sandbox": { "mode": "off" }
      },
      {
        "id": "family",
        "name": "家庭機器人",
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
          "id": "120363424282127706 @g.us"
        }
      }
    }
  ]
}
```

**結果：**

- `main` 智慧代理：在主機上執行，擁有完整的工具存取權限
- `family` 智慧代理：在 Docker 中執行（每個智慧代理一個容器），僅限 `read` 工具

---

### 範例 2：具備共用沙箱的工作智慧代理

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

### 範例 2b：全域 Coding Profile + 僅限訊息傳遞的智慧代理

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

- 預設智慧代理取得 Coding 工具
- `support` 智慧代理僅限訊息傳遞（外加 Slack 工具）

---

### 範例 3：智慧代理各別使用不同的沙箱模式

```json
{
  "agents": {
    "defaults": {
      "sandbox": {
        "mode": "non-main", // 全域預設
        "scope": "session"
      }
    },
    "list": [
      {
        "id": "main",
        "workspace": "~/.openclaw/workspace",
        "sandbox": {
          "mode": "off" // 覆寫：main 永不隔離
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // 覆寫：public 一律隔離
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

當同時存在全域 (`agents.defaults.*`) 與智慧代理特定 (`agents.list[].*`) 設定時：

### 沙箱設定

智慧代理特定設定會覆寫全域設定：

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

- `agents.list[].sandbox.{docker,browser,prune}.*` 會針對該智慧代理覆寫 `agents.defaults.sandbox.{docker,browser,prune}.*`（當沙箱範圍解析為 `"shared"` 時會被忽略）。

### 工具限制

篩選順序如下：

1. **工具 Profile** (`tools.profile` 或 `agents.list[].tools.profile`)
2. **供應商工具 Profile** (`tools.byProvider[provider].profile` 或 `agents.list[].tools.byProvider[provider].profile`)
3. **全域工具政策** (`tools.allow` / `tools.deny`)
4. **供應商工具政策** (`tools.byProvider[provider].allow/deny`)
5. **智慧代理特定工具政策** (`agents.list[].tools.allow/deny`)
6. **智慧代理供應商政策** (`agents.list[].tools.byProvider[provider].allow/deny`)
7. **沙箱工具政策** (`tools.sandbox.tools` 或 `agents.list[].tools.sandbox.tools`)
8. **子智慧代理工具政策** (`tools.subagents.tools`，若適用)

每個層級都可以進一步限制工具，但無法重新允許先前層級已拒絕的工具。
如果設定了 `agents.list[].tools.sandbox.tools`，它會取代該智慧代理的 `tools.sandbox.tools`。
如果設定了 `agents.list[].tools.profile`，它會針對該智慧代理覆寫 `tools.profile`。
供應商工具鍵名可接受 `provider`（例如 `google-antigravity`）或 `provider/model`（例如 `openai/gpt-5.2`）。

### 工具群組（簡寫）

工具政策（全域、智慧代理、沙箱）支援 `group:*` 項目，可展開為多個具體工具：

- `group:runtime`: `exec`, `bash`, `process`
- `group:fs`: `read`, `write`, `edit`, `apply_patch`
- `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
- `group:memory`: `memory_search`, `memory_get`
- `group:ui`: `browser`, `canvas`
- `group:automation`: `cron`, `gateway`
- `group:messaging`: `message`
- `group:nodes`: `nodes`
- `group:openclaw`: 所有內建 OpenClaw 工具（不包括供應商外掛）

### Elevated 模式

`tools.elevated` 是全域基準（基於發送者的允許清單）。`agents.list[].tools.elevated` 可以進一步限制特定智慧代理的 Elevated 權限（兩者都必須允許）。

緩解模式：

- 針對不信任的智慧代理拒絕 `exec` (`agents.list[].tools.deny: ["exec"]`)
- 避免將會路由到受限智慧代理的發送者加入允許清單
- 如果你只需要在沙箱中執行，請停用全域 Elevated (`tools.elevated.enabled: false`)
- 針對敏感的智慧代理 Profile 停用個別 Elevated (`agents.list[].tools.elevated.enabled: false`)

---

## 從單一智慧代理遷移

**遷移前（單一智慧代理）：**

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

**遷移後（具有不同 Profile 的多智慧代理）：**

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

舊有的 `agent.*` 設定可透過 `openclaw doctor` 遷移；建議日後使用 `agents.defaults` + `agents.list`。

---

## 工具限制範例

### 唯讀智慧代理

```json
{
  "tools": {
    "allow": ["read"],
    "deny": ["exec", "write", "edit", "apply_patch", "process"]
  }
}
```

### 安全執行智慧代理（不修改檔案）

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### 僅限通訊智慧代理

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

`agents.defaults.sandbox.mode: "non-main"` 是基於 `session.mainKey`（預設為 `"main"`），而不是智慧代理的 ID。群組/頻道的工作階段一律會取得自己的金鑰，因此它們會被視為 non-main 並被沙箱隔離。如果你希望某個智慧代理永遠不使用沙箱，請設定 `agents.list[].sandbox.mode: "off"`。

---

## 測試

在設定完多智慧代理沙箱與工具後：

1. **檢查智慧代理解析：**

   ```exec
   openclaw agents list --bindings
   ```

2. **驗證沙箱容器：**

   ```exec
   docker ps --filter "name=openclaw-sbx-"
   ```

3. **測試工具限制：**
   - 傳送一則需要受限工具的訊息
   - 驗證智慧代理無法使用被拒絕的工具

4. **監控日誌：**

   ```exec
   tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
   ```

---

## 疑難排解

### 即使設定 `mode: "all"`，智慧代理仍未被隔離

- 檢查是否有全域的 `agents.defaults.sandbox.mode` 覆寫了它
- 智慧代理特定設定具有優先權，因此請設定 `agents.list[].sandbox.mode: "all"`

### 工具在拒絕清單中卻仍可用

- 檢查工具篩選順序：全域 → 智慧代理 → 沙箱 → 子智慧代理
- 每個層級只能進一步限制，不能重新授權
- 透過日誌驗證：`[tools] filtering tools for agent:${agentId}`

### 容器未依智慧代理隔離

- 在智慧代理特定沙箱設定中將 `scope` 設為 `"agent"`
- 預設為 `"session"`，這會為每個工作階段建立一個容器

---

## 另請參閱

- [多智慧代理路由](/concepts/multi-agent)
- [沙箱設定](/gateway/configuration#agentsdefaults-sandbox)
- [工作階段管理](/concepts/session)
