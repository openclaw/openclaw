---
summary: "OpenClaw 系統提示詞的內容及其組合方式"
read_when:
  - 編輯系統提示詞文字、工具清單或時間/活動訊號區段時
  - 更改工作區引導或 Skills 注入行為時
title: "系統提示詞"
---

# 系統提示詞

OpenClaw 為每次智慧代理執行建構自訂的系統提示詞。該提示詞由 **OpenClaw 持有**，且不使用 p-coding-agent 的預設提示詞。

該提示詞由 OpenClaw 組裝並注入到每次智慧代理執行中。

## 結構

提示詞刻意設計得精簡並使用固定區段：

- **工具 (Tooling)**：目前的工具清單 + 簡短說明。
- **安全性 (Safety)**：簡短的防護欄提醒，以避免權力尋求行為或繞過監督。
- **Skills**（可用時）：告訴模型如何根據需求載入 Skills 說明。
- **OpenClaw 自我更新**：如何執行 `config.apply` 和 `update.run`。
- **工作區 (Workspace)**：工作目錄 (`agents.defaults.workspace`)。
- **文件 (Documentation)**：OpenClaw 文件的本機路徑（儲存庫或 npm 套件）以及何時閱讀。
- **工作區檔案 (插入)**：表示下方包含引導檔案。
- **沙箱 (Sandbox)**（啟用時）：表示沙箱隔離執行階段、沙箱路徑，以及是否可以使用提升的執行權限。
- **目前日期與時間**：使用者本機時間、時區和時間格式。
- **回覆標籤 (Reply Tags)**：支援的供應商之選用回覆標籤語法。
- **活動訊號 (Heartbeats)**：活動訊號提示與確認 (ack) 行為。
- **執行階段 (Runtime)**：主機、作業系統、Node、模型、儲存庫根目錄（偵測到時）、思考層級（一行）。
- **推理 (Reasoning)**：目前的能見度層級 + /reasoning 切換提示。

系統提示詞中的安全性防護欄僅供參考。它們引導模型行為，但不強制執行政策。請使用工具政策、執行核准、沙箱隔離和頻道白名單進行強制執行；操作者可以視設計停用這些功能。

## 提示詞模式

OpenClaw 可以為子代理生成較小的系統提示詞。執行階段會為每次執行設定 `promptMode`（非面向使用者的設定）：

- `full`（預設）：包含上述所有區段。
- `minimal`：用於子代理；省略 **Skills**、**記憶召回 (Memory Recall)**、**OpenClaw 自我更新**、**模型別名**、**使用者身分**、**回覆標籤**、**訊息傳遞**、**靜默回覆**以及**活動訊號**。工具、**安全性**、工作區、沙箱隔離、目前日期與時間（已知時）、執行階段和插入的上下文仍保持可用。
- `none`：僅傳回基本身分行。

當 `promptMode=minimal` 時，額外插入的提示詞會標記為 **Subagent Context**，而非 **Group Chat Context**。

## 工作區引導注入

引導檔案會經過修剪並附加在 **Project Context** 下，讓模型能看到身分和設定檔內容，而不需要顯式讀取：

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（僅限全新工作區）
- `MEMORY.md` 和/或 `memory.md`（當存在於工作區時；兩者皆可能被注入）

所有這些檔案都會在每一輪**注入到內容視窗 (context window)** 中，這意味著它們會消耗權杖 (tokens)。請保持簡潔 —— 特別是 `MEMORY.md`，它會隨著時間增長，可能導致非預期的高內容使用量和更頻繁的壓縮。

> **注意：** `memory/*.md` 每日檔案**不會**自動注入。它們透過 `memory_search` 和 `memory_get` 工具根據需求存取，因此除非模型顯式讀取，否則不會計入內容視窗。

大型檔案會使用標記進行截斷。每個檔案的最大大小由 `agents.defaults.bootstrapMaxChars` 控制（預設值：20000）。遺失的檔案會注入簡短的檔案遺失標記。

子代理工作階段僅注入 `AGENTS.md` 和 `TOOLS.md`（其他引導檔案會被過濾掉，以保持子代理內容精簡）。

內部掛鉤 (Hooks) 可以透過 `agent:bootstrap` 攔截此步驟，以變更或替換注入的引導檔案（例如將 `SOUL.md` 更換為另一個人格）。

要檢查每個注入檔案的貢獻程度（原始與注入、截斷，加上工具架構開銷），請使用 `/context list` 或 `/context detail`。參閱 [上下文 (Context)](/concepts/context)。

## 時間處理

當已知使用者時區時，系統提示詞包含專用的**目前日期與時間**區段。為了保持提示詞快取穩定，現在僅包含**時區**（無動態時鐘或時間格式）。

當智慧代理需要目前時間時，請使用 `session_status`；狀態卡片中包含時間戳記行。

設定方式：

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

參閱 [日期與時間](/date-time) 了解完整行為詳情。

## Skills

當存在符合條件的 Skills 時，OpenClaw 會注入精簡的 **可用 Skills 清單** (`formatSkillsForPrompt`)，其中包含每個 Skill 的 **檔案路徑**。提示詞引導模型使用 `read` 載入所列位置（工作區、託管或內建）的 SKILL.md。如果沒有符合條件的 Skills，則會省略 Skills 區段。

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

這能保持基本提示詞精簡，同時仍能實現目標導向的 Skill 使用。

## 文件

可用時，系統提示詞包含**文件**區段，指向本機 OpenClaw 文件目錄（儲存庫工作區中的 `docs/` 或內建的 npm 套件文件），並註明公開鏡像、來源儲存庫、社群 Discord 和用於探索 Skills 的 ClawHub ([https://clawhub.com](https://clawhub.com))。提示詞引導模型優先諮詢本機文件以了解 OpenClaw 的行為、命令、設定或架構，並盡可能自行執行 `openclaw status`（僅在缺乏存取權限時才詢問使用者）。
