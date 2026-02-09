---
summary: "Thiết lập Slack cho chế độ socket hoặc HTTP webhook"
read_when: "Thiết lập Slack hoặc gỡ lỗi chế độ socket/HTTP của Slack"
title: "Slack"
---

# Slack

## Chế độ Socket (mặc định)

### Thiết lập nhanh (cho người mới)

1. Tạo một Slack app và bật **Socket Mode**.
2. Tạo **App Token** (`xapp-...`) và **Bot Token** (`xoxb-...`).
3. Đặt các token cho OpenClaw và khởi động gateway.

Cấu hình tối thiểu:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### Thiết lập

1. Tạo một Slack app (From scratch) tại [https://api.slack.com/apps](https://api.slack.com/apps).
2. **Socket Mode** → bật. Then go to **Basic Information** → **App-Level Tokens** → **Generate Token and Scopes** with scope `connections:write`. Sao chép **App Token** (`xapp-...`).
3. 2. **OAuth & Permissions** → thêm các bot token scopes (sử dụng manifest bên dưới). 3. Nhấp **Install to Workspace**. 4. Sao chép **Bot User OAuth Token** (`xoxb-...`).
4. 5. Tùy chọn: **OAuth & Permissions** → thêm **User Token Scopes** (xem danh sách chỉ đọc bên dưới). 6. Cài đặt lại ứng dụng và sao chép **User OAuth Token** (`xoxp-...`).
5. **Event Subscriptions** → bật events và đăng ký:
   - `message.*` (bao gồm chỉnh sửa/xóa/phát sóng thread)
   - `app_mention`
   - `reaction_added`, `reaction_removed`
   - `member_joined_channel`, `member_left_channel`
   - `channel_rename`
   - `pin_added`, `pin_removed`
6. Mời bot vào các kênh bạn muốn nó đọc.
7. Slash Commands → tạo `/openclaw` nếu bạn dùng `channels.slack.slashCommand`. 8. Nếu bạn bật native commands, hãy thêm một slash command cho mỗi lệnh tích hợp sẵn (cùng tên như trong `/help`). Mặc định native bị tắt cho Slack trừ khi bạn đặt `channels.slack.commands.native: true` (thiết lập toàn cục `commands.native` là `"auto"` nên để Slack ở trạng thái tắt).
8. App Home → bật **Messages Tab** để người dùng có thể DM bot.

Dùng manifest bên dưới để scopes và events luôn đồng bộ.

Hỗ trợ nhiều tài khoản: dùng `channels.slack.accounts` với token theo từng tài khoản và `name` tùy chọn. 10. Xem [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) để biết mẫu dùng chung.

### Cấu hình OpenClaw (Chế độ Socket)

Đặt token qua biến môi trường (khuyến nghị):

- `SLACK_APP_TOKEN=xapp-...`
- `SLACK_BOT_TOKEN=xoxb-...`

Hoặc qua cấu hình:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
    },
  },
}
```

### User token (tùy chọn)

OpenClaw can use a Slack user token (`xoxp-...`) for read operations (history,
pins, reactions, emoji, member info). By default this stays read-only: reads
prefer the user token when present, and writes still use the bot token unless
you explicitly opt in. 13. Ngay cả khi `userTokenReadOnly: false`, bot token vẫn được ưu tiên cho các thao tác ghi khi nó khả dụng.

User tokens are configured in the config file (no env var support). 15. Đối với multi-account, đặt `channels.slack.accounts.<id>`.userToken\`.

Ví dụ với bot + app + user tokens:

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
    },
  },
}
```

Ví dụ với userTokenReadOnly được đặt rõ (cho phép user token ghi):

```json5
{
  channels: {
    slack: {
      enabled: true,
      appToken: "xapp-...",
      botToken: "xoxb-...",
      userToken: "xoxp-...",
      userTokenReadOnly: false,
    },
  },
}
```

#### Cách dùng token

- Thao tác đọc (lịch sử, danh sách phản ứng, danh sách ghim, danh sách emoji, thông tin thành viên,
  tìm kiếm) ưu tiên user token khi được cấu hình, nếu không thì dùng bot token.
- Các thao tác ghi (gửi/sửa/xóa tin nhắn, thêm/xóa reaction, ghim/bỏ ghim,
  tải tệp lên) mặc định sử dụng bot token. If `userTokenReadOnly: false` and
  no bot token is available, OpenClaw falls back to the user token.

### Ngữ cảnh lịch sử

- `channels.slack.historyLimit` (hoặc `channels.slack.accounts.*.historyLimit`) điều khiển số lượng tin nhắn gần đây của kênh/nhóm được gói vào prompt.
- Falls back to `messages.groupChat.historyLimit`. Set `0` to disable (default 50).

## Chế độ HTTP (Events API)

Use HTTP webhook mode when your Gateway is reachable by Slack over HTTPS (typical for server deployments).
HTTP mode uses the Events API + Interactivity + Slash Commands with a shared request URL.

### Thiết lập (Chế độ HTTP)

1. Tạo Slack app và **tắt Socket Mode** (tùy chọn nếu bạn chỉ dùng HTTP).
2. **Basic Information** → sao chép **Signing Secret**.
3. **OAuth & Permissions** → cài đặt app và sao chép **Bot User OAuth Token** (`xoxb-...`).
4. **Event Subscriptions** → bật events và đặt **Request URL** trỏ tới đường dẫn webhook của gateway (mặc định `/slack/events`).
5. **Interactivity & Shortcuts** → bật và đặt cùng **Request URL**.
6. **Slash Commands** → đặt cùng **Request URL** cho các lệnh.

Ví dụ Request URL:
`https://gateway-host/slack/events`

### Cấu hình OpenClaw (tối thiểu)

```json5
{
  channels: {
    slack: {
      enabled: true,
      mode: "http",
      botToken: "xoxb-...",
      signingSecret: "your-signing-secret",
      webhookPath: "/slack/events",
    },
  },
}
```

23. Chế độ HTTP multi-account: đặt `channels.slack.accounts.<id>`.mode = "http"`and provide a unique`webhookPath\` per account so each Slack app can point to its own URL.

### Manifest (tùy chọn)

25. Sử dụng Slack app manifest này để tạo ứng dụng nhanh chóng (điều chỉnh tên/lệnh nếu bạn muốn). Include the
    user scopes if you plan to configure a user token.

```json
{
  "display_information": {
    "name": "OpenClaw",
    "description": "Slack connector for OpenClaw"
  },
  "features": {
    "bot_user": {
      "display_name": "OpenClaw",
      "always_online": false
    },
    "app_home": {
      "messages_tab_enabled": true,
      "messages_tab_read_only_enabled": false
    },
    "slash_commands": [
      {
        "command": "/openclaw",
        "description": "Send a message to OpenClaw",
        "should_escape": false
      }
    ]
  },
  "oauth_config": {
    "scopes": {
      "bot": [
        "chat:write",
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "groups:write",
        "im:history",
        "im:read",
        "im:write",
        "mpim:history",
        "mpim:read",
        "mpim:write",
        "users:read",
        "app_mentions:read",
        "reactions:read",
        "reactions:write",
        "pins:read",
        "pins:write",
        "emoji:read",
        "commands",
        "files:read",
        "files:write"
      ],
      "user": [
        "channels:history",
        "channels:read",
        "groups:history",
        "groups:read",
        "im:history",
        "im:read",
        "mpim:history",
        "mpim:read",
        "users:read",
        "reactions:read",
        "pins:read",
        "emoji:read",
        "search:read"
      ]
    }
  },
  "settings": {
    "socket_mode_enabled": true,
    "event_subscriptions": {
      "bot_events": [
        "app_mention",
        "message.channels",
        "message.groups",
        "message.im",
        "message.mpim",
        "reaction_added",
        "reaction_removed",
        "member_joined_channel",
        "member_left_channel",
        "channel_rename",
        "pin_added",
        "pin_removed"
      ]
    }
  }
}
```

Nếu bạn bật native commands, hãy thêm một mục `slash_commands` cho mỗi lệnh bạn muốn công bố (khớp với danh sách `/help`). Ghi đè bằng `channels.slack.commands.native`.

## Scopes (hiện tại vs tùy chọn)

Slack's Conversations API is type-scoped: you only need the scopes for the
conversation types you actually touch (channels, groups, im, mpim). See
[https://docs.slack.dev/apis/web-api/using-the-conversations-api/](https://docs.slack.dev/apis/web-api/using-the-conversations-api/) for the overview.

### Bot token scopes (bắt buộc)

- `chat:write` (gửi/cập nhật/xóa tin nhắn qua `chat.postMessage`)
  [https://docs.slack.dev/reference/methods/chat.postMessage](https://docs.slack.dev/reference/methods/chat.postMessage)
- `im:write` (mở DM qua `conversations.open` cho DM người dùng)
  [https://docs.slack.dev/reference/methods/conversations.open](https://docs.slack.dev/reference/methods/conversations.open)
- `channels:history`, `groups:history`, `im:history`, `mpim:history`
  [https://docs.slack.dev/reference/methods/conversations.history](https://docs.slack.dev/reference/methods/conversations.history)
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
  [https://docs.slack.dev/reference/methods/conversations.info](https://docs.slack.dev/reference/methods/conversations.info)
- `users:read` (tra cứu người dùng)
  [https://docs.slack.dev/reference/methods/users.info](https://docs.slack.dev/reference/methods/users.info)
- `reactions:read`, `reactions:write` (`reactions.get` / `reactions.add`)
  [https://docs.slack.dev/reference/methods/reactions.get](https://docs.slack.dev/reference/methods/reactions.get)
  [https://docs.slack.dev/reference/methods/reactions.add](https://docs.slack.dev/reference/methods/reactions.add)
- `pins:read`, `pins:write` (`pins.list` / `pins.add` / `pins.remove`)
  [https://docs.slack.dev/reference/scopes/pins.read](https://docs.slack.dev/reference/scopes/pins.read)
  [https://docs.slack.dev/reference/scopes/pins.write](https://docs.slack.dev/reference/scopes/pins.write)
- `emoji:read` (`emoji.list`)
  [https://docs.slack.dev/reference/scopes/emoji.read](https://docs.slack.dev/reference/scopes/emoji.read)
- `files:write` (tải lên qua `files.uploadV2`)
  [https://docs.slack.dev/messaging/working-with-files/#upload](https://docs.slack.dev/messaging/working-with-files/#upload)

### User token scopes (tùy chọn, mặc định chỉ đọc)

Thêm các scope này dưới **User Token Scopes** nếu bạn cấu hình `channels.slack.userToken`.

- `channels:history`, `groups:history`, `im:history`, `mpim:history`
- `channels:read`, `groups:read`, `im:read`, `mpim:read`
- `users:read`
- `reactions:read`
- `pins:read`
- `emoji:read`
- `search:read`

### Chưa cần hiện tại (nhưng có thể trong tương lai)

- `mpim:write` (chỉ khi thêm mở group-DM/bắt đầu DM qua `conversations.open`)
- `groups:write` (chỉ khi thêm quản lý kênh riêng: tạo/đổi tên/mời/lưu trữ)
- `chat:write.public` (chỉ khi muốn đăng vào kênh mà bot không tham gia)
  [https://docs.slack.dev/reference/scopes/chat.write.public](https://docs.slack.dev/reference/scopes/chat.write.public)
- `users:read.email` (chỉ khi cần trường email từ `users.info`)
  [https://docs.slack.dev/changelog/2017-04-narrowing-email-access](https://docs.slack.dev/changelog/2017-04-narrowing-email-access)
- `files:read` (chỉ khi bắt đầu liệt kê/đọc metadata tệp)

## Cấu hình

31. Slack chỉ sử dụng Socket Mode (không có HTTP webhook server). 32. Cung cấp cả hai token:

```json
{
  "slack": {
    "enabled": true,
    "botToken": "xoxb-...",
    "appToken": "xapp-...",
    "groupPolicy": "allowlist",
    "dm": {
      "enabled": true,
      "policy": "pairing",
      "allowFrom": ["U123", "U456", "*"],
      "groupEnabled": false,
      "groupChannels": ["G123"],
      "replyToMode": "all"
    },
    "channels": {
      "C123": { "allow": true, "requireMention": true },
      "#general": {
        "allow": true,
        "requireMention": true,
        "users": ["U123"],
        "skills": ["search", "docs"],
        "systemPrompt": "Keep answers short."
      }
    },
    "reactionNotifications": "own",
    "reactionAllowlist": ["U123"],
    "replyToMode": "off",
    "actions": {
      "reactions": true,
      "messages": true,
      "pins": true,
      "memberInfo": true,
      "emojiList": true
    },
    "slashCommand": {
      "enabled": true,
      "name": "openclaw",
      "sessionPrefix": "slack:slash",
      "ephemeral": true
    },
    "textChunkLimit": 4000,
    "mediaMaxMb": 20
  }
}
```

Token cũng có thể cung cấp qua biến môi trường:

- `SLACK_BOT_TOKEN`
- `SLACK_APP_TOKEN`

33. Ack reactions được điều khiển toàn cục qua `messages.ackReaction` + `messages.ackReactionScope`. 34. Sử dụng `messages.removeAckAfterReply` để xóa phản ứng ack sau khi bot trả lời.

## Giới hạn

- Văn bản gửi đi được chia khối theo `channels.slack.textChunkLimit` (mặc định 4000).
- Chia theo dòng trống (tùy chọn): đặt `channels.slack.chunkMode="newline"` để tách theo dòng trống (ranh giới đoạn) trước khi chia theo độ dài.
- Tải lên media bị giới hạn bởi `channels.slack.mediaMaxMb` (mặc định 20).

## Luồng trả lời (thread)

By default, OpenClaw replies in the main channel. 36. Sử dụng `channels.slack.replyToMode` để điều khiển việc tự động tạo thread:

| Mode    | Behavior                                                                                                                                                                                                                                           |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `off`   | 37. **Mặc định.** Trả lời trong kênh chính. 38. Chỉ tạo thread nếu tin nhắn kích hoạt đã nằm trong một thread.                                              |
| `first` | 39. Phản hồi đầu tiên vào thread (bên dưới tin nhắn kích hoạt), các phản hồi tiếp theo vào kênh chính. Useful for keeping context visible while avoiding thread clutter. |
| `all`   | All replies go to thread. Keeps conversations contained but may reduce visibility.                                                                                                                                 |

Chế độ áp dụng cho cả trả lời tự động và lời gọi công cụ của tác tử (`slack sendMessage`).

### Thread theo từng loại chat

Bạn có thể cấu hình hành vi threading khác nhau cho từng loại chat bằng cách đặt `channels.slack.replyToModeByChatType`:

```json5
{
  channels: {
    slack: {
      replyToMode: "off", // default for channels
      replyToModeByChatType: {
        direct: "all", // DMs always thread
        group: "first", // group DMs/MPIM thread first reply
      },
    },
  },
}
```

Các loại chat được hỗ trợ:

- `direct`: DM 1:1 (Slack `im`)
- `group`: DM nhóm / MPIM (Slack `mpim`)
- `channel`: kênh tiêu chuẩn (công khai/riêng tư)

Thứ tự ưu tiên:

1. `replyToModeByChatType.<chatType>`
2. `replyToMode`
3. Mặc định của nhà cung cấp (`off`)

`channels.slack.dm.replyToMode` (cũ) vẫn được chấp nhận như phương án dự phòng cho `direct` khi không đặt ghi đè theo loại chat.

Ví dụ:

Chỉ thread DM:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { direct: "all" },
    },
  },
}
```

Thread DM nhóm nhưng giữ kênh ở gốc:

```json5
{
  channels: {
    slack: {
      replyToMode: "off",
      replyToModeByChatType: { group: "first" },
    },
  },
}
```

Cho kênh vào thread, giữ DM ở gốc:

```json5
{
  channels: {
    slack: {
      replyToMode: "first",
      replyToModeByChatType: { direct: "off", group: "off" },
    },
  },
}
```

### Thẻ thread thủ công

Để kiểm soát chi tiết, dùng các thẻ này trong phản hồi của tác tử:

- `[[reply_to_current]]` — trả lời tin nhắn kích hoạt (bắt đầu/tiếp tục thread).
- `[[reply_to:<id>]]` — trả lời một message id cụ thể.

## Phiên + định tuyến

- DM dùng chung phiên `main` (giống WhatsApp/Telegram).
- Kênh ánh xạ tới phiên `agent:<agentId>:slack:channel:<channelId>`.
- Slash commands dùng phiên `agent:<agentId>:slack:slash:<userId>` (tiền tố cấu hình qua `channels.slack.slashCommand.sessionPrefix`).
- Nếu Slack không cung cấp `channel_type`, OpenClaw suy ra từ tiền tố ID kênh (`D`, `C`, `G`) và mặc định về `channel` để giữ khóa phiên ổn định.
- Native command registration uses `commands.native` (global default `"auto"` → Slack off) and can be overridden per-workspace with `channels.slack.commands.native`. Text commands require standalone `/...` messages and can be disabled with `commands.text: false`. 47. Slack slash commands được quản lý trong Slack app và không bị tự động xóa. 48. Sử dụng `commands.useAccessGroups: false` để bỏ qua kiểm tra access-group cho các lệnh.
- Danh sách lệnh đầy đủ + cấu hình: [Slash commands](/tools/slash-commands)

## Bảo mật DM (ghép cặp)

- Mặc định: `channels.slack.dm.policy="pairing"` — người gửi DM chưa biết sẽ nhận mã ghép cặp (hết hạn sau 1 giờ).
- Phê duyệt qua: `openclaw pairing approve slack <code>`.
- Cho phép mọi người: đặt `channels.slack.dm.policy="open"` và `channels.slack.dm.allowFrom=["*"]`.
- 49. `channels.slack.dm.allowFrom` chấp nhận user ID, @handle hoặc email (được resolve khi khởi động nếu token cho phép). 50. Wizard chấp nhận username và resolve chúng thành id trong quá trình thiết lập khi token cho phép.

## Chính sách nhóm

- `channels.slack.groupPolicy` điều khiển xử lý kênh (`open|disabled|allowlist`).
- `allowlist` yêu cầu kênh phải được liệt kê trong `channels.slack.channels`.
- If you only set `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN` and never create a `channels.slack` section,
  the runtime defaults `groupPolicy` to `open`. Add `channels.slack.groupPolicy`,
  `channels.defaults.groupPolicy`, or a channel allowlist to lock it down.
- Trình cấu hình chấp nhận tên `#channel` và phân giải sang ID khi có thể
  (công khai + riêng tư); nếu có nhiều kết quả trùng, nó ưu tiên kênh đang hoạt động.
- Khi khởi động, OpenClaw phân giải tên kênh/người dùng trong allowlist sang ID (khi token cho phép)
  và ghi log ánh xạ; các mục không phân giải được sẽ giữ nguyên như đã nhập.
- Để **không cho phép kênh nào**, đặt `channels.slack.groupPolicy: "disabled"` (hoặc giữ allowlist rỗng).

Channel options (`channels.slack.channels.<id>` or `channels.slack.channels.<name>`):

- `allow`: cho phép/từ chối kênh khi `groupPolicy="allowlist"`.
- `requireMention`: kiểm soát nhắc tên cho kênh.
- `tools`: ghi đè chính sách công cụ theo kênh (tùy chọn) (`allow`/`deny`/`alsoAllow`).
- `toolsBySender`: ghi đè chính sách công cụ theo người gửi trong kênh (khóa là sender id/@handle/email; hỗ trợ wildcard `"*"`).
- `allowBots`: cho phép tin nhắn do bot tạo trong kênh này (mặc định: false).
- `users`: allowlist người dùng theo kênh (tùy chọn).
- `skills`: bộ lọc skill (bỏ qua = tất cả skills, rỗng = không skill nào).
- `systemPrompt`: system prompt bổ sung cho kênh (kết hợp với topic/purpose).
- `enabled`: đặt `false` để tắt kênh.

## Đích gửi

Dùng với cron/CLI gửi:

- `user:<id>` cho DM
- `channel:<id>` cho kênh

## Hành động công cụ

Hành động công cụ Slack có thể bị giới hạn bằng `channels.slack.actions.*`:

| Nhóm hành động | Mặc định | Ghi chú                     |
| -------------- | -------- | --------------------------- |
| reactions      | bật      | Phản ứng + liệt kê phản ứng |
| messages       | bật      | Đọc/gửi/sửa/xóa             |
| pins           | bật      | Ghim/bỏ ghim/liệt kê        |
| memberInfo     | bật      | Thông tin thành viên        |
| emojiList      | bật      | Danh sách emoji tùy chỉnh   |

## Ghi chú bảo mật

- Thao tác ghi mặc định dùng bot token để các hành động thay đổi trạng thái
  được giới hạn trong quyền và danh tính của bot.
- Setting `userTokenReadOnly: false` allows the user token to be used for write
  operations when a bot token is unavailable, which means actions run with the
  installing user's access. Treat the user token as highly privileged and keep
  action gates and allowlists tight.
- Nếu bật ghi bằng user token, hãy đảm bảo user token có các scope ghi
  tương ứng (`chat:write`, `reactions:write`, `pins:write`,
  `files:write`) nếu không các thao tác đó sẽ thất bại.

## Xử lý sự cố

Chạy theo thứ tự này trước:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Sau đó xác nhận trạng thái ghép cặp DM nếu cần:

```bash
openclaw pairing list slack
```

Lỗi thường gặp:

- Đã kết nối nhưng không có trả lời ở kênh: kênh bị chặn bởi `groupPolicy` hoặc không nằm trong allowlist `channels.slack.channels`.
- DM bị bỏ qua: người gửi chưa được phê duyệt khi `channels.slack.dm.policy="pairing"`.
- Lỗi API (`missing_scope`, `not_in_channel`, lỗi xác thực): bot/app token hoặc Slack scopes chưa đầy đủ.

Luồng xử lý triage: [/channels/troubleshooting](/channels/troubleshooting).

## Ghi chú

- Kiểm soát nhắc tên được điều khiển qua `channels.slack.channels` (đặt `requireMention` thành `true`); `agents.list[].groupChat.mentionPatterns` (hoặc `messages.groupChat.mentionPatterns`) cũng được tính là nhắc tên.
- Ghi đè đa tác tử: đặt mẫu theo từng tác tử trong `agents.list[].groupChat.mentionPatterns`.
- Thông báo phản ứng tuân theo `channels.slack.reactionNotifications` (dùng `reactionAllowlist` với chế độ `allowlist`).
- Bot-authored messages are ignored by default; enable via `channels.slack.allowBots` or `channels.slack.channels.<id>.allowBots`.
- Warning: If you allow replies to other bots (`channels.slack.allowBots=true` or `channels.slack.channels.<id>.allowBots=true`), prevent bot-to-bot reply loops with `requireMention`, `channels.slack.channels.<id>.users` allowlists, and/or clear guardrails in `AGENTS.md` and `SOUL.md`.
- Với công cụ Slack, ngữ nghĩa xóa phản ứng nằm tại [/tools/reactions](/tools/reactions).
- Tệp đính kèm được tải xuống kho media khi được phép và dưới giới hạn kích thước.
