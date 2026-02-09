---
summary: "Vòng đời Gateway trên macOS (launchd)"
read_when:
  - Tích hợp ứng dụng mac với vòng đời của gateway
title: "Vòng đời Gateway"
---

# Vòng đời Gateway trên macOS

Ứng dụng macOS **quản lý Gateway thông qua launchd** theo mặc định và không khởi chạy
Gateway như một tiến trình con. Trước tiên, nó cố gắng gắn vào một
Gateway đang chạy sẵn trên cổng đã cấu hình; nếu không có gateway nào truy cập được, nó sẽ bật dịch vụ launchd
thông qua CLI `openclaw` bên ngoài (không có runtime nhúng). Điều này mang lại cho bạn
khả năng tự động khởi động đáng tin cậy khi đăng nhập và tự khởi động lại khi gặp sự cố.

Chế độ tiến trình con (Gateway được khởi chạy trực tiếp bởi ứng dụng) hiện **không được sử dụng**.
If you need tighter coupling to the UI, run the Gateway manually in a terminal.

## Hành vi mặc định (launchd)

- Ứng dụng cài đặt một LaunchAgent theo người dùng với nhãn `bot.molt.gateway`
  (hoặc `bot.molt.<profile>`` khi sử dụng `--profile`/`OPENCLAW_PROFILE`; legacy `com.openclaw.\*\` được hỗ trợ).
- Khi bật chế độ Local, ứng dụng đảm bảo LaunchAgent được nạp và
  khởi động Gateway nếu cần.
- Log được ghi vào đường dẫn log gateway của launchd (xem trong Debug Settings).

Các lệnh thường dùng:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Thay thế nhãn bằng `bot.molt.<profile>`
` khi chạy một profile được đặt tên.` khi chạy một profile được đặt tên.

## Bản build dev chưa ký

`scripts/restart-mac.sh --no-sign` dùng cho các bản build cục bộ nhanh khi bạn không có
khóa ký. Các lần chạy đã ký của `scripts/restart-mac.sh` sẽ xóa ghi đè này nếu marker tồn tại.

- Ghi `~/.openclaw/disable-launchagent`.

Các lần chạy đã ký của `scripts/restart-mac.sh` sẽ xóa ghi đè này nếu marker tồn tại. Để buộc ứng dụng macOS **không bao giờ cài đặt hoặc quản lý launchd**, hãy khởi chạy nó với
`--attach-only` (hoặc `--no-launchd`).

```bash
rm ~/.openclaw/disable-launchagent
```

## Chế độ chỉ gắn kết

Điều này đặt `~/.openclaw/disable-launchagent`,
để ứng dụng chỉ gắn vào một Gateway đang chạy sẵn. Bạn cũng có thể bật/tắt hành vi tương tự
trong Debug Settings. Bạn có thể bật/tắt hành vi tương tự trong Debug Settings.

## Chế độ Remote

Remote mode never starts a local Gateway. Ứng dụng sử dụng một đường hầm SSH tới máy chủ từ xa và kết nối thông qua đường hầm đó.

## Vì sao chúng tôi ưu tiên launchd

- Tự động khởi động khi đăng nhập.
- Cơ chế khởi động lại/KeepAlive tích hợp sẵn.
- Log và giám sát nhất quán, dễ dự đoán.

Nếu trong tương lai thực sự cần chế độ tiến trình con, nó nên được tài liệu hóa như
một chế độ dev‑only riêng biệt, rõ ràng.
