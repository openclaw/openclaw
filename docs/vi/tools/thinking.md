---
summary: "Cú pháp chỉ thị cho /think + /verbose và cách chúng ảnh hưởng đến suy luận của mô hình"
read_when:
  - Điều chỉnh việc phân tích hoặc giá trị mặc định của chỉ thị thinking hoặc verbose
title: "Các mức Thinking"
x-i18n:
  source_path: tools/thinking.md
  source_hash: 0ae614147675be32
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:35Z
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
  - Z.AI (`zai/*`) chỉ hỗ trợ thinking nhị phân (`on`/`off`). Bất kỳ mức không phải `off` đều được coi là `on` (ánh xạ tới `low`).

## Thứ tự phân giải

1. Chỉ thị nội tuyến trên tin nhắn (chỉ áp dụng cho tin nhắn đó).
2. Ghi đè theo phiên (đặt bằng cách gửi một tin nhắn chỉ chứa chỉ thị).
3. Mặc định toàn cục (`agents.defaults.thinkingDefault` trong cấu hình).
4. Dự phòng: low cho các mô hình có khả năng suy luận; tắt cho các mô hình khác.

## Thiết lập mặc định theo phiên

- Gửi một tin nhắn **chỉ** gồm chỉ thị (cho phép khoảng trắng), ví dụ: `/think:medium` hoặc `/t high`.
- Thiết lập này được giữ cho phiên hiện tại (mặc định theo từng người gửi); được xóa bởi `/think:off` hoặc khi phiên bị reset do nhàn rỗi.
- Có phản hồi xác nhận (`Thinking level set to high.` / `Thinking disabled.`). Nếu mức không hợp lệ (ví dụ: `/thinking big`), lệnh sẽ bị từ chối kèm gợi ý và trạng thái phiên không thay đổi.
- Gửi `/think` (hoặc `/think:`) không kèm đối số để xem mức thinking hiện tại.

## Áp dụng theo tác tử

- **Pi nhúng**: mức đã phân giải được truyền vào runtime tác tử Pi trong tiến trình.

## Chỉ thị verbose (/verbose hoặc /v)

- Các mức: `on` (tối thiểu) | `full` | `off` (mặc định).
- Tin nhắn chỉ chứa chỉ thị sẽ bật/tắt verbose theo phiên và phản hồi `Verbose logging enabled.` / `Verbose logging disabled.`; mức không hợp lệ trả về gợi ý mà không thay đổi trạng thái.
- `/verbose off` lưu một ghi đè theo phiên rõ ràng; xóa bằng UI Sessions bằng cách chọn `inherit`.
- Chỉ thị nội tuyến chỉ ảnh hưởng đến tin nhắn đó; mặc định theo phiên/toàn cục áp dụng cho các trường hợp khác.
- Gửi `/verbose` (hoặc `/verbose:`) không kèm đối số để xem mức verbose hiện tại.
- Khi verbose bật, các tác tử phát ra kết quả công cụ có cấu trúc (Pi, các tác tử JSON khác) gửi lại mỗi lần gọi công cụ như một tin nhắn chỉ chứa metadata, với tiền tố `<emoji> <tool-name>: <arg>` khi có (đường dẫn/lệnh). Các tóm tắt công cụ này được gửi ngay khi mỗi công cụ bắt đầu (bong bóng riêng), không phải là delta streaming.
- Khi verbose ở mức `full`, đầu ra công cụ cũng được chuyển tiếp sau khi hoàn tất (bong bóng riêng, bị cắt ngắn đến độ dài an toàn). Nếu bạn bật/tắt `/verbose on|full|off` khi một lượt chạy đang diễn ra, các bong bóng công cụ tiếp theo sẽ tuân theo thiết lập mới.

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

- Nội dung thăm dò heartbeat là prompt heartbeat đã cấu hình (mặc định: `Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.`). Các chỉ thị nội tuyến trong một tin nhắn heartbeat áp dụng như bình thường (nhưng tránh thay đổi mặc định theo phiên từ heartbeat).
- Việc gửi heartbeat mặc định chỉ gửi payload cuối cùng. Để đồng thời gửi tin nhắn `Reasoning:` riêng (khi có), đặt `agents.defaults.heartbeat.includeReasoning: true` hoặc theo từng tác tử `agents.list[].heartbeat.includeReasoning: true`.

## Giao diện web chat

- Bộ chọn thinking trên web chat phản chiếu mức đã lưu của phiên từ kho phiên/cấu hình đầu vào khi trang tải.
- Chọn một mức khác chỉ áp dụng cho tin nhắn kế tiếp (`thinkingOnce`); sau khi gửi, bộ chọn sẽ quay lại mức đã lưu của phiên.
- Để thay đổi mặc định theo phiên, gửi một chỉ thị `/think:<level>` (như trước); bộ chọn sẽ phản ánh sau lần tải lại tiếp theo.
