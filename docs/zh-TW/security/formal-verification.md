---
title: 形式化驗證（安全性模型）
summary: 針對 OpenClaw 最高風險路徑的機器檢查安全性模型。
permalink: /security/formal-verification/
x-i18n:
  source_path: security/formal-verification.md
  source_hash: 8dff6ea41a37fb6b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:29:27Z
---

# 形式化驗證（安全性模型）

本頁追蹤 OpenClaw 的**形式化安全性模型**（目前為 TLA+/TLC；未來視需要擴充）。

> 注意：部分較舊的連結可能仍使用先前的專案名稱。

**目標（北極星）：** 在明確假設之下，提供一個經機器檢查的論證，證明 OpenClaw 會強制執行其
預期的安全性政策（授權、工作階段隔離、工具管控，以及錯誤設定安全性）。

**這是什麼（目前）：** 一套可執行、以攻擊者視角驅動的**安全性回歸測試套件**：

- 每一項主張都有一個可執行的模型檢查，涵蓋有限狀態空間。
- 許多主張都配有成對的**負向模型**，可針對真實的錯誤類型產生反例軌跡。

**這不是什麼（目前尚未）：** 不是「OpenClaw 在所有面向上都是安全的」之證明，也不是對完整 TypeScript 實作正確性的證明。

## 模型所在位置

模型維護於獨立的儲存庫中：[vignesh07/openclaw-formal-models](https://github.com/vignesh07/openclaw-formal-models)。

## 重要注意事項

- 這些是**模型**，而非完整的 TypeScript 實作；模型與程式碼之間可能發生漂移。
- 結果受限於 TLC 探索的狀態空間；「綠燈」不代表在模型假設與界限之外仍然安全。
- 部分主張仰賴明確的環境假設（例如：正確部署、正確的設定輸入）。

## 重現結果

目前，重現方式是將模型儲存庫複製到本機並執行 TLC（見下方）。未來的迭代可能提供：

- 由 CI 執行的模型，並提供公開產出（反例軌跡、執行記錄）
- 為小型、受限檢查提供的託管式「執行此模型」工作流程

入門：

```bash
git clone https://github.com/vignesh07/openclaw-formal-models
cd openclaw-formal-models

# Java 11+ required (TLC runs on the JVM).
# The repo vendors a pinned `tla2tools.jar` (TLA+ tools) and provides `bin/tlc` + Make targets.

make <target>
```

### Gateway 暴露與開放式 Gateway 錯誤設定

**主張：** 在未驗證的情況下，繫結至非 loopback 介面可能使遠端入侵成為可能／增加暴露面；在模型假設下，權杖／密碼可阻擋未授權的攻擊者。

- 綠燈執行：
  - `make gateway-exposure-v2`
  - `make gateway-exposure-v2-protected`
- 紅燈（符合預期）：
  - `make gateway-exposure-v2-negative`

另請參閱模型儲存庫中的：`docs/gateway-exposure-matrix.md`。

### Nodes.run 管線（最高風險能力）

**主張：** `nodes.run` 需要（a）節點命令允許清單加上已宣告的命令，以及（b）在設定時需有即時核准；在模型中，核准會以權杖化方式防止重放。

- 綠燈執行：
  - `make nodes-pipeline`
  - `make approvals-token`
- 紅燈（符合預期）：
  - `make nodes-pipeline-negative`
  - `make approvals-token-negative`

### 配對儲存（私訊管控）

**主張：** 配對請求會遵守 TTL 與待處理請求數上限。

- 綠燈執行：
  - `make pairing`
  - `make pairing-cap`
- 紅燈（符合預期）：
  - `make pairing-negative`
  - `make pairing-cap-negative`

### 入口管控（提及 + 控制命令繞過）

**主張：** 在需要提及的群組情境中，未授權的「控制命令」無法繞過提及管控。

- 綠燈：
  - `make ingress-gating`
- 紅燈（符合預期）：
  - `make ingress-gating-negative`

### 路由／工作階段金鑰隔離

**主張：** 來自不同對端的私訊不會合併為同一個工作階段，除非明確連結／設定。

- 綠燈：
  - `make routing-isolation`
- 紅燈（符合預期）：
  - `make routing-isolation-negative`

## v1++：額外的受限模型（併發、重試、軌跡正確性）

這些是後續模型，用於強化對真實世界失敗模式的擬真度（非原子更新、重試與訊息扇出）。

### 配對儲存併發／冪等性

**主張：** 配對儲存即使在交錯執行下，也應強制 `MaxPending` 與冪等性（亦即「檢查再寫入」必須是原子／加鎖；重新整理不應建立重複項目）。

其含義為：

- 在併發請求下，單一頻道不可超過 `MaxPending`。
- 針對相同 `(channel, sender)` 的重複請求／重新整理，不應建立重複的即時待處理資料列。

- 綠燈執行：
  - `make pairing-race`（原子／加鎖的上限檢查）
  - `make pairing-idempotency`
  - `make pairing-refresh`
  - `make pairing-refresh-race`
- 紅燈（符合預期）：
  - `make pairing-race-negative`（非原子的 begin/commit 上限競態）
  - `make pairing-idempotency-negative`
  - `make pairing-refresh-negative`
  - `make pairing-refresh-race-negative`

### 入口軌跡關聯／冪等性

**主張：** 匯入流程應在扇出時保留軌跡關聯，並在提供者重試下具備冪等性。

其含義為：

- 當一個外部事件轉換為多個內部訊息時，每一部分都保有相同的軌跡／事件識別。
- 重試不會導致重複處理。
- 若缺少提供者事件 ID，去重會回退到安全的鍵（例如：軌跡 ID），以避免誤丟不同事件。

- 綠燈：
  - `make ingress-trace`
  - `make ingress-trace2`
  - `make ingress-idempotency`
  - `make ingress-dedupe-fallback`
- 紅燈（符合預期）：
  - `make ingress-trace-negative`
  - `make ingress-trace2-negative`
  - `make ingress-idempotency-negative`
  - `make ingress-dedupe-fallback-negative`

### 路由 dmScope 優先順序 + identityLinks

**主張：** 路由在預設情況下必須維持私訊工作階段隔離，且僅在明確設定時才合併工作階段（頻道優先順序 + 身分連結）。

其含義為：

- 頻道層級的 dmScope 覆寫必須優先於全域預設。
- identityLinks 僅應在明確連結的群組內合併，而非跨越不相關的對端。

- 綠燈：
  - `make routing-precedence`
  - `make routing-identitylinks`
- 紅燈（符合預期）：
  - `make routing-precedence-negative`
  - `make routing-identitylinks-negative`
