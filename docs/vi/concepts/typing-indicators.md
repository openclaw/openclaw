---
summary: "Khi nào OpenClaw hiển thị chỉ báo đang gõ và cách tinh chỉnh chúng"
read_when:
  - Thay đổi hành vi hoặc giá trị mặc định của chỉ báo đang gõ
title: "Chỉ báo đang gõ"
---

# Chỉ báo đang gõ

Sử dụng
`agents.defaults.typingMode` để kiểm soát **khi nào** bắt đầu gõ và `typingIntervalSeconds`
để kiểm soát **tần suất** làm mới. `thinking` chỉ kích hoạt nếu lần chạy stream lập luận (`reasoningLevel: "stream"`).

## Mặc định

Khi `agents.defaults.typingMode` **chưa được đặt**, OpenClaw giữ hành vi cũ:

- **Chat trực tiếp**: bắt đầu hiển thị đang gõ ngay khi vòng lặp mô hình bắt đầu.
- **Chat nhóm có đề cập**: bắt đầu hiển thị đang gõ ngay.
- **Chat nhóm không có đề cập**: chỉ bắt đầu hiển thị đang gõ khi văn bản tin nhắn bắt đầu stream.
- **Run heartbeat**: tắt hiển thị đang gõ.

## Chế độ

Đặt `agents.defaults.typingMode` thành một trong các giá trị:

- `never` — không hiển thị chỉ báo đang gõ, trong mọi trường hợp.
- `instant` — bắt đầu hiển thị đang gõ **ngay khi vòng lặp mô hình bắt đầu**, kể cả khi run
  sau đó chỉ trả về token phản hồi im lặng.
- `thinking` — bắt đầu hiển thị đang gõ ở **delta suy luận đầu tiên** (yêu cầu
  `reasoningLevel: "stream"` cho run).
- `message` — bắt đầu hiển thị đang gõ ở **delta văn bản không im lặng đầu tiên** (bỏ qua
  token im lặng `NO_REPLY`).

Thứ tự theo “mức độ sớm khi kích hoạt”:
`never` → `message` → `thinking` → `instant`

## Cấu hình

```json5
{
  agent: {
    typingMode: "thinking",
    typingIntervalSeconds: 6,
  },
}
```

Bạn có thể ghi đè chế độ hoặc nhịp làm mới theo từng phiên:

```json5
{
  session: {
    typingMode: "message",
    typingIntervalSeconds: 4,
  },
}
```

## Ghi chú

- Chế độ `message` sẽ không hiển thị đang gõ cho các phản hồi chỉ có im lặng (ví dụ token
  `NO_REPLY` dùng để chặn đầu ra).
- Nếu mô hình không phát ra các delta lập luận, việc gõ sẽ không bắt đầu.
  `typingIntervalSeconds` kiểm soát **nhịp làm mới**, không phải thời điểm bắt đầu.
- Heartbeat không bao giờ hiển thị đang gõ, bất kể chế độ nào.
- Mặc định là 6 giây.
  `/status` trong chat: thẻ trạng thái giàu emoji với token phiên + chi phí ước tính (chỉ API key).
