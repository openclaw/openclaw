---
title: 形式驗證 (安全模型)
summary: 針對 OpenClaw 最高風險路徑的機器檢查安全模型。
permalink: /security/formal-verification/
---

# 形式驗證 (安全模型)

本頁面追蹤 OpenClaw 的 **形式安全模型** (目前使用 TLA+/TLC；視需要增加)。

> 注意：部分舊連結可能會指向先前的專案名稱。

**目標 (願景)：** 在明確的假設下，提供經過機器檢查的論據，證明 OpenClaw 確實執行了其預期的安全策略 (授權、工作階段隔離、工具閘控和錯誤設定安全性)。

**現狀 (今日)：** 一套可執行的、由攻擊者驅動的 **安全迴歸測試套件**：

- 每個宣稱在有限狀態空間內都有一個可執行的模型檢查。
- 許多宣稱都配有一個 **負面模型 (negative model)**，可針對現實中的錯誤類型產生反例追蹤。

**非目標 (尚未達成)：** 證明「OpenClaw 在所有方面都是安全的」，或是證明完整的 TypeScript 實作完全正確。

## 模型儲存位置

模型維護於獨立的儲存庫：[vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models)。

## 重要注意事項

- 這些是 **模型**，而非完整的 TypeScript 實作。模型與程式碼之間可能存在差異。
- 結果受限於 TLC 探索的狀態空間；「綠色 (通過)」並不代表在模型假設和範圍之外也是安全的。
- 某些宣稱依賴於明確的環境假設 (例如：正確的部署、正確的設定輸入)。

## 重現結果

目前透過在本機複製模型儲存庫並執行 TLC 來重現結果 (見下文)。未來的版本可能會提供：

- 具有公開產物 (反例追蹤、執行日誌) 的 CI 執行模型
- 針對小型有界檢查的託管式「執行此模型」工作流

入門指南：

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# 需要 Java 11+ (TLC 執行於 JVM)
# 該儲存庫內含固定版本的 `tla2tools.jar` (TLA+ 工具)，並提供 `bin/tlc` 與 Make 目標

make <target>
```

### Gateway 暴露與開放 Gateway 錯誤設定

**宣稱：** 在沒有驗證的情況下綁定至 local loopback 以外的介面可能會導致遠端入侵 / 增加暴露風險；根據模型假設，權杖 (token)/密碼可以阻擋未經授權的攻擊者。

- 綠色執行結果：
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- 紅色 (預期結果)：
  - `make gateway-exposure-v2-negative`

另請參閱：模型儲存庫中的 `docs/gateway-exposure-matrix.md`。

### Nodes.run 管線 (最高風險功能)

**宣稱：** `nodes.run` 需要 (a) 智慧節點指令允許清單以及宣告的指令，以及 (b) 設定時需要即時核准；在模型中，核准過程經過權杖化以防止重放攻擊。

- 綠色執行結果：
  - `make nodes-pipeline`
  - `make approvals-token`
- 紅色 (預期結果)：
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### 配對儲存 (私訊閘控)

**宣稱：** 配對請求遵守 TTL 和待處理請求上限。

- 綠色執行結果：
  - `make pairing`
  - `make pairing-cap`
- 紅色 (預期結果)：
  - `make pairing-negative`
  - `make pairing-cap-negative`

### 入站閘控 (提及 + 控制指令規避)

**宣稱：** 在需要提及 (@提及) 的群組情境中，未經授權的「控制指令」無法規避提及閘控。

- 綠色：
  - `make ingress-gating`
- 紅色 (預期結果)：
  - `make ingress-gating-negative`

### 路由/工作階段金鑰隔離

**宣稱：** 來自不同對等點的私訊不會合併到同一個工作階段中，除非經過明確連結/設定。

- 綠色：
  - `make routing-isolation`
- 紅色 (預期結果)：
  - `make routing-isolation-negative`

## v1++：額外的有界模型 (並行、重試、追蹤正確性)

這些是後續的模型，旨在加強現實世界失敗模式 (非原子性更新、重試和訊息扇出) 的真實度。

### 配對儲存並行 / 冪等性

**宣稱：** 配對儲存即使在交錯執行的情況下，也應強制執行 `MaxPending` 和冪等性 (即「檢查後寫入」必須是原子性的 / 已鎖定；重新整理不應產生重複項)。

其代表意義：

- 在並行請求下，單一頻道不能超過 `MaxPending`。
- 針對同一個 `(channel, sender)` 的重複請求/重新整理不應產生重複的活動待處理資料列。

- 綠色執行結果：
  - `make pairing-race` (原子性/鎖定上限檢查)
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- 紅色 (預期結果)：
  - `make pairing-race-negative` (非原子性開始/提交上限競爭)
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### 入站追蹤相關性 / 冪等性

**宣稱：** 入站處理應在扇出時保持追蹤相關性，並且在供應商重試下保持冪等性。

其代表意義：

- 當一個外部事件變成多個內部訊息時，每個部分都保有相同的追蹤/事件標識。
- 重試不會導致重複處理。
- 如果缺少供應商事件 ID，去重機制會降級至安全鍵 (例如：追蹤 ID) 以避免遺失不同的事件。

- 綠色：
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- 紅色 (預期結果)：
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### 路由 dmScope 優先順序 + identityLinks

**宣稱：** 路由預設必須保持私訊工作階段隔離，僅在明確設定 (頻道優先順序 + 身分連結) 時才合併工作階段。

其代表意義：

- 頻道特定的 dmScope 覆寫必須優於全域預設值。
- identityLinks 應僅在明確連結的群組內合併，而不應跨越無關的對等點。

- 綠色：
  - `make routing-precedence`
  - `make routing-identitylinks`
- 紅色 (預期結果)：
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
