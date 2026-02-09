---
summary: "Xử lý múi giờ cho tác tử, phong bì, và prompt"
read_when:
  - Bạn cần hiểu cách dấu thời gian được chuẩn hóa cho mô hình
  - Cấu hình múi giờ người dùng cho system prompt
title: "Múi giờ"
---

# Múi giờ

OpenClaw chuẩn hóa dấu thời gian để mô hình nhìn thấy **một thời điểm tham chiếu duy nhất**.

## Phong bì tin nhắn (mặc định theo giờ cục bộ)

Tin nhắn đến được bọc trong một phong bì như:

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Dấu thời gian trong phong bì **mặc định theo giờ cục bộ của máy chủ**, với độ chính xác đến phút.

Bạn có thể ghi đè bằng:

```json5
{
  agents: {
    defaults: {
      envelopeTimezone: "local", // "utc" | "local" | "user" | IANA timezone
      envelopeTimestamp: "on", // "on" | "off"
      envelopeElapsed: "on", // "on" | "off"
    },
  },
}
```

- `envelopeTimezone: "utc"` sử dụng UTC.
- `envelopeTimezone: "user"` sử dụng `agents.defaults.userTimezone` (dự phòng về múi giờ máy chủ).
- Dùng múi giờ IANA tường minh (ví dụ: `"Europe/Vienna"`) để có offset cố định.
- `envelopeTimestamp: "off"` loại bỏ dấu thời gian tuyệt đối khỏi tiêu đề phong bì.
- `envelopeElapsed: "off"` loại bỏ hậu tố thời gian trôi qua (kiểu `+2m`).

### Ví dụ

**Cục bộ (mặc định):**

```
[Signal Alice +1555 2026-01-18 00:19 PST] hello
```

**Múi giờ cố định:**

```
[Signal Alice +1555 2026-01-18 06:19 GMT+1] hello
```

**Thời gian trôi qua:**

```
[Signal Alice +1555 +2m 2026-01-18T05:19Z] follow-up
```

## Payload của công cụ (dữ liệu thô từ nhà cung cấp + các trường đã chuẩn hóa)

Các lệnh gọi công cụ (`channels.discord.readMessages`, `channels.slack.readMessages`, v.v.) trả về **dấu thời gian thô của nhà cung cấp**.
Chúng tôi cũng đính kèm các trường đã được chuẩn hóa để đảm bảo tính nhất quán:

- `timestampMs` (epoch mili-giây UTC)
- `timestampUtc` (chuỗi ISO 8601 UTC)

Các trường thô từ nhà cung cấp được giữ nguyên.

## Múi giờ người dùng cho system prompt

Đặt `agents.defaults.userTimezone` để cho mô hình biết múi giờ địa phương của người dùng. Nếu nó
chưa được đặt, OpenClaw sẽ phân giải **múi giờ máy chủ tại thời điểm chạy** (không ghi cấu hình).

```json5
{
  agents: { defaults: { userTimezone: "America/Chicago" } },
}
```

System prompt bao gồm:

- phần `Current Date & Time` với thời gian cục bộ và múi giờ
- `Time format: 12-hour` hoặc `24-hour`

Bạn có thể kiểm soát định dạng prompt bằng `agents.defaults.timeFormat` (`auto` | `12` | `24`).

Xem [Date & Time](/date-time) để biết đầy đủ hành vi và ví dụ.
