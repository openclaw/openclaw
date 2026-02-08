---
summary: "Trạng thái hỗ trợ, khả năng và cấu hình cho Tlon/Urbit"
read_when:
  - Làm việc trên các tính năng kênh Tlon/Urbit
title: "Tlon"
x-i18n:
  source_path: channels/tlon.md
  source_hash: 85fd29cda05b4563
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:06Z
---

# Tlon (plugin)

Tlon là một trình nhắn tin phi tập trung xây dựng trên Urbit. OpenClaw kết nối với ship Urbit của bạn và có thể
phản hồi tin nhắn riêng (DM) và tin nhắn trò chuyện nhóm. Phản hồi trong nhóm mặc định yêu cầu có @ mention và có thể
được hạn chế thêm thông qua danh sách cho phép.

Trạng thái: được hỗ trợ thông qua plugin. Hỗ trợ DM, mention trong nhóm, trả lời theo luồng, và dự phòng media chỉ văn bản
(URL được gắn vào chú thích). Không hỗ trợ reactions, polls và tải lên media gốc.

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

Tự động khám phá được bật theo mặc định. Bạn cũng có thể ghim kênh thủ công:

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
