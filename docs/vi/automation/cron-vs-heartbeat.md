---
summary: "Hướng dẫn lựa chọn giữa heartbeat và cron jobs cho tự động hóa"
read_when:
  - Quyết định cách lập lịch cho các tác vụ lặp lại
  - Thiết lập giám sát nền hoặc thông báo
  - Tối ưu hóa việc sử dụng token cho các kiểm tra định kỳ
title: "Cron vs Heartbeat"
---

# Cron vs Heartbeat: Khi nào nên dùng từng loại

Cả heartbeat và cron job đều cho phép bạn chạy tác vụ theo lịch. Hướng dẫn này giúp bạn chọn cơ chế phù hợp cho trường hợp sử dụng của mình.

## Hướng dẫn quyết định nhanh

| Trường hợp sử dụng                | Khuyến nghị                            | Lý do                                         |
| --------------------------------- | -------------------------------------- | --------------------------------------------- |
| Kiểm tra hộp thư mỗi 30 phút      | Heartbeat                              | Gộp với các kiểm tra khác, nhận biết ngữ cảnh |
| Gửi báo cáo hằng ngày đúng 9 giờ  | Cron (isolated)     | Cần thời điểm chính xác                       |
| Theo dõi lịch cho sự kiện sắp tới | Heartbeat                              | Phù hợp tự nhiên cho nhận biết định kỳ        |
| Chạy phân tích sâu hằng tuần      | Cron (isolated)     | Tác vụ độc lập, có thể dùng mô hình khác      |
| Nhắc tôi sau 20 phút              | Cron (main, `--at`) | Một lần, thời điểm chính xác                  |
| Kiểm tra sức khỏe dự án nền       | Heartbeat                              | Tận dụng chu kỳ hiện có                       |

## Heartbeat: Nhận biết định kỳ

Heartbeat chạy trong **phiên chính** theo một khoảng thời gian đều đặn (mặc định: 30 phút). Chúng được thiết kế để agent kiểm tra tình hình và đưa ra bất cứ điều gì quan trọng.

### Khi nào nên dùng heartbeat

- **Nhiều kiểm tra định kỳ**: Thay vì 5 cron jobs riêng lẻ kiểm tra hộp thư, lịch, thời tiết, thông báo và trạng thái dự án, một heartbeat có thể gộp tất cả.
- **Quyết định theo ngữ cảnh**: Tác tử có đầy đủ ngữ cảnh của main session, nên có thể quyết định thông minh việc nào khẩn cấp và việc nào có thể chờ.
- **Liên tục hội thoại**: Các lần chạy heartbeat dùng chung một phiên, nên tác tử nhớ các cuộc trò chuyện gần đây và theo dõi tự nhiên.
- **Giám sát chi phí thấp**: Một heartbeat thay thế nhiều tác vụ polling nhỏ.

### Ưu điểm của heartbeat

- **Gộp nhiều kiểm tra**: Một lượt của tác tử có thể xem hộp thư, lịch và thông báo cùng lúc.
- **Giảm số lần gọi API**: Một heartbeat rẻ hơn 5 cron jobs tách biệt.
- **Nhận biết ngữ cảnh**: Tác tử biết bạn đang làm gì và ưu tiên phù hợp.
- **Ẩn thông minh**: Nếu không có gì cần chú ý, tác tử trả lời `HEARTBEAT_OK` và không gửi thông báo nào.
- **Thời điểm tự nhiên**: Có thể trôi nhẹ theo tải hàng đợi, phù hợp cho hầu hết giám sát.

### Ví dụ heartbeat: danh sách kiểm HEARTBEAT.md

```md
# Heartbeat checklist

- Check email for urgent messages
- Review calendar for events in next 2 hours
- If a background task finished, summarize results
- If idle for 8+ hours, send a brief check-in
```

Tác tử đọc nội dung này ở mỗi heartbeat và xử lý tất cả mục trong một lượt.

### Cấu hình heartbeat

```json5
{
  agents: {
    defaults: {
      heartbeat: {
        every: "30m", // interval
        target: "last", // where to deliver alerts
        activeHours: { start: "08:00", end: "22:00" }, // optional
      },
    },
  },
}
```

Xem [Heartbeat](/gateway/heartbeat) để biết cấu hình đầy đủ.

## Cron: Lập lịch chính xác

Cron jobs chạy tại **thời điểm chính xác** và có thể chạy trong các phiên cô lập mà không ảnh hưởng đến ngữ cảnh chính.

### Khi nào nên dùng cron

- **Cần thời điểm chính xác**: "Gửi lúc 9:00 sáng mỗi thứ Hai" (không phải "khoảng 9 giờ").
- **Tác vụ độc lập**: Các tác vụ không cần ngữ cảnh hội thoại.
- **Mô hình/suy nghĩ khác**: Phân tích nặng cần mô hình mạnh hơn.
- **Nhắc việc một lần**: "Nhắc tôi sau 20 phút" với `--at`.
- **Tác vụ ồn/nhanh**: Những tác vụ sẽ làm lộn xộn lịch sử main session.
- **Kích hoạt bên ngoài**: Tác vụ cần chạy độc lập dù tác tử có đang hoạt động hay không.

### Ưu điểm của cron

- **Thời điểm chính xác**: Biểu thức cron 5 trường với hỗ trợ múi giờ.
- **Cô lập phiên**: Chạy trong `cron:<jobId>` mà không làm bẩn lịch sử chính.
- **Ghi đè mô hình**: Dùng mô hình rẻ hơn hoặc mạnh hơn cho từng job.
- **Kiểm soát phân phối**: Job cô lập mặc định là `announce` (tóm tắt); chọn `none` khi cần.
- **Gửi ngay**: Chế độ announce đăng trực tiếp, không chờ heartbeat.
- **Không cần ngữ cảnh tác tử**: Chạy ngay cả khi main session đang nhàn rỗi hoặc đã được nén.
- **Hỗ trợ một lần**: `--at` cho mốc thời gian tương lai chính xác.

### Ví dụ cron: Bản tin buổi sáng hằng ngày

```bash
openclaw cron add \
  --name "Morning briefing" \
  --cron "0 7 * * *" \
  --tz "America/New_York" \
  --session isolated \
  --message "Generate today's briefing: weather, calendar, top emails, news summary." \
  --model opus \
  --announce \
  --channel whatsapp \
  --to "+15551234567"
```

Chạy đúng 7:00 sáng theo giờ New York, dùng Opus để đảm bảo chất lượng, và thông báo tóm tắt trực tiếp tới WhatsApp.

### Ví dụ cron: Nhắc việc một lần

```bash
openclaw cron add \
  --name "Meeting reminder" \
  --at "20m" \
  --session main \
  --system-event "Reminder: standup meeting starts in 10 minutes." \
  --wake now \
  --delete-after-run
```

Xem [Cron jobs](/automation/cron-jobs) để biết tham chiếu CLI đầy đủ.

## Lưu đồ quyết định

```
Does the task need to run at an EXACT time?
  YES -> Use cron
  NO  -> Continue...

Does the task need isolation from main session?
  YES -> Use cron (isolated)
  NO  -> Continue...

Can this task be batched with other periodic checks?
  YES -> Use heartbeat (add to HEARTBEAT.md)
  NO  -> Use cron

Is this a one-shot reminder?
  YES -> Use cron with --at
  NO  -> Continue...

Does it need a different model or thinking level?
  YES -> Use cron (isolated) with --model/--thinking
  NO  -> Use heartbeat
```

## Kết hợp cả hai

Thiết lập hiệu quả nhất sử dụng **cả hai**:

1. **Heartbeat** xử lý giám sát thường xuyên (hộp thư, lịch, thông báo) trong một lượt gộp mỗi 30 phút.
2. **Cron** xử lý lịch chính xác (báo cáo hằng ngày, rà soát hằng tuần) và nhắc việc một lần.

### Ví dụ: Thiết lập tự động hóa hiệu quả

**HEARTBEAT.md** (kiểm tra mỗi 30 phút):

```md
# Heartbeat checklist

- Scan inbox for urgent emails
- Check calendar for events in next 2h
- Review any pending tasks
- Light check-in if quiet for 8+ hours
```

**Cron jobs** (thời điểm chính xác):

```bash
# Daily morning briefing at 7am
openclaw cron add --name "Morning brief" --cron "0 7 * * *" --session isolated --message "..." --announce

# Weekly project review on Mondays at 9am
openclaw cron add --name "Weekly review" --cron "0 9 * * 1" --session isolated --message "..." --model opus

# One-shot reminder
openclaw cron add --name "Call back" --at "2h" --session main --system-event "Call back the client" --wake now
```

## Lobster: Quy trình xác định với phê duyệt

Lobster là runtime quy trình làm việc cho **pipeline công cụ nhiều bước** cần thực thi mang tính quyết định và phê duyệt rõ ràng.
Hãy dùng nó khi tác vụ không chỉ là một lượt agent duy nhất, và bạn muốn một quy trình có thể tiếp tục lại với các điểm kiểm soát của con người.

### Khi Lobster phù hợp

- **Tự động hóa nhiều bước**: Bạn cần một pipeline gọi công cụ cố định, không phải prompt một lần.
- **Cổng phê duyệt**: Các tác động phụ nên tạm dừng cho đến khi bạn phê duyệt, rồi tiếp tục.
- **Chạy có thể tiếp tục**: Tiếp tục một quy trình đã tạm dừng mà không chạy lại các bước trước.

### Cách kết hợp với heartbeat và cron

- **Heartbeat/cron** quyết định _khi nào_ một lần chạy xảy ra.
- **Lobster** định nghĩa _những bước nào_ diễn ra khi lần chạy bắt đầu.

Đối với các quy trình làm việc theo lịch, hãy dùng cron hoặc heartbeat để kích hoạt một lượt agent gọi Lobster.
Đối với các quy trình làm việc ad-hoc, hãy gọi Lobster trực tiếp.

### Ghi chú vận hành (từ mã nguồn)

- Lobster chạy như một **tiến trình con cục bộ** (CLI `lobster`) ở chế độ tool và trả về **JSON envelope**.
- Nếu tool trả về `needs_approval`, bạn tiếp tục với `resumeToken` và cờ `approve`.
- Tool là **plugin tùy chọn**; bật theo cách bổ sung qua `tools.alsoAllow: ["lobster"]` (khuyến nghị).
- Nếu bạn truyền `lobsterPath`, nó phải là **đường dẫn tuyệt đối**.

Xem [Lobster](/tools/lobster) để biết cách dùng và ví dụ đầy đủ.

## Main Session vs Isolated Session

Cả heartbeat và cron đều có thể tương tác với main session, nhưng theo cách khác nhau:

|          | Heartbeat                    | Cron (main)                 | Cron (isolated)              |
| -------- | ---------------------------- | ---------------------------------------------- | ----------------------------------------------- |
| Phiên    | Main                         | Main (qua sự kiện hệ thống) | `cron:<jobId>`                                  |
| Lịch sử  | Dùng chung                   | Dùng chung                                     | Mới mỗi lần chạy                                |
| Ngữ cảnh | Đầy đủ                       | Đầy đủ                                         | Không (bắt đầu sạch)         |
| Mô hình  | Mô hình main session         | Mô hình main session                           | Có thể ghi đè                                   |
| Đầu ra   | Gửi nếu không `HEARTBEAT_OK` | Prompt heartbeat + sự kiện                     | Thông báo tóm tắt (mặc định) |

### Khi nào dùng cron main session

Dùng `--session main` với `--system-event` khi bạn muốn:

- Nhắc việc/sự kiện xuất hiện trong ngữ cảnh main session
- Tác tử xử lý trong heartbeat tiếp theo với đầy đủ ngữ cảnh
- Không có lần chạy cô lập riêng

```bash
openclaw cron add \
  --name "Check project" \
  --every "4h" \
  --session main \
  --system-event "Time for a project health check" \
  --wake now
```

### Khi nào dùng cron cô lập

Dùng `--session isolated` khi bạn muốn:

- Trạng thái sạch không có ngữ cảnh trước đó
- Cài đặt mô hình hoặc suy nghĩ khác
- Thông báo tóm tắt trực tiếp tới một kênh
- Lịch sử không làm lộn xộn main session

```bash
openclaw cron add \
  --name "Deep analysis" \
  --cron "0 6 * * 0" \
  --session isolated \
  --message "Weekly codebase analysis..." \
  --model opus \
  --thinking high \
  --announce
```

## Cân nhắc chi phí

| Cơ chế                             | Hồ sơ chi phí                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| Heartbeat                          | Một lượt mỗi N phút; tăng theo kích thước HEARTBEAT.md         |
| Cron (main)     | Thêm sự kiện vào heartbeat tiếp theo (không có lượt cô lập) |
| Cron (isolated) | Một lượt tác tử đầy đủ cho mỗi job; có thể dùng mô hình rẻ hơn                 |

**Mẹo**:

- Giữ `HEARTBEAT.md` nhỏ để giảm chi phí token.
- Gộp các kiểm tra tương tự vào heartbeat thay vì nhiều cron jobs.
- Dùng `target: "none"` trên heartbeat nếu bạn chỉ muốn xử lý nội bộ.
- Dùng cron cô lập với mô hình rẻ hơn cho các tác vụ thường lệ.

## Liên quan

- [Heartbeat](/gateway/heartbeat) - cấu hình heartbeat đầy đủ
- [Cron jobs](/automation/cron-jobs) - tham chiếu CLI và API cron đầy đủ
- [System](/cli/system) - sự kiện hệ thống + điều khiển heartbeat
