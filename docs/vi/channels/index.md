---
summary: "Các nền tảng nhắn tin mà OpenClaw có thể kết nối"
read_when:
  - Bạn muốn chọn một kênh trò chuyện cho OpenClaw
  - Bạn cần tổng quan nhanh về các nền tảng nhắn tin được hỗ trợ
title: "Kênh trò chuyện"
---

# Kênh trò chuyện

17. OpenClaw có thể trò chuyện với bạn trên bất kỳ ứng dụng chat nào bạn đang dùng. Each channel connects via the Gateway.
18. Văn bản được hỗ trợ ở mọi nơi; media và reaction khác nhau tùy kênh.

## Các kênh được hỗ trợ

- [WhatsApp](/channels/whatsapp) — Phổ biến nhất; dùng Baileys và yêu cầu ghép cặp QR.
- [Telegram](/channels/telegram) — Bot API qua grammY; hỗ trợ nhóm.
- [Discord](/channels/discord) — Discord Bot API + Gateway; hỗ trợ server, kênh và DM.
- [Slack](/channels/slack) — Bolt SDK; ứng dụng workspace.
- [Feishu](/channels/feishu) — Bot Feishu/Lark qua WebSocket (plugin, cài đặt riêng).
- [Google Chat](/channels/googlechat) — Ứng dụng Google Chat API qua webhook HTTP.
- [Mattermost](/channels/mattermost) — Bot API + WebSocket; kênh, nhóm, DM (plugin, cài đặt riêng).
- [Signal](/channels/signal) — signal-cli; tập trung vào quyền riêng tư.
- [BlueBubbles](/channels/bluebubbles) — **Khuyến nghị cho iMessage**; dùng REST API của máy chủ BlueBubbles trên macOS với hỗ trợ đầy đủ tính năng (chỉnh sửa, thu hồi, hiệu ứng, phản ứng, quản lý nhóm — chỉnh sửa hiện đang bị lỗi trên macOS 26 Tahoe).
- [iMessage (legacy)](/channels/imessage) — Tích hợp macOS cũ qua imsg CLI (đã ngừng khuyến nghị, dùng BlueBubbles cho thiết lập mới).
- [Microsoft Teams](/channels/msteams) — Bot Framework; hỗ trợ doanh nghiệp (plugin, cài đặt riêng).
- [LINE](/channels/line) — Bot LINE Messaging API (plugin, cài đặt riêng).
- [Nextcloud Talk](/channels/nextcloud-talk) — Chat tự lưu trữ qua Nextcloud Talk (plugin, cài đặt riêng).
- [Matrix](/channels/matrix) — Giao thức Matrix (plugin, cài đặt riêng).
- [Nostr](/channels/nostr) — DM phi tập trung qua NIP-04 (plugin, cài đặt riêng).
- [Tlon](/channels/tlon) — Trình nhắn tin dựa trên Urbit (plugin, cài đặt riêng).
- [Twitch](/channels/twitch) — Chat Twitch qua kết nối IRC (plugin, cài đặt riêng).
- [Zalo](/channels/zalo) — Zalo Bot API; ứng dụng nhắn tin phổ biến tại Việt Nam (plugin, cài đặt riêng).
- [Zalo Personal](/channels/zalouser) — Tài khoản Zalo cá nhân qua đăng nhập QR (plugin, cài đặt riêng).
- [WebChat](/web/webchat) — Giao diện WebChat của Gateway qua WebSocket.

## Ghi chú

- Các kênh có thể chạy đồng thời; cấu hình nhiều kênh và OpenClaw sẽ định tuyến theo từng cuộc chat.
- 19. Thiết lập nhanh nhất thường là **Telegram** (token bot đơn giản). 20. WhatsApp yêu cầu ghép cặp bằng QR và
      lưu nhiều trạng thái hơn trên đĩa.
- Hành vi trong nhóm khác nhau tùy kênh; xem [Groups](/channels/groups).
- Ghép cặp DM và danh sách cho phép được áp dụng để đảm bảo an toàn; xem [Security](/gateway/security).
- Nội bộ Telegram: [ghi chú grammY](/channels/grammy).
- Xử lý sự cố: [Xử lý sự cố kênh](/channels/troubleshooting).
- Nhà cung cấp mô hình được tài liệu hóa riêng; xem [Model Providers](/providers/models).
