---
summary: "Gia cố xử lý đầu vào cron.add, căn chỉnh schema và cải thiện công cụ UI/tác tử cho cron"
owner: "openclaw"
status: "complete"
last_updated: "2026-01-05"
title: "Gia cố Cron Add"
x-i18n:
  source_path: experiments/plans/cron-add-hardening.md
  source_hash: d7e469674bd9435b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:55Z
---

# Gia cố Cron Add & Căn chỉnh Schema

## Bối cảnh

Các log Gateway gần đây cho thấy lặp lại lỗi `cron.add` với tham số không hợp lệ (thiếu `sessionTarget`, `wakeMode`, `payload`, và `schedule` bị sai định dạng). Điều này cho thấy ít nhất một client (nhiều khả năng là đường gọi công cụ của tác tử) đang gửi payload job được bọc hoặc chỉ định không đầy đủ. Bên cạnh đó, có sự lệch pha giữa các enum nhà cung cấp cron trong TypeScript, schema của gateway, cờ CLI và kiểu biểu mẫu UI, cùng với sự không khớp UI cho `cron.status` (UI kỳ vọng `jobCount` trong khi gateway trả về `jobs`).

## Mục tiêu

- Chặn spam `cron.add` INVALID_REQUEST bằng cách chuẩn hóa các payload bọc phổ biến và suy luận các trường `kind` còn thiếu.
- Căn chỉnh danh sách nhà cung cấp cron giữa schema gateway, các kiểu cron, tài liệu CLI và biểu mẫu UI.
- Làm rõ schema công cụ cron của tác tử để LLM tạo payload job chính xác.
- Sửa hiển thị số lượng job trạng thái cron trên Control UI.
- Thêm test để bao phủ chuẩn hóa và hành vi công cụ.

## Ngoài phạm vi

- Thay đổi ngữ nghĩa lập lịch cron hoặc hành vi thực thi job.
- Thêm loại lịch mới hoặc phân tích cú pháp biểu thức cron.
- Đại tu UI/UX cho cron ngoài các chỉnh sửa trường cần thiết.

## Phát hiện (khoảng trống hiện tại)

- `CronPayloadSchema` trong gateway loại trừ `signal` + `imessage`, trong khi các kiểu TS có bao gồm.
- CronStatus của Control UI kỳ vọng `jobCount`, nhưng gateway trả về `jobs`.
- Schema công cụ cron của tác tử cho phép các đối tượng `job` tùy ý, tạo điều kiện cho đầu vào sai.
- Gateway xác thực nghiêm ngặt `cron.add` mà không có chuẩn hóa, nên các payload được bọc sẽ thất bại.

## Những thay đổi

- `cron.add` và `cron.update` hiện chuẩn hóa các dạng bọc phổ biến và suy luận các trường `kind` còn thiếu.
- Schema công cụ cron của tác tử khớp với schema gateway, giúp giảm payload không hợp lệ.
- Các enum nhà cung cấp được căn chỉnh trên gateway, CLI, UI và bộ chọn macOS.
- Control UI sử dụng trường đếm `jobs` của gateway cho trạng thái.

## Hành vi hiện tại

- **Chuẩn hóa:** các payload `data`/`job` được bọc sẽ được mở; `schedule.kind` và `payload.kind` được suy luận khi an toàn.
- **Mặc định:** áp dụng giá trị mặc định an toàn cho `wakeMode` và `sessionTarget` khi thiếu.
- **Nhà cung cấp:** Discord/Slack/Signal/iMessage hiện được hiển thị nhất quán trên CLI/UI.

Xem [Cron jobs](/automation/cron-jobs) để biết dạng chuẩn hóa và ví dụ.

## Xác minh

- Theo dõi log Gateway để thấy giảm lỗi `cron.add` INVALID_REQUEST.
- Xác nhận Control UI hiển thị số lượng job trạng thái cron sau khi làm mới.

## Theo dõi tùy chọn

- Smoke test thủ công trên Control UI: thêm một cron job cho mỗi nhà cung cấp + xác minh số lượng job trạng thái.

## Câu hỏi mở

- `cron.add` có nên chấp nhận `state` tường minh từ client không (hiện bị schema không cho phép)?
- Có nên cho phép `webchat` như một nhà cung cấp phân phối tường minh không (hiện bị lọc trong quá trình phân giải phân phối)?
