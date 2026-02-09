---
summary: "Cách ứng dụng macOS báo cáo trạng thái sức khỏe của gateway/Baileys"
read_when:
  - Gỡ lỗi các chỉ báo sức khỏe của ứng dụng mac
title: "Kiểm tra sức khỏe"
---

# Kiểm tra sức khỏe trên macOS

Cách xem liệu kênh đã liên kết có đang hoạt động tốt từ ứng dụng thanh menu hay không.

## Thanh menu

- Chấm trạng thái hiện phản ánh sức khỏe Baileys:
  - Xanh: đã liên kết + socket vừa được mở.
  - Cam: đang kết nối/đang thử lại.
  - Đỏ: đã đăng xuất hoặc thăm dò thất bại.
- Dòng phụ hiển thị "linked · auth 12m" hoặc hiển thị lý do thất bại.
- Mục menu "Run Health Check" kích hoạt thăm dò theo yêu cầu.

## Cài đặt

- Thẻ General có thêm thẻ Health hiển thị: tuổi xác thực của liên kết, đường dẫn/số lượng session-store, thời điểm kiểm tra gần nhất, lỗi/mã trạng thái gần nhất, và các nút Run Health Check / Reveal Logs.
- Sử dụng ảnh chụp được lưu trong bộ nhớ đệm để UI tải tức thì và suy giảm nhẹ nhàng khi offline.
- **Thẻ Channels** hiển thị trạng thái kênh + các điều khiển cho WhatsApp/Telegram (QR đăng nhập, đăng xuất, thăm dò, lần ngắt kết nối/lỗi gần nhất).

## Cách thăm dò hoạt động

- Ứng dụng chạy `openclaw health --json` thông qua `ShellExecutor` mỗi ~60 giây và theo yêu cầu. Probe tải thông tin xác thực và báo cáo trạng thái mà không gửi thông điệp.
- Lưu riêng ảnh chụp tốt gần nhất và lỗi gần nhất để tránh nhấp nháy; hiển thị dấu thời gian của từng mục.

## Khi cần kiểm tra thêm

- Bạn vẫn có thể dùng luồng CLI trong [Gateway health](/gateway/health) (`openclaw status`, `openclaw status --deep`, `openclaw health --json`) và theo dõi `/tmp/openclaw/openclaw-*.log` cho `web-heartbeat` / `web-reconnect`.
