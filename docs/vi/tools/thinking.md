---
summary: "Cú pháp chỉ thị cho /think + /verbose và cách chúng ảnh hưởng đến suy luận của mô hình"
read_when:
  - Điều chỉnh việc phân tích hoặc giá trị mặc định của chỉ thị thinking hoặc verbose
title: "Các mức Thinking"
---

# Các mức Thinking (chỉ thị /think)

## Chức năng

- Chỉ thị nội tuyến trong bất kỳ nội dung gửi vào nào: `/t <level>`, `/think:<level>`, hoặc `/thinking <level>`.
- Các mức (bí danh): `off | minimal | low | medium | high | xhigh` (chỉ dành cho mô hình GPT-5.2 + Codex)
  - minimal → “think”
  - low → “think hard”
  - medium → “think harder”
  - high → “ultrathink” (ngân sách tối đa)
  - xhigh → “ultrathink+” (chỉ dành cho mô hình GPT-5.2 + Codex)
  - `x-high`, `x_high`, `extra-high`, `extra high`, và `extra_high` ánh xạ tới `xhigh`.
  - `highest`, `max` ánh xạ tới `high`.
- Ghi chú theo nhà cung cấp:
  - Z.AI (`zai/*`) only supports binary thinking (`on`/`off`). Any non-`off` level is treated as `on` (mapped to `low`).

## Thứ tự phân giải

1. Chỉ thị nội tuyến trên tin nhắn (chỉ áp dụng cho tin nhắn đó).
2. Ghi đè theo phiên (đặt bằng cách gửi một tin nhắn chỉ chứa chỉ thị).
3. Mặc định toàn cục (`agents.defaults.thinkingDefault` trong cấu hình).
4. Dự phòng: low cho các mô hình có khả năng suy luận; tắt cho các mô hình khác.

## Thiết lập mặc định theo phiên

- Gửi một tin nhắn **chỉ** gồm chỉ thị (cho phép khoảng trắng), ví dụ: `/think:medium` hoặc `/t high`.
- Thiết lập này được giữ cho phiên hiện tại (mặc định theo từng người gửi); được xóa bởi `/think:off` hoặc khi phiên bị reset do nhàn rỗi.
- Confirmation reply is sent (`Thinking level set to high.` / `Thinking disabled.`). If the level is invalid (e.g. `/thinking big`), the command is rejected with a hint and the session state is left unchanged.
- Gửi `/think` (hoặc `/think:`) không kèm đối số để xem mức thinking hiện tại.

## Áp dụng theo tác tử

- **Pi nhúng**: mức đã phân giải được truyền vào runtime tác tử Pi trong tiến trình.

## Chỉ thị verbose (/verbose hoặc /v)

- Các mức: `on` (tối thiểu) | `full` | `off` (mặc định).
- Tin nhắn chỉ chứa chỉ thị sẽ bật/tắt verbose theo phiên và phản hồi `Verbose logging enabled.` / `Verbose logging disabled.`; mức không hợp lệ trả về gợi ý mà không thay đổi trạng thái.
- `/verbose off` lưu một ghi đè theo phiên rõ ràng; xóa bằng UI Sessions bằng cách chọn `inherit`.
- Chỉ thị nội tuyến chỉ ảnh hưởng đến tin nhắn đó; mặc định theo phiên/toàn cục áp dụng cho các trường hợp khác.
- Gửi `/verbose` (hoặc `/verbose:`) không kèm đối số để xem mức verbose hiện tại.
- When verbose is on, agents that emit structured tool results (Pi, other JSON agents) send each tool call back as its own metadata-only message, prefixed with `<emoji> <tool-name>: <arg>` when available (path/command). These tool summaries are sent as soon as each tool starts (separate bubbles), not as streaming deltas.
- When verbose is `full`, tool outputs are also forwarded after completion (separate bubble, truncated to a safe length). If you toggle `/verbose on|full|off` while a run is in-flight, subsequent tool bubbles honor the new setting.

## Hiển thị suy luận (/reasoning)

- Các mức: `on|off|stream`.
- Tin nhắn chỉ chứa chỉ thị sẽ bật/tắt việc hiển thị các khối thinking trong phản hồi.
- Khi được bật, suy luận được gửi như một **tin nhắn riêng** với tiền tố `Reasoning:`.
- `stream` (chỉ Telegram): stream suy luận vào bong bóng nháp Telegram trong khi phản hồi đang tạo, sau đó gửi câu trả lời cuối cùng không kèm suy luận.
- Bí danh: `/reason`.
- Gửi `/reasoning` (hoặc `/reasoning:`) không kèm đối số để xem mức suy luận hiện tại.

## Liên quan

- Tài liệu về Elevated mode nằm tại [Elevated mode](/tools/elevated).

## Heartbeats

- Heartbeat probe body is the configured heartbeat prompt (default: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Inline directives in a heartbeat message apply as usual (but avoid changing session defaults from heartbeats).
- Heartbeat delivery defaults to the final payload only. To also send the separate `Reasoning:` message (when available), set `agents.defaults.heartbeat.includeReasoning: true` or per-agent `agents.list[].heartbeat.includeReasoning: true`.

## Giao diện web chat

- Bộ chọn thinking trên web chat phản chiếu mức đã lưu của phiên từ kho phiên/cấu hình đầu vào khi trang tải.
- Chọn một mức khác chỉ áp dụng cho tin nhắn kế tiếp (`thinkingOnce`); sau khi gửi, bộ chọn sẽ quay lại mức đã lưu của phiên.
- Để thay đổi mặc định theo phiên, gửi một chỉ thị `/think:<level>` (như trước); bộ chọn sẽ phản ánh sau lần tải lại tiếp theo.
