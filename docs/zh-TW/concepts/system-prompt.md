---
summary: What the OpenClaw system prompt contains and how it is assembled
read_when:
  - "Editing system prompt text, tools list, or time/heartbeat sections"
  - Changing workspace bootstrap or skills injection behavior
title: System Prompt
---

# 系統提示

OpenClaw 為每次代理執行建立自訂系統提示。此提示為 **OpenClaw 擁有**，不使用 pi-coding-agent 預設提示。

此提示由 OpenClaw 組裝並注入每次代理執行。

## 結構

此提示刻意簡潔，使用固定區塊：

- **工具清單**：目前工具列表 + 簡短說明。
- **安全性**：簡短的防護提醒，避免權力尋求行為或繞過監督。
- **技能**（有時提供）：告訴模型如何按需載入技能指令。
- **OpenClaw 自我更新**：如何執行 `config.apply` 和 `update.run`。
- **工作目錄**：工作目錄 (`agents.defaults.workspace`)。
- **文件說明**：OpenClaw 文件的本地路徑（repo 或 npm 套件）及何時閱讀。
- **工作目錄檔案（注入）**：表示下方包含啟動檔案。
- **沙盒環境**（啟用時）：表示沙盒執行環境、沙盒路徑及是否有提升權限執行。
- **當前日期與時間**：使用者本地時間、時區及時間格式。
- **回覆標籤**：支援的提供者可選的回覆標籤語法。
- **心跳訊號**：心跳提示與確認行為。
- **執行環境**：主機、作業系統、node、模型、repo 根目錄（若偵測到）、思考層級（一行）。
- **推理**：目前可見層級 + /reasoning 切換提示。

系統提示中的安全防護為建議性質。它們引導模型行為，但不強制政策。請使用工具政策、執行批准、沙盒及頻道允許清單做嚴格執行；操作員可依設計停用這些功能。

## 提示模式

OpenClaw 可為子代理呈現較小的系統提示。執行時會設定
`promptMode`（非使用者面向設定）：

- `full`（預設）：包含上述所有區塊。
- `minimal`：用於子代理；省略 **技能**、**記憶回顧**、**OpenClaw 自我更新**、**模型別名**、**使用者身份**、**回覆標籤**、**訊息**、**靜默回覆**及**心跳訊號**。工具清單、**安全性**、工作目錄、沙盒、已知時的當前日期與時間、執行環境及注入上下文仍保留。
- `none`：僅回傳基本身份行。

當 `promptMode=minimal` 時，額外注入的提示標記為 **子代理上下文**，而非 **群組聊天上下文**。

## 工作目錄啟動注入

啟動檔案會被裁剪並附加於 **專案上下文**，讓模型在不需明確讀取的情況下看到身份與設定上下文：

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（僅在全新工作目錄時）
- `MEMORY.md` 和／或 `memory.md`（當工作目錄中存在；可注入其中一個或兩者）

所有這些檔案皆 **注入於每次對話上下文視窗**，因此會消耗 token。請保持簡潔 — 尤其是 `MEMORY.md`，它會隨時間增長，導致意外的高上下文使用量及更頻繁的壓縮。

> **注意：** `memory/*.md` 的每日檔案**不會**自動注入。它們是透過 `memory_search` 和 `memory_get` 工具按需存取，因此除非模型明確讀取，否則不會計入上下文視窗。

大型檔案會以標記截斷。每個檔案的最大大小由 `agents.defaults.bootstrapMaxChars` 控制（預設：20000）。跨檔案注入的啟動內容總量上限由 `agents.defaults.bootstrapTotalMaxChars` 控制（預設：150000）。缺少的檔案會注入一個簡短的缺檔標記。當發生截斷時，OpenClaw 可以在專案上下文中注入警告區塊；可透過 `agents.defaults.bootstrapPromptTruncationWarning`（`off`、`once`、`always`；預設：`once`）來控制。

子代理會話只注入 `AGENTS.md` 和 `TOOLS.md`（其他啟動檔案會被過濾，以保持子代理上下文精簡）。

內部掛勾可透過 `agent:bootstrap` 攔截此步驟，以變更或替換注入的啟動檔案（例如用 `SOUL.md` 替換成另一個角色設定）。

要檢視每個注入檔案的貢獻量（原始 vs 注入、截斷，以及工具結構開銷），請使用 `/context list` 或 `/context detail`。詳見 [Context](/concepts/context)。

## 時間處理

當使用者時區已知時，系統提示會包含專門的 **當前日期與時間** 區塊。為了保持提示快取穩定，現在只包含 **時區**（不含動態時鐘或時間格式）。

當代理需要當前時間時，請使用 `session_status`；狀態卡會包含時間戳行。

設定方式：

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat`（`auto` | `12` | `24`）

完整行為細節請參考 [Date & Time](/date-time)。

## 技能

當存在符合條件的技能時，OpenClaw 會注入一個精簡的 **可用技能清單**（`formatSkillsForPrompt`），其中包含每個技能的 **檔案路徑**。提示會指示模型使用 `read` 來載入列出位置（工作區、管理或綁定）的 SKILL.md。若無符合條件的技能，則省略技能區塊。

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

這樣可保持基礎提示精簡，同時仍能啟用針對性的技能使用。

## 文件說明

當可用時，系統提示會包含一個 **文件說明** 區段，指向本地的 OpenClaw 文件目錄（位於 repo 工作區的 `docs/` 或內建的 npm 套件文件），並同時註明公開鏡像、原始碼倉庫、社群 Discord，以及用於技能探索的 ClawHub（[https://clawhub.com](https://clawhub.com)）。提示指示模型優先參考本地文件，以了解 OpenClaw 的行為、指令、設定或架構，並在可能的情況下自行執行 `openclaw status`（僅在無法存取時詢問使用者）。
