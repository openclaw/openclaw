---
summary: "Những nội dung có trong system prompt của OpenClaw và cách nó được lắp ghép"
read_when:
  - Chỉnh sửa văn bản system prompt, danh sách công cụ, hoặc các phần thời gian/heartbeat
  - Thay đổi hành vi bootstrap workspace hoặc cơ chế chèn Skills
title: "System Prompt"
x-i18n:
  source_path: concepts/system-prompt.md
  source_hash: 1de1b529402a5f1b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:49Z
---

# System Prompt

OpenClaw xây dựng một system prompt tùy chỉnh cho mỗi lần chạy tác tử. Prompt này **thuộc sở hữu của OpenClaw** và không sử dụng prompt mặc định của p-coding-agent.

Prompt được OpenClaw lắp ghép và chèn vào mỗi lần chạy tác tử.

## Cấu trúc

Prompt được thiết kế gọn nhẹ và sử dụng các phần cố định:

- **Tooling**: danh sách công cụ hiện tại + mô tả ngắn.
- **Safety**: nhắc nhở guardrail ngắn để tránh hành vi tìm kiếm quyền lực hoặc né tránh giám sát.
- **Skills** (khi có): hướng dẫn mô hình cách tải chỉ dẫn kỹ năng theo yêu cầu.
- **OpenClaw Self-Update**: cách chạy `config.apply` và `update.run`.
- **Workspace**: thư mục làm việc (`agents.defaults.workspace`).
- **Documentation**: đường dẫn cục bộ tới tài liệu OpenClaw (repo hoặc gói npm) và khi nào cần đọc.
- **Workspace Files (injected)**: cho biết các tệp bootstrap được chèn bên dưới.
- **Sandbox** (khi bật): cho biết runtime trong sandbox, các đường dẫn sandbox, và liệu có quyền exec nâng cao hay không.
- **Current Date & Time**: thời gian theo địa phương của người dùng, múi giờ và định dạng thời gian.
- **Reply Tags**: cú pháp thẻ trả lời tùy chọn cho các nhà cung cấp được hỗ trợ.
- **Heartbeats**: prompt heartbeat và hành vi ack.
- **Runtime**: host, OS, node, model, repo root (khi phát hiện), mức độ suy nghĩ (một dòng).
- **Reasoning**: mức độ hiển thị hiện tại + gợi ý bật/tắt /reasoning.

Các guardrail an toàn trong system prompt mang tính hướng dẫn. Chúng định hướng hành vi của mô hình nhưng không thực thi chính sách. Hãy dùng chính sách công cụ, phê duyệt exec, sandboxing và danh sách cho phép kênh để thực thi cứng; theo thiết kế, người vận hành có thể vô hiệu hóa các cơ chế này.

## Chế độ prompt

OpenClaw có thể tạo các system prompt nhỏ hơn cho sub-agent. Runtime đặt
`promptMode` cho mỗi lần chạy (không phải cấu hình hướng người dùng):

- `full` (mặc định): bao gồm tất cả các phần ở trên.
- `minimal`: dùng cho sub-agent; lược bỏ **Skills**, **Memory Recall**, **OpenClaw
  Self-Update**, **Model Aliases**, **User Identity**, **Reply Tags**,
  **Messaging**, **Silent Replies** và **Heartbeats**. Tooling, **Safety**,
  Workspace, Sandbox, Current Date & Time (khi biết), Runtime và ngữ cảnh được chèn
  vẫn khả dụng.
- `none`: chỉ trả về dòng nhận diện cơ bản.

Khi `promptMode=minimal`, các prompt được chèn thêm sẽ được gắn nhãn **Subagent
Context** thay vì **Group Chat Context**.

## Chèn bootstrap workspace

Các tệp bootstrap được cắt gọn và nối vào dưới **Project Context** để mô hình thấy được ngữ cảnh danh tính và hồ sơ mà không cần đọc tường minh:

- `AGENTS.md`
- `SOUL.md`
- `TOOLS.md`
- `IDENTITY.md`
- `USER.md`
- `HEARTBEAT.md`
- `BOOTSTRAP.md` (chỉ trên workspace hoàn toàn mới)

Các tệp lớn sẽ bị cắt ngắn kèm theo một marker. Kích thước tối đa cho mỗi tệp được điều khiển bởi
`agents.defaults.bootstrapMaxChars` (mặc định: 20000). Các tệp bị thiếu sẽ chèn một
marker ngắn báo thiếu tệp.

Các hook nội bộ có thể chặn bước này thông qua `agent:bootstrap` để biến đổi hoặc thay thế
các tệp bootstrap được chèn (ví dụ hoán đổi `SOUL.md` bằng một persona thay thế).

Để kiểm tra mức đóng góp của từng tệp được chèn (raw so với injected, cắt ngắn, cộng thêm overhead của schema công cụ), hãy dùng `/context list` hoặc `/context detail`. Xem [Context](/concepts/context).

## Xử lý thời gian

System prompt bao gồm một phần **Current Date & Time** riêng khi
múi giờ người dùng được biết. Để giữ cache prompt ổn định, hiện nay nó chỉ bao gồm
**múi giờ** (không có đồng hồ động hay định dạng thời gian).

Dùng `session_status` khi tác tử cần thời gian hiện tại; thẻ trạng thái
có kèm một dòng timestamp.

Cấu hình bằng:

- `agents.defaults.userTimezone`
- `agents.defaults.timeFormat` (`auto` | `12` | `24`)

Xem [Date & Time](/date-time) để biết đầy đủ chi tiết hành vi.

## Skills

Khi có các Skills đủ điều kiện, OpenClaw chèn một **danh sách Skills khả dụng** gọn nhẹ
(`formatSkillsForPrompt`) bao gồm **đường dẫn tệp** cho mỗi skill. Prompt hướng dẫn mô hình sử dụng `read` để tải SKILL.md tại vị trí được liệt kê
(workspace, managed hoặc bundled). Nếu không có Skills đủ điều kiện, phần
Skills sẽ bị lược bỏ.

```
<available_skills>
  <skill>
    <name>...</name>
    <description>...</description>
    <location>...</location>
  </skill>
</available_skills>
```

Cách này giữ prompt nền nhỏ gọn trong khi vẫn cho phép sử dụng skill có mục tiêu.

## Documentation

Khi có sẵn, system prompt bao gồm một phần **Documentation** trỏ tới
thư mục tài liệu OpenClaw cục bộ (hoặc `docs/` trong workspace repo hoặc tài liệu gói npm
được bundled) và cũng ghi chú mirror công khai, repo nguồn, cộng đồng Discord và
ClawHub ([https://clawhub.com](https://clawhub.com)) để khám phá Skills. Prompt hướng dẫn mô hình tham khảo tài liệu cục bộ trước
đối với hành vi, lệnh, cấu hình hoặc kiến trúc của OpenClaw, và tự chạy
`openclaw status` khi có thể (chỉ hỏi người dùng khi không có quyền truy cập).
