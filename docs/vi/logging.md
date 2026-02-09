---
summary: "Tổng quan về logging: log tệp, đầu ra console, theo dõi bằng CLI, và Control UI"
read_when:
  - Bạn cần một cái nhìn tổng quan về logging thân thiện cho người mới
  - Bạn muốn cấu hình mức log hoặc định dạng
  - Bạn đang xử lý sự cố và cần tìm log nhanh
title: "Logging"
---

# Logging

OpenClaw ghi log ở hai nơi:

- **Log tệp** (dòng JSON) do Gateway ghi.
- **Đầu ra console** hiển thị trong terminal và Control UI.

Trang này giải thích log nằm ở đâu, cách đọc chúng, và cách cấu hình mức log
cũng như định dạng.

## Log nằm ở đâu

Theo mặc định, Gateway ghi một tệp log xoay vòng tại:

`/tmp/openclaw/openclaw-YYYY-MM-DD.log`

Ngày giờ sử dụng múi giờ cục bộ của máy chủ gateway.

Bạn có thể ghi đè điều này trong `~/.openclaw/openclaw.json`:

```json
{
  "logging": {
    "file": "/path/to/openclaw.log"
  }
}
```

## Cách đọc log

### CLI: theo dõi trực tiếp (khuyến nghị)

Dùng CLI để tail tệp log của gateway qua RPC:

```bash
openclaw logs --follow
```

Chế độ đầu ra:

- **Phiên TTY**: dòng log có cấu trúc, đẹp, có màu.
- **Phiên không phải TTY**: văn bản thuần.
- `--json`: JSON phân tách theo dòng (mỗi dòng là một sự kiện log).
- `--plain`: buộc văn bản thuần trong phiên TTY.
- `--no-color`: tắt màu ANSI.

Ở chế độ JSON, CLI phát ra các đối tượng được gắn thẻ `type`:

- `meta`: metadata của luồng (tệp, con trỏ, kích thước)
- `log`: mục log đã được phân tích
- `notice`: gợi ý cắt ngắn / xoay vòng
- `raw`: dòng log chưa được phân tích

Nếu Gateway không thể truy cập, CLI sẽ in ra gợi ý ngắn để chạy:

```bash
openclaw doctor
```

### Control UI (web)

The Control UI’s **Logs** tab tails the same file using `logs.tail`.
See [/web/control-ui](/web/control-ui) for how to open it.

### Log chỉ theo kênh

Để lọc hoạt động theo kênh (WhatsApp/Telegram/etc), dùng:

```bash
openclaw channels logs --channel whatsapp
```

## Định dạng log

### Log tệp (JSONL)

Each line in the log file is a JSON object. The CLI and Control UI parse these
entries to render structured output (time, level, subsystem, message).

### Đầu ra console

Log console **nhận biết TTY** và được định dạng để dễ đọc:

- Tiền tố phân hệ (ví dụ: `gateway/channels/whatsapp`)
- Tô màu theo mức (info/warn/error)
- Chế độ gọn hoặc JSON tùy chọn

Định dạng console được điều khiển bởi `logging.consoleStyle`.

## Cấu hình logging

Tất cả cấu hình logging nằm dưới `logging` trong `~/.openclaw/openclaw.json`.

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

### Mức log

- `logging.level`: mức **log tệp** (JSONL).
- `logging.consoleLevel`: mức độ chi tiết của **console**.

`--verbose` chỉ ảnh hưởng đến đầu ra console; không thay đổi mức log của tệp.

### Kiểu console

`logging.consoleStyle`:

- `pretty`: thân thiện cho con người, có màu, kèm dấu thời gian.
- `compact`: đầu ra gọn hơn (tốt cho phiên dài).
- `json`: JSON theo dòng (cho bộ xử lý log).

### Che dữ liệu nhạy cảm (Redaction)

Tóm tắt công cụ có thể che token nhạy cảm trước khi ra console:

- `logging.redactSensitive`: `off` | `tools` (mặc định: `tools`)
- `logging.redactPatterns`: danh sách chuỗi regex để ghi đè tập mặc định

Che dữ liệu chỉ ảnh hưởng đến **đầu ra console** và không thay đổi log tệp.

## Chẩn đoán + OpenTelemetry

Diagnostics are structured, machine-readable events for model runs **and**
message-flow telemetry (webhooks, queueing, session state). They do **not**
replace logs; they exist to feed metrics, traces, and other exporters.

Sự kiện chẩn đoán được phát trong tiến trình, nhưng exporter chỉ gắn khi bật
chẩn đoán + plugin exporter.

### OpenTelemetry vs OTLP

- **OpenTelemetry (OTel)**: mô hình dữ liệu + SDK cho traces, metrics và logs.
- **OTLP**: giao thức truyền dùng để xuất dữ liệu OTel tới collector/backend.
- OpenClaw hiện xuất qua **OTLP/HTTP (protobuf)**.

### Tín hiệu được xuất

- **Metrics**: counter + histogram (mức sử dụng token, luồng thông điệp, xếp hàng).
- **Traces**: span cho việc dùng mô hình + xử lý webhook/thông điệp.
- **Logs**: exported over OTLP when `diagnostics.otel.logs` is enabled. Log
  volume can be high; keep `logging.level` and exporter filters in mind.

### Danh mục sự kiện chẩn đoán

Sử dụng mô hình:

- `model.usage`: token, chi phí, thời lượng, ngữ cảnh, nhà cung cấp/mô hình/kênh, id phiên.

Luồng thông điệp:

- `webhook.received`: webhook vào theo từng kênh.
- `webhook.processed`: webhook được xử lý + thời lượng.
- `webhook.error`: lỗi bộ xử lý webhook.
- `message.queued`: thông điệp được đưa vào hàng đợi xử lý.
- `message.processed`: kết quả + thời lượng + lỗi tùy chọn.

Hàng đợi + phiên:

- `queue.lane.enqueue`: enqueue làn hàng đợi lệnh + độ sâu.
- `queue.lane.dequeue`: dequeue làn hàng đợi lệnh + thời gian chờ.
- `session.state`: chuyển trạng thái phiên + lý do.
- `session.stuck`: cảnh báo phiên bị kẹt + tuổi.
- `run.attempt`: metadata retry/lần thử chạy.
- `diagnostic.heartbeat`: bộ đếm tổng hợp (webhook/hàng đợi/phiên).

### Bật chẩn đoán (không exporter)

Dùng khi bạn muốn các sự kiện chẩn đoán sẵn sàng cho plugin hoặc sink tùy chỉnh:

```json
{
  "diagnostics": {
    "enabled": true
  }
}
```

### Cờ chẩn đoán (log theo mục tiêu)

Use flags to turn on extra, targeted debug logs without raising `logging.level`.
Flags are case-insensitive and support wildcards (e.g. `telegram.*` or `*`).

```json
{
  "diagnostics": {
    "flags": ["telegram.http"]
  }
}
```

Ghi đè bằng env (dùng một lần):

```
OPENCLAW_DIAGNOSTICS=telegram.http,telegram.payload
```

Ghi chú:

- Log theo cờ đi vào tệp log tiêu chuẩn (giống `logging.file`).
- Đầu ra vẫn được che dữ liệu theo `logging.redactSensitive`.
- Hướng dẫn đầy đủ: [/diagnostics/flags](/diagnostics/flags).

### Xuất sang OpenTelemetry

Diagnostics can be exported via the `diagnostics-otel` plugin (OTLP/HTTP). This
works with any OpenTelemetry collector/backend that accepts OTLP/HTTP.

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

Ghi chú:

- Bạn cũng có thể bật plugin bằng `openclaw plugins enable diagnostics-otel`.
- `protocol` currently supports `http/protobuf` only. `grpc` is ignored.
- Metrics bao gồm mức sử dụng token, chi phí, kích thước ngữ cảnh, thời lượng chạy, và
  các counter/histogram của luồng thông điệp (webhook, xếp hàng, trạng thái phiên, độ sâu/thời gian chờ hàng đợi).
- Traces/metrics can be toggled with `traces` / `metrics` (default: on). Traces
  include model usage spans plus webhook/message processing spans when enabled.
- Đặt `headers` khi collector của bạn yêu cầu xác thực.
- Biến môi trường được hỗ trợ: `OTEL_EXPORTER_OTLP_ENDPOINT`,
  `OTEL_SERVICE_NAME`, `OTEL_EXPORTER_OTLP_PROTOCOL`.

### Metrics được xuất (tên + loại)

Sử dụng mô hình:

- `openclaw.tokens` (counter, attrs: `openclaw.token`, `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.cost.usd` (counter, attrs: `openclaw.channel`, `openclaw.provider`,
  `openclaw.model`)
- `openclaw.run.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.provider`, `openclaw.model`)
- `openclaw.context.tokens` (histogram, attrs: `openclaw.context`,
  `openclaw.channel`, `openclaw.provider`, `openclaw.model`)

Luồng thông điệp:

- `openclaw.webhook.received` (counter, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.error` (counter, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.webhook.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.webhook`)
- `openclaw.message.queued` (counter, attrs: `openclaw.channel`,
  `openclaw.source`)
- `openclaw.message.processed` (counter, attrs: `openclaw.channel`,
  `openclaw.outcome`)
- `openclaw.message.duration_ms` (histogram, attrs: `openclaw.channel`,
  `openclaw.outcome`)

Hàng đợi + phiên:

- `openclaw.queue.lane.enqueue` (counter, attrs: `openclaw.lane`)
- `openclaw.queue.lane.dequeue` (counter, attrs: `openclaw.lane`)
- `openclaw.queue.depth` (histogram, attrs: `openclaw.lane` hoặc
  `openclaw.channel=heartbeat`)
- `openclaw.queue.wait_ms` (histogram, attrs: `openclaw.lane`)
- `openclaw.session.state` (counter, attrs: `openclaw.state`, `openclaw.reason`)
- `openclaw.session.stuck` (counter, attrs: `openclaw.state`)
- `openclaw.session.stuck_age_ms` (histogram, attrs: `openclaw.state`)
- `openclaw.run.attempt` (counter, attrs: `openclaw.attempt`)

### Span được xuất (tên + thuộc tính chính)

- `openclaw.model.usage`
  - `openclaw.channel`, `openclaw.provider`, `openclaw.model`
  - `openclaw.sessionKey`, `openclaw.sessionId`
  - `openclaw.tokens.*` (input/output/cache_read/cache_write/total)
- `openclaw.webhook.processed`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`
- `openclaw.webhook.error`
  - `openclaw.channel`, `openclaw.webhook`, `openclaw.chatId`,
    `openclaw.error`
- `openclaw.message.processed`
  - `openclaw.channel`, `openclaw.outcome`, `openclaw.chatId`,
    `openclaw.messageId`, `openclaw.sessionKey`, `openclaw.sessionId`,
    `openclaw.reason`
- `openclaw.session.stuck`
  - `openclaw.state`, `openclaw.ageMs`, `openclaw.queueDepth`,
    `openclaw.sessionKey`, `openclaw.sessionId`

### Lấy mẫu + flush

- Lấy mẫu trace: `diagnostics.otel.sampleRate` (0.0–1.0, chỉ span gốc).
- Khoảng thời gian xuất metric: `diagnostics.otel.flushIntervalMs` (tối thiểu 1000ms).

### Ghi chú về giao thức

- Endpoint OTLP/HTTP có thể đặt qua `diagnostics.otel.endpoint` hoặc
  `OTEL_EXPORTER_OTLP_ENDPOINT`.
- Nếu endpoint đã chứa `/v1/traces` hoặc `/v1/metrics`, sẽ dùng nguyên trạng.
- Nếu endpoint đã chứa `/v1/logs`, sẽ dùng nguyên trạng cho logs.
- `diagnostics.otel.logs` bật xuất log OTLP cho đầu ra logger chính.

### Hành vi xuất log

- Log OTLP dùng cùng các bản ghi có cấu trúc được ghi vào `logging.file`.
- Respect `logging.level` (file log level). Console redaction does **not** apply
  to OTLP logs.
- Các cài đặt lưu lượng cao nên ưu tiên lấy mẫu/lọc tại OTLP collector.

## Mẹo xử lý sự cố

- **Gateway không truy cập được?** Chạy `openclaw doctor` trước.
- **Log trống?** Kiểm tra Gateway đang chạy và ghi vào đường dẫn tệp
  trong `logging.file`.
- **Cần nhiều chi tiết hơn?** Đặt `logging.level` thành `debug` hoặc `trace` rồi thử lại.
