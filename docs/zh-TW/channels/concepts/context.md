---
summary: "Context: what the model sees, how it is built, and how to inspect it"
read_when:
  - You want to understand what “context” means in OpenClaw
  - You are debugging why the model “knows” something (or forgot it)
  - "You want to reduce context overhead (/context, /status, /compact)"
title: Context
---

# Context

「上下文」是 **OpenClaw 在執行時發送給模型的所有內容**。它受到模型的 **上下文窗口**（token 限制）的限制。

[[BLOCK_1]]  
初學者心智模型：  
[[BLOCK_1]]

- **系統提示** (OpenClaw-built): 規則、工具、技能列表、時間/執行時間，以及注入的工作區檔案。
- **對話歷史**: 本次會話中你的訊息 + 助手的訊息。
- **工具調用/結果 + 附件**: 命令輸出、檔案讀取、圖片/音訊等。

上下文 _並不是_ 與「記憶」相同的東西：記憶可以儲存在磁碟上並稍後重新載入；上下文則是模型當前視窗內的內容。

## 快速開始（檢查上下文）

- `/status` → 快速的「我的視窗有多滿？」檢視 + 會話設定。
- `/context list` → 注入了什麼 + 粗略大小（每個檔案 + 總計）。
- `/context detail` → 更深入的細分：每個檔案、每個工具的架構大小、每個技能條目的大小，以及系統提示大小。
- `/usage tokens` → 在正常回覆中附加每次回覆的使用腳註。
- `/compact` → 將較舊的歷史摘要成緊湊的條目以釋放視窗空間。

另請參閱：[斜線指令](/tools/slash-commands)、[Token 使用與成本](/reference/token-use)、[壓縮](/concepts/compaction)。

## Example output

值因模型、提供者、工具政策以及您工作區中的內容而異。

### `/context list`

🧠 內容分析
工作區：<workspaceDir>
啟動最大/檔案：20,000 字元
沙盒：模式=非主要 沙盒=false
系統提示（執行）：38,412 字元 (~9,603 token) （專案內容 23,901 字元 (~5,976 token)）

Injected workspace files:

- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)

[[BLOCK_1]]  
技能列表（系統提示文字）：2,184 字元（約 546 個標記）（12 種技能）  
工具：讀取、編輯、寫入、執行、處理、瀏覽器、訊息、sessions_send、…  
[[BLOCK_1]]

[[BLOCK_2]]  
工具列表（系統提示文字）：1,032 字元（約 258 個標記）  
[[BLOCK_2]]

[[BLOCK_3]]  
工具架構（JSON）：31,988 字元（約 7,997 個標記）（計入上下文；不顯示為文字）  
工具：（與上面相同）  
[[BLOCK_3]]

Session tokens (cached): 14,250 total / ctx=32,000

### `/context detail`

🧠 內容分析（詳細）
…
頂尖技能（提示輸入大小）：

- 前端設計：412 字元（約 103 個 token）
- Oracle：401 字元（約 101 個 token）
  … （還有 10 種以上技能）

Top tools (schema size):

- browser: 9,812 字元 (~2,453 token)
- exec: 6,240 字元 (~1,560 token)
  … (+N 更多工具)

## 什麼算作上下文窗口的內容

所有模型接收到的內容都會被計算，包括：

- 系統提示（所有部分）。
- 對話歷史。
- 工具調用 + 工具結果。
- 附件/記錄（圖片/音頻/文件）。
- 縮減摘要和修剪文檔。
- 提供者的「包裝」或隱藏標頭（不可見，但仍計算在內）。

## OpenClaw 如何構建系統提示

系統提示是 **OpenClaw 擁有** 並在每次執行時重建。它包括：

- 工具列表 + 簡短描述。
- 技能列表（僅元資料；見下文）。
- 工作區位置。
- 時間（UTC + 如果已設定的轉換用戶時間）。
- 執行時元資料（主機/作業系統/型號/思考）。
- 在 **專案上下文** 下注入的工作區啟動檔案。

[[BLOCK_1]]

## 注入的工作區檔案 (專案上下文)

預設情況下，OpenClaw 會注入一組固定的工作區檔案（如果存在）：

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (首次執行時僅限)

大型檔案會根據每個檔案使用 `agents.defaults.bootstrapMaxChars` 進行截斷（預設為 `20000` 字元）。OpenClaw 也對檔案施加了總的啟動注入上限，使用 `agents.defaults.bootstrapTotalMaxChars`（預設為 `150000` 字元）。`/context` 顯示 **原始 vs 注入** 的大小以及是否發生截斷。

當截斷發生時，執行時可以在專案上下文中注入一個提示警告區塊。請使用 `agents.defaults.bootstrapPromptTruncationWarning` (`off`, `once`, `always`; 預設 `once`) 進行設定。

## 技能：什麼是注入的，什麼是按需加載的

系統提示包含一個簡潔的 **技能列表**（名稱 + 描述 + 位置）。這個列表有實際的開銷。

技能指令預設並不包含。模型預期在**僅在需要時**`read`技能的`SKILL.md`。

## Tools: 有兩項成本

工具以兩種方式影響上下文：

1. **系統提示中的工具列表文字**（您所看到的“工具”）。
2. **工具架構**（JSON）。這些會發送給模型，以便它可以調用工具。即使您不將它們視為純文字，它們仍然會計入上下文。

`/context detail` 解析了最大的工具架構，讓你可以看到哪些是主導的。

## 命令、指令和「內嵌快捷方式」

Slash 指令由 Gateway 處理。有幾種不同的行為：

- **獨立指令**：只有 `/...` 的訊息會作為指令執行。
- **指令**：`/think`, `/verbose`, `/reasoning`, `/elevated`, `/model`, `/queue` 在模型看到訊息之前會被移除。
  - 只有指令的訊息會保留會話設定。
  - 正常訊息中的內嵌指令作為每則訊息的提示。
- **內嵌快捷方式**（僅限允許的發送者）：某些 `/...` token在正常訊息中可以立即執行（例如：“hey /status”），並在模型看到其餘文本之前被移除。

[[INLINE_1]]: [斜線指令](/tools/slash-commands)。[[INLINE_1]]

## 會話、壓縮與修剪（持久化的內容）

[[BLOCK_N]] 取決於機制，跨訊息持續存在的內容會有所不同：[[BLOCK_N]]

- **正常歷史** 在會話記錄中持續存在，直到根據政策進行壓縮/修剪。
- **壓縮** 將摘要保留在記錄中，並保持最近的消息不變。
- **修剪** 從 _記憶體中的_ 提示中移除舊的工具結果，但不會重寫記錄。

Docs: [Session](/concepts/session), [Compaction](/concepts/compaction), [Session pruning](/concepts/session-pruning).

預設情況下，OpenClaw 使用內建的 `legacy` 上下文引擎進行組裝和壓縮。如果您安裝了一個提供 `kind: "context-engine"` 的插件並使用 `plugins.slots.contextEngine` 選擇它，OpenClaw 將上下文組裝、`/compact` 以及相關的子代理上下文生命週期鉤子委派給該引擎。

## What `/context` 實際上報告的內容

`/context` 偏好在可用時獲取最新的 **run-built** 系統提示報告：

- `System prompt (run)` = 從最後一次嵌入式（具工具能力）執行中捕獲並保存在會話存儲中。
- `System prompt (estimate)` = 在不存在執行報告時（或當透過不生成報告的 CLI 後端執行時）即時計算。

無論哪種方式，它都會報告大小和主要貢獻者；它**不**會輸出完整的系統提示或工具架構。
