---
summary: "Tính bền vững của quyền trên macOS (TCC) và yêu cầu ký"
read_when:
  - Gỡ lỗi khi lời nhắc quyền macOS bị thiếu hoặc bị treo
  - Đóng gói hoặc ký ứng dụng macOS
  - Thay đổi bundle ID hoặc đường dẫn cài đặt ứng dụng
title: "Quyền trên macOS"
x-i18n:
  source_path: platforms/mac/permissions.md
  source_hash: 52bee5c896e31e99
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:42Z
---

# Quyền trên macOS (TCC)

Việc cấp quyền trên macOS khá mong manh. TCC liên kết một lần cấp quyền với
chữ ký mã của ứng dụng, bundle identifier và đường dẫn trên đĩa. Nếu bất kỳ yếu tố nào thay đổi,
macOS sẽ coi ứng dụng là mới và có thể bỏ hoặc ẩn các lời nhắc.

## Yêu cầu để quyền ổn định

- Cùng đường dẫn: chạy ứng dụng từ một vị trí cố định (đối với OpenClaw, `dist/OpenClaw.app`).
- Cùng bundle identifier: thay đổi bundle ID sẽ tạo một danh tính quyền mới.
- Ứng dụng được ký: các bản build chưa ký hoặc ký ad-hoc sẽ không lưu quyền.
- Chữ ký nhất quán: dùng chứng chỉ Apple Development hoặc Developer ID thật
  để chữ ký ổn định qua các lần build lại.

Chữ ký ad-hoc tạo ra một danh tính mới cho mỗi lần build. macOS sẽ quên các quyền đã cấp trước đó,
và các lời nhắc thậm chí có thể biến mất hoàn toàn cho đến khi các mục cũ được xóa.

## Danh sách khôi phục khi lời nhắc biến mất

1. Thoát ứng dụng.
2. Xóa mục ứng dụng trong System Settings -> Privacy & Security.
3. Mở lại ứng dụng từ cùng đường dẫn và cấp lại quyền.
4. Nếu lời nhắc vẫn không xuất hiện, đặt lại các mục TCC bằng `tccutil` và thử lại.
5. Một số quyền chỉ xuất hiện lại sau khi khởi động lại macOS hoàn toàn.

Ví dụ đặt lại (thay bundle ID khi cần):

```bash
sudo tccutil reset Accessibility bot.molt.mac
sudo tccutil reset ScreenCapture bot.molt.mac
sudo tccutil reset AppleEvents
```

## Quyền Files and folders (Desktop/Documents/Downloads)

macOS cũng có thể kiểm soát Desktop, Documents và Downloads đối với các tiến trình terminal/nền. Nếu việc đọc tệp hoặc liệt kê thư mục bị treo, hãy cấp quyền cho cùng ngữ cảnh tiến trình thực hiện thao tác tệp (ví dụ Terminal/iTerm, ứng dụng được khởi chạy bởi LaunchAgent, hoặc tiến trình SSH).

Cách khắc phục: chuyển tệp vào workspace của OpenClaw (`~/.openclaw/workspace`) nếu bạn muốn tránh việc cấp quyền theo từng thư mục.

Nếu bạn đang kiểm thử quyền, luôn ký bằng chứng chỉ thật. Các bản build ad-hoc
chỉ phù hợp cho các lần chạy cục bộ nhanh nơi quyền không quan trọng.
