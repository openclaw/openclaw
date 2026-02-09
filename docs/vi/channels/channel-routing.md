---
summary: "Quy tắc định tuyến theo từng kênh (WhatsApp, Telegram, Discord, Slack) và ngữ cảnh dùng chung"
read_when:
  - Thay đổi định tuyến kênh hoặc hành vi hộp thư
title: "Định tuyến kênh"
---

# Kênh & định tuyến

44. OpenClaw định tuyến phản hồi **trở lại kênh nơi thông điệp xuất phát**. The
    model does not choose a channel; routing is deterministic and controlled by the
    host configuration.

## Thuật ngữ chính

- **Channel**: `whatsapp`, `telegram`, `discord`, `slack`, `signal`, `imessage`, `webchat`.
- **AccountId**: thực thể tài khoản theo kênh (khi được hỗ trợ).
- **AgentId**: một không gian làm việc + kho phiên độc lập (“bộ não”).
- **SessionKey**: khóa dùng để lưu ngữ cảnh và kiểm soát đồng thời.

## Dạng khóa phiên (ví dụ)

Tin nhắn trực tiếp được gộp vào phiên **chính** của tác tử:

- `agent:<agentId>:<mainKey>` (mặc định: `agent:main:main`)

Nhóm và kênh được cô lập theo từng kênh:

- Nhóm: `agent:<agentId>:<channel>:group:<id>`
- Kênh/phòng: `agent:<agentId>:<channel>:channel:<id>`

Luồng (threads):

- Luồng Slack/Discord thêm `:thread:<threadId>` vào khóa cơ sở.
- Chủ đề diễn đàn Telegram nhúng `:topic:<topicId>` vào khóa nhóm.

Ví dụ:

- `agent:main:telegram:group:-1001234567890:topic:42`
- `agent:main:discord:channel:123456:thread:987654`

## Quy tắc định tuyến (cách chọn tác tử)

Định tuyến chọn **một tác tử** cho mỗi thông điệp đến:

1. **Khớp ngang hàng chính xác** (`bindings` với `peer.kind` + `peer.id`).
2. **Khớp guild** (Discord) qua `guildId`.
3. **Khớp team** (Slack) qua `teamId`.
4. **Khớp tài khoản** (`accountId` trên kênh).
5. **Khớp kênh** (bất kỳ tài khoản nào trên kênh đó).
6. **Tác tử mặc định** (`agents.list[].default`, nếu không thì mục đầu tiên trong danh sách, fallback sang `main`).

Tác tử được khớp sẽ quyết định không gian làm việc và kho phiên được sử dụng.

## Nhóm phát sóng (chạy nhiều tác tử)

Nhóm phát sóng cho phép bạn chạy **nhiều tác tử** cho cùng một peer **khi OpenClaw bình thường sẽ phản hồi** (ví dụ: trong nhóm WhatsApp, sau khi qua bước chặn theo mention/kích hoạt).

Cấu hình:

```json5
{
  broadcast: {
    strategy: "parallel",
    "120363403215116621@g.us": ["alfred", "baerbel"],
    "+15555550123": ["support", "logger"],
  },
}
```

Xem: [Broadcast Groups](/channels/broadcast-groups).

## Tổng quan cấu hình

- `agents.list`: các định nghĩa tác tử được đặt tên (không gian làm việc, mô hình, v.v.).
- `bindings`: ánh xạ kênh/tài khoản/peer đầu vào tới tác tử.

Ví dụ:

```json5
{
  agents: {
    list: [{ id: "support", name: "Support", workspace: "~/.openclaw/workspace-support" }],
  },
  bindings: [
    { match: { channel: "slack", teamId: "T123" }, agentId: "support" },
    { match: { channel: "telegram", peer: { kind: "group", id: "-100123" } }, agentId: "support" },
  ],
}
```

## Lưu trữ phiên

Kho phiên nằm dưới thư mục trạng thái (mặc định `~/.openclaw`):

- `~/.openclaw/agents/<agentId>/sessions/sessions.json`
- Bản ghi JSONL nằm cùng thư mục với kho

Bạn có thể ghi đè đường dẫn kho qua `session.store` và mẫu hóa `{agentId}`.

## Hành vi WebChat

WebChat attaches to the **selected agent** and defaults to the agent’s main
session. Các nguyên nhân phổ biến:

## Ngữ cảnh phản hồi

Phản hồi đến bao gồm:

- `ReplyToId`, `ReplyToBody`, và `ReplyToSender` khi khả dụng.
- Ngữ cảnh trích dẫn được nối vào `Body` như một khối `[Replying to ...]`.

Điều này nhất quán trên các kênh.
