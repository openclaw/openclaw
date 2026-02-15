---
summary: "Clawnet 重構：統一網路協定、角色、認證、核准與身分"
read_when:
  - 規劃節點與操作員端使用的統一網路協定時
  - 重新調整裝置間的核准、配對、TLS 與 Presence (狀態) 時
title: "Clawnet 重構"
---

# Clawnet 重構 (協定 + 認證統一)

## 嗨

嗨 Peter — 這是個很棒的方向；這將帶來更簡單的 UX 以及更強的安全性。

## 目的

這是一份針對以下內容的嚴謹文件：

- 現狀：協定、流程、信任邊界。
- 痛點：核准、多跳路由、UI 重複。
- 提議的新狀態：單一協定、限縮的角色權限、統一的認證/配對、TLS Pinning。
- 身分模型：穩定的 ID + 可愛代號 (Slug)。
- 遷移計畫、風險、待決問題。

## 目標 (源自討論)

- 所有用戶端 (mac app, CLI, iOS, Android, 無周邊節點) 統一使用單一協定。
- 每個網路參與者都經過認證並完成配對。
- 角色清晰：節點 vs 操作員。
- 集中核准機制，並路由至使用者所在的裝置。
- 所有遠端傳輸皆採用 TLS 加密 + 選用的 Pinning。
- 最小化程式碼重複。
- 單一機器應只出現一次 (不重複出現 UI/節點 項目)。

## 非目標 (明確定義)

- 移除能力分離 (仍需遵循最小權限原則)。
- 在未經範圍檢查的情況下暴露完整的 Gateway 控制層。
- 讓認證依賴於人類可讀的標籤 (代號仍不具備安全性)。

---

# 現狀 (As-is)

## 兩種協定

### 1) Gateway WebSocket (控制層)

- 完整的 API 範圍：設定、頻道、模型、工作階段、智慧代理運行、日誌、節點等。
- 預設綁定：local loopback。透過 SSH/Tailscale 進行遠端存取。
- 認證：透過 `connect` 傳送權杖/密碼。
- 無 TLS Pinning (依賴於 local loopback/通道)。
- 程式碼：
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2) Bridge (節點傳輸)

- 窄小的白名單範圍、節點身分 + 配對。
- 基於 TCP 的 JSONL；選用的 TLS + 憑證指紋 Pinning。
- TLS 在裝置探索 TXT 中宣告指紋。
- 程式碼：
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## 目前的控制層用戶端

- CLI → 透過 `callGateway` (`src/gateway/call.ts`) 連接至 Gateway WS。
- macOS app UI → Gateway WS (`GatewayConnection`)。
- Web 控制 UI → Gateway WS。
- ACP → Gateway WS。
- 瀏覽器控制使用其專有的 HTTP 控制伺服器。

## 目前的節點

- 處於節點模式的 macOS app 連接至 Gateway Bridge (`MacNodeBridgeSession`)。
- iOS/Android app 連接至 Gateway Bridge。
- 配對資訊與每個節點的權杖儲存於 Gateway。

## 目前的核准流程 (執行)

- 智慧代理透過 Gateway 使用 `system.run`。
- Gateway 透過 Bridge 調用節點。
- 節點執行環境決定是否核准。
- 由 mac app 顯示 UI 提示 (當節點為 mac app 時)。
- 節點向 Gateway 回傳 `invoke-res`。
- 多跳流程，UI 綁定在節點主機上。

## 目前的狀態與身分

- Gateway 的 Presence (狀態) 條目來自 WS 用戶端。
- 節點的 Presence 條目來自 Bridge。
- mac app 可能針對同一台機器顯示兩個條目 (UI + 節點)。
- 節點身分儲存於配對儲存空間；UI 身分則獨立分開。

---

# 問題 / 痛點

- 需維護兩套協定堆疊 (WS + Bridge)。
- 遠端節點的核准：提示出現在節點主機上，而非使用者目前所在的裝置。
- TLS Pinning 僅存在於 Bridge；WS 則依賴於 SSH/Tailscale。
- 身分重複：同一台機器顯示為多個執行個體。
- 角色模糊：UI、節點與 CLI 的功能界限不明確。

---

# 提議的新狀態 (Clawnet)

## 單一協定，兩種角色

單一 WS 協定，具備角色 (Role) 與權限範圍 (Scope)。

- **角色：node (節點)** (能力主機)
- **角色：operator (操作員)** (控制層)
- 操作員的選用**權限範圍 (Scope)**：
  - `operator.read` (狀態與檢視)
  - `operator.write` (智慧代理運行、發送)
  - `operator.admin` (設定、頻道、模型)

### 角色行為

**Node (節點)**

- 可以註冊能力 (`caps`, `commands`, 權限)。
- 可以接收 `invoke` 指令 (`system.run`, `camera.*`, `canvas.*`, `screen.record` 等)。
- 可以發送事件：`voice.transcript`, `agent.request`, `chat.subscribe`。
- 無法調用設定/模型/頻道/工作階段/智慧代理控制層的 API。

**Operator (操作員)**

- 擁有完整的控制層 API，受權限範圍管制。
- 接收所有核准請求。
- 不直接執行作業系統動作；而是路由至節點。

### 關鍵規則

角色是根據「連線」定義，而非根據「裝置」。一台裝置可以分別以兩種角色開啟連線。

---

# 統一認證與配對

## 用戶端身分

每個用戶端提供：

- `deviceId` (穩定的，衍生自裝置金鑰)。
- `displayName` (易讀名稱)。
- `role` + `scope` + `caps` + `commands`。

## 配對流程 (統一)

- 用戶端在未經認證的情況下連線。
- Gateway 為該 `deviceId` 建立一個**配對請求**。
- 操作員收到提示；核准或拒絕。
- Gateway 核發認證憑證，綁定至：
  - 裝置公鑰
  - 角色 (Roles)
  - 權限範圍 (Scopes)
  - 能力 (Capabilities) / 指令 (Commands)
- 用戶端持久化儲存權杖，並以通過認證的狀態重新連線。

## 裝置綁定認證 (避免持有者權杖重放)

偏好方式：裝置金鑰對。

- 裝置產生一次性金鑰對。
- `deviceId = fingerprint(publicKey)`。
- Gateway 發送 Nonce；裝置簽署；Gateway 驗證。
- 權杖核發給公鑰 (持有證明)，而非字串。

替代方案：

- mTLS (用戶端憑證)：最強大，但操作複雜度較高。
- 僅將短效持有者權杖 (Bearer tokens) 作為過渡階段 (提早輪換並撤銷)。

## 靜默核准 (SSH 啟發式)

精確定義以避免弱連結。偏好其中之一：

- **僅限本地 (Local-only)**：當用戶端透過 local loopback/Unix socket 連線時自動配對。
- **透過 SSH 挑戰**：Gateway 發送 Nonce；用戶端透過讀取該 Nonce 證明具備 SSH 權限。
- **物理在場窗口**：在 Gateway 主機 UI 完成本地核准後，允許短時間內 (例如 10 分鐘) 的自動配對。

務必記錄 (Log) 並存檔所有自動核准行為。

---

# 全面採用 TLS (開發與生產環境)

## 重用現有的 Bridge TLS

使用目前的 TLS 執行環境與指紋 Pinning：

- `src/infra/bridge/server/tls.ts`
- 位於 `src/node-host/bridge-client.ts` 的指紋驗證邏輯

## 套用至 WS

- WS 伺服器支援 TLS，使用相同的憑證/金鑰與指紋。
- WS 用戶端可以進行指紋 Pinning (選用)。
- 裝置探索為所有端點宣告 TLS 與指紋。
  - 裝置探索僅作為定位提示；絕不作為信任來源。

## 原因

- 減少對 SSH/Tailscale 進行機密傳輸的依賴。
- 讓遠端行動連線預設即具備安全性。

---

# 核准機制重新設計 (集中化)

## 現狀

核准發生在節點主機 (mac app 節點執行環境)。提示出現在節點運行的位置。

## 提議

核准由 **Gateway 託管**，UI 傳送至操作員端用戶端。

### 新流程

1. Gateway 接收 `system.run` 意圖 (來自智慧代理)。
2. Gateway 建立核准紀錄：`approval.requested`。
3. 操作員 UI 顯示提示。
4. 核准決定傳送至 Gateway：`approval.resolve`。
5. 若核准，Gateway 調用節點指令。
6. 節點執行並回傳 `invoke-res`。

### 核准語意 (強化)

- 廣播至所有操作員；僅有活動中的 UI 會顯示互動視窗 (其他端則收到通知)。
- 以第一個回應為準；Gateway 會拒絕後續已結案的處理請求。
- 預設逾時：N 秒 (例如 60 秒) 後拒絕，並記錄原因。
- 處理核准需要 `operator.approvals` 權限範圍。

## 優點

- 提示出現在使用者所在地 (Mac/手機)。
- 遠端節點具備一致的核准機制。
- 節點執行環境保持無周邊 (Headless) 狀態；不依賴 UI。

---

# 角色定義範例

## iPhone app

- **Node (節點) 角色**用於：麥克風、相機、語音通話、位置、一鍵通 (PTT)。
- 選用 **operator.read** 用於狀態與聊天檢視。
- 選用 **operator.write/admin** 僅在明確啟用的情況下使用。

## macOS app

- 預設為 Operator (操作員) 角色 (控制 UI)。
- 當啟用「Mac 節點」時具備 Node (節點) 角色 (system.run, 螢幕, 相機)。
- 兩個連線使用相同的 deviceId → UI 條目合併。

## CLI

- 始終為 Operator (操作員) 角色。
- 權限範圍由子指令衍生：
  - `status`, `logs` → read
  - `agent`, `message` → write
  - `config`, `channels` → admin
  - 核准與配對 → `operator.approvals` / `operator.pairing`

---

# 身分與 Slugs

## 穩定 ID

認證必需項；永不改變。
偏好：

- 金鑰對指紋 (公鑰雜湊)。

## 可愛代號 (Slug，以龍蝦為主題)

僅作為人類識別標籤。

- 範例：`scarlet-claw`, `saltwave`, `mantis-pinch`。
- 儲存於 Gateway 註冊表，可編輯。
- 衝突處理：自動加上 `-2`, `-3`。

## UI 分組

跨角色的相同 `deviceId` → 單一「執行個體」列：

- 徽章：`operator`, `node`。
- 顯示能力與最後上線時間。

---

# 遷移策略

## 階段 0：文件化與對齊

- 發佈此文件。
- 盤點所有協定調用與核准流程。

## 階段 1：為 WS 加入角色/權限範圍

- 在 `connect` 參數中擴充 `role`, `scope`, `deviceId`。
- 為 Node 角色加入白名單管制。

## 階段 2：Bridge 相容性

- 維持 Bridge 運行。
- 同步加入 WS 節點支援。
- 透過設定旗標管制功能。

## 階段 3：集中化核准

- 在 WS 中加入核准請求與處理事件。
- 更新 mac app UI 以進行提示與回應。
- 節點執行環境停止顯示 UI 提示。

## 階段 4：TLS 統一

- 使用 Bridge TLS 執行環境為 WS 加入 TLS 設定。
- 為用戶端加入 Pinning 功能。

## 階段 5：棄用 Bridge

- 將 iOS/Android/mac 節點遷移至 WS。
- 保留 Bridge 作為備援；待穩定後移除。

## 階段 6：裝置綁定認證

- 所有非本地連線皆要求基於金鑰的身分認證。
- 加入撤銷與輪換的 UI。

---

# 安全性說明

- 角色/白名單在 Gateway 邊界強制執行。
- 未經操作員權限範圍授權，任何用戶端皆無法獲得「完整」API 存取權。
- **所有**連線皆需配對。
- TLS + Pinning 降低了行動端遭受中間人攻擊 (MITM) 的風險。
- SSH 靜默核准是為了便利性；仍會被記錄且可撤銷。
- 裝置探索絕不作為信任來源。
- 能力宣告會根據平台/類型與伺服器的白名單進行驗證。

# 串流與大型負載 (節點媒體)

WS 控制層處理小訊息沒問題，但節點還需處理：

- 相機短片
- 螢幕錄影
- 音訊串流

選項：

1. WS 二進位框架 + 分塊 + 背壓 (Backpressure) 規則。
2. 獨立的串流端點 (仍需 TLS + 認證)。
3. 在媒體密集型指令中保留 Bridge 較長時間，最後再進行遷移。

在實作前需擇一決定，以避免架構發散。

# 能力與指令政策

- 節點回報的能力/指令被視為**宣告 (Claims)**。
- Gateway 強制執行各平台的白名單。
- 任何新指令皆需操作員核准或明確的白名單變更。
- 變更需附帶時間戳記以進行稽核。

# 稽核與速率限制

- 記錄：配對請求、核准/拒絕、權杖核發/輪換/撤銷。
- 限制配對垃圾訊息與核准提示的速率。

# 協定規範 (Protocol hygiene)

- 明確的協定版本與錯誤代碼。
- 重連規則與活動訊號 (Heartbeat) 政策。
- Presence TTL 與最後上線語意。

---

# 待決問題

1. 同一台裝置運行兩種角色：權杖模型
   - 建議每個角色使用獨立權杖 (節點 vs 操作員)。
   - 相同 deviceId；不同權限範圍；撤銷機制更清晰。

2. 操作員權限範圍細節
   - read/write/admin + approvals + pairing (最小可行性)。
   - 後續考慮針對各別功能細分權限範圍。

3. 權杖輪換與撤銷 UX
   - 角色變更時自動輪換。
   - UI 可根據 deviceId + 角色進行撤銷。

4. 裝置探索
   - 擴充現有的 Bonjour TXT，納入 WS TLS 指紋與角色提示。
   - 僅將其視為定位提示。

5. 跨網路核准
   - 廣播至所有操作員用戶端；活動中的 UI 顯示互動視窗。
   - 第一個回應者勝出；Gateway 強制執行原子性 (Atomicity)。

---

# 總結 (TL;DR)

- 目前：WS 控制層 + Bridge 節點傳輸。
- 痛點：核准流程複雜、重複、維護兩套堆疊。
- 提案：統一 WS 協定並具備明確角色與權限範圍、統一配對與 TLS Pinning、Gateway 託管核准、穩定的裝置 ID 與可愛代號。
- 成果：更簡單的 UX、更強的安全性、更少的重複、更佳的行動端路由。
