---
summary: "Tính bền vững của quyền trên macOS (TCC) và yêu cầu ký"
read_when:
  - Gỡ lỗi khi lời nhắc quyền macOS bị thiếu hoặc bị treo
  - Đóng gói hoặc ký ứng dụng macOS
  - Thay đổi bundle ID hoặc đường dẫn cài đặt ứng dụng
title: "Quyền trên macOS"
---

# Quyền trên macOS (TCC)

macOS permission grants are fragile. TCC liên kết việc cấp quyền với chữ ký mã, bundle identifier và đường dẫn trên đĩa của ứng dụng. Nếu bất kỳ yếu tố nào trong số đó thay đổi, macOS coi ứng dụng là mới và có thể bỏ hoặc ẩn các lời nhắc.

## Yêu cầu để quyền ổn định

- Cùng đường dẫn: chạy ứng dụng từ một vị trí cố định (đối với OpenClaw, `dist/OpenClaw.app`).
- Cùng bundle identifier: thay đổi bundle ID sẽ tạo một danh tính quyền mới.
- Ứng dụng được ký: các bản build chưa ký hoặc ký ad-hoc sẽ không lưu quyền.
- Chữ ký nhất quán: dùng chứng chỉ Apple Development hoặc Developer ID thật
  để chữ ký ổn định qua các lần build lại.

Chữ ký ad‑hoc tạo ra một danh tính mới cho mỗi bản build. macOS sẽ quên các quyền đã cấp trước đó, và các lời nhắc có thể biến mất hoàn toàn cho đến khi các mục cũ bị xóa.

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

macOS may also gate Desktop, Documents, and Downloads for terminal/background processes. Nếu việc đọc file hoặc liệt kê thư mục bị treo, hãy cấp quyền cho cùng ngữ cảnh tiến trình thực hiện thao tác file (ví dụ Terminal/iTerm, ứng dụng khởi chạy bằng LaunchAgent, hoặc tiến trình SSH).

Cách khắc phục: chuyển tệp vào workspace của OpenClaw (`~/.openclaw/workspace`) nếu bạn muốn tránh việc cấp quyền theo từng thư mục.

Nếu bạn đang kiểm thử quyền, luôn ký bằng một chứng chỉ thật. Ad-hoc
builds are only acceptable for quick local runs where permissions do not matter.
