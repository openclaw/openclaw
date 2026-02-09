---
summary: "Luồng thông điệp, phiên, xếp hàng và khả năng hiển thị lập luận"
read_when:
  - Giải thích cách thông điệp đến trở thành phản hồi
  - Làm rõ phiên, chế độ xếp hàng hoặc hành vi streaming
  - Tài liệu hóa khả năng hiển thị lập luận và các tác động khi sử dụng
title: "Thông điệp"
---

# Thông điệp

Trang này liên kết cách OpenClaw xử lý thông điệp đến, phiên, xếp hàng,
streaming và khả năng hiển thị lập luận.

## Luồng thông điệp (tổng quan)

```
Inbound message
  -> routing/bindings -> session key
  -> queue (if a run is active)
  -> agent run (streaming + tools)
  -> outbound replies (channel limits + chunking)
```

Các nút điều chỉnh chính nằm trong cấu hình:

- `messages.*` cho tiền tố, xếp hàng và hành vi nhóm.
- `agents.defaults.*` cho streaming theo khối và mặc định chia khối.
- Ghi đè theo kênh (`channels.whatsapp.*`, `channels.telegram.*`, v.v.) cho các giới hạn (caps) và công tắc streaming.

Xem [Cấu hình](/gateway/configuration) để biết đầy đủ lược đồ.

## Khử trùng lặp thông điệp đến

Channels can redeliver the same message after reconnects. OpenClaw keeps a
short-lived cache keyed by channel/account/peer/session/message id so duplicate
deliveries do not trigger another agent run.

## Chống dội thông điệp đến

Các tin nhắn liên tiếp nhanh từ **cùng một người gửi** có thể được gom lại thành một
lượt agent duy nhất thông qua `messages.inbound`. Debouncing is scoped per channel + conversation
and uses the most recent message for reply threading/IDs.

Cấu hình (mặc định toàn cục + ghi đè theo kênh):

```json5
{
  messages: {
    inbound: {
      debounceMs: 2000,
      byChannel: {
        whatsapp: 5000,
        slack: 1500,
        discord: 1500,
      },
    },
  },
}
```

Ghi chú:

- Chống dội áp dụng cho **chỉ văn bản**; media/tệp đính kèm sẽ xả ngay.
- Lệnh điều khiển bỏ qua chống dội để luôn là các mục độc lập.

## Phiên và thiết bị

Phiên thuộc về gateway, không phải client.

- Trò chuyện trực tiếp gộp vào khóa phiên chính của tác tử.
- Nhóm/kênh có khóa phiên riêng.
- Kho phiên và bản ghi hội thoại nằm trên máy chủ gateway.

Nhiều thiết bị/kênh có thể ánh xạ tới cùng một session, nhưng lịch sử không được đồng bộ đầy đủ trở lại mọi client. Recommendation: use one primary device for long
conversations to avoid divergent context. The Control UI and TUI always show the
gateway-backed session transcript, so they are the source of truth.

Chi tiết: [Quản lý phiên](/concepts/session).

## Nội dung thông điệp đến và ngữ cảnh lịch sử

OpenClaw tách **phần nội dung prompt** khỏi **phần nội dung lệnh**:

- `Body`: prompt text sent to the agent. This may include channel envelopes and
  optional history wrappers.
- `CommandBody`: văn bản thô của người dùng để phân tích chỉ thị/lệnh.
- `RawBody`: bí danh kế thừa của `CommandBody` (giữ để tương thích).

Khi kênh cung cấp lịch sử, nó dùng một wrapper chung:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

For **non-direct chats** (groups/channels/rooms), the **current message body** is prefixed with the
sender label (same style used for history entries). Điều này giữ cho các tin nhắn thời gian thực và các tin nhắn xếp hàng/lịch sử
nhất quán trong prompt của agent.

Bộ đệm lịch sử là **chỉ-đang-chờ**: chúng bao gồm các thông điệp nhóm _không_
kích hoạt một lần chạy (ví dụ, thông điệp bị chặn theo đề cập) và **loại trừ** các thông điệp
đã có trong bản ghi phiên.

Việc loại bỏ directive chỉ áp dụng cho phần **current message** nên lịch sử vẫn được giữ nguyên. `messages.responsePrefix`, `channels.<channel>`
Bộ đệm lịch sử có thể cấu hình qua `messages.groupChat.historyLimit` (mặc định toàn cục) và các ghi đè theo channel như `channels.slack.historyLimit` hoặc `channels.telegram.accounts.<id>`.historyLimit`(đặt`0\` để vô hiệu hóa).

## Xếp hàng và lượt theo sau

Nếu một lần chạy đã hoạt động, các thông điệp đến có thể được xếp hàng, điều hướng
vào lần chạy hiện tại, hoặc thu thập cho một lượt theo sau.

- Cấu hình qua `messages.queue` (và `messages.queue.byChannel`).
- Các chế độ: `interrupt`, `steer`, `followup`, `collect`, cùng các biến thể backlog.

Chi tiết: [Xếp hàng](/concepts/queue).

## Streaming, chia khối và gom lô

Block streaming sends partial replies as the model produces text blocks.
Chunking respects channel text limits and avoids splitting fenced code.

Các thiết lập chính:

- `agents.defaults.blockStreamingDefault` (`on|off`, mặc định tắt)
- `agents.defaults.blockStreamingBreak` (`text_end|message_end`)
- `agents.defaults.blockStreamingChunk` (`minChars|maxChars|breakPreference`)
- `agents.defaults.blockStreamingCoalesce` (gom lô dựa trên thời gian nhàn rỗi)
- `agents.defaults.humanDelay` (tạm dừng giống con người giữa các khối phản hồi)
- Ghi đè theo kênh: `*.blockStreaming` và `*.blockStreamingCoalesce` (các kênh không phải Telegram yêu cầu đặt rõ `*.blockStreaming: true`)

Chi tiết: [Streaming + chia khối](/concepts/streaming).

## Khả năng hiển thị lập luận và token

OpenClaw có thể hiển thị hoặc ẩn lập luận của mô hình:

- `/reasoning on|off|stream` kiểm soát khả năng hiển thị.
- Nội dung lập luận vẫn được tính vào mức sử dụng token khi mô hình tạo ra.
- Telegram hỗ trợ streaming lập luận vào bong bóng bản nháp.

Chi tiết: [Chỉ thị suy nghĩ + lập luận](/tools/thinking) và [Sử dụng token](/reference/token-use).

## Tiền tố, luồng hội thoại và trả lời

Định dạng thông điệp gửi đi được tập trung trong `messages`:

- `type: "oauth"` → `{ provider, access, refresh, expires, email?`.responsePrefix`, và `channels.<channel>`.accounts.<id>`.responsePrefix`(chuỗi tiền tố outbound theo cơ chế cascade), cùng với`channels.whatsapp.messagePrefix\` (tiền tố inbound của WhatsApp)
- Luồng trả lời thông qua `replyToMode` và mặc định theo kênh

Chi tiết: [Cấu hình](/gateway/configuration#messages) và tài liệu kênh.
