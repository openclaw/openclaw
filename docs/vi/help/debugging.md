---
summary: "Công cụ gỡ lỗi: chế độ theo dõi, luồng mô hình thô và truy vết rò rỉ lập luận"
read_when:
  - Bạn cần kiểm tra đầu ra mô hình thô để phát hiện rò rỉ lập luận
  - Bạn muốn chạy Gateway ở chế độ theo dõi khi lặp lại chỉnh sửa
  - Bạn cần một quy trình gỡ lỗi có thể lặp lại
title: "Gỡ lỗi"
---

# Gỡ lỗi

Trang này bao gồm các trợ giúp gỡ lỗi cho đầu ra dạng luồng, đặc biệt khi một
nhà cung cấp trộn lập luận vào văn bản thông thường.

## Ghi đè gỡ lỗi lúc chạy

Use `/debug` in chat to set **runtime-only** config overrides (memory, not disk).
`/debug` is disabled by default; enable with `commands.debug: true`.
This is handy when you need to toggle obscure settings without editing `openclaw.json`.

Ví dụ:

```
/debug show
/debug set messages.responsePrefix="[openclaw]"
/debug unset messages.responsePrefix
/debug reset
```

`/debug reset` xóa tất cả ghi đè và quay lại cấu hình trên đĩa.

## Chế độ theo dõi của Gateway

Để lặp nhanh, chạy gateway dưới trình theo dõi tệp:

```bash
pnpm gateway:watch --force
```

Ánh xạ tương đương:

```bash
tsx watch src/entry.ts gateway --force
```

Thêm bất kỳ cờ CLI của gateway sau `gateway:watch` và chúng sẽ được truyền qua
mỗi lần khởi động lại.

## Hồ sơ dev + gateway dev (--dev)

Use the dev profile to isolate state and spin up a safe, disposable setup for
debugging. There are **two** `--dev` flags:

- **`--dev` toàn cục (hồ sơ):** cô lập trạng thái dưới `~/.openclaw-dev` và
  mặc định cổng gateway là `19001` (các cổng dẫn xuất thay đổi theo).
- **`gateway --dev`: yêu cầu Gateway tự tạo cấu hình + workspace mặc định**
  khi thiếu (và bỏ qua BOOTSTRAP.md).

Luồng khuyến nghị (hồ sơ dev + bootstrap dev):

```bash
pnpm gateway:dev
OPENCLAW_PROFILE=dev openclaw tui
```

Nếu bạn chưa cài đặt toàn cục, hãy chạy CLI qua `pnpm openclaw ...`.

Việc này thực hiện:

1. **Cô lập hồ sơ** (`--dev` toàn cục)
   - `OPENCLAW_PROFILE=dev`
   - `OPENCLAW_STATE_DIR=~/.openclaw-dev`
   - `OPENCLAW_CONFIG_PATH=~/.openclaw-dev/openclaw.json`
   - `OPENCLAW_GATEWAY_PORT=19001` (trình duyệt/canvas dịch chuyển tương ứng)

2. **Bootstrap dev** (`gateway --dev`)
   - Ghi cấu hình tối thiểu nếu thiếu (`gateway.mode=local`, bind local loopback).
   - Đặt `agent.workspace` trỏ tới workspace dev.
   - Đặt `agent.skipBootstrap=true` (không dùng BOOTSTRAP.md).
   - Gieo các tệp workspace nếu thiếu:
     `AGENTS.md`, `SOUL.md`, `TOOLS.md`, `IDENTITY.md`, `USER.md`, `HEARTBEAT.md`.
   - Danh tính mặc định: **C3‑PO** (droid giao thức).
   - Bỏ qua các nhà cung cấp kênh ở chế độ dev (`OPENCLAW_SKIP_CHANNELS=1`).

Luồng đặt lại (khởi đầu mới):

```bash
pnpm gateway:dev:reset
```

Note: `--dev` is a **global** profile flag and gets eaten by some runners.
42. Nếu bạn cần viết rõ ràng, hãy dùng dạng biến môi trường:

```bash
OPENCLAW_PROFILE=dev openclaw gateway --dev --reset
```

`--reset` xóa cấu hình, thông tin xác thực, phiên và workspace dev (dùng
`trash`, không phải `rm`), rồi tạo lại thiết lập dev mặc định.

Mẹo: nếu một gateway không phải dev đang chạy sẵn (launchd/systemd), hãy dừng nó trước:

```bash
openclaw gateway stop
```

## Ghi log luồng thô (OpenClaw)

OpenClaw can log the **raw assistant stream** before any filtering/formatting.
This is the best way to see whether reasoning is arriving as plain text deltas
(or as separate thinking blocks).

Bật qua CLI:

```bash
pnpm gateway:watch --force --raw-stream
```

Ghi đè đường dẫn (tùy chọn):

```bash
pnpm gateway:watch --force --raw-stream --raw-stream-path ~/.openclaw/logs/raw-stream.jsonl
```

Biến môi trường tương đương:

```bash
OPENCLAW_RAW_STREAM=1
OPENCLAW_RAW_STREAM_PATH=~/.openclaw/logs/raw-stream.jsonl
```

Tệp mặc định:

`~/.openclaw/logs/raw-stream.jsonl`

## Ghi log chunk thô (pi-mono)

Để bắt **các chunk tương thích OpenAI thô** trước khi chúng được phân tích thành các khối,
pi-mono cung cấp một logger riêng:

```bash
PI_RAW_STREAM=1
```

Đường dẫn tùy chọn:

```bash
PI_RAW_STREAM_PATH=~/.pi-mono/logs/raw-openai-completions.jsonl
```

Tệp mặc định:

`~/.pi-mono/logs/raw-openai-completions.jsonl`

> Lưu ý: chỉ được phát ra bởi các tiến trình dùng nhà cung cấp
> `openai-completions` của pi-mono.

## Ghi chú an toàn

- Log luồng thô có thể bao gồm prompt đầy đủ, đầu ra công cụ và dữ liệu người dùng.
- Giữ log cục bộ và xóa sau khi gỡ lỗi.
- Nếu chia sẻ log, hãy loại bỏ bí mật và PII trước.
