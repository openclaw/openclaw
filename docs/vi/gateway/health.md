---
summary: "Các bước kiểm tra sức khỏe để xác minh kết nối kênh"
read_when:
  - Chẩn đoán tình trạng kênh WhatsApp
title: "Kiểm tra sức khỏe"
x-i18n:
  source_path: gateway/health.md
  source_hash: 74f242e98244c135
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:58Z
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
- Kho phiên: `ls -l ~/.openclaw/agents/<agentId>/sessions/sessions.json` (đường dẫn có thể ghi đè trong cấu hình). Số lượng và người nhận gần đây được hiển thị qua `status`.
- Luồng liên kết lại: `openclaw channels logout && openclaw channels login --verbose` khi các mã trạng thái 409–515 hoặc `loggedOut` xuất hiện trong nhật ký. (Lưu ý: luồng đăng nhập bằng QR tự động khởi động lại một lần đối với trạng thái 515 sau khi ghép cặp.)

## Khi có sự cố

- `logged out` hoặc trạng thái 409–515 → liên kết lại bằng `openclaw channels logout` rồi `openclaw channels login`.
- Gateway không truy cập được → khởi động: `openclaw gateway --port 18789` (dùng `--force` nếu cổng đang bận).
- Không có tin nhắn vào → xác nhận điện thoại đã liên kết đang online và người gửi được cho phép (`channels.whatsapp.allowFrom`); với chat nhóm, đảm bảo quy tắc danh sách cho phép + nhắc tên phù hợp (`channels.whatsapp.groups`, `agents.list[].groupChat.mentionPatterns`).

## Lệnh "health" chuyên dụng

`openclaw health --json` yêu cầu Gateway đang chạy cung cấp ảnh chụp sức khỏe của nó (CLI không mở socket kênh trực tiếp). Lệnh báo cáo thông tin xác thực đã liên kết/tuổi xác thực khi có, tóm tắt thăm dò theo từng kênh, tóm tắt kho phiên và thời lượng thăm dò. Lệnh thoát với mã khác 0 nếu Gateway không truy cập được hoặc thăm dò thất bại/hết thời gian chờ. Dùng `--timeout <ms>` để ghi đè mặc định 10 giây.
