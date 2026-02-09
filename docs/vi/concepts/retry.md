---
summary: "Chính sách retry cho các cuộc gọi nhà cung cấp outbound"
read_when:
  - Cập nhật hành vi hoặc mặc định retry của nhà cung cấp
  - Gỡ lỗi lỗi gửi hoặc giới hạn tốc độ của nhà cung cấp
title: "Chính sách Retry"
---

# Chính sách retry

## Mục tiêu

- Retry theo từng yêu cầu HTTP, không theo luồng nhiều bước.
- Giữ thứ tự bằng cách chỉ retry bước hiện tại.
- Tránh nhân bản các thao tác không idempotent.

## Mặc định

- Số lần thử: 3
- Giới hạn độ trễ tối đa: 30000 ms
- Jitter: 0.1 (10 phần trăm)
- Mặc định theo nhà cung cấp:
  - Telegram độ trễ tối thiểu: 400 ms
  - Discord độ trễ tối thiểu: 500 ms

## Hành vi

### Discord

- Chỉ retry khi có lỗi giới hạn tốc độ (HTTP 429).
- Sử dụng `retry_after` khi có, nếu không thì dùng exponential backoff.

### Telegram

- Retry khi gặp lỗi tạm thời (429, timeout, connect/reset/closed, tạm thời không khả dụng).
- Sử dụng `retry_after` khi có, nếu không thì dùng exponential backoff.
- Lỗi phân tích Markdown sẽ không được retry; sẽ fallback sang văn bản thuần.

## Cấu hình

Thiết lập chính sách retry theo từng nhà cung cấp trong `~/.openclaw/openclaw.json`:

```json5
{
  channels: {
    telegram: {
      retry: {
        attempts: 3,
        minDelayMs: 400,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
    discord: {
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

## Ghi chú

- Retry áp dụng theo từng yêu cầu (gửi tin nhắn, tải lên media, reaction, poll, sticker).
- Các luồng tổng hợp sẽ không retry những bước đã hoàn thành.
