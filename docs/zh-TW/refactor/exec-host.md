---
summary: "重構計畫：exec host 路由、node 核准以及無介面 (headless) 執行器"
read_when:
  - 設計 exec host 路由或 exec 核准時
  - 實作 node runner + UI IPC 時
  - 新增 exec host 安全模式與斜線指令時
title: "Exec Host 重構"
---

# Exec host 重構計畫

## 目標

- 新增 `exec.host` + `exec.security` 以在 **沙箱 (sandbox)**、**Gateway** 與 **node** 之間路由執行。
- 保持預設 **安全**：除非明確啟用，否則不允許跨主機執行。
- 將執行拆分為 **無介面執行器服務 (headless runner service)**，並可透過區域 IPC 搭配選用的 UI (macOS app)。
- 提供 **每個智慧代理 (agent)** 的政策、allowlist、詢問模式 (ask mode) 與 node 綁定。
- 支援可與 allowlist 搭配或獨立運作的 **詢問模式**。
- 跨平台：Unix socket + token 認證 (相容 macOS/Linux/Windows)。

## 非目標

- 不支援舊版 allowlist 遷移或舊版 schema。
- node exec 不支援 PTY/串流 (僅支援彙整後的輸出)。
- 除了現有的 Bridge + Gateway 之外，不新增網路層。

## 決策 (已確定)

- **設定鍵名：** `exec.host` + `exec.security` (允許智慧代理個別覆寫)。
- **權限提升：** 保留 `/elevated` 作為 Gateway 完全存取權的別名。
- **詢問預設值：** `on-miss`。
- **核准儲存庫：** `~/.openclaw/exec-approvals.json` (JSON 格式，無舊版遷移)。
- **執行器 (Runner)：** 無介面系統服務；UI 應用程式代管一個用於核准的 Unix socket。
- **Node 身分：** 使用現有的 `nodeId`。
- **Socket 認證：** Unix socket + token (跨平台)；日後若有需要再拆分。
- **Node 主機狀態：** `~/.openclaw/node.json` (node id + 配對 token)。
- **macOS exec host：** 在 macOS app 內執行 `system.run`；node 主機服務透過區域 IPC 轉發請求。
- **不使用 XPC helper：** 堅持使用 Unix socket + token + 同儕檢查 (peer checks)。

## 核心概念

### 主機 (Host)

- `sandbox`：Docker 執行 (目前行為)。
- `gateway`：在 Gateway 主機上執行。
- `node`：透過 Bridge 在 node runner 上執行 (`system.run`)。

### 安全模式 (Security mode)

- `deny`：一律封鎖。
- `allowlist`：僅允許符合條件的項目。
- `full`：允許所有執行 (等同於 elevated)。

### 詢問模式 (Ask mode)

- `off`：從不詢問。
- `on-miss`：僅當不符合 allowlist 時詢問。
- `always`：每次都詢問。

詢問是 **獨立於** allowlist 的；allowlist 可以與 `always` 或 `on-miss` 搭配使用。

### 政策解析 (每次執行)

1. 解析 `exec.host` (工具參數 → 智慧代理覆寫 → 全域預設值)。
2. 解析 `exec.security` 與 `exec.ask` (優先順序相同)。
3. 若主機為 `sandbox`，進行本地沙箱執行。
4. 若主機為 `gateway` 或 `node`，在該主機上套用安全 + 詢問政策。

## 預設安全性

- 預設 `exec.host = sandbox`。
- 對於 `gateway` 與 `node`，預設 `exec.security = deny`。
- 預設 `exec.ask = on-miss` (僅在安全性允許時才相關)。
- 若未設定 node 綁定，**智慧代理可能會指向任何 node**，但僅限於政策允許的情況下。

## 設定介面

### 工具參數

- `exec.host` (選用)：`sandbox | gateway | node`。
- `exec.security` (選用)：`deny | allowlist | full`。
- `exec.ask` (選用)：`off | on-miss | always`。
- `exec.node` (選用)：當 `host=node` 時使用的 node id/名稱。

### 設定鍵名 (全域)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (預設 node 綁定)

### 設定鍵名 (每個智慧代理)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### 別名

- `/elevated on` = 為該智慧代理工作階段設定 `tools.exec.host=gateway`, `tools.exec.security=full`。
- `/elevated off` = 為該智慧代理工作階段還原先前的執行設定。

## 核准儲存庫 (JSON)

路徑：`~/.openclaw/exec-approvals.json`

用途：

- **執行主機** (Gateway 或 node runner) 的本地政策 + allowlist。
- 當沒有 UI 可用時的詢問退路 (Ask fallback)。
- UI 用戶端的 IPC 憑證。

建議的 schema (v1)：

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

附註：

- 不支援舊版 allowlist 格式。
- `askFallback` 僅在需要 `ask` 且無法聯繫到 UI 時套用。
- 檔案權限：`0600`。

## 執行器服務 (無介面)

### 角色

- 在本地強制執行 `exec.security` + `exec.ask`。
- 執行系統指令並回傳輸出。
- 發送執行生命週期的 Bridge 事件 (選用但建議)。

### 服務生命週期

- macOS 上使用 launchd/daemon；Linux/Windows 上使用系統服務。
- 核准 JSON 位於執行主機本地。
- UI 代管一個區域 Unix socket；執行器視需求連線。

## UI 整合 (macOS app)

### IPC

- Unix socket 位於 `~/.openclaw/exec-approvals.sock` (0600)。
- Token 儲存於 `exec-approvals.json` (0600)。
- 同儕檢查 (Peer checks)：僅限相同 UID。
- 挑戰/回應 (Challenge/response)：Nonce + HMAC(token, request-hash) 以防止重放攻擊。
- 短 TTL (例如 10 秒) + 最大負載限制 + 速率限制。

### 詢問流程 (macOS app exec host)

1. Node 服務從 Gateway 接收到 `system.run`。
2. Node 服務連線至區域 socket 並傳送提示/執行請求。
3. App 驗證同儕 + token + HMAC + TTL，然後視需要顯示對話框。
4. App 在 UI 情境中執行指令並回傳輸出。
5. Node 服務將輸出回傳給 Gateway。

若遺失 UI：

- 套用 `askFallback` (`deny|allowlist|full`)。

### 圖解 (SCI)

```
智慧代理 -> Gateway -> Bridge -> Node 服務 (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## Node 身分與綁定

- 使用 Bridge 配對中現有的 `nodeId`。
- 綁定模型：
  - `tools.exec.node` 將智慧代理限制在特定的 node。
  - 若未設定，智慧代理可以選擇任何 node (政策仍會強制執行預設值)。
- Node 選擇解析：
  - `nodeId` 完全符合
  - `displayName` (正規化)
  - `remoteIp`
  - `nodeId` 前綴 (>= 6 字元)

## 事件處理 (Eventing)

### 誰能看到事件

- 系統事件是 **每個工作階段** 獨立的，並在下一次提示時顯示給智慧代理。
- 儲存在 Gateway 的記憶體佇列中 (`enqueueSystemEvent`)。

### 事件文字

- `Exec started (node=<id>, id=<runId>)`
- `Exec finished (node=<id>, id=<runId>, code=<code>)` + 選用的輸出結尾
- `Exec denied (node=<id>, id=<runId>, <reason>)`

### 傳輸協定

選項 A (建議)：

- 執行器傳送 Bridge `event` 框架 `exec.started` / `exec.finished`。
- Gateway 的 `handleBridgeEvent` 將這些映射至 `enqueueSystemEvent`。

選項 B：

- Gateway 的 `exec` 工具直接處理生命週期 (僅限同步)。

## 執行流程

### 沙箱主機 (Sandbox host)

- 現有的 `exec` 行為 (Docker，或在未隔離時直接在主機執行)。
- 僅在非沙箱模式下支援 PTY。

### Gateway 主機 (Gateway host)

- Gateway 程序在其自身機器上執行。
- 強制執行本地的 `exec-approvals.json` (security/ask/allowlist)。

### Node 主機 (Node host)

- Gateway 呼叫 `node.invoke` 並帶入 `system.run`。
- 執行器強制執行本地核准。
- 執行器回傳彙整後的 stdout/stderr。
- 選用的開始/完成/拒絕 Bridge 事件。

## 輸出上限

- 結合 stdout+stderr 的上限為 **200k**；保留 **最後 20k** 用於事件。
- 使用明確的後置詞進行截斷 (例如 `"… (truncated)"`)。

## 斜線指令

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- 智慧代理個別工作階段的覆寫；除非透過設定儲存，否則不具持久性。
- `/elevated on|off|ask|full` 仍是 `host=gateway security=full` 的捷徑 (使用 `full` 會跳過核准)。

## 跨平台支援

- 執行器服務是可移植的執行目標。
- UI 是選用的；若遺失，則套用 `askFallback`。
- Windows/Linux 支援相同的核准 JSON + socket 協定。

## 實作階段

### 第一階段：設定與 exec 路由

- 為 `exec.host`, `exec.security`, `exec.ask`, `exec.node` 新增設定 schema。
- 更新工具管線以遵循 `exec.host`。
- 新增 `/exec` 斜線指令並保留 `/elevated` 別名。

### 第二階段：核准儲存庫與 Gateway 強制執行

- 實作 `exec-approvals.json` 的讀取器/寫入器。
- 為 `gateway` 主機強制執行 allowlist + 詢問模式。
- 新增輸出上限。

### 第三階段：node runner 強制執行

- 更新 node runner 以強制執行 allowlist + 詢問。
- 為 macOS app UI 新增 Unix socket 提示橋接。
- 串接 `askFallback`。

### 第四階段：事件

- 為執行生命週期新增 node → gateway 的 Bridge 事件。
- 映射至智慧代理提示的 `enqueueSystemEvent`。

### 第五階段：UI 磨光

- Mac app：allowlist 編輯器、智慧代理切換器、詢問政策 UI。
- Node 綁定控制 (選用)。

## 測試計畫

- 單元測試：allowlist 匹配 (glob + 不區分大小寫)。
- 單元測試：政策解析優先順序 (工具參數 → 智慧代理覆寫 → 全域)。
- 整合測試：node runner 拒絕/允許/詢問流程。
- Bridge 事件測試：node 事件 → 系統事件路由。

## 開放性風險

- UI 無法使用：確保遵循 `askFallback`。
- 長時間執行的指令：依賴超時 + 輸出上限。
- 多 node 歧義：除非有 node 綁定或明確的 node 參數，否則報錯。

## 相關文件

- [Exec 工具](/tools/exec)
- [Exec 核准](/tools/exec-approvals)
- [Nodes](/nodes)
- [Elevated 模式](/tools/elevated)
