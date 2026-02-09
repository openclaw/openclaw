---
summary: "Agent 執行期（內嵌的 pi-mono）、工作區合約，以及工作階段啟動"
read_when:
  - 變更 agent 執行期、工作區啟動，或工作階段行為時
title: "Agent 執行期"
---

# Agent 執行期 🤖

OpenClaw 執行單一個源自 **pi-mono** 的內嵌 agent 執行期。

## 工作區（必須）

OpenClaw 使用單一的 agent 工作區目錄（`agents.defaults.workspace`），作為該 agent 用於工具與情境的**唯一**工作目錄（`cwd`）。

建議：使用 `openclaw setup`，在不存在時建立 `~/.openclaw/openclaw.json`，並初始化工作區檔案。

完整的工作區配置與備份指南：[Agent 工作區](/concepts/agent-workspace)

如果啟用 `agents.defaults.sandbox`，非主要工作階段可以改用位於 `agents.defaults.sandbox.workspaceRoot` 底下的每工作階段工作區（請參閱
[Gateway 設定](/gateway/configuration)）。

## 38. 啟動檔案（已注入）

在 `agents.defaults.workspace` 內，OpenClaw 預期存在以下可由使用者編輯的檔案：

- `AGENTS.md` — 操作指示 +「記憶」
- `SOUL.md` — 人設、界線、語氣
- `TOOLS.md` — 使用者維護的工具備註（例如 `imsg`、`sag`、慣例）
- `BOOTSTRAP.md` — 一次性的首次執行儀式（完成後會刪除）
- `IDENTITY.md` — agent 名稱／氛圍／表情符號
- `USER.md` — 使用者個人資料 + 偏好的稱呼方式

在新工作階段的第一個回合，OpenClaw 會將這些檔案的內容直接注入 agent 的情境中。

空白檔案會被略過。大型檔案會被修剪並截斷，並加上標記，以保持提示精簡（如需完整內容請直接閱讀檔案）。 39. 大型檔案會被修剪並以標記截斷，以保持提示精簡（完整內容請閱讀檔案）。

若檔案缺失，OpenClaw 會注入單一行「缺少檔案」標記（且 `openclaw setup` 會建立安全的預設範本）。

40. `BOOTSTRAP.md` 僅會在**全新工作區**時建立（不存在其他啟動檔案）。 1. 如果你在完成儀式後將其刪除，它在之後的重新啟動中不應該被重新建立。

若要完全停用啟動檔案的建立（用於預先佈署的工作區），請設定：

```json5
{ agent: { skipBootstrap: true } }
```

## 2. 內建工具

3. 核心工具（read/exec/edit/write 及相關系統工具）始終可用，
   受工具政策約束。 核心工具（read/exec/edit/write 與相關系統工具）始終可用，但會受工具政策限制。`apply_patch` 為選用，且受 `tools.exec.applyPatch` 控制。`TOOLS.md` **不會**控制有哪些工具存在；它僅是指引你希望工具如何被使用。 4. `TOOLS.md` **不會** 控制哪些工具存在；它是
   關於你希望如何使用它們的指引。

## Skills

OpenClaw 從三個位置載入 Skills（名稱衝突時以工作區為優先）：

- 隨安裝套件提供（Bundled）
- 受管／本地：`~/.openclaw/skills`
- 工作區：`<workspace>/skills`

Skills 可透過設定／環境變數進行管控（請參閱 [Gateway 設定](/gateway/configuration) 中的 `skills`）。

## pi-mono 整合

OpenClaw 重用 pi-mono 程式碼庫中的部分元件（模型／工具），但**工作階段管理、探索，以及工具串接皆由 OpenClaw 自行負責**。

- 不使用 pi-coding agent 執行期。
- 不會讀取任何 `~/.pi/agent` 或 `<workspace>/.pi` 設定。

## Sessions

5. 工作階段逐字稿以 JSONL 格式儲存於：

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

6. 工作階段 ID 是穩定的，並由 OpenClaw 選擇。
7. 舊版 Pi/Tau 工作階段資料夾 **不會** 被讀取。

## 8. 串流時的引導

9. 當佇列模式為 `steer` 時，傳入訊息會被注入到目前的執行中。
10. 佇列會在**每次工具呼叫之後**檢查；如果存在佇列中的訊息，
    目前助理訊息中剩餘的工具呼叫會被跳過（錯誤工具結果顯示為「Skipped due to queued user message.」），然後在下一次助理回應前注入佇列中的使用者訊息。

當佇列模式為 `followup` 或 `collect` 時，傳入訊息會被保留，直到目前回合結束，接著以排隊的負載啟動新的 agent 回合。模式與防抖／上限行為請參閱
[Queue](/concepts/queue)。 11. 請參閱
[Queue](/concepts/queue) 以了解模式與 debounce/cap 行為。

區塊串流會在助理區塊完成後立即送出；預設為**關閉**（`agents.defaults.blockStreamingDefault: "off"`）。
可透過 `agents.defaults.blockStreamingBreak` 調整邊界（`text_end` 與 `message_end`；預設為 text_end）。
使用 `agents.defaults.blockStreamingChunk` 控制軟性區塊分段（預設為
800–1200 個字元；優先段落分隔，其次換行，最後才是句子）。
使用 `agents.defaults.blockStreamingCoalesce` 合併串流片段，以降低單行訊息的洗版情況（送出前依閒置時間合併）。非 Telegram 頻道需要明確設定
`*.blockStreaming: true` 才能啟用區塊回覆。
詳細的工具摘要會在工具啟動時送出（不進行防抖）；當可用時，控制介面會透過 agent 事件串流工具輸出。
更多細節：[Streaming + chunking](/concepts/streaming)。
12. 透過 `agents.defaults.blockStreamingBreak` 調整邊界（`text_end` vs `message_end`；預設為 text_end）。
13. 使用 `agents.defaults.blockStreamingChunk` 控制軟性區塊分割（預設為
800–1200 字元；優先段落分隔，其次換行，最後才是句子）。
14. 使用 `agents.defaults.blockStreamingCoalesce` 合併串流區塊，以減少單行垃圾訊息（在送出前基於閒置時間進行合併）。 15. 非 Telegram 頻道需要
明確設定 `*.blockStreaming: true` 才能啟用區塊回覆。
16. 詳細的工具摘要會在工具啟動時發出（無 debounce）；控制 UI 會在可用時透過代理事件串流工具輸出。
17. 更多細節：[Streaming + chunking](/concepts/streaming)。

## 模型參照

設定中的模型參照（例如 `agents.defaults.model` 與 `agents.defaults.models`）會以**第一個** `/` 為界進行分割解析。

- 設定模型時請使用 `provider/model`。
- 若模型 ID 本身包含 `/`（OpenRouter 風格），請包含提供者前綴（例如：`openrouter/moonshotai/kimi-k2`）。
- 若省略提供者，OpenClaw 會將輸入視為別名或**預設提供者**的模型（僅在模型 ID 中不含 `/` 時才適用）。

## 設定（最小）

至少需要設定：

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom`（強烈建議）

---

_下一步：[Group Chats](/channels/group-messages)_ 🦞
