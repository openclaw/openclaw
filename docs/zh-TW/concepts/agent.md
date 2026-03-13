---
summary: "Agent runtime (embedded pi-mono), workspace contract, and session bootstrap"
read_when:
  - "Changing agent runtime, workspace bootstrap, or session behavior"
title: Agent Runtime
---

# Agent 執行環境 🤖

OpenClaw 執行一個基於 **pi-mono** 衍生的單一嵌入式 agent 執行環境。

## 工作區（必填）

OpenClaw 使用單一 agent 工作區目錄 (`agents.defaults.workspace`) 作為 agent 的**唯一**工作目錄 (`cwd`)，用於工具與上下文。

建議：使用 `openclaw setup` 來建立 `~/.openclaw/openclaw.json`（若不存在）並初始化工作區檔案。

完整工作區結構與備份指南：[Agent 工作區](/concepts/agent-workspace)

若啟用 `agents.defaults.sandbox`，非主要會話可在 `agents.defaults.sandbox.workspaceRoot` 下覆寫此設定，使用每會話工作區（詳見 [Gateway 設定](/gateway/configuration)）。

## 啟動檔案（注入）

在 `agents.defaults.workspace` 內，OpenClaw 預期這些可由使用者編輯的檔案：

- `AGENTS.md` — 操作指令 + “記憶”
- `SOUL.md` — 角色設定、界限、語氣
- `TOOLS.md` — 使用者維護的工具筆記（例如 `imsg`、`sag`、慣例）
- `BOOTSTRAP.md` — 一次性首次執行儀式（完成後刪除）
- `IDENTITY.md` — agent 名稱／風格／表情符號
- `USER.md` — 使用者檔案 + 偏好稱呼

在新會話的第一輪，OpenClaw 會將這些檔案內容直接注入 agent 上下文。

空白檔案會被跳過。大型檔案會被裁剪並加上標記，以保持提示精簡（完整內容請讀取檔案）。

若檔案遺失，OpenClaw 會注入一行「檔案遺失」標記（且 `openclaw setup` 會建立安全的預設範本）。

`BOOTSTRAP.md` 僅會為**全新工作區**（無其他啟動檔案存在）建立。若完成儀式後刪除，後續重啟時不會重新建立。

若要完全停用啟動檔案建立（用於預先準備的工作區），請設定：

```json5
{ agent: { skipBootstrap: true } }
```

## 內建工具

核心工具（讀取/執行/編輯/寫入及相關系統工具）始終可用，受工具政策限制。`apply_patch` 為選用且受 `tools.exec.applyPatch` 控制。`TOOLS.md` **不**控制工具的存在；它是指導你如何使用這些工具。

## 技能

OpenClaw 從三個位置載入技能（工作區名稱衝突時以工作區優先）：

- 捆綁（隨安裝包附帶）
- 管理/本地：`~/.openclaw/skills`
- 工作區：`<workspace>/skills`

技能可透過設定/環境變數控管（參見 [Gateway configuration](/gateway/configuration) 中的 `skills`）。

## pi-mono 整合

OpenClaw 重用 pi-mono 程式碼庫的部分元件（模型/工具），但 **會話管理、發現及工具連接由 OpenClaw 擁有**。

- 無 pi-coding 代理執行環境。
- 不會參考 `~/.pi/agent` 或 `<workspace>/.pi` 設定。

## 會話

會話記錄以 JSONL 格式儲存於：

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

會話 ID 由 OpenClaw 穩定選擇。舊版 Pi/Tau 會話資料夾 **不**會被讀取。

## 串流時的導向

當佇列模式為 `steer` 時，傳入訊息會被注入到當前執行中。
佇列會在**每次工具呼叫後**檢查；如果有佇列中的訊息存在，
則會跳過當前助理訊息剩餘的工具呼叫（工具結果顯示錯誤「因佇列中使用者訊息而跳過。」），
接著在下一次助理回應前注入該佇列中的使用者訊息。

當佇列模式為 `followup` 或 `collect` 時，傳入訊息會被保留直到當前回合結束，
然後新的代理回合會以佇列中的負載開始。詳情請參考 [Queue](/concepts/queue) 了解模式與去彈跳/上限行為。

區塊串流會在助理區塊完成後立即傳送；預設為**關閉** (`agents.defaults.blockStreamingDefault: "off"`)。
可透過 `agents.defaults.blockStreamingBreak` 調整邊界（`text_end` 與 `message_end`；預設為 text_end）。
使用 `agents.defaults.blockStreamingChunk` 控制軟區塊分段（預設為 800–1200 字元；優先段落斷點，再換行，最後句點）。
使用 `agents.defaults.blockStreamingCoalesce` 合併串流分段以減少單行垃圾訊息（基於閒置時間合併後再送出）。
非 Telegram 頻道需明確啟用 `*.blockStreaming: true` 才能使用區塊回覆。
詳細工具摘要會在工具啟動時輸出（無去彈跳）；控制介面會在可用時透過代理事件串流工具輸出。
更多細節請見：[Streaming + chunking](/concepts/streaming)。

## 模型參考

設定中的模型參考（例如 `agents.defaults.model` 和 `agents.defaults.models`）會以**第一個** `/` 進行拆分。

- 設定模型時請使用 `provider/model`。
- 若模型 ID 本身包含 `/`（OpenRouter 風格），請包含提供者前綴（例如：`openrouter/moonshotai/kimi-k2`）。
- 若省略提供者，OpenClaw 會將輸入視為別名或**預設提供者**的模型（僅當模型 ID 中沒有 `/` 時有效）。

## 設定（最小）

至少設定：

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom`（強烈建議）

---

_接下來： [群組聊天](/channels/group-messages)_ 🦞
