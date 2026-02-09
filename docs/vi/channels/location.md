---
summary: "Phân tích vị trí kênh đến (Telegram + WhatsApp) và các trường ngữ cảnh"
read_when:
  - Thêm hoặc chỉnh sửa phân tích vị trí của kênh
  - Sử dụng các trường ngữ cảnh vị trí trong prompt hoặc công cụ của tác tử
title: "Phân tích vị trí kênh"
---

# Phân tích vị trí kênh

OpenClaw chuẩn hóa các vị trí được chia sẻ từ các kênh trò chuyện thành:

- văn bản dễ đọc được nối vào phần nội dung đến, và
- các trường có cấu trúc trong payload ngữ cảnh của phản hồi tự động.

Hiện đang hỗ trợ:

- **Telegram** (ghim vị trí + địa điểm + vị trí trực tiếp)
- **WhatsApp** (locationMessage + liveLocationMessage)
- **Matrix** (`m.location` với `geo_uri`)

## Định dạng văn bản

Vị trí được hiển thị thành các dòng thân thiện, không có dấu ngoặc:

- Ghim:
  - `📍 48.858844, 2.294351 ±12m`
- Địa điểm có tên:
  - `📍 Eiffel Tower — Champ de Mars, Paris (48.858844, 2.294351 ±12m)`
- Chia sẻ trực tiếp:
  - `🛰 Live location: 48.858844, 2.294351 ±12m`

Nếu kênh có chú thích/bình luận, nội dung đó sẽ được nối ở dòng tiếp theo:

```
📍 48.858844, 2.294351 ±12m
Meet here
```

## Các trường ngữ cảnh

Khi có vị trí, các trường sau được thêm vào `ctx`:

- `LocationLat` (number)
- `LocationLon` (number)
- `LocationAccuracy` (number, mét; tùy chọn)
- `LocationName` (string; tùy chọn)
- `LocationAddress` (string; tùy chọn)
- `LocationSource` (`pin | place | live`)
- `LocationIsLive` (boolean)

## Ghi chú theo kênh

- **Telegram**: địa điểm được ánh xạ tới `LocationName/LocationAddress`; vị trí trực tiếp dùng `live_period`.
- **WhatsApp**: `locationMessage.comment` và `liveLocationMessage.caption` được nối như dòng chú thích.
- **Matrix**: `geo_uri` được phân tích như vị trí ghim; độ cao bị bỏ qua và `LocationIsLive` luôn là false.
