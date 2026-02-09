---
summary: "Cấu hình và thiết lập bot chat Twitch"
read_when:
  - Thiết lập tích hợp chat Twitch cho OpenClaw
title: "Twitch"
---

# Twitch (plugin)

Twitch chat support via IRC connection. OpenClaw connects as a Twitch user (bot account) to receive and send messages in channels.

## Plugin bắt buộc

Twitch được phát hành dưới dạng plugin và không được gộp trong cài đặt lõi.

Cài đặt qua CLI (npm registry):

```bash
openclaw plugins install @openclaw/twitch
```

Checkout cục bộ (khi chạy từ repo git):

```bash
openclaw plugins install ./extensions/twitch
```

Chi tiết: [Plugins](/tools/plugin)

## Thiết lập nhanh (cho người mới)

1. Tạo một tài khoản Twitch riêng cho bot (hoặc dùng tài khoản hiện có).
2. Tạo thông tin xác thực: [Twitch Token Generator](https://twitchtokengenerator.com/)
   - Chọn **Bot Token**
   - Xác minh các scope `chat:read` và `chat:write` đã được chọn
   - Sao chép **Client ID** và **Access Token**
3. Tìm Twitch user ID của bạn: [https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/)
4. Cấu hình token:
   - Biến môi trường: `OPENCLAW_TWITCH_ACCESS_TOKEN=...` (chỉ cho tài khoản mặc định)
   - Hoặc cấu hình: `channels.twitch.accessToken`
   - Nếu cả hai đều được thiết lập, cấu hình sẽ được ưu tiên (biến môi trường chỉ là phương án dự phòng cho tài khoản mặc định).
5. Khởi động gateway.

**⚠️ Important:** Add access control (`allowFrom` or `allowedRoles`) to prevent unauthorized users from triggering the bot. `requireMention` defaults to `true`.

Cấu hình tối thiểu:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw", // Bot's Twitch account
      accessToken: "oauth:abc123...", // OAuth Access Token (or use OPENCLAW_TWITCH_ACCESS_TOKEN env var)
      clientId: "xyz789...", // Client ID from Token Generator
      channel: "vevisk", // Which Twitch channel's chat to join (required)
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only - get it from https://www.streamweasels.com/tools/convert-twitch-username-to-user-id/
    },
  },
}
```

## Nó là gì

- Một kênh Twitch do Gateway sở hữu.
- Định tuyến xác định: phản hồi luôn quay lại Twitch.
- Mỗi tài khoản ánh xạ tới một khóa phiên cô lập `agent:<agentId>:twitch:<accountName>`.
- `username` là tài khoản của bot (dùng để xác thực), `channel` là phòng chat cần tham gia.

## Thiết lập (chi tiết)

### Tạo thông tin xác thực

Sử dụng [Twitch Token Generator](https://twitchtokengenerator.com/):

- Chọn **Bot Token**
- Xác minh các scope `chat:read` và `chat:write` đã được chọn
- Sao chép **Client ID** và **Access Token**

No manual app registration needed. Tokens expire after several hours.

### Cấu hình bot

**Biến môi trường (chỉ cho tài khoản mặc định):**

```bash
OPENCLAW_TWITCH_ACCESS_TOKEN=oauth:abc123...
```

**Hoặc cấu hình:**

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
    },
  },
}
```

Nếu cả biến môi trường và cấu hình đều được thiết lập, cấu hình sẽ được ưu tiên.

### Kiểm soát truy cập (khuyến nghị)

```json5
{
  channels: {
    twitch: {
      allowFrom: ["123456789"], // (recommended) Your Twitch user ID only
    },
  },
}
```

Prefer `allowFrom` for a hard allowlist. Use `allowedRoles` instead if you want role-based access.

**Các vai trò khả dụng:** `"moderator"`, `"owner"`, `"vip"`, `"subscriber"`, `"all"`.

**Why user IDs?** Usernames can change, allowing impersonation. User IDs are permanent.

Tìm Twitch user ID của bạn: [https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/](https://www.streamweasels.com/tools/convert-twitch-username-%20to-user-id/) (Chuyển đổi tên người dùng Twitch sang ID)

## Làm mới token (tùy chọn)

Token từ [Twitch Token Generator](https://twitchtokengenerator.com/) không thể tự động làm mới – hãy tạo lại khi hết hạn.

Để tự động làm mới token, hãy tạo ứng dụng Twitch của riêng bạn tại [Twitch Developer Console](https://dev.twitch.tv/console) và thêm vào cấu hình:

```json5
{
  channels: {
    twitch: {
      clientSecret: "your_client_secret",
      refreshToken: "your_refresh_token",
    },
  },
}
```

Bot sẽ tự động làm mới token trước khi hết hạn và ghi log các sự kiện làm mới.

## Hỗ trợ nhiều tài khoản

Use `channels.twitch.accounts` with per-account tokens. See [`gateway/configuration`](/gateway/configuration) for the shared pattern.

Ví dụ (một tài khoản bot trong hai kênh):

```json5
{
  channels: {
    twitch: {
      accounts: {
        channel1: {
          username: "openclaw",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "vevisk",
        },
        channel2: {
          username: "openclaw",
          accessToken: "oauth:def456...",
          clientId: "uvw012...",
          channel: "secondchannel",
        },
      },
    },
  },
}
```

**Lưu ý:** Mỗi tài khoản cần token riêng (một token cho mỗi kênh).

## Kiểm soát truy cập

### Giới hạn theo vai trò

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator", "vip"],
        },
      },
    },
  },
}
```

### Danh sách cho phép theo User ID (an toàn nhất)

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowFrom: ["123456789", "987654321"],
        },
      },
    },
  },
}
```

### Truy cập theo vai trò (phương án thay thế)

`allowFrom` is a hard allowlist. When set, only those user IDs are allowed.
If you want role-based access, leave `allowFrom` unset and configure `allowedRoles` instead:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

### Tắt yêu cầu @mention

By default, `requireMention` is `true`. To disable and respond to all messages:

```json5
{
  channels: {
    twitch: {
      accounts: {
        default: {
          requireMention: false,
        },
      },
    },
  },
}
```

## Xử lý sự cố

Trước tiên, hãy chạy các lệnh chẩn đoán:

```bash
openclaw doctor
openclaw channels status --probe
```

### Bot không phản hồi tin nhắn

**Kiểm tra kiểm soát truy cập:** Đảm bảo user ID của bạn có trong `allowFrom`, hoặc tạm thời gỡ
`allowFrom` và đặt `allowedRoles: ["all"]` để thử nghiệm.

**Kiểm tra bot đã vào kênh:** Bot phải tham gia kênh được chỉ định trong `channel`.

### Sự cố token

**“Failed to connect” hoặc lỗi xác thực:**

- Xác minh `accessToken` là giá trị access token OAuth (thường bắt đầu với tiền tố `oauth:`)
- Kiểm tra token có các scope `chat:read` và `chat:write`
- Nếu dùng làm mới token, xác minh `clientSecret` và `refreshToken` đã được thiết lập

### Làm mới token không hoạt động

**Kiểm tra log để xem sự kiện làm mới:**

```
Using env token source for mybot
Access token refreshed for user 123456 (expires in 14400s)
```

Nếu bạn thấy “token refresh disabled (no refresh token)”:

- Đảm bảo `clientSecret` được cung cấp
- Đảm bảo `refreshToken` được cung cấp

## Cấu hình

**Cấu hình tài khoản:**

- `username` - Tên người dùng bot
- `accessToken` - Access token OAuth với `chat:read` và `chat:write`
- `clientId` - Twitch Client ID (từ Token Generator hoặc ứng dụng của bạn)
- `channel` - Kênh cần tham gia (bắt buộc)
- `enabled` - Bật tài khoản này (mặc định: `true`)
- `clientSecret` - Tùy chọn: dùng cho tự động làm mới token
- `refreshToken` - Tùy chọn: dùng cho tự động làm mới token
- `expiresIn` - Thời gian hết hạn token (giây)
- `obtainmentTimestamp` - Dấu thời gian lấy token
- `allowFrom` - Danh sách cho phép theo User ID
- `allowedRoles` - Kiểm soát truy cập theo vai trò (`"moderator" | "owner" | "vip" | "subscriber" | "all"`)
- `requireMention` - Yêu cầu @mention (mặc định: `true`)

**Tùy chọn nhà cung cấp:**

- `channels.twitch.enabled` - Bật/tắt khởi động kênh
- `channels.twitch.username` - Tên người dùng bot (cấu hình đơn tài khoản rút gọn)
- `channels.twitch.accessToken` - Access token OAuth (cấu hình đơn tài khoản rút gọn)
- `channels.twitch.clientId` - Twitch Client ID (cấu hình đơn tài khoản rút gọn)
- `channels.twitch.channel` - Kênh cần tham gia (cấu hình đơn tài khoản rút gọn)
- `channels.twitch.accounts.<accountName>` - Multi-account config (all account fields above)

Ví dụ đầy đủ:

```json5
{
  channels: {
    twitch: {
      enabled: true,
      username: "openclaw",
      accessToken: "oauth:abc123...",
      clientId: "xyz789...",
      channel: "vevisk",
      clientSecret: "secret123...",
      refreshToken: "refresh456...",
      allowFrom: ["123456789"],
      allowedRoles: ["moderator", "vip"],
      accounts: {
        default: {
          username: "mybot",
          accessToken: "oauth:abc123...",
          clientId: "xyz789...",
          channel: "your_channel",
          enabled: true,
          clientSecret: "secret123...",
          refreshToken: "refresh456...",
          expiresIn: 14400,
          obtainmentTimestamp: 1706092800000,
          allowFrom: ["123456789", "987654321"],
          allowedRoles: ["moderator"],
        },
      },
    },
  },
}
```

## Hành động công cụ

Tác tử có thể gọi `twitch` với hành động:

- `send` - Gửi tin nhắn tới một kênh

Ví dụ:

```json5
{
  action: "twitch",
  params: {
    message: "Hello Twitch!",
    to: "#mychannel",
  },
}
```

## An toàn & vận hành

- **Coi token như mật khẩu** – Không bao giờ commit token lên git
- **Dùng tự động làm mới token** cho các bot chạy lâu
- **Dùng danh sách cho phép theo user ID** thay vì tên người dùng để kiểm soát truy cập
- **Theo dõi log** để nắm các sự kiện làm mới token và trạng thái kết nối
- **Giới hạn scope token ở mức tối thiểu** – Chỉ yêu cầu `chat:read` và `chat:write`
- **Nếu bị kẹt**: Khởi động lại gateway sau khi xác nhận không có tiến trình nào khác đang sở hữu phiên

## Giới hạn

- **500 ký tự** mỗi tin nhắn (tự động chia đoạn theo ranh giới từ)
- Markdown sẽ bị loại bỏ trước khi chia đoạn
- Không giới hạn tốc độ (sử dụng giới hạn tốc độ tích hợp của Twitch)
