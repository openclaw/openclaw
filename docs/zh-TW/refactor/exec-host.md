---
summary: "Refactor plan: exec host routing, node approvals, and headless runner"
read_when:
  - Designing exec host routing or exec approvals
  - Implementing node runner + UI IPC
  - Adding exec host security modes and slash commands
title: Exec Host Refactor
---

# 執行主機重構計畫

## 目標

- 新增 `exec.host` + `exec.security` 以路由執行至 **sandbox**、**gateway** 和 **node**。
- 保持預設設定 **安全**：除非明確啟用，否則不允許跨主機執行。
- 將執行拆分為 **無頭執行服務**，並透過本地 IPC 提供可選的 UI（macOS 應用程式）。
- 提供 **每個代理** 的政策、允許清單、詢問模式及節點綁定。
- 支援可 _搭配_ 或 _不搭配_ 允許清單使用的 **詢問模式**。
- 跨平台支援：Unix socket + token 認證（macOS/Linux/Windows 一致性）。

## 非目標

- 不進行舊版允許清單遷移或舊版架構支援。
- 節點執行不支援 PTY/串流（僅聚合輸出）。
- 不新增網路層，維持現有 Bridge + Gateway 架構。

## 決策（已鎖定）

- **設定鍵值：** `exec.host` + `exec.security`（允許每代理覆寫）。
- **權限提升：** 保留 `/elevated` 作為 gateway 完全存取的別名。
- **詢問預設：** `on-miss`。
- **批准存儲：** `~/.openclaw/exec-approvals.json`（JSON 格式，無舊版遷移）。
- **執行器：** 無頭系統服務；UI 應用程式提供 Unix socket 用於批准。
- **節點身份：** 使用現有 `nodeId`。
- **Socket 認證：** Unix socket + token（跨平台）；如有需要後續拆分。
- **節點主機狀態：** `~/.openclaw/node.json`（節點 ID + 配對 token）。
- **macOS 執行主機：** 在 macOS 應用程式內執行 `system.run`；節點主機服務透過本地 IPC 轉發請求。
- **無 XPC 助手：** 僅使用 Unix socket + token + 對等檢查。

## 主要概念

### 主機

- `sandbox`：Docker 執行（目前行為）。
- `gateway`：在 gateway 主機執行。
- `node`：透過 Bridge 在 node 執行器執行（`system.run`）。

### 安全模式

- `deny`：永遠封鎖。
- `allowlist`：僅允許匹配專案。
- `full`：全部允許（等同於提升權限）。

### 詢問模式

- `off`：從不詢問。
- `on-miss`：僅當允許清單不匹配時詢問。
- `always`：每次皆詢問。

詢問模式與允許清單是 **獨立** 的；允許清單可搭配 `always` 或 `on-miss` 使用。

### 策略解析（每次執行）

1. 解析 `exec.host`（工具參數 → 代理覆寫 → 全域預設）。
2. 解析 `exec.security` 和 `exec.ask`（同等優先權）。
3. 若主機為 `sandbox`，則進行本地沙箱執行。
4. 若主機為 `gateway` 或 `node`，則在該主機套用安全性與詢問政策。

## 預設安全性

- 預設 `exec.host = sandbox`。
- 預設 `exec.security = deny` 用於 `gateway` 和 `node`。
- 預設 `exec.ask = on-miss`（僅在安全性允許時相關）。
- 若未設定節點綁定，**代理可目標任意節點**，但僅限於政策允許的情況。

## 設定介面

### 工具參數

- `exec.host`（可選）：`sandbox | gateway | node`。
- `exec.security`（可選）：`deny | allowlist | full`。
- `exec.ask`（可選）：`off | on-miss | always`。
- `exec.node`（可選）：在 `host=node` 時使用的節點 ID/名稱。

### 設定鍵（全域）

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node`（預設節點綁定）

### 設定鍵（每個代理）

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### 別名

- `/elevated on` = 為代理會話設定 `tools.exec.host=gateway`、`tools.exec.security=full`。
- `/elevated off` = 還原代理會話先前的執行設定。

## 批准存儲（JSON）

路徑：`~/.openclaw/exec-approvals.json`

目的：

- 本地政策 + 執行主機（gateway 或 node runner）的允許清單。
- 無 UI 可用時，啟用詢問回退機制。
- UI 用戶端的 IPC 憑證。

建議的架構（v1）：

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

備註：

- 不支援舊版允許清單格式。
- `askFallback` 僅在 `ask` 必須且無法連接 UI 時適用。
- 檔案權限：`0600`。

## Runner 服務（無頭模式）

### 角色

- 本地強制執行 `exec.security` + `exec.ask`。
- 執行系統指令並回傳輸出。
- 發出 Bridge 事件以追蹤執行生命週期（選用但建議啟用）。

### 服務生命週期

- macOS 使用 launchd/daemon；Linux/Windows 使用系統服務。
- Approvals JSON 保存在執行主機本地。
- UI 端提供本地 Unix socket；runner 按需連接。

## UI 整合（macOS 應用程式）

### IPC

- Unix socket 位於 `~/.openclaw/exec-approvals.sock`（權限 0600）。
- Token 儲存在 `exec-approvals.json`（權限 0600）。
- 對等端檢查：僅限相同 UID。
- 挑戰/回應機制：nonce + HMAC(token, request-hash) 防止重放攻擊。
- 短 TTL（例如 10 秒）+ 最大負載限制 + 速率限制。

### 詢問流程（macOS 應用程式執行主機）

1. Node 服務從 gateway 接收 `system.run`。
2. Node 服務連接本地 socket 並發送 prompt/exec 請求。
3. App 驗證 peer + token + HMAC + TTL，必要時顯示對話框。
4. App 在 UI 環境中執行指令並回傳輸出結果。
5. Node 服務將輸出結果回傳給 gateway。

如果 UI 缺失：

- 應用 `askFallback` (`deny|allowlist|full`)。

### 圖示 (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## Node 身份與綁定

- 使用 Bridge 配對時已有的 `nodeId`。
- 綁定模型：
  - `tools.exec.node` 限制代理只能綁定特定節點。
  - 若未設定，代理可選擇任意節點（政策仍會強制預設規則）。
- 節點選擇解析：
  - `nodeId` 精確匹配
  - `displayName`（正規化）
  - `remoteIp`
  - `nodeId` 前綴（至少 6 個字元）

## 事件處理

### 誰能看到事件

- 系統事件為 **每個會話**，並在下一次 prompt 時顯示給代理。
- 儲存在 gateway 的記憶體佇列中 (`enqueueSystemEvent`)。

### 事件文字

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + 可選的輸出尾端
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### 傳輸方式

選項 A（推薦）：

- Runner 傳送 Bridge `event` 幀 `exec.started` / `exec.finished`。
- Gateway `handleBridgeEvent` 將其映射為 `enqueueSystemEvent`。

Option B:

- Gateway `exec` 工具直接處理生命週期（僅同步）。

## 執行流程

### 沙盒主機

- 現有 `exec` 行為（未沙盒時為 Docker 或主機）。
- 僅非沙盒模式支援 PTY。

### Gateway 主機

- Gateway 程式在自身機器上執行。
- 強制執行本地 `exec-approvals.json`（安全性/詢問/允許清單）。

### Node 主機

- Gateway 使用 `system.run` 呼叫 `node.invoke`。
- Runner 強制本地批准。
- Runner 回傳彙整的 stdout/stderr。
- 可選的 Bridge 事件：開始/結束/拒絕。

## 輸出限制

- 將 stdout+stderr 合計限制在 **200k**；事件保留 **尾端 20k**。
- 以明確後綴截斷（例如 `"… (truncated)"`）。

## 斜線指令

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- 每代理、每會話覆寫；非持久，除非透過設定儲存。
- `/elevated on|off|ask|full` 仍為 `host=gateway security=full` 的捷徑（搭配 `full` 可跳過批准）。

## 跨平台方案

- Runner 服務是可攜式執行目標。
- UI 為選用；若缺少，則套用 `askFallback`。
- Windows/Linux 支援相同的批准 JSON + socket 協定。

## 實作階段

### 階段 1：設定 + 執行路由

- 新增 `exec.host`、`exec.security`、`exec.ask`、`exec.node` 的設定結構。
- 更新工具管線以遵守 `exec.host`。
- 新增 `/exec` 斜線指令並保留 `/elevated` 別名。

### 階段 2：批准存儲 + 閘道強制

- 實作 `exec-approvals.json` 讀寫器。
- 對 `gateway` 主機強制執行允許清單與詢問模式。
- 新增輸出上限。

### 階段 3：節點執行器強制

- 更新節點執行器以強制執行允許清單與詢問。
- 新增 Unix socket 提示橋接至 macOS 應用 UI。
- 連接 `askFallback`。

### 階段 4：事件

- 新增節點 → 閘道橋接事件以管理執行生命週期。
- 映射至 `enqueueSystemEvent` 以供代理提示使用。

### 階段 5：UI 美化

- Mac 應用：允許清單編輯器、每代理切換器、詢問政策 UI。
- 節點綁定控制（可選）。

## 測試計畫

- 單元測試：允許清單匹配（glob + 不區分大小寫）。
- 單元測試：政策解析優先順序（工具參數 → 代理覆寫 → 全域）。
- 整合測試：節點執行器拒絕/允許/詢問流程。
- 橋接事件測試：節點事件 → 系統事件路由。

## 風險點

- UI 不可用：確保遵守 `askFallback`。
- 長時間執行指令：依賴逾時與輸出上限。
- 多節點模糊性：除非有節點綁定或明確節點參數，否則報錯。

## 相關文件

- [Exec 工具](/tools/exec)
- [Exec 審批](/tools/exec-approvals)
- [節點](/nodes)
- [提升權限模式](/tools/elevated)
