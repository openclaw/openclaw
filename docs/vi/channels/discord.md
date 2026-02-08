---
summary: "Trạng thái hỗ trợ bot Discord, khả năng và cấu hình"
read_when:
  - Làm việc trên các tính năng kênh Discord
title: "Discord"
x-i18n:
  source_path: channels/discord.md
  source_hash: 9bebfe8027ff1972
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:38:45Z
---

# Discord (Bot API)

Trạng thái: sẵn sàng cho DM và kênh văn bản guild thông qua gateway bot Discord chính thức.

## Thiết lập nhanh (cho người mới)

1. Tạo một bot Discord và sao chép bot token.
2. Trong phần cài đặt ứng dụng Discord, bật **Message Content Intent** (và **Server Members Intent** nếu bạn dự định dùng allowlist hoặc tra cứu tên).
3. Đặt token cho OpenClaw:
   - Env: `DISCORD_BOT_TOKEN=...`
   - Hoặc config: `channels.discord.token: "..."`.
   - Nếu cả hai đều được đặt, config sẽ được ưu tiên (env fallback chỉ áp dụng cho tài khoản mặc định).
4. Mời bot vào server của bạn với quyền gửi tin nhắn (tạo server riêng nếu bạn chỉ muốn dùng DM).
5. Khởi động gateway.
6. Truy cập DM mặc định là ghép cặp; phê duyệt mã ghép cặp khi liên hệ lần đầu.

Cấu hình tối thiểu:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

## Mục tiêu

- Trò chuyện với OpenClaw qua Discord DM hoặc kênh guild.
- Chat trực tiếp sẽ gộp vào phiên chính của tác tử (mặc định `agent:main:main`); các kênh guild được tách biệt thành `agent:<agentId>:discord:channel:<channelId>` (tên hiển thị dùng `discord:<guildSlug>#<channelSlug>`).
- Group DM bị bỏ qua theo mặc định; bật bằng `channels.discord.dm.groupEnabled` và có thể giới hạn bằng `channels.discord.dm.groupChannels`.
- Giữ định tuyến mang tính quyết định: phản hồi luôn quay lại đúng kênh đã nhận.

## Cách hoạt động

1. Tạo một ứng dụng Discord → Bot, bật các intent cần thiết (DM + tin nhắn guild + nội dung tin nhắn), và lấy bot token.
2. Mời bot vào server với các quyền cần thiết để đọc/gửi tin nhắn tại nơi bạn muốn sử dụng.
3. Cấu hình OpenClaw với `channels.discord.token` (hoặc `DISCORD_BOT_TOKEN` làm phương án dự phòng).
4. Chạy gateway; nó tự động khởi động kênh Discord khi có token (ưu tiên config, env là fallback) và `channels.discord.enabled` không phải là `false`.
   - Nếu bạn thích dùng biến môi trường, đặt `DISCORD_BOT_TOKEN` (khối config là tùy chọn).
5. Chat trực tiếp: dùng `user:<id>` (hoặc nhắc `<@id>`) khi gửi; tất cả lượt hội thoại sẽ vào phiên dùng chung `main`. ID số trần là mơ hồ và sẽ bị từ chối.
6. Kênh guild: dùng `channel:<channelId>` để gửi. Theo mặc định yêu cầu mention và có thể đặt theo từng guild hoặc từng kênh.
7. Chat trực tiếp: bảo mật theo mặc định qua `channels.discord.dm.policy` (mặc định: `"pairing"`). Người gửi chưa biết sẽ nhận mã ghép cặp (hết hạn sau 1 giờ); phê duyệt qua `openclaw pairing approve discord <code>`.
   - Để giữ hành vi cũ “mở cho mọi người”: đặt `channels.discord.dm.policy="open"` và `channels.discord.dm.allowFrom=["*"]`.
   - Để áp dụng allowlist chặt chẽ: đặt `channels.discord.dm.policy="allowlist"` và liệt kê người gửi trong `channels.discord.dm.allowFrom`.
   - Để bỏ qua toàn bộ DM: đặt `channels.discord.dm.enabled=false` hoặc `channels.discord.dm.policy="disabled"`.
8. Group DM bị bỏ qua theo mặc định; bật bằng `channels.discord.dm.groupEnabled` và có thể giới hạn bằng `channels.discord.dm.groupChannels`.
9. Quy tắc guild tùy chọn: đặt `channels.discord.guilds` theo guild id (khuyến nghị) hoặc slug, với quy tắc theo kênh.
10. Lệnh gốc tùy chọn: `commands.native` mặc định là `"auto"` (bật cho Discord/Telegram, tắt cho Slack). Ghi đè bằng `channels.discord.commands.native: true|false|"auto"`; `false` xóa các lệnh đã đăng ký trước đó. Lệnh văn bản được điều khiển bởi `commands.text` và phải được gửi như các tin nhắn `/...` độc lập. Dùng `commands.useAccessGroups: false` để bỏ qua kiểm tra nhóm truy cập cho lệnh.
    - Danh sách lệnh đầy đủ + cấu hình: [Slash commands](/tools/slash-commands)
11. Lịch sử ngữ cảnh guild tùy chọn: đặt `channels.discord.historyLimit` (mặc định 20, fallback về `messages.groupChat.historyLimit`) để đưa N tin nhắn guild gần nhất làm ngữ cảnh khi trả lời một mention. Đặt `0` để tắt.
12. Phản ứng: tác tử có thể kích hoạt phản ứng thông qua công cụ `discord` (được kiểm soát bởi `channels.discord.actions.*`).
    - Ngữ nghĩa gỡ phản ứng: xem [/tools/reactions](/tools/reactions).
    - Công cụ `discord` chỉ được hiển thị khi kênh hiện tại là Discord.
13. Lệnh gốc dùng khóa phiên tách biệt (`agent:<agentId>:discord:slash:<userId>`) thay vì phiên dùng chung `main`.

Lưu ý: Phân giải tên → id dùng tìm kiếm thành viên guild và yêu cầu Server Members Intent; nếu bot không thể tìm kiếm thành viên, hãy dùng id hoặc mention `<@id>`.
Lưu ý: Slug là chữ thường với khoảng trắng được thay bằng `-`. Tên kênh được slug hóa mà không có ký tự `#` ở đầu.
Lưu ý: Các dòng ngữ cảnh guild `[from:]` bao gồm `author.tag` + `id` để dễ tạo phản hồi có thể ping.

## Ghi cấu hình

Theo mặc định, Discord được phép ghi các cập nhật cấu hình được kích hoạt bởi `/config set|unset` (yêu cầu `commands.config: true`).

Tắt bằng:

```json5
{
  channels: { discord: { configWrites: false } },
}
```

## Cách tạo bot của riêng bạn

Đây là thiết lập “Discord Developer Portal” để chạy OpenClaw trong một kênh server (guild) như `#help`.

### 1) Tạo ứng dụng Discord + người dùng bot

1. Discord Developer Portal → **Applications** → **New Application**
2. Trong ứng dụng của bạn:
   - **Bot** → **Add Bot**
   - Sao chép **Bot Token** (đây là thứ bạn đặt vào `DISCORD_BOT_TOKEN`)

### 2) Bật các gateway intent mà OpenClaw cần

Discord chặn “privileged intents” trừ khi bạn bật rõ ràng.

Trong **Bot** → **Privileged Gateway Intents**, bật:

- **Message Content Intent** (bắt buộc để đọc nội dung tin nhắn ở hầu hết guild; nếu không bạn sẽ thấy “Used disallowed intents” hoặc bot kết nối nhưng không phản hồi tin nhắn)
- **Server Members Intent** (khuyến nghị; bắt buộc cho một số tra cứu thành viên/người dùng và khớp allowlist trong guild)

Thông thường bạn **không** cần **Presence Intent**. Việc đặt trạng thái hiện diện của chính bot (hành động `setPresence`) dùng gateway OP3 và không cần intent này; nó chỉ cần nếu bạn muốn nhận cập nhật hiện diện của các thành viên guild khác.

### 3) Tạo URL mời (OAuth2 URL Generator)

Trong ứng dụng của bạn: **OAuth2** → **URL Generator**

**Scopes**

- ✅ `bot`
- ✅ `applications.commands` (bắt buộc cho lệnh gốc)

**Bot Permissions** (tối thiểu)

- ✅ View Channels
- ✅ Send Messages
- ✅ Read Message History
- ✅ Embed Links
- ✅ Attach Files
- ✅ Add Reactions (tùy chọn nhưng khuyến nghị)
- ✅ Use External Emojis / Stickers (tùy chọn; chỉ khi bạn muốn dùng)

Tránh **Administrator** trừ khi bạn đang gỡ lỗi và hoàn toàn tin tưởng bot.

Sao chép URL đã tạo, mở nó, chọn server của bạn và cài đặt bot.

### 4) Lấy các id (guild/user/channel)

Discord dùng id số ở mọi nơi; cấu hình OpenClaw ưu tiên id.

1. Discord (desktop/web) → **User Settings** → **Advanced** → bật **Developer Mode**
2. Nhấp chuột phải:
   - Tên server → **Copy Server ID** (guild id)
   - Kênh (ví dụ `#help`) → **Copy Channel ID**
   - Người dùng của bạn → **Copy User ID**

### 5) Cấu hình OpenClaw

#### Token

Đặt bot token qua biến môi trường (khuyến nghị trên server):

- `DISCORD_BOT_TOKEN=...`

Hoặc qua config:

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "YOUR_BOT_TOKEN",
    },
  },
}
```

Hỗ trợ nhiều tài khoản: dùng `channels.discord.accounts` với token theo từng tài khoản và `name` tùy chọn. Xem [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) để biết mẫu dùng chung.

#### Allowlist + định tuyến kênh

Ví dụ “một server, chỉ cho phép tôi, chỉ cho phép #help”:

```json5
{
  channels: {
    discord: {
      enabled: true,
      dm: { enabled: false },
      guilds: {
        YOUR_GUILD_ID: {
          users: ["YOUR_USER_ID"],
          requireMention: true,
          channels: {
            help: { allow: true, requireMention: true },
          },
        },
      },
      retry: {
        attempts: 3,
        minDelayMs: 500,
        maxDelayMs: 30000,
        jitter: 0.1,
      },
    },
  },
}
```

Ghi chú:

- `requireMention: true` nghĩa là bot chỉ trả lời khi được mention (khuyến nghị cho kênh dùng chung).
- `agents.list[].groupChat.mentionPatterns` (hoặc `messages.groupChat.mentionPatterns`) cũng được tính là mention cho tin nhắn guild.
- Ghi đè đa tác tử: đặt mẫu theo từng tác tử tại `agents.list[].groupChat.mentionPatterns`.
- Nếu có `channels`, mọi kênh không được liệt kê sẽ bị từ chối theo mặc định.
- Dùng mục kênh `"*"` để áp dụng mặc định cho tất cả kênh; mục kênh cụ thể sẽ ghi đè wildcard.
- Thread kế thừa cấu hình kênh cha (allowlist, `requireMention`, skills, prompt, v.v.) trừ khi bạn thêm id thread cụ thể.
- Gợi ý chủ sở hữu: khi allowlist `users` theo guild hoặc kênh khớp người gửi, OpenClaw coi người gửi đó là chủ sở hữu trong system prompt. Để có chủ sở hữu toàn cục trên các kênh, đặt `commands.ownerAllowFrom`.
- Tin nhắn do bot tạo bị bỏ qua theo mặc định; đặt `channels.discord.allowBots=true` để cho phép (tin nhắn của chính bot vẫn bị lọc).
- Cảnh báo: Nếu bạn cho phép trả lời bot khác (`channels.discord.allowBots=true`), hãy ngăn vòng lặp bot-đối-bot bằng `requireMention`, allowlist `channels.discord.guilds.*.channels.<id>.users`, và/hoặc xóa guardrail trong `AGENTS.md` và `SOUL.md`.

### 6) Xác minh hoạt động

1. Khởi động gateway.
2. Trong kênh server của bạn, gửi: `@Krill hello` (hoặc tên bot của bạn).
3. Nếu không có gì xảy ra: xem **Xử lý sự cố** bên dưới.

### Xử lý sự cố

- Đầu tiên: chạy `openclaw doctor` và `openclaw channels status --probe` (cảnh báo có thể hành động + kiểm tra nhanh).
- **“Used disallowed intents”**: bật **Message Content Intent** (và có thể **Server Members Intent**) trong Developer Portal, sau đó khởi động lại gateway.
- **Bot kết nối nhưng không bao giờ trả lời trong kênh guild**:
  - Thiếu **Message Content Intent**, hoặc
  - Bot thiếu quyền kênh (View/Send/Read History), hoặc
  - Cấu hình yêu cầu mention và bạn không mention, hoặc
  - Allowlist guild/kênh từ chối kênh/người dùng.
- **`requireMention: false` nhưng vẫn không có phản hồi**:
- `channels.discord.groupPolicy` mặc định là **allowlist**; đặt thành `"open"` hoặc thêm mục guild dưới `channels.discord.guilds` (tùy chọn liệt kê kênh dưới `channels.discord.guilds.<id>.channels` để giới hạn).
  - Nếu bạn chỉ đặt `DISCORD_BOT_TOKEN` và không bao giờ tạo phần `channels.discord`, runtime
    mặc định `groupPolicy` thành `open`. Thêm `channels.discord.groupPolicy`,
    `channels.defaults.groupPolicy`, hoặc allowlist guild/kênh để khóa chặt.
- `requireMention` phải nằm dưới `channels.discord.guilds` (hoặc một kênh cụ thể). `channels.discord.requireMention` ở cấp cao nhất sẽ bị bỏ qua.
- **Kiểm tra quyền** (`channels status --probe`) chỉ kiểm tra id kênh số. Nếu bạn dùng slug/tên làm khóa `channels.discord.guilds.*.channels`, kiểm tra không thể xác minh quyền.
- **DM không hoạt động**: `channels.discord.dm.enabled=false`, `channels.discord.dm.policy="disabled"`, hoặc bạn chưa được phê duyệt (`channels.discord.dm.policy="pairing"`).
- **Phê duyệt exec trong Discord**: Discord hỗ trợ **UI nút bấm** cho phê duyệt exec trong DM (Allow once / Always allow / Deny). `/approve <id> ...` chỉ dành cho phê duyệt được chuyển tiếp và sẽ không giải quyết các prompt nút bấm của Discord. Nếu bạn thấy `❌ Failed to submit approval: Error: unknown approval id` hoặc UI không bao giờ hiện, hãy kiểm tra:
  - `channels.discord.execApprovals.enabled: true` trong config của bạn.
  - User ID Discord của bạn có nằm trong `channels.discord.execApprovals.approvers` (UI chỉ gửi cho người phê duyệt).
  - Dùng các nút trong DM (**Allow once**, **Always allow**, **Deny**).
  - Xem [Exec approvals](/tools/exec-approvals) và [Slash commands](/tools/slash-commands) để hiểu luồng phê duyệt và lệnh tổng thể.

## Khả năng & giới hạn

- DM và kênh văn bản guild (thread được xem là kênh riêng; không hỗ trợ voice).
- Chỉ báo đang gõ được gửi theo best-effort; chia nhỏ tin nhắn dùng `channels.discord.textChunkLimit` (mặc định 2000) và tách phản hồi dài theo số dòng (`channels.discord.maxLinesPerMessage`, mặc định 17).
- Chia nhỏ theo dòng trống tùy chọn: đặt `channels.discord.chunkMode="newline"` để tách theo dòng trống (ranh giới đoạn) trước khi chia theo độ dài.
- Hỗ trợ tải tệp lên đến `channels.discord.mediaMaxMb` đã cấu hình (mặc định 8 MB).
- Trả lời trong guild được chặn bằng mention theo mặc định để tránh bot ồn ào.
- Ngữ cảnh trả lời được chèn khi một tin nhắn tham chiếu tin nhắn khác (nội dung trích dẫn + id).
- Thread trả lời gốc **tắt theo mặc định**; bật bằng `channels.discord.replyToMode` và thẻ reply.

## Chính sách retry

Các lệnh gọi Discord API đi ra sẽ retry khi gặp giới hạn tốc độ (429) bằng `retry_after` của Discord khi có, với backoff theo cấp số nhân và jitter. Cấu hình qua `channels.discord.retry`. Xem [Retry policy](/concepts/retry).

## Cấu hình

```json5
{
  channels: {
    discord: {
      enabled: true,
      token: "abc.123",
      groupPolicy: "allowlist",
      guilds: {
        "*": {
          channels: {
            general: { allow: true },
          },
        },
      },
      mediaMaxMb: 8,
      actions: {
        reactions: true,
        stickers: true,
        emojiUploads: true,
        stickerUploads: true,
        polls: true,
        permissions: true,
        messages: true,
        threads: true,
        pins: true,
        search: true,
        memberInfo: true,
        roleInfo: true,
        roles: false,
        channelInfo: true,
        channels: true,
        voiceStatus: true,
        events: true,
        moderation: false,
        presence: false,
      },
      replyToMode: "off",
      dm: {
        enabled: true,
        policy: "pairing", // pairing | allowlist | open | disabled
        allowFrom: ["123456789012345678", "steipete"],
        groupEnabled: false,
        groupChannels: ["openclaw-dm"],
      },
      guilds: {
        "*": { requireMention: true },
        "123456789012345678": {
          slug: "friends-of-openclaw",
          requireMention: false,
          reactionNotifications: "own",
          users: ["987654321098765432", "steipete"],
          channels: {
            general: { allow: true },
            help: {
              allow: true,
              requireMention: true,
              users: ["987654321098765432"],
              skills: ["search", "docs"],
              systemPrompt: "Keep answers short.",
            },
          },
        },
      },
    },
  },
}
```

Phản ứng xác nhận (ack) được điều khiển toàn cục qua `messages.ackReaction` +
`messages.ackReactionScope`. Dùng `messages.removeAckAfterReply` để xóa
phản ứng ack sau khi bot trả lời.

- `dm.enabled`: đặt `false` để bỏ qua tất cả DM (mặc định `true`).
- `dm.policy`: kiểm soát truy cập DM (`pairing` được khuyến nghị). `"open"` yêu cầu `dm.allowFrom=["*"]`.
- `dm.allowFrom`: allowlist DM (id hoặc tên người dùng). Được dùng bởi `dm.policy="allowlist"` và cho xác thực `dm.policy="open"`. Trình hướng dẫn chấp nhận username và phân giải sang id khi bot có thể tìm kiếm thành viên.
- `dm.groupEnabled`: bật group DM (mặc định `false`).
- `dm.groupChannels`: allowlist tùy chọn cho id hoặc slug kênh group DM.
- `groupPolicy`: kiểm soát xử lý kênh guild (`open|disabled|allowlist`); `allowlist` yêu cầu allowlist kênh.
- `guilds`: quy tắc theo guild, khóa bằng guild id (khuyến nghị) hoặc slug.
- `guilds."*"`: thiết lập mặc định theo guild áp dụng khi không có mục cụ thể.
- `guilds.<id>.slug`: slug thân thiện tùy chọn dùng cho tên hiển thị.
- `guilds.<id>.users`: allowlist người dùng theo guild tùy chọn (id hoặc tên).
- `guilds.<id>.tools`: ghi đè chính sách công cụ theo guild tùy chọn (`allow`/`deny`/`alsoAllow`) dùng khi thiếu ghi đè ở kênh.
- `guilds.<id>.toolsBySender`: ghi đè chính sách công cụ theo người gửi ở cấp guild (áp dụng khi thiếu ghi đè ở kênh; hỗ trợ wildcard `"*"`).
- `guilds.<id>.channels.<channel>.allow`: cho phép/từ chối kênh khi `groupPolicy="allowlist"`.
- `guilds.<id>.channels.<channel>.requireMention`: chặn theo mention cho kênh.
- `guilds.<id>.channels.<channel>.tools`: ghi đè chính sách công cụ theo kênh tùy chọn (`allow`/`deny`/`alsoAllow`).
- `guilds.<id>.channels.<channel>.toolsBySender`: ghi đè chính sách công cụ theo người gửi trong kênh (`"*"` hỗ trợ wildcard).
- `guilds.<id>.channels.<channel>.users`: allowlist người dùng theo kênh tùy chọn.
- `guilds.<id>.channels.<channel>.skills`: bộ lọc skill (bỏ qua = tất cả skills, rỗng = không skill).
- `guilds.<id>.channels.<channel>.systemPrompt`: system prompt bổ sung cho kênh. Chủ đề kênh Discord được chèn như ngữ cảnh **không đáng tin** (không phải system prompt).
- `guilds.<id>.channels.<channel>.enabled`: đặt `false` để vô hiệu hóa kênh.
- `guilds.<id>.channels`: quy tắc kênh (khóa là slug hoặc id kênh).
- `guilds.<id>.requireMention`: yêu cầu mention theo guild (có thể ghi đè theo kênh).
- `guilds.<id>.reactionNotifications`: chế độ sự kiện hệ thống phản ứng (`off`, `own`, `all`, `allowlist`).
- `textChunkLimit`: kích thước chunk văn bản gửi ra (ký tự). Mặc định: 2000.
- `chunkMode`: `length` (mặc định) chỉ tách khi vượt `textChunkLimit`; `newline` tách theo dòng trống (ranh giới đoạn) trước khi tách theo độ dài.
- `maxLinesPerMessage`: số dòng tối đa mềm cho mỗi tin nhắn. Mặc định: 17.
- `mediaMaxMb`: giới hạn phương tiện vào được lưu xuống đĩa.
- `historyLimit`: số tin nhắn guild gần đây đưa vào ngữ cảnh khi trả lời mention (mặc định 20; fallback về `messages.groupChat.historyLimit`; `0` tắt).
- `dmHistoryLimit`: giới hạn lịch sử DM theo lượt người dùng. Ghi đè theo người dùng: `dms["<user_id>"].historyLimit`.
- `retry`: chính sách retry cho các lệnh gọi Discord API đi ra (attempts, minDelayMs, maxDelayMs, jitter).
- `pluralkit`: phân giải tin nhắn proxy PluralKit để các thành viên hệ thống xuất hiện như người gửi riêng biệt.
- `actions`: chặn công cụ theo hành động; bỏ qua để cho phép tất cả (đặt `false` để tắt).
  - `reactions` (bao gồm react + đọc phản ứng)
  - `stickers`, `emojiUploads`, `stickerUploads`, `polls`, `permissions`, `messages`, `threads`, `pins`, `search`
  - `memberInfo`, `roleInfo`, `channelInfo`, `voiceStatus`, `events`
  - `channels` (tạo/sửa/xóa kênh + danh mục + quyền)
  - `roles` (thêm/xóa vai trò, mặc định `false`)
  - `moderation` (timeout/kick/ban, mặc định `false`)
  - `presence` (trạng thái/hoạt động bot, mặc định `false`)
- `execApprovals`: DM phê duyệt exec chỉ dành cho Discord (UI nút bấm). Hỗ trợ `enabled`, `approvers`, `agentFilter`, `sessionFilter`.

Thông báo phản ứng dùng `guilds.<id>.reactionNotifications`:

- `off`: không có sự kiện phản ứng.
- `own`: phản ứng trên tin nhắn của chính bot (mặc định).
- `all`: mọi phản ứng trên mọi tin nhắn.
- `allowlist`: phản ứng từ `guilds.<id>.users` trên mọi tin nhắn (danh sách rỗng sẽ tắt).

### Hỗ trợ PluralKit (PK)

Bật tra cứu PK để các tin nhắn proxy được phân giải về hệ thống + thành viên gốc.
Khi bật, OpenClaw dùng danh tính thành viên cho allowlist và gắn nhãn
người gửi là `Member (PK:System)` để tránh ping Discord ngoài ý muốn.

```json5
{
  channels: {
    discord: {
      pluralkit: {
        enabled: true,
        token: "pk_live_...", // optional; required for private systems
      },
    },
  },
}
```

Ghi chú allowlist (khi bật PK):

- Dùng `pk:<memberId>` trong `dm.allowFrom`, `guilds.<id>.users`, hoặc `users` theo kênh.
- Tên hiển thị thành viên cũng được khớp theo tên/slug.
- Tra cứu dùng **ID tin nhắn Discord gốc** (trước proxy), nên API PK chỉ phân giải trong cửa sổ 30 phút.
- Nếu tra cứu PK thất bại (ví dụ hệ thống riêng tư không có token), tin nhắn proxy
  được coi là tin nhắn bot và sẽ bị loại trừ trừ khi `channels.discord.allowBots=true`.

### Mặc định hành động công cụ

| Nhóm hành động | Mặc định | Ghi chú                                  |
| -------------- | -------- | ---------------------------------------- |
| reactions      | enabled  | React + liệt kê phản ứng + emojiList     |
| stickers       | enabled  | Gửi sticker                              |
| emojiUploads   | enabled  | Tải emoji lên                            |
| stickerUploads | enabled  | Tải sticker lên                          |
| polls          | enabled  | Tạo poll                                 |
| permissions    | enabled  | Ảnh chụp quyền kênh                      |
| messages       | enabled  | Đọc/gửi/sửa/xóa                          |
| threads        | enabled  | Tạo/liệt kê/trả lời                      |
| pins           | enabled  | Ghim/bỏ ghim/liệt kê                     |
| search         | enabled  | Tìm kiếm tin nhắn (tính năng thử nghiệm) |
| memberInfo     | enabled  | Thông tin thành viên                     |
| roleInfo       | enabled  | Danh sách vai trò                        |
| channelInfo    | enabled  | Thông tin kênh + liệt kê                 |
| channels       | enabled  | Quản lý kênh/danh mục                    |
| voiceStatus    | enabled  | Tra cứu trạng thái voice                 |
| events         | enabled  | Liệt kê/tạo sự kiện đã lên lịch          |
| roles          | disabled | Thêm/xóa vai trò                         |
| moderation     | disabled | Timeout/kick/ban                         |
| presence       | disabled | Trạng thái/hoạt động bot (setPresence)   |

- `replyToMode`: `off` (mặc định), `first`, hoặc `all`. Chỉ áp dụng khi mô hình có thẻ reply.

## Thẻ trả lời

Để yêu cầu trả lời theo thread, mô hình có thể bao gồm một thẻ trong đầu ra:

- `[[reply_to_current]]` — trả lời tin nhắn Discord đã kích hoạt.
- `[[reply_to:<id>]]` — trả lời một id tin nhắn cụ thể từ ngữ cảnh/lịch sử.
  ID tin nhắn hiện tại được thêm vào prompt dưới dạng `[message_id: …]`; các mục lịch sử đã bao gồm id.

Hành vi được điều khiển bởi `channels.discord.replyToMode`:

- `off`: bỏ qua thẻ.
- `first`: chỉ chunk/đính kèm gửi ra đầu tiên là trả lời.
- `all`: mọi chunk/đính kèm gửi ra đều là trả lời.

Ghi chú khớp allowlist:

- `allowFrom`/`users`/`groupChannels` chấp nhận id, tên, thẻ, hoặc mention như `<@id>`.
- Hỗ trợ tiền tố như `discord:`/`user:` (người dùng) và `channel:` (group DM).
- Dùng `*` để cho phép bất kỳ người gửi/kênh nào.
- Khi có `guilds.<id>.channels`, các kênh không được liệt kê sẽ bị từ chối theo mặc định.
- Khi `guilds.<id>.channels` bị bỏ qua, tất cả kênh trong guild được allowlist đều được phép.
- Để cho phép **không kênh nào**, đặt `channels.discord.groupPolicy: "disabled"` (hoặc giữ allowlist rỗng).
- Trình hướng dẫn cấu hình chấp nhận tên `Guild/Channel` (công khai + riêng tư) và phân giải sang ID khi có thể.
- Khi khởi động, OpenClaw phân giải tên kênh/người dùng trong allowlist sang ID (khi bot có thể tìm kiếm thành viên)
  và ghi log ánh xạ; các mục không phân giải được sẽ được giữ nguyên như đã nhập.

Ghi chú lệnh gốc:

- Các lệnh đã đăng ký phản chiếu các lệnh chat của OpenClaw.
- Lệnh gốc tuân thủ cùng allowlist như DM/tin nhắn guild (`channels.discord.dm.allowFrom`, `channels.discord.guilds`, quy tắc theo kênh).
- Slash command vẫn có thể hiển thị trong UI Discord cho người dùng không nằm trong allowlist; OpenClaw sẽ thực thi kiểm soát và trả lời “not authorized”.

## Hành động công cụ

Tác tử có thể gọi `discord` với các hành động như:

- `react` / `reactions` (thêm hoặc liệt kê phản ứng)
- `sticker`, `poll`, `permissions`
- `readMessages`, `sendMessage`, `editMessage`, `deleteMessage`
- Payload công cụ đọc/tìm kiếm/ghim bao gồm `timestampMs` đã chuẩn hóa (UTC epoch ms) và `timestampUtc` cùng với `timestamp` Discord thô.
- `threadCreate`, `threadList`, `threadReply`
- `pinMessage`, `unpinMessage`, `listPins`
- `searchMessages`, `memberInfo`, `roleInfo`, `roleAdd`, `roleRemove`, `emojiList`
- `channelInfo`, `channelList`, `voiceStatus`, `eventList`, `eventCreate`
- `timeout`, `kick`, `ban`
- `setPresence` (hoạt động bot và trạng thái trực tuyến)

ID tin nhắn Discord được đưa ra trong ngữ cảnh chèn (`[discord message id: …]` và các dòng lịch sử) để tác tử có thể nhắm mục tiêu.
Emoji có thể là unicode (ví dụ `✅`) hoặc cú pháp emoji tùy chỉnh như `<:party_blob:1234567890>`.

## An toàn & vận hành

- Hãy coi bot token như mật khẩu; ưu tiên biến môi trường `DISCORD_BOT_TOKEN` trên các máy chủ được giám sát hoặc khóa chặt quyền của tệp cấu hình.
- Chỉ cấp cho bot các quyền cần thiết (thường là Read/Send Messages).
- Nếu bot bị kẹt hoặc bị giới hạn tốc độ, hãy khởi động lại gateway (`openclaw gateway --force`) sau khi xác nhận không có tiến trình nào khác đang sở hữu phiên Discord.
