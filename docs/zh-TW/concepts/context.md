```
---
summary: "上下文：模型看到的內容、如何建構以及如何檢查"
read_when:
  - 您想了解 OpenClaw 中的「上下文」是什麼意思
  - 您正在偵錯為什麼模型「知道」某事（或忘記了）
  - 您想減少上下文開銷（/context、/status、/compact）
title: "上下文"
---

# 上下文

「上下文」是 **OpenClaw 為每次執行傳送給模型的所有內容**。它受到模型的**上下文視窗**（token 限制）所限制。

初學者心智模型：

- **系統提示** (OpenClaw 建置)：規則、工具、Skills 列表、時間/執行時長，以及注入的工作區檔案。
- **對話歷史記錄**：您的訊息 + 本工作階段助理的訊息。
- **工具呼叫/結果 + 附件**：指令輸出、檔案讀取、圖片/音訊等。

上下文與「記憶體」_不同_：記憶體可以儲存在磁碟並稍後重新載入；上下文是模型目前視窗內的內容。

## 快速開始（檢查上下文）

- `/status` → 快速查看「我的視窗有多滿？」+ 工作階段設定。
- `/context list` → 已注入的內容 + 大致大小（每個檔案 + 總計）。
- `/context detail` → 更深入的細分：每個檔案、每個工具綱要大小、每個 Skills 條目大小以及系統提示大小。
- `/usage tokens` → 將每次回覆的使用量註腳附加到正常回覆中。
- `/compact` → 將較舊的歷史記錄摘要為緊湊條目以釋放視窗空間。

另請參閱：[斜線指令](/tools/slash-commands)、[Token 使用與成本](/reference/token-use)、[壓縮](/concepts/compaction)。

## 範例輸出

值會因模型、供應商、工具政策以及工作區內容而異。

### `/context list`

```
🧠 Context breakdown
Workspace: <workspaceDir>
Bootstrap max/file: 20,000 chars
Sandbox: mode=non-main sandboxed=false
System prompt (run): 38,412 chars (~9,603 tok) (Project Context 23,901 chars (~5,976 tok))

Injected workspace files:
- AGENTS.md: OK | raw 1,742 chars (~436 tok) | injected 1,742 chars (~436 tok)
- SOUL.md: OK | raw 912 chars (~228 tok) | injected 912 chars (~228 tok)
- TOOLS.md: TRUNCATED | raw 54,210 chars (~13,553 tok) | injected 20,962 chars (~5,241 tok)
- IDENTITY.md: OK | raw 211 chars (~53 tok) | injected 211 chars (~53 tok)
- USER.md: OK | raw 388 chars (~97 tok) | injected 388 chars (~97 tok)
- HEARTBEAT.md: MISSING | raw 0 | injected 0
- BOOTSTRAP.md: OK | raw 0 chars (~0 tok) | injected 0 chars (~0 tok)

Skills list (system prompt text): 2,184 chars (~546 tok) (12 skills)
Tools: read, edit, write, exec, process, browser, message, sessions_send, …
Tool list (system prompt text): 1,032 chars (~258 tok)
Tool schemas (JSON): 31,988 chars (~7,997 tok) (counts toward context; not shown as text)
Tools: (same as above)

Session tokens (cached): 14,250 total / ctx=32,000
```

### `/context detail`

```
🧠 Context breakdown (detailed)
…
Top skills (prompt entry size):
- frontend-design: 412 chars (~103 tok)
- oracle: 401 chars (~101 tok)
… (+10 more skills)

Top tools (schema size):
- browser: 9,812 chars (~2,453 tok)
- exec: 6,240 chars (~1,560 tok)
… (+N more tools)
```

## 哪些內容會計入上下文視窗

模型收到的所有內容都會計數，包括：

- 系統提示（所有部分）。
- 對話歷史記錄。
- 工具呼叫 + 工具結果。
- 附件/謄本（圖片/音訊/檔案）。
- 壓縮摘要和修剪產物。
- 供應商「包裝」或隱藏標頭（不可見，但仍計數）。

## OpenClaw 如何建構系統提示

系統提示由 **OpenClaw 擁有**，並在每次執行時重建。它包括：

- 工具列表 + 簡短描述。
- Skills 列表（僅限元資料；詳見下方）。
- 工作區位置。
- 時間（UTC + 如果已設定，則為轉換後的使用者時間）。
- 執行時長元資料（主機/作業系統/模型/思考）。
- **專案上下文**下注入的工作區引導檔案。

完整細分：[系統提示](/concepts/system-prompt)。

## 注入的工作區檔案（專案上下文）

依預設，OpenClaw 會注入一組固定的工作區檔案（如果存在）：

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (first-run only)

大型檔案會使用 `agents.defaults.bootstrapMaxChars`（預設為 `20000` 字元）按檔案進行截斷。`/context` 會顯示**原始與注入**的大小，以及是否發生截斷。

## Skills：注入的內容與按需載入的內容

系統提示包括一個簡潔的 **Skills 列表**（名稱 + 描述 + 位置）。此列表確實會產生開銷。

Skills 指令預設_不_包含在內。模型應**僅在需要時** `read` Skills 的 `SKILL.md`。

## 工具：有兩種成本

工具透過兩種方式影響上下文：

1. 系統提示中的**工具列表文字**（您看到的「工具」）。
2. **工具綱要** (JSON)。這些會傳送給模型，以便模型可以呼叫工具。即使您看不到它們的純文字形式，它們也會計入上下文。

`/context detail` 會細分最大的工具綱要，以便您了解哪些佔主導地位。

## 指令、指令和「內嵌捷徑」

斜線指令由 Gateway 處理。有幾種不同的行為：

- **獨立指令**：僅包含 `/...` 的訊息會作為指令執行。
- **指令**：`/think`、`/verbose`、`/reasoning`、`/elevated`、`/model`、`/queue` 在模型看到訊息之前會被剝離。
  - 僅包含指令的訊息會保留工作階段設定。
  - 正常訊息中的內嵌指令會作為單條訊息提示。
- **內嵌捷徑**（僅限白名單發送者）：正常訊息中的某些 `/...` token 可以立即執行（例如：「嘿 /status」），並在模型看到其餘文字之前被剝離。

詳細資訊：[斜線指令](/tools/slash-commands)。

## 工作階段、壓縮和修剪（保留的內容）

訊息之間保留的內容取決於機制：

- **正常歷史記錄**會保留在工作階段謄本中，直到依政策進行壓縮/修剪。
- **壓縮**會將摘要保留在謄本中，並保持近期訊息完整。
- **修剪**會從執行的_記憶體中_提示中移除舊的工具結果，但不會重寫謄本。

文件：[工作階段](/concepts/session)、[壓縮](/concepts/compaction)、[工作階段修剪](/concepts/session-pruning)。

## /context 實際報告的內容

如果可用，`/context` 會優先選擇最新的**執行建構**系統提示報告：

- 系統提示（執行）= 從上次內嵌（具備工具功能）的執行中擷取並保留在工作階段儲存中。
- 系統提示（估計）= 當不存在執行報告時（或透過未產生報告的 CLI 後端執行時）即時計算。

無論哪種方式，它都會報告大小和主要貢獻者；它**不會**傾印完整的系統提示或工具綱要。
```
