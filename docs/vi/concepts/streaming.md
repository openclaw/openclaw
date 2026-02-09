---
summary: "Hành vi streaming + chunking (trả lời theo block, streaming bản nháp, giới hạn)"
read_when:
  - Giải thích cách streaming hoặc chunking hoạt động trên các kênh
  - Thay đổi hành vi streaming theo block hoặc chunking theo kênh
  - Gỡ lỗi việc trả lời block bị trùng/lệch sớm hoặc streaming bản nháp
title: "Streaming và Chunking"
---

# Streaming + chunking

OpenClaw có hai lớp “streaming” riêng biệt:

- **Block streaming (channels):** emit completed **blocks** as the assistant writes. Đây là các tin nhắn kênh thông thường (không phải token delta).
- **Streaming kiểu token (chỉ Telegram):** cập nhật một **bong bóng bản nháp** với văn bản từng phần trong khi tạo; tin nhắn cuối cùng được gửi ở cuối.

Hiện tại **không có streaming token thực sự** tới các tin nhắn kênh bên ngoài. Telegram draft streaming is the only partial-stream surface.

## Block streaming (tin nhắn kênh)

Block streaming gửi đầu ra của trợ lý theo các khối thô khi chúng sẵn sàng.

```
Model output
  └─ text_delta/events
       ├─ (blockStreamingBreak=text_end)
       │    └─ chunker emits blocks as buffer grows
       └─ (blockStreamingBreak=message_end)
            └─ chunker flushes at message_end
                   └─ channel send (block replies)
```

Legend:

- `text_delta/events`: sự kiện stream của mô hình (có thể thưa thớt với các mô hình không streaming).
- `chunker`: `EmbeddedBlockChunker` áp dụng ràng buộc min/max + ưu tiên điểm ngắt.
- `channel send`: các tin nhắn outbound thực tế (trả lời theo block).

**Điều khiển:**

- `agents.defaults.blockStreamingDefault`: `"on"`/`"off"` (mặc định tắt).
- Ghi đè theo kênh: `*.blockStreaming` (và các biến thể theo tài khoản) để buộc `"on"`/`"off"` theo từng kênh.
- `agents.defaults.blockStreamingBreak`: `"text_end"` hoặc `"message_end"`.
- `agents.defaults.blockStreamingChunk`: `{ minChars, maxChars, breakPreference?` }\`.
- `agents.defaults.blockStreamingCoalesce`: `{ minChars?, maxChars?, idleMs? }` (gộp các khối stream trước khi gửi).
- Giới hạn cứng theo kênh: `*.textChunkLimit` (ví dụ: `channels.whatsapp.textChunkLimit`).
- Chế độ chunk theo kênh: `*.chunkMode` (`length` mặc định, `newline` tách theo dòng trống (ranh giới đoạn) trước khi chunk theo độ dài).
- Giới hạn mềm của Discord: `channels.discord.maxLinesPerMessage` (mặc định 17) tách các trả lời cao để tránh UI bị cắt.

**Ngữ nghĩa ranh giới:**

- `text_end`: stream các block ngay khi bộ chunker phát ra; flush ở mỗi `text_end`.
- `message_end`: chờ đến khi thông điệp của trợ lý kết thúc, sau đó flush đầu ra đã đệm.

`message_end` vẫn dùng chunker nếu văn bản đệm vượt quá `maxChars`, vì vậy có thể phát ra nhiều chunk ở cuối.

## Thuật toán chunking (giới hạn thấp/cao)

Chunking theo block được triển khai bởi `EmbeddedBlockChunker`:

- **Giới hạn thấp:** không phát cho đến khi bộ đệm >= `minChars` (trừ khi bị ép).
- **Giới hạn cao:** ưu tiên tách trước `maxChars`; nếu bị ép, tách tại `maxChars`.
- **Ưu tiên điểm ngắt:** `paragraph` → `newline` → `sentence` → `whitespace` → ngắt cứng.
- **Khối mã:** không bao giờ tách bên trong fence; khi bị ép tại `maxChars`, đóng + mở lại fence để giữ Markdown hợp lệ.

`maxChars` bị kẹp theo `textChunkLimit` của kênh, nên bạn không thể vượt quá giới hạn theo kênh.

## Coalescing (gộp các block đã stream)

Khi bật block streaming, OpenClaw có thể **gộp các block chunk liên tiếp** trước khi gửi đi. This reduces “single-line spam” while still providing
progressive output.

- Coalescing chờ **khoảng trống nhàn rỗi** (`idleMs`) trước khi flush.
- Bộ đệm bị giới hạn bởi `maxChars` và sẽ flush nếu vượt quá.
- `minChars` ngăn các mảnh quá nhỏ được gửi cho đến khi tích lũy đủ văn bản
  (flush cuối luôn gửi phần văn bản còn lại).
- Ký tự nối được suy ra từ `blockStreamingChunk.breakPreference`
  (`paragraph` → `\n\n`, `newline` → `\n`, `sentence` → dấu cách).
- Có ghi đè theo kênh qua `*.blockStreamingCoalesce` (bao gồm cấu hình theo từng tài khoản).
- `minChars` gộp mặc định được nâng lên 1500 cho Signal/Slack/Discord trừ khi bị ghi đè.

## Nhịp điệu giống con người giữa các block

Khi bật block streaming, bạn có thể thêm **khoảng dừng ngẫu nhiên** giữa các phản hồi block (sau block đầu tiên). Điều này khiến các phản hồi nhiều bong bóng
trông tự nhiên hơn.

- Cấu hình: `agents.defaults.humanDelay` (ghi đè theo tác tử qua `agents.list[].humanDelay`).
- Chế độ: `off` (mặc định), `natural` (800–2500ms), `custom` (`minMs`/`maxMs`).
- Chỉ áp dụng cho **trả lời theo block**, không áp dụng cho trả lời cuối hoặc tóm tắt công cụ.

## “Stream từng chunk hay gửi tất cả”

Ánh xạ như sau:

- **Stream chunks:** `blockStreamingDefault: "on"` + `blockStreamingBreak: "text_end"` (emit as you go). Các kênh không phải Telegram cũng cần `*.blockStreaming: true`.
- **Stream tất cả ở cuối:** `blockStreamingBreak: "message_end"` (flush một lần, có thể nhiều chunk nếu rất dài).
- **Không block streaming:** `blockStreamingDefault: "off"` (chỉ trả lời cuối).

**Channel note:** For non-Telegram channels, block streaming is **off unless**
`*.blockStreaming` is explicitly set to `true`. Telegram can stream drafts
(`channels.telegram.streamMode`) without block replies.

Nhắc vị trí cấu hình: các mặc định `blockStreaming*` nằm dưới
`agents.defaults`, không phải cấu hình gốc.

## Streaming bản nháp Telegram (kiểu token)

Telegram là kênh duy nhất có streaming bản nháp:

- Dùng Bot API `sendMessageDraft` trong **chat riêng với chủ đề**.
- `channels.telegram.streamMode: "partial" | "block" | "off"`.
  - `partial`: cập nhật bản nháp với văn bản stream mới nhất.
  - `block`: cập nhật bản nháp theo các block đã chunk (cùng quy tắc chunker).
  - `off`: không streaming bản nháp.
- Cấu hình chunk cho bản nháp (chỉ cho `streamMode: "block"`): `channels.telegram.draftChunk` (mặc định: `minChars: 200`, `maxChars: 800`).
- Streaming bản nháp tách biệt với block streaming; trả lời theo block tắt theo mặc định và chỉ được bật bởi `*.blockStreaming: true` trên các kênh không phải Telegram.
- Trả lời cuối vẫn là một tin nhắn bình thường.
- `/reasoning stream` ghi reasoning vào bong bóng bản nháp (chỉ Telegram).

Khi streaming bản nháp đang hoạt động, OpenClaw vô hiệu hóa block streaming cho lượt trả lời đó để tránh streaming kép.

```
Telegram (private + topics)
  └─ sendMessageDraft (draft bubble)
       ├─ streamMode=partial → update latest text
       └─ streamMode=block   → chunker updates draft
  └─ final reply → normal message
```

Legend:

- `sendMessageDraft`: bong bóng bản nháp Telegram (không phải tin nhắn thật).
- `final reply`: gửi tin nhắn Telegram bình thường.
