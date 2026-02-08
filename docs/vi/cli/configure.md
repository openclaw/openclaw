---
summary: "Tham chiếu CLI cho `openclaw configure` (các lời nhắc cấu hình tương tác)"
read_when:
  - Bạn muốn tinh chỉnh thông tin xác thực, thiết bị hoặc mặc định của tác tử theo cách tương tác
title: "configure"
x-i18n:
  source_path: cli/configure.md
  source_hash: 9cb2bb5237b02b3a
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:19Z
---

# `openclaw configure`

Lời nhắc tương tác để thiết lập thông tin xác thực, thiết bị và các mặc định của tác tử.

Lưu ý: Phần **Model** hiện bao gồm lựa chọn nhiều mục cho danh sách cho phép `agents.defaults.models` (những gì hiển thị trong `/model` và bộ chọn mô hình).

Mẹo: `openclaw config` không kèm theo lệnh con sẽ mở cùng trình hướng dẫn. Dùng
`openclaw config get|set|unset` cho các chỉnh sửa không tương tác.

Liên quan:

- Tham chiếu cấu hình Gateway: [Configuration](/gateway/configuration)
- Config CLI: [Config](/cli/config)

Ghi chú:

- Việc chọn nơi Gateway chạy luôn cập nhật `gateway.mode`. Bạn có thể chọn "Continue" mà không cần các phần khác nếu đó là tất cả những gì bạn cần.
- Các dịch vụ theo hướng kênh (Slack/Discord/Matrix/Microsoft Teams) sẽ yêu cầu danh sách cho phép kênh/phòng trong quá trình thiết lập. Bạn có thể nhập tên hoặc ID; trình hướng dẫn sẽ phân giải tên sang ID khi có thể.

## Ví dụ

```bash
openclaw configure
openclaw configure --section models --section channels
```
