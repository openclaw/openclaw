---
summary: "Thiết lập, cấu hình và cách dùng plugin LINE Messaging API"
read_when:
  - Bạn muốn kết nối OpenClaw với LINE
  - Bạn cần thiết lập webhook + thông tin xác thực cho LINE
  - Bạn muốn các tùy chọn tin nhắn dành riêng cho LINE
title: LINE
x-i18n:
  source_path: channels/line.md
  source_hash: 52eb66d06d616173
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:37:59Z
---

# LINE (plugin)

LINE kết nối với OpenClaw thông qua LINE Messaging API. Plugin chạy như một bộ nhận webhook
trên gateway và sử dụng channel access token + channel secret của bạn để xác thực.

Trạng thái: được hỗ trợ qua plugin. Hỗ trợ tin nhắn trực tiếp, chat nhóm, media, vị trí, Flex
messages, template messages và quick replies. Không hỗ trợ reactions và threads.

## Plugin required

Cài đặt plugin LINE:

```bash
openclaw plugins install @openclaw/line
```

Local checkout (khi chạy từ repo git):

```bash
openclaw plugins install ./extensions/line
```

## Setup

1. Tạo tài khoản LINE Developers và mở Console:
   [https://developers.line.biz/console/](https://developers.line.biz/console/)
2. Tạo (hoặc chọn) một Provider và thêm kênh **Messaging API**.
3. Sao chép **Channel access token** và **Channel secret** từ phần cài đặt kênh.
4. Bật **Use webhook** trong phần cài đặt Messaging API.
5. Đặt URL webhook trỏ tới endpoint gateway của bạn (yêu cầu HTTPS):

```
https://gateway-host/line/webhook
```

Gateway phản hồi việc xác minh webhook của LINE (GET) và các sự kiện vào (POST).
Nếu bạn cần đường dẫn tùy chỉnh, đặt `channels.line.webhookPath` hoặc
`channels.line.accounts.<id>.webhookPath` và cập nhật URL tương ứng.

## Configure

Cấu hình tối thiểu:

```json5
{
  channels: {
    line: {
      enabled: true,
      channelAccessToken: "LINE_CHANNEL_ACCESS_TOKEN",
      channelSecret: "LINE_CHANNEL_SECRET",
      dmPolicy: "pairing",
    },
  },
}
```

Biến môi trường (chỉ cho tài khoản mặc định):

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`

Tệp token/secret:

```json5
{
  channels: {
    line: {
      tokenFile: "/path/to/line-token.txt",
      secretFile: "/path/to/line-secret.txt",
    },
  },
}
```

Nhiều tài khoản:

```json5
{
  channels: {
    line: {
      accounts: {
        marketing: {
          channelAccessToken: "...",
          channelSecret: "...",
          webhookPath: "/line/marketing",
        },
      },
    },
  },
}
```

## Access control

Tin nhắn trực tiếp mặc định là ghép cặp. Người gửi chưa xác định sẽ nhận mã ghép cặp và
tin nhắn của họ sẽ bị bỏ qua cho đến khi được phê duyệt.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Danh sách cho phép và chính sách:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: các LINE user ID được cho phép cho DM
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: các LINE user ID được cho phép cho nhóm
- Ghi đè theo từng nhóm: `channels.line.groups.<groupId>.allowFrom`

LINE ID phân biệt chữ hoa/thường. ID hợp lệ có dạng:

- User: `U` + 32 ký tự hex
- Group: `C` + 32 ký tự hex
- Room: `R` + 32 ký tự hex

## Message behavior

- Văn bản được chia khúc ở 5000 ký tự.
- Định dạng Markdown bị loại bỏ; code blocks và bảng được chuyển thành Flex
  cards khi có thể.
- Phản hồi streaming được đệm; LINE nhận các khối hoàn chỉnh kèm hiệu ứng
  loading trong khi tác tử xử lý.
- Tải media bị giới hạn bởi `channels.line.mediaMaxMb` (mặc định 10).

## Channel data (rich messages)

Dùng `channelData.line` để gửi quick replies, vị trí, Flex cards hoặc template
messages.

```json5
{
  text: "Here you go",
  channelData: {
    line: {
      quickReplies: ["Status", "Help"],
      location: {
        title: "Office",
        address: "123 Main St",
        latitude: 35.681236,
        longitude: 139.767125,
      },
      flexMessage: {
        altText: "Status card",
        contents: {
          /* Flex payload */
        },
      },
      templateMessage: {
        type: "confirm",
        text: "Proceed?",
        confirmLabel: "Yes",
        confirmData: "yes",
        cancelLabel: "No",
        cancelData: "no",
      },
    },
  },
}
```

Plugin LINE cũng đi kèm lệnh `/card` cho các preset Flex message:

```
/card info "Welcome" "Thanks for joining!"
```

## Troubleshooting

- **Xác minh webhook thất bại:** đảm bảo URL webhook là HTTPS và
  `channelSecret` khớp với LINE console.
- **Không có sự kiện vào:** xác nhận đường dẫn webhook khớp với `channels.line.webhookPath`
  và gateway có thể truy cập từ LINE.
- **Lỗi tải media:** tăng `channels.line.mediaMaxMb` nếu media vượt quá
  giới hạn mặc định.
