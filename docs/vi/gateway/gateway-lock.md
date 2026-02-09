---
summary: "Cơ chế bảo vệ singleton của Gateway bằng cách ràng buộc listener WebSocket"
read_when:
  - Khi chạy hoặc gỡ lỗi tiến trình gateway
  - Khi điều tra việc thực thi chạy một phiên bản duy nhất
title: "Khóa Gateway"
---

# Khóa Gateway

Cập nhật lần cuối: 2025-12-11

## Vì sao

- Đảm bảo chỉ một phiên bản gateway chạy cho mỗi cổng cơ sở trên cùng một máy chủ; các gateway bổ sung phải dùng profile tách biệt và cổng riêng.
- Chịu được crash/SIGKILL mà không để lại tệp khóa lỗi thời.
- Thất bại nhanh với thông báo lỗi rõ ràng khi cổng điều khiển đã bị chiếm.

## Cơ chế

- Gateway ràng buộc listener WebSocket (mặc định `ws://127.0.0.1:18789`) ngay khi khởi động bằng một TCP listener độc quyền.
- Nếu việc bind thất bại với `EADDRINUSE`, quá trình khởi động ném lỗi `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Hệ điều hành tự động giải phóng listener khi tiến trình thoát theo bất kỳ cách nào, bao gồm crash và SIGKILL—không cần tệp khóa riêng hay bước dọn dẹp.
- Khi tắt, gateway đóng máy chủ WebSocket và máy chủ HTTP nền tảng để giải phóng cổng kịp thời.

## Bề mặt lỗi

- Nếu một tiến trình khác đang giữ cổng, quá trình khởi động ném lỗi `GatewayLockError("another gateway instance is already listening on ws://127.0.0.1:<port>")`.
- Các lỗi bind khác được hiển thị là `GatewayLockError("failed to bind gateway socket on ws://127.0.0.1:<port>: …")`.

## Ghi chú vận hành

- Nếu cổng bị chiếm bởi _một_ tiến trình khác, lỗi vẫn như nhau; hãy giải phóng cổng hoặc chọn cổng khác với `openclaw gateway --port <port>`.
- Ứng dụng macOS vẫn duy trì cơ chế bảo vệ PID nhẹ của riêng nó trước khi khởi chạy gateway; khóa ở thời gian chạy được thực thi bằng việc bind WebSocket.
