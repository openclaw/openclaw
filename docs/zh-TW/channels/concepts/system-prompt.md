---
summary: What the OpenClaw system prompt contains and how it is assembled
read_when:
  - "Editing system prompt text, tools list, or time/heartbeat sections"
  - Changing workspace bootstrap or skills injection behavior
title: System Prompt
---

# System Prompt

OpenClaw 為每次代理執行建立一個自訂的系統提示。該提示是 **OpenClaw 所擁有**，並不使用 pi-coding-agent 的預設提示。

該提示由 OpenClaw 組裝並注入到每個代理執行中。

## Structure

[[BLOCK_1]]  
該提示故意簡潔並使用固定區段：  
[[BLOCK_2]]

- **工具**: 當前工具列表 + 簡短描述。
- **安全性**: 簡短的警示提醒以避免追求權力的行為或繞過監督。
- **技能** (當可用時): 告訴模型如何按需加載技能指令。
- **OpenClaw 自我更新**: 如何執行 `config.apply` 和 `update.run`。
- **工作區**: 工作目錄 (`agents.defaults.workspace`)。
- **文件**: OpenClaw 文檔的本地路徑（repo 或 npm 套件）以及何時閱讀它們。
- **工作區檔案 (注入)**: 表示引導檔案已包含在下方。
- **沙盒** (當啟用時): 表示沙盒執行時、沙盒路徑，以及是否可用提升執行。
- **當前日期與時間**: 使用者本地時間、時區和時間格式。
- **回覆標籤**: 支援的提供者的可選回覆標籤語法。
- **心跳**: 心跳提示和確認行為。
- **執行時**: 主機、作業系統、節點、模型、repo 根目錄（當檢測到時）、思考層級（單行）。
- **推理**: 當前可見性層級 + /reasoning 切換提示。

系統提示中的安全護欄是建議性的。它們指導模型行為，但不強制執行政策。使用工具政策、執行批准、沙盒和通道白名單來進行強制執行；操作員可以根據設計禁用這些功能。

## Prompt modes

OpenClaw 可以為子代理渲染較小的系統提示。執行時會為每次執行設置一個 `promptMode`（不是面向用戶的設定）：

- `full` (預設): 包含所有上述部分。
- `minimal`: 用於子代理；省略 **技能**、**記憶回顧**、**OpenClaw 自我更新**、**模型別名**、**用戶身份**、**回覆標籤**、**消息傳遞**、**靜默回覆** 和 **心跳**。工具、**安全性**、工作區、沙盒、當前日期和時間（如果已知）、執行時和注入的上下文仍然可用。
- `none`: 僅返回基本身份行。

當 `promptMode=minimal` 時，額外注入的提示被標記為 **Subagent Context** 而不是 **Group Chat Context**。

## Workspace bootstrap injection

Bootstrap 檔案被修剪並附加在 **Project Context** 下，因此模型可以看到身份和個人資料上下文，而不需要明確的讀取：

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（僅限全新工作區）
- `MEMORY.md` 和/或 `memory.md`（當工作區中存在時；可以注入其中一個或兩個）

所有這些檔案都會在每次回合中**注入到上下文窗口**，這意味著它們會消耗 token。請保持它們簡潔，特別是 `MEMORY.md`，因為它可能隨著時間增長而導致意外的高上下文使用量和更頻繁的壓縮。

> **注意：** `memory/*.md` 每日檔案是 **不** 會自動注入的。它們是透過 `memory_search` 和 `memory_get` 工具按需訪問的，因此除非模型明確讀取它們，否則不會計入上下文窗口。

大型檔案會被截斷並加上標記。每個檔案的最大大小由 `agents.defaults.bootstrapMaxChars` 控制（預設值：20000）。跨檔案的總注入啟動內容上限為 `agents.defaults.bootstrapTotalMaxChars`（預設值：150000）。缺失的檔案會注入一個簡短的缺失檔案標記。當發生截斷時，OpenClaw 可以在專案上下文中注入一個警告區塊；可透過 `agents.defaults.bootstrapPromptTruncationWarning` 來控制此行為（`off`、`once`、`always`；預設值：`once`）。

子代理會話僅注入 `AGENTS.md` 和 `TOOLS.md`（其他啟動檔案會被過濾，以保持子代理的上下文小）。

內部鉤子可以通過 `agent:bootstrap` 攔截此步驟，以變更或替換注入的啟動檔案（例如將 `SOUL.md` 交換為替代角色）。

要檢查每個注入檔案的貢獻程度（原始與注入、截斷，以及工具架構的開銷），請使用 `/context list` 或 `/context detail`。詳情請參見 [Context](/concepts/context)。

## 時間處理

系統提示包含一個專門的 **當前日期與時間** 區域，當使用者的時區已知時。為了保持提示快取的穩定性，現在僅包含 **時區**（不包含動態時鐘或時間格式）。

當代理需要當前時間時，請使用 `session_status`；狀態卡包含一行時間戳記。

Configure with:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

請參閱 [Date & Time](/date-time) 以獲取完整的行為細節。

## Skills

當符合條件的技能存在時，OpenClaw 會注入一個簡潔的 **可用技能列表** (`formatSkillsForPrompt`)，該列表包含每個技能的 **檔案路徑**。提示指示模型使用 `read` 來加載位於所列位置（工作區、管理或打包）的 SKILL.md。如果沒有符合條件的技能，則會省略技能部分。

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

這樣可以保持基本提示簡潔，同時仍然能夠啟用針對性的技能使用。

## Documentation

當可用時，系統提示包含一個 **文件** 區段，指向本地的 OpenClaw 文檔目錄（在 repo 工作區的 `docs/` 或捆綁的 npm 套件文檔），並且還註明了公共鏡像、源程式碼庫、社群 Discord 以及 ClawHub ([https://clawhub.com](https://clawhub.com)) 以便於技能發現。該提示指示模型首先查閱本地文檔以了解 OpenClaw 的行為、命令、設定或架構，並在可能的情況下執行 `openclaw status` 本身（僅在缺乏訪問權限時才詢問用戶）。
