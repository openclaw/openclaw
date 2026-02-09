---
summary: "Refactor plan: exec host routing, node approvals, and headless runner"
read_when:
  - 設計 exec 主機路由或 exec 核准時
  - 實作節點 runner + UI IPC
  - 新增 exec 主機安全模式與斜線指令
title: "Exec Host Refactor"
---

# Exec host refactor plan

## 目標

- 新增 `exec.host` + `exec.security`，將執行路由到 **sandbox**、**Gateway 閘道器** 與 **node**。
- 保持預設 **安全**：除非明確啟用，否則不進行跨主機執行。
- 將執行拆分為 **無介面 runner 服務**，並透過本機 IPC 提供選用 UI（macOS 應用程式）。
- 提供 **每個 agent** 的政策、允許清單、詢問模式與節點綁定。
- 支援可 **搭配** 或 **不搭配** 允許清單的 **詢問模式**。
- 跨平台：Unix socket + 權杖驗證（macOS/Linux/Windows 同等）。

## 非目標

- No legacy allowlist migration or legacy schema support.
- 不為 node exec 提供 PTY/串流（僅彙總輸出）。
- 不新增現有 Bridge + Gateway 閘道器 之外的網路層。

## 決策（已鎖定）

- **設定鍵：** `exec.host` + `exec.security`（允許每個 agent 覆寫）。
- **提升權限：** 保留 `/elevated` 作為 Gateway 閘道器完整存取的別名。
- **詢問預設：** `on-miss`。
- **核准儲存：** `~/.openclaw/exec-approvals.json`（JSON，無舊版移轉）。
- **Runner：** 無介面系統服務；UI 應用程式透過 Unix socket 提供核准。
- **節點身分：** 使用既有的 `nodeId`。
- **Socket 驗證：** Unix socket + 權杖（跨平台）；必要時再拆分。
- **Node 主機狀態：** `~/.openclaw/node.json`（node id + 配對權杖）。
- **macOS exec 主機：** 在 macOS 應用程式內執行 `system.run`；node 主機服務透過本機 IPC 轉送請求。
- **不使用 XPC helper：** 維持 Unix socket + 權杖 + 對等檢查。

## 關鍵概念

### Host

- `sandbox`：Docker exec（目前行為）。
- `gateway`：在 Gateway 閘道器 主機上執行。
- `node`：透過 Bridge 在 node runner 上執行（`system.run`）。

### 安全模式

- `deny`：一律封鎖。
- `allowlist`：僅允許符合者。
- `full`：全部允許（等同於提升權限）。

### 詢問模式

- `off`: never ask.
- `on-miss`: ask only when allowlist does not match.
- `always`：每次都詢問。

詢問與允許清單 **相互獨立**；允許清單可與 `always` 或 `on-miss` 搭配使用。

### 政策解析（每次 exec）

1. 解析 `exec.host`（工具參數 → agent 覆寫 → 全域預設）。
2. 解析 `exec.security` 與 `exec.ask`（相同優先順序）。
3. 若主機為 `sandbox`，則進行本機 sandbox exec。
4. 若主機為 `gateway` 或 `node`，在該主機上套用安全 + 詢問政策。

## 預設安全性

- 預設 `exec.host = sandbox`。
- 對 `gateway` 與 `node` 的預設為 `exec.security = deny`。
- 預設 `exec.ask = on-miss`（僅在安全性允許時相關）。
- 若未設定節點綁定，**agent 可指定任何節點**，但僅在政策允許時。

## 設定介面

### 工具參數

- `exec.host`（選用）：`sandbox | gateway | node`。
- `exec.security`（選用）：`deny | allowlist | full`。
- `exec.ask`（選用）：`off | on-miss | always`。
- `exec.node`（選用）：在 `host=node` 時使用的 node id/名稱。

### 設定鍵（全域）

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node`（預設節點綁定）

### 設定鍵（每個 agent）

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### 44. 別名

- `/elevated on` = 為 agent 工作階段設定 `tools.exec.host=gateway`、`tools.exec.security=full`。
- `/elevated off` = 還原 agent 工作階段先前的 exec 設定。

## 核准儲存（JSON）

路徑：`~/.openclaw/exec-approvals.json`

用途：

- **執行主機**（Gateway 閘道器 或 node runner）的本機政策 + 允許清單。
- 45. 當沒有可用 UI 時，詢問後備方案。
- UI 用戶端的 IPC 憑證。

建議結構描述（v1）：

```json
{
  "version": 1,
  "socket": {
    "path": "~/.openclaw/exec-approvals.sock",
    "token": "base64-opaque-token"
  },
  "defaults": {
    "security": "deny",
    "ask": "on-miss",
    "askFallback": "deny"
  },
  "agents": {
    "agent-id-1": {
      "security": "allowlist",
      "ask": "on-miss",
      "allowlist": [
        {
          "pattern": "~/Projects/**/bin/rg",
          "lastUsedAt": 0,
          "lastUsedCommand": "rg -n TODO",
          "lastResolvedPath": "/Users/user/Projects/.../bin/rg"
        }
      ]
    }
  }
}
```

注意事項：

- 不支援舊版允許清單格式。
- 僅在需要 `ask` 且無法連線 UI 時，才套用 `askFallback`。
- 檔案權限：`0600`。

## Runner 服務（無介面）

### 角色

- 在本機強制執行 `exec.security` + `exec.ask`。
- Execute system commands and return output.
- 發送 exec 生命週期的 Bridge 事件（選用但建議）。

### 服務生命週期

- macOS 使用 Launchd/daemon；Linux/Windows 使用系統服務。
- Approvals JSON is local to the execution host.
- UI 提供本機 Unix socket；runner 依需求連線。

## UI 整合（macOS 應用程式）

### IPC

- Unix socket 位置：`~/.openclaw/exec-approvals.sock`（0600）。
- 權杖儲存在 `exec-approvals.json`（0600）。
- Peer checks: same-UID only.
- 挑戰/回應：nonce + HMAC(token, request-hash) 以防重放。
- 短 TTL（例如 10 秒）+ 最大負載 + 速率限制。

### 詢問流程（macOS 應用程式 exec 主機）

1. Node 服務自 Gateway 收到 `system.run`。
2. Node 服務連線至本機 socket，送出提示/exec 請求。
3. 應用程式驗證對等 + 權杖 + HMAC + TTL，必要時顯示對話框。
4. App executes the command in UI context and returns output.
5. Node 服務將輸出回傳至 Gateway。

若 UI 缺失：

- 套用 `askFallback`（`deny|allowlist|full`）。

### 圖表（SCI）

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## Node 身分 + 綁定

- 使用 Bridge 配對中的既有 `nodeId`。
- 綁定模型：
  - `tools.exec.node` 將 agent 限制到特定節點。
  - 若未設定，agent 可選擇任何節點（政策仍會強制預設）。
- 50. 節點選擇解析：
  - `nodeId` 精確比對
  - `displayName`（正規化）
  - `remoteIp`
  - `nodeId` 前綴（>= 6 個字元）

## 事件

### Who sees events

- System events are **per session** and shown to the agent on the next prompt.
- 儲存在 Gateway 的記憶體佇列（`enqueueSystemEvent`）。

### 事件文字

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + 選用的輸出尾段
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### Transport

選項 A（建議）：

- Runner 傳送 Bridge `event` 影格 `exec.started` / `exec.finished`。
- Gateway `handleBridgeEvent` 將其對應為 `enqueueSystemEvent`。

選項 B：

- Gateway 的 `exec` 工具直接處理生命週期（僅同步）。

## Exec 流程

### Sandbox 主機

- 既有的 `exec` 行為（Docker，或在非 sandbox 時於主機上）。
- 僅在非 sandbox 模式支援 PTY。

### Gateway 主機

- Gateway 程序在其自身機器上執行。
- 強制執行本機 `exec-approvals.json`（安全/詢問/允許清單）。

### Node 主機

- Gateway 以 `system.run` 呼叫 `node.invoke`。
- Runner enforces local approvals.
- Runner 回傳彙總的 stdout/stderr。
- Optional Bridge events for start/finish/deny.

## Output caps

- 合併 stdout+stderr 上限 **200k**；事件保留 **20k** 尾段。
- 以明確字尾截斷（例如 `"… (truncated)"`）。

## 斜線指令

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- Per-agent, per-session overrides; non-persistent unless saved via config.
- `/elevated on|off|ask|full` 仍是 `host=gateway security=full` 的捷徑（搭配 `full` 跳過核准）。

## 跨平台說明

- Runner 服務是可攜式的執行目標。
- UI 為選用；若缺失，套用 `askFallback`。
- Windows/Linux 支援相同的核准 JSON + socket 協定。

## Implementation phases

### 第 1 階段：設定 + exec 路由

- 新增 `exec.host`、`exec.security`、`exec.ask`、`exec.node` 的設定結構描述。
- 更新工具管線以遵循 `exec.host`。
- 新增 `/exec` 斜線指令，並保留 `/elevated` 別名。

### 第 2 階段：核准儲存 + Gateway 強制

- 實作 `exec-approvals.json` 讀寫器。
- Enforce allowlist + ask modes for `gateway` host.
- Add output caps.

### 第 3 階段：node runner 強制

- 更新 node runner 以強制允許清單 + 詢問。
- 新增到 macOS 應用程式 UI 的 Unix socket 提示橋接。
- 串接 `askFallback`。

### 第 4 階段：事件

- 新增 node → Gateway 的 Bridge 事件以涵蓋 exec 生命週期。
- 對應為 agent 提示用的 `enqueueSystemEvent`。

### 第 5 階段：UI 潤飾

- Mac 應用程式：允許清單編輯器、每個 agent 切換器、詢問政策 UI。
- Node binding controls (optional).

## 測試計畫

- Unit tests: allowlist matching (glob + case-insensitive).
- 單元測試：政策解析優先順序（工具參數 → agent 覆寫 → 全域）。
- Integration tests: node runner deny/allow/ask flows.
- Bridge 事件測試：node 事件 → 系統事件路由。

## 開放風險

- UI 不可用：確保遵循 `askFallback`。
- Long-running commands: rely on timeout + output caps.
- Multi-node ambiguity: error unless node binding or explicit node param.

## Related docs

- [Exec 工具](/tools/exec)
- [Exec 核准](/tools/exec-approvals)
- [Nodes](/nodes)
- [提升權限模式](/tools/elevated)
