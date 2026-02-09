---
summary: "Xử lý ngày và giờ trên các envelope, prompt, công cụ và connector"
read_when:
  - Bạn đang thay đổi cách hiển thị dấu thời gian cho mô hình hoặc người dùng
  - Bạn đang gỡ lỗi định dạng thời gian trong tin nhắn hoặc đầu ra system prompt
title: "Ngày và Giờ"
---

# Ngày & Giờ

Dấu thời gian của nhà cung cấp được giữ nguyên để các công cụ giữ ngữ nghĩa gốc của chúng (thời gian hiện tại khả dụng qua `session_status`).
`timeFormat` kiểm soát **hiển thị 12h/24h** trong prompt.

## Message envelope (mặc định là local)

Tin nhắn đến được bao bọc với một dấu thời gian (độ chính xác theo phút):

```
[Provider ... 2026-01-05 16:26 PST] message text
```

Dấu thời gian của envelope này **mặc định là thời gian cục bộ của máy chủ**, bất kể múi giờ của nhà cung cấp.

Bạn có thể ghi đè hành vi này:

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
- `envelopeTimezone: "local"` sử dụng múi giờ của máy chủ.
- `envelopeTimezone: "user"` sử dụng `agents.defaults.userTimezone` (dự phòng về múi giờ máy chủ).
- Dùng múi giờ IANA cụ thể (ví dụ: `"America/Chicago"`) cho một vùng cố định.
- `envelopeTimestamp: "off"` loại bỏ dấu thời gian tuyệt đối khỏi header của envelope.
- `envelopeElapsed: "off"` loại bỏ hậu tố thời gian đã trôi qua (kiểu `+2m`).

### Ví dụ

**Local (mặc định):**

```
[WhatsApp +1555 2026-01-18 00:19 PST] hello
```

**Múi giờ người dùng:**

```
[WhatsApp +1555 2026-01-18 00:19 CST] hello
```

**Bật thời gian đã trôi qua:**

```
[WhatsApp +1555 +30s 2026-01-18T05:19Z] follow-up
```

## System prompt: Ngày & Giờ hiện tại

Nếu biết múi giờ của người dùng, system prompt sẽ bao gồm một mục riêng
**Ngày & Giờ hiện tại** chỉ với **múi giờ** (không có đồng hồ/định dạng giờ)
để giữ cho việc cache prompt ổn định:

```
Time zone: America/Chicago
```

Khi tác tử cần thời gian hiện tại, hãy dùng công cụ `session_status`; thẻ trạng thái
sẽ bao gồm một dòng dấu thời gian.

## Dòng sự kiện hệ thống (mặc định là local)

Các sự kiện hệ thống được xếp hàng và chèn vào ngữ cảnh của tác tử sẽ được
tiền tố bằng một dấu thời gian, sử dụng cùng lựa chọn múi giờ như message envelope
(mặc định: thời gian cục bộ của máy chủ).

```
System: [2026-01-12 12:19:17 PST] Model switched.
```

### Cấu hình múi giờ + định dạng cho người dùng

```json5
{
  agents: {
    defaults: {
      userTimezone: "America/Chicago",
      timeFormat: "auto", // auto | 12 | 24
    },
  },
}
```

- `userTimezone` đặt **múi giờ cục bộ của người dùng** cho ngữ cảnh prompt.
- `auto` tuân theo tùy chọn của hệ điều hành. Khi `timeFormat: "auto"`, OpenClaw kiểm tra tùy chọn hệ điều hành (macOS/Windows)
  và quay về định dạng theo locale.

## Phát hiện định dạng thời gian (tự động)

Giá trị được phát hiện được **lưu đệm theo từng tiến trình**
để tránh các lời gọi hệ thống lặp lại. Điều này bắt đầu sau khi chuyển các script dev từ Bun sang `tsx` (commit `2871657e`, 2026-01-06).

## Payload công cụ + connector (thời gian thô từ nhà cung cấp + trường chuẩn hóa)

Các công cụ theo kênh trả về **dấu thời gian gốc của nhà cung cấp** và thêm các trường
chuẩn hóa để đảm bảo tính nhất quán:

- `timestampMs`: mili giây epoch (UTC)
- `timestampUtc`: chuỗi ISO 8601 UTC

Các trường thô từ nhà cung cấp được giữ nguyên để không mất thông tin.

- Slack: chuỗi dạng epoch từ API
- Discord: dấu thời gian ISO UTC
- Telegram/WhatsApp: dấu thời gian số hoặc ISO theo từng nhà cung cấp

Nếu bạn cần thời gian local, hãy chuyển đổi ở bước downstream bằng múi giờ đã biết.

## Tài liệu liên quan

- [System Prompt](/concepts/system-prompt)
- [Timezones](/concepts/timezone)
- [Messages](/concepts/messages)
