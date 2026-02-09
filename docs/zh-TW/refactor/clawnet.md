---
summary: "Clawnet 重構：統一網路協定、角色、驗證、核准與身分識別"
read_when:
  - Planning a unified network protocol for nodes + operator clients
  - 重新設計跨裝置的核准流程、配對、TLS 與線上狀態
title: "Clawnet 重構"
---

# Clawnet 重構（通訊協定 + 驗證統一）

## 嗨

嗨 Peter —— 方向很棒；這將解鎖更簡單的 UX 與更強的安全性。

## 目的

Single, rigorous document for:

- 目前狀態：協定、流程、信任邊界。
- 痛點：核准、多跳路由、UI 重複。
- 提出的新狀態：單一協定、具範圍的角色、統一的驗證／配對、TLS 釘選。
- 身分模型：穩定 ID + 可愛的 slug。
- 遷移計畫、風險、未解問題。

## 目標（來自討論）

- 所有用戶端使用單一協定（mac app、CLI、iOS、Android、headless node）。
- Every network participant authenticated + paired.
- 角色清楚：nodes 與 operators。
- 中央化的核准，導向使用者所在的位置。
- 所有遠端流量皆使用 TLS 加密 + 可選釘選。
- 最小化程式碼重複。
- 單一機器只顯示一次（不再有 UI／node 重複項目）。

## 非目標（明確）

- 移除能力分離（仍需最小權限）。
- 在沒有範圍檢查的情況下暴露完整 Gateway 閘道器 控制平面。
- 讓驗證依賴人工標籤（slug 仍非安全要素）。

---

# 目前狀態（現況）

## 兩種通訊協定

### 1）Gateway WebSocket（控制平面）

- 完整 API 範圍：設定、頻道、模型、工作階段、代理程式執行、日誌、節點等。
- 預設綁定：loopback。 透過 SSH／Tailscale 進行遠端存取。
- 驗證：透過 `connect` 的 token／密碼。
- 無 TLS 釘選（仰賴 loopback／通道）。
- 程式碼：
  - `src/gateway/server/ws-connection/message-handler.ts`
  - `src/gateway/client.ts`
  - `docs/gateway/protocol.md`

### 2）Bridge（節點傳輸）

- 縮小允許清單範圍，節點身分 + 配對。
- TCP 上的 JSONL；可選 TLS + 憑證指紋釘選。
- TLS 在探索 TXT 中宣告指紋。
- 程式碼：
  - `src/infra/bridge/server/connection.ts`
  - `src/gateway/server-bridge.ts`
  - `src/node-host/bridge-client.ts`
  - `docs/gateway/bridge-protocol.md`

## 目前的控制平面客戶端

- CLI → Gateway WS，透過 `callGateway`（`src/gateway/call.ts`）。
- macOS app UI → Gateway WS（`GatewayConnection`）。
- Web Control UI → Gateway WS。
- ACP → Gateway WS。
- 瀏覽器控制使用其自有的 HTTP 控制伺服器。

## 目前的節點

- macOS app 的 node 模式連線至 Gateway bridge（`MacNodeBridgeSession`）。
- iOS／Android app 連線至 Gateway bridge。
- Pairing + per‑node token stored on gateway.

## 目前的核准流程（執行）

- Agent 透過 Gateway 使用 `system.run`。
- Gateway 透過 bridge 呼叫節點。
- 節點執行階段決定是否核准。
- UI 提示由 mac app 顯示（當 node == mac app）。
- 節點回傳 `invoke-res` 給 Gateway。
- 1. 多跳，UI 綁定到節點主機。

## 目前的在線狀態 + 身分

- WS 用戶端的 Gateway 在線狀態項目。
- 來自橋接器的節點在線狀態項目。
- mac app 可能為同一台機器顯示兩個項目（UI + node）。
- 4. 節點身分儲存在配對存儲中；UI 身分獨立。

---

# 問題／痛點

- 需維護兩套協定堆疊（WS + Bridge）。
- 遠端節點上的核准：提示會出現在節點主機上，而非使用者所在位置。
- TLS 釘選僅存在於 bridge；WS 依賴 SSH／Tailscale。
- 身分重複：同一台機器顯示為多個實例。
- 角色不明確：UI + node + CLI 的能力界線不清。

---

# 提議的新狀態（Clawnet）

## 6. 一種協定，兩種角色

單一 WS 通訊協定，具備角色 + 範圍。

- **角色：node**（能力宿主）
- **角色：operator**（控制平面）
- operator 的可選 **scope**：
  - `operator.read`（狀態 + 檢視）
  - `operator.write`（agent 執行、傳送）
  - `operator.admin`（設定、頻道、模型）

### 角色行為

**Node**

- 可註冊能力（`caps`、`commands`、權限）。
- 可接收 `invoke` 指令（`system.run`、`camera.*`、`canvas.*`、`screen.record` 等）。
- 可送出事件：`voice.transcript`、`agent.request`、`chat.subscribe`。
- 不可呼叫設定／模型／頻道／工作階段／agent 的控制平面 API。

**Operator**

- 具範圍控管的完整控制平面 API。
- 接收所有核准。
- 不直接執行 OS 動作；改由路由至 nodes。

### 關鍵規則

角色是每個連線的屬性，而非每個裝置。 9. 一個裝置可以分別開啟兩種角色。

---

# 統一的驗證 + 配對

## 10. 用戶端身分

每個用戶端提供：

- `deviceId`（穩定，源自裝置金鑰）。
- `displayName`（人類可讀名稱）。
- `role` + `scope` + `caps` + `commands`。

## 11. 配對流程（統一）

- 用戶端以未驗證狀態連線。
- Gateway 為該 `deviceId` 建立 **配對請求**。
- Operator 收到提示；核准／拒絕。
- 閘道發行與下列項目綁定的憑證：
  - 裝置公開金鑰
  - 角色
  - 範圍（scope）
  - 能力／指令
- 用戶端保存權杖，並以驗證狀態重新連線。

## 裝置綁定的驗證（避免 bearer token 重播）

建議做法：裝置金鑰對。

- 裝置只需產生一次金鑰對。
- `deviceId = fingerprint(publicKey)`。
- Gateway 傳送 nonce；裝置簽署；Gateway 驗證。
- 18. 權杖是發行給公鑰的（持有證明），而不是字串。

替代方案：

- mTLS（用戶端憑證）：最強，但營運複雜度較高。
- 僅將短期存活的 Bearer 權杖作為暫時階段（輪替 + 提前撤銷）。

## 靜默核准（SSH 啟發式）

20. 精確定義以避免形成弱點。 1. 優先選擇一種：

- **僅限本機**：用戶端經由 loopback／Unix socket 連線時自動配對。
- **透過 SSH 的挑戰**：Gateway 發出 nonce；用戶端透過取得它來證明 SSH。
- **實體在場視窗**：在 Gateway 主機 UI 完成一次本機核准後，允許短時間（例如 10 分鐘）自動配對。

22. 始終記錄並保存自動核准。

---

# 全面 TLS（開發 + 正式）

## 重用既有的 bridge TLS

使用目前的 TLS 執行階段 + 指紋釘選：

- `src/infra/bridge/server/tls.ts`
- `src/node-host/bridge-client.ts` 中的指紋驗證邏輯

## 套用至 WS

- WS 伺服器以相同的憑證／金鑰 + 指紋支援 TLS。
- 3. WS 用戶端可釘選指紋（選用）。
- 探索為所有端點宣告 TLS + 指紋。
  - 探索僅作為定位提示；絕非信任錨點。

## 為什麼

- 降低對 SSH／Tailscale 的機密性依賴。
- 4. 預設讓遠端行動連線是安全的。

---

# 核准重新設計（中央化）

## 目前

5. 核准在節點主機上進行（mac 應用節點執行階段）。 26. 提示出現在節點執行的位置。

## 提議

27. 核准由 **gateway** 託管，UI 交付給操作員用戶端。

### 新流程

1. Gateway 接收 `system.run` 意圖（agent）。
2. Gateway 建立核准紀錄：`approval.requested`。
3. Operator UI 顯示提示。
4. 核准決策送回 Gateway：`approval.resolve`。
5. 28. 若獲核准，閘道會呼叫節點命令。
6. 節點執行並回傳 `invoke-res`。

### 核准語義（強化）

- 9. 廣播給所有操作員；只有作用中的 UI 會顯示模態視窗（其他顯示提示）。
- 30. 以第一次結果為準；閘道會拒絕後續的解決，並標示為已處理。
- 31. 預設逾時：N 秒後拒絕（例如 60 秒），並記錄原因。
- 需具 `operator.approvals` scope 才能解決。

## 好處

- 提示出現在使用者所在位置（mac／手機）。
- 32. 為遠端節點提供一致的核准機制。
- 33. 節點執行階段保持無頭；不依賴 UI。

---

# 角色清楚化範例

## iPhone app

- **Node 角色**：麥克風、相機、語音聊天、位置、按鍵對講。
- 可選 **operator.read**：狀態與聊天檢視。
- 僅在明確啟用時才提供 **operator.write/admin**。

## macOS app

- 預設為 Operator 角色（控制 UI）。
- 啟用「Mac node」時提供 Node 角色（system.run、螢幕、相機）。
- 兩種連線共用同一 deviceId → UI 合併為單一項目。

## CLI

- 永遠為 Operator 角色。
- scope 依子指令而定：
  - `status`、`logs` → read
  - `agent`、`message` → write
  - `config`、`channels` → admin
  - 核准 + 配對 → `operator.approvals`／`operator.pairing`

---

# 身分 + slug

## 穩定 ID

34. 為驗證所必需；且永不變更。
    建議：

- 35. 金鑰對指紋（公鑰雜湊）。

## 可愛的 slug（龍蝦主題）

36. 僅為人類可讀標籤。

- 範例：`scarlet-claw`、`saltwave`、`mantis-pinch`。
- 17. 儲存在 Gateway 登錄中，可編輯。
- 碰撞處理：`-2`、`-3`。

## UI 分組

跨角色相同的 `deviceId` → 單一「Instance」列：

- 徽章：`operator`、`node`。
- 18. 顯示能力與最後一次出現時間。

---

# 遷移策略

## 第 0 階段：文件 + 對齊

- 39. 發布此文件。
- 20. 盤點所有通訊協定呼叫與核准流程。

## 第 1 階段：為 WS 新增角色／範圍

- 擴充 `connect` 參數，加入 `role`、`scope`、`deviceId`。
- 21. 為節點角色新增允許清單（allowlist）門檻。

## 第 2 階段：Bridge 相容

- 保留 bridge 執行。
- 平行新增 WS node 支援。
- 42. 以設定旗標管控功能。

## 第 3 階段：中央化核准

- 43. 在 WS 中新增核准請求 + 解決事件。
- 更新 mac app UI 以顯示提示並回應。
- 44. 節點執行階段停止提示 UI。

## 第 4 階段：TLS 統一

- 使用 bridge TLS 執行階段為 WS 新增 TLS 設定。
- 45. 為用戶端新增釘選。

## 第 5 階段：淘汰 bridge

- 將 iOS／Android／mac node 遷移至 WS。
- 保留 bridge 作為後備；穩定後移除。

## 第 6 階段：裝置綁定驗證

- 26. 所有非本機連線皆要求以金鑰為基礎的身分識別。
- 新增撤銷 + 輪替 UI。

---

# 安全性注意事項

- 47. 在閘道邊界強制角色/允許清單。
- 無 operator scope 的用戶端不得取得「完整」API。
- 48. 所有連線都必須配對。
- TLS + 釘選降低行動端的 MITM 風險。
- SSH 靜默核准僅為便利；仍需記錄 + 可撤銷。
- 探索永遠不是信任錨點。
- 49. 能力宣告會依平台/類型由伺服器允許清單進行驗證。

# 串流 + 大型負載（節點媒體）

WS 控制平面適合小型訊息，但節點也會處理：

- 相機片段
- 螢幕錄製
- 音訊串流

選項：

1. WS 二進位框架 + 分塊 + 背壓規則。
2. 獨立的串流端點（仍使用 TLS + 驗證）。
3. 媒體密集指令保留 bridge 更久，最後再遷移。

在實作前擇一，以避免偏移。

# 能力 + 指令政策

- 30. 節點回報的能力／指令一律視為 **宣告**。
- Gateway 依平台執行允許清單。
- 任何新指令需 operator 核准或明確的允許清單變更。
- Audit changes with timestamps.

# 稽核 + 速率限制

- Log: pairing requests, approvals/denials, token issuance/rotation/revocation.
- Rate‑limit pairing spam and approval prompts.

# 協定衛生

- 明確的協定版本 + 錯誤碼。
- 重連規則 + 心跳政策。
- 在線狀態 TTL 與最後出現語義。

---

# 開放問題

1. 同一裝置同時執行兩種角色：token 模型
   - 建議每角色獨立 token（node vs operator）。
   - 相同 deviceId；不同 scope；撤銷更清楚。

2. Operator scope 粒度
   - read／write／admin + approvals + pairing（最小可行）。
   - 後續再考慮按功能細分。

3. Token 輪替 + 撤銷 UX
   - Auto‑rotate on role change.
   - 依 deviceId + 角色撤銷的 UI。

4. 探索
   - 擴充現有 Bonjour TXT，加入 WS TLS 指紋 + 角色提示。
   - Treat as locator hints only.

5. 跨網路核准
   - Broadcast to all operator clients; active UI shows modal.
   - First response wins; gateway enforces atomicity.

---

# 摘要（TL;DR）

- 現況：WS 控制平面 + Bridge 節點傳輸。
- 痛點：核准 + 重複 + 兩套堆疊。
- 提案：單一 WS 協定，具明確角色 + 範圍，統一配對 + TLS 釘選，Gateway 託管核准，穩定裝置 ID + 可愛 slug。
- 成果：更簡單的 UX、更強的安全性、更少重複、更佳的行動端路由。
