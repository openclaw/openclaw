---
summary: "日誌總覽：檔案日誌、主控台輸出、CLI 追蹤和 Control UI"
read_when:
  - 您需要日誌的入門指南
  - 您想要設定日誌等級或格式
  - 您正在進行疑難排解，需要快速找到日誌
title: "日誌記錄"
---

# 日誌記錄

OpenClaw 將日誌記錄在兩個位置：

- 由 Gateway 寫入的**檔案日誌** (JSON 行)。
- 在終端機和 Control UI 中顯示的**主控台輸出**。

本頁說明日誌的儲存位置、如何讀取日誌，以及如何設定日誌等級和格式。

## 日誌的儲存位置

預設情況下，Gateway 會在以下路徑寫入輪替的日誌檔案：

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

日期使用 Gateway 主機的當地時區。

您可以在 `~/.openclaw/openclaw.json` 中覆寫此設定：

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## 如何讀取日誌

### CLI：即時追蹤 (推薦)

使用 CLI 透過 RPC 追蹤 Gateway 日誌檔案：

```bash
openclaw logs --follow
```

輸出模式：

- **TTY 工作階段**：美觀、彩色、結構化的日誌行。
- **非 TTY 工作階段**：純文字。
- `--json`：行分隔的 JSON (每行一個日誌事件)。
- `--plain`：強制 TTY 工作階段為純文字。
- `--no-color`：停用 ANSI 顏色。

在 JSON 模式下，CLI 輸出 `type` 標記的物件：

- `meta`：串流中繼資料 (檔案、游標、大小)
- `log`：已解析的日誌條目
- `notice`：截斷 / 輪替提示
- `raw`：未解析的日誌行

如果 Gateway 無法連線，CLI 會列印一個簡短提示，指示執行：

```bash
openclaw doctor
```

### Control UI (網頁)

Control UI 的**日誌**分頁使用 `logs.tail` 追蹤相同的檔案。
請參閱 [/web/control-ui](/web/control-ui) 了解如何開啟它。

### 僅限頻道日誌

若要篩選頻道活動 (WhatsApp/Telegram/等)，請使用：

```bash
openclaw channels logs --channel whatsapp
```

## 日誌格式

### 檔案日誌 (JSONL)

日誌檔案中的每一行都是一個 JSON 物件。CLI 和 Control UI 會解析這些條目以呈現結構化輸出 (時間、等級、子系統、訊息)。

### 主控台輸出

主控台日誌**支援 TTY** 並格式化以提高可讀性：

- 子系統前綴 (例如 `gateway/channels/whatsapp`)
- 等級著色 (資訊/警告/錯誤)
- 可選的精簡模式或 JSON 模式

主控台格式由 `logging.consoleStyle` 控制。

## 設定日誌記錄

所有日誌記錄設定都位於 `~/.openclaw/openclaw.json` 中的 `logging` 下。

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

- `logging.level`：**檔案日誌** (JSONL) 等級。
- `logging.consoleLevel`：**主控台**詳細程度等級。

`--verbose` 僅影響主控台輸出；它不會更改檔案日誌等級。

### 主控台樣式

`logging.consoleStyle`：

- `pretty`：人性化、彩色，帶有時間戳記。
- `compact`：更緊湊的輸出 (最適合長時間工作階段)。
- `json`：每行 JSON (用於日誌處理器)。

### 編輯

智慧代理摘要可以在敏感憑證傳到主控台之前進行編輯：

- `logging.redactSensitive`：`off` | `tools` (預設值：`tools`)
- `logging.redactPatterns`：用於覆寫預設集合的正規表示式字串清單

編輯僅影響**主控台輸出**，不會更改檔案日誌。

## 診斷 + OpenTelemetry

診斷是結構化、機器可讀的事件，用於模型執行**和**訊息流遙測 (webhooks、佇列、工作階段狀態)。它們不**會**取代日誌；它們的存在是為了提供指標、追蹤和其他匯出工具。

診斷事件在程序內發出，但只有在診斷 + 匯出工具外掛程式啟用時，匯出工具才會附加。

### OpenTelemetry vs OTLP

- **OpenTelemetry (OTel)**：用於追蹤、指標和日誌的資料模型 + SDK。
- **OTLP**：用於將 OTel 資料匯出到收集器/後端時使用的連線協定。
- OpenClaw 目前透過 **OTLP/HTTP (protobuf)** 匯出。

### 匯出的訊號

- **指標**：計數器 + 長條圖 (令牌使用量、訊息流、佇列)。
- **追蹤**：用於模型使用 + webhook/訊息處理的範圍。
- **日誌**：當 `diagnostics.otel.logs` 啟用時，透過 OTLP 匯出。日誌量可能很高；請記住 `logging.level` 和匯出工具篩選條件。

### 診斷事件目錄

模型使用：

- `model.usage`：令牌、成本、持續時間、上下文、供應商/模型/頻道、工作階段 ID。

訊息流：

- `webhook.received`：每個頻道的 webhook 接收。
- `webhook.processed`：webhook 處理 + 持續時間。
- `webhook.error`：webhook 處理程式錯誤。
- `message.queued`：訊息排入佇列等待處理。
- `message.processed`：結果 + 持續時間 + 可選錯誤。

佇列 + 工作階段：

- `queue.lane.enqueue`：命令佇列線道排入佇列 + 深度。
- `queue.lane.dequeue`：命令佇列線道出佇列 + 等待時間。
- `session.state`：工作階段狀態轉換 + 原因。
- `session.stuck`：工作階段卡住警告 + 時間。
- `run.attempt`：執行重試/嘗試中繼資料。
- `diagnostic.heartbeat`：聚合計數器 (webhooks/佇列/工作階段)。

### 啟用診斷 (無匯出工具)

如果您希望診斷事件可供外掛程式或自訂接收器使用，請使用此項：

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### 診斷旗標 (目標日誌)

使用旗標開啟額外的、有針對性的偵錯日誌，而無需提高 `logging.level`。旗標不區分大小寫，並支援萬用字元 (例如 `telegram.*` 或 `*`)。

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

環境變數覆寫 (一次性)：

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

注意事項：

- 旗標日誌會傳送到標準日誌檔案 (與 `logging.file` 相同)。
- 輸出仍會根據 `logging.redactSensitive` 進行編輯。
- 完整指南：[/diagnostics/flags](/diagnostics/flags)。

### 匯出到 OpenTelemetry

診斷可以透過 `diagnostics-otel` 外掛程式 (OTLP/HTTP) 匯出。這適用於任何接受 OTLP/HTTP 的 OpenTelemetry 收集器/後端。

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

- 您也可以使用 `openclaw plugins enable diagnostics-otel` 啟用外掛程式。
- `protocol` 目前僅支援 `http/protobuf`。`grpc` 會被忽略。
- 指標包括令牌使用量、成本、上下文大小、執行持續時間，以及訊息流計數器/長條圖 (webhooks、佇列、工作階段狀態、佇列深度/等待時間)。
- 追蹤/指標可以透過 `traces` / `metrics` 進行切換 (預設值：啟用)。追蹤包括模型使用範圍以及啟用時的 webhook/訊息處理範圍。
- 當您的收集器需要驗證時，請設定 `headers`。
- 支援的環境變數：`OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_SERVICE_NAME`、`OTEL_EXPORTER_OTLP_PROTOCOL`。

### 匯出的指標 (名稱 + 類型)

模型使用：

- `openclaw.tokens` (計數器，屬性：`openclaw.token`、`openclaw.channel`、
  `openclaw.provider`、`openclaw.model`)
- `openclaw.cost.usd` (計數器，屬性：`openclaw.channel`、`openclaw.provider`、
  `openclaw.model`)
- `openclaw.run.duration_ms` (長條圖，屬性：`openclaw.channel`、
  `openclaw.provider`、`openclaw.model`)
- `openclaw.context.tokens` (長條圖，屬性：`openclaw.context`、
  `openclaw.channel`、`openclaw.provider`、`openclaw.model`)

訊息流：

- `openclaw.webhook.received` (計數器，屬性：`openclaw.channel`、
  `openclaw.webhook`)
- `openclaw.webhook.error` (計數器，屬性：`openclaw.channel`、
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (長條圖，屬性：`openclaw.channel`、
  `openclaw.webhook`)
- `openclaw.message.queued` (計數器，屬性：`openclaw.channel`、
  `openclaw.source`)
- `openclaw.message.processed` (計數器，屬性：`openclaw.channel`、
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (長條圖，屬性：`openclaw.channel`、
  `openclaw.outcome`)

佇列 + 工作階段：

- `openclaw.queue.lane.enqueue` (計數器，屬性：`openclaw.lane`)
- `openclaw.queue.lane.dequeue` (計數器，屬性：`openclaw.lane`)
- `openclaw.queue.depth` (長條圖，屬性：`openclaw.lane` 或
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (長條圖，屬性：`openclaw.lane`)
- `openclaw.session.state` (計數器，屬性：`openclaw.state`、`openclaw.reason`)
- `openclaw.session.stuck` (計數器，屬性：`openclaw.state`)
- `openclaw.session.stuck_age_ms` (長條圖，屬性：`openclaw.state`)
- `openclaw.run.attempt` (計數器，屬性：`openclaw.attempt`)

### 匯出的範圍 (名稱 + 主要屬性)

- `openclaw.model.usage`
  - `openclaw.channel`、`openclaw.provider`、`openclaw.model`
  - `openclaw.sessionKey`、`openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`、`openclaw.webhook`、`openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`、`openclaw.webhook`、`openclaw.chatId`、
    `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`、`openclaw.outcome`、`openclaw.chatId`、
    `openclaw.messageId`、`openclaw.sessionKey`、`openclaw.sessionId`、
    `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`、`openclaw.ageMs`、`openclaw.queueDepth`、
    `openclaw.sessionKey`、`openclaw.sessionId`

### 採樣 + 刷新

- 追蹤採樣：`diagnostics.otel.sampleRate` (0.0–1.0，僅限根範圍)。
- 指標匯出間隔：`diagnostics.otel.flushIntervalMs` (最小 1000ms)。

### 協定注意事項

- OTLP/HTTP 端點可以透過 `diagnostics.otel.endpoint` 或
  `OTEL_EXPORTER_OTLP_ENDPOINT` 設定。
- 如果端點已包含 `/v1/traces` 或 `/v1/metrics`，則按原樣使用。
- 如果端點已包含 `/v1/logs`，則按原樣用於日誌。
- `diagnostics.otel.logs` 啟用主要日誌輸出用的 OTLP 日誌匯出。

### 日誌匯出行為

- OTLP 日誌使用寫入 `logging.file` 的相同結構化記錄。
- 遵循 `logging.level` (檔案日誌等級)。主控台編輯**不**適用於 OTLP 日誌。
- 高流量安裝應優先使用 OTLP 收集器採樣/篩選。

## 疑難排解提示

- **Gateway 無法連線？** 請先執行 `openclaw doctor`。
- **日誌空白？** 檢查 Gateway 是否正在執行並寫入 `logging.file` 中的檔案路徑。
- **需要更多詳細資訊？** 將 `logging.level` 設定為 `debug` 或 `trace` 並重試。
