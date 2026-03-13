---
title: Formal Verification (Security Models)
summary: Machine-checked security models for OpenClaw’s highest-risk paths.
read_when:
  - Reviewing formal security model guarantees or limits
  - Reproducing or updating TLA+/TLC security model checks
permalink: /security/formal-verification/
---

# 形式驗證（安全模型）

本頁面追蹤 OpenClaw 的 **形式安全模型**（目前使用 TLA+/TLC；未來視需求擴充）。

> 注意：部分舊連結可能指向先前的專案名稱。

**目標（北極星）：** 提供機器檢查的論證，證明 OpenClaw 在明確假設下，能夠強制執行其預期的安全政策（授權、會話隔離、工具閘控及錯誤設定安全性）。

**目前狀態：** 一套可執行、由攻擊者驅動的 **安全回歸測試套件**：

- 每個主張都有一個可執行的模型檢查，涵蓋有限狀態空間。
- 許多主張配有對應的 **負面模型**，可針對真實漏洞類別產生反例追蹤。

**尚未達成：** 證明「OpenClaw 在所有方面皆安全」或完整 TypeScript 實作的正確性。

## 模型存放位置

模型維護於獨立的倉庫：[vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models)。

## 重要注意事項

- 這些是 **模型**，非完整的 TypeScript 實作。模型與程式碼間可能存在偏差。
- 結果受限於 TLC 探索的狀態空間；「綠燈」不代表超出模型假設與範圍之外的安全性。
- 部分主張依賴明確的環境假設（例如正確部署、正確的設定輸入）。

## 重現結果

目前，結果可透過本地複製模型倉庫並執行 TLC 來重現（詳見下方）。未來版本可能提供：

- CI 執行模型並公開產物（反例追蹤、執行日誌）
- 一個託管的「執行此模型」工作流程，用於小型且有限的檢查

開始使用：

bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# 需要 Java 11 以上版本（TLC 在 JVM 上執行）。

# 此倉庫包含一個固定版本的 `tla2tools.jar`（TLA+ 工具），並提供 `bin/tlc` 及 Make 目標。

make <target>

### Gateway 暴露與開放 Gateway 錯誤設定

**主張：** 在未經授權的情況下綁定非回環地址可能導致遠端攻擊風險增加；token/密碼可阻擋未授權攻擊者（依模型假設）。

- 綠燈執行：
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- 紅燈（預期）：
  - `make gateway-exposure-v2-negative`

另見：模型倉庫中的 `docs/gateway-exposure-matrix.md`。

### Nodes.run 流程（最高風險功能）

**主張：** `nodes.run` 需要 (a) node 指令白名單及宣告指令，且 (b) 設定時需即時批准；批准會被 token 化以防重放（依模型）。

- 綠燈執行：
  - `make nodes-pipeline`
  - `make approvals-token`
- 紅燈（預期）：
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### 配對存儲（DM 門控）

**主張：** 配對請求會遵守 TTL 及待處理請求上限。

- 綠燈執行：
  - `make pairing`
  - `make pairing-cap`
- 紅燈（預期）：
  - `make pairing-negative`
  - `make pairing-cap-negative`

### 入口門控（提及與控制指令繞過）

**主張：** 在需要提及的群組情境中，未授權的「控制指令」無法繞過提及門控。

- 綠色：
  - `make ingress-gating`
- 紅色（預期）：
  - `make ingress-gating-negative`

### 路由／會話金鑰隔離

**主張：** 來自不同對等端的私訊不會合併到同一個會話，除非明確連結或設定。

- 綠色：
  - `make routing-isolation`
- 紅色（預期）：
  - `make routing-isolation-negative`

## v1++：額外的有界模型（併發、重試、追蹤正確性）

這些是後續模型，用以加強對真實世界失效模式（非原子更新、重試與訊息分發）的準確度。

### 配對存儲併發／冪等性

**主張：** 配對存儲應該在交錯執行下仍強制執行 `MaxPending` 和冪等性（也就是「先檢查再寫入」必須是原子操作／加鎖；刷新不應產生重複專案）。

意涵：

- 在併發請求下，頻道的數量不可超過 `MaxPending`。
- 對同一 `(channel, sender)` 的重複請求／刷新不應產生重複的待處理資料列。

- 綠色執行：
  - `make pairing-race`（原子／加鎖的容量檢查）
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- 紅色（預期）：
  - `make pairing-race-negative`（非原子開始／提交容量競爭）
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### 入口追蹤關聯／冪等性

**主張：** 資料攝取應在訊息分發過程中保持追蹤關聯，且在供應商重試時保持冪等性。

意涵：

- 當一個外部事件變成多個內部訊息時，每個部分都保有相同的追蹤／事件識別。
- 重試不會導致重複處理。
- 若供應商事件 ID 缺失，去重機制會退回使用安全的鍵（例如追蹤 ID），以避免遺漏不同事件。

- Green:
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- Red (expected):
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### 路由 dmScope 優先權 + identityLinks

**主張：** 路由預設必須保持 DM 會話隔離，只有在明確設定（頻道優先權 + identity links）時才合併會話。

這代表：

- 頻道特定的 dmScope 覆寫必須優先於全域預設。
- identityLinks 應該只在明確連結的群組內合併，不應跨越無關的對等者。

- Green:
  - `make routing-precedence`
  - `make routing-identitylinks`
- Red (expected):
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
