---
summary: "Cửa sổ ngữ cảnh + nén: cách OpenClaw giữ các phiên trong giới hạn của mô hình"
read_when:
  - Bạn muốn hiểu về tự động nén và /compact
  - Bạn đang gỡ lỗi các phiên dài chạm giới hạn ngữ cảnh
title: "Nén"
---

# Cửa sổ ngữ cảnh & Nén

Các cuộc trò chuyện dài tích lũy thông điệp và kết quả công cụ; khi cửa sổ trở nên chật, OpenClaw **nén (compacts)** lịch sử cũ để nằm trong giới hạn. Long-running chats accumulate messages and tool results; once the window is tight, OpenClaw **compacts** older history to stay within limits.

## Nén là gì

Compaction **summarizes older conversation** into a compact summary entry and keeps recent messages intact. The summary is stored in the session history, so future requests use:

- Bản tóm tắt nén
- Các tin nhắn gần đây sau điểm nén

Nén được **lưu bền vững** trong lịch sử JSONL của phiên.

## Cấu hình

Xem [Cấu hình & chế độ nén](/concepts/compaction) cho các thiết lập `agents.defaults.compaction`.

## Tự động nén (bật mặc định)

Khi một phiên tiến gần hoặc vượt quá cửa sổ ngữ cảnh của mô hình, OpenClaw kích hoạt tự động nén và có thể thử lại yêu cầu ban đầu bằng ngữ cảnh đã được nén.

Bạn sẽ thấy:

- `🧹 Auto-compaction complete` ở chế độ verbose
- `/status` hiển thị `🧹 Compactions: <count>`

Xem [Memory](/concepts/memory) để biết chi tiết và cấu hình. See [Memory](/concepts/memory) for details and config.

## Nén thủ công

Dùng `/compact` (tùy chọn kèm hướng dẫn) để buộc chạy một lượt nén:

```
/compact Focus on decisions and open questions
```

## Nguồn cửa sổ ngữ cảnh

Context window is model-specific. OpenClaw uses the model definition from the configured provider catalog to determine limits.

## Nén vs cắt tỉa

- **Nén**: tóm tắt và **lưu bền vững** vào JSONL.
- **Cắt tỉa phiên**: chỉ cắt bớt **kết quả công cụ** cũ, **trong bộ nhớ**, theo từng yêu cầu.

Xem [/concepts/session-pruning](/concepts/session-pruning) để biết chi tiết về cắt tỉa.

## Mẹo

- Dùng `/compact` khi phiên có cảm giác ì trệ hoặc ngữ cảnh bị phình to.
- Các đầu ra công cụ lớn đã được cắt ngắn sẵn; cắt tỉa có thể tiếp tục giảm sự tích tụ của kết quả công cụ.
- Nếu bạn cần bắt đầu lại từ đầu, `/new` hoặc `/reset` sẽ tạo một id phiên mới.
