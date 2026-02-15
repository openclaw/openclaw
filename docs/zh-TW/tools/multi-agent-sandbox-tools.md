```
---
summary: "每個智慧代理的沙箱 + 工具限制、優先順序和範例"
title: 多代理沙箱與工具
read_when: "您希望在多代理 Gateway 中，針對每個智慧代理進行沙箱隔離，或設定每個智慧代理的工具允許/拒絕政策。"
status: active
---

# 多代理沙箱與工具設定

## 概述

在多代理設定中，每個智慧代理現在都可以擁有自己的：

-   **沙箱設定** (`agents.list[].sandbox` 會覆寫 `agents.defaults.sandbox`)
-   **工具限制** (`tools.allow` / `tools.deny`，加上 `agents.list[].tools`)

這讓您能夠以不同的安全設定檔執行多個智慧代理：

-   具有完整存取權的個人助理
-   具有受限工具的家庭/工作智慧代理
-   在沙箱中運行的公開智慧代理

`setupCommand` 位於 `sandbox.docker` (全域或每個智慧代理) 下，並在容器建立時執行一次。

憑證是針對每個智慧代理設定的：每個智慧代理都會從其自己的 `agentDir` 憑證儲存中讀取，路徑位於：

```
~/.openclaw/agents/<agentId>/agent/auth-profiles.json
```

憑證**不會**在智慧代理之間共用。切勿在不同智慧代理之間重複使用 `agentDir`。
如果您想共用憑證，請將 `auth-profiles.json` 複製到另一個智慧代理的 `agentDir` 中。

關於沙箱隔離在執行時的行為，請參閱 [沙箱隔離](/gateway/sandboxing)。
關於偵錯「為何此項目被封鎖？」，請參閱 [沙箱與工具政策與提升權限](/gateway/sandbox-vs-tool-policy-vs-elevated) 以及 `openclaw sandbox explain`。

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
          "id": "120363424282127706 @g.us"
        }
      }
    }
  ]
}
```

**結果：**

-   `main` 智慧代理：在主機上執行，擁有完整的工具存取權
-   `family` 智慧代理：在 Docker 中執行 (每個智慧代理一個容器)，僅限 `read` 工具

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

### 範例 2b：全域程式碼設定檔 + 僅訊息智慧代理

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

-   預設智慧代理取得程式碼工具
-   `support` 智慧代理僅限訊息 (+ Slack 工具)

---

### 範例 3：每個智慧代理使用不同的沙箱模式

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
          "mode": "off" // 覆寫：main 永不進行沙箱隔離
        }
      },
      {
        "id": "public",
        "workspace": "~/.openclaw/workspace-public",
        "sandbox": {
          "mode": "all", // 覆寫：public 始終進行沙箱隔離
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

當全域 (`agents.defaults.*`) 和智慧代理特定 (`agents.list[].*`) 設定同時存在時：

### 沙箱設定

智慧代理特定的設定會覆寫全域設定：

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

-   `agents.list[].sandbox.{docker,browser,prune}.*` 會覆寫該智慧代理的 `agents.defaults.sandbox.{docker,browser,prune}.*` (當沙箱範圍解析為 `"shared"` 時會忽略)。

### 工具限制

篩選順序為：

1.  **工具設定檔** (`tools.profile` 或 `agents.list[].tools.profile`)
2.  **供應商工具設定檔** (`tools.byProvider[provider].profile` 或 `agents.list[].tools.byProvider[provider].profile`)
3.  **全域工具政策** (`tools.allow` / `tools.deny`)
4.  **供應商工具政策** (`tools.byProvider[provider].allow/deny`)
5.  **智慧代理特定工具政策** (`agents.list[].tools.allow/deny`)
6.  **智慧代理供應商政策** (`agents.list[].tools.byProvider[provider].allow/deny`)
7.  **沙箱工具政策** (`tools.sandbox.tools` 或 `agents.list[].tools.sandbox.tools`)
8.  **子代理工具政策** (`tools.subagents.tools`，如果適用)

每個層級都可以進一步限制工具，但不能重新授予先前層級已拒絕的工具。
如果設定了 `agents.list[].tools.sandbox.tools`，它會取代該智慧代理的 `tools.sandbox.tools`。
如果設定了 `agents.list[].tools.profile`，它會覆寫該智慧代理的 `tools.profile`。
供應商工具鍵接受 `provider` (例如 `google-antigravity`) 或 `provider/model` (例如 `openai/gpt-5.2`)。

### 工具群組 (簡寫)

工具政策 (全域、智慧代理、沙箱) 支援展開為多個具體工具的 `group:*` 項目：

-   `group:runtime`: `exec`, `bash`, `process`
-   `group:fs`: `read`, `write`, `edit`, `apply_patch`
-   `group:sessions`: `sessions_list`, `sessions_history`, `sessions_send`, `sessions_spawn`, `session_status`
-   `group:memory`: `memory_search`, `memory_get`
-   `group:ui`: `browser`, `canvas`
-   `group:automation`: `cron`, `gateway`
-   `group:messaging`: `message`
-   `group:nodes`: `nodes`
-   `group:openclaw`: 所有內建的 OpenClaw 工具 (不包括供應商插件)

### 提升權限模式

`tools.elevated` 是全域基準 (基於發送者的允許清單)。`agents.list[].tools.elevated` 可以進一步限制特定智慧代理的提升權限 (兩者都必須允許)。

緩解模式：

-   拒絕不受信任智慧代理的 `exec` (`agents.list[].tools.deny: ["exec"]`)
-   避免允許清單中包含路由至受限智慧代理的發送者
-   全域停用提升權限 (`tools.elevated.enabled: false`)，如果您只希望執行沙箱隔離
-   針對每個智慧代理停用提升權限 (`agents.list[].tools.elevated.enabled: false`) 以用於敏感設定檔

---

## 從單一代理遷移

**之前 (單一代理)：**

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

**之後 (具有不同設定檔的多代理)：**

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

舊版 `agent.*` 設定透過 `openclaw doctor` 進行遷移；未來請優先使用 `agents.defaults` + `agents.list`。

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

### 安全執行智慧代理 (不修改檔案)

```json
{
  "tools": {
    "allow": ["read", "exec", "process"],
    "deny": ["write", "edit", "apply_patch", "browser", "gateway"]
  }
}
```

### 僅限通訊的智慧代理

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

`agents.defaults.sandbox.mode: "non-main"` 是基於 `session.mainKey` (預設為 `"main"`)，
而不是智慧代理 ID。群組/頻道工作階段始終會取得自己的鍵，因此它們會被視為非 main 並將進行沙箱隔離。如果您希望智慧代理永不進行沙箱隔離，請設定 `agents.list[].sandbox.mode: "off"`。

---

## 測試

設定多代理沙箱和工具後：

1.  **檢查智慧代理解析：**

    ```exec
    openclaw agents list --bindings
    ```

2.  **驗證沙箱容器：**

    ```exec
    docker ps --filter "name=openclaw-sbx-"
    ```

3.  **測試工具限制：**
    -   發送需要受限工具的訊息
    -   驗證智慧代理無法使用被拒絕的工具

4.  **監控日誌：**

    ```exec
    tail -f "${OPENCLAW_STATE_DIR:-$HOME/.openclaw}/logs/gateway.log" | grep -E "routing|sandbox|tools"
    ```

---

## 疑難排解

### 智慧代理未進行沙箱隔離，儘管 `mode: "all"`

-   檢查是否有全域的 `agents.defaults.sandbox.mode` 覆寫它
-   智慧代理特定設定具有優先權，因此請設定 `agents.list[].sandbox.mode: "all"`

### 儘管在拒絕清單中，工具仍然可用

-   檢查工具篩選順序：全域 → 智慧代理 → 沙箱 → 子代理
-   每個層級只能進一步限制，不能重新授予
-   透過日誌驗證：`[tools] filtering tools for agent:${agentId}`

### 容器未依智慧代理隔離

-   在智慧代理特定的沙箱設定中設定 `scope: "agent"`
-   預設為 `"session"`，它會為每個工作階段建立一個容器

---

## 參閱

-   [多代理路由](/concepts/multi-agent)
-   [沙箱設定](/gateway/configuration#agentsdefaults-sandbox)
-   [工作階段管理](/concepts/session)
```
