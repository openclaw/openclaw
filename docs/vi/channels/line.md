---
summary: "Thiết lập, cấu hình và cách dùng plugin LINE Messaging API"
read_when:
  - Bạn muốn kết nối OpenClaw với LINE
  - Bạn cần thiết lập webhook + thông tin xác thực cho LINE
  - Bạn muốn các tùy chọn tin nhắn dành riêng cho LINE
title: LINE
---

# LINE (plugin)

21. LINE kết nối với OpenClaw thông qua LINE Messaging API. 22. Plugin chạy như một webhook
    receiver trên gateway và sử dụng access token + channel secret của bạn cho
    xác thực.

23. Trạng thái: được hỗ trợ thông qua plugin. 24. Hỗ trợ tin nhắn trực tiếp, trò chuyện nhóm, media, vị trí, Flex
    messages, template messages và quick replies. 25. Reactions và threads
    không được hỗ trợ.

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

26. Gateway phản hồi xác minh webhook của LINE (GET) và các sự kiện đến (POST).
27. Nếu bạn cần một đường dẫn tùy chỉnh, hãy đặt `channels.line.webhookPath` hoặc
    `channels.line.accounts.<id>`.webhookPath\` and update the URL accordingly.

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

28. Tin nhắn trực tiếp mặc định yêu cầu ghép cặp. 29. Người gửi không xác định sẽ nhận được mã ghép cặp và tin nhắn của họ sẽ bị
    bỏ qua cho đến khi được chấp thuận.

```bash
openclaw pairing list line
openclaw pairing approve line <CODE>
```

Danh sách cho phép và chính sách:

- `channels.line.dmPolicy`: `pairing | allowlist | open | disabled`
- `channels.line.allowFrom`: các LINE user ID được cho phép cho DM
- `channels.line.groupPolicy`: `allowlist | open | disabled`
- `channels.line.groupAllowFrom`: các LINE user ID được cho phép cho nhóm
- 30. Ghi đè theo nhóm: `channels.line.groups.<groupId>`.allowFrom\`

31. LINE ID phân biệt chữ hoa chữ thường. Valid IDs look like:

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
