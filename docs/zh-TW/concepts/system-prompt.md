---
summary: "OpenClaw 系統提示包含的內容以及其組裝方式"
read_when:
  - 10. 編輯系統提示文字、工具清單或時間／心跳區段
  - 變更工作區啟動程序或 Skills 注入行為時
title: "系統提示"
---

# 系統提示

OpenClaw 會為每一次代理程式執行建構一個自訂的系統提示。此提示由 **OpenClaw 所擁有**，並且不使用 p-coding-agent 的預設提示。 11. 該提示為 **OpenClaw 擁有**，且不使用 p-coding-agent 的預設提示。

該提示由 OpenClaw 組裝，並注入至每一次代理程式執行中。

## 12. 結構

此提示刻意保持精簡，並使用固定的區段：

- **Tooling**：目前的工具清單與簡短說明。
- **Safety**：簡短的防護提醒，用於避免追求權力的行為或規避監督。
- **Skills**（可用時）：告知模型如何在需要時載入技能指示。
- **OpenClaw Self-Update**：如何執行 `config.apply` 與 `update.run`。
- **Workspace**：工作目錄（`agents.defaults.workspace`）。
- **Documentation**：OpenClaw 文件的本機路徑（repo 或 npm 套件）以及何時閱讀。
- **Workspace Files (injected)**：指出下方包含已注入的啟動檔案。
- **Sandbox**（啟用時）：指出沙箱化的執行環境、沙箱路徑，以及是否提供提升權限的 exec。
- **Current Date & Time**：使用者的本地時間、時區與時間格式。
- **Reply Tags**：支援的提供者可用的選用回覆標籤語法。
- **Heartbeats**：心跳提示與確認（ack）行為。
- **Runtime**：主機、OS、node、模型、repo 根目錄（偵測到時）、思考層級（單行）。
- **Reasoning**：目前的可見性層級與 /reasoning 切換提示。

13. 系統提示中的安全護欄屬於建議性質。 14. 它們用於引導模型行為，但不強制執行政策。 15. 請使用工具政策、執行核准、沙箱化與頻道允許清單來進行硬性強制；營運者可依設計停用這些機制。

## 提示模式

16. OpenClaw 可以為子代理渲染較小的系統提示。 17. 執行階段會為每次執行設定一個 `promptMode`（非使用者可見的設定）：

- `full`（預設）：包含上述所有區段。
- `minimal`：用於子代理程式；省略 **Skills**、**Memory Recall**、**OpenClaw
  Self-Update**、**Model Aliases**、**User Identity**、**Reply Tags**、
  **Messaging**、**Silent Replies** 與 **Heartbeats**。Tooling、**Safety**、
  Workspace、Sandbox、Current Date & Time（已知時）、Runtime，以及注入的
  內容仍可使用。 18. 工具、**安全**、工作區、沙箱、目前日期與時間（若已知）、執行階段，以及注入的上下文皆會保持可用。
- `none`：僅回傳基礎身分識別行。

當為 `promptMode=minimal` 時，額外注入的提示會標示為 **Subagent
Context**，而非 **Group Chat Context**。

## 工作區啟動注入

啟動檔案會被裁剪後附加於 **Project Context** 之下，讓模型在不需明確讀取的情況下即可看到身分與設定檔脈絡：

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md`（僅在全新工作區時）

19. 大型檔案會以標記截斷。 大型檔案會以標記方式截斷。每個檔案的最大大小由
    `agents.defaults.bootstrapMaxChars` 控制（預設：20000）。缺少的檔案會注入一段
    簡短的缺檔標記。 20. 遺失的檔案會注入一個簡短的缺失檔案標記。

內部鉤子可透過 `agent:bootstrap` 攔截此步驟，以變更或取代
注入的啟動檔案（例如將 `SOUL.md` 換成替代角色設定）。

若要檢視每個注入檔案的貢獻量（原始 vs 注入後、截斷情況，以及工具結構描述的額外負擔），請使用 `/context list` 或 `/context detail`。請參閱 [Context](/concepts/context)。 21. 請參閱 [Context](/concepts/context)。

## 時間處理

當已知使用者時區時，系統提示會包含專用的 **Current Date & Time** 區段。為了保持提示快取的穩定性，目前僅包含
**時區**（不含動態時鐘或時間格式）。 22. 為了讓提示快取保持穩定，現在僅包含**時區**（不含動態時鐘或時間格式）。

當代理程式需要目前時間時，請使用 `session_status`；狀態卡片
會包含一行時間戳記。

設定方式如下：

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat`（`auto` | `12` | `24`）

完整行為細節請參閱 [Date & Time](/date-time)。

## Skills

當存在符合條件的技能時，OpenClaw 會注入精簡的 **available skills list**
（`formatSkillsForPrompt`），其中包含每個技能的 **檔案路徑**。提示會指示模型使用
`read` 來載入所列位置（工作區、受管或隨附）的 SKILL.md。若沒有符合條件的技能，則會省略
Skills 區段。 23. 該提示指示模型使用 `read` 在列出的所在位置（工作區、受管或隨附）載入 SKILL.md。 24. 若沒有符合資格的技能，Skills 區段會被省略。

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

25. 這在保持基礎提示精簡的同時，仍能啟用目標式技能使用。

## Documentation

當可用時，系統提示會包含 **Documentation** 區段，指向
OpenClaw 文件的本機目錄（repo 工作區中的 `docs/`，或隨附的 npm
套件文件），並同時標註公開鏡像、原始碼 repo、社群 Discord，以及
ClawHub（[https://clawhub.com](https://clawhub.com)）以供技能探索。提示會指示模型在需要了解
OpenClaw 行為、指令、設定或架構時，優先查閱本機文件，並在可能的情況下自行執行
`openclaw status`（僅在無法存取時才詢問使用者）。 26. 該提示指示模型優先查閱本地文件以了解 OpenClaw 的行為、指令、設定或架構，並在可能時自行執行 `openclaw status`（僅在缺乏存取權時才詢問使用者）。
