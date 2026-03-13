---
summary: "Agent runtime (embedded pi-mono), workspace contract, and session bootstrap"
read_when:
  - "Changing agent runtime, workspace bootstrap, or session behavior"
title: Agent Runtime
---

# Agent Runtime 🤖

OpenClaw 執行一個單一的嵌入式代理執行環境，源自 **pi-mono**。

## Workspace (必填)

OpenClaw 使用單一代理工作區目錄 (`agents.defaults.workspace`) 作為代理的 **唯一** 工作目錄 (`cwd`)，用於工具和上下文。

建議：使用 `openclaw setup` 來創建 `~/.openclaw/openclaw.json`（如果缺失）並初始化工作區檔案。

完整的工作區佈局 + 備份指南: [代理工作區](/concepts/agent-workspace)

如果 `agents.defaults.sandbox` 已啟用，非主要會話可以在 `agents.defaults.sandbox.workspaceRoot` 下使用每個會話的工作區來覆蓋此設定（請參見 [Gateway configuration](/gateway/configuration)）。

## Bootstrap 檔案（注入）

在 `agents.defaults.workspace` 中，OpenClaw 期望這些可供用戶編輯的檔案：

- `AGENTS.md` — 操作指令 + “記憶”
- `SOUL.md` — 個性、界限、語調
- `TOOLS.md` — 使用者維護的工具註解（例如 `imsg`、`sag`、慣例）
- `BOOTSTRAP.md` — 一次性首次執行儀式（完成後刪除）
- `IDENTITY.md` — 代理名稱/氛圍/表情符號
- `USER.md` — 使用者檔案 + 偏好的稱呼

在新會話的第一回合，OpenClaw 會將這些檔案的內容直接注入到代理上下文中。

空白檔案會被跳過。大型檔案會被修剪並截斷，並加上標記，以保持提示簡潔（請閱讀檔案以獲取完整內容）。

如果檔案遺失，OpenClaw 會插入一行單一的「缺失檔案」標記（而 `openclaw setup` 將會創建一個安全的預設範本）。

`BOOTSTRAP.md` 只會在 **全新的工作區** 中創建（沒有其他啟動檔案存在）。如果在完成儀式後刪除它，則在後續重啟時不應該重新創建。

要完全禁用 bootstrap 檔案的創建（針對預先填充的工作區），請設定：

```json5
{ agent: { skipBootstrap: true } }
```

## 內建工具

核心工具（讀取/執行/編輯/寫入及相關系統工具）始終可用，受工具政策的限制。`apply_patch` 是可選的，並受到 `tools.exec.applyPatch` 的限制。`TOOLS.md` **不** 控制哪些工具存在；它是對 _你_ 如何使用這些工具的指導。

## Skills

OpenClaw 從三個位置加載技能（在名稱衝突的情況下，工作區優先）：

- 打包的（隨安裝一起提供）
- 管理/本地: `~/.openclaw/skills`
- 工作區: `<workspace>/skills`

技能可以透過設定/環境進行限制（請參見 `skills` 在 [閘道設定](/gateway/configuration) 中）。

## pi-mono 整合

OpenClaw 重用了一些 pi-mono 程式碼庫中的部分（模型/工具），但 **會話管理、發現和工具連接是 OpenClaw 所擁有的**。

- 沒有 pi-coding agent 執行時。
- 不會參考 `~/.pi/agent` 或 `<workspace>/.pi` 設定。

## Sessions

Session transcripts are stored as JSONL at:

`~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

會話 ID 是穩定的，並由 OpenClaw 選擇。  
舊版 Pi/Tau 會話資料夾 **不** 會被讀取。

## 在串流時的操控

當佇列模式為 `steer` 時，進來的訊息會被注入到當前的執行中。佇列會在 **每次工具呼叫後** 進行檢查；如果有佇列中的訊息存在，則當前助手訊息的剩餘工具呼叫會被跳過（錯誤工具結果顯示為 "因佇列中的使用者訊息而跳過。"），然後在下一次助手回應之前，佇列中的使用者訊息會被注入。

當佇列模式為 `followup` 或 `collect` 時，進來的訊息會被暫時保留，直到當前回合結束，然後新的代理回合將以佇列中的有效負載開始。請參閱 [Queue](/concepts/queue) 以了解模式 + 去彈跳/上限行為。

區塊串流會在助手區塊完成後立即發送；預設為**關閉** (`agents.defaults.blockStreamingDefault: "off"`)。透過 `agents.defaults.blockStreamingBreak` 調整邊界 (`text_end` 與 `message_end`；預設為 text_end)。使用 `agents.defaults.blockStreamingChunk` 控制軟區塊分塊（預設為 800–1200 字元；優先考慮段落斷點，其次是換行；最後是句子）。使用 `agents.defaults.blockStreamingCoalesce` 合併串流的區塊，以減少單行垃圾訊息（在發送前進行基於閒置的合併）。非 Telegram 通道需要明確的 `*.blockStreaming: true` 來啟用區塊回覆。詳細的工具摘要會在工具啟動時發出（無去抖動）；當可用時，透過代理事件控制 UI 串流工具輸出。更多細節請參考：[Streaming + chunking](/concepts/streaming)。

## Model refs

在設定中的模型引用（例如 `agents.defaults.model` 和 `agents.defaults.models`）是通過在 **第一個** `/` 上進行分割來解析的。

- 在設定模型時使用 `provider/model`。
- 如果模型 ID 本身包含 `/`（OpenRouter 風格），請包含提供者前綴（範例：`openrouter/moonshotai/kimi-k2`）。
- 如果省略提供者，OpenClaw 將把輸入視為 **預設提供者** 的別名或模型（僅在模型 ID 中沒有 `/` 時有效）。

## Configuration (minimal)

在最小情況下，設置：

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (強烈建議)

---

_Next: [群組聊天](/channels/group-messages)_ 🦞
