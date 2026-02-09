---
summary: "Tham chiếu CLI cho `openclaw configure` (các lời nhắc cấu hình tương tác)"
read_when:
  - Bạn muốn tinh chỉnh thông tin xác thực, thiết bị hoặc mặc định của tác tử theo cách tương tác
title: "configure"
---

# `openclaw configure`

Lời nhắc tương tác để thiết lập thông tin xác thực, thiết bị và các mặc định của tác tử.

Lưu ý: Phần **Model** hiện bao gồm lựa chọn nhiều mục cho danh sách cho phép `agents.defaults.models` (những gì hiển thị trong `/model` và bộ chọn mô hình).

Mẹo: `openclaw config` không kèm subcommand sẽ mở cùng trình hướng dẫn. Dùng
`openclaw config get|set|unset` cho các chỉnh sửa không tương tác.

Liên quan:

- Tham chiếu cấu hình Gateway: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

Ghi chú:

- Việc chọn nơi Gateway chạy luôn cập nhật `gateway.mode`. You can select "Continue" without other sections if that is all you need.
- Các dịch vụ hướng kênh (Slack/Discord/Matrix/Microsoft Teams) sẽ hỏi danh sách cho phép kênh/phòng trong quá trình thiết lập. Bạn có thể nhập tên hoặc ID; trình hướng dẫn sẽ phân giải tên sang ID khi có thể.

## Ví dụ

```bash
openclaw configure
openclaw configure --section models --section channels
```
