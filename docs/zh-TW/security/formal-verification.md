---
title: 形式驗證（安全模型）
summary: OpenClaw 高風險路徑的機器驗證安全模型。
permalink: /security/formal-verification/
---

# 形式驗證（安全模型）

此頁面追蹤 OpenClaw 的**形式安全模型**（目前為 TLA+/TLC；視需求增加）。

> 注意：部分舊連結可能參考先前的專案名稱。

**目標（北極星）：** 在明確的假設下，提供機器驗證的論證，證明 OpenClaw 執行其預期的安全策略（授權、工作階段隔離、工具閘控和錯誤設定安全）。

**目前現狀：** 一個可執行的、攻擊者驅動的**安全迴歸套件**：

- 每個聲明都有一個在有限狀態空間上可運行的模型檢查。
- 許多聲明都配有一個**負面模型**，用於為實際的錯誤類別產生反例追蹤。

**尚未實現的目標：** 證明「OpenClaw 在所有方面都是安全的」，或證明完整的 TypeScript 實作是正確的。

## 模型儲存位置

模型儲存於獨立的儲存庫中：[vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models)。

## 重要注意事項

- 這些是**模型**，而非完整的 TypeScript 實作。模型與程式碼之間可能存在差異。
- 結果受 TLC 探索的狀態空間限制；「綠燈」不代表超出模型假設和限制範圍的安全。
- 部分聲明依賴明確的環境假設（例如，正確部署、正確設定輸入）。

## 重現結果

目前，透過在本機複製模型儲存庫並執行 TLC 來重現結果（請參閱下方）。未來迭代可能提供：

- 帶有公共產物（反例追蹤、執行日誌）的 CI 運行模型
- 用於小型、有界檢查的託管「運行此模型」工作流程

入門指南：

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# 需要 Java 11+（TLC 在 JVM 上運行）。
# 儲存庫供應固定版本的 `tla2tools.jar`（TLA+ 工具），並提供 `bin/tlc` + Make 目標。

make <target>
```

### Gateway 暴露與 Gateway 錯誤設定

**聲明：** 未經授權，將綁定暴露於 loopback 之外可能導致遠端入侵或增加暴露風險；權杖/密碼可防止未經授權的攻擊者（依模型假設）。

- 綠燈運行：
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- 紅燈（預期）：
  - `make gateway-exposure-v2-negative`

另請參閱：模型儲存庫中的 `docs/gateway-exposure-matrix.md`。

### Nodes.run 管線（最高風險能力）

**聲明：** `nodes.run` 需要 (a) 節點指令允許清單以及聲明指令，以及 (b) 設定時的即時核准；核准會被權杖化以防止重放（在模型中）。

- 綠燈運行：
  - `make nodes-pipeline`
  - `make approvals-token`
- 紅燈（預期）：
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### 配對儲存（私訊閘控）

**聲明：** 配對請求遵守 TTL 和待處理請求限制。

- 綠燈運行：
  - `make pairing`
  - `make pairing-cap`
- 紅燈（預期）：
  - `make pairing-negative`
  - `make pairing-cap-negative`

### 引入閘控（提及 + 控制指令繞過）

**聲明：** 在需要提及的群組上下文中，未經授權的「控制指令」無法繞過提及閘控。

- 綠燈：
  - `make ingress-gating`
- 紅燈（預期）：
  - `make ingress-gating-negative`

### 路由/工作階段金鑰隔離

**聲明：** 來自不同對等節點的私訊不會合併到相同的工作階段，除非明確連結/設定。

- 綠燈：
  - `make routing-isolation`
- 紅燈（預期）：
  - `make routing-isolation-negative`

## v1++：額外有界模型（並行性、重試、追蹤正確性）

這些是後續模型，它們針對現實世界中的故障模式（非原子更新、重試和訊息扇出）收緊了準確度。

### 配對儲存並行性/冪等性

**聲明：** 配對儲存應即使在交錯的情況下（即「檢查後寫入」必須是原子/鎖定操作；刷新不應產生重複項），也應強制執行 `MaxPending` 和冪等性。

這意味著：

- 在並行請求下，通道不能超過 `MaxPending`。
- 對於相同的 `(channel, sender)`，重複請求/刷新不應產生重複的即時待處理行。

- 綠燈運行：
  - `make pairing-race`（原子/鎖定上限檢查）
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- 紅燈（預期）：
  - `make pairing-race-negative`（非原子開始/提交上限競爭）
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### 引入追蹤關聯/冪等性

**聲明：** 引入應在扇出時保留追蹤關聯，並在提供者重試時保持冪等性。

這意味著：

- 當一個外部事件變成多個內部訊息時，每個部分都保持相同的追蹤/事件識別。
- 重試不會導致重複處理。
- 如果提供者事件 ID 遺失，重複資料刪除會退回到安全鍵（例如，追蹤 ID），以避免丟失不同的事件。

- 綠燈：
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- 紅燈（預期）：
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### 路由 dmScope 優先順序 + identityLinks

**聲明：** 路由預設必須保持私訊工作階段隔離，並且僅在明確設定時（通道優先順序 + 身份連結）才合併工作階段。

這意味著：

- 通道特定的 dmScope 覆寫必須優於全域預設值。
- identityLinks 應僅在明確連結的群組內合併，而不是跨不相關的對等節點。

- 綠燈：
  - `make routing-precedence`
  - `make routing-identitylinks`
- 紅燈（預期）：
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
