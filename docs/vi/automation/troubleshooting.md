---
summary: "Xử lý sự cố lập lịch và gửi cron và heartbeat"
read_when:
  - Cron không chạy
  - Cron đã chạy nhưng không có thông báo nào được gửi
  - Heartbeat có vẻ im lặng hoặc bị bỏ qua
title: "Xử lý sự cố Tự động hóa"
---

# Xử lý sự cố tự động hóa

Sử dụng trang này cho các vấn đề về bộ lập lịch và gửi (`cron` + `heartbeat`).

## Thang lệnh

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Sau đó chạy các kiểm tra tự động hóa:

```bash
openclaw cron status
openclaw cron list
openclaw system heartbeat last
```

## Cron không kích hoạt

```bash
openclaw cron status
openclaw cron list
openclaw cron runs --id <jobId> --limit 20
openclaw logs --follow
```

Đầu ra tốt trông như sau:

- `cron status` báo cáo đã bật và có `nextWakeAtMs` trong tương lai.
- Job được bật và có lịch/múi giờ hợp lệ.
- `cron runs` hiển thị `ok` hoặc lý do bỏ qua rõ ràng.

Dấu hiệu thường gặp:

- `cron: scheduler disabled; jobs will not run automatically` → cron bị tắt trong cấu hình/biến môi trường.
- `cron: timer tick failed` → nhịp bộ lập lịch bị lỗi; kiểm tra ngữ cảnh stack/log xung quanh.
- `reason: not-due` trong đầu ra chạy → chạy thủ công được gọi mà không có `--force` và job chưa đến hạn.

## Cron đã chạy nhưng không có gửi

```bash
openclaw cron runs --id <jobId> --limit 20
openclaw cron list
openclaw channels status --probe
openclaw logs --follow
```

Đầu ra tốt trông như sau:

- Trạng thái chạy là `ok`.
- Chế độ/đích gửi được thiết lập cho các job cô lập.
- Kiểm tra kênh báo cáo kênh đích đã kết nối.

Dấu hiệu thường gặp:

- Chạy thành công nhưng chế độ gửi là `none` → không mong đợi có thông báo bên ngoài.
- Thiếu/không hợp lệ đích gửi (`channel`/`to`) → chạy có thể thành công nội bộ nhưng bỏ qua gửi ra ngoài.
- Lỗi xác thực kênh (`unauthorized`, `missing_scope`, `Forbidden`) → gửi bị chặn bởi thông tin xác thực/quyền của kênh.

## Heartbeat bị chặn hoặc bỏ qua

```bash
openclaw system heartbeat last
openclaw logs --follow
openclaw config get agents.defaults.heartbeat
openclaw channels status --probe
```

Đầu ra tốt trông như sau:

- Heartbeat được bật với khoảng thời gian khác 0.
- Kết quả heartbeat gần nhất là `ran` (hoặc lý do bỏ qua đã được hiểu rõ).

Dấu hiệu thường gặp:

- `heartbeat skipped` với `reason=quiet-hours` → nằm ngoài `activeHours`.
- `requests-in-flight` → luồng chính bận; heartbeat bị hoãn.
- `empty-heartbeat-file` → `HEARTBEAT.md` tồn tại nhưng không có nội dung có thể hành động.
- `alerts-disabled` → cài đặt hiển thị chặn các thông báo heartbeat gửi ra ngoài.

## Những điểm dễ sai về múi giờ và activeHours

```bash
openclaw config get agents.defaults.heartbeat.activeHours
openclaw config get agents.defaults.heartbeat.activeHours.timezone
openclaw config get agents.defaults.userTimezone || echo "agents.defaults.userTimezone not set"
openclaw cron list
openclaw logs --follow
```

Quy tắc nhanh:

- `Config path not found: agents.defaults.userTimezone` nghĩa là khóa chưa được đặt; heartbeat quay về múi giờ của máy chủ (hoặc `activeHours.timezone` nếu được đặt).
- Cron không có `--tz` sẽ dùng múi giờ của máy chủ gateway.
- `activeHours` của heartbeat dùng phân giải múi giờ đã cấu hình (`user`, `local`, hoặc IANA tz tường minh).
- Dấu thời gian ISO không có múi giờ được coi là UTC cho các lịch cron `at`.

Dấu hiệu thường gặp:

- Job chạy sai thời điểm theo đồng hồ sau khi múi giờ máy chủ thay đổi.
- Heartbeat luôn bị bỏ qua vào ban ngày của bạn vì `activeHours.timezone` sai.

Liên quan:

- [/automation/cron-jobs](/automation/cron-jobs)
- [/gateway/heartbeat](/gateway/heartbeat)
- [/automation/cron-vs-heartbeat](/automation/cron-vs-heartbeat)
- [/concepts/timezone](/concepts/timezone)
