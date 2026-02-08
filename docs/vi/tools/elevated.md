---
summary: "Chế độ exec nâng cao và các chỉ thị /elevated"
read_when:
  - Điều chỉnh mặc định chế độ elevated, allowlist hoặc hành vi lệnh gạch chéo
title: "Chế độ Elevated"
x-i18n:
  source_path: tools/elevated.md
  source_hash: 83767a0160930402
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:40:29Z
---

# Chế độ Elevated (chỉ thị /elevated)

## Nó làm gì

- `/elevated on` chạy trên máy chủ gateway và giữ các phê duyệt exec (giống như `/elevated ask`).
- `/elevated full` chạy trên máy chủ gateway **và** tự động phê duyệt exec (bỏ qua phê duyệt exec).
- `/elevated ask` chạy trên máy chủ gateway nhưng vẫn giữ phê duyệt exec (giống như `/elevated on`).
- `on`/`ask` **không** buộc `exec.security=full`; chính sách bảo mật/hỏi vẫn được áp dụng.
- Chỉ thay đổi hành vi khi tác tử ở trạng thái **sandboxed** (nếu không thì exec vốn đã chạy trên host).
- Các dạng chỉ thị: `/elevated on|off|ask|full`, `/elev on|off|ask|full`.
- Chỉ chấp nhận `on|off|ask|full`; mọi thứ khác trả về gợi ý và không thay đổi trạng thái.

## Nó kiểm soát gì (và không kiểm soát gì)

- **Cổng khả dụng**: `tools.elevated` là đường cơ sở toàn cục. `agents.list[].tools.elevated` có thể hạn chế elevated theo từng tác tử (cả hai đều phải cho phép).
- **Trạng thái theo phiên**: `/elevated on|off|ask|full` đặt mức elevated cho khóa phiên hiện tại.
- **Chỉ thị nội tuyến**: `/elevated on|ask|full` bên trong một tin nhắn chỉ áp dụng cho tin nhắn đó.
- **Nhóm**: Trong chat nhóm, chỉ thị elevated chỉ được tôn trọng khi tác tử được nhắc đến. Các tin nhắn chỉ chứa lệnh bỏ qua yêu cầu nhắc đến được coi là đã nhắc đến.
- **Thực thi trên host**: elevated buộc `exec` lên máy chủ gateway; `full` cũng đặt `security=full`.
- **Phê duyệt**: `full` bỏ qua phê duyệt exec; `on`/`ask` vẫn tuân theo khi các quy tắc allowlist/hỏi yêu cầu.
- **Tác tử không sandboxed**: không tác động đến vị trí; chỉ ảnh hưởng đến gating, logging và trạng thái.
- **Chính sách công cụ vẫn áp dụng**: nếu `exec` bị từ chối bởi chính sách công cụ, elevated không thể được dùng.
- **Tách biệt với `/exec`**: `/exec` điều chỉnh mặc định theo phiên cho người gửi được ủy quyền và không yêu cầu elevated.

## Thứ tự phân giải

1. Chỉ thị nội tuyến trong tin nhắn (chỉ áp dụng cho tin nhắn đó).
2. Ghi đè theo phiên (được đặt bằng cách gửi một tin nhắn chỉ chứa chỉ thị).
3. Mặc định toàn cục (`agents.defaults.elevatedDefault` trong cấu hình).

## Đặt mặc định cho một phiên

- Gửi một tin nhắn **chỉ** chứa chỉ thị (cho phép khoảng trắng), ví dụ: `/elevated full`.
- Có phản hồi xác nhận (`Elevated mode set to full...` / `Elevated mode disabled.`).
- Nếu quyền elevated bị vô hiệu hóa hoặc người gửi không nằm trong allowlist được phê duyệt, chỉ thị sẽ trả về lỗi có thể hành động và không thay đổi trạng thái phiên.
- Gửi `/elevated` (hoặc `/elevated:`) không kèm đối số để xem mức elevated hiện tại.

## Khả dụng + allowlists

- Cổng tính năng: `tools.elevated.enabled` (mặc định có thể tắt qua cấu hình ngay cả khi mã hỗ trợ).
- Allowlist người gửi: `tools.elevated.allowFrom` với allowlist theo từng nhà cung cấp (ví dụ: `discord`, `whatsapp`).
- Cổng theo tác tử: `agents.list[].tools.elevated.enabled` (tùy chọn; chỉ có thể hạn chế thêm).
- Allowlist theo tác tử: `agents.list[].tools.elevated.allowFrom` (tùy chọn; khi đặt, người gửi phải khớp **cả** allowlist toàn cục + theo tác tử).
- Dự phòng cho Discord: nếu `tools.elevated.allowFrom.discord` bị bỏ qua, danh sách `channels.discord.dm.allowFrom` được dùng làm dự phòng. Đặt `tools.elevated.allowFrom.discord` (kể cả `[]`) để ghi đè. Allowlist theo tác tử **không** dùng cơ chế dự phòng.
- Tất cả các cổng phải vượt qua; nếu không elevated được coi là không khả dụng.

## Logging + trạng thái

- Các lệnh exec elevated được ghi log ở mức info.
- Trạng thái phiên bao gồm chế độ elevated (ví dụ: `elevated=ask`, `elevated=full`).
