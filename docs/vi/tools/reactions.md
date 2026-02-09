---
summary: "Ngữ nghĩa reaction dùng chung giữa các kênh"
read_when:
  - Làm việc với reactions ở bất kỳ kênh nào
title: "Reactions"
---

# Công cụ reaction

Ngữ nghĩa reaction dùng chung giữa các kênh:

- `emoji` là bắt buộc khi thêm một reaction.
- `emoji=""` gỡ reaction của bot khi được hỗ trợ.
- `remove: true` gỡ emoji được chỉ định khi được hỗ trợ (yêu cầu `emoji`).

Ghi chú theo kênh:

- **Discord/Slack**: `emoji` trống sẽ gỡ tất cả reaction của bot trên tin nhắn; `remove: true` chỉ gỡ emoji đó.
- **Google Chat**: `emoji` trống sẽ gỡ các reaction của ứng dụng trên tin nhắn; `remove: true` chỉ gỡ emoji đó.
- **Telegram**: `emoji` trống sẽ gỡ các reaction của bot; `remove: true` cũng gỡ reaction nhưng vẫn yêu cầu `emoji` không trống để xác thực công cụ.
- **WhatsApp**: `emoji` trống sẽ gỡ reaction của bot; `remove: true` ánh xạ thành emoji trống (vẫn yêu cầu `emoji`).
- **Signal**: thông báo reaction đến sẽ phát ra sự kiện hệ thống khi `channels.signal.reactionNotifications` được bật.
