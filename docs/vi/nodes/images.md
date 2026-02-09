---
summary: "Quy tắc xử lý hình ảnh và media cho gửi, gateway và phản hồi của tác tử"
read_when:
  - Sửa đổi pipeline media hoặc tệp đính kèm
title: "Hỗ trợ Hình ảnh và Media"
---

# Hỗ trợ Hình ảnh & Media — 2025-12-05

The WhatsApp channel runs via **Baileys Web**. This document captures the current media handling rules for send, gateway, and agent replies.

## Mục tiêu

- Gửi media kèm chú thích tùy chọn qua `openclaw message send --media`.
- Cho phép phản hồi tự động từ web inbox bao gồm media đi kèm văn bản.
- Giữ các giới hạn theo từng loại hợp lý và dễ dự đoán.

## Bề mặt CLI

- `openclaw message send --media <path-or-url> [--message <caption>]`
  - `--media` là tùy chọn; chú thích có thể để trống khi chỉ gửi media.
  - `--dry-run` in ra payload đã được resolve; `--json` phát ra `{ channel, to, messageId, mediaUrl, caption }`.

## Hành vi kênh WhatsApp Web

- Đầu vào: đường dẫn file cục bộ **hoặc** URL HTTP(S).
- Luồng: tải vào Buffer, phát hiện loại media và xây dựng payload phù hợp:
  - **Hình ảnh:** thay đổi kích thước & nén lại sang JPEG (cạnh dài tối đa 2048px), nhắm tới `agents.defaults.mediaMaxMb` (mặc định 5 MB), giới hạn tối đa 6 MB.
  - **Âm thanh/Thoại/Video:** chuyển tiếp nguyên trạng tới 16 MB; âm thanh được gửi dưới dạng voice note (`ptt: true`).
  - **Tài liệu:** mọi loại còn lại, tối đa 100 MB, giữ nguyên tên file khi có.
- Phát GIF kiểu WhatsApp: gửi MP4 với `gifPlayback: true` (CLI: `--gif-playback`) để ứng dụng di động lặp inline.
- Phát hiện MIME ưu tiên magic bytes, sau đó header, rồi phần mở rộng file.
- Chú thích lấy từ `--message` hoặc `reply.text`; cho phép chú thích trống.
- Ghi log: chế độ không verbose hiển thị `↩️`/`✅`; verbose bao gồm kích thước và đường dẫn nguồn/URL.

## Pipeline Phản hồi Tự động

- `getReplyFromConfig` returns `{ text?, mediaUrl?, mediaUrls? }`.
- Khi có media, web sender resolve đường dẫn cục bộ hoặc URL bằng cùng pipeline như `openclaw message send`.
- Nếu cung cấp nhiều media, chúng sẽ được gửi tuần tự.

## Media đầu vào cho Lệnh (Pi)

- Khi tin nhắn web đầu vào có media, OpenClaw tải xuống file tạm và cung cấp các biến templating:
  - `{{MediaUrl}}` pseudo-URL cho media đầu vào.
  - `{{MediaPath}}` đường dẫn tạm cục bộ được ghi trước khi chạy lệnh.
- Khi bật Docker sandbox theo từng phiên, media đầu vào được sao chép vào workspace của sandbox và `MediaPath`/`MediaUrl` được ghi lại thành đường dẫn tương đối như `media/inbound/<filename>`.
- Khả năng hiểu media (nếu được cấu hình qua `tools.media.*` hoặc dùng chung `tools.media.models`) chạy trước templating và có thể chèn các khối `[Image]`, `[Audio]` và `[Video]` vào `Body`.
  - Âm thanh thiết lập `{{Transcript}}` và dùng bản chép lời để phân tích lệnh, để lệnh slash vẫn hoạt động.
  - Mô tả video và hình ảnh giữ lại mọi chú thích để phân tích lệnh.
- Theo mặc định, chỉ tệp đính kèm hình ảnh/âm thanh/video khớp đầu tiên được xử lý; đặt `tools.media.<cap>``.attachments` để xử lý nhiều tệp đính kèm.

## Giới hạn & Lỗi

**Giới hạn gửi ra (WhatsApp web send)**

- Hình ảnh: ~6 MB sau khi nén lại.
- Âm thanh/thoại/video: 16 MB; tài liệu: 100 MB.
- Media quá lớn hoặc không đọc được → lỗi rõ ràng trong log và phản hồi bị bỏ qua.

**Giới hạn hiểu media (phiên âm/mô tả)**

- Hình ảnh mặc định: 10 MB (`tools.media.image.maxBytes`).
- Âm thanh mặc định: 20 MB (`tools.media.audio.maxBytes`).
- Video mặc định: 50 MB (`tools.media.video.maxBytes`).
- Media quá lớn sẽ bỏ qua bước hiểu, nhưng phản hồi vẫn được gửi với nội dung gốc.

## Ghi chú cho Kiểm thử

- Bao phủ luồng gửi + phản hồi cho các trường hợp hình ảnh/âm thanh/tài liệu.
- Xác thực việc nén lại hình ảnh (giới hạn kích thước) và cờ voice-note cho âm thanh.
- Đảm bảo phản hồi nhiều media được tách ra thành các lần gửi tuần tự.
