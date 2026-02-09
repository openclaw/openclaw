---
summary: "Tài liệu tham chiếu CLI cho `openclaw cron` (lên lịch và chạy các tác vụ nền)"
read_when:
  - Bạn cần các tác vụ theo lịch và đánh thức
  - Bạn đang gỡ lỗi việc thực thi cron và nhật ký
title: "cron"
---

# `openclaw cron`

Quản lý các tác vụ cron cho bộ lập lịch của Gateway.

Liên quan:

- Tác vụ cron: [Cron jobs](/automation/cron-jobs)

Mẹo: chạy `openclaw cron --help` để xem đầy đủ bề mặt lệnh.

Lưu ý: các job `cron add` độc lập mặc định gửi với `--announce`. Dùng `--no-deliver` để giữ
đầu ra ở nội bộ. `--deliver` vẫn được giữ như một alias đã bị ngưng dùng cho `--announce`.

Lưu ý: các job một lần (`--at`) mặc định sẽ bị xóa sau khi thành công. Dùng `--keep-after-run` để giữ chúng lại.

Lưu ý: các tác vụ định kỳ hiện dùng cơ chế lùi thử lại theo hàm mũ sau các lỗi liên tiếp (30s → 1m → 5m → 15m → 60m), sau đó quay lại lịch bình thường sau lần chạy thành công tiếp theo.

## Chỉnh sửa thường gặp

Cập nhật cài đặt phân phối mà không thay đổi thông điệp:

```bash
openclaw cron edit <job-id> --announce --channel telegram --to "123456789"
```

Tắt phân phối cho một tác vụ cô lập:

```bash
openclaw cron edit <job-id> --no-deliver
```

Thông báo tới một kênh cụ thể:

```bash
openclaw cron edit <job-id> --announce --channel slack --to "channel:C1234567890"
```
