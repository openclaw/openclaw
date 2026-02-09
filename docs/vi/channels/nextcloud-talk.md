---
summary: "Trạng thái hỗ trợ, khả năng và cấu hình của Nextcloud Talk"
read_when:
  - Làm việc trên các tính năng kênh Nextcloud Talk
title: "Nextcloud Talk"
---

# Nextcloud Talk (plugin)

Status: supported via plugin (webhook bot). Direct messages, rooms, reactions, and markdown messages are supported.

## Yêu cầu plugin

Nextcloud Talk được phát hành dưới dạng plugin và không được gộp sẵn trong bản cài đặt lõi.

Cài đặt qua CLI (npm registry):

```bash
openclaw plugins install @openclaw/nextcloud-talk
```

Checkout cục bộ (khi chạy từ repo git):

```bash
openclaw plugins install ./extensions/nextcloud-talk
```

Nếu bạn chọn Nextcloud Talk trong quá trình cấu hình/hướng dẫn ban đầu và phát hiện một bản checkout git,
OpenClaw sẽ tự động đề xuất đường dẫn cài đặt cục bộ.

Chi tiết: [Plugins](/tools/plugin)

## Thiết lập nhanh (cho người mới)

1. Cài đặt plugin Nextcloud Talk.

2. Trên máy chủ Nextcloud của bạn, tạo một bot:

   ```bash
   ./occ talk:bot:install "OpenClaw" "<shared-secret>" "<webhook-url>" --feature reaction
   ```

3. Bật bot trong cài đặt phòng mục tiêu.

4. Cấu hình OpenClaw:
   - Config: `channels.nextcloud-talk.baseUrl` + `channels.nextcloud-talk.botSecret`
   - Hoặc env: `NEXTCLOUD_TALK_BOT_SECRET` (chỉ cho tài khoản mặc định)

5. Khởi động lại gateway (hoặc hoàn tất hướng dẫn ban đầu).

Cấu hình tối thiểu:

```json5
{
  channels: {
    "nextcloud-talk": {
      enabled: true,
      baseUrl: "https://cloud.example.com",
      botSecret: "shared-secret",
      dmPolicy: "pairing",
    },
  },
}
```

## Ghi chú

- Bots cannot initiate DMs. The user must message the bot first.
- URL webhook phải truy cập được bởi Gateway; đặt `webhookPublicUrl` nếu ở sau proxy.
- Tải lên media không được hỗ trợ bởi API bot; media được gửi dưới dạng URL.
- Payload webhook không phân biệt DM và phòng; đặt `apiUser` + `apiPassword` để bật tra cứu loại phòng (nếu không, DM sẽ được xử lý như phòng).

## Kiểm soát truy cập (DM)

- Mặc định: `channels.nextcloud-talk.dmPolicy = "pairing"`. Unknown senders get a pairing code.
- Phê duyệt thông qua:
  - `openclaw pairing list nextcloud-talk`
  - `openclaw pairing approve nextcloud-talk <CODE>`
- DM công khai: `channels.nextcloud-talk.dmPolicy="open"` cộng với `channels.nextcloud-talk.allowFrom=["*"]`.
- `allowFrom` chỉ khớp với ID người dùng Nextcloud; tên hiển thị bị bỏ qua.

## Phòng (nhóm)

- Mặc định: `channels.nextcloud-talk.groupPolicy = "allowlist"` (yêu cầu mention).
- Cho phép phòng bằng danh sách cho phép với `channels.nextcloud-talk.rooms`:

```json5
{
  channels: {
    "nextcloud-talk": {
      rooms: {
        "room-token": { requireMention: true },
      },
    },
  },
}
```

- Để không cho phép phòng nào, giữ danh sách cho phép trống hoặc đặt `channels.nextcloud-talk.groupPolicy="disabled"`.

## Khả năng

| Tính năng          | Trạng thái   |
| ------------------ | ------------ |
| Tin nhắn trực tiếp | Hỗ trợ       |
| Phòng              | Hỗ trợ       |
| Luồng              | Không hỗ trợ |
| Media              | Chỉ URL      |
| Phản ứng           | Hỗ trợ       |
| Lệnh gốc           | Không hỗ trợ |

## Tham chiếu cấu hình (Nextcloud Talk)

Cấu hình đầy đủ: [Configuration](/gateway/configuration)

Tùy chọn nhà cung cấp:

- `channels.nextcloud-talk.enabled`: bật/tắt khởi động kênh.
- `channels.nextcloud-talk.baseUrl`: URL phiên bản Nextcloud.
- `channels.nextcloud-talk.botSecret`: bí mật chia sẻ của bot.
- `channels.nextcloud-talk.botSecretFile`: đường dẫn tệp bí mật.
- `channels.nextcloud-talk.apiUser`: người dùng API để tra cứu phòng (phát hiện DM).
- `channels.nextcloud-talk.apiPassword`: mật khẩu API/app để tra cứu phòng.
- `channels.nextcloud-talk.apiPasswordFile`: đường dẫn tệp mật khẩu API.
- `channels.nextcloud-talk.webhookPort`: cổng lắng nghe webhook (mặc định: 8788).
- `channels.nextcloud-talk.webhookHost`: host webhook (mặc định: 0.0.0.0).
- `channels.nextcloud-talk.webhookPath`: đường dẫn webhook (mặc định: /nextcloud-talk-webhook).
- `channels.nextcloud-talk.webhookPublicUrl`: URL webhook có thể truy cập từ bên ngoài.
- `channels.nextcloud-talk.dmPolicy`: `pairing | allowlist | open | disabled`.
- `channels.nextcloud-talk.allowFrom`: DM allowlist (user IDs). `open` requires `"*"`.
- `channels.nextcloud-talk.groupPolicy`: `allowlist | open | disabled`.
- `channels.nextcloud-talk.groupAllowFrom`: danh sách cho phép nhóm (ID người dùng).
- `channels.nextcloud-talk.rooms`: cài đặt theo phòng và danh sách cho phép.
- `channels.nextcloud-talk.historyLimit`: giới hạn lịch sử nhóm (0 để tắt).
- `channels.nextcloud-talk.dmHistoryLimit`: giới hạn lịch sử DM (0 để tắt).
- `channels.nextcloud-talk.dms`: ghi đè theo từng DM (historyLimit).
- `channels.nextcloud-talk.textChunkLimit`: kích thước phân đoạn văn bản đầu ra (ký tự).
- `channels.nextcloud-talk.chunkMode`: `length` (mặc định) hoặc `newline` để tách theo dòng trống (ranh giới đoạn) trước khi phân đoạn theo độ dài.
- `channels.nextcloud-talk.blockStreaming`: tắt block streaming cho kênh này.
- `channels.nextcloud-talk.blockStreamingCoalesce`: tinh chỉnh gộp block streaming.
- `channels.nextcloud-talk.mediaMaxMb`: giới hạn media đầu vào (MB).
