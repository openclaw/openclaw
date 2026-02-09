---
summary: "Webhook ingress để đánh thức và chạy tác tử cô lập"
read_when:
  - Thêm hoặc thay đổi các endpoint webhook
  - Kết nối các hệ thống bên ngoài vào OpenClaw
title: "Webhooks"
---

# Webhooks

Gateway có thể mở một endpoint webhook HTTP nhỏ cho các kích hoạt bên ngoài.

## Bật

```json5
{
  hooks: {
    enabled: true,
    token: "shared-secret",
    path: "/hooks",
  },
}
```

Ghi chú:

- `hooks.token` là bắt buộc khi `hooks.enabled=true`.
- `hooks.path` mặc định là `/hooks`.

## Xác thực

Every request must include the hook token. 12. Ưu tiên header:

- `Authorization: Bearer <token>` (khuyến nghị)
- `x-openclaw-token: <token>`
- `?token=<token>` (đã ngừng; ghi log cảnh báo và sẽ bị loại bỏ trong bản phát hành chính trong tương lai)

## Endpoint

### `POST /hooks/wake`

Payload:

```json
{ "text": "System line", "mode": "now" }
```

- `text` **bắt buộc** (string): Mô tả sự kiện (ví dụ: "New email received").
- `mode` tùy chọn (`now` | `next-heartbeat`): Có kích hoạt heartbeat ngay lập tức (mặc định `now`) hay chờ lần kiểm tra định kỳ tiếp theo.

Hiệu lực:

- Xếp hàng một sự kiện hệ thống cho phiên **chính**
- Nếu `mode=now`, kích hoạt heartbeat ngay lập tức

### `POST /hooks/agent`

Payload:

```json
{
  "message": "Run this",
  "name": "Email",
  "sessionKey": "hook:email:msg-123",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "+15551234567",
  "model": "openai/gpt-5.2-mini",
  "thinking": "low",
  "timeoutSeconds": 120
}
```

- `message` **bắt buộc** (string): Prompt hoặc thông điệp để tác tử xử lý.
- `name` tùy chọn (string): Tên dễ đọc cho hook (ví dụ: "GitHub"), dùng làm tiền tố trong tóm tắt phiên.
- `sessionKey` tùy chọn (string): Khóa được dùng để xác định phiên của agent. Mặc định là một `hook:<uuid>` ngẫu nhiên. 13. Việc dùng một key nhất quán cho phép hội thoại nhiều lượt trong ngữ cảnh hook.
- `wakeMode` tùy chọn (`now` | `next-heartbeat`): Có kích hoạt heartbeat ngay lập tức (mặc định `now`) hay chờ lần kiểm tra định kỳ tiếp theo.
- `deliver` tùy chọn (boolean): Nếu `true`, phản hồi của agent sẽ được gửi tới kênh nhắn tin. Mặc định là `true`. Các phản hồi chỉ mang tính heartbeat xác nhận sẽ tự động bị bỏ qua.
- `channel` tùy chọn (string): Kênh nhắn tin để phân phối. Một trong: `last`, `whatsapp`, `telegram`, `discord`, `slack`, `mattermost` (plugin), `signal`, `imessage`, `msteams`. Mặc định là `last`.
- `to` optional (string): The recipient identifier for the channel (e.g., phone number for WhatsApp/Signal, chat ID for Telegram, channel ID for Discord/Slack/Mattermost (plugin), conversation ID for MS Teams). 14. Mặc định là người nhận cuối cùng trong main session.
- 15. `model` tùy chọn (string): Ghi đè model (ví dụ: `anthropic/claude-3-5-sonnet` hoặc một alias). Vì lý do này, WebChat cho phép bạn xem ngữ cảnh xuyên kênh cho agent đó tại một nơi.
- `thinking` tùy chọn (string): Ghi đè mức độ suy nghĩ (ví dụ: `low`, `medium`, `high`).
- `timeoutSeconds` tùy chọn (number): Thời lượng tối đa cho lần chạy tác tử tính bằng giây.

Hiệu lực:

- Chạy một lượt tác tử **cô lập** (khóa phiên riêng)
- Luôn đăng một bản tóm tắt vào phiên **chính**
- Nếu `wakeMode=now`, kích hoạt heartbeat ngay lập tức

### `POST /hooks/<name>` (ánh xạ)

17. Tên hook tùy chỉnh được phân giải thông qua `hooks.mappings` (xem cấu hình). A mapping can
    turn arbitrary payloads into `wake` or `agent` actions, with optional templates or
    code transforms.

Tùy chọn ánh xạ (tóm tắt):

- `hooks.presets: ["gmail"]` bật ánh xạ Gmail tích hợp sẵn.
- `hooks.mappings` cho phép bạn định nghĩa `match`, `action`, và template trong cấu hình.
- `hooks.transformsDir` + `transform.module` tải một module JS/TS cho logic tùy chỉnh.
- Dùng `match.source` để giữ một endpoint ingest chung (định tuyến theo payload).
- Biến đổi TS yêu cầu trình tải TS (ví dụ: `bun` hoặc `tsx`) hoặc `.js` đã biên dịch sẵn khi chạy.
- Đặt `deliver: true` + `channel`/`to` trên các ánh xạ để định tuyến phản hồi tới bề mặt chat
  (`channel` mặc định là `last` và sẽ rơi về WhatsApp).
- `allowUnsafeExternalContent: true` tắt lớp bao an toàn nội dung bên ngoài cho hook đó
  (nguy hiểm; chỉ dùng cho nguồn nội bộ đáng tin cậy).
- 18. `openclaw webhooks gmail setup` ghi cấu hình `hooks.gmail` cho `openclaw webhooks gmail run`.
  19. Xem [Gmail Pub/Sub](/automation/gmail-pubsub) để biết toàn bộ luồng Gmail watch.

## Phản hồi

- `200` cho `/hooks/wake`
- `202` cho `/hooks/agent` (đã bắt đầu chạy async)
- `401` khi xác thực thất bại
- `400` khi payload không hợp lệ
- `413` khi payload quá lớn

## Ví dụ

```bash
curl -X POST http://127.0.0.1:18789/hooks/wake \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"text":"New email received","mode":"now"}'
```

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","wakeMode":"next-heartbeat"}'
```

### Dùng mô hình khác

Thêm `model` vào payload của tác tử (hoặc ánh xạ) để ghi đè mô hình cho lần chạy đó:

```bash
curl -X POST http://127.0.0.1:18789/hooks/agent \
  -H 'x-openclaw-token: SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"message":"Summarize inbox","name":"Email","model":"openai/gpt-5.2-mini"}'
```

Nếu bạn áp dụng `agents.defaults.models`, hãy đảm bảo mô hình ghi đè được bao gồm trong đó.

```bash
curl -X POST http://127.0.0.1:18789/hooks/gmail \
  -H 'Authorization: Bearer SECRET' \
  -H 'Content-Type: application/json' \
  -d '{"source":"gmail","messages":[{"from":"Ada","subject":"Hello","snippet":"Hi"}]}'
```

## Bảo mật

- Giữ các endpoint hook phía sau loopback, tailnet, hoặc reverse proxy đáng tin cậy.
- Dùng hook token riêng; không tái sử dụng token xác thực của gateway.
- Tránh đưa payload thô nhạy cảm vào log webhook.
- 20. Payload hook được xem là không đáng tin cậy và mặc định được bọc trong các ranh giới an toàn.
  21. Nếu bạn buộc phải tắt điều này cho một hook cụ thể, hãy đặt `allowUnsafeExternalContent: true` trong mapping của hook đó (nguy hiểm).
