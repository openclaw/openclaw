---
summary: "Context：模型看到的內容、其建構方式以及如何檢查"
read_when:
  - 您想了解 OpenClaw 中「Context」的含義
  - 您正在偵鎖模型為何「知道」某些事情（或忘記了）
  - 您想減少 Context 的負擔 (/context, /status, /compact)
title: "Context"
---

# Context

「Context」是 **OpenClaw 在每次執行時發送給模型的所有內容**。它受到模型 **Context Window**（Token 限制）的約束。

初學者的心理模型：

- **System Prompt**（OpenClaw 構建）：規則、工具、Skills 清單、時間/執行階段資訊，以及插入的工作區檔案。
- **對話紀錄**：您在本次工作階段中的訊息 + 智慧代理的訊息。
- **工具呼叫/結果 + 附件**：指令輸出、檔案讀取內容、圖片/音訊等。

Context 與「記憶體」**並不是同一回事**：記憶體可以儲存在硬碟中並在稍後重新載入；Context 則是模型目前視窗內的內容。

## 快速開始 (檢查 Context)

- `/status` → 快速查看「我的視窗有多滿？」+ 工作階段設定。
- `/context list` → 查看插入的內容 + 大致大小（單個檔案及總計）。
- `/context detail` → 更深入的分析：每個檔案、每個工具 Schema 的大小、每個 Skill 條目的大小，以及 System Prompt 的大小。
- `/usage tokens` → 在一般回覆後方附加每次回覆的 Token 使用量。
- `/compact` → 將較舊的紀錄摘要為簡要條目，以釋放視窗空間。

另請參閱：[斜線指令](/tools/slash-commands)、[Token 使用與成本](/reference/token-use)、[區塊串流傳輸](/concepts/compaction)。

## 輸出範例

數值會根據模型、供應商、工具策略以及工作區內容而有所不同。

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

## 哪些內容會計入 Context Window

模型接收到的所有內容都會計入，包括：

- System Prompt（所有區段）。
- 對話紀錄。
- 工具呼叫 + 工具結果。
- 附件/逐字稿（圖片/音訊/檔案）。
- 區塊串流傳輸摘要與修剪後的殘留物。
- 供應商的「包裝容器」或隱藏標頭（不可見，但仍會計入）。

## OpenClaw 如何建構 System Prompt

System Prompt 由 **OpenClaw 管理**，並在每次執行時重新構建。它包括：

- 工具清單 + 簡短說明。
- Skills 清單（僅限詮釋資料；詳見下文）。
- 工作區位置。
- 時間（UTC + 已設定的用戶轉換時間）。
- 執行階段詮釋資料（主機/作業系統/模型/思考過程）。
- **Project Context** 下插入的工作區引導檔案。

完整分析：[System Prompt](/concepts/system-prompt)。

## 插入的工作區檔案 (Project Context)

預設情況下，OpenClaw 會插入一組固定的工作區檔案（如果存在）：

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（僅限首次執行）

大型檔案會根據 `agents.defaults.bootstrapMaxChars`（預設為 `20000` 字元）進行單個檔案截斷。`/context` 會顯示 **原始大小 vs 插入大小**，以及是否發生了截斷。

## Skills：插入 vs 按需載入

System Prompt 包含一個精簡的 **Skills 清單**（名稱 + 說明 + 位置）。這個清單本身會有實際的負擔。

預設情況下，Skill 指示語*不*包含在內。模型預計**僅在需要時**才去 `read` 該 Skill 的 `SKILL.md`。

## 工具：有兩種類型的消耗

工具會以兩種方式影響 Context：

1. System Prompt 中的**工具清單文字**（即您看到的「Tooling」部分）。
2. **工具 Schema** (JSON)。這些會發送給模型以便其呼叫工具。即使您沒看到它們以純文字形式出現，它們也會計入 Context。

`/context detail` 會列出最大的工具 Schema，以便您查看哪些工具占據主導地位。

## 指令、指示語與「內嵌捷徑」

斜線指令由 Gateway 處理。有幾種不同的行為：

- **獨立指令**：僅包含 `/...` 的訊息會作為指令執行。
- **指示語**：`/think`、`/verbose`、`/reasoning`、`/elevated`、`/model`、`/queue` 會在模型看到訊息之前被移除。
  - 僅包含指示語的訊息會保留工作階段設定。
  - 一般訊息中的內嵌指示語會作為單次訊息的提示。
- **內嵌捷徑**（僅限白名單發送者）：一般訊息中的某些 `/...` Token 可以立即執行（例如：「hey /status」），並在模型看到剩餘文字之前被移除。

詳情：[斜線指令](/tools/slash-commands)。

## 工作階段、區塊串流傳輸與修剪 (哪些內容會保留)

哪些內容會在訊息之間保留取決於其機制：

- **一般紀錄**會保留在工作階段逐字稿中，直到根據策略進行區塊串流傳輸/修剪。
- **區塊串流傳輸**會將摘要保留在逐字稿中，並保持近期訊息完整。
- **修剪**會從單次執行的*記憶體內*提示詞中移除舊的工具結果，但不會重寫逐字稿。

文件：[工作階段](/concepts/session)、[區塊串流傳輸](/concepts/compaction)、[工作階段修剪](/concepts/session-pruning)。

## /context 實際回報的內容

`/context` 會優先使用最新**建構執行**的 System Prompt 報告（如果可用）：

- `System prompt (run)` = 從最後一次嵌入式（具備工具能力）執行中擷取，並保存在工作階段儲存區。
- `System prompt (estimate)` = 當不存在執行報告時（或透過不生成報告的 CLI 後端執行時）即時計算。

無論哪種方式，它都會回報大小和主要消耗項目；它**不會**傾印完整的 System Prompt 或工具 Schema。
