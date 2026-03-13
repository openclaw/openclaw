---
summary: "Clawnet refactor: unify network protocol, roles, auth, approvals, identity"
read_when:
  - Planning a unified network protocol for nodes + operator clients
  - "Reworking approvals, pairing, TLS, and presence across devices"
title: Clawnet Refactor
---

# Clawnet 重構（協議 + 認證統一）

## 你好

你好 Peter — 很棒的方向；這將解鎖更簡單的使用者體驗與更強的安全性。

## 目的

單一且嚴謹的文件，用於：

- 目前狀態：協議、流程、信任邊界。
- 痛點：授權、多跳路由、UI 重複。
- 建議的新狀態：單一協議、範圍角色、統一認證/配對、TLS 固定。
- 身份模型：穩定 ID + 可愛的 slug。
- 遷移計畫、風險、開放問題。

## 目標（來自討論）

- 所有用戶端（mac app、CLI、iOS、Android、無頭節點）使用同一協議。
- 每個網路參與者皆經過認證與配對。
- 角色明確：節點與操作員。
- 中央授權導向使用者所在位置。
- 所有遠端流量皆使用 TLS 加密 + 可選的固定憑證。
- 最小化程式碼重複。
- 單一機器只出現一次（無 UI/節點重複條目）。

## 非目標（明確）

- 不移除能力分離（仍需最小權限）。
- 不暴露無範圍檢查的完整閘道控制平面。
- 不讓認證依賴人為標籤（slug 仍非安全依據）。

---

# 目前狀態（現況）

## 兩個協議

### 1) 閘道 WebSocket（控制平面）

- 完整 API 範圍：設定、頻道、模型、會話、代理執行、日誌、節點等。
- 預設綁定：loopback。遠端存取透過 SSH/Tailscale。
- 認證：token/密碼，透過 `connect`。
- 無 TLS 固定（依賴 loopback/隧道）。
- 程式碼：
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2) Bridge（節點傳輸）

- 縮小允許清單範圍，節點身份與配對。
- 透過 TCP 傳送 JSONL；可選擇 TLS + 憑證指紋綁定。
- TLS 在發現的 TXT 記錄中廣播指紋。
- 程式碼：
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## 目前的控制平面用戶端

- CLI → 透過 `callGateway` (`src/gateway/call.ts`) 連接 Gateway 的 WS。
- macOS 應用程式 UI → Gateway WS (`GatewayConnection`)。
- 網頁控制 UI → Gateway WS。
- ACP → Gateway WS。
- 瀏覽器控制使用自己的 HTTP 控制伺服器。

## 目前的節點

- macOS 應用程式以節點模式連接 Gateway bridge (`MacNodeBridgeSession`)。
- iOS/Android 應用程式連接 Gateway bridge。
- 配對與每節點的 token 儲存在 gateway。

## 目前的批准流程（執行階段）

- Agent 透過 Gateway 使用 `system.run`。
- Gateway 透過 bridge 呼叫節點。
- 節點執行環境決定是否批准。
- mac 應用程式顯示 UI 提示（當節點即為 mac 應用程式時）。
- 節點回傳 `invoke-res` 給 Gateway。
- 多跳，UI 綁定於節點主機。

## 目前的存在狀態與身份

- Gateway 從 WS 用戶端取得存在條目。
- 節點從 bridge 取得存在條目。
- mac 應用程式可為同一台機器顯示兩個條目（UI + 節點）。
- 節點身份儲存在配對資料庫；UI 身份則分開管理。

---

# 問題 / 痛點

- 需維護兩套協定棧（WS + Bridge）。
- 遠端節點的批准：提示出現在節點主機，而非使用者所在位置。
- TLS 綁定僅存在於 bridge；WS 依賴 SSH/Tailscale。
- 身份重複：同一台機器顯示為多個實例。
- 角色模糊：UI、節點與 CLI 功能未明確區分。

---

# 建議的新狀態（Clawnet）

## 一個協議，兩種角色

單一 WS 協議，帶有角色 + 範圍。

- **角色：node**（能力主機）
- **角色：operator**（控制平面）
- operator 的可選 **範圍**：
  - `operator.read`（狀態 + 檢視）
  - `operator.write`（代理執行、發送）
  - `operator.admin`（設定、頻道、模型）

### 角色行為

**Node**

- 可註冊能力 (`caps`、`commands`、權限)。
- 可接收 `invoke` 指令 (`system.run`、`camera.*`、`canvas.*`、`screen.record` 等)。
- 可發送事件：`voice.transcript`、`agent.request`、`chat.subscribe`。
- 不可呼叫設定/模型/頻道/會話/代理控制平面 API。

**Operator**

- 完整控制平面 API，受範圍限制。
- 接收所有批准。
- 不直接執行作業系統動作；路由至節點。

### 主要規則

角色是依連線而定，不是依裝置。裝置可分別開啟兩種角色。

---

# 統一認證 + 配對

## 用戶端身份

每個用戶端需提供：

- `deviceId`（穩定，從裝置金鑰衍生）。
- `displayName`（人類可讀名稱）。
- `role` + `scope` + `caps` + `commands`。

## 配對流程（統一）

- 用戶端以未驗證狀態連線。
- Gateway 為該 `deviceId` 建立**配對請求**。
- 操作者收到提示，批准或拒絕。
- Gateway 發行綁定以下資訊的憑證：
  - 裝置公鑰
  - 角色
  - 範圍
  - 功能/指令
- 用戶端保存 token，重新以驗證狀態連線。

## 綁定裝置的認證（避免 bearer token 重放）

首選：裝置金鑰對。

- 裝置只生成一次金鑰對。
- `deviceId = fingerprint(publicKey)`。
- Gateway 發送 nonce；裝置簽署；Gateway 驗證。
- Token 發行給公鑰（持有證明），而非字串。

替代方案：

- mTLS（用戶端憑證）：最強，但操作複雜度較高。
- 短期 bearer token 僅作為暫時階段（需定期輪替並及早撤銷）。

## 靜默批准（SSH 啟發式）

需明確定義以避免弱點。建議採用以下之一：

- **僅限本地**：當用戶端透過 loopback/Unix socket 連線時自動配對。
- **透過 SSH 挑戰**：Gateway 發送 nonce；用戶端透過 SSH 取得並證明。
- **實體存在窗口**：在 Gateway 主機 UI 上本地批准後，允許短時間內（例如 10 分鐘）自動配對。

務必記錄並保存所有自動批准的日誌。

---

# 全面使用 TLS（開發與生產）

## 重用現有橋接 TLS

使用現有 TLS 執行環境與指紋鎖定：

- `src/infra/bridge/server/tls.ts`
- `src/node-host/bridge-client.ts` 中的指紋驗證邏輯

## 應用於 WS

- WS 伺服器支援使用相同的憑證/金鑰 + 指紋的 TLS。
- WS 用戶端可選擇釘選指紋。
- Discovery 為所有端點廣播 TLS + 指紋。
  - Discovery 僅作為定位提示；絕非信任根。

## 為什麼

- 降低對 SSH/Tailscale 保密性的依賴。
- 預設讓遠端行動連線更安全。

---

# 核准流程重新設計（集中式）

## 目前狀況

核准發生在節點主機（mac app 節點執行環境）。提示會出現在節點執行的位置。

## 建議方案

核准由 **gateway 主機** 處理，UI 傳送給操作員用戶端。

### 新流程

1. Gateway 收到 `system.run` 意圖（agent）。
2. Gateway 建立核准紀錄：`approval.requested`。
3. 操作員 UI 顯示提示。
4. 核准決定送回 gateway：`approval.resolve`。
5. 若核准，gateway 呼叫節點指令。
6. 節點執行並回傳 `invoke-res`。

### 核准語意（強化）

- 廣播給所有操作員；只有活躍的 UI 顯示模態視窗（其他顯示通知）。
- 以第一次決定為準；gateway 拒絕後續決定，視為已處理。
- 預設逾時：N 秒後拒絕（例如 60 秒），並記錄原因。
- 決定需具備 `operator.approvals` 權限範圍。

## 優點

- 提示會出現在使用者所在的位置（Mac/手機）。
- 遠端節點的授權一致。
- 節點執行時保持無頭狀態；無需依賴 UI。

---

# 角色明確範例

## iPhone 應用程式

- **節點角色** 用於：麥克風、相機、語音聊天、定位、按鍵說話。
- 選用 **operator.read** 用於狀態與聊天檢視。
- 僅在明確啟用時，選用 **operator.write/admin**。

## macOS 應用程式

- 預設為操作員角色（控制 UI）。
- 啟用「Mac 節點」時為節點角色（system.run、螢幕、相機）。
- 兩個連線使用相同 deviceId → 合併 UI 專案。

## CLI

- 永遠為操作員角色。
- 權限範圍由子指令決定：
  - `status`, `logs` → 讀取
  - `agent`, `message` → 寫入
  - `config`, `channels` → 管理員
  - 授權 + 配對 → `operator.approvals` / `operator.pairing`

---

# 身份與 slug

## 穩定 ID

用於認證；永遠不變。
建議使用：

- 金鑰對指紋（公鑰雜湊）。

## 可愛的蝸牛（龍蝦主題）

僅限人工標籤。

- 範例：`scarlet-claw`、`saltwave`、`mantis-pinch`。
- 儲存在 gateway registry，可編輯。
- 碰撞處理：`-2`、`-3`。

## UI 群組

相同 `deviceId` 跨角色 → 單一「Instance」列：

- 徽章：`operator`、`node`。
- 顯示功能與最後出現時間。

---

# 遷移策略

## 階段 0：文件與對齊

- 發布此文件。
- 清點所有協議呼叫與審核流程。

## 階段 1：新增角色/範圍至 WS

- 擴充 `connect` 參數，加入 `role`、`scope`、`deviceId`。
- 為節點角色新增允許清單控管。

## 階段 2：橋接相容性

- 持續執行橋接。
- 同步新增 WS 節點支援。
- 以設定旗標控管功能開啟。

## 階段 3：中央審核

- 在 WS 中新增批准請求與解決事件。
- 更新 mac 應用程式 UI 以提示並回應。
- Node 執行環境停止提示 UI。

## 第四階段：TLS 統一

- 使用 bridge TLS 執行環境為 WS 新增 TLS 設定。
- 為用戶端新增 pinning。

## 第五階段：棄用 bridge

- 將 iOS/Android/mac 節點遷移至 WS。
- 保留 bridge 作為備援；穩定後移除。

## 第六階段：裝置綁定認證

- 所有非本地連線皆需基於金鑰的身份驗證。
- 新增撤銷與輪替 UI。

---

# 安全說明

- 角色與允許清單於閘道邊界強制執行。
- 無用戶端在無操作員範圍下取得「完整」API 權限。
- 所有連線皆需配對。
- TLS 與 pinning 降低行動裝置中間人攻擊風險。
- SSH 靜默批准為便利功能；仍會被記錄且可撤銷。
- 探索功能從不作為信任錨點。
- 能力聲明會依平台/類型對照伺服器允許清單進行驗證。

# 串流與大型負載（節點媒體）

WS 控制平面適合小訊息，但節點也會處理：

- 攝影機片段
- 螢幕錄影
- 音訊串流

選項：

1. WS 二進位框架 + 分塊 + 背壓規則。
2. 獨立串流端點（仍使用 TLS 與認證）。
3. 對媒體密集指令延長使用 bridge，最後再遷移。

實作前請先選擇一項以避免偏移。

# 能力 + 指令政策

- 節點回報的能力/指令視為**聲明**。
- Gateway 強制執行每個平台的允許清單。
- 任何新指令都需操作員批准或明確修改允許清單。
- 變更需審計並附帶時間戳。

# 審計 + 限速

- 紀錄：配對請求、批准/拒絕、token 發行/輪替/撤銷。
- 限制配對垃圾訊息和批准提示的頻率。

# 協議衛生

- 明確的協議版本 + 錯誤程式碼。
- 重連規則 + 心跳政策。
- 在線存活時間 (TTL) 與最後見到語意。

---

# 開放問題

1. 單一裝置同時執行兩個角色：token 模型
   - 建議每個角色（節點 vs 操作員）使用獨立 token。
   - 相同 deviceId；不同權限範圍；撤銷更清晰。

2. 操作員權限範圍細分
   - 讀取/寫入/管理 + 批准 + 配對（最小可行方案）。
   - 後續可考慮每功能權限範圍。

3. Token 輪替 + 撤銷使用者體驗
   - 角色變更時自動輪替。
   - UI 支援依 deviceId + 角色撤銷。

4. 裝置發現
   - 擴充現有 Bonjour TXT，包含 WS TLS 指紋 + 角色提示。
   - 僅作為定位提示使用。

5. 跨網路批准
   - 廣播給所有操作員用戶端；活躍 UI 顯示模態視窗。
   - 先回應者勝出；Gateway 強制原子性。

---

# 摘要 (TL;DR)

- 今日狀況：WS 控制平面 + Bridge 節點傳輸。
- 問題點：審核流程繁瑣 + 重複作業 + 兩套架構。
- 提案：單一 WS 協議，明確角色與範圍，統一配對 + TLS 固定，閘道主機承載審核，穩定裝置 ID + 可愛的 slug。
- 結果：更簡潔的使用者體驗、更強的安全性、減少重複作業、改善行動路由。
