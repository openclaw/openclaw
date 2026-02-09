---
summary: "Trạng thái hỗ trợ bot Zalo, khả năng và cấu hình"
read_when:
  - Làm việc với các tính năng hoặc webhook của Zalo
title: "Zalo"
---

# Zalo (Bot API)

Status: experimental. Direct messages only; groups coming soon per Zalo docs.

## Cần plugin

Zalo được phân phối dưới dạng plugin và không đi kèm trong bản cài đặt lõi.

- Cài đặt qua CLI: `openclaw plugins install @openclaw/zalo`
- Hoặc chọn **Zalo** trong quá trình hướng dẫn ban đầu và xác nhận lời nhắc cài đặt
- Chi tiết: [Plugins](/tools/plugin)

## Thiết lập nhanh (cho người mới)

1. Cài đặt plugin Zalo:
   - Từ bản mã nguồn: `openclaw plugins install ./extensions/zalo`
   - Từ npm (nếu đã phát hành): `openclaw plugins install @openclaw/zalo`
   - Hoặc chọn **Zalo** trong hướng dẫn ban đầu và xác nhận lời nhắc cài đặt
2. Đặt token:
   - Biến môi trường: `ZALO_BOT_TOKEN=...`
   - Hoặc cấu hình: `channels.zalo.botToken: "..."`.
3. Khởi động lại gateway (hoặc hoàn tất hướng dẫn ban đầu).
4. Quyền truy cập DM mặc định là ghép cặp; phê duyệt mã ghép cặp khi liên hệ lần đầu.

Cấu hình tối thiểu:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

## Nó là gì

Zalo is a Vietnam-focused messaging app; its Bot API lets the Gateway run a bot for 1:1 conversations.
It is a good fit for support or notifications where you want deterministic routing back to Zalo.

- Một kênh Zalo Bot API do Gateway sở hữu.
- Định tuyến xác định: phản hồi luôn quay lại Zalo; mô hình không chọn kênh.
- DM dùng chung phiên chính của tác tử.
- Nhóm chưa được hỗ trợ (tài liệu Zalo ghi “coming soon”).

## Thiết lập (nhanh)

### 1. Tạo bot token (Zalo Bot Platform)

1. Truy cập [https://bot.zaloplatforms.com](https://bot.zaloplatforms.com) và đăng nhập.
2. Tạo bot mới và cấu hình các thiết lập.
3. Sao chép bot token (định dạng: `12345689:abc-xyz`).

### 2) Cấu hình token (biến môi trường hoặc cấu hình)

Ví dụ:

```json5
{
  channels: {
    zalo: {
      enabled: true,
      botToken: "12345689:abc-xyz",
      dmPolicy: "pairing",
    },
  },
}
```

Tùy chọn biến môi trường: `ZALO_BOT_TOKEN=...` (chỉ hoạt động cho tài khoản mặc định).

Hỗ trợ nhiều tài khoản: dùng `channels.zalo.accounts` với token theo từng tài khoản và `name` tùy chọn.

3. Khởi động lại gateway. Zalo starts when a token is resolved (env or config).
4. DM access defaults to pairing. Approve the code when the bot is first contacted.

## Cách hoạt động (hành vi)

- Tin nhắn đến được chuẩn hóa vào phong bì kênh dùng chung với placeholder cho media.
- Phản hồi luôn định tuyến về cùng cuộc trò chuyện Zalo.
- Mặc định dùng long-polling; có chế độ webhook với `channels.zalo.webhookUrl`.

## Giới hạn

- Văn bản gửi đi được chia khối 2000 ký tự (giới hạn API Zalo).
- Tải lên/tải xuống media bị giới hạn bởi `channels.zalo.mediaMaxMb` (mặc định 5).
- Streaming bị chặn theo mặc định do giới hạn 2000 ký tự khiến streaming kém hữu ích.

## Kiểm soát truy cập (DM)

### Quyền truy cập DM

- Mặc định: `channels.zalo.dmPolicy = "pairing"`. Người gửi chưa biết sẽ nhận mã ghép cặp; tin nhắn bị bỏ qua cho đến khi được duyệt (mã hết hạn sau 1 giờ).
- Phê duyệt qua:
  - `openclaw pairing list zalo`
  - `openclaw pairing approve zalo <CODE>`
- Pairing is the default token exchange. Details: [Pairing](/channels/pairing)
- `channels.zalo.allowFrom` chấp nhận ID người dùng dạng số (không có tra cứu tên người dùng).

## Long-polling vs webhook

- Mặc định: long-polling (không cần URL công khai).
- Chế độ webhook: đặt `channels.zalo.webhookUrl` và `channels.zalo.webhookSecret`.
  - Secret webhook phải dài 8–256 ký tự.
  - URL webhook phải dùng HTTPS.
  - Zalo gửi sự kiện kèm header `X-Bot-Api-Secret-Token` để xác minh.
  - Gateway HTTP xử lý yêu cầu webhook tại `channels.zalo.webhookPath` (mặc định là đường dẫn URL webhook).

**Lưu ý:** getUpdates (polling) và webhook loại trừ lẫn nhau theo tài liệu API Zalo.

## Các loại tin nhắn được hỗ trợ

- **Tin nhắn văn bản**: Hỗ trợ đầy đủ với chia khối 2000 ký tự.
- **Tin nhắn hình ảnh**: Tải xuống và xử lý ảnh đến; gửi ảnh qua `sendPhoto`.
- **Sticker**: Được ghi log nhưng chưa xử lý đầy đủ (không có phản hồi từ tác tử).
- **Loại không hỗ trợ**: Được ghi log (ví dụ: tin nhắn từ người dùng được bảo vệ).

## Khả năng

| Tính năng                           | Trạng thái                                           |
| ----------------------------------- | ---------------------------------------------------- |
| Tin nhắn trực tiếp                  | ✅ Được hỗ trợ                                        |
| Nhóm                                | ❌ Sắp ra mắt (theo tài liệu Zalo) |
| Media (hình ảnh) | ✅ Được hỗ trợ                                        |
| Reaction                            | ❌ Không hỗ trợ                                       |
| Threads                             | ❌ Không hỗ trợ                                       |
| Polls                               | ❌ Không hỗ trợ                                       |
| Lệnh gốc                            | ❌ Không hỗ trợ                                       |
| Streaming                           | ⚠️ Bị chặn (giới hạn 2000 ký tự)  |

## Đích gửi (CLI/cron)

- Dùng chat id làm đích.
- Ví dụ: `openclaw message send --channel zalo --target 123456789 --message "hi"`.

## Xử lý sự cố

**Bot không phản hồi:**

- Kiểm tra token hợp lệ: `openclaw channels status --probe`
- Xác minh người gửi đã được phê duyệt (ghép cặp hoặc allowFrom)
- Kiểm tra log gateway: `openclaw logs --follow`

**Webhook không nhận sự kiện:**

- Đảm bảo URL webhook dùng HTTPS
- Xác minh secret token dài 8–256 ký tự
- Xác nhận endpoint HTTP của gateway có thể truy cập tại đường dẫn đã cấu hình
- Kiểm tra getUpdates polling không đang chạy (chúng loại trừ lẫn nhau)

## Tham chiếu cấu hình (Zalo)

Cấu hình đầy đủ: [Configuration](/gateway/configuration)

Tùy chọn nhà cung cấp:

- `channels.zalo.enabled`: bật/tắt khởi động kênh.
- `channels.zalo.botToken`: bot token từ Zalo Bot Platform.
- `channels.zalo.tokenFile`: đọc token từ đường dẫn tệp.
- `channels.zalo.dmPolicy`: `pairing | allowlist | open | disabled` (mặc định: ghép cặp).
- `channels.zalo.allowFrom`: DM allowlist (user IDs). `open` requires `"*"`. The wizard will ask for numeric IDs.
- `channels.zalo.mediaMaxMb`: giới hạn media vào/ra (MB, mặc định 5).
- `channels.zalo.webhookUrl`: bật chế độ webhook (yêu cầu HTTPS).
- `channels.zalo.webhookSecret`: secret webhook (8–256 ký tự).
- `channels.zalo.webhookPath`: đường dẫn webhook trên máy chủ HTTP của gateway.
- `channels.zalo.proxy`: URL proxy cho các yêu cầu API.

Tùy chọn nhiều tài khoản:

- `channels.zalo.accounts.<id>.botToken`: per-account token.
- `channels.zalo.accounts.<id>.tokenFile`: per-account token file.
- `channels.zalo.accounts.<id>`.name\`: tên hiển thị.
- `channels.zalo.accounts.<id>.enabled`: enable/disable account.
- `channels.zalo.accounts.<id>.dmPolicy`: per-account DM policy.
- `channels.zalo.accounts.<id>.allowFrom`: per-account allowlist.
- `channels.zalo.accounts.<id>.webhookUrl`: per-account webhook URL.
- `channels.zalo.accounts.<id>``.webhookSecret`: webhook secret theo từng tài khoản.
- `channels.zalo.accounts.<id>``.webhookPath`: đường dẫn webhook theo từng tài khoản.
- `channels.zalo.accounts.<id>`.proxy\`: URL proxy theo từng tài khoản.
