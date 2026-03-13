---
summary: "Context: what the model sees, how it is built, and how to inspect it"
read_when:
  - You want to understand what “context” means in OpenClaw
  - You are debugging why the model “knows” something (or forgot it)
  - "You want to reduce context overhead (/context, /status, /compact)"
title: Context
---

# 內容說明

「內容」是 **OpenClaw 傳送給模型執行時的所有資料**。它受限於模型的 **內容視窗**（token 限制）。

初學者心智模型：

- **系統提示**（OpenClaw 建置）：規則、工具、技能清單、時間/執行時間，以及注入的工作區檔案。
- **對話歷史**：你與助理在本次會話中的訊息。
- **工具呼叫/結果 + 附件**：指令輸出、檔案讀取、圖片/音訊等。

內容 _不等同於_「記憶」：記憶可以儲存在磁碟並稍後重新載入；內容則是模型當前視窗內的資料。

## 快速開始（檢視內容）

- `/status` → 快速查看「我的視窗使用了多少？」及會話設定。
- `/context list` → 注入了什麼 + 粗略大小（每個檔案 + 總計）。
- `/context detail` → 更深入拆解：每個檔案、每個工具 schema 大小、每個技能條目大小，以及系統提示大小。
- `/usage tokens` → 在一般回覆中附加每次回覆的使用量頁尾。
- `/compact` → 將較舊的歷史摘要成一個精簡條目以釋放視窗空間。

另見：[斜線指令](/tools/slash-commands)、[Token 使用與費用](/reference/token-use)、[壓縮](/concepts/compaction)。

## 範例輸出

數值會依模型、供應商、工具政策及工作區內容而異。

### `/context list`

🧠 內容拆解
工作區：<workspaceDir>
啟動最大/檔案：20,000 字元
沙盒：模式=非主沙盒，沙盒化=false
系統提示（執行）：38,412 字元（約 9,603 token）（專案內容 23,901 字元（約 5,976 token））

注入的工作區檔案：

- AGENTS.md：正常 | 原始 1,742 字元（約 436 token）| 注入 1,742 字元（約 436 token）
- SOUL.md：正常 | 原始 912 字元（約 228 token）| 注入 912 字元（約 228 token）
- TOOLS.md：截斷 | 原始 54,210 字元（約 13,553 token）| 注入 20,962 字元（約 5,241 token）
- IDENTITY.md：正常 | 原始 211 字元（約 53 token）| 注入 211 字元（約 53 token）
- USER.md：正常 | 原始 388 字元（約 97 token）| 注入 388 字元（約 97 token）
- HEARTBEAT.md：遺失 | 原始 0 | 注入 0
- BOOTSTRAP.md：正常 | 原始 0 字元（約 0 token）| 注入 0 字元（約 0 token）

技能清單（系統提示文字）：2,184 字元（約 546 token）（12 個技能）
工具：read、edit、write、exec、process、browser、message、sessions_send、…
工具清單（系統提示文字）：1,032 字元（約 258 token）
工具 schema（JSON）：31,988 字元（約 7,997 token）（計入內容；未以文字顯示）
工具：同上

會話 token（快取）：共 14,250 / ctx=32,000

### `/context detail`

🧠 上下文解析（詳細）
…
主要技能（提示輸入大小）：

- 前端設計：412 字元（約 103 token）
- Oracle：401 字元（約 101 token）
  …（還有 10 項以上技能）

主要工具（結構大小）：

- 瀏覽器：9,812 字元（約 2,453 token）
- 執行器：6,240 字元（約 1,560 token）
  …（還有 N 項以上工具）

## 什麼會計入上下文視窗

模型接收到的所有內容都會計入，包括：

- 系統提示（所有區段）。
- 對話歷史。
- 工具呼叫與工具結果。
- 附件／轉錄檔（圖片／音訊／檔案）。
- 壓縮摘要與修剪產物。
- 供應商「包裝器」或隱藏標頭（不可見，但仍計入）。

## OpenClaw 如何建立系統提示

系統提示由 **OpenClaw 擁有**，每次執行時重建。內容包含：

- 工具清單與簡短描述。
- 技能清單（僅元資料；詳見下方）。
- 工作區位置。
- 時間（UTC + 若有設定則轉換為使用者時間）。
- 執行時元資料（主機／作業系統／模型／思考狀態）。
- 注入的工作區啟動檔案，置於 **專案上下文**。

完整說明請見：[系統提示](/concepts/system-prompt)。

## 注入的工作區檔案（專案上下文）

預設情況下，OpenClaw 會注入一組固定的工作區檔案（若存在）：

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（僅首次執行）

大型檔案會依檔案使用 `agents.defaults.bootstrapMaxChars` 截斷（預設為 `20000` 字元）。OpenClaw 也會透過 `agents.defaults.bootstrapTotalMaxChars` 強制整體啟動注入上限（預設 `150000` 字元）。`/context` 顯示 **原始大小 vs 注入大小** 以及是否發生截斷。

當發生截斷時，執行時可在專案上下文中注入提示警告區塊。可透過 `agents.defaults.bootstrapPromptTruncationWarning`（`off`、`once`、`always`；預設 `once`）進行設定。

## 技能：什麼是注入的 vs 按需載入的

系統提示包含一個精簡的**技能清單**（名稱 + 描述 + 位置）。這個清單有實際的資源負擔。

技能指令預設不會包含。模型預期會在**需要時**`read`該技能的`SKILL.md`。

## 工具：有兩種成本

工具會以兩種方式影響上下文：

1. 系統提示中的**工具清單文字**（你看到的「工具」）。
2. **工具結構**（JSON）。這些會傳送給模型以便呼叫工具。即使你看不到它們的純文字，也會計入上下文。

`/context detail` 分解了最大的工具結構，讓你看出主要佔用的部分。

## 指令、指示與「內嵌捷徑」

斜線指令由 Gateway 處理。有幾種不同的行為：

- **獨立指令**：只有 `/...` 的訊息會作為指令執行。
- **指示**：`/think`、`/verbose`、`/reasoning`、`/elevated`、`/model`、`/queue` 會在模型看到訊息前被剝除。
  - 僅含指示的訊息會持續會話設定。
  - 正常訊息中的內嵌指示則作為每則訊息的提示。
- **內嵌捷徑**（僅限白名單發送者）：正常訊息中某些 `/...` 代幣可立即執行（例如：「hey /status」），並在模型看到剩餘文字前被剝除。

詳情：[斜線指令](/tools/slash-commands)。

## 會話、壓縮與修剪（什麼會持續）

跨訊息持續的內容取決於機制：

- **正常歷史**會持續保存在會話記錄中，直到被政策壓縮或修剪。
- **壓縮**會將摘要保存在記錄中，並保留近期訊息完整。
- **修剪**會從 _記憶中_ 的提示中移除舊的工具結果，但不會重寫記錄。

文件：[會話](/concepts/session)、[壓縮](/concepts/compaction)、[會話修剪](/concepts/session-pruning)。

預設情況下，OpenClaw 使用內建的 `legacy` 上下文引擎來進行組裝和壓縮。如果您安裝了提供 `kind: "context-engine"` 的外掛，並透過 `plugins.slots.contextEngine` 選擇它，OpenClaw 將會將上下文組裝、`/compact` 以及相關的子代理上下文生命週期掛勾委派給該引擎。

## `/context` 實際報告的內容

`/context` 偏好使用最新的 **執行時生成** 系統提示報告（如果有的話）：

- `System prompt (run)` = 從最後一次內嵌（具工具能力）執行中擷取，並保存在會話存儲中。
- `System prompt (estimate)` = 當沒有執行報告存在時（或透過不產生報告的 CLI 後端執行時）即時計算。

無論哪種方式，它都會報告大小和主要貢獻者；但**不會**輸出完整的系統提示或工具結構。
