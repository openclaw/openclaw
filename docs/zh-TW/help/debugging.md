---
summary: "Debugging tools: watch mode, raw model streams, and tracing reasoning leakage"
read_when:
  - You need to inspect raw model output for reasoning leakage
  - You want to run the Gateway in watch mode while iterating
  - You need a repeatable debugging workflow
title: Debugging
---

# Debugging

這個頁面涵蓋了用於串流輸出的除錯輔助工具，特別是在提供者將推理混合到正常文本中的情況下。

## Runtime debug overrides

在聊天中使用 `/debug` 來設置 **僅限執行時** 的設定覆蓋（記憶體，而非磁碟）。`/debug` 預設為禁用；可透過 `commands.debug: true` 來啟用。這在您需要切換不常見的設定而不編輯 `openclaw.json` 時非常方便。

[[BLOCK_1]]  
範例：  
[[BLOCK_2]]

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` 會清除所有覆蓋並返回到磁碟上的設定。

## Gateway 監控模式

為了快速迭代，請在檔案監視器下執行網關：

```bash
pnpm gateway:watch
```

這對應到：

```bash
node --watch-path src --watch-path tsconfig.json --watch-path package.json --watch-preserve-output scripts/run-node.mjs gateway --force
```

在 `gateway:watch` 之後添加任何網關 CLI 標誌，這些標誌將在每次重啟時傳遞。

## 開發者設定檔 + 開發者網關 (--dev)

使用開發設定來隔離狀態並啟動一個安全、可丟棄的設置以進行除錯。有 **兩個** `--dev` 標誌：

- **Global `--dev` (profile):** 在 `~/.openclaw-dev` 下隔離狀態，並將閘道埠預設為 `19001`（衍生埠隨之變動）。
- **`gateway --dev`: 告訴閘道在缺少時自動創建預設設定 + 工作區**（並跳過 BOOTSTRAP.md）。

建議流程（開發者設定檔 + 開發者啟動）：

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

如果你還沒有全域安裝，請透過 `pnpm openclaw ...` 執行 CLI。

這個是做什麼的：

1. **個人資料隔離** (全域 `--dev`)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (瀏覽器/畫布相應調整)

2. **開發啟動** (`gateway --dev`)
   - 如果缺少，則寫入最小設定 (`gateway.mode=local`，綁定迴圈回路)。
   - 將 `agent.workspace` 設定為開發工作區。
   - 設定 `agent.skipBootstrap=true`（無 BOOTSTRAP.md）。
   - 如果缺少，則種子工作區檔案：
     `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`。
   - 預設身份：**C3‑PO**（協議機器人）。
   - 在開發模式下跳過通道提供者 (`OPENCLAW_SKIP_CHANNELS=1`).

[[BLOCK_1]]  
Reset flow (fresh start):  
[[BLOCK_1]]

```bash
pnpm gateway:dev:reset
```

注意：`--dev` 是一個 **全域** 設定標誌，某些執行者會忽略它。  
如果需要詳細說明，請使用環境變數的形式：

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` 會清除設定、憑證、會話和開發工作區（使用 `trash`，而不是 `rm`），然後重新建立預設的開發設置。

提示：如果非開發者網關已經在執行（launchd/systemd），請先停止它：

```bash
openclaw gateway stop
```

## 原始串流日誌記錄 (OpenClaw)

OpenClaw 可以在任何過濾/格式化之前記錄 **原始助手串流**。這是檢查推理是否以純文本增量（或作為獨立思考區塊）到達的最佳方式。

透過 CLI 啟用它：

```bash
pnpm gateway:watch --raw-stream
```

可選的路徑覆寫：

```bash
pnpm gateway:watch --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

等效的環境變數：

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Default file:

`~/.openclaw/logs/raw-stream.jsonl`

## 原始區塊日誌 (pi-mono)

要在解析成區塊之前捕獲 **原始的 OpenAI 相容區塊**，pi-mono 提供了一個單獨的記錄器：

```bash
PI_RAW_STREAM=1
```

[[BLOCK_1]]  
可選路徑：  
[[BLOCK_1]]

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Default file:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> 注意：這僅由使用 pi-mono 的 `openai-completions` 提供者的進程發出。

## 安全注意事項

- 原始串流日誌可能包含完整的提示、工具輸出和用戶數據。
- 將日誌保留在本地，並在除錯後刪除。
- 如果您分享日誌，請先刪除機密資訊和個人識別資訊 (PII)。
