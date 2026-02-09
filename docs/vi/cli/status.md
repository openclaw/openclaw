---
summary: "Tham chiếu CLI cho `openclaw status` (chẩn đoán, thăm dò, ảnh chụp nhanh cách dùng)"
read_when:
  - Bạn muốn chẩn đoán nhanh tình trạng kênh + người nhận phiên gần đây
  - Bạn muốn một trạng thái “all” có thể dán để gỡ lỗi
title: "status"
---

# `openclaw status`

Chẩn đoán cho các kênh + phiên.

```bash
openclaw status
openclaw status --all
openclaw status --deep
openclaw status --usage
```

Ghi chú:

- `--deep` chạy các phép thăm dò trực tiếp (WhatsApp Web + Telegram + Discord + Google Chat + Slack + Signal).
- Đầu ra bao gồm các kho phiên theo từng tác tử khi cấu hình nhiều tác tử.
- Tổng quan bao gồm trạng thái cài đặt/chạy của Gateway + dịch vụ máy chủ node khi khả dụng.
- Tổng quan bao gồm kênh cập nhật + git SHA (đối với bản checkout từ mã nguồn).
- Thông tin cập nhật xuất hiện trong phần Tổng quan; nếu có bản cập nhật, trạng thái sẽ in gợi ý chạy `openclaw update` (xem [Updating](/install/updating)).
