---
summary: "Cửa sổ ngữ cảnh + nén: cách OpenClaw giữ các phiên trong giới hạn của mô hình"
read_when:
  - Bạn muốn hiểu về tự động nén và /compact
  - Bạn đang gỡ lỗi các phiên dài chạm giới hạn ngữ cảnh
title: "Nén"
x-i18n:
  source_path: concepts/compaction.md
  source_hash: e1d6791f2902044b
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:31Z
---

# Cửa sổ ngữ cảnh & Nén

Mỗi mô hình đều có **cửa sổ ngữ cảnh** (số token tối đa mà nó có thể thấy). Các cuộc trò chuyện chạy lâu sẽ tích lũy tin nhắn và kết quả công cụ; khi cửa sổ trở nên chật chội, OpenClaw sẽ **nén** lịch sử cũ để giữ trong giới hạn.

## Nén là gì

Nén **tóm tắt các đoạn hội thoại cũ hơn** thành một mục tóm tắt gọn và giữ nguyên các tin nhắn gần đây. Bản tóm tắt được lưu trong lịch sử phiên, vì vậy các yêu cầu tiếp theo sẽ sử dụng:

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

Trước khi nén, OpenClaw có thể chạy một lượt **xả bộ nhớ im lặng** để lưu
các ghi chú bền vững xuống đĩa. Xem [Memory](/concepts/memory) để biết chi tiết và cấu hình.

## Nén thủ công

Dùng `/compact` (tùy chọn kèm hướng dẫn) để buộc chạy một lượt nén:

```
/compact Focus on decisions and open questions
```

## Nguồn cửa sổ ngữ cảnh

Cửa sổ ngữ cảnh phụ thuộc vào từng mô hình. OpenClaw sử dụng định nghĩa mô hình từ danh mục nhà cung cấp đã cấu hình để xác định các giới hạn.

## Nén vs cắt tỉa

- **Nén**: tóm tắt và **lưu bền vững** vào JSONL.
- **Cắt tỉa phiên**: chỉ cắt bớt **kết quả công cụ** cũ, **trong bộ nhớ**, theo từng yêu cầu.

Xem [/concepts/session-pruning](/concepts/session-pruning) để biết chi tiết về cắt tỉa.

## Mẹo

- Dùng `/compact` khi phiên có cảm giác ì trệ hoặc ngữ cảnh bị phình to.
- Các đầu ra công cụ lớn đã được cắt ngắn sẵn; cắt tỉa có thể tiếp tục giảm sự tích tụ của kết quả công cụ.
- Nếu bạn cần bắt đầu lại từ đầu, `/new` hoặc `/reset` sẽ tạo một id phiên mới.
