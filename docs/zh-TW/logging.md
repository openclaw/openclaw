---
summary: "紀錄概覽：檔案紀錄、主控台輸出、CLI 即時追蹤以及 Control UI"
read_when:
  - 你需要適合初學者的紀錄概覽
  - 你想要設定紀錄等級或格式
  - 你正在進行疑難排解並需要快速找到紀錄
title: "紀錄"
---

# 紀錄

OpenClaw 會在兩個地方記錄：

- **檔案紀錄** (JSON lines)：由 Gateway 寫入。
- **主控台輸出**：在終端機和 Control UI 顯示。

本頁面說明紀錄的存放位置、讀取方式，以及如何設定紀錄等級和格式。

## 紀錄存放位置

預設情況下，Gateway 會將滾動紀錄檔寫入：

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

日期使用 Gateway 主機的在地時區。

你可以在 `~/.openclaw/openclaw.json` 中覆寫此設定：

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## 如何讀取紀錄

### CLI：即時追蹤 (建議使用)

使用 CLI 透過 RPC 即時追蹤 Gateway 紀錄檔：

```bash
openclaw logs --follow
```

輸出模式：

- **TTY 工作階段**：美化、上色且結構化的紀錄行。
- **非 TTY 工作階段**：純文字。
- `--json`：每行一個 JSON 物件 (每行一個紀錄事件)。
- `--plain`：在 TTY 工作階段強制使用純文字。
- `--no-color`：停用 ANSI 顏色。

在 JSON 模式下，CLI 會發出帶有 `type` 標籤的物件：

- `meta`：串流詮釋資料 (檔案、游標、大小)
- `log`：已解析的紀錄項目
- `notice`：截斷 / 輪替提示
- `raw`：未解析的紀錄行

如果無法連接 Gateway，CLI 會顯示短暫提示以執行：

```bash
openclaw doctor
```

### Control UI (網頁)

Control UI 的 **Logs** 分頁使用 `logs.tail` 追蹤相同的檔案。
請參閱 [/web/control-ui](/web/control-ui) 了解如何開啟。

### 僅限頻道的紀錄

若要篩選特定頻道的活動 (WhatsApp/Telegram 等)，請使用：

```bash
openclaw channels logs --channel whatsapp
```

## 紀錄格式

### 檔案紀錄 (JSONL)

紀錄檔中的每一行都是一個 JSON 物件。CLI 和 Control UI 會解析這些項目，以呈現結構化的輸出 (時間、等級、子系統、訊息)。

### 主控台輸出

主控台紀錄具備 **TTY 感知** 能力，並針對可讀性進行格式化：

- 子系統前綴 (例如 `gateway/channels/whatsapp`)
- 等級顏色 (info/warn/error)
- 選用的精簡 (compact) 或 JSON 模式

主控台格式由 `logging.consoleStyle` 控制。

## 設定紀錄

所有紀錄設定都位於 `~/.openclaw/openclaw.json` 中的 `logging` 下。

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

### 紀錄等級

- `logging.level`：**檔案紀錄** (JSONL) 等級。
- `logging.consoleLevel`：**主控台** 詳細等級。

`--verbose` 僅影響主控台輸出，不會改變檔案紀錄等級。

### 主控台樣式

`logging.consoleStyle`：

- `pretty`：人類友好、上色且帶有時間戳記。
- `compact`：較緊湊的輸出 (最適合長時間的工作階段)。
- `json`：每行一個 JSON (供紀錄處理器使用)。

### 內容遮蔽

工具摘要可以在顯示到主控台之前遮蔽敏感權杖 (token)：

- `logging.redactSensitive`：`off` | `tools` (預設值：`tools`)
- `logging.redactPatterns`：用於覆寫預設集合的正則表達式字串清單

內容遮蔽僅影響 **主控台輸出**，不會更改檔案紀錄。

## 診斷 + OpenTelemetry

診斷是用於模型執行 **以及** 訊息流遙測 (Webhook、排程、工作階段狀態) 的結構化、機器可讀事件。它們 **不會** 取代紀錄；其存在是為了提供給指標 (metrics)、追蹤 (traces) 和其他匯出器使用。

診斷事件在程序內發出，但只有在啟用診斷和匯出器插件時，匯出器才會連接。

### OpenTelemetry vs OTLP

- **OpenTelemetry (OTel)**：追蹤、指標和紀錄的資料模型與 SDK。
- **OTLP**：用於將 OTel 資料匯出到收集器 / 後端的傳輸協定。
- OpenClaw 目前透過 **OTLP/HTTP (protobuf)** 匯出。

### 匯出的訊號

- **指標 (Metrics)**：計數器 + 直方圖 (權杖使用量、訊息流、排程)。
- **追蹤 (Traces)**：模型使用量 + Webhook/訊息處理的 Span。
- **紀錄 (Logs)**：啟用 `diagnostics.otel.logs` 時透過 OTLP 匯出。紀錄量可能很大；請留意 `logging.level` 和匯出器篩選器。

### 診斷事件目錄

模型使用：

- `model.usage`：權杖、成本、時長、上下文、供應商/模型/頻道、工作階段 ID。

訊息流：

- `webhook.received`：每個頻道的 Webhook 入口。
- `webhook.processed`：Webhook 處理完成 + 時長。
- `webhook.error`：Webhook 處理器錯誤。
- `message.queued`：訊息進入佇列等待處理。
- `message.processed`：結果 + 時長 + 選用的錯誤。

佇列 + 工作階段：

- `queue.lane.enqueue`：命令佇列通道進入佇列 + 深度。
- `queue.lane.dequeue`：命令佇列通道離開佇列 + 等待時間。
- `session.state`：工作階段狀態轉換 + 原因。
- `session.stuck`：工作階段卡住警告 + 持續時間。
- `run.attempt`：執行重試 / 嘗試的詮釋資料。
- `diagnostic.heartbeat`：聚合計數器 (Webhook/佇列/工作階段)。

### 啟用診斷 (無匯出器)

如果你希望診斷事件可供插件或自定義接收端 (sink) 使用，請使用此設定：

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### 診斷標記 (目標紀錄)

使用標記開啟特定的偵錯紀錄，而無需提高 `logging.level`。標記不區分大小寫，且支援萬用字元 (例如 `telegram.*` 或 `*`)。

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

注意：

- 標記紀錄會寫入標準紀錄檔 (與 `logging.file` 相同)。
- 輸出仍會根據 `logging.redactSensitive` 進行遮蔽。
- 完整指南：[/diagnostics/flags](/diagnostics/flags)。

### 匯出到 OpenTelemetry

診斷可以透過 `diagnostics-otel` 插件 (OTLP/HTTP) 匯出。這適用於任何接受 OTLP/HTTP 的 OpenTelemetry 收集器 / 後端。

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

注意：

- 你也可以使用 `openclaw plugins enable diagnostics-otel` 啟用插件。
- `protocol` 目前僅支援 `http/protobuf`。`grpc` 會被忽略。
- 指標包含權杖使用量、成本、上下文大小、執行時長，以及訊息流計數器 / 直方圖 (Webhook、排程、工作階段狀態、佇列深度 / 等待時間)。
- 可以透過 `traces` / `metrics` 切換開關 (預設：開啟)。啟用後，追蹤包含模型使用 Span 以及 Webhook/訊息處理 Span。
- 當你的收集器需要認證時，請設定 `headers`。
- 支援的環境變數：`OTEL_EXPORTER_OTLP_ENDPOINT`、`OTEL_SERVICE_NAME`、`OTEL_EXPORTER_OTLP_PROTOCOL`。

### 匯出的指標 (名稱 + 類型)

模型使用：

- `openclaw.tokens` (計數器，屬性：`openclaw.token`, `openclaw.channel`, `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (計數器，屬性：`openclaw.channel`, `openclaw.provider`, `openclaw.model`)
- `openclaw.run.duration_ms` (直方圖，屬性：`openclaw.channel`, `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (直方圖，屬性：`openclaw.context`, `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

訊息流：

- `openclaw.webhook.received` (計數器，屬性：`openclaw.channel`, `openclaw.webhook`)
- `openclaw.webhook.error` (計數器，屬性：`openclaw.channel`, `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (直方圖，屬性：`openclaw.channel`, `openclaw.webhook`)
- `openclaw.message.queued` (計數器，屬性：`openclaw.channel`, `openclaw.source`)
- `openclaw.message.processed` (計數器，屬性：`openclaw.channel`, `openclaw.outcome`)
- `openclaw.message.duration_ms` (直方圖，屬性：`openclaw.channel`, `openclaw.outcome`)

佇列 + 工作階段：

- `openclaw.queue.lane.enqueue` (計數器，屬性：`openclaw.lane`)
- `openclaw.queue.lane.dequeue` (計數器，屬性：`openclaw.lane`)
- `openclaw.queue.depth` (直方圖，屬性：`openclaw.lane` 或 `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (直方圖，屬性：`openclaw.lane`)
- `openclaw.session.state` (計數器，屬性：`openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (計數器，屬性：`openclaw.state`)
- `openclaw.session.stuck_age_ms` (直方圖，屬性：`openclaw.state`)
- `openclaw.run.attempt` (計數器，屬性：`openclaw.attempt`)

### 匯出的 Span (名稱 + 關鍵屬性)

- `openclaw.model.usage`
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`
  - `openclaw.sessionKey`, `openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`, `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`, `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`, `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`, `openclaw.sessionKey`, `openclaw.sessionId`

### 取樣 + 排清

- 追蹤取樣：`diagnostics.otel.sampleRate` (0.0–1.0，僅限根 Span)。
- 指標匯出間隔：`diagnostics.otel.flushIntervalMs` (最少 1000ms)。

### 協定說明

- OTLP/HTTP 端點可以透過 `diagnostics.otel.endpoint` 或 `OTEL_EXPORTER_OTLP_ENDPOINT` 設定。
- 如果端點已經包含 `/v1/traces` 或 `/v1/metrics`，則會原樣使用。
- 如果端點已經包含 `/v1/logs`，則會將其用於紀錄。
- `diagnostics.otel.logs` 為主要記錄器輸出啟用 OTLP 紀錄匯出。

### 紀錄匯出行為

- OTLP 紀錄使用與 `logging.file` 相同的結構化紀錄。
- 遵循 `logging.level` (檔案紀錄等級)。主控台內容遮蔽 **不適用** 於 OTLP 紀錄。
- 高流量的安裝建議優先使用 OTLP 收集器的取樣 / 篩選功能。

## 疑難排解技巧

- **無法連接 Gateway？** 請先執行 `openclaw doctor`。
- **紀錄是空的？** 請檢查 Gateway 是否正在執行，並正在寫入 `logging.file` 中的檔案路徑。
- **需要更多細節？** 將 `logging.level` 設定為 `debug` 或 `trace` 並重試。
