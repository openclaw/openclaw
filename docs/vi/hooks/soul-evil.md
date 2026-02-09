---
summary: "Hook SOUL Evil (hoán đổi SOUL.md với SOUL_EVIL.md)"
read_when:
  - Bạn muốn bật hoặc tinh chỉnh hook SOUL Evil
  - Bạn muốn có cửa sổ purge hoặc hoán đổi persona theo xác suất ngẫu nhiên
title: "Hook SOUL Evil"
---

# Hook SOUL Evil

The SOUL Evil hook swaps the **injected** `SOUL.md` content with `SOUL_EVIL.md` during
a purge window or by random chance. một khoảng thời gian purge hoặc ngẫu nhiên.

## Cách hoạt động

When `agent:bootstrap` runs, the hook can replace the `SOUL.md` content in memory
before the system prompt is assembled. If `SOUL_EVIL.md` is missing or empty,
OpenClaw logs a warning and keeps the normal `SOUL.md`.

Các lần chạy sub-agent **không** bao gồm `SOUL.md` trong các tệp bootstrap của chúng, vì vậy hook này
không có tác dụng với sub-agent.

## Bật

```bash
openclaw hooks enable soul-evil
```

Sau đó đặt cấu hình:

```json
{
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "soul-evil": {
          "enabled": true,
          "file": "SOUL_EVIL.md",
          "chance": 0.1,
          "purge": { "at": "21:00", "duration": "15m" }
        }
      }
    }
  }
}
```

Tạo `SOUL_EVIL.md` trong thư mục gốc workspace của agent (bên cạnh `SOUL.md`).

## Tùy chọn

- `file` (string): tên tệp SOUL thay thế (mặc định: `SOUL_EVIL.md`)
- `chance` (number 0–1): xác suất ngẫu nhiên mỗi lần chạy để dùng `SOUL_EVIL.md`
- `purge.at` (HH:mm): thời điểm bắt đầu purge hằng ngày (định dạng 24 giờ)
- `purge.duration` (duration): độ dài cửa sổ (ví dụ: `30s`, `10m`, `1h`)

**Thứ tự ưu tiên:** cửa sổ purge ưu tiên hơn xác suất.

**Múi giờ:** dùng `agents.defaults.userTimezone` khi được đặt; nếu không thì dùng múi giờ của máy chủ.

## Ghi chú

- Không có tệp nào được ghi hoặc chỉnh sửa trên đĩa.
- Nếu `SOUL.md` không có trong danh sách bootstrap, hook sẽ không làm gì.

## Xem thêm

- [Hooks](/automation/hooks)
