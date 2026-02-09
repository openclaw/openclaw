---
summary: "Hỗ trợ Signal qua signal-cli (JSON-RPC + SSE), thiết lập và mô hình số"
read_when:
  - Thiết lập hỗ trợ Signal
  - Gỡ lỗi gửi/nhận Signal
title: "Signal"
---

# Signal (signal-cli)

Status: external CLI integration. Gateway talks to `signal-cli` over HTTP JSON-RPC + SSE.

## Thiết lập nhanh (cho người mới)

1. Dùng **một số Signal riêng** cho bot (khuyến nghị).
2. Cài đặt `signal-cli` (cần Java).
3. Liên kết thiết bị bot và khởi động daemon:
   - `signal-cli link -n "OpenClaw"`
4. Cấu hình OpenClaw và khởi động gateway.

Cấu hình tối thiểu:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

## Nó là gì

- Kênh Signal qua `signal-cli` (không phải libsignal nhúng).
- Định tuyến xác định: phản hồi luôn quay lại Signal.
- DM dùng chung phiên chính của tác tử; nhóm được cô lập (`agent:<agentId>:signal:group:<groupId>`).

## Ghi cấu hình

Theo mặc định, Signal được phép ghi cập nhật cấu hình do `/config set|unset` kích hoạt (cần `commands.config: true`).

Tắt bằng:

```json5
{
  channels: { signal: { configWrites: false } },
}
```

## Mô hình số (quan trọng)

- Gateway kết nối tới **một thiết bị Signal** (tài khoản `signal-cli`).
- Nếu chạy bot trên **tài khoản Signal cá nhân của bạn**, nó sẽ bỏ qua tin nhắn của chính bạn (bảo vệ vòng lặp).
- Để có hành vi “tôi nhắn bot và nó trả lời”, hãy dùng **một số bot riêng**.

## Thiết lập (nhanh)

1. Cài đặt `signal-cli` (cần Java).
2. Liên kết một tài khoản bot:
   - `signal-cli link -n "OpenClaw"` rồi quét QR trong Signal.
3. Cấu hình Signal và khởi động gateway.

Ví dụ:

```json5
{
  channels: {
    signal: {
      enabled: true,
      account: "+15551234567",
      cliPath: "signal-cli",
      dmPolicy: "pairing",
      allowFrom: ["+15557654321"],
    },
  },
}
```

Multi-account support: use `channels.signal.accounts` with per-account config and optional `name`. See [`gateway/configuration`](/gateway/configuration#telegramaccounts--discordaccounts--slackaccounts--signalaccounts--imessageaccounts) for the shared pattern.

## Chế độ daemon bên ngoài (httpUrl)

Nếu bạn muốn tự quản lý `signal-cli` (khởi động JVM chậm, init container, hoặc CPU dùng chung), hãy chạy daemon riêng và trỏ OpenClaw tới đó:

```json5
{
  channels: {
    signal: {
      httpUrl: "http://127.0.0.1:8080",
      autoStart: false,
    },
  },
}
```

This skips auto-spawn and the startup wait inside OpenClaw. For slow starts when auto-spawning, set `channels.signal.startupTimeoutMs`.

## Kiểm soát truy cập (DM + nhóm)

DM:

- Mặc định: `channels.signal.dmPolicy = "pairing"`.
- Người gửi chưa biết sẽ nhận mã ghép cặp; tin nhắn bị bỏ qua cho đến khi được duyệt (mã hết hạn sau 1 giờ).
- Duyệt qua:
  - `openclaw pairing list signal`
  - `openclaw pairing approve signal <CODE>`
- Pairing is the default token exchange for Signal DMs. Details: [Pairing](/channels/pairing)
- Người gửi chỉ có UUID (từ `sourceUuid`) được lưu dưới dạng `uuid:<id>` trong `channels.signal.allowFrom`.

Nhóm:

- `channels.signal.groupPolicy = open | allowlist | disabled`.
- `channels.signal.groupAllowFrom` kiểm soát ai có thể kích hoạt trong nhóm khi đặt `allowlist`.

## Cách hoạt động (hành vi)

- `signal-cli` chạy như một daemon; gateway đọc sự kiện qua SSE.
- Tin nhắn vào được chuẩn hóa vào phong bì kênh dùng chung.
- Phản hồi luôn được định tuyến về cùng số hoặc nhóm.

## Media + giới hạn

- Văn bản gửi đi được chia khối theo `channels.signal.textChunkLimit` (mặc định 4000).
- Tùy chọn chia theo dòng mới: đặt `channels.signal.chunkMode="newline"` để tách theo dòng trống (ranh giới đoạn) trước khi chia theo độ dài.
- Hỗ trợ tệp đính kèm (base64 lấy từ `signal-cli`).
- Giới hạn media mặc định: `channels.signal.mediaMaxMb` (mặc định 8).
- Dùng `channels.signal.ignoreAttachments` để bỏ qua tải media.
- Group history context uses `channels.signal.historyLimit` (or `channels.signal.accounts.*.historyLimit`), falling back to `messages.groupChat.historyLimit`. Set `0` to disable (default 50).

## Đang gõ + biên nhận đã đọc

- **Chỉ báo đang gõ**: OpenClaw gửi tín hiệu đang gõ qua `signal-cli sendTyping` và làm mới trong khi đang tạo phản hồi.
- **Biên nhận đã đọc**: khi `channels.signal.sendReadReceipts` là true, OpenClaw chuyển tiếp biên nhận đã đọc cho các DM được phép.
- signal-cli không cung cấp biên nhận đã đọc cho nhóm.

## Phản ứng (công cụ tin nhắn)

- Dùng `message action=react` với `channel=signal`.
- Đích: E.164 hoặc UUID của người gửi (dùng `uuid:<id>` từ đầu ra ghép cặp; UUID trần cũng dùng được).
- `messageId` là dấu thời gian Signal của tin nhắn bạn đang phản ứng.
- Phản ứng trong nhóm cần `targetAuthor` hoặc `targetAuthorUuid`.

Ví dụ:

```
message action=react channel=signal target=uuid:123e4567-e89b-12d3-a456-426614174000 messageId=1737630212345 emoji=🔥
message action=react channel=signal target=+15551234567 messageId=1737630212345 emoji=🔥 remove=true
message action=react channel=signal target=signal:group:<groupId> targetAuthor=uuid:<sender-uuid> messageId=1737630212345 emoji=✅
```

Cấu hình:

- `channels.signal.actions.reactions`: bật/tắt hành động phản ứng (mặc định true).
- `channels.signal.reactionLevel`: `off | ack | minimal | extensive`.
  - `off`/`ack` tắt phản ứng của tác tử (công cụ tin nhắn `react` sẽ báo lỗi).
  - `minimal`/`extensive` bật phản ứng của tác tử và đặt mức hướng dẫn.
- Per-account overrides: `channels.signal.accounts.<id>.actions.reactions`, `channels.signal.accounts.<id>`.reactionLevel\`.

## Đích gửi (CLI/cron)

- DM: `signal:+15551234567` (hoặc E.164 trần).
- DM bằng UUID: `uuid:<id>` (hoặc UUID trần).
- Nhóm: `signal:group:<groupId>`.
- Tên người dùng: `username:<name>` (nếu tài khoản Signal của bạn hỗ trợ).

## Xử lý sự cố

Chạy thang kiểm tra này trước:

```bash
openclaw status
openclaw gateway status
openclaw logs --follow
openclaw doctor
openclaw channels status --probe
```

Sau đó xác nhận trạng thái ghép cặp DM nếu cần:

```bash
openclaw pairing list signal
```

Lỗi thường gặp:

- Daemon truy cập được nhưng không có phản hồi: kiểm tra cài đặt tài khoản/daemon (`httpUrl`, `account`) và chế độ nhận.
- DM bị bỏ qua: người gửi đang chờ duyệt ghép cặp.
- Tin nhắn nhóm bị bỏ qua: chặn do kiểm soát người gửi/nhắc tên trong nhóm.

Luồng phân tích sự cố: [/channels/troubleshooting](/channels/troubleshooting).

## Tham chiếu cấu hình (Signal)

Cấu hình đầy đủ: [Configuration](/gateway/configuration)

Tùy chọn nhà cung cấp:

- `channels.signal.enabled`: bật/tắt khởi động kênh.
- `channels.signal.account`: E.164 cho tài khoản bot.
- `channels.signal.cliPath`: đường dẫn tới `signal-cli`.
- `channels.signal.httpUrl`: URL daemon đầy đủ (ghi đè host/port).
- `channels.signal.httpHost`, `channels.signal.httpPort`: bind daemon (mặc định 127.0.0.1:8080).
- `channels.signal.autoStart`: tự khởi chạy daemon (mặc định true nếu `httpUrl` chưa đặt).
- `channels.signal.startupTimeoutMs`: thời gian chờ khởi động tính bằng ms (giới hạn 120000).
- `channels.signal.receiveMode`: `on-start | manual`.
- `channels.signal.ignoreAttachments`: bỏ qua tải tệp đính kèm.
- `channels.signal.ignoreStories`: bỏ qua stories từ daemon.
- `channels.signal.sendReadReceipts`: chuyển tiếp biên nhận đã đọc.
- `channels.signal.dmPolicy`: `pairing | allowlist | open | disabled` (mặc định: ghép cặp).
- `channels.signal.allowFrom`: DM allowlist (E.164 or `uuid:<id>`). `open` yêu cầu `"*"`. Signal has no usernames; use phone/UUID ids.
- `channels.signal.groupPolicy`: `open | allowlist | disabled` (mặc định: danh sách cho phép).
- `channels.signal.groupAllowFrom`: danh sách cho phép người gửi trong nhóm.
- `channels.signal.historyLimit`: số tin nhắn nhóm tối đa để đưa vào ngữ cảnh (0 để tắt).
- `channels.signal.dmHistoryLimit`: giới hạn lịch sử DM theo lượt người dùng. Per-user overrides: `channels.signal.dms["<phone_or_uuid>"].historyLimit`.
- `channels.signal.textChunkLimit`: kích thước chia khối gửi đi (ký tự).
- `channels.signal.chunkMode`: `length` (mặc định) hoặc `newline` để tách theo dòng trống (ranh giới đoạn) trước khi chia theo độ dài.
- `channels.signal.mediaMaxMb`: giới hạn media vào/ra (MB).

Tùy chọn toàn cục liên quan:

- `agents.list[].groupChat.mentionPatterns` (Signal không hỗ trợ nhắc tên gốc).
- `messages.groupChat.mentionPatterns` (dự phòng toàn cục).
- `messages.responsePrefix`.
