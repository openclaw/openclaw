---
summary: "Tổng quan về ghép cặp: phê duyệt ai có thể nhắn DM cho bạn + những node nào có thể tham gia"
read_when:
  - Thiết lập kiểm soát truy cập DM
  - Ghép cặp một node iOS/Android mới
  - Rà soát tư thế bảo mật của OpenClaw
title: "Ghép cặp"
---

# Ghép cặp

“Pairing” is OpenClaw’s explicit **owner approval** step.
It is used in two places:

1. **Ghép cặp DM** (ai được phép nói chuyện với bot)
2. **Ghép cặp node** (những thiết bị/node nào được phép tham gia mạng gateway)

Ngữ cảnh bảo mật: [Security](/gateway/security)

## 1. Ghép cặp DM (truy cập chat đến)

Khi một kênh được cấu hình với chính sách DM `pairing`, người gửi chưa xác định sẽ nhận một mã ngắn và tin nhắn của họ **không được xử lý** cho đến khi bạn phê duyệt.

Các chính sách DM mặc định được ghi trong: [Security](/gateway/security)

Mã ghép cặp:

- 8 ký tự, chữ hoa, không có ký tự dễ gây nhầm lẫn (`0O1I`).
- **Expire after 1 hour**. The bot only sends the pairing message when a new request is created (roughly once per hour per sender).
- Các yêu cầu ghép cặp DM đang chờ được giới hạn **3 yêu cầu cho mỗi kênh** theo mặc định; các yêu cầu bổ sung sẽ bị bỏ qua cho đến khi một yêu cầu hết hạn hoặc được phê duyệt.

### Phê duyệt một người gửi

```bash
openclaw pairing list telegram
openclaw pairing approve telegram <CODE>
```

Các kênh được hỗ trợ: `telegram`, `whatsapp`, `signal`, `imessage`, `discord`, `slack`.

### Trạng thái được lưu ở đâu

Lưu dưới `~/.openclaw/credentials/`:

- Yêu cầu đang chờ: `<channel>-pairing.json`
- Kho danh sách cho phép đã phê duyệt: `<channel>-allowFrom.json`

Hãy coi những mục này là nhạy cảm (chúng kiểm soát quyền truy cập vào trợ lý của bạn).

## 2. Ghép cặp thiết bị node (iOS/Android/macOS/node headless)

Nodes connect to the Gateway as **devices** with `role: node`. The Gateway
creates a device pairing request that must be approved.

### Phê duyệt một thiết bị node

```bash
openclaw devices list
openclaw devices approve <requestId>
openclaw devices reject <requestId>
```

### Lưu trữ trạng thái ghép cặp node

Lưu dưới `~/.openclaw/devices/`:

- `pending.json` (tồn tại ngắn; các yêu cầu đang chờ sẽ hết hạn)
- `paired.json` (thiết bị đã ghép cặp + token)

### Ghi chú

- The legacy `node.pair.*` API (CLI: `openclaw nodes pending/approve`) is a
  separate gateway-owned pairing store. WS nodes still require device pairing.

## Tài liệu liên quan

- Mô hình bảo mật + prompt injection: [Security](/gateway/security)
- Cập nhật an toàn (chạy doctor): [Updating](/install/updating)
- Cấu hình kênh:
  - Telegram: [Telegram](/channels/telegram)
  - WhatsApp: [WhatsApp](/channels/whatsapp)
  - Signal: [Signal](/channels/signal)
  - BlueBubbles (iMessage): [BlueBubbles](/channels/bluebubbles)
  - iMessage (legacy): [iMessage](/channels/imessage)
  - Discord: [Discord](/channels/discord)
  - Slack: [Slack](/channels/slack)
