---
summary: "Kênh DM Nostr qua tin nhắn mã hóa NIP-04"
read_when:
  - Bạn muốn OpenClaw nhận DM qua Nostr
  - Bạn đang thiết lập nhắn tin phi tập trung
title: "Nostr"
---

# Nostr

**Trạng thái:** Plugin tùy chọn (tắt theo mặc định).

Nostr is a decentralized protocol for social networking. This channel enables OpenClaw to receive and respond to encrypted direct messages (DMs) via NIP-04.

## Cài đặt (theo yêu cầu)

### Hướng dẫn ban đầu (khuyến nghị)

- Trình hướng dẫn onboarding (`openclaw onboard`) và `openclaw channels add` liệt kê các plugin kênh tùy chọn.
- Chọn Nostr sẽ nhắc bạn cài đặt plugin theo yêu cầu.

Cài đặt mặc định:

- **Kênh Dev + có git checkout:** dùng đường dẫn plugin cục bộ.
- **Stable/Beta:** tải từ npm.

Bạn luôn có thể ghi đè lựa chọn trong lời nhắc.

### Cài đặt thủ công

```bash
openclaw plugins install @openclaw/nostr
```

Dùng bản checkout cục bộ (quy trình dev):

```bash
openclaw plugins install --link <path-to-openclaw>/extensions/nostr
```

Khởi động lại Gateway sau khi cài đặt hoặc bật plugin.

## Khởi động nhanh

1. Tạo cặp khóa Nostr (nếu cần):

```bash
# Using nak
nak key generate
```

2. Thêm vào cấu hình:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}"
    }
  }
}
```

3. Xuất khóa:

```bash
export NOSTR_PRIVATE_KEY="nsec1..."
```

4. Khởi động lại Gateway.

## Tham chiếu cấu hình

| Khóa         | Kiểu                                                         | Mặc định                                    | Mô tả                                    |
| ------------ | ------------------------------------------------------------ | ------------------------------------------- | ---------------------------------------- |
| `privateKey` | string                                                       | required                                    | Khóa riêng ở định dạng `nsec` hoặc hex   |
| `relays`     | string[] | `['wss://relay.damus.io', 'wss://nos.lol']` | URL relay (WebSocket) |
| `dmPolicy`   | string                                                       | `pairing`                                   | Chính sách truy cập DM                   |
| `allowFrom`  | string[] | `[]`                                        | Pubkey người gửi được phép               |
| `enabled`    | boolean                                                      | `true`                                      | Bật/tắt kênh                             |
| `name`       | string                                                       | -                                           | Tên hiển thị                             |
| `profile`    | object                                                       | -                                           | Metadata hồ sơ NIP-01                    |

## Metadata hồ sơ

Profile data is published as a NIP-01 `kind:0` event. You can manage it from the Control UI (Channels -> Nostr -> Profile) or set it directly in config.

Ví dụ:

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "profile": {
        "name": "openclaw",
        "displayName": "OpenClaw",
        "about": "Personal assistant DM bot",
        "picture": "https://example.com/avatar.png",
        "banner": "https://example.com/banner.png",
        "website": "https://example.com",
        "nip05": "openclaw@example.com",
        "lud16": "openclaw@example.com"
      }
    }
  }
}
```

Ghi chú:

- URL hồ sơ phải dùng `https://`.
- Nhập từ relay sẽ gộp các trường và giữ nguyên các ghi đè cục bộ.

## Kiểm soát truy cập

### Chính sách DM

- **pairing** (mặc định): người gửi chưa biết sẽ nhận mã ghép cặp.
- **allowlist**: chỉ các pubkey trong `allowFrom` mới được DM.
- **open**: DM công khai vào (yêu cầu `allowFrom: ["*"]`).
- **disabled**: bỏ qua DM vào.

### Ví dụ allowlist

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "dmPolicy": "allowlist",
      "allowFrom": ["npub1abc...", "npub1xyz..."]
    }
  }
}
```

## Định dạng khóa

Các định dạng chấp nhận:

- **Khóa riêng:** `nsec...` hoặc hex 64 ký tự
- **Pubkey (`allowFrom`):** `npub...` hoặc hex

## Relay

Mặc định: `relay.damus.io` và `nos.lol`.

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["wss://relay.damus.io", "wss://relay.primal.net", "wss://nostr.wine"]
    }
  }
}
```

Mẹo:

- Dùng 2–3 relay để dự phòng.
- Tránh quá nhiều relay (độ trễ, trùng lặp).
- Relay trả phí có thể cải thiện độ tin cậy.
- Relay cục bộ phù hợp cho thử nghiệm (`ws://localhost:7777`).

## Hỗ trợ giao thức

| NIP    | Trạng thái | Mô tả                                     |
| ------ | ---------- | ----------------------------------------- |
| NIP-01 | Hỗ trợ     | Định dạng sự kiện cơ bản + metadata hồ sơ |
| NIP-04 | Hỗ trợ     | DM mã hóa (`kind:4`)   |
| NIP-17 | Dự kiến    | DM gói quà                                |
| NIP-44 | Dự kiến    | Mã hóa có phiên bản                       |

## Kiểm thử

### Relay cục bộ

```bash
# Start strfry
docker run -p 7777:7777 ghcr.io/hoytech/strfry
```

```json
{
  "channels": {
    "nostr": {
      "privateKey": "${NOSTR_PRIVATE_KEY}",
      "relays": ["ws://localhost:7777"]
    }
  }
}
```

### Kiểm thử thủ công

1. Ghi lại pubkey (npub) của bot từ log.
2. Mở một client Nostr (Damus, Amethyst, v.v.).
3. Gửi DM đến pubkey của bot.
4. Xác minh phản hồi.

## Xử lý sự cố

### Không nhận được tin nhắn

- Xác minh khóa riêng hợp lệ.
- Đảm bảo URL relay truy cập được và dùng `wss://` (hoặc `ws://` cho cục bộ).
- Xác nhận `enabled` không phải `false`.
- Kiểm tra log Gateway để tìm lỗi kết nối relay.

### Không gửi được phản hồi

- Kiểm tra relay có chấp nhận ghi.
- Xác minh kết nối ra ngoài.
- Theo dõi giới hạn tốc độ của relay.

### Phản hồi trùng lặp

- Điều này ожида khi dùng nhiều relay.
- Tin nhắn được khử trùng lặp theo ID sự kiện; chỉ lần giao đầu tiên kích hoạt phản hồi.

## Bảo mật

- Không bao giờ commit khóa riêng.
- Dùng biến môi trường cho khóa.
- Cân nhắc `allowlist` cho bot sản xuất.

## Hạn chế (MVP)

- Chỉ tin nhắn trực tiếp (không có chat nhóm).
- Không hỗ trợ tệp media đính kèm.
- Chỉ NIP-04 (NIP-17 gói quà dự kiến).
