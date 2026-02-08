---
summary: "Trạng thái hỗ trợ bot Telegram, khả năng và cấu hình"
read_when:
  - Khi làm việc với các tính năng hoặc webhook của Telegram
title: "Telegram"
x-i18n:
  source_path: channels/telegram.md
  source_hash: 604e2dc12d2b776d
  provider: openai
  model: gpt-5.2-chat-latest
  workflow: v1
  generated_at: 2026-02-08T09:39:15Z
---

# Telegram (Bot API)

Trạng thái: sẵn sàng cho môi trường production đối với bot DM + nhóm qua grammY. Mặc định dùng long-polling; webhook là tùy chọn.

## Quick setup (beginner)

1. Tạo bot với **@BotFather** ([liên kết trực tiếp](https://t.me/BotFather)). Xác nhận handle chính xác là `@BotFather`, sau đó sao chép token.
2. Thiết lập token:
   - Env: `TELEGRAM_BOT_TOKEN=...`
   - Hoặc config: `channels.telegram.botToken: "..."`.
   - Nếu cả hai cùng được thiết lập, config sẽ được ưu tiên (env chỉ dùng làm fallback cho tài khoản mặc định).
3. Khởi động gateway.
4. Quyền truy cập DM mặc định là ghép cặp; phê duyệt mã ghép cặp ở lần liên hệ đầu tiên.

Cấu hình tối thiểu:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
    },
  },
}
```

## Nó là gì

- Một kênh Telegram Bot API do Gateway sở hữu.
- Định tuyến xác định: phản hồi luôn quay lại Telegram; mô hình không bao giờ tự chọn kênh.
- DM dùng chung phiên chính của tác tử; nhóm được tách biệt (`agent:<agentId>:telegram:group:<chatId>`).

## Setup (fast path)

### 1) Tạo bot token (BotFather)

1. Mở Telegram và chat với **@BotFather** ([liên kết trực tiếp](https://t.me/BotFather)). Xác nhận handle chính xác là `@BotFather`.
2. Chạy `/newbot`, sau đó làm theo hướng dẫn (tên + username kết thúc bằng `bot`).
3. Sao chép token và lưu trữ an toàn.

Cài đặt BotFather tùy chọn:

- `/setjoingroups` — cho phép/không cho phép thêm bot vào nhóm.
- `/setprivacy` — kiểm soát việc bot có thấy tất cả tin nhắn trong nhóm hay không.

### 2) Cấu hình token (env hoặc config)

Ví dụ:

```json5
{
  channels: {
    telegram: {
      enabled: true,
      botToken: "123:abc",
      dmPolicy: "pairing",
      groups: { "*": { requireMention: true } },
    },
  },
}
```

Tùy chọn env: `TELEGRAM_BOT_TOKEN=...` (chỉ áp dụng cho tài khoản mặc định).
Nếu cả env và config đều được thiết lập, config sẽ được ưu tiên.

Hỗ trợ nhiều tài khoản: dùng `channels.telegram.accounts` với token theo từng tài khoản và tùy chọn `name`. Xem [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) để biết mẫu dùng chung.

3. Khởi động gateway. Telegram sẽ bắt đầu khi token được resolve (ưu tiên config, env làm fallback).
4. Quyền DM mặc định là ghép cặp. Phê duyệt mã khi bot được liên hệ lần đầu.
5. Với nhóm: thêm bot, quyết định hành vi privacy/admin (bên dưới), sau đó thiết lập `channels.telegram.groups` để kiểm soát gating theo mention + allowlist.

## Token + quyền riêng tư + quyền hạn (phía Telegram)

### Tạo token (BotFather)

- `/newbot` tạo bot và trả về token (giữ bí mật).
- Nếu token bị lộ, thu hồi/tạo lại qua @BotFather và cập nhật cấu hình.

### Khả năng hiển thị tin nhắn nhóm (Privacy Mode)

Bot Telegram mặc định bật **Privacy Mode**, giới hạn các tin nhắn nhóm mà bot nhận được.
Nếu bot cần thấy _tất cả_ tin nhắn trong nhóm, có hai cách:

- Tắt privacy mode bằng `/setprivacy` **hoặc**
- Thêm bot làm **admin** của nhóm (bot admin nhận tất cả tin nhắn).

**Lưu ý:** Khi thay đổi privacy mode, Telegram yêu cầu xóa + thêm lại bot
vào từng nhóm để thay đổi có hiệu lực.

### Quyền hạn nhóm (admin)

Trạng thái admin được thiết lập trong nhóm (UI của Telegram). Bot admin luôn nhận
tất cả tin nhắn nhóm, vì vậy hãy dùng admin nếu bạn cần toàn bộ khả năng quan sát.

## Cách hoạt động (hành vi)

- Tin nhắn đến được chuẩn hóa vào phong bì kênh dùng chung với ngữ cảnh trả lời và placeholder media.
- Trả lời trong nhóm mặc định yêu cầu mention (mention @ gốc hoặc `agents.list[].groupChat.mentionPatterns` / `messages.groupChat.mentionPatterns`).
- Ghi đè đa tác tử: thiết lập pattern theo từng tác tử trên `agents.list[].groupChat.mentionPatterns`.
- Phản hồi luôn quay lại cùng một chat Telegram.
- Long-polling dùng grammY runner với tuần tự theo từng chat; tổng mức song song bị giới hạn bởi `agents.defaults.maxConcurrent`.
- Telegram Bot API không hỗ trợ read receipts; không có tùy chọn `sendReadReceipts`.

## Draft streaming

OpenClaw có thể stream phản hồi từng phần trong Telegram DM bằng `sendMessageDraft`.

Yêu cầu:

- Bật Threaded Mode cho bot trong @BotFather (forum topic mode).
- Chỉ áp dụng cho thread chat riêng (Telegram bao gồm `message_thread_id` trong tin nhắn đến).
- `channels.telegram.streamMode` không được đặt là `"off"` (mặc định: `"partial"`, `"block"` bật cập nhật draft theo khối).

Draft streaming chỉ áp dụng cho DM; Telegram không hỗ trợ trong nhóm hoặc kênh.

## Định dạng (Telegram HTML)

- Văn bản gửi đi dùng `parse_mode: "HTML"` (tập con thẻ được Telegram hỗ trợ).
- Đầu vào dạng Markdown-ish được render thành **HTML an toàn cho Telegram** (đậm/nghiêng/gạch/xuống dòng/code/liên kết); các phần tử khối được làm phẳng thành văn bản với xuống dòng/gạch đầu dòng.
- HTML thô từ mô hình sẽ được escape để tránh lỗi parse của Telegram.
- Nếu Telegram từ chối payload HTML, OpenClaw sẽ thử gửi lại cùng thông điệp dưới dạng plain text.

## Lệnh (gốc + tùy chỉnh)

OpenClaw đăng ký các lệnh gốc (như `/status`, `/reset`, `/model`) với menu bot của Telegram khi khởi động.
Bạn có thể thêm lệnh tùy chỉnh vào menu qua config:

```json5
{
  channels: {
    telegram: {
      customCommands: [
        { command: "backup", description: "Git backup" },
        { command: "generate", description: "Create an image" },
      ],
    },
  },
}
```

## Xử lý sự cố thiết lập (lệnh)

- `setMyCommands failed` trong log thường có nghĩa là HTTPS/DNS outbound bị chặn tới `api.telegram.org`.
- Nếu thấy lỗi `sendMessage` hoặc `sendChatAction`, hãy kiểm tra định tuyến IPv6 và DNS.

Thêm trợ giúp: [Channel troubleshooting](/channels/troubleshooting).

Ghi chú:

- Lệnh tùy chỉnh **chỉ là mục menu**; OpenClaw không triển khai logic cho chúng trừ khi bạn xử lý ở nơi khác.
- Tên lệnh được chuẩn hóa (loại bỏ `/` ở đầu, chuyển chữ thường) và phải khớp `a-z`, `0-9`, `_` (1–32 ký tự).
- Lệnh tùy chỉnh **không thể ghi đè lệnh gốc**. Xung đột sẽ bị bỏ qua và ghi log.
- Nếu `commands.native` bị tắt, chỉ các lệnh tùy chỉnh được đăng ký (hoặc bị xóa nếu không có).

## Giới hạn

- Văn bản gửi đi được chia khối theo `channels.telegram.textChunkLimit` (mặc định 4000).
- Chia khối theo dòng trống (tùy chọn): đặt `channels.telegram.chunkMode="newline"` để tách theo dòng trống (ranh giới đoạn) trước khi chia theo độ dài.
- Tải xuống/tải lên media bị giới hạn bởi `channels.telegram.mediaMaxMb` (mặc định 5).
- Yêu cầu Telegram Bot API timeout sau `channels.telegram.timeoutSeconds` (mặc định 500 qua grammY). Đặt thấp hơn để tránh treo lâu.
- Ngữ cảnh lịch sử nhóm dùng `channels.telegram.historyLimit` (hoặc `channels.telegram.accounts.*.historyLimit`), fallback về `messages.groupChat.historyLimit`. Đặt `0` để tắt (mặc định 50).
- Lịch sử DM có thể giới hạn bằng `channels.telegram.dmHistoryLimit` (số lượt người dùng). Ghi đè theo người dùng: `channels.telegram.dms["<user_id>"].historyLimit`.

## Chế độ kích hoạt nhóm

Mặc định, bot chỉ phản hồi khi được mention trong nhóm (`@botname` hoặc pattern trong `agents.list[].groupChat.mentionPatterns`). Để thay đổi:

### Qua config (khuyến nghị)

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": { requireMention: false }, // always respond in this group
      },
    },
  },
}
```

**Quan trọng:** Thiết lập `channels.telegram.groups` tạo **allowlist** — chỉ các nhóm được liệt kê (hoặc `"*"`) mới được chấp nhận.
Forum topic kế thừa cấu hình của nhóm cha (allowFrom, requireMention, skills, prompts) trừ khi bạn thêm ghi đè theo topic trong `channels.telegram.groups.<groupId>.topics.<topicId>`.

Cho phép tất cả nhóm và luôn phản hồi:

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: false }, // all groups, always respond
      },
    },
  },
}
```

Giữ chế độ chỉ phản hồi khi mention cho tất cả nhóm (mặc định):

```json5
{
  channels: {
    telegram: {
      groups: {
        "*": { requireMention: true }, // or omit groups entirely
      },
    },
  },
}
```

### Qua lệnh (mức phiên)

Gửi trong nhóm:

- `/activation always` - phản hồi mọi tin nhắn
- `/activation mention` - yêu cầu mention (mặc định)

**Lưu ý:** Lệnh chỉ cập nhật trạng thái phiên. Để duy trì qua lần khởi động lại, hãy dùng config.

### Lấy chat ID của nhóm

Chuyển tiếp bất kỳ tin nhắn nào từ nhóm tới `@userinfobot` hoặc `@getidsbot` trên Telegram để xem chat ID (số âm như `-1001234567890`).

**Mẹo:** Để lấy user ID của bạn, DM bot và bot sẽ trả lời user ID (thông báo ghép cặp), hoặc dùng `/whoami` khi lệnh đã được bật.

**Lưu ý về quyền riêng tư:** `@userinfobot` là bot bên thứ ba. Nếu muốn, hãy thêm bot vào nhóm, gửi một tin nhắn và dùng `openclaw logs --follow` để đọc `chat.id`, hoặc dùng Bot API `getUpdates`.

## Ghi cấu hình

Mặc định, Telegram được phép ghi các cập nhật cấu hình được kích hoạt bởi sự kiện kênh hoặc `/config set|unset`.

Điều này xảy ra khi:

- Nhóm được nâng cấp thành supergroup và Telegram phát `migrate_to_chat_id` (chat ID thay đổi). OpenClaw có thể tự động migrate `channels.telegram.groups`.
- Bạn chạy `/config set` hoặc `/config unset` trong chat Telegram (yêu cầu `commands.config: true`).

Tắt bằng:

```json5
{
  channels: { telegram: { configWrites: false } },
}
```

## Topics (forum supergroups)

Forum topic của Telegram bao gồm `message_thread_id` cho mỗi tin nhắn. OpenClaw:

- Nối `:topic:<threadId>` vào khóa phiên nhóm Telegram để mỗi topic được tách biệt.
- Gửi typing indicator và phản hồi với `message_thread_id` để câu trả lời nằm trong topic.
- Topic chung (thread id `1`) là đặc biệt: khi gửi tin nhắn sẽ bỏ `message_thread_id` (Telegram từ chối), nhưng typing indicator vẫn bao gồm.
- Phơi bày `MessageThreadId` + `IsForum` trong ngữ cảnh template để định tuyến/templating.
- Cấu hình theo topic có sẵn trong `channels.telegram.groups.<chatId>.topics.<threadId>` (skills, allowlists, auto-reply, system prompts, disable).
- Cấu hình topic kế thừa thiết lập nhóm (requireMention, allowlists, skills, prompts, enabled) trừ khi ghi đè theo topic.

Chat riêng có thể bao gồm `message_thread_id` trong một số trường hợp biên. OpenClaw giữ nguyên khóa phiên DM, nhưng vẫn dùng thread id cho phản hồi/draft streaming khi có.

## Inline Buttons

Telegram hỗ trợ inline keyboard với callback buttons.

```json5
{
  channels: {
    telegram: {
      capabilities: {
        inlineButtons: "allowlist",
      },
    },
  },
}
```

Cho cấu hình theo từng tài khoản:

```json5
{
  channels: {
    telegram: {
      accounts: {
        main: {
          capabilities: {
            inlineButtons: "allowlist",
          },
        },
      },
    },
  },
}
```

Phạm vi:

- `off` — tắt inline buttons
- `dm` — chỉ DM (chặn mục tiêu nhóm)
- `group` — chỉ nhóm (chặn mục tiêu DM)
- `all` — DM + nhóm
- `allowlist` — DM + nhóm, nhưng chỉ người gửi được cho phép bởi `allowFrom`/`groupAllowFrom` (cùng quy tắc với lệnh điều khiển)

Mặc định: `allowlist`.
Legacy: `capabilities: ["inlineButtons"]` = `inlineButtons: "all"`.

### Gửi nút

Dùng message tool với tham số `buttons`:

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  message: "Choose an option:",
  buttons: [
    [
      { text: "Yes", callback_data: "yes" },
      { text: "No", callback_data: "no" },
    ],
    [{ text: "Cancel", callback_data: "cancel" }],
  ],
}
```

Khi người dùng bấm nút, dữ liệu callback được gửi lại cho tác tử dưới dạng thông điệp với định dạng:
`callback_data: value`

### Tùy chọn cấu hình

Khả năng Telegram có thể cấu hình ở hai mức (hiển thị dạng object ở trên; mảng chuỗi legacy vẫn được hỗ trợ):

- `channels.telegram.capabilities`: Cấu hình khả năng mặc định toàn cục áp dụng cho tất cả tài khoản Telegram trừ khi bị ghi đè.
- `channels.telegram.accounts.<account>.capabilities`: Khả năng theo từng tài khoản, ghi đè mặc định toàn cục cho tài khoản cụ thể.

Dùng thiết lập toàn cục khi tất cả bot/tài khoản Telegram cần hành vi giống nhau. Dùng cấu hình theo tài khoản khi các bot khác nhau cần hành vi khác nhau (ví dụ: một tài khoản chỉ xử lý DM trong khi tài khoản khác được phép trong nhóm).

## Kiểm soát truy cập (DM + nhóm)

### Quyền truy cập DM

- Mặc định: `channels.telegram.dmPolicy = "pairing"`. Người gửi chưa biết sẽ nhận mã ghép cặp; tin nhắn bị bỏ qua cho đến khi được phê duyệt (mã hết hạn sau 1 giờ).
- Phê duyệt qua:
  - `openclaw pairing list telegram`
  - `openclaw pairing approve telegram <CODE>`
- Ghép cặp là cơ chế trao đổi token mặc định cho Telegram DM. Chi tiết: [Pairing](/channels/pairing)
- `channels.telegram.allowFrom` chấp nhận user ID dạng số (khuyến nghị) hoặc mục `@username`. Đây **không** phải username của bot; hãy dùng ID của người gửi. Trình wizard chấp nhận `@username` và sẽ resolve sang ID số khi có thể.

#### Tìm Telegram user ID của bạn

An toàn hơn (không dùng bot bên thứ ba):

1. Khởi động gateway và DM bot của bạn.
2. Chạy `openclaw logs --follow` và tìm `from.id`.

Cách khác (Bot API chính thức):

1. DM bot của bạn.
2. Lấy updates bằng token bot và đọc `message.from.id`:

   ```bash
   curl "https://api.telegram.org/bot<bot_token>/getUpdates"
   ```

Bên thứ ba (ít riêng tư hơn):

- DM `@userinfobot` hoặc `@getidsbot` và dùng user id được trả về.

### Quyền truy cập nhóm

Hai kiểm soát độc lập:

**1. Nhóm nào được phép** (allowlist nhóm qua `channels.telegram.groups`):

- Không có cấu hình `groups` = cho phép tất cả nhóm
- Có cấu hình `groups` = chỉ các nhóm được liệt kê hoặc `"*"` được phép
- Ví dụ: `"groups": { "-1001234567890": {}, "*": {} }` cho phép tất cả nhóm

**2. Người gửi nào được phép** (lọc người gửi qua `channels.telegram.groupPolicy`):

- `"open"` = tất cả người gửi trong các nhóm được phép có thể nhắn
- `"allowlist"` = chỉ người gửi trong `channels.telegram.groupAllowFrom` có thể nhắn
- `"disabled"` = không chấp nhận tin nhắn nhóm nào
  Mặc định là `groupPolicy: "allowlist"` (bị chặn trừ khi bạn thêm `groupAllowFrom`).

Hầu hết người dùng muốn: `groupPolicy: "allowlist"` + `groupAllowFrom` + các nhóm cụ thể được liệt kê trong `channels.telegram.groups`

Để cho phép **bất kỳ thành viên nhóm** nào nói chuyện trong một nhóm cụ thể (vẫn giữ lệnh điều khiển bị giới hạn cho người gửi được ủy quyền), đặt ghi đè theo nhóm:

```json5
{
  channels: {
    telegram: {
      groups: {
        "-1001234567890": {
          groupPolicy: "open",
          requireMention: false,
        },
      },
    },
  },
}
```

## Long-polling vs webhook

- Mặc định: long-polling (không cần URL công khai).
- Chế độ webhook: đặt `channels.telegram.webhookUrl` và `channels.telegram.webhookSecret` (tùy chọn `channels.telegram.webhookPath`).
  - Listener cục bộ bind tới `0.0.0.0:8787` và phục vụ `POST /telegram-webhook` theo mặc định.
  - Nếu URL công khai của bạn khác, hãy dùng reverse proxy và trỏ `channels.telegram.webhookUrl` tới endpoint công khai.

## Threading phản hồi

Telegram hỗ trợ threading phản hồi tùy chọn qua thẻ:

- `[[reply_to_current]]` -- trả lời tin nhắn kích hoạt.
- `[[reply_to:<id>]]` -- trả lời một message id cụ thể.

Được kiểm soát bởi `channels.telegram.replyToMode`:

- `first` (mặc định), `all`, `off`.

## Tin nhắn âm thanh (voice vs file)

Telegram phân biệt **voice note** (bong bóng tròn) và **audio file** (thẻ metadata).
OpenClaw mặc định dùng audio file để tương thích ngược.

Để buộc gửi voice note trong phản hồi của tác tử, hãy chèn thẻ này ở bất kỳ đâu trong câu trả lời:

- `[[audio_as_voice]]` — gửi âm thanh dưới dạng voice note thay vì file.

Thẻ sẽ bị loại bỏ khỏi văn bản gửi đi. Các kênh khác bỏ qua thẻ này.

Với message tool, đặt `asVoice: true` cùng URL `media` âm thanh tương thích voice
(`message` là tùy chọn khi có media):

```json5
{
  action: "send",
  channel: "telegram",
  to: "123456789",
  media: "https://example.com/voice.ogg",
  asVoice: true,
}
```

## Stickers

OpenClaw hỗ trợ nhận và gửi sticker Telegram với bộ nhớ đệm thông minh.

### Nhận sticker

Khi người dùng gửi sticker, OpenClaw xử lý dựa trên loại sticker:

- **Sticker tĩnh (WEBP):** Được tải xuống và xử lý qua vision. Sticker xuất hiện dưới dạng placeholder `<media:sticker>` trong nội dung tin nhắn.
- **Sticker động (TGS):** Bỏ qua (định dạng Lottie không được hỗ trợ xử lý).
- **Sticker video (WEBM):** Bỏ qua (định dạng video không được hỗ trợ xử lý).

Trường ngữ cảnh template khả dụng khi nhận sticker:

- `Sticker` — object với:
  - `emoji` — emoji gắn với sticker
  - `setName` — tên bộ sticker
  - `fileId` — Telegram file ID (gửi lại cùng sticker)
  - `fileUniqueId` — ID ổn định để tra cứu cache
  - `cachedDescription` — mô tả vision đã cache khi có

### Bộ nhớ đệm sticker

Sticker được xử lý qua khả năng vision của AI để tạo mô tả. Vì cùng một sticker thường được gửi lặp lại, OpenClaw cache các mô tả này để tránh gọi API dư thừa.

**Cách hoạt động:**

1. **Lần đầu gặp:** Ảnh sticker được gửi tới AI để phân tích vision. AI tạo mô tả (ví dụ: "Một con mèo hoạt hình đang vẫy tay nhiệt tình").
2. **Lưu cache:** Mô tả được lưu cùng file ID, emoji và tên bộ sticker.
3. **Những lần sau:** Khi gặp lại sticker đó, mô tả trong cache được dùng trực tiếp. Ảnh không được gửi tới AI.

**Vị trí cache:** `~/.openclaw/telegram/sticker-cache.json`

**Định dạng mục cache:**

```json
{
  "fileId": "CAACAgIAAxkBAAI...",
  "fileUniqueId": "AgADBAADb6cxG2Y",
  "emoji": "👋",
  "setName": "CoolCats",
  "description": "A cartoon cat waving enthusiastically",
  "cachedAt": "2026-01-15T10:30:00.000Z"
}
```

**Lợi ích:**

- Giảm chi phí API bằng cách tránh gọi vision lặp lại cho cùng sticker
- Thời gian phản hồi nhanh hơn cho sticker đã cache (không có độ trễ xử lý vision)
- Cho phép tìm kiếm sticker dựa trên mô tả đã cache

Cache được tự động tạo khi nhận sticker. Không cần quản lý cache thủ công.

### Gửi sticker

Tác tử có thể gửi và tìm sticker bằng các action `sticker` và `sticker-search`. Mặc định bị tắt và cần bật trong config:

```json5
{
  channels: {
    telegram: {
      actions: {
        sticker: true,
      },
    },
  },
}
```

**Gửi một sticker:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "123456789",
  fileId: "CAACAgIAAxkBAAI...",
}
```

Tham số:

- `fileId` (bắt buộc) — Telegram file ID của sticker. Lấy từ `Sticker.fileId` khi nhận sticker, hoặc từ kết quả `sticker-search`.
- `replyTo` (tùy chọn) — message ID để trả lời.
- `threadId` (tùy chọn) — message thread ID cho forum topic.

**Tìm sticker:**

Tác tử có thể tìm sticker đã cache theo mô tả, emoji hoặc tên bộ:

```json5
{
  action: "sticker-search",
  channel: "telegram",
  query: "cat waving",
  limit: 5,
}
```

Trả về các sticker khớp từ cache:

```json5
{
  ok: true,
  count: 2,
  stickers: [
    {
      fileId: "CAACAgIAAxkBAAI...",
      emoji: "👋",
      description: "A cartoon cat waving enthusiastically",
      setName: "CoolCats",
    },
  ],
}
```

Tìm kiếm dùng fuzzy matching trên văn bản mô tả, ký tự emoji và tên bộ.

**Ví dụ với threading:**

```json5
{
  action: "sticker",
  channel: "telegram",
  to: "-1001234567890",
  fileId: "CAACAgIAAxkBAAI...",
  replyTo: 42,
  threadId: 123,
}
```

## Streaming (drafts)

Telegram có thể stream **draft bubble** trong khi tác tử đang tạo phản hồi.
OpenClaw dùng Bot API `sendMessageDraft` (không phải tin nhắn thật) rồi gửi
phản hồi cuối cùng như một tin nhắn bình thường.

Yêu cầu (Telegram Bot API 9.3+):

- **Chat riêng với topics được bật** (forum topic mode cho bot).
- Tin nhắn đến phải bao gồm `message_thread_id` (private topic thread).
- Streaming bị bỏ qua cho nhóm/supergroup/kênh.

Cấu hình:

- `channels.telegram.streamMode: "off" | "partial" | "block"` (mặc định: `partial`)
  - `partial`: cập nhật draft bubble với văn bản streaming mới nhất.
  - `block`: cập nhật draft bubble theo các khối lớn hơn (chunked).
  - `off`: tắt draft streaming.
- Tùy chọn (chỉ cho `streamMode: "block"`):
  - `channels.telegram.draftChunk: { minChars?, maxChars?, breakPreference? }`
    - mặc định: `minChars: 200`, `maxChars: 800`, `breakPreference: "paragraph"` (giới hạn tới `channels.telegram.textChunkLimit`).

Lưu ý: draft streaming tách biệt với **block streaming** (tin nhắn kênh).
Block streaming mặc định tắt và cần `channels.telegram.blockStreaming: true`
nếu bạn muốn tin nhắn Telegram sớm thay vì cập nhật draft.

Reasoning stream (chỉ Telegram):

- `/reasoning stream` stream reasoning vào draft bubble trong khi tạo phản hồi,
  sau đó gửi câu trả lời cuối cùng không kèm reasoning.
- Nếu `channels.telegram.streamMode` là `off`, reasoning stream bị tắt.
  Tham khảo thêm: [Streaming + chunking](/concepts/streaming).

## Chính sách retry

Các cuộc gọi Telegram API outbound sẽ retry khi gặp lỗi mạng tạm thời/429 với exponential backoff và jitter. Cấu hình qua `channels.telegram.retry`. Xem [Retry policy](/concepts/retry).

## Agent tool (messages + reactions)

- Tool: `telegram` với action `sendMessage` (`to`, `content`, tùy chọn `mediaUrl`, `replyToMessageId`, `messageThreadId`).
- Tool: `telegram` với action `react` (`chatId`, `messageId`, `emoji`).
- Tool: `telegram` với action `deleteMessage` (`chatId`, `messageId`).
- Ngữ nghĩa xóa reaction: xem [/tools/reactions](/tools/reactions).
- Gating tool: `channels.telegram.actions.reactions`, `channels.telegram.actions.sendMessage`, `channels.telegram.actions.deleteMessage` (mặc định: bật), và `channels.telegram.actions.sticker` (mặc định: tắt).

## Thông báo reaction

**Cách reaction hoạt động:**
Reaction Telegram đến dưới dạng **sự kiện `message_reaction` riêng biệt**, không phải thuộc tính trong payload tin nhắn. Khi người dùng thêm reaction, OpenClaw:

1. Nhận update `message_reaction` từ Telegram API
2. Chuyển thành **system event** với định dạng: `"Telegram reaction added: {emoji} by {user} on msg {id}"`
3. Đưa system event vào hàng đợi dùng **cùng khóa phiên** với tin nhắn thường
4. Khi tin nhắn tiếp theo đến trong cuộc hội thoại đó, system event sẽ được xả và thêm vào đầu ngữ cảnh của tác tử

Tác tử thấy reaction như **thông báo hệ thống** trong lịch sử hội thoại, không phải metadata của tin nhắn.

**Cấu hình:**

- `channels.telegram.reactionNotifications`: Kiểm soát reaction nào kích hoạt thông báo
  - `"off"` — bỏ qua mọi reaction
  - `"own"` — thông báo khi người dùng react vào tin nhắn của bot (best-effort; trong bộ nhớ) (mặc định)
  - `"all"` — thông báo cho tất cả reaction

- `channels.telegram.reactionLevel`: Kiểm soát khả năng reaction của tác tử
  - `"off"` — tác tử không thể react tin nhắn
  - `"ack"` — bot gửi reaction xác nhận (👀 khi đang xử lý) (mặc định)
  - `"minimal"` — tác tử có thể react tiết kiệm (hướng dẫn: 1 lần mỗi 5–10 lượt trao đổi)
  - `"extensive"` — tác tử có thể react linh hoạt khi phù hợp

**Nhóm forum:** Reaction trong nhóm forum bao gồm `message_thread_id` và dùng khóa phiên như `agent:main:telegram:group:{chatId}:topic:{threadId}`. Điều này đảm bảo reaction và tin nhắn trong cùng topic được gộp chung.

**Ví dụ cấu hình:**

```json5
{
  channels: {
    telegram: {
      reactionNotifications: "all", // See all reactions
      reactionLevel: "minimal", // Agent can react sparingly
    },
  },
}
```

**Yêu cầu:**

- Bot Telegram phải yêu cầu rõ `message_reaction` trong `allowed_updates` (được OpenClaw cấu hình tự động)
- Với chế độ webhook, reaction được bao gồm trong webhook `allowed_updates`
- Với chế độ polling, reaction được bao gồm trong `getUpdates` `allowed_updates`

## Mục tiêu gửi (CLI/cron)

- Dùng chat id (`123456789`) hoặc username (`@name`) làm mục tiêu.
- Ví dụ: `openclaw message send --channel telegram --target 123456789 --message "hi"`.

## Troubleshooting

**Bot không phản hồi tin nhắn không mention trong nhóm:**

- Nếu bạn đặt `channels.telegram.groups.*.requireMention=false`, **privacy mode** của Telegram Bot API phải bị tắt.
  - BotFather: `/setprivacy` → **Disable** (sau đó xóa + thêm lại bot vào nhóm)
- `openclaw channels status` hiển thị cảnh báo khi config mong đợi tin nhắn nhóm không mention.
- `openclaw channels status --probe` có thể kiểm tra thêm tư cách thành viên cho các group ID số cụ thể (không audit được rule wildcard `"*"`).
- Thử nhanh: `/activation always` (chỉ phiên; dùng config để lưu bền vững)

**Bot không thấy tin nhắn nhóm nào:**

- Nếu `channels.telegram.groups` được đặt, nhóm phải được liệt kê hoặc dùng `"*"`
- Kiểm tra Privacy Settings trong @BotFather → "Group Privacy" phải **OFF**
- Xác minh bot thực sự là thành viên (không chỉ là admin không có quyền đọc)
- Kiểm tra log gateway: `openclaw logs --follow` (tìm "skipping group message")

**Bot phản hồi khi mention nhưng không phản hồi `/activation always`:**

- Lệnh `/activation` cập nhật trạng thái phiên nhưng không lưu vào config
- Để lưu bền vững, thêm nhóm vào `channels.telegram.groups` với `requireMention: false`

**Các lệnh như `/status` không hoạt động:**

- Đảm bảo Telegram user ID của bạn được ủy quyền (qua ghép cặp hoặc `channels.telegram.allowFrom`)
- Lệnh yêu cầu ủy quyền ngay cả trong nhóm với `groupPolicy: "open"`

**Long-polling bị hủy ngay lập tức trên Node 22+ (thường với proxy/custom fetch):**

- Node 22+ nghiêm ngặt hơn với instance `AbortSignal`; signal lạ có thể hủy `fetch` ngay.
- Nâng cấp lên bản OpenClaw chuẩn hóa abort signals, hoặc chạy gateway trên Node 20 cho đến khi nâng cấp được.

**Bot khởi động rồi im lặng ngừng phản hồi (hoặc log `HttpError: Network request ... failed`):**

- Một số host resolve `api.telegram.org` sang IPv6 trước. Nếu server không có IPv6 egress hoạt động, grammY có thể bị kẹt với request chỉ IPv6.
- Khắc phục bằng cách bật IPv6 egress **hoặc** ép resolve IPv4 cho `api.telegram.org` (ví dụ: thêm mục `/etc/hosts` dùng bản ghi A IPv4, hoặc ưu tiên IPv4 trong DNS OS), rồi khởi động lại gateway.
- Kiểm tra nhanh: `dig +short api.telegram.org A` và `dig +short api.telegram.org AAAA` để xác nhận DNS trả về gì.

## Tham chiếu cấu hình (Telegram)

Cấu hình đầy đủ: [Configuration](/gateway/configuration)

Tùy chọn provider:

- `channels.telegram.enabled`: bật/tắt khởi động kênh.
- `channels.telegram.botToken`: bot token (BotFather).
- `channels.telegram.tokenFile`: đọc token từ đường dẫn file.
- `channels.telegram.dmPolicy`: `pairing | allowlist | open | disabled` (mặc định: ghép cặp).
- `channels.telegram.allowFrom`: allowlist DM (id/username). `open` yêu cầu `"*"`.
- `channels.telegram.groupPolicy`: `open | allowlist | disabled` (mặc định: allowlist).
- `channels.telegram.groupAllowFrom`: allowlist người gửi trong nhóm (id/username).
- `channels.telegram.groups`: mặc định theo nhóm + allowlist (dùng `"*"` cho mặc định toàn cục).
  - `channels.telegram.groups.<id>.groupPolicy`: ghi đè theo nhóm cho groupPolicy (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.requireMention`: mặc định gating theo mention.
  - `channels.telegram.groups.<id>.skills`: bộ lọc skill (bỏ qua = tất cả skills, rỗng = không skill nào).
  - `channels.telegram.groups.<id>.allowFrom`: ghi đè allowlist người gửi theo nhóm.
  - `channels.telegram.groups.<id>.systemPrompt`: system prompt bổ sung cho nhóm.
  - `channels.telegram.groups.<id>.enabled`: tắt nhóm khi `false`.
  - `channels.telegram.groups.<id>.topics.<threadId>.*`: ghi đè theo topic (cùng trường như nhóm).
  - `channels.telegram.groups.<id>.topics.<threadId>.groupPolicy`: ghi đè groupPolicy theo topic (`open | allowlist | disabled`).
  - `channels.telegram.groups.<id>.topics.<threadId>.requireMention`: ghi đè gating theo mention cho topic.
- `channels.telegram.capabilities.inlineButtons`: `off | dm | group | all | allowlist` (mặc định: allowlist).
- `channels.telegram.accounts.<account>.capabilities.inlineButtons`: ghi đè theo tài khoản.
- `channels.telegram.replyToMode`: `off | first | all` (mặc định: `first`).
- `channels.telegram.textChunkLimit`: kích thước chunk gửi đi (ký tự).
- `channels.telegram.chunkMode`: `length` (mặc định) hoặc `newline` để tách theo dòng trống (ranh giới đoạn) trước khi chia theo độ dài.
- `channels.telegram.linkPreview`: bật/tắt preview liên kết cho tin nhắn gửi đi (mặc định: true).
- `channels.telegram.streamMode`: `off | partial | block` (draft streaming).
- `channels.telegram.mediaMaxMb`: giới hạn media inbound/outbound (MB).
- `channels.telegram.retry`: chính sách retry cho Telegram API outbound (attempts, minDelayMs, maxDelayMs, jitter).
- `channels.telegram.network.autoSelectFamily`: ghi đè Node autoSelectFamily (true=bật, false=tắt). Mặc định tắt trên Node 22 để tránh timeout Happy Eyeballs.
- `channels.telegram.proxy`: URL proxy cho Bot API (SOCKS/HTTP).
- `channels.telegram.webhookUrl`: bật chế độ webhook (yêu cầu `channels.telegram.webhookSecret`).
- `channels.telegram.webhookSecret`: webhook secret (bắt buộc khi đặt webhookUrl).
- `channels.telegram.webhookPath`: đường dẫn webhook cục bộ (mặc định `/telegram-webhook`).
- `channels.telegram.actions.reactions`: gate reaction của Telegram tool.
- `channels.telegram.actions.sendMessage`: gate gửi tin nhắn của Telegram tool.
- `channels.telegram.actions.deleteMessage`: gate xóa tin nhắn của Telegram tool.
- `channels.telegram.actions.sticker`: gate action sticker Telegram — gửi và tìm (mặc định: false).
- `channels.telegram.reactionNotifications`: `off | own | all` — kiểm soát reaction nào kích hoạt system event (mặc định: `own` khi không đặt).
- `channels.telegram.reactionLevel`: `off | ack | minimal | extensive` — kiểm soát khả năng reaction của tác tử (mặc định: `minimal` khi không đặt).

Tùy chọn toàn cục liên quan:

- `agents.list[].groupChat.mentionPatterns` (pattern gating theo mention).
- `messages.groupChat.mentionPatterns` (fallback toàn cục).
- `commands.native` (mặc định `"auto"` → bật cho Telegram/Discord, tắt cho Slack), `commands.text`, `commands.useAccessGroups` (hành vi lệnh). Ghi đè bằng `channels.telegram.commands.native`.
- `messages.responsePrefix`, `messages.ackReaction`, `messages.ackReactionScope`, `messages.removeAckAfterReply`.
