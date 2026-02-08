---
summary: "Luồng thông điệp, phiên, xếp hàng và khả năng hiển thị lập luận"
read_when:
  - Giải thích cách thông điệp đến trở thành phản hồi
  - Làm rõ phiên, chế độ xếp hàng hoặc hành vi streaming
  - Tài liệu hóa khả năng hiển thị lập luận và các tác động khi sử dụng
title: "Thông điệp"
x-i18n:
  source_path: concepts/messages.md
  source_hash: 773301d5c0c1e3b8
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:45Z
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
- Ghi đè theo kênh (`channels.whatsapp.*`, `channels.telegram.*`, v.v.) cho giới hạn và công tắc streaming.

Xem [Cấu hình](/gateway/configuration) để biết đầy đủ lược đồ.

## Khử trùng lặp thông điệp đến

Các kênh có thể gửi lại cùng một thông điệp sau khi kết nối lại. OpenClaw giữ một
bộ nhớ đệm ngắn hạn theo khóa kênh/tài khoản/đối tác/phiên/id thông điệp để các lần gửi trùng
không kích hoạt một lần chạy tác tử khác.

## Chống dội thông điệp đến

Các thông điệp liên tiếp nhanh từ **cùng một người gửi** có thể được gom thành một lượt
tác tử duy nhất thông qua `messages.inbound`. Chống dội được áp dụng theo phạm vi kênh + cuộc trò chuyện
và dùng thông điệp gần nhất cho luồng trả lời/ID.

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

Nhiều thiết bị/kênh có thể ánh xạ tới cùng một phiên, nhưng lịch sử không được
đồng bộ đầy đủ về mọi client. Khuyến nghị: dùng một thiết bị chính cho các cuộc
trò chuyện dài để tránh ngữ cảnh bị lệch. Control UI và TUI luôn hiển thị bản ghi
phiên do gateway lưu trữ, nên chúng là nguồn sự thật.

Chi tiết: [Quản lý phiên](/concepts/session).

## Nội dung thông điệp đến và ngữ cảnh lịch sử

OpenClaw tách **phần nội dung prompt** khỏi **phần nội dung lệnh**:

- `Body`: văn bản prompt gửi tới tác tử. Có thể bao gồm phong bì kênh và
  các wrapper lịch sử tùy chọn.
- `CommandBody`: văn bản thô của người dùng để phân tích chỉ thị/lệnh.
- `RawBody`: bí danh kế thừa của `CommandBody` (giữ để tương thích).

Khi kênh cung cấp lịch sử, nó dùng một wrapper chung:

- `[Chat messages since your last reply - for context]`
- `[Current message - respond to this]`

Đối với **không phải trò chuyện trực tiếp** (nhóm/kênh/phòng), **nội dung thông điệp hiện tại**
được thêm tiền tố nhãn người gửi (cùng kiểu dùng cho các mục lịch sử). Điều này
giữ cho thông điệp thời gian thực và thông điệp xếp hàng/lịch sử nhất quán trong prompt của tác tử.

Bộ đệm lịch sử là **chỉ-đang-chờ**: chúng bao gồm các thông điệp nhóm _không_
kích hoạt một lần chạy (ví dụ, thông điệp bị chặn theo đề cập) và **loại trừ** các thông điệp
đã có trong bản ghi phiên.

Việc loại bỏ chỉ thị chỉ áp dụng cho phần **thông điệp hiện tại** để lịch sử
giữ nguyên. Các kênh bọc lịch sử nên đặt `CommandBody` (hoặc
`RawBody`) thành văn bản thông điệp gốc và giữ `Body` là prompt đã kết hợp.
Bộ đệm lịch sử có thể cấu hình qua `messages.groupChat.historyLimit` (mặc định
toàn cục) và các ghi đè theo kênh như `channels.slack.historyLimit` hoặc
`channels.telegram.accounts.<id>.historyLimit` (đặt `0` để tắt).

## Xếp hàng và lượt theo sau

Nếu một lần chạy đã hoạt động, các thông điệp đến có thể được xếp hàng, điều hướng
vào lần chạy hiện tại, hoặc thu thập cho một lượt theo sau.

- Cấu hình qua `messages.queue` (và `messages.queue.byChannel`).
- Các chế độ: `interrupt`, `steer`, `followup`, `collect`, cùng các biến thể backlog.

Chi tiết: [Xếp hàng](/concepts/queue).

## Streaming, chia khối và gom lô

Streaming theo khối gửi các phản hồi từng phần khi mô hình tạo ra các khối văn bản.
Chia khối tôn trọng giới hạn văn bản của kênh và tránh tách code được rào.

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

- `messages.responsePrefix`, `channels.<channel>.responsePrefix` và `channels.<channel>.accounts.<id>.responsePrefix` (chuỗi tiền tố gửi đi), cùng `channels.whatsapp.messagePrefix` (tiền tố đến của WhatsApp)
- Luồng trả lời thông qua `replyToMode` và mặc định theo kênh

Chi tiết: [Cấu hình](/gateway/configuration#messages) và tài liệu kênh.
