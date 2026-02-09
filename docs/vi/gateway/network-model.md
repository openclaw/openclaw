---
summary: "Cách Gateway, các node và máy chủ canvas kết nối."
read_when:
  - Bạn muốn có cái nhìn ngắn gọn về mô hình mạng của Gateway
title: "Mô hình mạng"
---

Hầu hết các thao tác đều đi qua Gateway (`openclaw gateway`), một tiến trình chạy lâu dài duy nhất
sở hữu các kết nối kênh và mặt phẳng điều khiển WebSocket.

## Quy tắc cốt lõi

- Khuyến nghị một Gateway cho mỗi máy chủ. Đây là quy trình duy nhất được phép sở hữu phiên WhatsApp Web. Đối với bot cứu hộ hoặc yêu cầu cách ly nghiêm ngặt, hãy chạy nhiều gateway với hồ sơ và cổng được cách ly. Xem [Multiple gateways](/gateway/multiple-gateways).
- Ưu tiên loopback: Gateway WS mặc định là `ws://127.0.0.1:18789`. Trình hướng dẫn tạo token gateway theo mặc định, ngay cả với loopback. Để truy cập qua tailnet, chạy `openclaw gateway --bind tailnet --token ...` vì token là bắt buộc đối với các bind không phải loopback.
- Các node kết nối tới Gateway WS qua LAN, tailnet hoặc SSH khi cần. Cầu TCP cũ đã bị ngừng hỗ trợ.
- Canvas host là một máy chủ tệp HTTP tại `canvasHost.port` (mặc định `18793`) phục vụ `/__openclaw__/canvas/` cho WebView của node. Xem [Gateway configuration](/gateway/configuration) (`canvasHost`).
- Sử dụng từ xa thường là đường hầm SSH hoặc VPN tailnet. Xem [Remote access](/gateway/remote) và [Discovery](/gateway/discovery).
