---
summary: "Tích hợp Telegram Bot API thông qua grammY kèm ghi chú thiết lập"
read_when:
  - Khi làm việc với các luồng Telegram hoặc grammY
title: grammY
---

# Tích hợp grammY (Telegram Bot API)

# Vì sao chọn grammY

- Client Bot API ưu tiên TypeScript với các tiện ích long-poll + webhook tích hợp sẵn, middleware, xử lý lỗi, bộ giới hạn tốc độ.
- Trợ giúp media gọn gàng hơn so với tự ghép fetch + FormData; hỗ trợ đầy đủ các phương thức Bot API.
- Khả năng mở rộng: hỗ trợ proxy qua fetch tùy chỉnh, middleware phiên (tùy chọn), context an toàn kiểu.

# Những gì đã triển khai

- **Đường client duy nhất:** loại bỏ triển khai dựa trên fetch; grammY hiện là client Telegram duy nhất (gửi + gateway) với bộ throttler của grammY được bật mặc định.
- **Gateway:** `monitorTelegramProvider` builds a grammY `Bot`, wires mention/allowlist gating, media download via `getFile`/`download`, and delivers replies with `sendMessage/sendPhoto/sendVideo/sendAudio/sendDocument`. Hỗ trợ long-poll hoặc webhook thông qua `webhookCallback`.
- **Proxy:** `channels.telegram.proxy` (tùy chọn) dùng `undici.ProxyAgent` thông qua `client.baseFetch` của grammY.
- **Hỗ trợ webhook:** `webhook-set.ts` bao bọc `setWebhook/deleteWebhook`; `webhook.ts` lưu trữ callback với kiểm tra sức khỏe + tắt máy an toàn. Gateway enables webhook mode when `channels.telegram.webhookUrl` + `channels.telegram.webhookSecret` are set (otherwise it long-polls).
- **Phiên:** chat trực tiếp được gộp vào phiên chính của tác tử (`agent:<agentId>:<mainKey>`); nhóm dùng `agent:<agentId>:telegram:group:<chatId>`; phản hồi quay lại cùng kênh.
- **Núm cấu hình:** `channels.telegram.botToken`, `channels.telegram.dmPolicy`, `channels.telegram.groups` (mặc định allowlist + mention), `channels.telegram.allowFrom`, `channels.telegram.groupAllowFrom`, `channels.telegram.groupPolicy`, `channels.telegram.mediaMaxMb`, `channels.telegram.linkPreview`, `channels.telegram.proxy`, `channels.telegram.webhookSecret`, `channels.telegram.webhookUrl`.
- **Streaming bản nháp:** tùy chọn `channels.telegram.streamMode` sử dụng `sendMessageDraft` trong các cuộc trò chuyện chủ đề riêng tư (Bot API 9.3+). This is separate from channel block streaming.
- **Kiểm thử:** mock grammY bao phủ DM + kiểm soát mention trong nhóm và gửi ra ngoài; vẫn hoan nghênh thêm fixture cho media/webhook.

Câu hỏi còn mở

- Plugin grammY tùy chọn (throttler) nếu gặp lỗi 429 từ Bot API.
- Bổ sung kiểm thử media có cấu trúc hơn (sticker, ghi chú thoại).
- Cho phép cấu hình cổng lắng nghe webhook (hiện cố định 8787 trừ khi nối qua gateway).
