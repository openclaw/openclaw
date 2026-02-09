---
summary: "Ghi log OpenClaw: tệp chẩn đoán xoay vòng + cờ quyền riêng tư của unified log"
read_when:
  - Thu thập log macOS hoặc điều tra việc ghi log dữ liệu riêng tư
  - Gỡ lỗi các vấn đề về vòng đời đánh thức/phiên giọng nói
title: "Ghi log macOS"
---

# Logging (macOS)

## Tệp log chẩn đoán xoay vòng (ngăn Debug)

OpenClaw định tuyến log của ứng dụng macOS qua swift-log (mặc định là unified logging) và có thể ghi một tệp log cục bộ, xoay vòng trên đĩa khi bạn cần lưu trữ bền vững.

- Mức chi tiết: **Debug pane → Logs → App logging → Verbosity**
- Bật: **Debug pane → Logs → App logging → “Write rolling diagnostics log (JSONL)”**
- Vị trí: `~/Library/Logs/OpenClaw/diagnostics.jsonl` (tự động xoay vòng; các tệp cũ được thêm hậu tố `.1`, `.2`, …)
- Xóa: **Debug pane → Logs → App logging → “Clear”**

Ghi chú:

- Tính năng này **tắt theo mặc định**. Chỉ bật khi đang debug tích cực.
- Coi tệp là dữ liệu nhạy cảm; không chia sẻ nếu chưa xem xét.

## Dữ liệu riêng tư trong unified logging trên macOS

Unified logging sẽ ẩn hầu hết payload trừ khi một subsystem chọn `privacy -off`. Per Peter's write-up on macOS [logging privacy shenanigans](https://steipete.me/posts/2025/logging-privacy-shenanigans) (2025) this is controlled by a plist in `/Library/Preferences/Logging/Subsystems/` keyed by the subsystem name. Chỉ các mục log mới nhận cờ này, vì vậy hãy bật nó trước khi tái hiện sự cố.

## Bật cho OpenClaw (`bot.molt`)

- Trước tiên ghi plist ra một tệp tạm, sau đó cài đặt một cách nguyên tử với quyền root:

```bash
cat <<'EOF' >/tmp/bot.molt.plist
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>DEFAULT-OPTIONS</key>
    <dict>
        <key>Enable-Private-Data</key>
        <true/>
    </dict>
</dict>
</plist>
EOF
sudo install -m 644 -o root -g wheel /tmp/bot.molt.plist /Library/Preferences/Logging/Subsystems/bot.molt.plist
```

- Không cần khởi động lại; logd sẽ nhanh chóng nhận ra tệp, nhưng chỉ các dòng log mới sẽ bao gồm payload riêng tư.
- Xem đầu ra chi tiết hơn bằng trợ giúp hiện có, ví dụ: `./scripts/clawlog.sh --category WebChat --last 5m`.

## Tắt sau khi gỡ lỗi

- Gỡ bỏ ghi đè: `sudo rm /Library/Preferences/Logging/Subsystems/bot.molt.plist`.
- Tùy chọn chạy `sudo log config --reload` để buộc logd bỏ ghi đè ngay lập tức.
- Hãy nhớ bề mặt này có thể bao gồm số điện thoại và nội dung tin nhắn; chỉ giữ plist trong thời gian bạn thực sự cần thêm chi tiết.
