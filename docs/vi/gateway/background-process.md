---
summary: "Thực thi exec nền và quản lý tiến trình"
read_when:
  - Thêm hoặc chỉnh sửa hành vi exec nền
  - Gỡ lỗi các tác vụ exec chạy lâu
title: "Công cụ Exec Nền và Tiến trình"
---

# Công cụ Exec Nền + Tiến trình

Công cụ `process` quản lý các session nền đó. Công cụ `process` quản lý các phiên chạy nền đó.

## công cụ exec

Tham số chính:

- `command` (bắt buộc)
- `yieldMs` (mặc định 10000): tự động chuyển sang nền sau độ trễ này
- `background` (bool): chạy nền ngay lập tức
- `timeout` (giây, mặc định 1800): kết thúc tiến trình sau thời gian chờ này
- `elevated` (bool): chạy trên host nếu chế độ nâng quyền được bật/cho phép
- Đặt `pty: true`. Khi spawn các child process chạy dài bên ngoài các công cụ exec/process (ví dụ: CLI respawn hoặc helper gateway), hãy gắn helper bridge cho child-process để các tín hiệu kết thúc được chuyển tiếp và các listener được gỡ khi thoát/lỗi.
- `workdir`, `env`

Hành vi:

- Chạy tiền cảnh trả về đầu ra trực tiếp.
- Khi chạy nền (tường minh hoặc do hết thời gian), công cụ trả về `status: "running"` + `sessionId` và một đoạn đuôi ngắn.
- Đầu ra được giữ trong bộ nhớ cho đến khi phiên được thăm dò hoặc bị xóa.
- Nếu công cụ `process` không được cho phép, `exec` chạy đồng bộ và bỏ qua `yieldMs`/`background`.

## Cầu nối tiến trình con

Khi sinh các tiến trình con chạy lâu bên ngoài các công cụ exec/process (ví dụ: CLI tự khởi chạy lại hoặc helper của gateway), hãy gắn helper cầu nối tiến trình con để các tín hiệu kết thúc được chuyển tiếp và các listener được tháo gỡ khi thoát/lỗi. Điều này tránh các tiến trình mồ côi trên systemd và giữ hành vi tắt máy nhất quán trên các nền tảng.

Ghi đè biến môi trường:

- `PI_BASH_YIELD_MS`: yield mặc định (ms)
- `PI_BASH_MAX_OUTPUT_CHARS`: giới hạn đầu ra trong bộ nhớ (ký tự)
- `OPENCLAW_BASH_PENDING_MAX_OUTPUT_CHARS`: giới hạn stdout/stderr đang chờ theo từng luồng (ký tự)
- `PI_BASH_JOB_TTL_MS`: TTL cho các phiên đã hoàn tất (ms, giới hạn trong 1m–3h)

Cấu hình (khuyến nghị):

- `tools.exec.backgroundMs` (mặc định 10000)
- `tools.exec.timeoutSec` (mặc định 1800)
- `tools.exec.cleanupMs` (mặc định 1800000)
- `tools.exec.notifyOnExit` (mặc định true): đưa một sự kiện hệ thống vào hàng đợi + yêu cầu heartbeat khi một exec chạy nền kết thúc.

## công cụ process

Hành động:

- `list`: các phiên đang chạy + đã hoàn tất
- `poll`: rút đầu ra mới cho một phiên (cũng báo trạng thái thoát)
- `log`: đọc đầu ra tổng hợp (hỗ trợ `offset` + `limit`)
- `write`: gửi stdin (`data`, tùy chọn `eof`)
- `kill`: kết thúc một phiên chạy nền
- `clear`: xóa một phiên đã hoàn tất khỏi bộ nhớ
- `remove`: nếu đang chạy thì kill, nếu đã hoàn tất thì xóa

Ghi chú:

- Chỉ các phiên chạy nền mới được liệt kê/lưu trong bộ nhớ.
- Các phiên bị mất khi tiến trình khởi động lại (không lưu trên đĩa).
- Log phiên chỉ được lưu vào lịch sử chat nếu bạn chạy `process poll/log` và kết quả công cụ được ghi lại.
- `process` được phạm vi theo từng tác tử; nó chỉ thấy các phiên do tác tử đó khởi tạo.
- `process list` bao gồm một `name` dẫn xuất (động từ lệnh + mục tiêu) để quét nhanh.
- `process log` dùng `offset`/`limit` theo dòng (bỏ `offset` để lấy N dòng cuối).

## Ví dụ

Chạy một tác vụ dài và thăm dò sau:

```json
{ "tool": "exec", "command": "sleep 5 && echo done", "yieldMs": 1000 }
```

```json
{ "tool": "process", "action": "poll", "sessionId": "<id>" }
```

Bắt đầu chạy nền ngay lập tức:

```json
{ "tool": "exec", "command": "npm run build", "background": true }
```

Gửi stdin:

```json
{ "tool": "process", "action": "write", "sessionId": "<id>", "data": "y\n" }
```
