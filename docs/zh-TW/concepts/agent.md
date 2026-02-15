---
summary: "智慧代理執行階段 (嵌入式 pi-mono)、工作區協議與工作階段引導 (bootstrap)"
read_when:
  - 變更智慧代理執行階段、工作區引導或工作階段行為時
title: "智慧代理執行階段"
---

# 智慧代理執行階段 🤖

OpenClaw 執行一個衍生自 **pi-mono** 的嵌入式智慧代理執行階段。

## 工作區 (必填)

OpenClaw 使用單一智慧代理工作區目錄 (`agents.defaults.workspace`) 作為智慧代理工具與上下文的**唯一**工作目錄 (`cwd`)。

建議：使用 `openclaw setup` 來建立缺失的 `~/.openclaw/openclaw.json` 並初始化工作區檔案。

完整工作區佈局 + 備份指南：[智慧代理工作區](/concepts/agent-workspace)

若啟用了 `agents.defaults.sandbox`，非主工作階段可以使用 `agents.defaults.sandbox.workspaceRoot` 下的個別工作階段工作區來覆蓋此設定 (請參閱 [Gateway 設定](/gateway/configuration))。

## 引導檔案 (已注入)

在 `agents.defaults.workspace` 中，OpenClaw 預期有以下可供使用者編輯的檔案：

- `AGENTS.md` — 操作指令 + 「記憶體」
- `SOUL.md` — 人格特質、界限、語氣
- `TOOLS.md` — 使用者維護的工具筆記 (例如 `imsg`, `sag`, 慣例)
- `BOOTSTRAP.md` — 一次性的首次執行流程 (完成後會刪除)
- `IDENTITY.md` — 智慧代理名稱/氛圍/表情符號
- `USER.md` — 使用者個人資料 + 偏好稱呼

在新建工作階段的第一輪，OpenClaw 會將這些檔案的內容直接注入到智慧代理上下文中。

空白檔案會被略過。大型檔案會被修剪並標記截斷，以保持提示詞 (prompts) 精簡 (讀取檔案以獲取完整內容)。

若檔案缺失，OpenClaw 會注入一行「檔案缺失」標記 (且 `openclaw setup` 會建立一個安全的預設範本)。

`BOOTSTRAP.md` 只有在**全新工作區** (不存在其他引導檔案) 時才會建立。若您在完成流程後將其刪除，則在之後重新啟動時不應再重新建立。

若要完全禁用引導檔案建立 (用於預先配置的工作區)，請設定：

```json5
{ agent: { skipBootstrap: true } }
```

## 內建工具

核心工具 (read/exec/edit/write 與相關系統工具) 始終可用，受工具策略限制。`apply_patch` 是選用的，並由 `tools.exec.applyPatch` 控制。`TOOLS.md` 並**不**控制存在哪些工具；它是關於您希望如何使用它們的指引。

## Skills

OpenClaw 從三個位置載入 Skills (名稱衝突時以工作區為準)：

- 隨附 (隨安裝程式提供)
- 受管/本地：`~/.openclaw/skills`
- 工作區：`<workspace>/skills`

Skills 可透過設定/環境變數進行限制 (請參閱 [Gateway 設定](/gateway/configuration) 中的 `skills`)。

## pi-mono 整合

OpenClaw 重用了 pi-mono 程式碼庫的部分內容 (模型/工具)，但**工作階段管理、裝置探索與工具串接則由 OpenClaw 負責**。

- 無 pi-coding 智慧代理執行階段。
- 不會參考 `~/.pi/agent` 或 `<workspace>/.pi` 的設定。

## 工作階段

工作階段紀錄以 JSONL 格式儲存於：

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

工作階段 ID 是固定的並由 OpenClaw 選擇。**不會**讀取舊版的 Pi/Tau 工作階段資料夾。

## 串流傳輸時的引導 (Steering)

當佇列模式為 `steer` 時，傳入的訊息會注入到當前執行中。佇列會在**每次工具呼叫後**檢查；若存在佇列訊息，則會跳過當前智慧助理訊息中剩餘的工具呼叫 (工具結果會顯示錯誤 "Skipped due to queued user message.")，然後在下一次智慧助理回應前注入佇列的使用者訊息。

當佇列模式為 `followup` 或 `collect` 時，傳入的訊息會保留直到當前輪次結束，然後以佇列的負載 (payloads) 開始新的智慧代理輪次。請參閱 [佇列](/concepts/queue) 以了解模式 + 防震 (debounce)/上限 (cap) 行為。

區塊串流傳輸會在智慧助理區塊完成後立即發送；**預設為關閉** (`agents.defaults.blockStreamingDefault: "off"`)。透過 `agents.defaults.blockStreamingBreak` 調整邊界 (`text_end` vs `message_end`；預設為 `text_end`)。使用 `agents.defaults.blockStreamingChunk` 控制軟區塊分塊 (預設為 800–1200 字元；優先考慮段落分隔，其次是換行符，最後是句子)。使用 `agents.defaults.blockStreamingCoalesce` 合併串流分塊以減少單行洗版 (發送前基於空閒狀態進行合併)。非 Telegram 頻道需要明確設定 `*.blockStreaming: true` 才能啟用區塊回覆。詳細的工具摘要會在工具啟動時發出 (無防震)；當可用時，控制介面會透過智慧代理事件串流傳輸工具輸出。更多細節：[串流傳輸 + 分塊](/concepts/streaming)。

## 模型參考

設定中的模型參考 (例如 `agents.defaults.model` 與 `agents.defaults.models`) 會透過在**第一個** `/` 處分割來進行解析。

- 設定模型時請使用 `provider/model`。
- 若模型 ID 本身包含 `/` (如 OpenRouter 風格)，請包含供應商前綴 (例如：`openrouter/moonshotai/kimi-k2`)。
- 若省略供應商，OpenClaw 會將輸入視為**預設供應商**的別名或模型 (僅在模型 ID 中沒有 `/` 時有效)。

## 設定 (最小需求)

至少需要設定：

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (強烈建議)

---

_下一步：[群組聊天](/channels/group-messages)_ 🦞
