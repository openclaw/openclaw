---
summary: "iMessage qua máy chủ BlueBubbles macOS (gửi/nhận REST, trạng thái gõ, phản ứng, ghép cặp, hành động nâng cao)."
read_when:
  - Thiết lập kênh BlueBubbles
  - Xử lý sự cố ghép cặp webhook
  - Cấu hình iMessage trên macOS
title: "BlueBubbles"
---

# BlueBubbles (macOS REST)

22. Trạng thái: plugin được bundle, giao tiếp với máy chủ BlueBubbles trên macOS qua HTTP. 23. **Được khuyến nghị cho tích hợp iMessage** nhờ API phong phú hơn và thiết lập dễ hơn so với kênh imsg legacy.

## Tổng quan

- Chạy trên macOS thông qua ứng dụng trợ giúp BlueBubbles ([bluebubbles.app](https://bluebubbles.app)).
- 24. Khuyến nghị/đã kiểm thử: macOS Sequoia (15). 25. macOS Tahoe (26) hoạt động; chỉnh sửa hiện đang bị lỗi trên Tahoe, và cập nhật icon nhóm có thể báo thành công nhưng không đồng bộ.
- OpenClaw giao tiếp thông qua REST API (`GET /api/v1/ping`, `POST /message/text`, `POST /chat/:id/*`).
- Tin nhắn đến được nhận qua webhook; phản hồi đi, trạng thái gõ, xác nhận đã đọc và tapback là các lời gọi REST.
- Tệp đính kèm và sticker được nhập như media đến (và hiển thị cho tác tử khi có thể).
- 26. Ghép cặp/allowlist hoạt động giống các kênh khác (`/channels/pairing` v.v.) với `channels.bluebubbles.allowFrom` + mã ghép cặp.
- Phản ứng được hiển thị như sự kiện hệ thống giống Slack/Telegram để tác tử có thể “nhắc” chúng trước khi trả lời.
- Tính năng nâng cao: chỉnh sửa, thu hồi, luồng trả lời, hiệu ứng tin nhắn, quản lý nhóm.

## Khởi động nhanh

1. Cài đặt máy chủ BlueBubbles trên Mac của bạn (làm theo hướng dẫn tại [bluebubbles.app/install](https://bluebubbles.app/install)).

2. Trong cấu hình BlueBubbles, bật web API và đặt mật khẩu.

3. Chạy `openclaw onboard` và chọn BlueBubbles, hoặc cấu hình thủ công:

   ```json5
   {
     channels: {
       bluebubbles: {
         enabled: true,
         serverUrl: "http://192.168.1.100:1234",
         password: "example-password",
         webhookPath: "/bluebubbles-webhook",
       },
     },
   }
   ```

4. Trỏ webhook BlueBubbles tới gateway của bạn (ví dụ: `https://your-gateway-host:3000/bluebubbles-webhook?password=<password>`).

5. Khởi động gateway; nó sẽ đăng ký trình xử lý webhook và bắt đầu ghép cặp.

## Giữ Messages.app hoạt động (VM / thiết lập headless)

27. Một số thiết lập macOS VM / always-on có thể khiến Messages.app rơi vào trạng thái “idle” (sự kiện đến bị dừng cho đến khi app được mở/đưa ra foreground). 28. Một cách khắc phục đơn giản là **chọc Messages mỗi 5 phút** bằng AppleScript + LaunchAgent.

### 1. Lưu AppleScript

Lưu với tên:

- `~/Scripts/poke-messages.scpt`

Script ví dụ (không tương tác; không giành focus):

```applescript
try
  tell application "Messages"
    if not running then
      launch
    end if

    -- Touch the scripting interface to keep the process responsive.
    set _chatCount to (count of chats)
  end tell
on error
  -- Ignore transient failures (first-run prompts, locked session, etc).
end try
```

### 2. Cài đặt LaunchAgent

Lưu với tên:

- `~/Library/LaunchAgents/com.user.poke-messages.plist`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>com.user.poke-messages</string>

    <key>ProgramArguments</key>
    <array>
      <string>/bin/bash</string>
      <string>-lc</string>
      <string>/usr/bin/osascript &quot;$HOME/Scripts/poke-messages.scpt&quot;</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>StartInterval</key>
    <integer>300</integer>

    <key>StandardOutPath</key>
    <string>/tmp/poke-messages.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/poke-messages.err</string>
  </dict>
</plist>
```

Ghi chú:

- Chạy **mỗi 300 giây** và **khi đăng nhập**.
- The first run may trigger macOS **Automation** prompts (`osascript` → Messages). 29. Phê duyệt chúng trong cùng phiên người dùng đang chạy LaunchAgent.

Nạp:

```bash
launchctl unload ~/Library/LaunchAgents/com.user.poke-messages.plist 2>/dev/null || true
launchctl load ~/Library/LaunchAgents/com.user.poke-messages.plist
```

## Hướng dẫn ban đầu

BlueBubbles có sẵn trong trình hướng dẫn thiết lập tương tác:

```
openclaw onboard
```

Trình hướng dẫn sẽ yêu cầu:

- **Server URL** (bắt buộc): địa chỉ máy chủ BlueBubbles (ví dụ: `http://192.168.1.100:1234`)
- **Password** (bắt buộc): mật khẩu API từ cài đặt BlueBubbles Server
- **Webhook path** (tùy chọn): mặc định là `/bluebubbles-webhook`
- **DM policy**: ghép cặp, danh sách cho phép, mở, hoặc vô hiệu hóa
- **Allow list**: số điện thoại, email, hoặc mục tiêu chat

Bạn cũng có thể thêm BlueBubbles qua CLI:

```
openclaw channels add bluebubbles --http-url http://192.168.1.100:1234 --password <password>
```

## Kiểm soát truy cập (DMs + nhóm)

DMs:

- Mặc định: `channels.bluebubbles.dmPolicy = "pairing"`.
- Người gửi chưa biết sẽ nhận mã ghép cặp; tin nhắn bị bỏ qua cho đến khi được phê duyệt (mã hết hạn sau 1 giờ).
- Phê duyệt qua:
  - `openclaw pairing list bluebubbles`
  - `openclaw pairing approve bluebubbles <CODE>`
- Pairing is the default token exchange. 30. Chi tiết: [Pairing](/channels/pairing)

Nhóm:

- `channels.bluebubbles.groupPolicy = open | allowlist | disabled` (mặc định: `allowlist`).
- `channels.bluebubbles.groupAllowFrom` kiểm soát ai có thể kích hoạt trong nhóm khi `allowlist` được đặt.

### Chặn theo mention (nhóm)

BlueBubbles hỗ trợ chặn theo mention cho chat nhóm, phù hợp hành vi iMessage/WhatsApp:

- Dùng `agents.list[].groupChat.mentionPatterns` (hoặc `messages.groupChat.mentionPatterns`) để phát hiện mention.
- Khi `requireMention` được bật cho một nhóm, tác tử chỉ phản hồi khi được mention.
- Lệnh điều khiển từ người gửi được ủy quyền bỏ qua chặn theo mention.

Cấu hình theo nhóm:

```json5
{
  channels: {
    bluebubbles: {
      groupPolicy: "allowlist",
      groupAllowFrom: ["+15555550123"],
      groups: {
        "*": { requireMention: true }, // default for all groups
        "iMessage;-;chat123": { requireMention: false }, // override for specific group
      },
    },
  },
}
```

### Chặn lệnh

- Lệnh điều khiển (ví dụ: `/config`, `/model`) yêu cầu ủy quyền.
- Dùng `allowFrom` và `groupAllowFrom` để xác định quyền lệnh.
- Người gửi được ủy quyền có thể chạy lệnh điều khiển ngay cả khi không mention trong nhóm.

## Trạng thái gõ + xác nhận đã đọc

- **Trạng thái gõ**: gửi tự động trước và trong quá trình tạo phản hồi.
- **Xác nhận đã đọc**: được điều khiển bởi `channels.bluebubbles.sendReadReceipts` (mặc định: `true`).
- **Trạng thái gõ**: OpenClaw gửi sự kiện bắt đầu gõ; BlueBubbles tự xóa trạng thái gõ khi gửi hoặc khi timeout (dừng thủ công qua DELETE không đáng tin cậy).

```json5
{
  channels: {
    bluebubbles: {
      sendReadReceipts: false, // disable read receipts
    },
  },
}
```

## Hành động nâng cao

BlueBubbles hỗ trợ các hành động nâng cao khi được bật trong cấu hình:

```json5
{
  channels: {
    bluebubbles: {
      actions: {
        reactions: true, // tapbacks (default: true)
        edit: true, // edit sent messages (macOS 13+, broken on macOS 26 Tahoe)
        unsend: true, // unsend messages (macOS 13+)
        reply: true, // reply threading by message GUID
        sendWithEffect: true, // message effects (slam, loud, etc.)
        renameGroup: true, // rename group chats
        setGroupIcon: true, // set group chat icon/photo (flaky on macOS 26 Tahoe)
        addParticipant: true, // add participants to groups
        removeParticipant: true, // remove participants from groups
        leaveGroup: true, // leave group chats
        sendAttachment: true, // send attachments/media
      },
    },
  },
}
```

Các hành động khả dụng:

- **react**: Thêm/xóa phản ứng tapback (`messageId`, `emoji`, `remove`)
- **edit**: Chỉnh sửa tin đã gửi (`messageId`, `text`)
- **unsend**: Thu hồi tin nhắn (`messageId`)
- **reply**: Trả lời một tin nhắn cụ thể (`messageId`, `text`, `to`)
- **sendWithEffect**: Gửi kèm hiệu ứng iMessage (`text`, `to`, `effectId`)
- **renameGroup**: Đổi tên chat nhóm (`chatGuid`, `displayName`)
- **setGroupIcon**: Đặt biểu tượng/ảnh cho chat nhóm (`chatGuid`, `media`) — không ổn định trên macOS 26 Tahoe (API có thể trả về thành công nhưng biểu tượng không đồng bộ).
- **addParticipant**: Thêm người vào nhóm (`chatGuid`, `address`)
- **removeParticipant**: Xóa người khỏi nhóm (`chatGuid`, `address`)
- **leaveGroup**: Rời nhóm chat (`chatGuid`)
- **sendAttachment**: Gửi media/tệp (`to`, `buffer`, `filename`, `asVoice`)
  - 31. Voice memo: đặt `asVoice: true` với audio **MP3** hoặc **CAF** để gửi dưới dạng tin nhắn thoại iMessage. 32. BlueBubbles chuyển đổi MP3 → CAF khi gửi voice memo.

### ID tin nhắn (ngắn vs đầy đủ)

OpenClaw có thể hiển thị ID tin nhắn _ngắn_ (ví dụ: `1`, `2`) để tiết kiệm token.

- `MessageSid` / `ReplyToId` có thể là ID ngắn.
- `MessageSidFull` / `ReplyToIdFull` chứa ID đầy đủ của nhà cung cấp.
- ID ngắn nằm trong bộ nhớ; có thể hết hạn khi khởi động lại hoặc bị loại khỏi cache.
- Các hành động chấp nhận `messageId` ngắn hoặc đầy đủ, nhưng ID ngắn sẽ lỗi nếu không còn khả dụng.

Dùng ID đầy đủ cho tự động hóa và lưu trữ lâu dài:

- Mẫu: `{{MessageSidFull}}`, `{{ReplyToIdFull}}`
- Ngữ cảnh: `MessageSidFull` / `ReplyToIdFull` trong payload đến

Xem [Configuration](/gateway/configuration) để biết biến mẫu.

## Chặn streaming

Kiểm soát việc phản hồi được gửi thành một tin nhắn hay stream theo khối:

```json5
{
  channels: {
    bluebubbles: {
      blockStreaming: true, // enable block streaming (off by default)
    },
  },
}
```

## Media + giới hạn

- Tệp đính kèm đến được tải xuống và lưu trong cache media.
- Giới hạn media qua `channels.bluebubbles.mediaMaxMb` (mặc định: 8 MB).
- Văn bản gửi đi được chia khối theo `channels.bluebubbles.textChunkLimit` (mặc định: 4000 ký tự).

## Tham chiếu cấu hình

Cấu hình đầy đủ: [Configuration](/gateway/configuration)

Tùy chọn nhà cung cấp:

- `channels.bluebubbles.enabled`: Bật/tắt kênh.
- `channels.bluebubbles.serverUrl`: URL gốc REST API của BlueBubbles.
- `channels.bluebubbles.password`: Mật khẩu API.
- `channels.bluebubbles.webhookPath`: Đường dẫn endpoint webhook (mặc định: `/bluebubbles-webhook`).
- `channels.bluebubbles.dmPolicy`: `pairing | allowlist | open | disabled` (mặc định: `pairing`).
- `channels.bluebubbles.allowFrom`: Danh sách cho phép DM (handle, email, số E.164, `chat_id:*`, `chat_guid:*`).
- `channels.bluebubbles.groupPolicy`: `open | allowlist | disabled` (mặc định: `allowlist`).
- `channels.bluebubbles.groupAllowFrom`: Danh sách cho phép người gửi trong nhóm.
- `channels.bluebubbles.groups`: Cấu hình theo nhóm (`requireMention`, v.v.).
- `channels.bluebubbles.sendReadReceipts`: Gửi xác nhận đã đọc (mặc định: `true`).
- `channels.bluebubbles.blockStreaming`: Bật streaming theo khối (mặc định: `false`; cần cho phản hồi streaming).
- `channels.bluebubbles.textChunkLimit`: Kích thước khối gửi đi theo ký tự (mặc định: 4000).
- `channels.bluebubbles.chunkMode`: `length` (mặc định) chỉ tách khi vượt `textChunkLimit`; `newline` tách theo dòng trống (ranh giới đoạn) trước khi tách theo độ dài.
- `channels.bluebubbles.mediaMaxMb`: Giới hạn media đến tính bằng MB (mặc định: 8).
- `channels.bluebubbles.historyLimit`: Số tin nhắn nhóm tối đa cho ngữ cảnh (0 để tắt).
- `channels.bluebubbles.dmHistoryLimit`: Giới hạn lịch sử DM.
- `channels.bluebubbles.actions`: Bật/tắt các hành động cụ thể.
- `channels.bluebubbles.accounts`: Cấu hình đa tài khoản.

Tùy chọn toàn cục liên quan:

- `agents.list[].groupChat.mentionPatterns` (hoặc `messages.groupChat.mentionPatterns`).
- `messages.responsePrefix`.

## Địa chỉ hóa / mục tiêu gửi

Ưu tiên `chat_guid` để định tuyến ổn định:

- `chat_guid:iMessage;-;+15555550123` (ưu tiên cho nhóm)
- `chat_id:123`
- `chat_identifier:...`
- Handle trực tiếp: `+15555550123`, `user@example.com`
  - If a direct handle does not have an existing DM chat, OpenClaw will create one via `POST /api/v1/chat/new`. This requires the BlueBubbles Private API to be enabled.

## Bảo mật

- 33. Các yêu cầu webhook được xác thực bằng cách so sánh tham số truy vấn hoặc header `guid`/`password` với `channels.bluebubbles.password`. 34. Các yêu cầu từ `localhost` cũng được chấp nhận.
- Giữ bí mật mật khẩu API và endpoint webhook (coi như thông tin xác thực).
- 35. Việc tin cậy localhost có nghĩa là một reverse proxy cùng máy có thể vô tình vượt qua mật khẩu. 36. Nếu bạn proxy gateway, hãy yêu cầu xác thực tại proxy và cấu hình `gateway.trustedProxies`. See [Gateway security](/gateway/security#reverse-proxy-configuration).
- Bật HTTPS + quy tắc tường lửa trên máy chủ BlueBubbles nếu mở ra ngoài LAN.

## Xử lý sự cố

- Nếu trạng thái gõ/đã đọc ngừng hoạt động, kiểm tra log webhook của BlueBubbles và xác minh đường dẫn gateway khớp `channels.bluebubbles.webhookPath`.
- Mã ghép cặp hết hạn sau một giờ; dùng `openclaw pairing list bluebubbles` và `openclaw pairing approve bluebubbles <code>`.
- Phản ứng yêu cầu BlueBubbles private API (`POST /api/v1/message/react`); đảm bảo phiên bản máy chủ có hỗ trợ.
- Edit/unsend require macOS 13+ and a compatible BlueBubbles server version. On macOS 26 (Tahoe), edit is currently broken due to private API changes.
- Cập nhật biểu tượng nhóm có thể không ổn định trên macOS 26 (Tahoe): API có thể trả về thành công nhưng biểu tượng mới không đồng bộ.
- OpenClaw auto-hides known-broken actions based on the BlueBubbles server's macOS version. If edit still appears on macOS 26 (Tahoe), disable it manually with `channels.bluebubbles.actions.edit=false`.
- Thông tin trạng thái/sức khỏe: `openclaw status --all` hoặc `openclaw status --deep`.

Để tham khảo quy trình kênh nói chung, xem [Channels](/channels) và hướng dẫn [Plugins](/tools/plugin).
