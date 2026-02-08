---
summary: "Vòng đời Gateway trên macOS (launchd)"
read_when:
  - Tích hợp ứng dụng mac với vòng đời của gateway
title: "Vòng đời Gateway"
x-i18n:
  source_path: platforms/mac/child-process.md
  source_hash: 9b910f574b723bc1
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:40Z
---

# Vòng đời Gateway trên macOS

Ứng dụng macOS **quản lý Gateway thông qua launchd** theo mặc định và không khởi chạy
Gateway như một tiến trình con. Trước tiên, ứng dụng cố gắng gắn kết với một
Gateway đang chạy trên cổng đã cấu hình; nếu không kết nối được, nó sẽ bật dịch vụ
launchd thông qua CLI bên ngoài `openclaw` (không có runtime nhúng). Cách này
đảm bảo tự động khởi động khi đăng nhập và tự khởi động lại khi gặp sự cố.

Chế độ tiến trình con (Gateway được ứng dụng khởi chạy trực tiếp) **hiện không được sử dụng**.
Nếu bạn cần liên kết chặt chẽ hơn với UI, hãy chạy Gateway thủ công trong terminal.

## Hành vi mặc định (launchd)

- Ứng dụng cài đặt một LaunchAgent theo người dùng với nhãn `bot.molt.gateway`
  (hoặc `bot.molt.<profile>` khi dùng `--profile`/`OPENCLAW_PROFILE`; `com.openclaw.*` cũ vẫn được hỗ trợ).
- Khi bật chế độ Local, ứng dụng đảm bảo LaunchAgent được nạp và
  khởi động Gateway nếu cần.
- Log được ghi vào đường dẫn log gateway của launchd (xem trong Debug Settings).

Các lệnh thường dùng:

```bash
launchctl kickstart -k gui/$UID/bot.molt.gateway
launchctl bootout gui/$UID/bot.molt.gateway
```

Thay nhãn bằng `bot.molt.<profile>` khi chạy một profile có tên.

## Bản build dev chưa ký

`scripts/restart-mac.sh --no-sign` dùng cho các bản build cục bộ nhanh khi bạn chưa có
khóa ký. Để tránh launchd trỏ tới một binary relay chưa ký, nó sẽ:

- Ghi `~/.openclaw/disable-launchagent`.

Các lần chạy đã ký của `scripts/restart-mac.sh` sẽ xóa ghi đè này nếu
dấu đánh dấu tồn tại. Để đặt lại thủ công:

```bash
rm ~/.openclaw/disable-launchagent
```

## Chế độ chỉ gắn kết

Để buộc ứng dụng macOS **không bao giờ cài đặt hoặc quản lý launchd**, hãy khởi chạy với
`--attach-only` (hoặc `--no-launchd`). Thao tác này đặt `~/.openclaw/disable-launchagent`,
vì vậy ứng dụng chỉ gắn kết với một Gateway đang chạy sẵn. Bạn cũng có thể bật/tắt
hành vi tương tự trong Debug Settings.

## Chế độ Remote

Chế độ Remote không bao giờ khởi động Gateway cục bộ. Ứng dụng sử dụng một đường hầm SSH
tới máy chủ từ xa và kết nối qua đường hầm đó.

## Vì sao chúng tôi ưu tiên launchd

- Tự động khởi động khi đăng nhập.
- Cơ chế khởi động lại/KeepAlive tích hợp sẵn.
- Log và giám sát nhất quán, dễ dự đoán.

Nếu trong tương lai thực sự cần chế độ tiến trình con, nó nên được tài liệu hóa như
một chế độ dev‑only riêng biệt, rõ ràng.
