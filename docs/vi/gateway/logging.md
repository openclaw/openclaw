---
summary: "Các bề mặt ghi log, log tệp, kiểu log WS và định dạng console"
read_when:
  - Thay đổi đầu ra hoặc định dạng ghi log
  - Gỡ lỗi đầu ra CLI hoặc gateway
title: "Ghi log"
---

# Ghi log

Để xem tổng quan hướng tới người dùng (CLI + Control UI + cấu hình), xem [/logging](/logging).

OpenClaw có hai “bề mặt” log:

- **Đầu ra console** (những gì bạn thấy trong terminal / Debug UI).
- **Log tệp** (các dòng JSON) do bộ ghi log của gateway ghi ra.

## Bộ ghi log dựa trên tệp

- Tệp log cuộn mặc định nằm dưới `/tmp/openclaw/` (mỗi ngày một tệp): `openclaw-YYYY-MM-DD.log`
  - Ngày sử dụng múi giờ cục bộ của máy chủ gateway.
- Đường dẫn tệp log và mức log có thể cấu hình qua `~/.openclaw/openclaw.json`:
  - `logging.file`
  - `logging.level`

Định dạng tệp là mỗi dòng một đối tượng JSON.

Tab Logs của Control UI theo dõi (tail) tệp này qua gateway (`logs.tail`).
8. CLI cũng có thể làm điều tương tự:

```bash
openclaw logs --follow
```

**Verbose so với mức log**

- **Log tệp** được điều khiển độc quyền bởi `logging.level`.
- `--verbose` chỉ ảnh hưởng đến **độ chi tiết của console** (và kiểu log WS); nó **không**
  nâng mức log của tệp.
- Để ghi lại các chi tiết chỉ có ở verbose vào log tệp, hãy đặt `logging.level` thành `debug` hoặc
  `trace`.

## Bắt console

CLI bắt `console.log/info/warn/error/debug/trace` và ghi chúng vào log tệp,
đồng thời vẫn in ra stdout/stderr.

Bạn có thể tinh chỉnh độ chi tiết của console một cách độc lập qua:

- `logging.consoleLevel` (mặc định `info`)
- `logging.consoleStyle` (`pretty` | `compact` | `json`)

## Che thông tin tóm tắt của công cụ

Tóm tắt công cụ chi tiết (ví dụ: `🛠️ Exec: ...`) có thể che các token nhạy cảm trước khi chúng xuất hiện trên
luồng console. Điều này là **chỉ cho tools** và không thay đổi log file.

- `logging.redactSensitive`: `off` | `tools` (mặc định: `tools`)
- `logging.redactPatterns`: mảng các chuỗi regex (ghi đè mặc định)
  - Dùng chuỗi regex thô (tự động `gi`), hoặc `/pattern/flags` nếu bạn cần cờ tùy chỉnh.
  - Các khớp sẽ được che bằng cách giữ 6 ký tự đầu + 4 ký tự cuối (độ dài >= 18), nếu không thì `***`.
  - Mặc định bao phủ các gán khóa phổ biến, cờ CLI, trường JSON, header bearer, khối PEM và các tiền tố token phổ biến.

## Log WebSocket của Gateway

Gateway in log giao thức WebSocket theo hai chế độ:

- **Chế độ thường (không có `--verbose`)**: chỉ in các kết quả RPC “đáng chú ý”:
  - lỗi (`ok=false`)
  - các lời gọi chậm (ngưỡng mặc định: `>= 50ms`)
  - lỗi phân tích
- **Chế độ verbose (`--verbose`)**: in toàn bộ lưu lượng yêu cầu/phản hồi WS.

### Kiểu log WS

`openclaw gateway` hỗ trợ chuyển kiểu theo từng gateway:

- `--ws-log auto` (mặc định): chế độ thường được tối ưu; chế độ verbose dùng đầu ra gọn
- `--ws-log compact`: đầu ra gọn (ghép cặp yêu cầu/phản hồi) khi verbose
- `--ws-log full`: đầu ra đầy đủ theo từng frame khi verbose
- `--compact`: bí danh cho `--ws-log compact`

Ví dụ:

```bash
# optimized (only errors/slow)
openclaw gateway

# show all WS traffic (paired)
openclaw gateway --verbose --ws-log compact

# show all WS traffic (full meta)
openclaw gateway --verbose --ws-log full
```

## Định dạng console (ghi log theo hệ thống con)

Bộ định dạng console **nhận biết TTY** và in các dòng nhất quán, có tiền tố.
Logger theo phân hệ giữ đầu ra được nhóm và dễ quét.

Hành vi:

- **Tiền tố hệ thống con** trên mỗi dòng (ví dụ: `[gateway]`, `[canvas]`, `[tailscale]`)
- **Màu theo hệ thống con** (ổn định theo từng hệ thống con) cộng với màu theo mức log
- **Có màu khi đầu ra là TTY hoặc môi trường trông như terminal phong phú** (`TERM`/`COLORTERM`/`TERM_PROGRAM`), tôn trọng `NO_COLOR`
- **Rút gọn tiền tố hệ thống con**: bỏ `gateway/` + `channels/` ở đầu, giữ 2 phân đoạn cuối (ví dụ: `whatsapp/outbound`)
- **Bộ ghi log con theo hệ thống con** (tự động thêm tiền tố + trường có cấu trúc `{ subsystem }`)
- **`logRaw()`** cho đầu ra QR/UX (không tiền tố, không định dạng)
- **Kiểu console** (ví dụ: `pretty | compact | json`)
- **Mức log console** tách biệt với mức log tệp (tệp vẫn giữ đầy đủ chi tiết khi `logging.level` được đặt thành `debug`/`trace`)
- **Nội dung tin nhắn WhatsApp** được ghi log ở mức `debug` (dùng `--verbose` để xem)

Điều này giữ cho log tệp hiện có ổn định trong khi làm cho đầu ra tương tác dễ quét hơn.
