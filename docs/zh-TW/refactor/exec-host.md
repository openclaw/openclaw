```
---
summary: "重構計畫：執行主機路由、節點審批與無頭執行器"
read_when:
  - 設計執行主機路由或執行審批時
  - 實作節點執行器 + UI IPC 時
  - 新增執行主機安全模式與斜線指令時
title: "執行主機重構"
---

# 執行主機重構計畫

## 目標

- 新增 `exec.host` + `exec.security` 以在 **沙箱**、**Gateway** 和 **節點** 之間路由執行。
- 保持**預設安全**：除非明確啟用，否則不進行跨主機執行。
- 將執行分為**無頭執行器服務**，並可選透過本機 IPC 搭配 UI (macOS 應用程式)。
- 提供**每個智慧代理**的策略、允許列表、詢問模式和節點綁定。
- 支援 _有_ 或 _無_ 允許列表皆可運作的**詢問模式**。
- 跨平台：Unix socket + 權杖驗證 (macOS/Linux/Windows 同等)。

## 非目標

- 不支援舊版允許列表遷移或舊版綱要。
- 不支援節點執行的 PTY/串流傳輸 (僅限聚合輸出)。
- 除了現有的 Bridge + Gateway 之外，不新增網路層。

## 決策 (已鎖定)

- **設定鍵名**：`exec.host` + `exec.security` (允許每個智慧代理覆寫)。
- **權限提升**：將 `/elevated` 保留為 Gateway 完全存取的別名。
- **預設詢問模式**：`on-miss`。
- **審批儲存**：`~/.openclaw/exec-approvals.json` (JSON 檔案，不進行舊版遷移)。
- **執行器**：無頭系統服務；UI 應用程式託管用於審批的 Unix socket。
- **節點身份**：使用現有的 `nodeId`。
- **Socket 驗證**：Unix socket + 權杖 (跨平台)；如果需要，稍後再拆分。
- **節點主機狀態**：`~/.openclaw/node.json` (節點 ID + 配對權杖)。
- **macOS 執行主機**：在 macOS 應用程式內部執行 `system.run`；節點主機服務透過本機 IPC 轉發請求。
- **無 XPC 協助程式**：堅持使用 Unix socket + 權杖 + 對等檢查。

## 關鍵概念

### 主機

- `sandbox`：Docker 執行 (目前的行為)。
- `gateway`：在 Gateway 主機上執行。
- `node`：透過 Bridge (`system.run`) 在節點執行器上執行。

### 安全模式

- `deny`：一律封鎖。
- `allowlist`：僅允許符合的項目。
- `full`：允許所有項目 (等同於權限提升)。

### 詢問模式

- `off`：從不詢問。
- `on-miss`：僅在允許列表不匹配時詢問。
- `always`：每次都詢問。

詢問模式與允許列表**獨立**；允許列表可與 `always` 或 `on-miss` 搭配使用。

### 策略解析 (每次執行)

1. 解析 `exec.host` (工具參數 → 智慧代理覆寫 → 全域預設)。
2. 解析 `exec.security` 和 `exec.ask` (相同優先順序)。
3. 如果主機是 `sandbox`，則繼續進行本機沙箱執行。
4. 如果主機是 `gateway` 或 `node`，則在該主機上套用安全 + 詢問策略。

## 預設安全

- 預設 `exec.host = sandbox`。
- 對於 `gateway` 和 `node`，預設 `exec.security = deny`。
- 預設 `exec.ask = on-miss` (僅在安全允許時相關)。
- 如果未設定節點綁定，**智慧代理可鎖定任何節點**，但前提是策略允許。

## 設定介面

### 工具參數

- `exec.host` (選用)：`sandbox | gateway | node`。
- `exec.security` (選用)：`deny | allowlist | full`。
- `exec.ask` (選用)：`off | on-miss | always`。
- `exec.node` (選用)：當 `host=node` 時要使用的節點 ID/名稱。

### 設定鍵名 (全域)

- `tools.exec.host`
- `tools.exec.security`
- `tools.exec.ask`
- `tools.exec.node` (預設節點綁定)

### 設定鍵名 (每個智慧代理)

- `agents.list[].tools.exec.host`
- `agents.list[].tools.exec.security`
- `agents.list[].tools.exec.ask`
- `agents.list[].tools.exec.node`

### 別名

- `/elevated on` = 為該智慧代理工作階段設定 `tools.exec.host=gateway`，`tools.exec.security=full`。
- `/elevated off` = 恢復該智慧代理工作階段先前的執行設定。

## 審批儲存 (JSON)

路徑：`~/.openclaw/exec-approvals.json`

用途：

- **執行主機** (Gateway 或節點執行器) 的本機策略 + 允許列表。
- 當沒有 UI 可用時的詢問備用方案。
- 用於 UI 用戶端的 IPC 憑證。

建議的綱要 (v1)：

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

- 不支援舊版允許列表格式。
- `askFallback` 僅在需要 `ask` 且無法連接 UI 時套用。
- 檔案權限：`0600`。

## 執行器服務 (無頭)

### 角色

- 在本機強制執行 `exec.security` + `exec.ask`。
- 執行系統指令並回傳輸出。
- 發出執行生命週期的 Bridge 事件 (可選但建議)。

### 服務生命週期

- macOS 上的 Launchd/daemon；Linux/Windows 上的系統服務。
- 審批 JSON 檔案是執行主機的本機檔案。
- UI 託管一個本機 Unix socket；執行器按需連接。

## UI 整合 (macOS 應用程式)

### IPC

- Unix socket 位於 `~/.openclaw/exec-approvals.sock` (0600)。
- 權杖儲存在 `exec-approvals.json` 中 (0600)。
- 對等檢查：僅限相同 UID。
- 挑戰/回應：nonce + HMAC(權杖, 請求雜湊) 以防止重播。
- 短 TTL (例如 10 秒) + 最大負載 + 速率限制。

### 詢問流程 (macOS 應用程式執行主機)

1. 節點服務從 Gateway 接收 `system.run`。
2. 節點服務連接到本機 socket 並傳送提示/執行請求。
3. 應用程式驗證對等 + 權杖 + HMAC + TTL，然後在需要時顯示對話框。
4. 應用程式在 UI 環境中執行指令並回傳輸出。
5. 節點服務將輸出回傳給 Gateway。

如果 UI 遺失：

- 套用 `askFallback` (`deny|allowlist|full`)。

### 圖表 (SCI)

```
Agent -> Gateway -> Bridge -> Node Service (TS)
                         |  IPC (UDS + token + HMAC + TTL)
                         v
                     Mac App (UI + TCC + system.run)
```

## 節點身份 + 綁定

- 使用 Bridge 配對中現有的 `nodeId`。
- 綁定模型：
  - `tools.exec.node` 將智慧代理限制為特定節點。
  - 如果未設定，智慧代理可以選擇任何節點 (策略仍強制執行預設值)。
- 節點選擇解析：
  - `nodeId` 完全匹配
  - `displayName` (正規化)
  - `remoteIp`
  - `nodeId` 前綴 (>= 6 個字元)

## 事件

### 誰看到事件

- 系統事件是**每個工作階段**的，並在下一個提示時顯示給智慧代理。
- 儲存在 Gateway 的記憶體佇列中 (`enqueueSystemEvent`)。

### 事件文字

- `執行已啟動 (節點=<id>, ID=<runId>)`
- `執行已完成 (節點=<id>, ID=<runId>, 程式碼=<code>)` + 可選的輸出尾部
- `執行已拒絕 (節點=<id>, ID=<runId>, <原因>)`

### 傳輸協定

選項 A (建議)：

- 執行器傳送 Bridge `event` 框架 `exec.started` / `exec.finished`。
- Gateway 的 `handleBridgeEvent` 將這些映射到 `enqueueSystemEvent`。

選項 B：

- Gateway `exec` 工具直接處理生命週期 (僅限同步)。

## 執行流程

### 沙箱主機

- 現有的 `exec` 行為 (非沙箱隔離時為 Docker 或主機)。
- PTY 僅在非沙箱模式下支援。

### Gateway 主機

- Gateway 程序在其自己的機器上執行。
- 強制執行本機 `exec-approvals.json` (安全/詢問/允許列表)。

### 節點主機

- Gateway 使用 `system.run` 呼叫 `node.invoke`。
- 執行器強制執行本機審批。
- 執行器回傳聚合的 stdout/stderr。
- 可選的 Bridge 事件，用於啟動/完成/拒絕。

## 輸出限制

- 將組合的 stdout+stderr 限制在 **200k**；保留 **20k 尾部**用於事件。
- 使用明確的後綴截斷 (例如，`「… (已截斷)」`)。

## 斜線指令

- `/exec host=<sandbox|gateway|node> security=<deny|allowlist|full> ask=<off|on-miss|always> node=<id>`
- 每個智慧代理、每個工作階段的覆寫；除非透過設定儲存，否則不具持久性。
- `/elevated on|off|ask|full` 仍然是 `host=gateway security=full` 的捷徑 (其中 `full` 會跳過審批)。

## 跨平台故事

- 執行器服務是可攜式的執行目標。
- UI 是可選的；如果遺失，則套用 `askFallback`。
- Windows/Linux 支援相同的審批 JSON 檔案 + socket 協定。

## 實作階段

### 階段 1：設定 + 執行路由

- 新增 `exec.host`、`exec.security`、`exec.ask`、`exec.node` 的設定綱要。
- 更新工具管道以遵守 `exec.host`。
- 新增 `/exec` 斜線指令並保留 `/elevated` 別名。

### 階段 2：審批儲存 + Gateway 強制執行

- 實作 `exec-approvals.json` 讀寫器。
- 對於 `gateway` 主機強制執行允許列表 + 詢問模式。
- 新增輸出限制。

### 階段 3：節點執行器強制執行

- 更新節點執行器以強制執行允許列表 + 詢問。
- 新增 Unix socket 提示橋接到 macOS 應用程式 UI。
- 連接 `askFallback`。

### 階段 4：事件

- 新增節點 → Gateway 的 Bridge 事件，用於執行生命週期。
- 映射到 `enqueueSystemEvent` 以用於智慧代理提示。

### 階段 5：UI 優化

- Mac 應用程式：允許列表編輯器、每個智慧代理切換器、詢問策略 UI。
- 節點綁定控制項 (選用)。

## 測試計畫

- 單元測試：允許列表匹配 (glob + 不區分大小寫)。
- 單元測試：策略解析優先順序 (工具參數 → 智慧代理覆寫 → 全域)。
- 整合測試：節點執行器拒絕/允許/詢問流程。
- Bridge 事件測試：節點事件 → 系統事件路由。

## 開放風險

- UI 無法使用：確保 `askFallback` 受到遵守。
- 長時間執行的指令：依賴於逾時 + 輸出限制。
- 多節點模糊：錯誤，除非有節點綁定或明確的節點參數。

## 相關文件

- [執行工具](/tools/exec)
- [執行審批](/tools/exec-approvals)
- [節點](/nodes)
- [權限提升模式](/tools/elevated)
```
