---
summary: "Hành vi và cấu hình cho việc xử lý tin nhắn nhóm WhatsApp (mentionPatterns được dùng chung trên các bề mặt)"
read_when:
  - Khi thay đổi quy tắc tin nhắn nhóm hoặc nhắc tên
title: "Tin nhắn nhóm"
---

# Tin nhắn nhóm (kênh WhatsApp web)

Mục tiêu: cho phép Clawd tham gia các nhóm WhatsApp, chỉ thức dậy khi được ping, và giữ luồng đó tách biệt với phiên DM cá nhân.

Lưu ý: `agents.list[].groupChat.mentionPatterns` hiện cũng được dùng cho Telegram/Discord/Slack/iMessage; tài liệu này tập trung vào hành vi riêng của WhatsApp. For multi-agent setups, set `agents.list[].groupChat.mentionPatterns` per agent (or use `messages.groupChat.mentionPatterns` as a global fallback).

## Những gì đã triển khai (2025-12-03)

- Activation modes: `mention` (default) or `always`. `mention` yêu cầu một ping (mention WhatsApp @ thực thông qua `mentionedJids`, các mẫu regex, hoặc số E.164 của bot xuất hiện ở bất kỳ đâu trong văn bản). `always` đánh thức agent với mọi tin nhắn nhưng chỉ nên trả lời khi có thể mang lại giá trị thực; nếu không thì trả về token im lặng `NO_REPLY`. Giá trị mặc định có thể được đặt trong cấu hình (`channels.whatsapp.groups`) và được ghi đè theo từng nhóm thông qua `/activation`. When `channels.whatsapp.groups` is set, it also acts as a group allowlist (include `"*"` to allow all).
- Group policy: `channels.whatsapp.groupPolicy` controls whether group messages are accepted (`open|disabled|allowlist`). `allowlist` uses `channels.whatsapp.groupAllowFrom` (fallback: explicit `channels.whatsapp.allowFrom`). Default is `allowlist` (blocked until you add senders).
- Per-group sessions: session keys look like `agent:<agentId>:whatsapp:group:<jid>` so commands such as `/verbose on` or `/think high` (sent as standalone messages) are scoped to that group; personal DM state is untouched. Heartbeats are skipped for group threads.
- Context injection: **pending-only** group messages (default 50) that _did not_ trigger a run are prefixed under `[Chat messages since your last reply - for context]`, with the triggering line under `[Current message - respond to this]`. Messages already in the session are not re-injected.
- Hiển thị người gửi: mỗi lô tin nhắn nhóm giờ kết thúc bằng `[from: Sender Name (+E164)]` để Pi biết ai đang nói.
- Tin nhắn tạm thời/xem một lần: chúng tôi mở gói trước khi trích xuất văn bản/nhắc tên, nên các ping bên trong vẫn kích hoạt.
- Discord: allowlist sử dụng `channels.discord.guilds.<id>` Group members: Alice (+44...), Bob (+43...), … Activation: trigger-only … Address the specific sender noted in the message context.\` If metadata isn’t available we still tell the agent it’s a group chat.

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

Only the owner number (from `channels.whatsapp.allowFrom`, or the bot’s own E.164 when unset) can change this. Send `/status` as a standalone message in the group to see the current activation mode.

## Cách sử dụng

1. Thêm tài khoản WhatsApp của bạn (tài khoản đang chạy OpenClaw) vào nhóm.
2. Say `@openclaw …` (or include the number). Only allowlisted senders can trigger it unless you set `groupPolicy: "open"`.
3. Prompt của tác tử sẽ bao gồm ngữ cảnh nhóm gần đây cùng với dấu `[from: …]` ở cuối để có thể trả lời đúng người.
4. Session-level directives (`/verbose on`, `/think high`, `/new` or `/reset`, `/compact`) apply only to that group’s session; send them as standalone messages so they register. Your personal DM session remains independent.

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
