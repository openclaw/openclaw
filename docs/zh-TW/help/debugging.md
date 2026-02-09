---
summary: "除錯工具：監看模式、原始模型串流，以及推理洩漏的追蹤"
read_when:
  - 你需要檢視原始模型輸出以檢查推理洩漏
  - 你想在反覆迭代時以監看模式執行 Gateway 閘道器
  - 你需要可重複的除錯工作流程
title: "除錯"
---

# 除錯

This page covers debugging helpers for streaming output, especially when a
provider mixes reasoning into normal text.

## 執行期除錯覆寫

Use `/debug` in chat to set **runtime-only** config overrides (memory, not disk).
`/debug` 預設為停用；請以 `commands.debug: true` 啟用。
This is handy when you need to toggle obscure settings without editing `openclaw.json`.

範例：

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` 會清除所有覆寫並回到磁碟上的設定。

## Gateway 監看模式

為了快速迭代，請在檔案監看器下執行 Gateway 閘道器：

```bash
pnpm gateway:watch --force
```

這會對應到：

```bash
tsx watch src/entry.ts gateway --force
```

在 `gateway:watch` 之後加入任何 Gateway 閘道器 CLI 旗標，重啟時都會一併傳遞。

## Dev 設定檔 + dev gateway（--dev）

Use the dev profile to isolate state and spin up a safe, disposable setup for
debugging. 共有 **兩個** `--dev` 旗標：

- **全域 `--dev`（設定檔）：** 將狀態隔離在 `~/.openclaw-dev` 之下，並將 Gateway 閘道器連接埠預設為 `19001`（其衍生連接埠也會隨之位移）。
- **`gateway --dev`：告訴 Gateway 在缺少時自動建立預設設定 +
  工作區**（並略過 BOOTSTRAP.md）。

建議流程（開發者設定檔 + dev bootstrap）：

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

如果你尚未有全域安裝，請透過 `pnpm openclaw ...` 執行 CLI。

其行為如下：

1. **設定檔隔離**（全域 `--dev`）
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001`（瀏覽器／畫布也會相應位移）

2. **Dev 啟動**（`gateway --dev`）
   - 若缺少則寫入最小設定（`gateway.mode=local`，繫結 local loopback）。
   - 將 `agent.workspace` 設為 dev 工作區。
   - 設定 `agent.skipBootstrap=true`（不使用 BOOTSTRAP.md）。
   - 若缺少則播種工作區檔案：
     `AGENTS.md`、`SOUL.md`、`TOOLS.md`、`IDENTITY.md`、`USER.md`、`HEARTBEAT.md`。
   - 預設身分：**C3‑PO**（protocol droid）。
   - 在 dev 模式下略過頻道提供者（`OPENCLAW_SKIP_CHANNELS=1`）。

重置流程（全新開始）：

```bash
pnpm gateway:dev:reset
```

注意：`--dev` 是一個**全域**設定檔旗標，且會被某些執行器吃掉。
If you need to spell it out, use the env var form:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` 會清除設定、憑證、工作階段，以及 dev 工作區（使用
`trash`，而非 `rm`），然後重新建立預設的 dev 設定。

提示：如果已有非 dev 的 Gateway 閘道器正在執行（launchd/systemd），請先停止它：

```bash
openclaw gateway stop
```

## 原始串流記錄（OpenClaw）

OpenClaw 可以在任何過濾／格式化之前，記錄**原始助理串流**。
這是查看推理是否以純文字增量抵達
（或作為獨立的思考區塊）的最佳方式。

透過 CLI 啟用：

```bash
pnpm gateway:watch --force --raw-stream
```

可選的路徑覆寫：

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

等效的環境變數：

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Default file:

`~/.openclaw/logs/raw-stream.jsonl`

## 原始分塊記錄（pi-mono）

為了在解析成區塊之前擷取**原始 OpenAI 相容分塊**，
pi-mono 提供了獨立的記錄器：

```bash
PI_RAW_STREAM=1
```

可選路徑：

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

預設檔案：

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> 注意：這只會由使用 pi-mono 的
> `openai-completions` 提供者的處理程序輸出。

## 安全性注意事項

- 原始串流記錄可能包含完整提示、工具輸出與使用者資料。
- Keep logs local and delete them after debugging.
- 若你分享日誌，請先清除祕密資訊與 PII。
