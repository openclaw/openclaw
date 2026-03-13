---
summary: "Logging overview: file logs, console output, CLI tailing, and the Control UI"
read_when:
  - You need a beginner-friendly overview of logging
  - You want to configure log levels or formats
  - You are troubleshooting and need to find logs quickly
title: Logging
---

# 紀錄

OpenClaw 的紀錄存在兩個地方：

- **檔案紀錄**（JSON 行格式），由 Gateway 寫入。
- **終端機輸出**，顯示在終端機與控制介面中。

本頁說明紀錄的位置、如何閱讀，以及如何設定紀錄等級與格式。

## 紀錄位置

預設情況下，Gateway 會在以下路徑寫入滾動紀錄檔：

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

日期會使用 Gateway 主機的本地時區。

你可以在 `~/.openclaw/openclaw.json` 中覆寫此設定：

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## 如何閱讀紀錄

### CLI：即時追蹤（推薦）

使用 CLI 透過 RPC 追蹤 Gateway 紀錄檔：

```bash
openclaw logs --follow
```

輸出模式：

- **TTY 會話**：美觀、有色彩、結構化的日誌行。
- **非 TTY 會話**：純文字。
- `--json`：以行分隔的 JSON（每行一個日誌事件）。
- `--plain`：強制在 TTY 會話中使用純文字。
- `--no-color`：禁用 ANSI 顏色。

在 JSON 模式下，CLI 輸出帶有 `type` 標籤的物件：

- `meta`：串流元資料（檔案、游標、大小）
- `log`：解析後的日誌條目
- `notice`：截斷 / 輪替提示
- `raw`：未解析的日誌行

如果 Gateway 無法連線，CLI 會印出簡短提示，建議執行：

```bash
openclaw doctor
```

### 控制介面（網頁）

控制介面的 **Logs** 分頁會使用 `logs.tail` 追蹤相同檔案。
詳情請參考 [/web/control-ui](/web/control-ui) 如何開啟。

### 僅頻道日誌

若要過濾頻道活動（WhatsApp/Telegram 等），請使用：

```bash
openclaw channels logs --channel whatsapp
```

## 日誌格式

### 檔案日誌（JSONL）

日誌檔案中的每一行都是一個 JSON 物件。CLI 和控制介面會解析這些
條目以呈現結構化輸出（時間、等級、子系統、訊息）。

### 主控台輸出

主控台日誌具備 **TTY 感知**，並以易讀格式呈現：

- 子系統前綴（例如 `gateway/channels/whatsapp`）
- 等級著色（資訊/警告/錯誤）
- 可選的精簡或 JSON 模式

主控台格式由 `logging.consoleStyle` 控制。

## 設定日誌紀錄

所有日誌設定都位於 `logging` 的 `~/.openclaw/openclaw.json` 下。

```json
{
  "logging": {
    "level": "info",
    "file": "/tmp/openclaw/openclaw-YYYY-MM-DD.log",
    "consoleLevel": "info",
    "consoleStyle": "pretty",
    "redactSensitive": "tools",
    "redactPatterns": ["sk-.*"]
  }
}
```

### 日誌等級

- `logging.level`：**檔案日誌**（JSONL）等級。
- `logging.consoleLevel`：**主控台** 詳細程度等級。

你可以透過 **`OPENCLAW_LOG_LEVEL`** 環境變數（例如 `OPENCLAW_LOG_LEVEL=debug`）覆寫兩者。環境變數優先於設定檔，因此你可以在不修改 `openclaw.json` 的情況下，針對單次執行提高詳細程度。你也可以傳入全域 CLI 選項 **`--log-level <level>`**（例如 `openclaw --log-level debug gateway run`），該選項會覆寫該指令的環境變數設定。

`--verbose` 僅影響主控台輸出；不會改變檔案日誌等級。

### 主控台樣式

`logging.consoleStyle`：

- `pretty`：人性化、彩色且帶有時間戳記。
- `compact`：更緊湊的輸出（適合長時間工作階段）。
- `json`：每行 JSON（供日誌處理器使用）。

### 遮蔽

工具摘要可在輸出到主控台前遮蔽敏感的 token：

- `logging.redactSensitive`：`off` | `tools`（預設：`tools`）
- `logging.redactPatterns`：用於覆寫預設集合的正則表達式字串清單

遮蔽僅影響**主控台輸出**，不會更改檔案日誌。

## 診斷 + OpenTelemetry

診斷是針對模型執行**及**訊息流程遙測（Webhook、排隊、會話狀態）的結構化、機器可讀事件。它們**不**取代日誌；存在的目的是用來提供指標、追蹤及其他匯出器。

診斷事件在程序內發出，但匯出器僅在診斷與匯出器外掛啟用時才會附加。

### OpenTelemetry 與 OTLP

- **OpenTelemetry (OTel)**：用於追蹤、指標與日誌的資料模型與 SDK。
- **OTLP**：用來將 OTel 資料匯出到收集器/後端的傳輸協定。
- OpenClaw 目前透過 **OTLP/HTTP (protobuf)** 進行匯出。

### 匯出訊號

- **指標**：計數器與直方圖（token 使用量、訊息流程、排隊）。
- **追蹤**：模型使用與 webhook/訊息處理的 span。
- **日誌**：啟用 `diagnostics.otel.logs` 時透過 OTLP 匯出。日誌量可能很大，請留意 `logging.level` 與匯出器過濾條件。

### 診斷事件目錄

模型使用：

- `model.usage`：token、成本、持續時間、上下文、提供者/模型/頻道、會話 ID。

訊息流程：

- `webhook.received`：每個頻道的 webhook 進入。
- `webhook.processed`：webhook 處理與持續時間。
- `webhook.error`：webhook 處理錯誤。
- `message.queued`：訊息排入處理佇列。
- `message.processed`：結果、持續時間與選擇性錯誤。

排隊 + 會話：

- `queue.lane.enqueue`：指令佇列通道的排入與深度。
- `queue.lane.dequeue`：指令佇列通道的取出與等待時間。
- `session.state`：會話狀態轉換與原因。
- `session.stuck`：會話卡住警告與持續時間。
- `run.attempt`：執行重試/嘗試的元資料。
- `diagnostic.heartbeat`：彙總計數器（webhook/佇列/會話）。

### 啟用診斷（無匯出器）

如果您想讓診斷事件可供插件或自訂接收器使用，請使用此功能：

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### 診斷旗標（針對性日誌）

使用旗標來開啟額外的針對性除錯日誌，而不會提高 `logging.level`。
旗標不區分大小寫，並支援萬用字元（例如 `telegram.*` 或 `*`）。

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

環境變數覆寫（一次性）：

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

注意事項：

- 旗標日誌會寫入標準日誌檔（與 `logging.file` 相同）。
- 輸出仍會依照 `logging.redactSensitive` 進行遮蔽。
- 完整指南：[/diagnostics/flags](/diagnostics/flags)。

### 匯出至 OpenTelemetry

診斷資料可透過 `diagnostics-otel` 插件（OTLP/HTTP）匯出。
此方式適用於任何接受 OTLP/HTTP 的 OpenTelemetry 收集器/後端。

```json
{
  "plugins": {
    "allow": ["diagnostics-otel"],
    "entries": {
      "diagnostics-otel": {
        "enabled": true
      }
    }
  },
  "diagnostics": {
    "enabled": true,
    "otel": {
      "enabled": true,
      "endpoint": "http://otel-collector:4318",
      "protocol": "http/protobuf",
      "serviceName": "openclaw-gateway",
      "traces": true,
      "metrics": true,
      "logs": true,
      "sampleRate": 0.2,
      "flushIntervalMs": 60000
    }
  }
}
```

注意事項：

- 你也可以使用 `openclaw plugins enable diagnostics-otel` 啟用該插件。
- `protocol` 目前僅支援 `http/protobuf`，`grpc` 會被忽略。
- 指標包含 token 使用量、成本、上下文大小、執行時間，以及訊息流程計數器/直方圖（Webhook、排隊、會話狀態、佇列深度/等待）。
- 追蹤/指標可透過 `traces` / `metrics` 切換（預設為開啟）。追蹤包含模型使用區段，以及啟用時的 webhook/訊息處理區段。
- 當收集器需要驗證時，請設定 `headers`。
- 支援的環境變數有：`OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_SERVICE_NAME`、`OTEL_EXPORTER_OTLP_PROTOCOL`。

### 匯出指標（名稱 + 類型）

模型使用情況：

- `openclaw.tokens`（計數器，屬性：`openclaw.token`、`openclaw.channel`、`openclaw.provider`、`openclaw.model`）
- `openclaw.cost.usd`（計數器，屬性：`openclaw.channel`、`openclaw.provider`、`openclaw.model`）
- `openclaw.run.duration_ms`（直方圖，屬性：`openclaw.channel`、`openclaw.provider`、`openclaw.model`）
- `openclaw.context.tokens`（直方圖，屬性：`openclaw.context`、`openclaw.channel`、`openclaw.provider`、`openclaw.model`）

訊息流程：

- `openclaw.webhook.received`（計數器，屬性：`openclaw.channel`、`openclaw.webhook`）
- `openclaw.webhook.error`（計數器，屬性：`openclaw.channel`、`openclaw.webhook`）
- `openclaw.webhook.duration_ms`（直方圖，屬性：`openclaw.channel`、`openclaw.webhook`）
- `openclaw.message.queued`（計數器，屬性：`openclaw.channel`、`openclaw.source`）
- `openclaw.message.processed`（計數器，屬性：`openclaw.channel`、`openclaw.outcome`）
- `openclaw.message.duration_ms`（直方圖，屬性：`openclaw.channel`、`openclaw.outcome`）

佇列與會話：

- `openclaw.queue.lane.enqueue`（計數器，屬性：`openclaw.lane`）
- `openclaw.queue.lane.dequeue`（計數器，屬性：`openclaw.lane`）
- `openclaw.queue.depth`（直方圖，屬性：`openclaw.lane` 或 `openclaw.channel=heartbeat`）
- `openclaw.queue.wait_ms`（直方圖，屬性：`openclaw.lane`）
- `openclaw.session.state`（計數器，屬性：`openclaw.state`、`openclaw.reason`）
- `openclaw.session.stuck`（計數器，屬性：`openclaw.state`）
- `openclaw.session.stuck_age_ms`（直方圖，屬性：`openclaw.state`）
- `openclaw.run.attempt`（計數器，屬性：`openclaw.attempt`）

### 匯出追蹤（名稱 + 主要屬性）

- `openclaw.model.usage`
  - `openclaw.channel`、`openclaw.provider`、`openclaw.model`
  - `openclaw.sessionKey`、`openclaw.sessionId`
  - `openclaw.tokens.*`（輸入/輸出/快取讀取/快取寫入/總計）
- `openclaw.webhook.processed`
  - `openclaw.channel`、`openclaw.webhook`、`openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`、`openclaw.webhook`、`openclaw.chatId`、`openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`、`openclaw.outcome`、`openclaw.chatId`、`openclaw.messageId`、`openclaw.sessionKey`、`openclaw.sessionId`、`openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`、`openclaw.ageMs`、`openclaw.queueDepth`、`openclaw.sessionKey`、`openclaw.sessionId`

### 取樣與刷新

- 追蹤取樣：`diagnostics.otel.sampleRate`（0.0–1.0，僅根追蹤）
- 指標匯出間隔：`diagnostics.otel.flushIntervalMs`（最小 1000 毫秒）

### 協定說明

- OTLP/HTTP 端點可透過 `diagnostics.otel.endpoint` 或 `OTEL_EXPORTER_OTLP_ENDPOINT` 設定。
- 若端點已包含 `/v1/traces` 或 `/v1/metrics`，則直接使用該端點。
- 若端點已包含 `/v1/logs`，則直接用於日誌。
- `diagnostics.otel.logs` 啟用 OTLP 日誌匯出，針對主要 logger 輸出。

### 日誌匯出行為

- OTLP 日誌使用相同的結構化紀錄，寫入 `logging.file`。
- 遵守 `logging.level`（檔案日誌等級）。主控台遮蔽不適用於 OTLP 日誌。
- 高流量安裝建議使用 OTLP collector 取樣/過濾。

## 疑難排解技巧

- **無法連接 Gateway？** 請先執行 `openclaw doctor`。
- **日誌為空？** 請確認 Gateway 是否正在執行，且有寫入 `logging.file` 中指定的檔案路徑。
- **需要更多細節？** 將 `logging.level` 設為 `debug` 或 `trace`，然後重試。
