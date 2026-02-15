---
summary: "智慧代理執行時期 (嵌入式 pi-mono)、工作空間合約與工作階段啟動"
read_when:
  - 變更智慧代理執行時期、工作空間啟動或工作階段行為
title: "智慧代理執行時期"
---

# 智慧代理執行時期 🤖

OpenClaw 執行一個源自於 **pi-mono** 的嵌入式智慧代理執行時期。

## 工作空間 (必要)

OpenClaw 使用單一的智慧代理工作空間目錄 (`agents.defaults.workspace`) 作為智慧代理**唯一**的當前工作目錄 (`cwd`)，用於工具和上下文。

建議：如果 `~/.openclaw/openclaw.json` 不存在，請使用 `openclaw setup` 建立它，並初始化工作空間檔案。

完整的工作空間配置 + 備份指南：[智慧代理工作空間](/concepts/agent-workspace)

如果 `agents.defaults.sandbox` 已啟用，非主要工作階段可以使用 `agents.defaults.sandbox.workspaceRoot` 下的每個工作階段工作空間來覆寫此設定 (請參閱 [Gateway 設定](/gateway/configuration))。

## 啟動檔案 (注入)

在 `agents.defaults.workspace` 內，OpenClaw 預期存在這些使用者可編輯的檔案：

- `AGENTS.md` — 操作說明 +「記憶體」
- `SOUL.md` — 人設、界限、語氣
- `TOOLS.md` — 使用者維護的工具筆記 (例如 `imsg`、`sag`、慣例)
- `BOOTSTRAP.md` — 一次性的首次執行儀式 (完成後刪除)
- `IDENTITY.md` — 智慧代理名稱/風格/表情符號
- `USER.md` — 使用者個人資料 + 偏好稱呼

在新工作階段的第一次輪次中，OpenClaw 會將這些檔案的內容直接注入到智慧代理上下文。

空白檔案會被跳過。大型檔案會被截斷並附上標記，以保持提示精簡 (讀取檔案以獲取完整內容)。

如果檔案遺失，OpenClaw 會注入單一的「檔案遺失」標記行 (且 `openclaw setup` 會建立一個安全的預設模板)。

`BOOTSTRAP.md` 僅針對**全新的工作空間**建立 (沒有其他啟動檔案存在)。如果您在完成儀式後將其刪除，後續重新啟動時不應重新建立。

若要完全停用啟動檔案建立 (適用於預設工作空間)，請設定：

```json5
{ agent: { skipBootstrap: true } }
```

## 內建工具

核心工具 (讀取/執行/編輯/寫入和相關的系統工具) 始終可用，但受工具政策限制。`apply_patch` 是可選的，並由 `tools.exec.applyPatch` 控制。`TOOLS.md` **不**控制哪些工具存在；它是關於**您**希望如何使用它們的指南。

## Skills

OpenClaw 從三個位置載入 Skills (名稱衝突時工作空間優先)：

- 內建 (隨安裝一起提供)
- 受管/本機：`~/.openclaw/skills`
- 工作空間：`<workspace>/skills`

Skills 可以透過設定/環境變數來控制 (請參閱 [Gateway 設定](/gateway/configuration) 中的 `skills`)。

## pi-mono 整合

OpenClaw 重複使用 pi-mono 程式碼庫的部分 (模型/工具)，但**工作階段管理、裝置探索和工具連接由 OpenClaw 擁有**。

- 沒有 pi-coding 智慧代理執行時期。
- 不會參考 `~/.pi/agent` 或 `<workspace>/.pi` 設定。

## 工作階段

工作階段轉錄檔以 JSONL 格式儲存於：

- `~/.openclaw/agents/<agentId>/sessions/<SessionId>.jsonl`

工作階段 ID 是穩定的，由 OpenClaw 選擇。
不讀取舊版 Pi/Tau 工作階段檔案。

## 串流傳輸時的引導

當佇列模式為 `steer` 時，入站訊息會被注入到當前執行中。
**每次工具呼叫後**都會檢查佇列；如果存在佇列中的訊息，當前助理訊息中剩餘的工具呼叫將被跳過 (工具結果錯誤顯示「因佇列中的使用者訊息而跳過。」)，然後在下一個助理回應之前注入佇列中的使用者訊息。

當佇列模式為 `followup` 或 `collect` 時，入站訊息會被保留直到當前回合結束，然後新的智慧代理回合會以佇列中的負載開始。請參閱 [佇列](/concepts/queue) 以了解模式 + 防抖/容量行為。

區塊串流傳輸會盡快傳送已完成的助理區塊；預設情況下它**是關閉的** (`agents.defaults.blockStreamingDefault: "off"`)。
透過 `agents.defaults.blockStreamingBreak` (`text_end` 與 `message_end`；預設為 text_end) 調整邊界。
使用 `agents.defaults.blockStreamingChunk` 控制軟區塊分塊 (預設為 800–1200 字元；偏好段落斷行，然後是換行符；最後是句子)。
使用 `agents.defaults.blockStreamingCoalesce` 合併串流傳輸的區塊以減少單行垃圾訊息 (傳送前的閒置合併)。非 Telegram 頻道需要明確的 `*.blockStreaming: true` 才能啟用區塊回覆。
詳細的工具摘要會在工具啟動時發出 (無防抖)；當可用時，控制 UI 會透過智慧代理事件串流傳輸工具輸出。
更多詳情：[串流傳輸 + 分塊](/concepts/streaming)。

## 模型參考

設定中的模型參考 (例如 `agents.defaults.model` 和 `agents.defaults.models`) 透過**第一個** `/` 分割進行解析。

- 設定模型時使用 `供應商/模型`。
- 如果模型 ID 本身包含 `/` (OpenRouter 樣式)，請包含供應商前綴 (範例：`openrouter/moonshotai/kimi-k2`)。
- 如果您省略供應商，OpenClaw 會將輸入視為**預設供應商**的別名或模型 (僅在模型 ID 中沒有 `/` 時有效)。

## 設定 (最簡)

至少設定：

- `agents.defaults.workspace`
- `channels.whatsapp.allowFrom` (強烈建議)

---

_下一步：[群組聊天](/channels/group-messages)_ 🦞
