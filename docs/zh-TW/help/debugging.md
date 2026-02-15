---
summary: "除錯工具：監控模式、原始模型串流，以及追蹤推理洩漏"
read_when:
  - 您需要檢查原始模型輸出以尋找推理洩漏
  - 您想在迭代時以監控模式執行 Gateway
  - 您需要一個可重複的除錯工作流程
title: "除錯"
---

# 除錯

此頁面涵蓋了串流輸出的除錯輔助工具，特別是當供應商將推理過程混入一般文字時。

## 執行階段除錯覆寫

在聊天中使用 `/debug` 來設定**僅限執行階段**的設定覆寫（儲存在記憶體而非磁碟中）。
`/debug` 預設為停用；請使用 `commands.debug: true` 來啟用。
當您需要切換較少見的設定而不想編輯 `openclaw.json` 時，這非常方便。

範例：

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` 會清除所有覆寫並恢復到磁碟上的設定。

## Gateway 監控模式

為了快速迭代，請在檔案監控器下執行 Gateway：

```bash
pnpm gateway:watch --force
```

這會映射到：

```bash
tsx watch src/entry.ts gateway --force
```

在 `gateway:watch` 後面新增任何 Gateway CLI 旗標，這些旗標將在每次重新啟動時傳遞。

## 開發設定檔 + 開發 Gateway (--dev)

使用開發設定檔來隔離狀態，並為除錯建立一個安全、可丟棄的環境。共有**兩個** `--dev` 旗標：

- **全域 `--dev` (設定檔)：** 將狀態隔離在 `~/.openclaw-dev` 下，並預設 Gateway 連接埠為 `19001`（相關連接埠也會隨之調整）。
- **`gateway --dev`：** 告訴 Gateway 在缺少設定時自動建立預設設定 + 工作空間（並跳過 BOOTSTRAP.md）。

推薦流程（開發設定檔 + 開發引導）：

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

如果您尚未進行全域安裝，請透過 `pnpm openclaw ...` 執行 CLI。

此操作的作用：

1. **設定檔隔離** (全域 `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (browser/canvas 會相應調整)

2. **開發引導** (`gateway --dev`)
   - 如果缺少設定，則寫入最小化設定 (`gateway.mode=local`, 綁定 local loopback)。
   - 將 `agent.workspace` 設定為開發工作空間。
   - 設定 `agent.skipBootstrap=true`（不執行 BOOTSTRAP.md）。
   - 如果缺少工作空間檔案，則建立初始檔案：
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`。
   - 預設身分：**C3‑PO** (禮儀機器人)。
   - 在開發模式下跳過頻道供應商 (`OPENCLAW_SKIP_CHANNELS=1`)。

重設流程（全新開始）：

```bash
pnpm gateway:dev:reset
```

注意：`--dev` 是一個**全域**設定檔旗標，在某些執行器中可能會被忽略。如果您需要明確指定，請使用環境變數形式：

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` 會抹除設定、憑證、工作階段和開發工作空間（使用 `trash` 而非 `rm`），然後重新建立預設的開發環境。

提示：如果非開發用的 Gateway 已經在執行（launchd/systemd），請先停止它：

```bash
openclaw gateway stop
```

## 原始串流記錄 (OpenClaw)

OpenClaw 可以記錄任何過濾或格式化之前的**原始智慧代理串流**。這是觀察推理過程是以純文字增量形式到達，還是作為獨立思考區塊到達的最佳方式。

透過 CLI 啟用：

```bash
pnpm gateway:watch --force --raw-stream
```

選擇性路徑覆寫：

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

等效環境變數：

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

預設檔案：

`~/.openclaw/logs/raw-stream.jsonl`

## 原始區塊記錄 (pi-mono)

為了在解析成區塊之前擷取**原始 OpenAI 相容區塊**，pi-mono 提供了一個獨立的記錄器：

```bash
PI_RAW_STREAM=1
```

選擇性路徑：

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

預設檔案：

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> 注意：這僅由使用 pi-mono 的 `openai-completions` 供應商的程序發出。

## 安全注意事項

- 原始串流記錄可能包含完整的提示詞、工具輸出和使用者資料。
- 請將記錄保存在本機，並在除錯後刪除。
- 如果您分享記錄，請先清除秘密資訊和個人識別資訊 (PII)。
