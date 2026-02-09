---
summary: "Trạng thái hỗ trợ, khả năng và cấu hình cho Tlon/Urbit"
read_when:
  - Làm việc trên các tính năng kênh Tlon/Urbit
title: "Tlon"
---

# Tlon (plugin)

Tlon is a decentralized messenger built on Urbit. OpenClaw connects to your Urbit ship and can
respond to DMs and group chat messages. Group replies require an @ mention by default and can
be further restricted via allowlists.

Status: supported via plugin. DMs, group mentions, thread replies, and text-only media fallback
(URL appended to caption). Reactions, polls, and native media uploads are not supported.

## Cần plugin

Tlon được phát hành dưới dạng plugin và không được gộp trong bản cài đặt lõi.

Cài đặt qua CLI (npm registry):

```bash
openclaw plugins install @openclaw/tlon
```

Checkout cục bộ (khi chạy từ repo git):

```bash
openclaw plugins install ./extensions/tlon
```

Chi tiết: [Plugins](/tools/plugin)

## Thiết lập

1. Cài đặt plugin Tlon.
2. Thu thập URL ship và mã đăng nhập của bạn.
3. Cấu hình `channels.tlon`.
4. Khởi động lại gateway.
5. Gửi DM cho bot hoặc mention nó trong kênh nhóm.

Cấu hình tối thiểu (một tài khoản):

```json5
{
  channels: {
    tlon: {
      enabled: true,
      ship: "~sampel-palnet",
      url: "https://your-ship-host",
      code: "lidlut-tabwed-pillex-ridrup",
    },
  },
}
```

## Kênh nhóm

Auto-discovery is enabled by default. You can also pin channels manually:

```json5
{
  channels: {
    tlon: {
      groupChannels: ["chat/~host-ship/general", "chat/~host-ship/support"],
    },
  },
}
```

Tắt tự động khám phá:

```json5
{
  channels: {
    tlon: {
      autoDiscoverChannels: false,
    },
  },
}
```

## Kiểm soát truy cập

Danh sách cho phép DM (rỗng = cho phép tất cả):

```json5
{
  channels: {
    tlon: {
      dmAllowlist: ["~zod", "~nec"],
    },
  },
}
```

Ủy quyền nhóm (mặc định bị hạn chế):

```json5
{
  channels: {
    tlon: {
      defaultAuthorizedShips: ["~zod"],
      authorization: {
        channelRules: {
          "chat/~host-ship/general": {
            mode: "restricted",
            allowedShips: ["~zod", "~nec"],
          },
          "chat/~host-ship/announcements": {
            mode: "open",
          },
        },
      },
    },
  },
}
```

## Đích gửi (CLI/cron)

Sử dụng các đích này với `openclaw message send` hoặc gửi qua cron:

- DM: `~sampel-palnet` hoặc `dm/~sampel-palnet`
- Nhóm: `chat/~host-ship/channel` hoặc `group:~host-ship/channel`

## Ghi chú

- Phản hồi trong nhóm yêu cầu mention (ví dụ: `~your-bot-ship`) để trả lời.
- Trả lời theo luồng: nếu tin nhắn đến nằm trong một luồng, OpenClaw sẽ trả lời trong luồng đó.
- Media: `sendMedia` sẽ chuyển sang dự phòng văn bản + URL (không tải lên gốc).
