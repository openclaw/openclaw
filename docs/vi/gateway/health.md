---
summary: "Các bước kiểm tra sức khỏe để xác minh kết nối kênh"
read_when:
  - Chẩn đoán tình trạng kênh WhatsApp
title: "Kiểm tra sức khỏe"
---

# Kiểm tra sức khỏe (CLI)

Hướng dẫn ngắn để xác minh kết nối kênh mà không cần đoán mò.

## Kiểm tra nhanh

- `openclaw status` — tóm tắt cục bộ: khả năng truy cập/chế độ gateway, gợi ý cập nhật, tuổi xác thực của kênh đã liên kết, các phiên + hoạt động gần đây.
- `openclaw status --all` — chẩn đoán cục bộ đầy đủ (chỉ đọc, có màu, an toàn để dán khi gỡ lỗi).
- `openclaw status --deep` — đồng thời thăm dò Gateway đang chạy (thăm dò theo từng kênh khi được hỗ trợ).
- `openclaw health --json` — yêu cầu Gateway đang chạy cung cấp ảnh chụp sức khỏe đầy đủ (chỉ WS; không có socket Baileys trực tiếp).
- Gửi `/status` như một tin nhắn độc lập trong WhatsApp/WebChat để nhận phản hồi trạng thái mà không kích hoạt tác tử.
- Nhật ký: theo dõi `/tmp/openclaw/openclaw-*.log` và lọc `web-heartbeat`, `web-reconnect`, `web-auto-reply`, `web-inbound`.

## Chẩn đoán chuyên sâu

- Thông tin xác thực trên đĩa: `ls -l ~/.openclaw/credentials/whatsapp/<accountId>/creds.json` (mtime nên là gần đây).
- Kho phiên: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (đường dẫn có thể bị ghi đè trong cấu hình). Số lượng và các người nhận gần đây được hiển thị qua `status`.
- Luồng liên kết lại: `openclaw channels logout && openclaw channels login --verbose` khi các mã trạng thái 409–515 hoặc `loggedOut` xuất hiện trong log. (Lưu ý: luồng đăng nhập bằng QR tự khởi động lại một lần cho trạng thái 515 sau khi ghép đôi.)

## Khi có sự cố

- `logged out` hoặc trạng thái 409–515 → liên kết lại bằng `openclaw channels logout` rồi `openclaw channels login`.
- Gateway không truy cập được → khởi động: `openclaw gateway --port 18789` (dùng `--force` nếu cổng đang bận).
- Không có tin nhắn vào → xác nhận điện thoại đã liên kết đang online và người gửi được cho phép (`channels.whatsapp.allowFrom`); với chat nhóm, đảm bảo quy tắc danh sách cho phép + nhắc tên phù hợp (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Lệnh "health" chuyên dụng

`openclaw health --json` asks the running Gateway for its health snapshot (no direct channel sockets from the CLI). It reports linked creds/auth age when available, per-channel probe summaries, session-store summary, and a probe duration. Lệnh sẽ thoát với mã khác 0 nếu Gateway không thể truy cập hoặc phép thăm dò thất bại/hết thời gian. Dùng `--timeout <ms>` để ghi đè mặc định 10s.
