---
summary: "偵錯工具：監看模式、原始模型串流，以及追蹤推理洩漏"
read_when:
  - 當您需要檢查原始模型輸出是否存在推理洩漏時
  - 當您想在迭代時以監看模式執行 Gateway 時
  - 當您需要可重複的偵錯工作流程時
title: "偵錯"
---

# 偵錯

此頁面涵蓋串流輸出的偵錯輔助工具，特別是當供應商將推理混入正常文字時。

## 執行時偵錯覆寫

在聊天中使用 `/debug` 來設定**僅限執行時**的設定覆寫（記憶體中，而非磁碟上）。`/debug` 預設為停用；請使用 `commands.debug: true` 啟用。當您需要切換不常見的設定而無需編輯 `openclaw.json` 時，這會很方便。

範例：

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` 清除所有覆寫，並返回磁碟上的設定。

## Gateway 監看模式

為實現快速迭代，請在檔案監看器下執行 Gateway：

```bash
pnpm gateway:watch --force
```

這對應於：

```bash
tsx watch src/entry.ts gateway --force
```

在 `gateway:watch` 後面新增任何 Gateway CLI 旗標，它們將在每次重新啟動時傳遞。

## 開發者設定檔 + 開發者 Gateway (--dev)

使用開發者設定檔來隔離狀態並啟動一個安全、一次性的設定以進行偵錯。有**兩個** `--dev` 旗標：

- **全域 `--dev` (設定檔)：** 將狀態隔離在 `~/.openclaw-dev` 下，並將 Gateway 埠設定為 `19001`（衍生埠隨之移動）。
- **`gateway --dev`：指示 Gateway 在缺少時自動建立預設設定 + 工作區**（並跳過 BOOTSTRAP.md）。

建議流程（開發者設定檔 + 開發者啟動）：

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

如果您尚未進行全域安裝，請透過 `pnpm openclaw ...` 執行 CLI。

其作用為：

1. **設定檔隔離**（全域 `--dev`）
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (瀏覽器/畫布隨之移動)

2. **開發者啟動**（`gateway --dev`）
   - 如果缺少，則寫入最小設定（`gateway.mode=local`，綁定 local loopback）。
   - 將 `agent.workspace` 設定為開發者工作區。
   - 設定 `agent.skipBootstrap=true`（無 BOOTSTRAP.md）。
   - 如果缺少，則植入工作區檔案：
     `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`。
   - 預設身分：**C3‑PO** (協定機器人)。
   - 在開發者模式下跳過頻道供應商（`OPENCLAW_SKIP_CHANNELS=1`）。

重設流程（全新開始）：

```bash
pnpm gateway:dev:reset
```

注意：`--dev` 是一個**全域**設定檔旗標，並可能被某些執行器消耗。如果您需要明確指出，請使用環境變數形式：

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` 會清除設定、憑證、工作階段和開發者工作區（使用 `trash`，而非 `rm`），然後重新建立預設的開發者設定。

提示：如果非開發者 Gateway 已經在執行（launchd/systemd），請先停止它：

```bash
openclaw gateway stop
```

## 原始串流記錄 (OpenClaw)

OpenClaw 可以在任何過濾/格式化之前記錄**原始助理串流**。這是了解推理是作為純文字差異（或作為單獨的思考區塊）到達的最佳方式。

透過 CLI 啟用它：

```bash
pnpm gateway:watch --force --raw-stream
```

選用路徑覆寫：

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

為了在原始 OpenAI 相容區塊被解析成區塊之前捕獲它們，pi-mono 暴露了一個單獨的記錄器：

```bash
PI_RAW_STREAM=1
```

選用路徑：

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

預設檔案：

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> 注意：這僅由使用 pi-mono 的 `openai-completions` 供應商的程序發出。

## 安全注意事項

- 原始串流記錄可能包含完整的提示、工具輸出和使用者資料。
- 將記錄保留在本地，並在偵錯後刪除它們。
- 如果您分享記錄，請先清除機密和個人身分識別資訊（PII）。
