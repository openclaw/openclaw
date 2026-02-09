---
summary: "Ghép cặp nút do Gateway sở hữu (Tùy chọn B) cho iOS và các nút từ xa khác"
read_when:
  - Triển khai phê duyệt ghép cặp nút không có UI macOS
  - Thêm luồng CLI để phê duyệt các nút từ xa
  - Mở rộng giao thức gateway với quản lý nút
title: "Ghép cặp do Gateway sở hữu"
---

# Ghép cặp do Gateway sở hữu (Tùy chọn B)

Trong cơ chế ghép cặp do Gateway sở hữu, **Gateway** là nguồn sự thật cho việc node nào
được phép tham gia. Các UI (ứng dụng macOS, các client tương lai) chỉ là frontend
phê duyệt hoặc từ chối các yêu cầu đang chờ.

**Quan trọng:** Các node WS sử dụng **ghép cặp thiết bị** (vai trò `node`) trong quá trình `connect`.
`node.pair.*` là một kho ghép cặp riêng và **không** kiểm soát bắt tay WS.
Chỉ các client gọi rõ ràng `node.pair.*` mới sử dụng luồng này.

## Khái niệm

- **Yêu cầu đang chờ**: một nút yêu cầu tham gia; cần được phê duyệt.
- **Nút đã ghép cặp**: nút đã được phê duyệt và được cấp token xác thực.
- **Vận chuyển**: endpoint Gateway WS chuyển tiếp các yêu cầu nhưng không quyết định
  tư cách thành viên. (Hỗ trợ cầu TCP cũ đã bị ngừng/loại bỏ.)

## Cách hoạt động của ghép cặp

1. Một nút kết nối tới WS của Gateway và yêu cầu ghép cặp.
2. Gateway lưu một **yêu cầu đang chờ** và phát `node.pair.requested`.
3. Bạn phê duyệt hoặc từ chối yêu cầu (CLI hoặc UI).
4. Khi phê duyệt, Gateway phát hành một **token mới** (token được xoay vòng khi ghép cặp lại).
5. Nút kết nối lại bằng token và lúc này đã được “ghép cặp”.

Các yêu cầu đang chờ sẽ tự động hết hạn sau **5 phút**.

## Quy trình CLI (thân thiện với môi trường không UI)

```bash
openclaw nodes pending
openclaw nodes approve <requestId>
openclaw nodes reject <requestId>
openclaw nodes status
openclaw nodes rename --node <id|name|ip> --name "Living Room iPad"
```

`nodes status` hiển thị các nút đã ghép cặp/đang kết nối và khả năng của chúng.

## Bề mặt API (giao thức gateway)

Sự kiện:

- `node.pair.requested` — phát khi một yêu cầu đang chờ mới được tạo.
- `node.pair.resolved` — phát khi một yêu cầu được phê duyệt/bị từ chối/hết hạn.

Phương thức:

- `node.pair.request` — tạo hoặc tái sử dụng một yêu cầu đang chờ.
- `node.pair.list` — liệt kê các nút đang chờ + đã ghép cặp.
- `node.pair.approve` — phê duyệt một yêu cầu đang chờ (cấp token).
- `node.pair.reject` — từ chối một yêu cầu đang chờ.
- `node.pair.verify` — xác minh `{ nodeId, token }`.

Ghi chú:

- `node.pair.request` là idempotent theo từng nút: các lần gọi lặp lại trả về cùng một
  yêu cầu đang chờ.
- Việc phê duyệt **luôn** tạo ra một token mới; không có token nào từng được trả về từ
  `node.pair.request`.
- Các yêu cầu có thể bao gồm `silent: true` như một gợi ý cho các luồng tự động phê duyệt.

## Tự động phê duyệt (ứng dụng macOS)

Ứng dụng macOS có thể tùy chọn thử **phê duyệt im lặng** khi:

- yêu cầu được đánh dấu `silent`, và
- ứng dụng có thể xác minh kết nối SSH tới máy chủ gateway bằng cùng một người dùng.

Nếu phê duyệt im lặng thất bại, nó sẽ quay lại hộp thoại “Phê duyệt/Từ chối” thông thường.

## Lưu trữ (cục bộ, riêng tư)

Trạng thái ghép cặp được lưu dưới thư mục trạng thái của Gateway (mặc định `~/.openclaw`):

- `~/.openclaw/nodes/paired.json`
- `~/.openclaw/nodes/pending.json`

Nếu bạn ghi đè `OPENCLAW_STATE_DIR`, thư mục `nodes/` sẽ di chuyển theo.

Ghi chú bảo mật:

- Token là bí mật; hãy coi `paired.json` là dữ liệu nhạy cảm.
- Xoay vòng token yêu cầu phê duyệt lại (hoặc xóa mục nhập của nút).

## Hành vi vận chuyển

- Lớp vận chuyển là **không trạng thái**; nó không lưu trữ tư cách thành viên.
- Nếu Gateway ngoại tuyến hoặc ghép cặp bị vô hiệu hóa, các nút không thể ghép cặp.
- Nếu Gateway ở chế độ từ xa, việc ghép cặp vẫn diễn ra với kho lưu trữ của Gateway từ xa.
