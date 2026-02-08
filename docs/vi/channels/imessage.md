---
summary: "Hỗ trợ iMessage cũ thông qua imsg (JSON-RPC qua stdio). Thiết lập mới nên dùng BlueBubbles."
read_when:
  - Thiết lập hỗ trợ iMessage
  - Gỡ lỗi gửi/nhận iMessage
title: iMessage
x-i18n:
  source_path: channels/imessage.md
  source_hash: b418a589547d1ef0
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:15Z
---

# iMessage (legacy: imsg)

> **Khuyến nghị:** Dùng [BlueBubbles](/channels/bluebubbles) cho các thiết lập iMessage mới.
>
> Kênh `imsg` là tích hợp CLI bên ngoài dạng legacy và có thể bị loại bỏ trong một bản phát hành tương lai.

Trạng thái: tích hợp CLI bên ngoài dạng legacy. Gateway khởi chạy `imsg rpc` (JSON-RPC qua stdio).

## Khởi động nhanh (cho người mới)

1. Đảm bảo Messages đã đăng nhập trên máy Mac này.
2. Cài đặt `imsg`:
   - `brew install steipete/tap/imsg`
3. Cấu hình OpenClaw với `channels.imessage.cliPath` và `channels.imessage.dbPath`.
4. Khởi động gateway và phê duyệt mọi lời nhắc của macOS (Automation + Full Disk Access).

Cấu hình tối thiểu:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "/usr/local/bin/imsg",
      dbPath: "/Users/<you>/Library/Messages/chat.db",
    },
  },
}
```

## Nó là gì

- Kênh iMessage được hỗ trợ bởi `imsg` trên macOS.
- Định tuyến xác định: phản hồi luôn quay lại iMessage.
- DM dùng chung phiên chính của tác tử; nhóm được cô lập (`agent:<agentId>:imessage:group:<chat_id>`).
- Nếu một luồng nhiều người tham gia đến với `is_group=false`, bạn vẫn có thể cô lập nó bằng `chat_id` sử dụng `channels.imessage.groups` (xem “Group-ish threads” bên dưới).

## Ghi cấu hình

Theo mặc định, iMessage được phép ghi các cập nhật cấu hình kích hoạt bởi `/config set|unset` (yêu cầu `commands.config: true`).

Tắt bằng:

```json5
{
  channels: { imessage: { configWrites: false } },
}
```

## Yêu cầu

- macOS với Messages đã đăng nhập.
- Full Disk Access cho OpenClaw + `imsg` (truy cập DB Messages).
- Quyền Automation khi gửi.
- `channels.imessage.cliPath` có thể trỏ tới bất kỳ lệnh nào proxy stdin/stdout (ví dụ: script bọc SSH sang Mac khác và chạy `imsg rpc`).

## Xử lý sự cố macOS Privacy and Security TCC

Nếu gửi/nhận thất bại (ví dụ, `imsg rpc` thoát với mã khác 0, hết thời gian chờ, hoặc gateway có vẻ bị treo), nguyên nhân phổ biến là lời nhắc quyền macOS chưa từng được phê duyệt.

macOS cấp quyền TCC theo ngữ cảnh ứng dụng/tiến trình. Phê duyệt lời nhắc trong cùng ngữ cảnh chạy `imsg` (ví dụ: Terminal/iTerm, phiên LaunchAgent, hoặc tiến trình khởi chạy qua SSH).

Danh sách kiểm tra:

- **Full Disk Access**: cho phép truy cập đối với tiến trình chạy OpenClaw (và bất kỳ wrapper shell/SSH nào thực thi `imsg`). Điều này cần để đọc cơ sở dữ liệu Messages (`chat.db`).
- **Automation → Messages**: cho phép tiến trình chạy OpenClaw (và/hoặc terminal của bạn) điều khiển **Messages.app** cho việc gửi ra ngoài.
- **Tình trạng CLI `imsg`**: xác minh `imsg` đã được cài và hỗ trợ RPC (`imsg rpc --help`).

Mẹo: Nếu OpenClaw chạy headless (LaunchAgent/systemd/SSH), lời nhắc macOS có thể dễ bị bỏ lỡ. Chạy một lệnh tương tác một lần trong terminal GUI để buộc hiện lời nhắc, rồi thử lại:

```bash
imsg chats --limit 1
# or
imsg send <handle> "test"
```

Quyền thư mục macOS liên quan (Desktop/Documents/Downloads): [/platforms/mac/permissions](/platforms/mac/permissions).

## Thiết lập (nhanh)

1. Đảm bảo Messages đã đăng nhập trên máy Mac này.
2. Cấu hình iMessage và khởi động gateway.

### Người dùng macOS dành riêng cho bot (để cô lập danh tính)

Nếu bạn muốn bot gửi từ **một danh tính iMessage riêng** (và giữ Messages cá nhân sạch sẽ), hãy dùng một Apple ID riêng + một người dùng macOS riêng.

1. Tạo một Apple ID dành riêng (ví dụ: `my-cool-bot@icloud.com`).
   - Apple có thể yêu cầu số điện thoại để xác minh / 2FA.
2. Tạo một người dùng macOS (ví dụ: `openclawhome`) và đăng nhập vào đó.
3. Mở Messages trong người dùng macOS đó và đăng nhập iMessage bằng Apple ID của bot.
4. Bật Remote Login (System Settings → General → Sharing → Remote Login).
5. Cài đặt `imsg`:
   - `brew install steipete/tap/imsg`
6. Thiết lập SSH để `ssh <bot-macos-user>@localhost true` hoạt động không cần mật khẩu.
7. Trỏ `channels.imessage.accounts.bot.cliPath` tới một wrapper SSH chạy `imsg` dưới người dùng bot.

Lưu ý lần chạy đầu: gửi/nhận có thể yêu cầu phê duyệt GUI (Automation + Full Disk Access) trong _người dùng macOS của bot_. Nếu `imsg rpc` có vẻ bị kẹt hoặc thoát, hãy đăng nhập vào người dùng đó (Screen Sharing rất hữu ích), chạy một lần `imsg chats --limit 1` / `imsg send ...`, phê duyệt lời nhắc, rồi thử lại. Xem [Xử lý sự cố macOS Privacy and Security TCC](#troubleshooting-macos-privacy-and-security-tcc).

Ví dụ wrapper (`chmod +x`). Thay `<bot-macos-user>` bằng tên người dùng macOS thực tế của bạn:

```bash
#!/usr/bin/env bash
set -euo pipefail

# Run an interactive SSH once first to accept host keys:
#   ssh <bot-macos-user>@localhost true
exec /usr/bin/ssh -o BatchMode=yes -o ConnectTimeout=5 -T <bot-macos-user>@localhost \
  "/usr/local/bin/imsg" "$@"
```

Ví dụ cấu hình:

```json5
{
  channels: {
    imessage: {
      enabled: true,
      accounts: {
        bot: {
          name: "Bot",
          enabled: true,
          cliPath: "/path/to/imsg-bot",
          dbPath: "/Users/<bot-macos-user>/Library/Messages/chat.db",
        },
      },
    },
  },
}
```

Với thiết lập một tài khoản, dùng các tùy chọn phẳng (`channels.imessage.cliPath`, `channels.imessage.dbPath`) thay vì map `accounts`.

### Biến thể remote/SSH (tùy chọn)

Nếu bạn muốn iMessage chạy trên một Mac khác, đặt `channels.imessage.cliPath` tới một wrapper chạy `imsg` trên máy macOS từ xa qua SSH. OpenClaw chỉ cần stdio.

Ví dụ wrapper:

```bash
#!/usr/bin/env bash
exec ssh -T gateway-host imsg "$@"
```

**Đính kèm từ xa:** Khi `cliPath` trỏ tới máy từ xa qua SSH, đường dẫn đính kèm trong DB Messages tham chiếu các tệp trên máy từ xa. OpenClaw có thể tự động tải chúng qua SCP bằng cách đặt `channels.imessage.remoteHost`:

```json5
{
  channels: {
    imessage: {
      cliPath: "~/imsg-ssh", // SSH wrapper to remote Mac
      remoteHost: "user@gateway-host", // for SCP file transfer
      includeAttachments: true,
    },
  },
}
```

Nếu `remoteHost` không được đặt, OpenClaw sẽ cố gắng tự phát hiện bằng cách phân tích lệnh SSH trong script wrapper của bạn. Khuyến nghị cấu hình tường minh để đảm bảo độ tin cậy.

#### Mac từ xa qua Tailscale (ví dụ)

Nếu Gateway chạy trên host/VM Linux nhưng iMessage phải chạy trên Mac, Tailscale là cầu nối đơn giản nhất: Gateway nói chuyện với Mac qua tailnet, chạy `imsg` qua SSH, và SCP đính kèm về.

Kiến trúc:

```
┌──────────────────────────────┐          SSH (imsg rpc)          ┌──────────────────────────┐
│ Gateway host (Linux/VM)      │──────────────────────────────────▶│ Mac with Messages + imsg │
│ - openclaw gateway           │          SCP (attachments)        │ - Messages signed in     │
│ - channels.imessage.cliPath  │◀──────────────────────────────────│ - Remote Login enabled   │
└──────────────────────────────┘                                   └──────────────────────────┘
              ▲
              │ Tailscale tailnet (hostname or 100.x.y.z)
              ▼
        user@gateway-host
```

Ví dụ cấu hình cụ thể (hostname Tailscale):

```json5
{
  channels: {
    imessage: {
      enabled: true,
      cliPath: "~/.openclaw/scripts/imsg-ssh",
      remoteHost: "bot@mac-mini.tailnet-1234.ts.net",
      includeAttachments: true,
      dbPath: "/Users/bot/Library/Messages/chat.db",
    },
  },
}
```

Ví dụ wrapper (`~/.openclaw/scripts/imsg-ssh`):

```bash
#!/usr/bin/env bash
exec ssh -T bot@mac-mini.tailnet-1234.ts.net imsg "$@"
```

Ghi chú:

- Đảm bảo Mac đã đăng nhập Messages và bật Remote Login.
- Dùng khóa SSH để `ssh bot@mac-mini.tailnet-1234.ts.net` hoạt động không cần lời nhắc.
- `remoteHost` nên khớp với đích SSH để SCP có thể tải đính kèm.

Hỗ trợ nhiều tài khoản: dùng `channels.imessage.accounts` với cấu hình theo từng tài khoản và `name` tùy chọn. Xem [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) cho mẫu dùng chung. Đừng commit `~/.openclaw/openclaw.json` (thường chứa token).

## Kiểm soát truy cập (DM + nhóm)

DM:

- Mặc định: `channels.imessage.dmPolicy = "pairing"`.
- Người gửi chưa biết sẽ nhận mã ghép cặp; tin nhắn bị bỏ qua cho đến khi được phê duyệt (mã hết hạn sau 1 giờ).
- Phê duyệt qua:
  - `openclaw pairing list imessage`
  - `openclaw pairing approve imessage <CODE>`
- Ghép cặp là cơ chế trao đổi token mặc định cho DM iMessage. Chi tiết: [Pairing](/channels/pairing)

Nhóm:

- `channels.imessage.groupPolicy = open | allowlist | disabled`.
- `channels.imessage.groupAllowFrom` kiểm soát ai có thể kích hoạt trong nhóm khi `allowlist` được đặt.
- Chặn theo nhắc tên dùng `agents.list[].groupChat.mentionPatterns` (hoặc `messages.groupChat.mentionPatterns`) vì iMessage không có metadata nhắc tên gốc.
- Ghi đè đa tác tử: đặt pattern theo từng tác tử trên `agents.list[].groupChat.mentionPatterns`.

## Cách hoạt động (hành vi)

- `imsg` stream các sự kiện tin nhắn; gateway chuẩn hóa chúng vào phong bì kênh dùng chung.
- Phản hồi luôn định tuyến về cùng chat id hoặc handle.

## Group-ish threads (`is_group=false`)

Một số luồng iMessage có thể có nhiều người tham gia nhưng vẫn đến với `is_group=false` tùy theo cách Messages lưu định danh chat.

Nếu bạn cấu hình tường minh một `chat_id` dưới `channels.imessage.groups`, OpenClaw coi luồng đó là “nhóm” cho:

- cô lập phiên (khóa phiên `agent:<agentId>:imessage:group:<chat_id>` riêng)
- hành vi danh sách cho phép nhóm / chặn theo nhắc tên

Ví dụ:

```json5
{
  channels: {
    imessage: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "42": { requireMention: false },
      },
    },
  },
}
```

Điều này hữu ích khi bạn muốn một tính cách/mô hình cô lập cho một luồng cụ thể (xem [Multi-agent routing](/concepts/multi-agent)). Với cô lập filesystem, xem [Sandboxing](/gateway/sandboxing).

## Media + giới hạn

- Nạp đính kèm tùy chọn qua `channels.imessage.includeAttachments`.
- Giới hạn media qua `channels.imessage.mediaMaxMb`.

## Giới hạn

- Văn bản gửi ra được chia khối tới `channels.imessage.textChunkLimit` (mặc định 4000).
- Chia khối theo dòng mới tùy chọn: đặt `channels.imessage.chunkMode="newline"` để tách theo dòng trống (ranh giới đoạn) trước khi chia theo độ dài.
- Tải media bị giới hạn bởi `channels.imessage.mediaMaxMb` (mặc định 16).

## Địa chỉ / đích gửi

Ưu tiên `chat_id` để định tuyến ổn định:

- `chat_id:123` (ưu tiên)
- `chat_guid:...`
- `chat_identifier:...`
- handle trực tiếp: `imessage:+1555` / `sms:+1555` / `user@example.com`

Liệt kê chat:

```
imsg chats --limit 20
```

## Tham chiếu cấu hình (iMessage)

Cấu hình đầy đủ: [Cấu hình](/gateway/configuration)

Tùy chọn nhà cung cấp:

- `channels.imessage.enabled`: bật/tắt khởi động kênh.
- `channels.imessage.cliPath`: đường dẫn tới `imsg`.
- `channels.imessage.dbPath`: đường dẫn DB Messages.
- `channels.imessage.remoteHost`: host SSH để chuyển đính kèm qua SCP khi `cliPath` trỏ tới Mac từ xa (ví dụ: `user@gateway-host`). Tự phát hiện từ wrapper SSH nếu không đặt.
- `channels.imessage.service`: `imessage | sms | auto`.
- `channels.imessage.region`: vùng SMS.
- `channels.imessage.dmPolicy`: `pairing | allowlist | open | disabled` (mặc định: pairing).
- `channels.imessage.allowFrom`: danh sách cho phép DM (handle, email, số E.164, hoặc `chat_id:*`). `open` yêu cầu `"*"`. iMessage không có username; dùng handle hoặc đích chat.
- `channels.imessage.groupPolicy`: `open | allowlist | disabled` (mặc định: allowlist).
- `channels.imessage.groupAllowFrom`: danh sách cho phép người gửi trong nhóm.
- `channels.imessage.historyLimit` / `channels.imessage.accounts.*.historyLimit`: số tin nhắn nhóm tối đa đưa vào ngữ cảnh (0 là tắt).
- `channels.imessage.dmHistoryLimit`: giới hạn lịch sử DM theo lượt người dùng. Ghi đè theo người dùng: `channels.imessage.dms["<handle>"].historyLimit`.
- `channels.imessage.groups`: mặc định theo nhóm + danh sách cho phép (dùng `"*"` cho mặc định toàn cục).
- `channels.imessage.includeAttachments`: nạp đính kèm vào ngữ cảnh.
- `channels.imessage.mediaMaxMb`: giới hạn media vào/ra (MB).
- `channels.imessage.textChunkLimit`: kích thước chia khối gửi ra (ký tự).
- `channels.imessage.chunkMode`: `length` (mặc định) hoặc `newline` để tách theo dòng trống (ranh giới đoạn) trước khi chia theo độ dài.

Tùy chọn toàn cục liên quan:

- `agents.list[].groupChat.mentionPatterns` (hoặc `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.
