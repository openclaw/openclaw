---
summary: "Cách Gateway, các node và máy chủ canvas kết nối."
read_when:
  - Bạn muốn có cái nhìn ngắn gọn về mô hình mạng của Gateway
title: "Mô hình mạng"
x-i18n:
  source_path: gateway/network-model.md
  source_hash: e3508b884757ef19
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:57Z
---

Hầu hết các thao tác đều đi qua Gateway (`openclaw gateway`), một tiến trình chạy lâu dài duy nhất
sở hữu các kết nối kênh và mặt phẳng điều khiển WebSocket.

## Quy tắc cốt lõi

- Khuyến nghị một Gateway cho mỗi máy chủ. Đây là tiến trình duy nhất được phép sở hữu phiên WhatsApp Web. Đối với bot cứu hộ hoặc yêu cầu cô lập nghiêm ngặt, hãy chạy nhiều gateway với hồ sơ và cổng tách biệt. Xem [Multiple gateways](/gateway/multiple-gateways).
- Ưu tiên loopback: WS của Gateway mặc định là `ws://127.0.0.1:18789`. Trình hướng dẫn tạo token gateway theo mặc định, kể cả cho loopback. Để truy cập qua tailnet, hãy chạy `openclaw gateway --bind tailnet --token ...` vì token là bắt buộc cho các bind không phải loopback.
- Các node kết nối tới WS của Gateway qua LAN, tailnet hoặc SSH khi cần. Cầu nối TCP cũ đã bị ngừng dùng.
- Máy chủ canvas là một máy chủ tệp HTTP trên `canvasHost.port` (mặc định `18793`) phục vụ `/__openclaw__/canvas/` cho WebView của node. Xem [Gateway configuration](/gateway/configuration) (`canvasHost`).
- Sử dụng từ xa thường là đường hầm SSH hoặc VPN tailnet. Xem [Remote access](/gateway/remote) và [Discovery](/gateway/discovery).
