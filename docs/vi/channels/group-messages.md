---
summary: "Hành vi và cấu hình cho việc xử lý tin nhắn nhóm WhatsApp (mentionPatterns được dùng chung trên các bề mặt)"
read_when:
  - Khi thay đổi quy tắc tin nhắn nhóm hoặc nhắc tên
title: "Tin nhắn nhóm"
x-i18n:
  source_path: channels/group-messages.md
  source_hash: 181a72f12f5021af
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:02Z
---

# Tin nhắn nhóm (kênh WhatsApp web)

Mục tiêu: cho phép Clawd tham gia các nhóm WhatsApp, chỉ thức dậy khi được ping, và giữ luồng đó tách biệt với phiên DM cá nhân.

Lưu ý: `agents.list[].groupChat.mentionPatterns` hiện cũng được dùng cho Telegram/Discord/Slack/iMessage; tài liệu này tập trung vào hành vi riêng của WhatsApp. Với thiết lập đa tác tử, hãy đặt `agents.list[].groupChat.mentionPatterns` theo từng tác tử (hoặc dùng `messages.groupChat.mentionPatterns` làm dự phòng toàn cục).

## Những gì đã triển khai (2025-12-03)

- Chế độ kích hoạt: `mention` (mặc định) hoặc `always`. `mention` yêu cầu một ping (nhắc @ thật của WhatsApp qua `mentionedJids`, các mẫu regex, hoặc số E.164 của bot xuất hiện ở bất kỳ đâu trong văn bản). `always` đánh thức tác tử với mọi tin nhắn nhưng chỉ nên trả lời khi có thể mang lại giá trị; nếu không thì trả về token im lặng `NO_REPLY`. Mặc định có thể đặt trong cấu hình (`channels.whatsapp.groups`) và ghi đè theo từng nhóm qua `/activation`. Khi đặt `channels.whatsapp.groups`, nó cũng hoạt động như một danh sách cho phép của nhóm (bao gồm `"*"` để cho phép tất cả).
- Chính sách nhóm: `channels.whatsapp.groupPolicy` kiểm soát việc có chấp nhận tin nhắn nhóm hay không (`open|disabled|allowlist`). `allowlist` sử dụng `channels.whatsapp.groupAllowFrom` (dự phòng: `channels.whatsapp.allowFrom` rõ ràng). Mặc định là `allowlist` (bị chặn cho đến khi bạn thêm người gửi).
- Phiên theo từng nhóm: khóa phiên có dạng `agent:<agentId>:whatsapp:group:<jid>` nên các lệnh như `/verbose on` hoặc `/think high` (gửi như tin nhắn độc lập) sẽ chỉ áp dụng trong phạm vi nhóm đó; trạng thái DM cá nhân không bị ảnh hưởng. Heartbeat bị bỏ qua cho các luồng nhóm.
- Tiêm ngữ cảnh: các tin nhắn nhóm **chưa xử lý** (mặc định 50) mà _không_ kích hoạt chạy sẽ được thêm tiền tố dưới `[Chat messages since your last reply - for context]`, với dòng kích hoạt nằm dưới `[Current message - respond to this]`. Các tin nhắn đã có trong phiên sẽ không được tiêm lại.
- Hiển thị người gửi: mỗi lô tin nhắn nhóm giờ kết thúc bằng `[from: Sender Name (+E164)]` để Pi biết ai đang nói.
- Tin nhắn tạm thời/xem một lần: chúng tôi mở gói trước khi trích xuất văn bản/nhắc tên, nên các ping bên trong vẫn kích hoạt.
- System prompt cho nhóm: ở lượt đầu tiên của một phiên nhóm (và bất cứ khi nào `/activation` thay đổi chế độ) chúng tôi chèn một đoạn ngắn vào system prompt như `You are replying inside the WhatsApp group "<subject>". Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.`. Nếu không có metadata, chúng tôi vẫn cho tác tử biết đó là chat nhóm.

## Ví dụ cấu hình (WhatsApp)

Thêm một khối `groupChat` vào `~/.openclaw/openclaw.json` để ping theo tên hiển thị hoạt động ngay cả khi WhatsApp loại bỏ `@` hiển thị trong thân văn bản:

```json5
{
  channels: {
    whatsapp: {
      groups: {
        "*": { requireMention: true },
      },
    },
  },
  agents: {
    list: [
      {
        id: "main",
        groupChat: {
          historyLimit: 50,
          mentionPatterns: ["@?openclaw", "\\+?15555550123"],
        },
      },
    ],
  },
}
```

Ghi chú:

- Các regex không phân biệt hoa thường; chúng bao phủ ping theo tên hiển thị như `@openclaw` và số thô có hoặc không có `+`/khoảng trắng.
- WhatsApp vẫn gửi nhắc tên chuẩn qua `mentionedJids` khi ai đó chạm vào liên hệ, nên phương án dự phòng bằng số hiếm khi cần nhưng là một lưới an toàn hữu ích.

### Lệnh kích hoạt (chỉ chủ sở hữu)

Dùng lệnh trong chat nhóm:

- `/activation mention`
- `/activation always`

Chỉ số của chủ sở hữu (từ `channels.whatsapp.allowFrom`, hoặc số E.164 của bot khi chưa đặt) mới có thể thay đổi điều này. Gửi `/status` như một tin nhắn độc lập trong nhóm để xem chế độ kích hoạt hiện tại.

## Cách sử dụng

1. Thêm tài khoản WhatsApp của bạn (tài khoản đang chạy OpenClaw) vào nhóm.
2. Nói `@openclaw …` (hoặc bao gồm số). Chỉ những người gửi trong danh sách cho phép mới có thể kích hoạt trừ khi bạn đặt `groupPolicy: "open"`.
3. Prompt của tác tử sẽ bao gồm ngữ cảnh nhóm gần đây cùng với dấu `[from: …]` ở cuối để có thể trả lời đúng người.
4. Các chỉ thị cấp phiên (`/verbose on`, `/think high`, `/new` hoặc `/reset`, `/compact`) chỉ áp dụng cho phiên của nhóm đó; hãy gửi chúng như tin nhắn độc lập để được ghi nhận. Phiên DM cá nhân của bạn vẫn độc lập.

## Kiểm thử / xác minh

- Thử nghiệm thủ công:
  - Gửi một ping `@openclaw` trong nhóm và xác nhận có phản hồi tham chiếu đến tên người gửi.
  - Gửi ping thứ hai và xác minh khối lịch sử được bao gồm rồi bị xóa ở lượt tiếp theo.
- Kiểm tra log của gateway (chạy với `--verbose`) để xem các mục `inbound web message` hiển thị `from: <groupJid>` và hậu tố `[from: …]`.

## Các lưu ý đã biết

- Heartbeat được cố ý bỏ qua cho nhóm để tránh phát sóng ồn ào.
- Chống echo sử dụng chuỗi lô kết hợp; nếu bạn gửi cùng một văn bản hai lần mà không có nhắc tên, chỉ lần đầu nhận được phản hồi.
- Các mục lưu trữ phiên sẽ xuất hiện dưới dạng `agent:<agentId>:whatsapp:group:<jid>` trong kho phiên (`~/.openclaw/agents/<agentId>/sessions/sessions.json` theo mặc định); thiếu mục chỉ có nghĩa là nhóm chưa kích hoạt chạy lần nào.
- Chỉ báo đang nhập trong nhóm tuân theo `agents.defaults.typingMode` (mặc định: `message` khi không được nhắc tên).
