---
summary:「記錄介面、檔案記錄、WS 記錄樣式，以及主控台格式化」
read_when:
  - 變更記錄輸出或格式時
  - 偵錯 CLI 或 Gateway 閘道器輸出時
title:「Logging」
x-i18n:
  source_path: gateway/logging.md
  source_hash: efb8eda5e77e3809
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:28:08Z
---

# Logging

如需以使用者為導向的概覽（CLI + Control UI + 設定），請參閱 [/logging](/logging)。

OpenClaw 有兩個記錄「介面」：

- **主控台輸出**（你在終端機／除錯 UI 中看到的內容）。
- **檔案記錄**（JSON lines），由 Gateway 閘道器記錄器寫入。

## 檔案型記錄器

- 預設的輪替記錄檔位於 `/tmp/openclaw/` 之下（每天一個檔案）：`openclaw-YYYY-MM-DD.log`
  - 日期使用閘道器主機的本地時區。
- 記錄檔路徑與層級可透過 `~/.openclaw/openclaw.json` 設定：
  - `logging.file`
  - `logging.level`

檔案格式為每行一個 JSON 物件。

Control UI 的 Logs 分頁會透過 Gateway 閘道器尾隨（tail）此檔案（`logs.tail`）。
CLI 也可以執行相同操作：

```bash
openclaw logs --follow
```

**Verbose 與記錄層級**

- **檔案記錄**僅由 `logging.level` 控制。
- `--verbose` 只會影響 **主控台的詳細程度**（以及 WS 記錄樣式）；它**不會**
  提高檔案記錄層級。
- 若要在檔案記錄中擷取僅限 verbose 的細節，請將 `logging.level` 設為 `debug` 或
  `trace`。

## 主控台擷取

CLI 會擷取 `console.log/info/warn/error/debug/trace` 並將其寫入檔案記錄，
同時仍然輸出至 stdout／stderr。

你可以透過以下方式獨立調整主控台詳細程度：

- `logging.consoleLevel`（預設 `info`）
- `logging.consoleStyle`（`pretty` | `compact` | `json`）

## 工具摘要遮蔽

Verbose 的工具摘要（例如 `🛠️ Exec: ...`）可以在進入
主控台串流之前遮蔽敏感權杖。這僅適用於 **tools**，不會變更檔案記錄。

- `logging.redactSensitive`：`off` | `tools`（預設：`tools`）
- `logging.redactPatterns`：正則表達式字串的陣列（會覆蓋預設值）
  - 使用原始正則字串（自動 `gi`），或在需要自訂旗標時使用 `/pattern/flags`。
  - 比對項會保留前 6 + 後 4 個字元（長度 >= 18）進行遮蔽，否則為 `***`。
  - 預設值涵蓋常見的金鑰指派、CLI 旗標、JSON 欄位、bearer 標頭、PEM 區塊，以及常見的權杖前綴。

## Gateway WebSocket 記錄

Gateway 閘道器會以兩種模式輸出 WebSocket 協定記錄：

- **一般模式（未啟用 `--verbose`）**：只會輸出「有意義」的 RPC 結果：
  - 錯誤（`ok=false`）
  - 緩慢呼叫（預設門檻：`>= 50ms`）
  - 解析錯誤
- **Verbose 模式（`--verbose`）**：輸出所有 WS 請求／回應流量。

### WS 記錄樣式

`openclaw gateway` 支援每個 Gateway 閘道器的樣式切換：

- `--ws-log auto`（預設）：一般模式最佳化；verbose 模式使用精簡輸出
- `--ws-log compact`：在 verbose 時使用精簡輸出（成對的請求／回應）
- `--ws-log full`：在 verbose 時使用完整的逐框輸出
- `--compact`：`--ws-log compact` 的別名

範例：

```bash
# optimized (only errors/slow)
openclaw gateway

# show all WS traffic (paired)
openclaw gateway --verbose --ws-log compact

# show all WS traffic (full meta)
openclaw gateway --verbose --ws-log full
```

## 主控台格式化（子系統記錄）

主控台格式化器具備 **TTY 感知**，並輸出一致、帶前綴的行。
子系統記錄器會讓輸出保持分組且易於掃描。

行為：

- 每行都有 **子系統前綴**（例如 `[gateway]`、`[canvas]`、`[tailscale]`）
- **子系統顏色**（每個子系統固定）加上層級著色
- **當輸出為 TTY 或環境看起來像豐富終端機時啟用顏色**（`TERM`/`COLORTERM`/`TERM_PROGRAM`），並遵循 `NO_COLOR`
- **縮短的子系統前綴**：移除開頭的 `gateway/` + `channels/`，保留最後 2 個區段（例如 `whatsapp/outbound`）
- **依子系統的子記錄器**（自動前綴 + 結構化欄位 `{ subsystem }`）
- **`logRaw()`** 用於 QR／UX 輸出（無前綴、無格式）
- **主控台樣式**（例如 `pretty | compact | json`）
- **主控台記錄層級** 與檔案記錄層級分離（當 `logging.level` 設為 `debug`/`trace` 時，檔案仍保留完整細節）
- **WhatsApp 訊息本文** 會以 `debug` 記錄（使用 `--verbose` 來查看）

這可在維持既有檔案記錄穩定的同時，讓互動式輸出更容易掃描。
